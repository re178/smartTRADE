// core/intelligence/openTradeIntelligenceV5.js
// OTIE v6.1 – Tick-driven profit trajectory observer for Deriv Multipliers.
//
// [FILE-1] Bug fix: OTIE used to require a Trade document in MongoDB to
//   observe a contract. If the Trade doc was missing (creation failed,
//   marked CLOSED by reconcile, or legacy), OTIE silently dropped every
//   tick and the frontend stayed empty — even though contracts were open
//   at Deriv. Fix: adopt from contractUpdate state directly when no Trade
//   doc is present. Enrich from state.raw (multiplier, buy_price,
//   entry_spot, contract_type). Periodic resync closes the gap when a
//   Trade doc appears after the contract was already being tracked.
//   Every adoption path logs which source it used, so silent drops are
//   impossible to miss in logs.

const EventEmitter = require('events');
const Trade = require('../../models/Trade');
const TradeManagementDecision = require('../../models/TradeManagementDecision');
const eventBus = require('../../infrastructure/eventBus');
const orderService = require('../execution/orderService');
const { getBroker } = require('../execution/brokerFactory');
const logger = require('../../infrastructure/logger') || console;

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
  fallbackTickMs: parseInt(process.env.OTIE_FALLBACK_TICK_MS) || 30000,
  resyncIntervalMs: parseInt(process.env.OTIE_RESYNC_INTERVAL_MS) || 60000,
  maxSeriesLength: 120,
};

function normalizeSymbol(symbol) {
  if (!symbol) return '';
  return symbol.replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
}

// ========================================================================
// ContractObserver
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
    this.isClosing = false;
    this.loggedReversalsWarn = false;
  }

  observe(state) {
    const now = Date.now();
    const profit = Number(state.currentProfit) || 0;
    const price = Number(state.currentSpot) || 0;

    this.tickCount++;
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

    return this.metrics(now);
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
    };
  }
}

// ========================================================================
// Engine
// ========================================================================
class OpenTradeIntelligenceV6 extends EventEmitter {
  constructor(broker = null) {
    super();
    this.broker = broker || getBroker('deriv_cfd');
    this._observers = new Map();
    this._fallbackTimer = null;
    this._resyncTimer = null;
    this._restorePromise = null;
    // [FILE-1] Dedupe warnings for contracts we can't adopt
    this._warnedAdoptFail = new Set();

    if (!this.broker.isConnected || !this.broker.isConnected()) {
      this.broker.connect().catch((err) => {
        logger.warn(`[OTIE] Broker connect failed: ${err.message}`);
      });
    }

    eventBus.on('trade.placed', (data) => {
      this._adoptTrade(data?.contractId || data?.tradeId, data?.instrument);
    });

    eventBus.on('trade.closed', (data) => {
      this._releaseTrade(data?.contractId || data?.tradeId);
    });

    try {
      this.broker.on('contractUpdate', (state) => {
        this._onContractUpdate(state);
      });
      logger.info('[OTIE] Attached to broker.contractUpdate.');
    } catch (err) {
      logger.error(`[OTIE] FAILED to attach contractUpdate listener: ${err.message}`);
    }

    this._restorePromise = this._restoreFromDB().catch((err) => {
      logger.error(`[OTIE] Restore failed: ${err.message}`);
    });

    this._fallbackTimer = setInterval(() => {
      this._fallbackCheck().catch((err) => {
        logger.warn(`[OTIE] Fallback check failed: ${err.message}`);
      });
    }, CONFIG.fallbackTickMs);
    if (typeof this._fallbackTimer.unref === 'function') this._fallbackTimer.unref();

    // [FILE-1] Periodic resync
    this._resyncTimer = setInterval(() => {
      this._resync().catch((err) => {
        logger.warn(`[OTIE] Resync failed: ${err.message}`);
      });
    }, CONFIG.resyncIntervalMs);
    if (typeof this._resyncTimer.unref === 'function') this._resyncTimer.unref();

    logger.info('[OTIE] Initialized (v6.1 — tick-driven observer, adopts without Trade doc).');
    logger.info(
      `[OTIE] Thresholds: maxLoss=${CONFIG.maxLossR}R dd=${(CONFIG.drawdownClosePct * 100).toFixed(0)}% ` +
      `chop=${CONFIG.chopMaxReversals}revs/${CONFIG.chopWindowMs / 1000}s ` +
      `slopeMin=${CONFIG.slopeMinMagnitude} flat=${CONFIG.flatCloseMs / 1000}s ` +
      `stale=${CONFIG.stalePeakMs / 60000}min resync=${CONFIG.resyncIntervalMs / 1000}s`
    );
  }

  // ======================================================================
  // [FILE-1] Tick handler — adopt from DB OR state, never give up
  // ======================================================================
  async _onContractUpdate(state) {
    if (!state || !state.contractId) return;
    const contractId = String(state.contractId);

    let observer = this._observers.get(contractId);

    // Path 1: not tracked yet — try DB, then state
    if (!observer) {
      // Path 1a: Trade doc exists → full metadata
      try {
        const trade = await Trade.findOne({ contractId, status: 'OPEN' }).lean();
        if (trade) {
          this._adoptTradeSync(trade, 'trade-doc');
          observer = this._observers.get(contractId);
        }
      } catch (err) {
        logger.debug(`[OTIE] Trade lookup for ${contractId} failed: ${err.message}`);
      }

      // Path 1b: no Trade doc → synthesize from state
      if (!observer) {
        try {
          observer = this._adoptFromState(state);
          this._warnedAdoptFail.delete(contractId);
        } catch (err) {
          if (!this._warnedAdoptFail.has(contractId)) {
            this._warnedAdoptFail.add(contractId);
            logger.warn(`[OTIE] Cannot adopt ${contractId} from state either: ${err.message}`);
          }
          return;
        }
      }
    }

    // Feed + analyze
    observer.observe(state);
    const verdict = this._analyze(observer, state);

    if (verdict.action === 'CLOSE') {
      if (!state.isValidToSell) {
        logger.info(
          `[OTIE:${observer.symbol}:${contractId}] CLOSE deferred — isValidToSell=false. reason=${verdict.reason}`
        );
      } else {
        await this._executeClose(observer, verdict);
      }
    }

    const now = Date.now();
    const shouldLog = (now - observer.lastLogAt >= CONFIG.logIntervalMs) || verdict.action === 'CLOSE';
    if (shouldLog) {
      observer.lastLogAt = now;
      const m = verdict.metrics;
      logger.info(
        `[OTIE:${observer.symbol}:${contractId}] ` +
        `profit=${m.current.toFixed(2)}$ peak=${m.peak.toFixed(2)}$ ` +
        `dd=${(m.drawdownPct * 100).toFixed(0)}% slope=${m.slope.toFixed(4)} ` +
        `revs=${m.reversals} flat=${(m.flatTime / 1000).toFixed(0)}s ` +
        `age=${(m.elapsedMs / 1000).toFixed(0)}s ` +
        `action=${verdict.action}${verdict.action === 'CLOSE' ? ` (${verdict.reason})` : ''}`
      );

      try {
        this.emit('otieState', {
          tradeId: contractId,
          symbol: observer.symbol,
          side: observer.side,
          stake: observer.stake,
          multiplier: observer.multiplier,
          source: observer.source,
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
        });
      } catch (err) {
        logger.warn(`[OTIE] otieState emit failed: ${err.message}`);
      }
    }
  }

  // ======================================================================
  // [FILE-1] Adopt from state — no Trade doc required
  // ======================================================================
  _adoptFromState(state) {
    const contractId = String(state.contractId);
    if (this._observers.has(contractId)) return this._observers.get(contractId);

    const raw = state.raw || {};

    // Side: derive from contract_type
    const contractType = String(state.contractType || raw.contract_type || '').toUpperCase();
    const side = contractType.includes('UP') ? 'BUY'
               : contractType.includes('DOWN') ? 'SELL'
               : 'BUY';

    // Multiplier: Deriv reports it in poc for MULTUP/MULTDOWN
    let multiplier = 100;
    if (raw.multiplier != null && Number.isFinite(Number(raw.multiplier))) {
      multiplier = Number(raw.multiplier);
    } else if (raw.multiplier_range != null && Number.isFinite(Number(raw.multiplier_range))) {
      multiplier = Number(raw.multiplier_range);
    }

    // Stake: what was paid. buy_price is exactly that.
    const stakeCandidate =
      Number(state.buyPrice) ||
      Number(raw.buy_price) ||
      Number(raw.purchase_price) ||
      0;
    const stake = stakeCandidate > 0 ? stakeCandidate : 1;

    // Symbol: normalize Deriv symbol
    const symbol = normalizeSymbol(state.symbol || raw.underlying || raw.underlying_symbol || 'UNKNOWN');

    // Entry price
    const openPrice =
      Number(state.entrySpot) ||
      Number(raw.entry_spot) ||
      Number(raw.entry_tick) ||
      Number(state.currentSpot) ||
      0;

    if (!symbol || symbol === 'UNKNOWN') {
      throw new Error(`Cannot adopt ${contractId}: no symbol in state or raw`);
    }

    const synthetic = {
      contractId,
      instrument: symbol,
      side: side.toLowerCase(),
      stake,
      multiplier,
      openPrice,
    };

    const observer = new ContractObserver(synthetic, CONFIG, 'state-synthesized');
    this._observers.set(contractId, observer);

    logger.info(
      `[OTIE] Adopted ${contractId} from STATE (no Trade doc). ` +
      `symbol=${symbol} side=${side} stake=${stake}$ mult=${multiplier}x ` +
      `openPrice=${openPrice}`
    );

    return observer;
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
      return {
        action: 'CLOSE',
        reason: `MAX_LOSS profit=${m.current.toFixed(2)}$ ≤ -${maxLossDollars.toFixed(2)}$`,
        metrics: m,
      };
    }

    if (m.peak >= minPeakForDrawdown && m.drawdownPct >= cfg.drawdownClosePct) {
      return {
        action: 'CLOSE',
        reason: `DRAWDOWN ${(m.drawdownPct * 100).toFixed(0)}% (peak=${m.peak.toFixed(2)}$ now=${m.current.toFixed(2)}$)`,
        metrics: m,
      };
    }

    if (m.peak >= minPeakForProtect && m.reversals >= cfg.chopMaxReversals) {
      return {
        action: 'CLOSE',
        reason: `CHOP ${m.reversals} reversals in ${cfg.chopWindowMs / 1000}s at peak=${m.peak.toFixed(2)}$`,
        metrics: m,
      };
    }

    if (
      m.peak >= minPeakForProtect &&
      m.slope < -cfg.slopeMinMagnitude &&
      m.timeSincePeak >= cfg.slopeMinTimeSincePeakMs
    ) {
      return {
        action: 'CLOSE',
        reason: `SLOPE_FLIP slope=${m.slope.toFixed(4)}$/tick for ${(m.timeSincePeak / 1000).toFixed(0)}s after peak`,
        metrics: m,
      };
    }

    if (m.current > minProfitForFlat && m.flatTime >= cfg.flatCloseMs) {
      return {
        action: 'CLOSE',
        reason: `FLAT ${(m.flatTime / 1000).toFixed(0)}s stagnant at +${m.current.toFixed(2)}$`,
        metrics: m,
      };
    }

    if (m.current > minProfitForStale && m.timeSincePeak >= cfg.stalePeakMs) {
      return {
        action: 'CLOSE',
        reason: `STALE_PEAK no new high for ${(m.timeSincePeak / 60000).toFixed(1)}min (peak=${m.peak.toFixed(2)}$ now=${m.current.toFixed(2)}$)`,
        metrics: m,
      };
    }

    return { action: 'HOLD', reason: 'healthy', metrics: m };
  }

  async _executeClose(observer, verdict) {
    const now = Date.now();
    if (observer.isClosing) return;
    if (now - observer.lastCloseAttempt < CONFIG.closeCooldownMs) return;

    observer.lastCloseAttempt = now;
    observer.isClosing = true;
    const m = verdict.metrics;

    logger.info(
      `[OTIE:CLOSE] ${observer.symbol}:${observer.tradeId} reason=${verdict.reason} ` +
      `profit=${m.current.toFixed(2)}$ peak=${m.peak.toFixed(2)}$ ` +
      `profitR=${m.profitR.toFixed(2)} peakR=${m.peakR.toFixed(2)}`
    );

    try {
      let verification = { status: 'unknown' };
      try {
        verification = await this.broker.getContractStatus(observer.tradeId);
      } catch (err) {
        logger.warn(`[OTIE] Pre-close verification failed for ${observer.tradeId}: ${err.message}`);
      }

      if (verification.status === 'closed') {
        logger.info(`[OTIE] ${observer.tradeId} already closed at Deriv — releasing observer`);
        this._releaseTrade(observer.tradeId);
        return;
      }
      if (verification.status === 'unknown') {
        logger.warn(`[OTIE] ${observer.tradeId} status unknown — deferring close`);
        observer.lastCloseAttempt = 0;
        return;
      }

      await orderService.closeTrade(observer.tradeId, 'deriv_cfd');

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
    } catch (err) {
      logger.error(`[OTIE] Close failed for ${observer.tradeId}: ${err.message}`);
      observer.lastCloseAttempt = 0;
    } finally {
      observer.isClosing = false;
    }
  }

  // ======================================================================
  // Adoption / release
  // ======================================================================
  _adoptTrade(contractId, instrument) {
    if (!contractId) return;
    const cid = String(contractId);
    if (this._observers.has(cid)) return;

    Trade.findOne({ contractId: cid, status: 'OPEN' }).lean().then(trade => {
      if (!trade) {
        logger.warn(`[OTIE] trade.placed for ${cid} but no OPEN Trade doc — will adopt from next tick`);
        return;
      }
      this._adoptTradeSync(trade, 'trade-placed-event');
    }).catch(err => {
      logger.warn(`[OTIE] Adopt ${cid} failed: ${err.message}`);
    });
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

  _releaseTrade(contractId) {
    if (!contractId) return;
    const cid = String(contractId);
    const observer = this._observers.get(cid);
    if (!observer) return;

    const m = observer.metrics();
    logger.info(
      `[OTIE] Released ${cid} — final profit=${m.current.toFixed(2)}$ peak=${m.peak.toFixed(2)}$ ` +
      `ticks=${m.tickCount} duration=${(m.elapsedMs / 1000).toFixed(0)}s source=${observer.source}`
    );
    this._observers.delete(cid);
    this._warnedAdoptFail.delete(cid);

    try {
      this.emit('otieState', {
        tradeId: cid,
        action: 'RELEASED',
        timestamp: new Date().toISOString(),
      });
    } catch (_) {}
  }

  // ======================================================================
  // Restore from DB on startup
  // ======================================================================
  async _restoreFromDB() {
    let openTrades = [];
    try {
      openTrades = await Trade.find({ status: 'OPEN' }).lean();
    } catch (err) {
      logger.error(`[OTIE] DB query failed during restore: ${err.message}`);
      return;
    }

    logger.info(`[OTIE] Startup restore: ${openTrades.length} OPEN Trade doc(s) in DB.`);

    if (openTrades.length === 0) {
      logger.warn(
        '[OTIE] Startup restore: ZERO open Trade docs in DB. ' +
        'This is expected if you have no open contracts. If you DO have open contracts ' +
        'at Deriv, OTIE will adopt them from the first contractUpdate tick — ' +
        'you will see "Adopted <id> from STATE" lines within ~1s of the next tick.'
      );
      return;
    }

    for (const trade of openTrades) {
      const contractId = String(trade.contractId);
      if (!contractId || this._observers.has(contractId)) continue;

      const observer = new ContractObserver(trade, CONFIG, 'trade-doc-restore');

      try {
        const status = await this.broker.getContractStatus(contractId);
        if (status.status === 'closed') {
          logger.info(`[OTIE] ${contractId} is CLOSED at Deriv — will reconcile to CLOSED via broker`);
          continue;
        }
        if (status.status === 'open' && status.profit != null && Number.isFinite(Number(status.profit))) {
          const currentProfit = Number(status.profit);
          observer.peak = { profit: currentProfit, at: Date.now() };
          observer.series.push({ t: Date.now(), profit: currentProfit, price: 0 });
          logger.info(
            `[OTIE] Restored ${contractId} (${observer.symbol} ${observer.side}): ` +
            `currentProfit=${currentProfit.toFixed(2)}$ peak seeded`
          );
        } else {
          logger.info(`[OTIE] Restored ${contractId} — peak will build from first tick`);
        }
      } catch (err) {
        logger.warn(`[OTIE] Restore status check failed for ${contractId} (will still track): ${err.message}`);
      }

      this._observers.set(contractId, observer);
    }

    logger.info(`[OTIE] Restore complete. Tracking ${this._observers.size} contract(s).`);
  }

  // ======================================================================
  // [FILE-1] Periodic resync
  // ======================================================================
  async _resync() {
    let openTrades = [];
    try {
      openTrades = await Trade.find({ status: 'OPEN' }).lean();
    } catch (err) {
      logger.debug(`[OTIE] Resync DB query failed: ${err.message}`);
      return;
    }

    const dbIds = new Set(openTrades.map(t => String(t.contractId)));

    // Adopt any OPEN trades we're not tracking
    for (const trade of openTrades) {
      const cid = String(trade.contractId);
      if (!this._observers.has(cid)) {
        logger.info(`[OTIE] Resync: adopting ${cid} (missed by startup/trade.placed)`);
        this._adoptTradeSync(trade, 'trade-doc-resync');
      }
    }

    // Release observers whose trades are no longer OPEN AND have gone silent
    const now = Date.now();
    for (const [cid, observer] of this._observers) {
      if (dbIds.has(cid)) continue;
      const lastTickAt = observer.series[observer.series.length - 1]?.t || 0;
      const silentMs = now - lastTickAt;
      if (silentMs > 120000) {
        logger.info(
          `[OTIE] Resync: releasing ${cid} — not OPEN in DB and silent for ${(silentMs / 1000).toFixed(0)}s`
        );
        this._releaseTrade(cid);
      }
    }
  }

  // ======================================================================
  // Fallback check
  // ======================================================================
  async _fallbackCheck() {
    if (this._observers.size === 0) return;

    for (const [contractId, observer] of this._observers) {
      const stillOpen = await Trade.findOne({ contractId, status: 'OPEN' }).lean().catch(() => null);
      const timeSinceLastTick = Date.now() - (observer.series[observer.series.length - 1]?.t || 0);

      if (timeSinceLastTick > CONFIG.fallbackTickMs * 3) {
        try {
          const status = await this.broker.getContractStatus(contractId);
          if (status.status === 'closed') {
            logger.info(`[OTIE] Fallback: ${contractId} closed at Deriv — releasing`);
            this._releaseTrade(contractId);
          } else if (status.status === 'open' && status.profit != null) {
            this._onContractUpdate({
              contractId,
              currentProfit: Number(status.profit),
              currentSpot: 0,
              isValidToSell: true,
            });
          }
        } catch (err) {
          logger.debug(`[OTIE] Fallback status query failed for ${contractId}: ${err.message}`);
        }
      }
    }
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

  get observerCount() { return this._observers.size; }

  stop() {
    if (this._fallbackTimer) clearInterval(this._fallbackTimer);
    if (this._resyncTimer) clearInterval(this._resyncTimer);
    this._fallbackTimer = null;
    this._resyncTimer = null;
    logger.info('[OTIE] Stopped.');
  }
}

module.exports = new OpenTradeIntelligenceV6();
