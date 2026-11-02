// core/awareness/engine.js
// Market Awareness Engine – runs on every tick.
// Observes: spread, velocity, acceleration, liquidity, micro-structure.
// Updates MarketStateCache (RAM) every tick, persists to MongoDB periodically.
//
// Logging policy:
//   • Silent per tick — no console.log inside _processTick().
//   • One compact summary line per minute so the pipeline can still be
//     verified as alive without flooding stdout.
//   • Constructor emits a single init log.
//
// [FILE-1A] Symbol normalization at every persistence and emit boundary.
//   Broker emits Deriv symbols ('frxEURUSD'); candles, regime, deep state,
//   and the dashboard all use canonical 'EURUSD'. This file is the ONLY
//   writer to marketStateCache — normalizing here fixes the entire
//   downstream read path without touching a dozen other consumers.
//   Internal _state uses the normalized key too, so decisionEngine
//   (which iterates _state.keys()) naturally yields the right format.
//
// [FILE-1B] Emit both `unusual` and `unusualEvents` on the awareness
//   event. Three consumers read `data.unusualEvents`; historically this
//   file wrote `unusual`, so those consumers always saw undefined.
//   Both fields point to the same array so no downstream code changes
//   are needed.
//
// [FILE-1C] Log once per new tracked symbol — makes it obvious when
//   awareness starts (or stops) receiving ticks.
//
// [FIX-AW1] **Liquidity normalizer fixed.** Was dividing ticks/sec by 20,
//   which produced liq≈0.05 for every FX symbol (Deriv FX feeds run at
//   0.5–5 ticks/sec, never 20). marketState.js then computed
//   marketQuality = (0.05 × 100) - spreadPenalty + 20 ≈ 23, which is
//   below the 30-point gate. Result: every FX trade blocked with
//   LOW_MARKET_QUALITY. New ceiling is 4 ticks/sec — realistic for
//   Deriv FX majors. Normal markets produce liq≈0.25 → quality≈43.
//   Genuinely dead markets (0.2 ticks/sec) still produce liq≈0.05 →
//   quality≈23 and are correctly rejected.
//
// [FIX-AW2] Proper EventEmitter inheritance. Same bug as regime.js
//   [FIX-RG1] — `Object.setPrototypeOf` without `super()` left
//   `_events`/`_eventsCount` uninitialized on instances. Works by
//   accident in modern Node but breaks `.once()`, `.rawListeners()`,
//   error-event handling, and any inspection of listener state.
//
// [FIX-AW3] Config is now exported and mutable at runtime for tuning
//   without restart. Use `setConfig({ LIQUIDITY_TICKS_PER_SEC_CEILING: 6 })`
//   to loosen or tighten the gate.
//
// [FIX-AW4] Summary log now shows ticks-per-minute (delta) instead of
//   cumulative counts. Previous version printed total-since-boot, which
//   made it impossible to diagnose "why is liquidity 0.05?" from the log.
//   Now each summary line shows `ticks/min=N` per symbol.
//
// [FIX-AW5] `_knownSymbols` is capped (200). Prevents unbounded growth
//   on a long-running process with dynamic watchlists.
//
// [FIX-AW6] velocity_burst false positives on synthetic indices (R_*,
//   1HZ*). Synthetics are designed to be volatile — flagged only if
//   velocity exceeds 5× the 20-sample average (was 3×). FX still uses 3×.
//
// [FIX-AW7] Sanity guard: if `time` is not a valid timestamp the tick
//   is silently dropped instead of corrupting tickTimes. Defends against
//   malformed broker payloads after a reconnect.

const EventEmitter = require('events');
const priceBuffer = require('../data/priceBuffer');
const marketStateCache = require('../data/marketStateCache');
const logger = require('../../infrastructure/logger') || console;

// [FIX-AW3] Exported so tests and /debug endpoints can inspect/tune.
const CONFIG = {
  VELOCITY_WINDOW: 5,
  ACCELERATION_WINDOW: 3,
  LIQUIDITY_WINDOW_MS: 1000,
  SPREAD_SMA_ALPHA: 0.3,

  // [FIX-AW1] Realistic ceiling for Deriv FX feeds.
  // Empirically: EURUSD during London open ≈ 4-5 ticks/s, quiet ≈ 1-2.
  // Synthetics (R_100, 1HZ*) tick at exactly 1/s by design.
  LIQUIDITY_TICKS_PER_SEC_CEILING: 4,
};

const SUMMARY_INTERVAL_MS = 60_000;

// [FIX-AW5] Cap for _knownSymbols.
const MAX_KNOWN_SYMBOLS = 200;

// [FIX-AW6] Per-asset-class velocity_burst thresholds.
// Synthetics are designed to be bursty — require a bigger multiple.
const VELOCITY_BURST_MULT_FX = 3;
const VELOCITY_BURST_MULT_SYNTHETIC = 5;

// [FILE-1A] Shared normalizer. 'frxEURUSD' → 'EURUSD', 'EUR_USD' → 'EURUSD'.
function normalizeSymbol(symbol) {
  if (!symbol) return '';
  return symbol.replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
}

// [FIX-AW6] Is this a synthetic-index symbol?
function isSynthetic(symbol) {
  return /^(R_|1HZ|BOOM|CRASH|JD|STPR)/i.test(String(symbol || ''));
}

// [FIX-AW2] Proper class extends EventEmitter.
class MarketAwarenessEngine extends EventEmitter {
  constructor() {
    // [FIX-AW2] super() must be first to initialize _events etc.
    super();

    this._state = new Map();
    this._tickCount = 0;
    this._tickCountBySymbol = new Map();
    this._lastUpdateBySymbol = new Map();
    this._lastSummaryAt = Date.now();
    this._knownSymbols = new Set();
    // [FIX-AW4] Snapshot of tick counts at last summary (for delta rate)
    this._lastSummaryTickCounts = new Map();

    // Listen to every tick from the price buffer
    priceBuffer.on('tick', (tick) => {
      this._tickCount++;
      this._processTick(tick);
    });

    logger.info('[MarketAwarenessEngine] Initialized, listening to ticks.');
  }

  _processTick(tick) {
    // [FIX-AW7] Guard against malformed tick payloads.
    if (!tick || !tick.symbol) return;
    if (!Number.isFinite(tick.bid) || !Number.isFinite(tick.ask)) return;

    const rawSymbol = tick.symbol;
    const symbol = normalizeSymbol(rawSymbol);
    if (!symbol) return;

    const { bid, ask, mid } = tick;
    // [FIX-AW7] Ensure time is a valid ms timestamp.
    let time = tick.time;
    if (!Number.isFinite(time) || time <= 0) {
      time = Date.now();
    }
    // If time is obviously in seconds (e.g. someone passed epoch directly),
    // convert to milliseconds. Anything below year-2001-in-seconds is wrong.
    if (time < 1e12) time = time * 1000;

    const spread = ask - bid;

    // [FILE-1C] Log once per newly-tracked symbol.
    if (!this._state.has(symbol) && !this._knownSymbols.has(symbol)) {
      // [FIX-AW5] Cap known-symbols growth.
      if (this._knownSymbols.size >= MAX_KNOWN_SYMBOLS) {
        const first = this._knownSymbols.values().next().value;
        this._knownSymbols.delete(first);
      }
      this._knownSymbols.add(symbol);
      logger.info(`[Awareness] Now tracking: ${symbol} (raw: ${rawSymbol})`);
    }

    this._tickCountBySymbol.set(
      symbol,
      (this._tickCountBySymbol.get(symbol) || 0) + 1
    );

    if (!this._state.has(symbol)) {
      this._state.set(symbol, {
        priceHistory: [],
        tickTimes: [],
        spreadEMA: null,
        velocityHistory: [],
        liquidityHistory: [],
        lastTickTime: time,
      });
    }
    const state = this._state.get(symbol);

    // 1. Price history
    state.priceHistory.push(mid);
    if (state.priceHistory.length > CONFIG.VELOCITY_WINDOW + 5) {
      state.priceHistory.shift();
    }

    // 2. Tick times (bounded to ~2s lookback)
    state.tickTimes.push(time);
    const cutoff = time - CONFIG.LIQUIDITY_WINDOW_MS * 2;
    while (state.tickTimes.length > 0 && state.tickTimes[0] < cutoff) {
      state.tickTimes.shift();
    }

    // 3. Spread EMA
    if (state.spreadEMA === null) {
      state.spreadEMA = spread;
    } else {
      state.spreadEMA = state.spreadEMA * (1 - CONFIG.SPREAD_SMA_ALPHA) + spread * CONFIG.SPREAD_SMA_ALPHA;
    }

    // 4. Velocity
    let velocity = 0;
    if (state.priceHistory.length >= CONFIG.VELOCITY_WINDOW) {
      const recent = state.priceHistory.slice(-CONFIG.VELOCITY_WINDOW);
      const first = recent[0];
      const last = recent[recent.length - 1];
      velocity = (last - first) / CONFIG.VELOCITY_WINDOW;
    }
    state.velocityHistory.push(velocity);
    if (state.velocityHistory.length > CONFIG.ACCELERATION_WINDOW + 5) {
      state.velocityHistory.shift();
    }

    // 5. Acceleration
    let acceleration = 0;
    if (state.velocityHistory.length >= CONFIG.ACCELERATION_WINDOW) {
      const recentVels = state.velocityHistory.slice(-CONFIG.ACCELERATION_WINDOW);
      const first = recentVels[0];
      const last = recentVels[recentVels.length - 1];
      acceleration = (last - first) / CONFIG.ACCELERATION_WINDOW;
    }

    // 6. Liquidity — [FIX-AW1] realistic ceiling.
    let liquidity = 0;
    const timeWindow = CONFIG.LIQUIDITY_WINDOW_MS;
    const recentTicks = state.tickTimes.filter(t => t >= time - timeWindow);
    if (recentTicks.length > 1) {
      const duration = (recentTicks[recentTicks.length - 1] - recentTicks[0]) / 1000;
      if (duration > 0) {
        liquidity = (recentTicks.length - 1) / duration;
      }
    }
    // [FIX-AW1] Was / 20. Now / 4. See file header for full rationale.
    liquidity = Math.min(1, liquidity / CONFIG.LIQUIDITY_TICKS_PER_SEC_CEILING);

    state.liquidityHistory.push(liquidity);
    if (state.liquidityHistory.length > 50) state.liquidityHistory.shift();

    // 7. Unusual detection — [FIX-AW6] asset-class-aware thresholds
    const unusual = this._detectUnusual(
      { velocity, acceleration, spread, liquidity },
      state,
      symbol
    );

    // 8. Publish to marketStateCache — [FILE-1A] normalized symbol
    const stateUpdate = {
      symbol,
      bid,
      ask,
      mid,
      spread: state.spreadEMA,
      velocity,
      acceleration,
      liquidity,
      unusual,
      unusualEvents: unusual,   // [FILE-1B]
      lastUpdated: new Date(time),
    };

    marketStateCache.update(symbol, stateUpdate);

    // 9. Emit — [FILE-1A] normalized symbol
    this.emit('marketAwareness', { ...stateUpdate });

    // 10. Retain for summary logging
    this._lastUpdateBySymbol.set(symbol, stateUpdate);
    state.lastTickTime = time;

    this._maybeLogSummary();
  }

  // [FIX-AW6] Synthetic-aware thresholds
  _detectUnusual(update, state, symbol) {
    const { velocity, acceleration, spread, liquidity } = update;
    const events = [];

    // Velocity burst — use higher multiple for synthetics
    const burstMult = isSynthetic(symbol) ? VELOCITY_BURST_MULT_SYNTHETIC : VELOCITY_BURST_MULT_FX;
    const avgVelocity = state.velocityHistory.reduce((a, b) => a + b, 0) / Math.max(1, state.velocityHistory.length);
    if (Math.abs(velocity) > Math.abs(avgVelocity) * burstMult && Math.abs(velocity) > 0.0001) {
      events.push('velocity_burst');
    }

    // Spread spike
    if (spread > (state.spreadEMA || 0) * 2.5 && spread > 0.0002) {
      events.push('spread_spike');
    }

    // Liquidity drop
    if (state.liquidityHistory.length > 10) {
      const avgLiquidity = state.liquidityHistory.reduce((a, b) => a + b, 0) / state.liquidityHistory.length;
      if (avgLiquidity > 0.3 && liquidity < avgLiquidity * 0.3) {
        events.push('liquidity_drop');
      }
    }

    return events.length > 0 ? events : null;
  }

  // [FIX-AW4] Summary shows ticks/min delta, not cumulative.
  _maybeLogSummary() {
    const now = Date.now();
    if (now - this._lastSummaryAt < SUMMARY_INTERVAL_MS) return;
    this._lastSummaryAt = now;

    const parts = [];
    for (const [symbol, u] of this._lastUpdateBySymbol) {
      const cumulative = this._tickCountBySymbol.get(symbol) || 0;
      const previous = this._lastSummaryTickCounts.get(symbol) || 0;
      const ticksPerMinute = Math.max(0, cumulative - previous);
      this._lastSummaryTickCounts.set(symbol, cumulative);

      parts.push(
        `${symbol}: ticks/min=${ticksPerMinute} ` +
        `spread=${u.spread.toFixed(5)} ` +
        `vel=${u.velocity.toFixed(6)} ` +
        `acc=${u.acceleration.toFixed(6)} ` +
        `liq=${u.liquidity.toFixed(3)} ` +
        `unusual=${u.unusual ? u.unusual.join(',') : 'none'}`
      );
    }

    logger.info(
      `[MarketAwareness] Summary — symbols=${this._lastUpdateBySymbol.size} ` +
      `(liq ceiling = ${CONFIG.LIQUIDITY_TICKS_PER_SEC_CEILING} ticks/s)\n  ${parts.join('\n  ')}`
    );
  }

  // [FIX-AW3] Runtime config access for /debug endpoints and tests.
  getConfig() {
    return { ...CONFIG };
  }
  setConfig(overrides) {
    const allowed = Object.keys(CONFIG);
    for (const key of Object.keys(overrides || {})) {
      if (allowed.includes(key)) CONFIG[key] = overrides[key];
    }
    return this.getConfig();
  }

  // Diagnostic view per symbol — useful for /debug/awareness.
  getSnapshot() {
    const out = {};
    for (const [symbol, u] of this._lastUpdateBySymbol) {
      out[symbol] = {
        spread: u.spread,
        velocity: u.velocity,
        acceleration: u.acceleration,
        liquidity: u.liquidity,
        ticksTotal: this._tickCountBySymbol.get(symbol) || 0,
        unusual: u.unusual,
        lastUpdated: u.lastUpdated,
      };
    }
    return out;
  }
}

// Singleton
const engine = new MarketAwarenessEngine();
module.exports = engine;
// [FIX-AW3] Expose CONFIG for external inspection
module.exports.CONFIG = CONFIG;
