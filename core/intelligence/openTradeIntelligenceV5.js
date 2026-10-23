// core/intelligence/openTradeIntelligenceV5.js
// OTIE v7 — high-throughput profit trajectory observer for Deriv Multipliers.
//
// ARCHITECTURE
//   Tick handler: synchronous after warm-up. No DB lookups on the hot path.
//   Adoption:    deduped via _adopting set; driven from Trade docs AND
//                Deriv portfolio at startup, so every open contract is
//                tracked before the first tick arrives.
//   Close:       fire-and-forget into a bounded worker pool (concurrency 5).
//                Tick handler never blocks on Deriv API roundtrips.
//   State:       per-contract ACTIVE → CLOSING → RELEASED. Prevents
//                double-close attempts and resurrecting closed contracts.
//   Persistence: Trade currentPrice/floatingProfit persistence is delegated
//                to broker._persistContractState (already throttled). OTIE
//                writes the Trade doc exactly once — at close.
//   Watchdog:    every 30s, releases observers that haven't ticked in
//                2 minutes after confirming closed at Deriv.
//
// BEHAVIOR (identical to v6.1 for close decisions)
//   1. MAX_LOSS      profit <= maxLossR × stake
//   2. DRAWDOWN      gave back >= drawdownClosePct of peak >= drawdownMinPeakPct
//   3. CHOP          >= chopMaxReversals profit flips in chopWindowMs
//   4. SLOPE_FLIP    slope < -slopeMinMagnitude for slopeMinTimeSincePeakMs
//   5. FLAT          profit stagnant >= flatCloseMs while in profit
//   6. STALE_PEAK    no new high for stalePeakMs while in profit
//
// The only change from v6.1 in decision logic: a per-contract closeAttempted
// flag ensures a close is enqueued exactly once per contract.

const EventEmitter = require('events');
const Trade = require('../../models/Trade');
const TradeManagementDecision = require('../../models/TradeManagementDecision');
const eventBus = require('../../infrastructure/eventBus');
const orderService = require('../execution/orderService');
const { getBroker } = require('../execution/brokerFactory');
const logger = require('../../infrastructure/logger') || console;

// ========================================================================
// CONFIG
// ========================================================================
const CONFIG = {
  maxLossR: parseFloat(process.env.OTIE_MAX_LOSS_R) || -2.0,
  drawdownClosePct: parseFloat(process.env.OTIE_DRAWDOWN_CLOSE_PCT) || 0.40,
  drawdownMinPeakPct: parseFloat(process.env.OTIE_DRAWDOWN_MIN_PEAK_PCT) || 0.20,
  chopWindowMs: parseInt(process.env.OTIE_CHOP_WINDOW_MS) || 30000,
  chopMaxReversals: parseInt(process.env.OTIE_CHOP_MAX_REVERSALS) || 8,
  minPeakToProtectPct: parseFloat(process.env.OTIE_MIN_PEAK_TO_PROTECT_PCT) || 0.15,
  slopeLookback: parseInt(process.env.OTIE_SLOPE_LOOKBACK) || 10,
  slopeMinTimeSincePeakMs: parseInt(process.env.OTIE_SLOPE_MIN_TIME_MS) || 10000,
  slopeMinMagnitude: parseFloat(process.env.OTIE_SLOPE_MIN_MAGNITUDE) || 0.0005,
  flatThresholdPct: parseFloat(process.env.OTIE_FLAT_THRESHOLD_PCT) || 0.02,
  flatCloseMs: parseInt(process.env.OTIE_FLAT_CLOSE_MS) || 30000,
  minProfitForFlatClosePct: parseFloat(process.env.OTIE_MIN_PROFIT_FLAT_PCT) || 0.10,
  stalePeakMs: parseInt(process.env.OTIE_STALE_PEAK_MS) || 180000,
  minProfitForStaleClosePct: parseFloat(process.env.OTIE_MIN_PROFIT_STALE_PCT) || 0.20,
  closeCooldownMs: parseInt(process.env.OTIE_CLOSE_COOLDOWN_MS) || 15000,
  logIntervalMs: parseInt(process.env.OTIE_LOG_INTERVAL_MS) || 5000,
  watchdogIntervalMs: parseInt(process.env.OTIE_WATCHDOG_INTERVAL_MS) || 30000,
  staleTickThresholdMs: parseInt(process.env.OTIE_STALE_TICK_MS) || 120000,
  closeWorkerConcurrency: parseInt(process.env.OTIE_CLOSE_CONCURRENCY) || 5,
  maxSeriesLength: 120,
  maxCloseAttempts: 3,
};

// ========================================================================
// HELPERS
// ========================================================================
function normalizeSymbol(symbol) {
  if (!symbol) return '';
  return symbol.replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
}

// ========================================================================
// ContractObserver — one per open contract
// ========================================================================
class ContractObserver {
  constructor(trade, config = CONFIG, source = 'trade-doc') {
    this.tradeId = String(trade.contractId);
    this.symbol = normalizeSymbol(trade.instrument);
    this.side = String(trade.side || '').toUpperCase();
    this.stake = Number(trade.stake) || 1;
    this.multiplier = Number(trade.multiplier) || 100;
    this.openPrice = Number(trade.openPrice) || 0;
    this.config = config;
    this.source = source;

    this.phase = 'ACTIVE';         // ACTIVE | CLOSING | RELEASED
    this.closeAttempted = false;
    this.closeAttempts = 0;

    this.series = [];
    this.peak = { profit: 0, at: 0 };
    this.firstTickAt = Date.now();
    this.tickCount = 0;
    this.lastDeltaSign = 0;
    this.reversals = [];
    this.flatStartProfit = null;
    this.flatStartAt = 0;
    this.lastCloseAttempt = 0;
    this.lastLogAt = 0;

    // Per-contract diagnostics
    this.totalTickLatencyMs = 0;
    this.avgTickLatencyMs = 0;
  }

  observe(state, latencyMs = 0) {
    const now = Date.now();
    const profit = Number(state.currentProfit) || 0;
    const price = Number(state.currentSpot) || 0;

    this.tickCount++;
    if (latencyMs > 0) {
      this.totalTickLatencyMs += latencyMs;
      this.avgTickLatencyMs = this.totalTickLatencyMs / this.tickCount;
    }

    this.series.push({ t: now, profit, price });
    if (this.series.length > this.config.maxSeriesLength) this.series.shift();

    if (profit > this.peak.profit) {
      this.peak = { profit, at: now };
    }

    if (this.series.length >= 2) {
      const prev = this.series[this.series.length - 2].profit;
      const curr = this.series[this.series.length - 1].profit;
      const delta = curr - prev;
      const sign = delta > 0 ? 1 : delta < 0 ? -1 : 0;
      if (sign !== 0 && sign !== this.lastDeltaSign && this.lastDeltaSign !== 0) {
        this.reversals.push(now);
      }
      if (sign !== 0) this.lastDeltaSign = sign;
    }

    const cutoff = now - this.config.chopWindowMs;
    this.reversals = this.reversals.filter(t => t >= cutoff);

    const flatThreshold = Math.max(
      Math.abs(this.peak.profit) * this.config.flatThresholdPct,
      this.stake * this.config.flatThresholdPct
    );
    if (this.flatStartProfit === null) {
      this.flatStartProfit = profit;
      this.flatStartAt = now;
    } else if (Math.abs(profit - this.flatStartProfit) > flatThreshold) {
      this.flatStartProfit = profit;
      this.flatStartAt = now;
    }
  }

  metrics(now = Date.now()) {
    const current = this.series.length > 0 ? this.series[this.series.length - 1].profit : 0;
    const peak = this.peak.profit || 0;
    const drawdown = Math.max(0, peak - current);
    const drawdownPct = peak > 0 ? drawdown / peak : 0;
    const timeSincePeak = this.peak.at > 0 ? now - this.peak.at : 0;
    const flatTime = this.flatStartAt > 0 ? now - this.flatStartAt : 0;

    const lookback = this.config.slopeLookback;
    const window = this.series.slice(-lookback);
    let slope = 0;
    if (window.length >= 3) {
      const n = window.length;
      const xs = window.map((_, i) => i);
      const ys = window.map(p => p.profit);
      const sumX = xs.reduce((a, b) => a + b, 0);
      const sumY = ys.reduce((a, b) => a + b, 0);
      const sumXY = xs.reduce((a, x, i) => a + x * ys[i], 0);
      const sumX2 = xs.reduce((a, x) => a + x * x, 0);
      const denom = n * sumX2 - sumX * sumX;
      slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
    }

    return {
      current,
      peak,
      drawdown,
      drawdownPct,
      timeSincePeak,
      flatTime,
      slope,
      reversals: this.reversals.length,
      tickCount: this.tickCount,
      elapsedMs: now - this.firstTickAt,
      profitR: current / this.stake,
      peakR: peak / this.stake,
      phase: this.phase,
      source: this.source,
      avgTickLatencyMs: Number(this.avgTickLatencyMs.toFixed(2)),
    };
  }
}

// ========================================================================
// CloseWorker — bounded concurrency for close execution
// ========================================================================
class CloseWorker {
  constructor(concurrency = 5) {
    this._queue = [];
    this._active = 0;
    this._concurrency = concurrency;
    this._totalEnqueued = 0;
    this._totalCompleted = 0;
    this._totalFailed = 0;
  }

  enqueue(taskFn) {
    this._queue.push(taskFn);
    this._totalEnqueued++;
    this._drain();
  }

  _drain() {
    while (this._active < this._concurrency && this._queue.length > 0) {
      const fn = this._queue.shift();
      this._active++;
      Promise.resolve()
        .then(fn)
        .then(() => { this._totalCompleted++; })
        .catch((err) => {
          this._totalFailed++;
          logger.debug(`[CloseWorker] Task threw: ${err.message}`);
        })
        .finally(() => {
          this._active--;
          this._drain();
        });
    }
  }

  stats() {
    return {
      queueLength: this._queue.length,
      active: this._active,
      concurrency: this._concurrency,
      totalEnqueued: this._totalEnqueued,
      totalCompleted: this._totalCompleted,
      totalFailed: this._totalFailed,
    };
  }
}

// ========================================================================
// Engine
// ========================================================================
class OpenTradeIntelligenceV7 extends EventEmitter {
  constructor(broker = null) {
    super();
    this.broker = broker || getBroker('deriv_cfd');
    this._observers = new Map();
    this._adopting = new Set();
    this._warnedAdoptFail = new Set();
    this._closeWorker = new CloseWorker(CONFIG.closeWorkerConcurrency);

    this._warmUpPromise = null;
    this._watchdogTimer = null;
    this._stopped = false;

    if (!this.broker.isConnected || !this.broker.isConnected()) {
      this.broker.connect().catch((err) => {
        logger.warn(`[OTIE] Broker connect failed: ${err.message}`);
      });
    }

    // ---- Event bindings ----
    eventBus.on('trade.placed', (data) => {
      this._adoptTradeAsync(data?.contractId || data?.tradeId, data?.instrument);
    });

    eventBus.on('trade.closed', (data) => {
      this._releaseTrade(data?.contractId || data?.tradeId, 'trade.closed event');
    });

    try {
      this.broker.on('contractUpdate', (state) => {
        this._onContractUpdate(state);
      });
      logger.info('[OTIE] Attached to broker.contractUpdate (v7 sync hot path).');
    } catch (err) {
      logger.error(`[OTIE] FAILED to attach contractUpdate listener: ${err.message}`);
    }

    // ---- Warm-up: adopt all open contracts from both sources ----
    this._warmUpPromise = this._warmUp().catch((err) => {
      logger.error(`[OTIE] Warm-up failed: ${err.message}`);
    });

    // ---- Watchdog ----
    this._watchdogTimer = setInterval(() => {
      if (this._stopped) return;
      this._checkStaleObservers().catch(() => {});
    }, CONFIG.watchdogIntervalMs);
    if (typeof this._watchdogTimer.unref === 'function') this._watchdogTimer.unref();

    logger.info('[OTIE] Initialized (v7 — sync hot path, close worker, warm-up from 2 sources).');
    logger.info(
      `[OTIE] Thresholds: maxLoss=${CONFIG.maxLossR}R dd=${(CONFIG.drawdownClosePct * 100).toFixed(0)}% ` +
      `chop=${CONFIG.chopMaxReversals}revs/${CONFIG.chopWindowMs / 1000}s ` +
      `slopeMin=${CONFIG.slopeMinMagnitude} flat=${CONFIG.flatCloseMs / 1000}s ` +
      `stale=${CONFIG.stalePeakMs / 60000}min closeConcurrency=${CONFIG.closeWorkerConcurrency}`
    );
  }

  // ======================================================================
  // HOT PATH — synchronous after warm-up
  // ======================================================================
  _onContractUpdate(state) {
    if (!state || !state.contractId) return;
    const tStart = process.hrtime.bigint();
    const cid = String(state.contractId);

    const observer = this._observers.get(cid);

    // Fast path: observer exists
    if (observer) {
      if (observer.phase !== 'ACTIVE') return;  // CLOSING or RELEASED
      const latencyMs = Number(process.hrtime.bigint() - tStart) / 1e6;
      this._processTick(observer, state, latencyMs);
      return;
    }

    // Cold path: not tracked yet
    if (this._adopting.has(cid)) return;  // adoption already in flight
    this._adopting.add(cid);
    this._adoptAsync(state).finally(() => this._adopting.delete(cid));
  }

  _processTick(observer, state, latencyMs = 0) {
    observer.observe(state, latencyMs);
    const verdict = this._analyze(observer, state);

    // Close path — enqueue once, never block
    if (verdict.action === 'CLOSE' && !observer.closeAttempted) {
      if (!state.isValidToSell) {
        logger.info(
          `[OTIE:${observer.symbol}:${observer.tradeId}] CLOSE deferred — isValidToSell=false. ` +
          `reason=${verdict.reason}`
        );
      } else {
        observer.closeAttempted = true;
        observer.phase = 'CLOSING';
        const m = verdict.metrics;
        logger.info(
          `[OTIE:CLOSE] ${observer.symbol}:${observer.tradeId} reason=${verdict.reason} ` +
          `profit=${m.current.toFixed(2)}$ peak=${m.peak.toFixed(2)}$ ` +
          `profitR=${m.profitR.toFixed(2)} peakR=${m.peakR.toFixed(2)}`
        );
        this._closeWorker.enqueue(() => this._executeClose(observer, verdict));
      }
    }

    // Log + emit (throttled to 5s + always on close decision)
    const now = Date.now();
    const shouldLog = (now - observer.lastLogAt >= CONFIG.logIntervalMs) || verdict.action === 'CLOSE';
    if (shouldLog) {
      observer.lastLogAt = now;
      const m = verdict.metrics;
      logger.info(
        `[OTIE:${observer.symbol}:${observer.tradeId}] ` +
        `profit=${m.current.toFixed(2)}$ peak=${m.peak.toFixed(2)}$ ` +
        `dd=${(m.drawdownPct * 100).toFixed(0)}% slope=${m.slope.toFixed(4)} ` +
        `revs=${m.reversals} flat=${(m.flatTime / 1000).toFixed(0)}s ` +
        `age=${(m.elapsedMs / 1000).toFixed(0)}s ` +
        `action=${verdict.action}${verdict.action === 'CLOSE' ? ` (${verdict.reason})` : ''}`
      );
      try { this.emit('otieState', this._serializeState(observer, verdict)); } catch (_) {}
    }
  }

  // ======================================================================
  // Adopt (async cold path only)
  // ======================================================================
  async _adoptAsync(state) {
    const cid = String(state.contractId);

    // Try Trade doc first
    try {
      const trade = await Trade.findOne({ contractId: cid, status: 'OPEN' }).lean();
      if (trade) {
        this._adoptTradeSync(trade, 'trade-doc');
        // Process the current tick immediately (we're already late)
        const observer = this._observers.get(cid);
        if (observer) {
          const fakeState = { ...state };
          this._processTick(observer, fakeState, 0);
        }
        return;
      }
    } catch (err) {
      logger.debug(`[OTIE] Trade lookup for ${cid} failed: ${err.message}`);
    }

    // Fallback: adopt from state
    try {
      const observer = this._adoptFromState(state);
      const fakeState = { ...state };
      this._processTick(observer, fakeState, 0);
    } catch (err) {
      if (!this._warnedAdoptFail.has(cid)) {
        this._warnedAdoptFail.add(cid);
        logger.warn(`[OTIE] Cannot adopt ${cid} from state either: ${err.message}`);
      }
    }
  }

  _adoptTradeAsync(contractId, instrument) {
    if (!contractId) return;
    const cid = String(contractId);
    if (this._observers.has(cid) || this._adopting.has(cid)) return;

    this._adopting.add(cid);
    Trade.findOne({ contractId: cid, status: 'OPEN' }).lean()
      .then(trade => {
        if (!trade) {
          logger.debug(`[OTIE] trade.placed for ${cid} — no OPEN Trade doc, will adopt from tick`);
          return;
        }
        this._adoptTradeSync(trade, 'trade-placed');
      })
      .catch(err => {
        logger.warn(`[OTIE] trade.placed adopt ${cid} failed: ${err.message}`);
      })
      .finally(() => this._adopting.delete(cid));
  }

  _adoptTradeSync(trade, source = 'trade-doc') {
    const cid = String(trade.contractId);
    if (this._observers.has(cid)) return;
    const observer = new ContractObserver(trade, CONFIG, source);
    this._observers.set(cid, observer);
    logger.info(
      `[OTIE] Adopted ${cid} from ${source} (${observer.symbol} ${observer.side} ` +
      `stake=${observer.stake}$ mult=${observer.multiplier}x)`
    );
  }

  _adoptFromState(state) {
    const contractId = String(state.contractId);
    if (this._observers.has(contractId)) return this._observers.get(contractId);

    const raw = state.raw || {};
    const contractType = String(state.contractType || raw.contract_type || '').toUpperCase();
    const side = contractType.includes('UP') ? 'BUY'
               : contractType.includes('DOWN') ? 'SELL'
               : 'BUY';

    let multiplier = 100;
    if (raw.multiplier != null && Number.isFinite(Number(raw.multiplier))) {
      multiplier = Number(raw.multiplier);
    } else if (raw.multiplier_range != null && Number.isFinite(Number(raw.multiplier_range))) {
      multiplier = Number(raw.multiplier_range);
    }

    const stakeCandidate =
      Number(state.buyPrice) ||
      Number(raw.buy_price) ||
      Number(raw.purchase_price) ||
      0;
    const stake = stakeCandidate > 0 ? stakeCandidate : 1;

    const symbol = normalizeSymbol(state.symbol || raw.underlying || raw.underlying_symbol || 'UNKNOWN');
    const openPrice =
      Number(state.entrySpot) ||
      Number(raw.entry_spot) ||
      Number(raw.entry_tick) ||
      Number(state.currentSpot) ||
      0;

    if (!symbol || symbol === 'UNKNOWN') {
      throw new Error(`Cannot adopt ${contractId}: no symbol in state or raw`);
    }

    const synthetic = { contractId, instrument: symbol, side: side.toLowerCase(), stake, multiplier, openPrice };
    const observer = new ContractObserver(synthetic, CONFIG, 'state-synthesized');
    this._observers.set(contractId, observer);
    logger.info(
      `[OTIE] Adopted ${contractId} from STATE (${symbol} ${side} stake=${stake}$ mult=${multiplier}x openPrice=${openPrice})`
    );
    return observer;
  }

  _adoptFromPosition(pos) {
    const contractId = String(pos.id || '');
    if (!contractId || this._observers.has(contractId)) return;
    const side = pos.side === 'BUY' ? 'buy' : pos.side === 'SELL' ? 'sell' : 'buy';
    const synthetic = {
      contractId,
      instrument: pos.instrument || 'UNKNOWN',
      side,
      stake: pos.purchasePrice || 1,
      multiplier: 100,
      openPrice: pos.entryPrice || 0,
    };
    const observer = new ContractObserver(synthetic, CONFIG, 'portfolio-synthesized');
    this._observers.set(contractId, observer);
    logger.info(
      `[OTIE] Adopted ${contractId} from PORTFOLIO (${observer.symbol} ${side} stake=${observer.stake}$)`
    );
  }

  // ======================================================================
  // Warm-up: adopt from both Trade docs and Deriv portfolio
  // ======================================================================
  async _warmUp() {
    let openTrades = [];
    let brokerPositions = [];

    try {
      const results = await Promise.all([
        Trade.find({ status: 'OPEN' }).lean().catch(err => {
          logger.warn(`[OTIE] Warm-up Trade query failed: ${err.message}`);
          return [];
        }),
        this.broker.getOpenTrades().catch(err => {
          logger.warn(`[OTIE] Warm-up portfolio query failed: ${err.message}`);
          return [];
        }),
      ]);
      openTrades = results[0];
      brokerPositions = results[1];
    } catch (err) {
      logger.error(`[OTIE] Warm-up fatal: ${err.message}`);
      return;
    }

    logger.info(
      `[OTIE] Warm-up: ${openTrades.length} Trade doc(s), ${brokerPositions.length} broker position(s)`
    );

    // Adopt from Trade docs first (has full metadata)
    for (const trade of openTrades) {
      const cid = String(trade.contractId);
      if (!cid || this._observers.has(cid)) continue;

      const observer = new ContractObserver(trade, CONFIG, 'trade-doc-warmup');

      // Seed peak from current profit on Deriv
      try {
        const status = await this.broker.getContractStatus(cid);
        if (status.status === 'closed') {
          logger.info(`[OTIE] Warm-up: ${cid} already closed at Deriv, skipping`);
          continue;
        }
        if (status.status === 'open' && status.profit != null && Number.isFinite(Number(status.profit))) {
          const currentProfit = Number(status.profit);
          observer.peak = { profit: currentProfit, at: Date.now() };
          observer.series.push({ t: Date.now(), profit: currentProfit, price: 0 });
        }
      } catch (err) {
        logger.debug(`[OTIE] Warm-up status check failed for ${cid}: ${err.message}`);
      }

      this._observers.set(cid, observer);
    }

    // Adopt any broker positions missing a Trade doc
    for (const pos of brokerPositions) {
      const cid = String(pos.id);
      if (this._observers.has(cid)) continue;
      this._adoptFromPosition(pos);
    }

    // Check for Trade docs OPEN but contract CLOSED at Deriv (orphans)
    const brokerIds = new Set(brokerPositions.map(p => String(p.id)));
    for (const trade of openTrades) {
      const cid = String(trade.contractId);
      if (brokerIds.has(cid)) continue;
      logger.warn(
        `[OTIE] Warm-up: Trade ${cid} is OPEN in DB but not in broker portfolio — ` +
        `broker reconcile will close it`
      );
    }

    logger.info(`[OTIE] Warm-up complete. Tracking ${this._observers.size} contract(s).`);
  }

  // ======================================================================
  // Analysis
  // ======================================================================
  _analyze(observer, state) {
    const m = observer.metrics();
    const cfg = observer.config;
    const stake = observer.stake;

    const minPeakForProtect = stake * cfg.minPeakToProtectPct;
    const minPeakForDrawdown = stake * cfg.drawdownMinPeakPct;
    const maxLossDollars = stake * Math.abs(cfg.maxLossR);
    const minProfitForFlat = stake * cfg.minProfitForFlatClosePct;
    const minProfitForStale = stake * cfg.minProfitForStaleClosePct;

    if (m.current <= -maxLossDollars) {
      return { action: 'CLOSE', reason: `MAX_LOSS profit=${m.current.toFixed(2)}$ <= -${maxLossDollars.toFixed(2)}$`, metrics: m };
    }
    if (m.peak >= minPeakForDrawdown && m.drawdownPct >= cfg.drawdownClosePct) {
      return { action: 'CLOSE', reason: `DRAWDOWN ${(m.drawdownPct * 100).toFixed(0)}% (peak=${m.peak.toFixed(2)}$ now=${m.current.toFixed(2)}$)`, metrics: m };
    }
    if (m.peak >= minPeakForProtect && m.reversals >= cfg.chopMaxReversals) {
      return { action: 'CLOSE', reason: `CHOP ${m.reversals} reversals in ${cfg.chopWindowMs / 1000}s`, metrics: m };
    }
    if (m.peak >= minPeakForProtect && m.slope < -cfg.slopeMinMagnitude && m.timeSincePeak >= cfg.slopeMinTimeSincePeakMs) {
      return { action: 'CLOSE', reason: `SLOPE_FLIP slope=${m.slope.toFixed(4)}$/tick for ${(m.timeSincePeak / 1000).toFixed(0)}s`, metrics: m };
    }
    if (m.current > minProfitForFlat && m.flatTime >= cfg.flatCloseMs) {
      return { action: 'CLOSE', reason: `FLAT ${(m.flatTime / 1000).toFixed(0)}s at +${m.current.toFixed(2)}$`, metrics: m };
    }
    if (m.current > minProfitForStale && m.timeSincePeak >= cfg.stalePeakMs) {
      return { action: 'CLOSE', reason: `STALE_PEAK ${(m.timeSincePeak / 60000).toFixed(1)}min no new high`, metrics: m };
    }
    return { action: 'HOLD', reason: 'healthy', metrics: m };
  }

  // ======================================================================
  // Close execution (runs in CloseWorker)
  // ======================================================================
  async _executeClose(observer, verdict) {
    const now = Date.now();
    if (now - observer.lastCloseAttempt < CONFIG.closeCooldownMs && observer.closeAttempts > 0) {
      observer.closeAttempted = false;
      observer.phase = 'ACTIVE';
      return;
    }
    observer.lastCloseAttempt = now;
    observer.closeAttempts++;

    const m = verdict.metrics;

    try {
      // Verify still open
      let verification = { status: 'unknown' };
      try {
        verification = await this.broker.getContractStatus(observer.tradeId);
      } catch (err) {
        logger.warn(`[OTIE] Pre-close verify failed for ${observer.tradeId}: ${err.message}`);
      }

      if (verification.status === 'closed') {
        logger.info(`[OTIE] ${observer.tradeId} already closed at Deriv — releasing`);
        this._releaseTrade(observer.tradeId, 'already closed at Deriv');
        return;
      }
      if (verification.status === 'unknown') {
        logger.warn(`[OTIE] ${observer.tradeId} status unknown — will retry next tick`);
        observer.closeAttempted = false;
        observer.phase = 'ACTIVE';
        observer.lastCloseAttempt = 0;  // allow immediate retry
        return;
      }

      // Execute close via orderService (updates Trade doc + fires trade.closed)
      await orderService.closeTrade(observer.tradeId, 'deriv_cfd');

      logger.info(
        `[OTIE:CLOSED] ${observer.symbol}:${observer.tradeId} ` +
        `finalProfit=${m.current.toFixed(2)}$ peak=${m.peak.toFixed(2)}$ ` +
        `ticks=${m.tickCount} reason=${verdict.reason}`
      );

      this.emit('otieV5Action', {
        tradeId: observer.tradeId,
        action: 'CLOSE',
        reason: verdict.reason,
        metrics: {
          profit: m.current,
          peak: m.peak,
          drawdownPct: m.drawdownPct,
          slope: m.slope,
          reversals: m.reversals,
        },
        timestamp: new Date().toISOString(),
      });

      this._releaseTrade(observer.tradeId, 'close confirmed');
    } catch (err) {
      logger.error(`[OTIE] Close failed for ${observer.tradeId} (attempt ${observer.closeAttempts}): ${err.message}`);

      if (observer.closeAttempts >= CONFIG.maxCloseAttempts) {
        logger.error(
          `[OTIE] ${observer.tradeId} close FAILED after ${observer.closeAttempts} attempts — giving up. ` +
          `Manual intervention required.`
        );
        this._releaseTrade(observer.tradeId, `close failed ${observer.closeAttempts}x`);
      } else {
        // Allow retry
        observer.closeAttempted = false;
        observer.phase = 'ACTIVE';
        observer.lastCloseAttempt = 0;
      }
    }
  }

  // ======================================================================
  // Release
  // ======================================================================
  _releaseTrade(contractId, reason = 'unknown') {
    if (!contractId) return;
    const cid = String(contractId);
    const observer = this._observers.get(cid);
    if (!observer) return;

    const m = observer.metrics();
    observer.phase = 'RELEASED';
    logger.info(
      `[OTIE] Released ${cid} (${reason}) — final=${m.current.toFixed(2)}$ peak=${m.peak.toFixed(2)}$ ` +
      `ticks=${m.tickCount} duration=${(m.elapsedMs / 1000).toFixed(0)}s source=${observer.source}`
    );
    this._observers.delete(cid);
    this._warnedAdoptFail.delete(cid);

    try {
      this.emit('otieState', { tradeId: cid, action: 'RELEASED', reason, timestamp: new Date().toISOString() });
    } catch (_) {}
  }

  // ======================================================================
  // Watchdog
  // ======================================================================
  async _checkStaleObservers() {
    if (this._observers.size === 0) return;
    const now = Date.now();

    for (const [cid, observer] of this._observers) {
      if (observer.phase !== 'ACTIVE') continue;
      const lastTickAt = observer.series[observer.series.length - 1]?.t || 0;
      if ((now - lastTickAt) < CONFIG.staleTickThresholdMs) continue;

      // Stale observer — force status check
      try {
        const status = await this.broker.getContractStatus(cid);
        if (status.status === 'closed') {
          this._releaseTrade(cid, 'watchdog: closed at Deriv');
        } else if (status.status === 'open' && status.profit != null) {
          // Re-inject state
          this._processTick(observer, {
            contractId: cid,
            currentProfit: Number(status.profit),
            currentSpot: 0,
            isValidToSell: true,
          }, 0);
        }
      } catch (err) {
        logger.debug(`[OTIE] Watchdog status check failed for ${cid}: ${err.message}`);
      }
    }
  }

  // ======================================================================
  // Serialization for otieState event
  // ======================================================================
  _serializeState(observer, verdict) {
    const m = verdict.metrics;
    return {
      tradeId: observer.tradeId,
      symbol: observer.symbol,
      side: observer.side,
      stake: observer.stake,
      multiplier: observer.multiplier,
      source: observer.source,
      phase: observer.phase,
      profit: m.current,
      peak: m.peak,
      drawdown: m.drawdown,
      drawdownPct: m.drawdownPct,
      slope: m.slope,
      reversals: m.reversals,
      flatTime: m.flatTime,
      timeSincePeak: m.timeSincePeak,
      age: m.elapsedMs,
      profitR: m.profitR,
      peakR: m.peakR,
      tickCount: m.tickCount,
      avgTickLatencyMs: m.avgTickLatencyMs,
      action: verdict.action,
      reason: verdict.action === 'CLOSE' ? verdict.reason : null,
      history: observer.series.slice(-30).map(p => p.profit),
      thresholds: {
        maxLossR: observer.config.maxLossR,
        drawdownClosePct: observer.config.drawdownClosePct,
        chopMaxReversals: observer.config.chopMaxReversals,
        chopWindowMs: observer.config.chopWindowMs,
        stalePeakMs: observer.config.stalePeakMs,
        flatCloseMs: observer.config.flatCloseMs,
        minPeakToProtectPct: observer.config.minPeakToProtectPct,
      },
      timestamp: new Date().toISOString(),
    };
  }

  // ======================================================================
  // Public API
  // ======================================================================
  updateConfig(newThresholds) {
    if (!newThresholds) return;
    if (Number.isFinite(newThresholds.maxLossR)) CONFIG.maxLossR = newThresholds.maxLossR;
    if (Number.isFinite(newThresholds.drawdownClosePct)) CONFIG.drawdownClosePct = newThresholds.drawdownClosePct;
    if (Number.isFinite(newThresholds.chopMaxReversals)) CONFIG.chopMaxReversals = newThresholds.chopMaxReversals;
    if (Number.isFinite(newThresholds.stalePeakMs)) CONFIG.stalePeakMs = newThresholds.stalePeakMs;
    logger.info('[OTIE] Config updated.');
  }

  getState(contractId) {
    const observer = this._observers.get(String(contractId));
    return observer ? observer.metrics() : null;
  }

  getAllStates() {
    const out = {};
    for (const [cid, obs] of this._observers) {
      out[cid] = {
        ...obs.metrics(),
        symbol: obs.symbol,
        side: obs.side,
        stake: obs.stake,
        multiplier: obs.multiplier,
        source: obs.source,
      };
    }
    return out;
  }

  getHealth() {
    return {
      observers: this._observers.size,
      adopting: this._adopting.size,
      closeWorker: this._closeWorker.stats(),
      phases: {
        active: Array.from(this._observers.values()).filter(o => o.phase === 'ACTIVE').length,
        closing: Array.from(this._observers.values()).filter(o => o.phase === 'CLOSING').length,
      },
    };
  }

  get observerCount() { return this._observers.size; }

  stop() {
    this._stopped = true;
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
    logger.info('[OTIE] Stopped.');
  }
}

module.exports = new OpenTradeIntelligenceV7();
