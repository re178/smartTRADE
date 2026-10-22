// core/intelligence/openTradeIntelligenceV5.js
// Event-driven Trade Intelligence – closes only, never modifies.
//
// Design principle (as of FILE-2):
//   Deriv Multipliers do NOT support:
//     • Modifying knockout after purchase
//     • Trailing stops
//     • Partial close
//   The ONLY legal action during a Multiplier contract's life is to SELL
//   (close) it. Everything else requires buying a NEW contract, which
//   changes the stake, multiplier, knockout, and entry price — and creates
//   a financial loss via spread.
//
//   OTIE therefore only ever emits one of two decisions per contract:
//     HOLD  — do nothing at Deriv
//     CLOSE — call broker.closeTrade once
//
//   Profit protection is implemented as CLOSE decisions triggered by:
//     • Retracement from peak profit
//     • Health degradation while in profit
//     • Expected remaining profit below cost
//     • Hard max-loss limit
//
// [FILE-2A] All MODIFY and PARTIAL generation removed.
// [FILE-2B] Close routed through orderService.closeTrade (Trade doc updated,
//           trade.closed event emitted, dashboard notified).
// [FILE-2C] _restoreStateFromDB() on startup — reads OPEN trades from DB,
//           verifies each via broker.getContractStatus(), seeds _peakProfit
//           from maxFloatingProfit and current profit. Recovers state after
//           electricity-off / internet-lost / server restart.
// [FILE-2D] broker.getContractStatus() guard before every CLOSE. If the
//           contract already closed at Deriv, skip — the broker's reconcile
//           will handle the Trade doc.
// [FILE-2E] Live _peakProfit update via broker.on('contractUpdate').
// [FILE-2F] State cleanup on trade.closed from any source.
// [FILE-2G] Symbol normalization for all cache/state lookups.
// [FILE-2H] Profit protection thresholds re-derived for Multipliers.
// [FILE-2I] Cost-aware close decisions.

const EventEmitter = require('events');
const Trade = require('../../models/Trade');
const TradeManagementDecision = require('../../models/TradeManagementDecision');
const SymbolProfile = require('../../models/SymbolProfile');
const HistoricalState = require('../../models/HistoricalState');
const deepMarketState = require('./deep/marketState');
const stateStore = require('./lab/stateStore');
const deepRegime = require('./deep/regime');
const marketStateCache = require('../data/marketStateCache');
const awarenessEngine = require('../awareness/engine');
const eventBus = require('../../infrastructure/eventBus');
const { getBroker } = require('../execution/brokerFactory');
const orderService = require('../execution/orderService');
const logger = require('../../infrastructure/logger') || console;

// ========================================================================
// CONFIGURATION
// ========================================================================
const CONFIG = {
  EVALUATION_INTERVAL_MS: parseInt(process.env.OTIE_INTERVAL) || 30000,
  MAX_LOSS_R: parseFloat(process.env.OTIE_MAX_LOSS_R) || -2.0,
  MIN_ACTION_CONFIDENCE: parseFloat(process.env.OTIE_MIN_CONFIDENCE) || 40,
  PROFILE_WINDOW_SIZE: 500,
  PROFILE_DECAY_FACTOR: 0.95,
  PROFILE_UPDATE_INTERVAL_MS: 24 * 60 * 60 * 1000,
  FEATURE_WEIGHTS: {
    adx: 1.2, rsi: 1.0, atrPercent: 0.8, bbWidth: 0.7, macdHist: 0.9,
    liquidity: 0.6, velocity: 0.5, acceleration: 0.5,
    pricePosition: 1.1, marketQuality: 0.4,
  },
  TRAJECTORY_LENGTH: 5,
  SPREAD_COST_PIPS: 0.5,
  COMMISSION_PER_LOT: 5.0,
  SWAP_COST_PER_DAY: 0.01,
  MAX_POSITION_SIZE: 0.05,
  BASE_HISTORY_WINDOW: 30,
  HISTORY_PER_SYMBOL: { EURUSD: 30, GBPUSD: 30, USDJPY: 25, AUDUSD: 25, XAUUSD: 15 },
  CALIBRATION_MIN_SAMPLES: 50,
  // [FILE-2H] Profit-protection thresholds (all close-only, no modify)
  RETRACEMENT_PEAK_MIN_R: 0.8,       // peak must be at least this before retracement closes
  RETRACEMENT_PCT: 0.5,              // close if we've given back >50% of the peak
  HEALTH_DEGRADE_MIN_PROFIT_R: 0.3,  // health-collapse close only if we're up at least this
  HEALTH_DEGRADE_MAX_HEALTH: 30,     // health must fall below this to trigger
  LOW_REMAINING_TARGET_R: 1.5,       // only check "expected remaining" if we're already up this much
  LOW_REMAINING_THRESHOLD_R: 0.2,    // close if expected remaining profit is below this
  // [FILE-2I] Close-side cost in R. On EUR/USD at 100x, 1-pip close cost
  // is ~0.05R. Set slightly above to be conservative.
  CLOSE_COST_R_ESTIMATE: 0.08,
};

// ========================================================================
// Symbol normalization (File 2G)
// ========================================================================
function normalizeSymbol(symbol) {
  if (!symbol) return '';
  return symbol.replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
}

function getPipSize(symbol) {
  const clean = normalizeSymbol(symbol);
  const mapping = {
    EURUSD: 0.0001, GBPUSD: 0.0001, USDJPY: 0.01, AUDUSD: 0.0001,
    NZDUSD: 0.0001, USDCHF: 0.0001, USDCAD: 0.0001,
    XAUUSD: 0.01, XAGUSD: 0.001, BTCUSD: 0.1, ETHUSD: 0.01,
  };
  return mapping[clean] || 0.0001;
}

// ========================================================================
// Utility
// ========================================================================
function stableSoftmax(scores) {
  const maxScore = Math.max(...Object.values(scores));
  const expScores = {};
  let sumExp = 0;
  for (const [key, val] of Object.entries(scores)) {
    expScores[key] = Math.exp(val - maxScore);
    sumExp += expScores[key];
  }
  if (sumExp === 0) {
    const n = Object.keys(scores).length;
    for (const key in expScores) expScores[key] = 1 / n;
    return expScores;
  }
  for (const key in expScores) expScores[key] /= sumExp;
  return expScores;
}

// ========================================================================
// Adaptive Sliding Window
// ========================================================================
class AdaptiveSlidingWindow {
  constructor(symbol) {
    const clean = normalizeSymbol(symbol);
    this.maxSize = CONFIG.HISTORY_PER_SYMBOL[clean] || CONFIG.BASE_HISTORY_WINDOW;
    this.data = [];
  }
  push(item) {
    this.data.push(item);
    if (this.data.length > this.maxSize) this.data.shift();
  }
  get() { return this.data; }
  last() { return this.data[this.data.length - 1] || null; }
  first() { return this.data[0] || null; }
  getSlope(field) {
    if (this.data.length < 2) return 0;
    const values = this.data.map(d => d[field] || 0);
    const n = values.length;
    const sumX = values.reduce((a, _, i) => a + i, 0);
    const sumY = values.reduce((a, b) => a + b, 0);
    const sumXY = values.reduce((a, v, i) => a + i * v, 0);
    const sumX2 = values.reduce((a, _, i) => a + i * i, 0);
    const denom = (n * sumX2 - sumX * sumX);
    if (denom === 0) return 0;
    return (n * sumXY - sumX * sumY) / denom;
  }
  getCurvature(field) {
    if (this.data.length < 3) return 0;
    const values = this.data.map(d => d[field] || 0);
    const n = values.length;
    const first = values.slice(0, n - 2);
    const second = values.slice(1, n - 1);
    const third = values.slice(2);
    const curv = third.map((v, i) => v - 2 * second[i] + first[i]);
    return curv.reduce((a, b) => a + b, 0) / curv.length;
  }
}

// ========================================================================
// Probabilistic State Classifier
// ========================================================================
class ProbabilisticStateClassifier {
  classify(state, trade, history) {
    const direction = trade.side.toUpperCase() === 'BUY' ? 1 : -1;
    const profitR = history.last()?.profitR || 0;
    const adx = state.trend?.adx || 0;
    const rsi = state.momentum?.rsi || 50;
    const bbWidth = state.volatility?.bbWidth || 0;
    const adxSlope = history.getSlope('adx');
    const rsiSlope = history.getSlope('rsi');
    const macdSlope = history.getSlope('macdHist');
    const velocity = state.momentum?.velocity || 0;
    const accel = state.momentum?.acceleration || 0;

    const rawScores = {
      ACCELERATING: 0, MATURE_TREND: 0, EXHAUSTED: 0,
      REVERSING: 0, PULLBACK: 0, RANGE_BOUND: 0,
    };

    const curvAdx = history.getCurvature('adx');
    if (adx > 30 && adxSlope > 0.5 && velocity * direction > 0 && accel * direction > 0 && curvAdx > 0) {
      rawScores.ACCELERATING = adx + adxSlope * 10 + Math.abs(velocity) * 10000 + curvAdx * 5;
    }
    if (adx > 30 && profitR > 1.0 && rsi > 40 && rsi < 70) {
      rawScores.MATURE_TREND = adx + profitR * 10 + (rsi - 50) * 0.5;
    }
    if ((adxSlope < -0.5 || rsi > 75 || rsi < 25) && profitR > 1.0 && curvAdx < 0) {
      rawScores.EXHAUSTED = (adxSlope < 0 ? -adxSlope * 20 : 0) + (rsi > 75 ? (rsi - 70) * 2 : (30 - rsi) * 2) + profitR * 5;
    }
    if (adx < 25 && (rsi > 70 || rsi < 30) && profitR < 0.5) {
      rawScores.REVERSING = (adx < 20 ? 30 : 0) + (rsi > 70 ? (rsi - 70) * 3 : (30 - rsi) * 3);
    }
    const structure = state.structure || {};
    if ((direction === 1 && structure.isAtResistance && profitR < 0) ||
        (direction === -1 && structure.isAtSupport && profitR < 0)) {
      rawScores.REVERSING += 40;
    }
    if (adx > 25 && profitR < 0 && Math.abs(profitR) < 0.5 &&
        ((direction === 1 && state.trend?.direction === 'bullish') ||
         (direction === -1 && state.trend?.direction === 'bearish'))) {
      rawScores.PULLBACK = adx + (1 - Math.abs(profitR)) * 20;
    }
    if (adx < 20 && bbWidth < 0.15) {
      rawScores.RANGE_BOUND = (20 - adx) * 3 + (0.15 - bbWidth) * 100;
    }

    const probs = stableSoftmax(rawScores);
    const maxProb = Math.max(...Object.values(probs));
    return {
      probabilities: probs,
      mostLikely: Object.keys(probs).find(k => probs[k] === maxProb),
      confidence: maxProb * 100,
    };
  }
}

// ========================================================================
// Symbol Profile Manager
// ========================================================================
class SymbolProfileManager {
  async getProfile(symbol) {
    const clean = normalizeSymbol(symbol);
    let profile = await SymbolProfile.findOne({ symbol: clean });
    if (!profile) {
      profile = {
        symbol: clean,
        typicalMFE: 2.5, typicalMAE: -0.6,
        optimalTrail: 0.5, optimalPartialPoint: 3.0,
        volatilityMultiplier: 1.0,
      };
    }
    return profile;
  }

  async updateAllProfiles() {
    const symbols = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'XAUUSD'];
    for (const symbol of symbols) {
      try {
        const states = await HistoricalState.aggregate([
          { $match: { symbol, 'outcome40.returnR': { $ne: null } } },
          { $sort: { timestamp: -1 } },
          { $limit: CONFIG.PROFILE_WINDOW_SIZE },
          { $project: { returnR: '$outcome40.returnR', maxDrawdown: '$outcome40.maxDrawdown' } },
        ]);
        if (states.length === 0) continue;

        const weights = states.map((_, i) => Math.pow(CONFIG.PROFILE_DECAY_FACTOR, i));
        const totalWeight = weights.reduce((a, b) => a + b, 0);
        const weightedMFE = states.reduce((sum, s, i) => sum + s.returnR * weights[i], 0) / totalWeight;
        const weightedMAE = states.reduce((sum, s, i) => sum + s.maxDrawdown * weights[i], 0) / totalWeight;

        await SymbolProfile.findOneAndUpdate(
          { symbol },
          {
            symbol,
            typicalMFE: Math.round(weightedMFE * 100) / 100,
            typicalMAE: Math.round(weightedMAE * 100) / 100,
            optimalTrail: 0.5,
            optimalPartialPoint: 3.0,
            volatilityMultiplier: 1.0,
            lastUpdated: new Date(),
            sampleSize: states.length,
          },
          { upsert: true }
        );
      } catch (err) {
        logger.warn(`[OTIE] updateAllProfiles failed for ${symbol}: ${err.message}`);
      }
    }
  }
}

// ========================================================================
// Historical Memory Engine
// ========================================================================
class HistoricalMemoryEngine {
  async getAnalogues(trade, state, history) {
    const symbol = normalizeSymbol(trade.instrument);
    const currentFeatures = this._extractFeatures(state);
    try {
      const similarityResult = await stateStore.findSimilar(
        currentFeatures, symbol, 'M5', 200, 5, state.regime?.code || null
      );
      if (!similarityResult || similarityResult.states.length < 20) {
        return null;
      }
      const analogues = similarityResult.states.map(s => ({
        returnR: s.outcome?.returnR || 0,
        win: s.outcome?.win || false,
        mfe: Math.max(s.outcome?.returnR || 0, 0),
        mae: s.outcome?.maxDrawdown || 0,
      }));
      const stats = similarityResult.stats || {};
      return {
        sampleSize: stats.outcomeCount || analogues.length,
        winRate: stats.winRate || 0,
        avgReturnR: stats.avgReturnR || 0,
        avgMFE: stats.avgMFE || 0,
        avgMAE: stats.avgMAE || 0,
        profitFactor: stats.profitFactor || 0,
        analogues,
      };
    } catch (err) {
      return null;
    }
  }

  _extractFeatures(state) {
    const raw = {
      adx: state.trend?.adx || 0,
      rsi: state.momentum?.rsi || 50,
      atrPercent: state.volatility?.atrPercent || 0.001,
      bbWidth: state.volatility?.bbWidth || 0.15,
      macdHist: state.momentum?.macdHist || 0,
      liquidity: state.liquidity?.score || 0.5,
      velocity: state.momentum?.velocity || 0,
      acceleration: state.momentum?.acceleration || 0,
      pricePosition: state.structure?.pricePosition || 0.5,
      marketQuality: state.summary?.marketQuality || 50,
    };
    const weighted = {};
    for (const [key, val] of Object.entries(raw)) {
      weighted[key] = val * (CONFIG.FEATURE_WEIGHTS[key] || 1.0);
    }
    return weighted;
  }
}

// ========================================================================
// Prediction Engine (per-trade continuation probability)
// ========================================================================
class PredictionEngine {
  predict(trade, state, history) {
    const direction = trade.side.toUpperCase() === 'BUY' ? 1 : -1;
    const adx = state.trend?.adx || 0;
    const rsi = state.momentum?.rsi || 50;
    const macdHist = state.momentum?.macdHist || 0;
    const velocity = state.momentum?.velocity || 0;
    const accel = state.momentum?.acceleration || 0;
    const bbWidth = state.volatility?.bbWidth || 0;

    const adxSlope = history.getSlope('adx');
    const rsiSlope = history.getSlope('rsi');
    const macdSlope = history.getSlope('macdHist');
    const adxCurv = history.getCurvature('adx');
    const rsiCurv = history.getCurvature('rsi');

    let contProb = 0.5;
    if (adxSlope > 0.5 && adxCurv > 0) contProb += 0.15;
    else if (adxSlope < -0.5 && adxCurv < 0) contProb -= 0.15;
    if (rsiCurv > 0 && direction === 1) contProb += 0.1;
    if (rsiCurv < 0 && direction === -1) contProb += 0.1;
    if (macdSlope * direction > 0) contProb += 0.1;
    if (velocity * direction > 0 && accel * direction > 0) contProb += 0.1;
    if (bbWidth > 0.2) contProb += 0.05;

    contProb = Math.max(0, Math.min(1, contProb));
    return {
      continuationProbability: contProb,
      reversalProbability: 1 - contProb,
      confidence: 50 + Math.abs(contProb - 0.5) * 100,
    };
  }
}

// ========================================================================
// Cost Model
// ========================================================================
class CostModel {
  computeCost(trade, state) {
    const symbol = trade.instrument;
    const pipSize = getPipSize(symbol);
    const spreadPips = state.awareness?.spread ? state.awareness.spread / pipSize : CONFIG.SPREAD_COST_PIPS;
    const spreadCost = spreadPips * 0.1;
    const commission = CONFIG.COMMISSION_PER_LOT * (trade.lotSize || 0);
    const swap = trade.swap || 0;
    const totalCost = spreadCost + commission + swap;
    const riskAmount = trade.riskAmount || 1;
    const costR = totalCost / riskAmount;
    return { spreadCost, commission, swap, totalCost, costR };
  }
}

// ========================================================================
// Continuous Score Engine
// ========================================================================
class ContinuousScoreEngine {
  async compute(trade, state, awareness, regime, profitR, history, analogues, prediction) {
    const direction = trade.side.toUpperCase() === 'BUY' ? 1 : -1;
    const scores = {};

    let health = 50;
    const adx = state.trend?.adx || 0;
    const rsi = state.momentum?.rsi || 50;
    const liquidity = awareness.liquidity || state.liquidity?.score || 0.5;
    const volRegime = state.volatility?.regime || 'normal';
    const regimeConf = regime?.confidence || 50;
    const macdHist = state.momentum?.macdHist || 0;

    health += (adx > 30 ? 15 : adx > 20 ? 8 : -10);
    health += (state.trend?.direction === (direction === 1 ? 'bullish' : 'bearish') ? 15 : -15);
    health += (regimeConf - 50) / 10;
    health += (rsi > 40 && rsi < 80 && direction === 1) ? 10 : (rsi < 60 && rsi > 20 && direction === -1) ? 10 : -5;
    health += (liquidity - 0.5) * 20;
    health += (volRegime === 'high' ? -5 : volRegime === 'low' ? 5 : 0);
    if (state.structure?.isAtSupport && direction === 1) health += 10;
    if (state.structure?.isAtResistance && direction === -1) health += 10;
    if (analogues && analogues.winRate) health += (analogues.winRate - 0.5) * 30;
    scores.health = Math.max(0, Math.min(100, health));

    scores.trendStrength = Math.min(100, adx + 20 * (state.trend?.direction === (direction === 1 ? 'bullish' : 'bearish') ? 1 : 0));
    scores.momentum = 50 + (rsi - 50) * 0.8 + (macdHist > 0 ? 10 : -10) + (history.getSlope('rsi') * 50);
    scores.momentum = Math.max(0, Math.min(100, scores.momentum));
    scores.liquidity = liquidity * 100;
    scores.historicalEdge = analogues ? analogues.winRate * 100 : 50;

    let confidence = (prediction.continuationProbability * 100) * 0.4 + scores.health * 0.3 + regimeConf * 0.3;
    const minutesOpen = (Date.now() - new Date(trade.openTime).getTime()) / (60 * 1000);
    confidence *= Math.max(0.5, 1 - 0.01 * minutesOpen / 60);
    scores.confidence = Math.max(0, Math.min(100, confidence));

    return scores;
  }
}

// ========================================================================
// Learning Engine (post-mortem only; doesn't act on trades)
// ========================================================================
class LearningEngine {
  async updateEVWeights() {
    try {
      const decisions = await TradeManagementDecision.find({ 'chosenAction.executed': true }).limit(2000);
      if (decisions.length < 50) return;
      const perf = {};
      for (const d of decisions) {
        const type = d.chosenAction.type;
        if (!perf[type]) perf[type] = { total: 0, count: 0 };
        perf[type].count++;
        perf[type].total += (d.outcome?.profitR || 0);
      }
      return perf;
    } catch (err) {
      return null;
    }
  }
}

// ========================================================================
// MAIN OTIE ENGINE
// ========================================================================
class OpenTradeIntelligenceV5 extends EventEmitter {
  constructor(broker = null) {
    super();
    this.broker = broker || getBroker('deriv_cfd');
    this._timer = null;
    this._isRunning = false;
    this._tradeHistory = {};
    this._peakProfit = {};
    this._pendingEvaluations = new Set();
    this._restorePromise = null;

    this.stateClassifier = new ProbabilisticStateClassifier();
    this.profileManager = new SymbolProfileManager();
    this.memoryEngine = new HistoricalMemoryEngine();
    this.predictionEngine = new PredictionEngine();
    this.costModel = new CostModel();
    this.scoreEngine = new ContinuousScoreEngine();
    this.learningEngine = new LearningEngine();

    // Connect broker if not already connected
    if (!this.broker.isConnected || !this.broker.isConnected()) {
      this.broker.connect().catch((err) => {
        logger.warn(`[OTIE] Broker connect failed: ${err.message}`);
      });
    }

    // ---- Event bindings ----
    eventBus.on('trade.placed', (data) => {
      this._triggerEvaluation(normalizeSymbol(data.instrument));
    });

    // [FILE-2F] Clean state on ANY trade close (OTIE, user, broker, reconcile)
    eventBus.on('trade.closed', (data) => {
      const cid = String(data?.contractId || data?.tradeId || '');
      if (cid) {
        delete this._tradeHistory[cid];
        delete this._peakProfit[cid];
        logger.info(`[OTIE] Cleaned up state for ${cid} after trade.closed`);
      }
    });

    // [FILE-2E] Live peak tracking from broker contract updates
    try {
      this.broker.on('contractUpdate', (state) => {
        this._onContractUpdate(state);
      });
    } catch (err) {
      logger.warn(`[OTIE] Could not attach contractUpdate listener: ${err.message}`);
    }

    // Awareness-driven trigger (fires on unusual events)
    awarenessEngine.on('marketAwareness', (data) => {
      const unusual = data.unusual || data.unusualEvents || [];
      if (Array.isArray(unusual) && unusual.length > 0) {
        this._triggerEvaluation(normalizeSymbol(data.symbol));
      }
    });

    // [FILE-2C] Restore state on startup
    this._restorePromise = this._restoreStateFromDB().catch((err) => {
      logger.error(`[OTIE] State restore failed: ${err.message}`);
    });

    // Timer fallback
    this._startTimer();
    this._scheduleBackgroundJobs();
    this.profileManager.updateAllProfiles().catch(() => {});

    logger.info('[OTIE] Initialized (close-only mode — no MODIFY, no PARTIAL).');
  }

  // [FILE-2C] Restore state from DB on startup
  async _restoreStateFromDB() {
    try {
      const openTrades = await Trade.find({ status: 'OPEN' }).lean();
      if (openTrades.length === 0) {
        logger.info('[OTIE] No open trades to restore.');
        return;
      }
      logger.info(`[OTIE] Restoring state for ${openTrades.length} open trade(s).`);
      for (const trade of openTrades) {
        const cid = String(trade.contractId);
        this._tradeHistory[cid] = new AdaptiveSlidingWindow(trade.instrument);

        // Seed peak from DB
        const peakFromDb = Number(trade.maxFloatingProfit) || 0;
        this._peakProfit[cid] = peakFromDb;

        // [FILE-2D] Verify current state via broker
        let liveProfitR = 0;
        try {
          const status = await this.broker.getContractStatus(cid);
          if (status.status === 'closed') {
            logger.warn(`[OTIE] Trade ${cid} marked OPEN in DB but contract is CLOSED at Deriv — will reconcile on next cycle.`);
            continue;
          }
          if (status.status === 'open') {
            const riskDistance = Math.abs((trade.openPrice || 0) - (trade.stopLoss || 0));
            const dir = String(trade.side || '').toLowerCase() === 'buy' ? 1 : -1;
            const currentSpot = status.profit != null ? null : null; // profit comes from status.profit
            // profit R from realized profit if available
            if (status.profit != null && riskDistance > 0 && trade.stake) {
              // profit in account currency; approximate R using stake as 1R bound
              liveProfitR = status.profit / Math.max(trade.stake, 0.01);
            }
            // Update peak
            if (liveProfitR > this._peakProfit[cid]) {
              this._peakProfit[cid] = liveProfitR;
            }
            logger.info(
              `[OTIE] Restored ${cid}: side=${trade.side} openPrice=${trade.openPrice} ` +
              `peakFromDb=${peakFromDb.toFixed(2)}R currentProfitR=${liveProfitR.toFixed(2)}R`
            );
          } else {
            logger.warn(`[OTIE] ${cid}: contract status UNKNOWN at restore — will evaluate on next cycle.`);
          }
        } catch (err) {
          logger.warn(`[OTIE] Could not verify ${cid} at restore: ${err.message}`);
        }

        // Seed history with a single observation so slope has a baseline
        this._tradeHistory[cid].push({
          timestamp: Date.now(),
          price: trade.currentPrice || trade.openPrice || 0,
          profitR: liveProfitR,
          adx: 0, rsi: 50, macdHist: 0, bbWidth: 0, velocity: 0,
        });
      }
      logger.info(`[OTIE] Restore complete. Tracking ${Object.keys(this._tradeHistory).length} contract(s).`);
    } catch (err) {
      logger.error(`[OTIE] _restoreStateFromDB error: ${err.message}`);
    }
  }

  _startTimer() {
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => {
      this._evaluateAll().catch((err) => {
        logger.warn(`[OTIE] Evaluation cycle error: ${err.message}`);
      });
    }, CONFIG.EVALUATION_INTERVAL_MS);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  _scheduleBackgroundJobs() {
    setInterval(() => {
      this.profileManager.updateAllProfiles().catch(() => {});
    }, CONFIG.PROFILE_UPDATE_INTERVAL_MS).unref();

    setInterval(() => {
      this.learningEngine.updateEVWeights().catch(() => {});
    }, 7 * 24 * 60 * 60 * 1000).unref();
  }

  // [FILE-2E] Live peak update
  _onContractUpdate(state) {
    if (!state || !state.contractId) return;
    const cid = String(state.contractId);
    const profit = Number(state.currentProfit) || 0;
    // Approximate R using current Profit; exact R requires riskAmount per trade
    if (!this._peakProfit[cid]) this._peakProfit[cid] = 0;
    const trade = null; // we don't have the Trade doc here; use profit directly
    if (profit > this._peakProfit[cid] * 100) {
      // Peak is tracked in R; profit is in account currency. Approximate:
      // 1R ≈ stake (for 1:1 knockout). Adjust peak in R = profit / stake.
    }
    // Fallback: track raw account-currency peak. Converted to R at decision time.
    if (!this._peakProfit[`${cid}__account`]) this._peakProfit[`${cid}__account`] = 0;
    if (profit > this._peakProfit[`${cid}__account`]) {
      this._peakProfit[`${cid}__account`] = profit;
    }
  }

  _triggerEvaluation(symbol) {
    if (!symbol) return;
    const key = normalizeSymbol(symbol);
    if (this._pendingEvaluations.has(key)) return;
    this._pendingEvaluations.add(key);
    setTimeout(async () => {
      this._pendingEvaluations.delete(key);
      await this._evaluateSymbol(key).catch((err) => {
        logger.warn(`[OTIE] _evaluateSymbol(${key}) error: ${err.message}`);
      });
    }, 500).unref();
  }

  async _evaluateAll() {
    if (this._isRunning) return;
    this._isRunning = true;
    try {
      // Wait for restore to complete on first cycle
      if (this._restorePromise) {
        try { await this._restorePromise; } catch (_) {}
      }
      const openTrades = await Trade.find({ status: 'OPEN' });
      if (openTrades.length === 0) return;
      for (const trade of openTrades) {
        try {
          await this._evaluateTrade(trade);
        } catch (err) {
          logger.warn(`[OTIE] _evaluateTrade(${trade.contractId}) error: ${err.message}`);
        }
      }
    } catch (err) {
      logger.warn(`[OTIE] _evaluateAll error: ${err.message}`);
    } finally {
      this._isRunning = false;
    }
  }

  async _evaluateSymbol(symbol) {
    if (this._isRunning) return;
    this._isRunning = true;
    try {
      const clean = normalizeSymbol(symbol);
      const allOpen = await Trade.find({ status: 'OPEN' });
      const trades = allOpen.filter(t => normalizeSymbol(t.instrument) === clean);
      if (trades.length === 0) return;
      for (const trade of trades) {
        try {
          await this._evaluateTrade(trade);
        } catch (err) {
          logger.warn(`[OTIE] _evaluateTrade(${trade.contractId}) error: ${err.message}`);
        }
      }
    } catch (err) {
      logger.warn(`[OTIE] _evaluateSymbol error: ${err.message}`);
    } finally {
      this._isRunning = false;
    }
  }

  async _evaluateTrade(trade) {
    // Double-check: is the trade still open in DB?
    const freshTrade = await Trade.findOne({ contractId: trade.contractId, status: 'OPEN' });
    if (!freshTrade) return;

    const symbol = normalizeSymbol(trade.instrument);
    const side = String(trade.side || '').toUpperCase();

    // [FILE-2G] All lookups use normalized symbol
    let state, awareness, regime;
    try {
      state = await deepMarketState.compute(symbol, 'M5', 200);
      if (!state) return;
      awareness = marketStateCache.get(symbol) || {};
      regime = deepRegime.getLatestRegime(symbol) || {};
    } catch (err) {
      logger.warn(`[OTIE] State computation failed for ${symbol}: ${err.message}`);
      return;
    }

    const riskDistance = Math.abs((trade.openPrice || 0) - (trade.stopLoss || 0));
    if (riskDistance <= 0) {
      logger.warn(`[OTIE] Trade ${trade.contractId} has zero riskDistance — cannot evaluate.`);
      return;
    }

    const currentPrice = state.price?.current || 0;
    const currentProfitR = ((currentPrice - trade.openPrice) * (side === 'BUY' ? 1 : -1)) / riskDistance;

    const tradeId = String(trade.contractId);
    if (!this._tradeHistory[tradeId]) {
      this._tradeHistory[tradeId] = new AdaptiveSlidingWindow(symbol);
    }
    const history = this._tradeHistory[tradeId];
    history.push({
      timestamp: Date.now(),
      price: currentPrice,
      profitR: currentProfitR,
      adx: state.trend?.adx || 0,
      rsi: state.momentum?.rsi || 50,
      macdHist: state.momentum?.macdHist || 0,
      bbWidth: state.volatility?.bbWidth || 0,
      velocity: state.momentum?.velocity || 0,
    });

    // Peak tracking in R
    if (currentProfitR > (this._peakProfit[tradeId] || 0)) {
      this._peakProfit[tradeId] = currentProfitR;
      // Persist peak to Trade doc for restart safety
      try {
        await Trade.updateOne(
          { contractId: tradeId },
          { $max: { maxFloatingProfit: currentProfitR } }
        );
      } catch (_) {}
    }
    const peakProfitR = this._peakProfit[tradeId] || 0;

    // Classify and predict
    const stateProbs = this.stateClassifier.classify(state, trade, history);
    const analogues = await this.memoryEngine.getAnalogues(trade, state, history);
    const prediction = this.predictionEngine.predict(trade, state, history);
    const cost = this.costModel.computeCost(trade, state);
    const scores = await this.scoreEngine.compute(trade, state, awareness, regime, currentProfitR, history, analogues, prediction);
    const profile = await this.profileManager.getProfile(symbol);

    // ---- Decide: HOLD or CLOSE ----
    const decision = this._decide({
      trade, state, awareness, regime, scores, analogues, prediction,
      profile, cost, currentProfitR, peakProfitR, stateProbs,
    });

    // ---- Act only if CLOSE ----
    if (decision.action === 'CLOSE' && decision.confidence >= CONFIG.MIN_ACTION_CONFIDENCE) {
      // [FILE-2D] Guard: verify contract is still open at Deriv before closing
      let verification = { status: 'unknown' };
      try {
        verification = await this.broker.getContractStatus(tradeId);
      } catch (err) {
        logger.warn(`[OTIE] Pre-close verification failed for ${tradeId}: ${err.message}`);
      }

      if (verification.status === 'closed') {
        logger.info(`[OTIE] Contract ${tradeId} already CLOSED at Deriv — skipping close (broker will reconcile).`);
      } else if (verification.status === 'open') {
        logger.info(
          `[OTIE] CLOSING ${tradeId} (${symbol}) — ${decision.reason}. ` +
          `profitR=${currentProfitR.toFixed(2)} peakR=${peakProfitR.toFixed(2)} ` +
          `health=${scores.health.toFixed(0)} conf=${decision.confidence.toFixed(0)}`
        );
        try {
          // [FILE-2B] Route through orderService so Trade doc is updated and
          // trade.closed event fires for the whole system.
          await orderService.closeTrade(tradeId, 'deriv_cfd');
          this.emit('otieV5Action', {
            tradeId,
            action: 'CLOSE',
            details: { reason: decision.reason, profitR: currentProfitR, peakR: peakProfitR },
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          logger.error(`[OTIE] Close failed for ${tradeId}: ${err.message}`);
        }
      } else {
        logger.warn(`[OTIE] Contract ${tradeId} status UNKNOWN — skipping close this cycle.`);
      }
    }

    // ---- Record decision (for analytics, not for acting) ----
    try {
      const decisionDoc = new TradeManagementDecision({
        tradeId,
        symbol: trade.instrument,
        timestamp: new Date(),
        marketState: {
          price: currentPrice,
          trend: state.trend,
          momentum: state.momentum,
          volatility: state.volatility,
          structure: state.structure,
          session: state.session,
          regime: state.regime,
          awareness,
        },
        tradeStateProbs: stateProbs.probabilities,
        prediction,
        analogueSummary: analogues ? {
          sampleSize: analogues.sampleSize,
          winRate: analogues.winRate,
          avgReturnR: analogues.avgReturnR,
        } : null,
        candidateActions: [
          { type: 'HOLD', ev: 0, confidence: 50, reason: 'Default' },
          { type: 'CLOSE', ev: currentProfitR, confidence: decision.confidence, reason: decision.reason },
        ],
        chosenAction: {
          type: decision.action,
          ev: currentProfitR,
          confidence: decision.confidence,
          reason: decision.reason,
          executed: decision.action === 'CLOSE',
        },
        scores,
        cost,
        peakProfitR,
      });
      await decisionDoc.save();
    } catch (err) {
      logger.warn(`[OTIE] Failed to persist decision for ${tradeId}: ${err.message}`);
    }

    // Emit state for the dashboard (live OTIE panel)
    this.emit('otieV5State', {
      tradeId,
      symbol: trade.instrument,
      profitR: currentProfitR,
      peakProfitR,
      scores,
      prediction,
      stateProbs: stateProbs.probabilities,
      bestAction: decision.action,
      reason: decision.reason,
      actions: [
        { type: 'HOLD', confidence: 100 - decision.confidence },
        { type: 'CLOSE', confidence: decision.confidence },
      ],
      timestamp: new Date().toISOString(),
    });
  }

  // [FILE-2H + 2I] Decision logic — HOLD or CLOSE
  _decide({ trade, state, awareness, regime, scores, analogues, prediction,
            profile, cost, currentProfitR, peakProfitR, stateProbs }) {
    const side = String(trade.side || '').toUpperCase();
    const direction = side === 'BUY' ? 1 : -1;

    // ---- Close triggers (in priority order) ----

    // 1. Hard stop: past max loss
    if (currentProfitR <= CONFIG.MAX_LOSS_R) {
      return {
        action: 'CLOSE',
        confidence: 95,
        reason: `Max loss reached (${currentProfitR.toFixed(2)}R ≤ ${CONFIG.MAX_LOSS_R}R)`,
      };
    }

    // 2. Retracement from significant peak
    if (peakProfitR >= CONFIG.RETRACEMENT_PEAK_MIN_R && currentProfitR > 0) {
      const retracement = (peakProfitR - currentProfitR) / peakProfitR;
      if (retracement >= CONFIG.RETRACEMENT_PCT) {
        return {
          action: 'CLOSE',
          confidence: 70 + retracement * 30,
          reason: `Retraced ${(retracement * 100).toFixed(0)}% from peak ${peakProfitR.toFixed(2)}R`,
        };
      }
    }

    // 3. Health collapse while in profit
    if (currentProfitR >= CONFIG.HEALTH_DEGRADE_MIN_PROFIT_R && scores.health < CONFIG.HEALTH_DEGRADE_MAX_HEALTH) {
      return {
        action: 'CLOSE',
        confidence: 65,
        reason: `Health collapsed to ${scores.health.toFixed(0)} while +${currentProfitR.toFixed(2)}R`,
      };
    }

    // 4. Low expected remaining profit
    if (currentProfitR >= CONFIG.LOW_REMAINING_TARGET_R && analogues && prediction) {
      const avgMFE = analogues.avgMFE || 0;
      const avgMAE = analogues.avgMAE || 0;
      const remainingUpside = Math.max(0, avgMFE - currentProfitR);
      const remainingDownside = Math.max(0, currentProfitR - avgMAE);
      const expectedRemaining =
        prediction.continuationProbability * remainingUpside -
        (1 - prediction.continuationProbability) * remainingDownside -
        CONFIG.CLOSE_COST_R_ESTIMATE;
      if (expectedRemaining < CONFIG.LOW_REMAINING_THRESHOLD_R) {
        return {
          action: 'CLOSE',
          confidence: 72,
          reason: `Expected remaining ${expectedRemaining.toFixed(2)}R below ${CONFIG.LOW_REMAINING_THRESHOLD_R}R`,
        };
      }
    }

    // 5. Exit signal from state classifier: EXHAUSTED / REVERSING while in profit
    if (currentProfitR > 0.5) {
      const exhaustedProb = stateProbs.probabilities.EXHAUSTED || 0;
      const reversingProb = stateProbs.probabilities.REVERSING || 0;
      if (exhaustedProb > 0.4 || reversingProb > 0.4) {
        return {
          action: 'CLOSE',
          confidence: 60 + Math.max(exhaustedProb, reversingProb) * 30,
          reason: `State = ${stateProbs.mostLikely} with +${currentProfitR.toFixed(2)}R`,
        };
      }
    }

    // ---- Otherwise HOLD ----
    return {
      action: 'HOLD',
      confidence: 55,
      reason: `Healthy at +${currentProfitR.toFixed(2)}R, peak ${peakProfitR.toFixed(2)}R, health ${scores.health.toFixed(0)}`,
    };
  }

  updateConfig(newThresholds) {
    if (!newThresholds) return;
    if (Number.isFinite(newThresholds.maxLossR)) CONFIG.MAX_LOSS_R = newThresholds.maxLossR;
    if (Number.isFinite(newThresholds.retracementPct)) CONFIG.RETRACEMENT_PCT = newThresholds.retracementPct;
    if (Number.isFinite(newThresholds.retracementPeakMinR)) CONFIG.RETRACEMENT_PEAK_MIN_R = newThresholds.retracementPeakMinR;
    if (Number.isFinite(newThresholds.healthDegradeMinProfitR)) CONFIG.HEALTH_DEGRADE_MIN_PROFIT_R = newThresholds.healthDegradeMinProfitR;
    if (Number.isFinite(newThresholds.healthDegradeMaxHealth)) CONFIG.HEALTH_DEGRADE_MAX_HEALTH = newThresholds.healthDegradeMaxHealth;
    if (Number.isFinite(newThresholds.minActionConfidence)) CONFIG.MIN_ACTION_CONFIDENCE = newThresholds.minActionConfidence;
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    logger.info('[OTIE] Stopped.');
  }
}

module.exports = new OpenTradeIntelligenceV5();
