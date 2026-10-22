// core/intelligence/openTradeIntelligenceV5.js
// OTIE v6 – Tick-driven profit trajectory observer for Deriv Multipliers.
//
// [FILE-1] Emits 'otieState' every 5s + on every close trigger so the
//   frontend can render a live trajectory panel.
//   Fixed re-adoption to check `status: 'OPEN'` so a just-closed trade
//   isn't re-added when its final contractUpdate tick arrives.

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
  maxSeriesLength: 120,
};

function normalizeSymbol(symbol) {
  if (!symbol) return '';
  return symbol.replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
}

class ContractObserver {
  constructor(trade, config = CONFIG) {
    this.tradeId = String(trade.contractId);
    this.symbol = normalizeSymbol(trade.instrument);
    this.side = String(trade.side || '').toUpperCase();
    this.stake = Number(trade.stake) || 1;
    this.multiplier = Number(trade.multiplier) || 100;
    this.openPrice = Number(trade.openPrice) || 0;
    this.config = config;

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

class OpenTradeIntelligenceV6 extends EventEmitter {
  constructor(broker = null) {
    super();
    this.broker = broker || getBroker('deriv_cfd');
    this._observers = new Map();
    this._fallbackTimer = null;
    this._restorePromise = null;

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
    } catch (err) {
      logger.warn(`[OTIE] Could not attach contractUpdate listener: ${err.message}`);
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

    logger.info('[OTIE] Initialized (v6 — tick-driven profit trajectory observer).');
    logger.info(
      `[OTIE] Thresholds: maxLoss=${CONFIG.maxLossR}R dd=${(CONFIG.drawdownClosePct * 100).toFixed(0)}% ` +
      `chop=${CONFIG.chopMaxReversals}revs/${CONFIG.chopWindowMs / 1000}s ` +
      `slopeMin=${CONFIG.slopeMinMagnitude} flat=${CONFIG.flatCloseMs / 1000}s ` +
      `stale=${CONFIG.stalePeakMs / 60000}min`
    );
  }

  async _onContractUpdate(state) {
    if (!state || !state.contractId) return;
    const contractId = String(state.contractId);

    let observer = this._observers.get(contractId);
    if (!observer) {
      // [FILE-1] Only re-adopt if the Trade is still OPEN in DB
      try {
        const trade = await Trade.findOne({ contractId, status: 'OPEN' }).lean();
        if (trade) {
          this._adoptTradeSync(trade);
          observer = this._observers.get(contractId);
        }
      } catch (_) {}
      if (!observer) return;
    }

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

      // [FILE-1] Emit state for frontend
      try {
        this.emit('otieState', {
          tradeId: contractId,
          symbol: observer.symbol,
          side: observer.side,
          stake: observer.stake,
          multiplier: observer.multiplier,
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
    if (observer.isClosing) {
      logger.debug(`[OTIE] ${observer.tradeId} close already in-flight — skipping`);
      return;
    }
    if (now - observer.lastCloseAttempt < CONFIG.closeCooldownMs) {
      logger.debug(`[OTIE] ${observer.tradeId} close cooldown — deferring`);
      return;
    }

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

  _adoptTrade(contractId, instrument) {
    if (!contractId) return;
    const cid = String(contractId);
    if (this._observers.has(cid)) return;

    Trade.findOne({ contractId: cid, status: 'OPEN' }).lean().then(trade => {
      if (!trade) {
        logger.warn(`[OTIE] Cannot adopt ${cid} — Trade doc not found or not OPEN`);
        return;
      }
      this._adoptTradeSync(trade);
    }).catch(err => {
      logger.warn(`[OTIE] Adopt ${cid} failed: ${err.message}`);
    });
  }

  _adoptTradeSync(trade) {
    const cid = String(trade.contractId);
    if (this._observers.has(cid)) return;
    const observer = new ContractObserver(trade, CONFIG);
    this._observers.set(cid, observer);
    logger.info(
      `[OTIE] Adopted ${cid} (${observer.symbol} ${observer.side} ` +
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
      `ticks=${m.tickCount} duration=${(m.elapsedMs / 1000).toFixed(0)}s`
    );
    this._observers.delete(cid);

    try {
      this.emit('otieState', {
        tradeId: cid,
        action: 'RELEASED',
        timestamp: new Date().toISOString(),
      });
    } catch (_) {}
  }

  async _restoreFromDB() {
    const openTrades = await Trade.find({ status: 'OPEN' }).lean();
    logger.info(`[OTIE] Restoring ${openTrades.length} open trade(s) from DB.`);

    for (const trade of openTrades) {
      const contractId = String(trade.contractId);
      if (!contractId || this._observers.has(contractId)) continue;

      const observer = new ContractObserver(trade, CONFIG);

      try {
        const status = await this.broker.getContractStatus(contractId);
        if (status.status === 'closed') {
          logger.info(`[OTIE] ${contractId} closed at Deriv — skipping restore`);
          continue;
        }
        if (status.status === 'open' && status.profit != null && Number.isFinite(Number(status.profit))) {
          const currentProfit = Number(status.profit);
          observer.peak = { profit: currentProfit, at: Date.now() };
          observer.series.push({ t: Date.now(), profit: currentProfit, price: 0 });
          logger.info(
            `[OTIE] Restored ${contractId} (${observer.symbol} ${observer.side}): ` +
            `currentProfit=${currentProfit.toFixed(2)}$ peak seeded=${currentProfit.toFixed(2)}$`
          );
        } else {
          logger.info(`[OTIE] Restored ${contractId} — peak will build from first tick`);
        }
      } catch (err) {
        logger.warn(`[OTIE] Restore status check failed for ${contractId}: ${err.message}`);
      }

      this._observers.set(contractId, observer);
    }

    logger.info(`[OTIE] Restore complete. Tracking ${this._observers.size} contract(s).`);
  }

  async _fallbackCheck() {
    if (this._observers.size === 0) return;

    for (const [contractId, observer] of this._observers) {
      const stillOpen = await Trade.findOne({ contractId, status: 'OPEN' }).lean().catch(() => null);
      if (!stillOpen) {
        this._releaseTrade(contractId);
        continue;
      }

      const timeSinceLastTick = Date.now() - (observer.series[observer.series.length - 1]?.t || 0);
      if (timeSinceLastTick > CONFIG.fallbackTickMs * 3) {
        try {
          const status = await this.broker.getContractStatus(contractId);
          if (status.status === 'closed') {
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
      out[cid] = obs.metrics();
    }
    return out;
  }

  get observerCount() { return this._observers.size; }

  stop() {
    if (this._fallbackTimer) {
      clearInterval(this._fallbackTimer);
      this._fallbackTimer = null;
    }
    logger.info('[OTIE] Stopped.');
  }
}

module.exports = new OpenTradeIntelligenceV6();
