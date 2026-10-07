// core/awareness/engine.js
// Market Awareness Engine – runs on every tick.
// Observes: spread, velocity, acceleration, liquidity, micro‑structure.
// Updates MarketStateCache (RAM) every tick, persists to MongoDB periodically.
//
// Logging policy:
//   • Silent per tick — no console.log inside _processTick().
//   • One compact summary line per minute so the pipeline can still be
//     verified as alive without flooding stdout.
//   • Constructor emits a single init log.

const priceBuffer = require('../data/priceBuffer');
const marketStateCache = require('../data/marketStateCache');
const logger = require('../../infrastructure/logger') || console;

// Configuration
const CONFIG = {
  VELOCITY_WINDOW: 5,
  ACCELERATION_WINDOW: 3,
  LIQUIDITY_WINDOW_MS: 1000,
  SPREAD_SMA_ALPHA: 0.3,
};

// How often to emit the summary line.
const SUMMARY_INTERVAL_MS = 60_000;

class MarketAwarenessEngine {
  constructor() {
    this._state = new Map(); // symbol -> internal state
    this._tickCount = 0;
    this._tickCountBySymbol = new Map();
    this._lastUpdateBySymbol = new Map(); // symbol -> last computed stateUpdate
    this._lastSummaryAt = Date.now();

    // Listen to every tick from the price buffer
    priceBuffer.on('tick', (tick) => {
      this._tickCount++;
      this._tickCountBySymbol.set(
        tick.symbol,
        (this._tickCountBySymbol.get(tick.symbol) || 0) + 1
      );
      this._processTick(tick);
    });

    logger.info('[MarketAwarenessEngine] Initialized, listening to ticks.');
  }

  _processTick(tick) {
    const { symbol, bid, ask, mid, time } = tick;
    const spread = ask - bid;

    // 1. Get or create symbol state
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

    // 2. Update price history (for velocity)
    state.priceHistory.push(mid);
    if (state.priceHistory.length > CONFIG.VELOCITY_WINDOW + 5) {
      state.priceHistory.shift();
    }

    // 3. Update tick times (for liquidity)
    state.tickTimes.push(time);
    const cutoff = time - CONFIG.LIQUIDITY_WINDOW_MS * 2;
    while (state.tickTimes.length > 0 && state.tickTimes[0] < cutoff) {
      state.tickTimes.shift();
    }

    // 4. Compute spread (exponential moving average)
    if (state.spreadEMA === null) {
      state.spreadEMA = spread;
    } else {
      state.spreadEMA = state.spreadEMA * (1 - CONFIG.SPREAD_SMA_ALPHA) + spread * CONFIG.SPREAD_SMA_ALPHA;
    }

    // 5. Compute velocity
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

    // 6. Compute acceleration
    let acceleration = 0;
    if (state.velocityHistory.length >= CONFIG.ACCELERATION_WINDOW) {
      const recentVels = state.velocityHistory.slice(-CONFIG.ACCELERATION_WINDOW);
      const first = recentVels[0];
      const last = recentVels[recentVels.length - 1];
      acceleration = (last - first) / CONFIG.ACCELERATION_WINDOW;
    }

    // 7. Liquidity proxy: tick frequency (ticks per second)
    let liquidity = 0;
    const timeWindow = CONFIG.LIQUIDITY_WINDOW_MS;
    const recentTicks = state.tickTimes.filter(t => t >= time - timeWindow);
    if (recentTicks.length > 1) {
      const duration = (recentTicks[recentTicks.length - 1] - recentTicks[0]) / 1000;
      if (duration > 0) {
        liquidity = (recentTicks.length - 1) / duration;
      }
    }
    liquidity = Math.min(1, liquidity / 20);

    // Store liquidity history for unusual detection
    state.liquidityHistory.push(liquidity);
    if (state.liquidityHistory.length > 50) state.liquidityHistory.shift();

    // 8. Detect unusual events
    const unusual = this._detectUnusual({ velocity, acceleration, spread, liquidity }, state);

    // 9. Update the market state cache
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
      lastUpdated: new Date(time),
    };

    marketStateCache.update(symbol, stateUpdate);

    // 10. Emit marketAwareness event
    const awarenessEvent = { symbol, ...stateUpdate };
    this.emit('marketAwareness', awarenessEvent);

    // Retain the latest computed state for summary logging
    this._lastUpdateBySymbol.set(symbol, stateUpdate);

    // Update last tick time
    state.lastTickTime = time;

    // Periodic compact summary (once per SUMMARY_INTERVAL_MS)
    this._maybeLogSummary();
  }

  _detectUnusual(update, state) {
    const { velocity, acceleration, spread, liquidity } = update;
    const events = [];

    // Velocity burst
    const avgVelocity = state.velocityHistory.reduce((a, b) => a + b, 0) / state.velocityHistory.length || 0;
    if (Math.abs(velocity) > Math.abs(avgVelocity) * 3 && Math.abs(velocity) > 0.0001) {
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

  // Compact periodic summary — one line per symbol, once per minute.
  _maybeLogSummary() {
    const now = Date.now();
    if (now - this._lastSummaryAt < SUMMARY_INTERVAL_MS) return;
    this._lastSummaryAt = now;

    const parts = [];
    for (const [symbol, u] of this._lastUpdateBySymbol) {
      const ticks = this._tickCountBySymbol.get(symbol) || 0;
      parts.push(
        `${symbol}: ticks=${ticks} ` +
        `spread=${u.spread.toFixed(5)} ` +
        `vel=${u.velocity.toFixed(6)} ` +
        `acc=${u.acceleration.toFixed(6)} ` +
        `liq=${u.liquidity.toFixed(3)} ` +
        `unusual=${u.unusual ? u.unusual.join(',') : 'none'}`
      );
    }

    logger.info(
      `[MarketAwareness] Summary — total ticks=${this._tickCount}, ` +
      `symbols=${this._lastUpdateBySymbol.size}\n  ${parts.join('\n  ')}`
    );
  }
}

// Add EventEmitter methods
const EventEmitter = require('events');
Object.setPrototypeOf(MarketAwarenessEngine.prototype, EventEmitter.prototype);

// Singleton
const engine = new MarketAwarenessEngine();
module.exports = engine;
