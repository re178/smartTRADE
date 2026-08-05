// core/intelligence/openTradeIntelligenceV5.js
const EventEmitter = require('events');
const axios = require('axios');
const Trade = require('../../models/Trade');
const TradeManagementDecision = require('../../models/TradeManagementDecision');
const SymbolProfile = require('../../models/SymbolProfile');
const HistoricalState = require('../../models/HistoricalState');
const deepMarketState = require('./deep/marketState');
const stateStore = require('./lab/stateStore');
const deepRegime = require('./deep/regime');
const marketStateCache = require('../data/marketStateCache');
const awarenessEngine = require('../awareness/engine');
const MT5Broker = require('../../execution/mt5Broker');
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
  FEATURE_WEIGHTS: { adx: 1.2, rsi: 1.0, atrPercent: 0.8, bbWidth: 0.7, macdHist: 0.9, liquidity: 0.6, velocity: 0.5, acceleration: 0.5, pricePosition: 1.1, marketQuality: 0.4 },
  TRAJECTORY_LENGTH: 5,
  SPREAD_COST_PIPS: 0.5,
  COMMISSION_PER_LOT: 5.0,
  SWAP_COST_PER_DAY: 0.01,
  SIMULATION_BARS: 5,
  MAX_DRAWDOWN_R: -1.5,
  MAX_POSITION_SIZE: 0.05,
  BASE_HISTORY_WINDOW: 30,
  HISTORY_PER_SYMBOL: { EURUSD: 30, GBPUSD: 30, USDJPY: 25, AUDUSD: 25, XAUUSD: 15 },
  CALIBRATION_MIN_SAMPLES: 50,
  BREAKEVEN_PROFIT_R: 0.5,
  PROGRESSIVE_SL_STEPS: [
    { profitR: 0.5, slR: -0.2 },
    { profitR: 1.0, slR: 0.0 },
    { profitR: 2.0, slR: 0.5 },
    { profitR: 3.0, slR: 1.0 },
    { profitR: 5.0, slR: 2.0 },
    { profitR: 8.0, slR: 4.0 },
  ],
  RETRACEMENT_THRESHOLD: 0.2,
  PARTIAL_FRACTION_MIN: 0.1,
  PARTIAL_FRACTION_MAX: 0.5,
  EXPECTED_REMAINING_THRESHOLD: 0.5,
};

// ========================================================================
// Utility: get pip size from symbol
// ========================================================================
function getPipSize(symbol) {
  const mapping = {
    EURUSD: 0.0001,
    GBPUSD: 0.0001,
    USDJPY: 0.01,
    AUDUSD: 0.0001,
    NZDUSD: 0.0001,
    USDCHF: 0.0001,
    USDCAD: 0.0001,
    XAUUSD: 0.01,
    XAGUSD: 0.001,
    BTCUSD: 0.1,
    ETHUSD: 0.01,
  };
  const clean = symbol.replace(/[/\-_]/g, '').toUpperCase();
  return mapping[clean] || 0.0001;
}

// ========================================================================
// Utility: stable softmax
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
// 1. SLIDING WINDOW (FIXED)
// ========================================================================
class AdaptiveSlidingWindow {
  constructor(symbol) {
    this.maxSize = CONFIG.HISTORY_PER_SYMBOL[symbol] || CONFIG.BASE_HISTORY_WINDOW;
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
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    return slope;
  }
  getCurvature(field) {
    if (this.data.length < 3) return 0;
    const values = this.data.map(d => d[field] || 0);
    const n = values.length;
    const first = values.slice(0, n-2);
    const second = values.slice(1, n-1);
    const third = values.slice(2);
    const curv = third.map((v, i) => v - 2*second[i] + first[i]);
    return curv.reduce((a, b) => a + b, 0) / curv.length;
  }
}

// ========================================================================
// 2. PROBABILISTIC STATE CLASSIFIER (stable softmax)
// ========================================================================
class ProbabilisticStateClassifier {
  classify(state, trade, history) {
    const direction = trade.side.toUpperCase() === 'BUY' ? 1 : -1;
    const profitR = history.last()?.profitR || 0;
    const adx = state.trend.adx || 0;
    const rsi = state.momentum.rsi || 50;
    const bbWidth = state.volatility.bbWidth || 0;
    const adxSlope = history.getSlope('adx');
    const rsiSlope = history.getSlope('rsi');
    const macdSlope = history.getSlope('macdHist');
    const velocity = state.momentum.velocity || 0;
    const accel = state.momentum.acceleration || 0;

    let rawScores = {
      ACCELERATING: 0,
      MATURE_TREND: 0,
      EXHAUSTED: 0,
      REVERSING: 0,
      PULLBACK: 0,
      RANGE_BOUND: 0,
    };

    const curvAdx = history.getCurvature('adx');
    const curvRsi = history.getCurvature('rsi');

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

    if (adx > 25 && profitR < 0 && Math.abs(profitR) < 0.5 && ((direction === 1 && state.trend.direction === 'bullish') ||
                                                              (direction === -1 && state.trend.direction === 'bearish'))) {
      rawScores.PULLBACK = adx + (1 - Math.abs(profitR)) * 20;
    }

    if (adx < 20 && bbWidth < 0.15) {
      rawScores.RANGE_BOUND = (20 - adx) * 3 + (0.15 - bbWidth) * 100;
    }

    const probs = stableSoftmax(rawScores);
    const maxProb = Math.max(...Object.values(probs));
    return { probabilities: probs, mostLikely: Object.keys(probs).find(k => probs[k] === maxProb), confidence: maxProb * 100 };
  }
}

// ========================================================================
// 3. SYMBOL PROFILE MANAGER
// ========================================================================
class SymbolProfileManager {
  async getProfile(symbol) {
    let profile = await SymbolProfile.findOne({ symbol });
    if (!profile) {
      profile = { symbol, typicalMFE: 2.5, typicalMAE: -0.6, optimalTrail: 0.5, optimalPartialPoint: 3.0, volatilityMultiplier: 1.0 };
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
          { $project: { returnR: '$outcome40.returnR', maxDrawdown: '$outcome40.maxDrawdown' } }
        ]);

        if (states.length === 0) continue;

        const weights = states.map((_, i) => Math.pow(CONFIG.PROFILE_DECAY_FACTOR, i));
        const totalWeight = weights.reduce((a, b) => a + b, 0);
        const weightedMFE = states.reduce((sum, s, i) => sum + s.returnR * weights[i], 0) / totalWeight;
        const weightedMAE = states.reduce((sum, s, i) => sum + s.maxDrawdown * weights[i], 0) / totalWeight;

        const trades = await Trade.aggregate([
          { $match: { instrument: symbol, status: 'CLOSED', realizedProfit: { $gt: 0 } } },
          { $sort: { closeTime: -1 } },
          { $limit: CONFIG.PROFILE_WINDOW_SIZE },
          { $project: { profitR: { $divide: ['$realizedProfit', '$riskAmount'] }, maxProfitR: { $divide: ['$maxFloatingProfit', '$riskAmount'] }, captureRatio: { $divide: ['$realizedProfit', '$maxFloatingProfit'] } } }
        ]);

        let optimalTrail = 0.5, optimalPartial = 3.0;
        if (trades.length > 10) {
          const avgCaptureRatio = trades.reduce((sum, t) => sum + t.captureRatio, 0) / trades.length;
          optimalTrail = Math.max(0.2, 1 - avgCaptureRatio);
          const avgMaxProfitR = trades.reduce((sum, t) => sum + t.maxProfitR, 0) / trades.length;
          optimalPartial = Math.max(1.0, avgMaxProfitR * 0.6);
        }

        await SymbolProfile.findOneAndUpdate({ symbol }, {
          symbol,
          typicalMFE: Math.round(weightedMFE * 100) / 100,
          typicalMAE: Math.round(weightedMAE * 100) / 100,
          optimalTrail: Math.round(optimalTrail * 100) / 100,
          optimalPartialPoint: Math.round(optimalPartial * 100) / 100,
          volatilityMultiplier: 1.0,
          lastUpdated: new Date(),
          sampleSize: states.length,
        }, { upsert: true });
      } catch (err) {
        logger.warn(`[Profiles] Failed to update ${symbol}:`, err.message);
      }
    }
  }
}

// ========================================================================
// 4. HISTORICAL MEMORY ENGINE (uses risk-based R)
// ========================================================================
class HistoricalMemoryEngine {
  async getAnalogues(trade, state, history) {
    const symbol = trade.instrument;
    const currentFeatures = this._extractFeatures(state);
    const trajectory = history.get().slice(-CONFIG.TRAJECTORY_LENGTH);
    const trajFeatures = {
      adxSlope: history.getSlope('adx'),
      rsiSlope: history.getSlope('rsi'),
      macdSlope: history.getSlope('macdHist'),
      adxCurvature: history.getCurvature('adx'),
      rsiCurvature: history.getCurvature('rsi'),
    };
    const fullFeatureVector = { ...currentFeatures, ...trajFeatures };

    try {
      const riskDistance = Math.abs(trade.openPrice - trade.stopLoss);
      const currentProfitR = (trade.currentPrice - trade.openPrice) * (trade.side.toUpperCase() === 'BUY' ? 1 : -1) / riskDistance;

      const similarityResult = await stateStore.findSimilar(
        currentFeatures,
        symbol,
        'M5',
        200,
        5,
        state.regime?.code || null
      );

      if (!similarityResult || similarityResult.states.length < 20) {
        return null;
      }

      const analogues = similarityResult.states.map(s => ({
        returnR: s.outcome?.returnR || 0,
        maxDrawdown: s.outcome?.maxDrawdown || 0,
        win: s.outcome?.win || false,
        mfe: Math.max(s.outcome?.returnR || 0, 0),
        mae: s.outcome?.maxDrawdown || 0,
      }));

      const stats = similarityResult.stats;
      const continuationCount = analogues.filter(a => a.returnR > currentProfitR + 1).length;
      const survivalProb = analogues.length > 0 ? continuationCount / analogues.length : 0.5;

      return {
        sampleSize: stats.count || analogues.length,
        winRate: stats.winRate || 0,
        avgReturnR: stats.avgReturnR || 0,
        avgMFE: stats.avgMFE || 0,
        avgMAE: stats.avgMAE || 0,
        medianReturnR: stats.medianReturnR || 0,
        profitFactor: stats.profitFactor || 0,
        analogues,
        survivalProb,
        trajectoryMatch: 0.8,
      };
    } catch (err) {
      logger.warn('[Memory] Analogues failed:', err.message);
      return null;
    }
  }

  _extractFeatures(state) {
    const raw = {
      adx: state.trend.adx || 0,
      rsi: state.momentum.rsi || 50,
      atrPercent: state.volatility.atrPercent || 0.001,
      bbWidth: state.volatility.bbWidth || 0.15,
      macdHist: state.momentum.macdHist || 0,
      liquidity: state.liquidity?.score || 0.5,
      velocity: state.momentum.velocity || 0,
      acceleration: state.momentum.acceleration || 0,
      pricePosition: state.structure.pricePosition || 0.5,
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
// 5. PREDICTION ENGINE
// ========================================================================
class PredictionEngine {
  predict(trade, state, history) {
    const direction = trade.side.toUpperCase() === 'BUY' ? 1 : -1;
    const adx = state.trend.adx || 0;
    const rsi = state.momentum.rsi || 50;
    const macdHist = state.momentum.macdHist || 0;
    const velocity = state.momentum.velocity || 0;
    const accel = state.momentum.acceleration || 0;
    const bbWidth = state.volatility.bbWidth || 0;

    const adxSlope = history.getSlope('adx');
    const rsiSlope = history.getSlope('rsi');
    const macdSlope = history.getSlope('macdHist');
    const adxCurv = history.getCurvature('adx');
    const rsiCurv = history.getCurvature('rsi');

    let contProb = 0.5;
    if (adxSlope > 0.5 && adxCurv > 0) contProb += 0.2;
    else if (adxSlope < -0.5 && adxCurv < 0) contProb -= 0.2;
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
      expectedDirection: contProb > 0.5 ? 1 : -1,
    };
  }
}

// ========================================================================
// 6. COST MODEL (costR = totalCost / riskAmount)
// ========================================================================
class CostModel {
  computeCost(trade, state) {
    const symbol = trade.instrument;
    const pipSize = getPipSize(symbol);
    const spreadPips = state.awareness?.spread ? state.awareness.spread / pipSize : CONFIG.SPREAD_COST_PIPS;
    const spreadCost = spreadPips * 0.1;
    const commission = CONFIG.COMMISSION_PER_LOT * trade.lotSize;
    const swap = trade.swap || 0;
    const totalCost = spreadCost + commission + swap;
    const riskAmount = trade.riskAmount || 1;
    const costR = totalCost / riskAmount;
    return { spreadCost, commission, swap, totalCost, costR };
  }
}

// ========================================================================
// 7. CONTINUOUS TRADE SCORE ENGINE
// ========================================================================
class ContinuousScoreEngine {
  async compute(trade, state, awareness, regime, profitR, history, analogues, prediction, weights) {
    const direction = trade.side.toUpperCase() === 'BUY' ? 1 : -1;
    const scores = {};

    let health = 50;
    const adx = state.trend.adx || 0;
    const rsi = state.momentum.rsi || 50;
    const liquidity = awareness.liquidity || state.liquidity?.score || 0.5;
    const volRegime = state.volatility?.regime || 'normal';
    const regimeConf = regime.confidence || 50;
    const macdHist = state.momentum.macdHist || 0;

    health += (adx > 30 ? 15 : adx > 20 ? 8 : -10);
    health += (state.trend.direction === (direction === 1 ? 'bullish' : 'bearish') ? 15 : -15);
    health += (regimeConf - 50) / 10;
    health += (rsi > 40 && rsi < 80 && direction === 1) ? 10 : (rsi < 60 && rsi > 20 && direction === -1) ? 10 : -5;
    health += (liquidity - 0.5) * 20;
    health += (volRegime === 'high' ? -5 : volRegime === 'low' ? 5 : 0);
    if (state.structure?.isAtSupport && direction === 1) health += 10;
    if (state.structure?.isAtResistance && direction === -1) health += 10;
    if (analogues && analogues.winRate) health += (analogues.winRate - 0.5) * 30;
    scores.health = Math.max(0, Math.min(100, health));

    scores.trendStrength = Math.min(100, adx + 20 * (state.trend.direction === (direction === 1 ? 'bullish' : 'bearish') ? 1 : 0));
    scores.momentum = 50 + (rsi - 50) * 0.8 + (macdHist > 0 ? 10 : -10) + (history.getSlope('rsi') * 50);
    scores.momentum = Math.max(0, Math.min(100, scores.momentum));
    scores.liquidity = liquidity * 100;
    scores.historicalEdge = analogues ? analogues.winRate * 100 : 50;

    const profile = await SymbolProfile.findOne({ symbol: trade.instrument });
    const typicalMFE = profile?.typicalMFE || 2.5;
    const capturedPct = Math.min(1, profitR / typicalMFE);
    scores.opportunity = 100 * (1 - capturedPct);
    scores.opportunity = Math.max(0, Math.min(100, scores.opportunity));

    const risk = 100 - (scores.health * 0.7 + (1 - Math.min(1, Math.abs(profitR) / 5)) * 30);
    scores.risk = Math.max(0, Math.min(100, risk));

    let confidence = (prediction.continuationProbability * 100) * 0.4 + scores.health * 0.3 + regimeConf * 0.3;
    const minutesOpen = (Date.now() - new Date(trade.openTime).getTime()) / (60 * 1000);
    confidence *= Math.max(0.5, 1 - 0.01 * minutesOpen / 60);
    scores.confidence = Math.max(0, Math.min(100, confidence));

    scores.holdProb = (scores.opportunity * 0.5 + scores.health * 0.5);
    scores.exitProb = 100 - scores.holdProb;
    const scaleProb = (adx > 40 && history.getSlope('adx') > 0.5 && profitR > 0.5) ? Math.min(50, adx) : 0;
    scores.scaleProb = Math.min(100, scaleProb);

    const tradeAgeMinutes = (Date.now() - new Date(trade.openTime).getTime()) / (60 * 1000);
    scores.tradeAge = Math.min(100, tradeAgeMinutes / 10);
    const now = new Date();
    const dayOfWeek = now.getUTCDay();
    const hour = now.getUTCHours();
    const sessionEndHour = { London: 15, NewYork: 20, Asia: 8, Sydney: 6 };
    const sessionName = state.session?.name || 'Other';
    const endHour = sessionEndHour[sessionName] || 24;
    const sessionRemaining = Math.max(0, (endHour - hour) / 24 * 100);
    scores.sessionRemaining = Math.min(100, sessionRemaining);
    scores.isFriday = dayOfWeek === 5 ? 100 : 0;

    return scores;
  }
}

// ========================================================================
// 8. FORWARD SIMULATION (includes current profit)
// ========================================================================
class ForwardSimulation {
  async simulate(trade, state, actions, analogues) {
    const results = [];
    const direction = trade.side.toUpperCase() === 'BUY' ? 1 : -1;
    const riskDistance = Math.abs(trade.openPrice - trade.stopLoss);
    const currentProfitR = (state.price.current - trade.openPrice) * direction / riskDistance;
    const atr = state.volatility.atr || 0.001;

    for (const action of actions) {
      let simulatedProfit = currentProfitR;
      let confidence = action.confidence || 50;
      switch (action.type) {
        case 'HOLD':
          const contProb = action.contProb || 0.5;
          const expectedGain = contProb * (analogues?.avgMFE || 1.0);
          const expectedLoss = (1 - contProb) * (analogues?.avgMAE || -0.5);
          const futureEV = expectedGain + expectedLoss;
          simulatedProfit += futureEV;
          confidence = 50 + Math.abs(contProb - 0.5) * 100;
          break;
        case 'MODIFY':
          if (action.stopLoss) {
            const newSL = action.stopLoss;
            const slDistance = Math.abs(newSL - state.price.current) / riskDistance;
            const hitSLProb = 0.3;
            const lossIfHit = -slDistance * direction;
            const futureEV = (1 - hitSLProb) * (analogues?.avgMFE || 0) + hitSLProb * lossIfHit;
            simulatedProfit += futureEV;
          }
          break;
        case 'PARTIAL':
          const fraction = action.volume / trade.lotSize;
          const remainingFraction = 1 - fraction;
          const futureRemainingEV = remainingFraction * (prediction?.continuationProbability || 0.5) * (analogues?.avgMFE || 0)
                                  + remainingFraction * (1 - (prediction?.continuationProbability || 0.5)) * (analogues?.avgMAE || -0.5);
          simulatedProfit = fraction * currentProfitR + futureRemainingEV;
          break;
        case 'CLOSE':
          simulatedProfit = currentProfitR;
          break;
        default:
          break;
      }
      results.push({ ...action, simulatedProfit, confidence });
    }
    results.sort((a, b) => b.simulatedProfit - a.simulatedProfit);
    return results;
  }
}

// ========================================================================
// 9. ACTION COMPETITION (fixed partial EV, trailing stop, retracement)
// ========================================================================
class ActionCompetition {
  constructor() {
    this.tradeStates = {};
    this.peakProfit = {};
  }

  generateActions(trade, state, scores, analogues, prediction, profile, cost, peakProfitR) {
    const direction = trade.side.toUpperCase() === 'BUY' ? 1 : -1;
    const atr = state.volatility.atr || 0.001;
    const currentPrice = state.price.current;
    const entryPrice = trade.openPrice;
    const riskDistance = Math.abs(entryPrice - trade.stopLoss);
    const profitR = (currentPrice - entryPrice) * direction / riskDistance;
    const actions = [];
    const tradeId = trade.contractId;
    const currentStage = this.tradeStates[tradeId] || 'INITIAL';

    // --- HOLD ---
    let holdEV = prediction.continuationProbability * (analogues?.avgMFE || 1.0) + (1 - prediction.continuationProbability) * (analogues?.avgMAE || -0.5);
    holdEV -= cost.costR;
    actions.push({
      type: 'HOLD',
      ev: holdEV,
      confidence: scores.confidence,
      reason: 'Hold based on current evidence.',
      contProb: prediction.continuationProbability,
    });

    // --- PROGRESSIVE SL ---
    let bestSLR = null;
    let bestProfitR = 0;
    for (const step of CONFIG.PROGRESSIVE_SL_STEPS) {
      if (profitR >= step.profitR && step.profitR > bestProfitR) {
        bestSLR = step.slR;
        bestProfitR = step.profitR;
      }
    }
    if (bestSLR !== null && currentStage !== 'PROTECTING') {
      const newSL = direction === 1 ? entryPrice + bestSLR * riskDistance : entryPrice - bestSLR * riskDistance;
      if ((direction === 1 && newSL > trade.stopLoss) || (direction === -1 && newSL < trade.stopLoss)) {
        const ev = holdEV * 1.1;
        actions.push({
          type: 'MODIFY',
          stopLoss: newSL,
          ev: ev,
          confidence: 70,
          reason: `Progressive SL lock at ${bestSLR}R profit`,
        });
      }
    }

    // --- TRAILING STOP (using absolute MAE) ---
    if (profitR > 0.5 && scores.health > 50 && currentStage !== 'PROTECTING') {
      const maeAbs = Math.abs(profile.typicalMAE || 0.6);
      const trailDistance = Math.min(
        (1 - scores.health/100) * atr,
        maeAbs * riskDistance,
        state.volatility.atr * 1.5
      );
      const newSL = direction === 1 ? currentPrice - trailDistance : currentPrice + trailDistance;
      if ((direction === 1 && newSL > trade.stopLoss) || (direction === -1 && newSL < trade.stopLoss)) {
        const ev = holdEV * 0.95;
        actions.push({
          type: 'MODIFY',
          stopLoss: newSL,
          ev: ev,
          confidence: 60 + scores.health * 0.3,
          reason: 'Trailing stop (enhanced)',
        });
      }
    }

    // --- PARTIAL CLOSE (dynamic fraction) ---
    if (profitR > 1.5 && scores.opportunity < 60 && currentStage !== 'PROTECTING') {
      const ratio = Math.min(profitR / profile.typicalMFE, 1);
      const fraction = CONFIG.PARTIAL_FRACTION_MIN + (CONFIG.PARTIAL_FRACTION_MAX - CONFIG.PARTIAL_FRACTION_MIN) * ratio;
      const fractionRounded = Math.round(fraction * 100) / 100;
      const contProb = prediction.continuationProbability;
      const futureEV = contProb * (analogues?.avgMFE || 0) + (1 - contProb) * (analogues?.avgMAE || -0.5);
      const ev = fractionRounded * profitR + (1 - fractionRounded) * futureEV;
      actions.push({
        type: 'PARTIAL',
        volume: trade.lotSize * fractionRounded,
        ev: ev,
        confidence: 50 + (100 - scores.opportunity) * 0.5,
        reason: `Partial close (${fractionRounded*100}%) based on profit potential`,
      });
    }

    // --- RETRACEMENT PROTECTION (with division guard) ---
    if (peakProfitR && peakProfitR > 0 && peakProfitR > profitR) {
      const retracement = (peakProfitR - profitR) / peakProfitR;
      if (retracement > CONFIG.RETRACEMENT_THRESHOLD && profitR > 0) {
        const fraction = Math.min(0.3, 0.1 + retracement * 0.5);
        const futureEV = prediction.continuationProbability * (analogues?.avgMFE || 0) + (1 - prediction.continuationProbability) * (analogues?.avgMAE || -0.5);
        const ev = fraction * profitR + (1 - fraction) * futureEV;
        actions.push({
          type: 'PARTIAL',
          volume: trade.lotSize * fraction,
          ev: ev,
          confidence: 60 + retracement * 30,
          reason: `Retracement protection (${(retracement*100).toFixed(0)}% from peak)`,
        });
        const newTP = direction === 1 ? currentPrice + atr * 1.5 : currentPrice - atr * 1.5;
        if ((direction === 1 && newTP < trade.takeProfit) || (direction === -1 && newTP > trade.takeProfit)) {
          actions.push({
            type: 'MODIFY',
            takeProfit: newTP,
            ev: profitR * 0.9,
            confidence: 50 + retracement * 30,
            reason: 'Tighten TP after retracement',
          });
        }
      }
    }

    // --- EXPECTED REMAINING VALUE ---
    if (analogues && prediction) {
      const avgMFE = analogues.avgMFE || 0;
      const avgMAE = analogues.avgMAE || 0;
      const remainingUpside = Math.max(0, avgMFE - profitR);
      const remainingDownside = Math.max(0, profitR - avgMAE);
      const probContinue = prediction.continuationProbability;
      const expectedRemaining = probContinue * remainingUpside - (1 - probContinue) * remainingDownside;
      if (expectedRemaining < CONFIG.EXPECTED_REMAINING_THRESHOLD && profitR > 0.5) {
        actions.push({
          type: 'CLOSE',
          ev: profitR,
          confidence: 80,
          reason: `Expected remaining ${expectedRemaining.toFixed(2)}R below threshold`,
        });
      }
    }

    // --- CLOSE (loss or health) ---
    if (profitR < CONFIG.MAX_LOSS_R || (scores.health < 30 && profitR < 0.5)) {
      actions.push({
        type: 'CLOSE',
        ev: profitR,
        confidence: 90,
        reason: 'Exit due to adverse conditions or max loss.',
      });
    }

    // --- EXTEND TP ---
    if (scores.opportunity > 70 && scores.trendStrength > 70 && currentStage !== 'PROTECTING' && currentStage !== 'EXTENDED') {
      const newTP = direction === 1 ? currentPrice + atr * 4 : currentPrice - atr * 4;
      const ev = profitR * 1.2;
      actions.push({
        type: 'MODIFY',
        takeProfit: newTP,
        ev: ev,
        confidence: 60 + scores.opportunity * 0.3,
        reason: 'Extend TP as market shows strong potential.',
      });
    }

    // --- TIGHTEN TP (if health weak) ---
    if (scores.health < 50 && profitR > 0.5) {
      const newTP = direction === 1 ? currentPrice + atr * 1.5 : currentPrice - atr * 1.5;
      const ev = profitR * 0.9;
      actions.push({
        type: 'MODIFY',
        takeProfit: newTP,
        ev: ev,
        confidence: 50 + (100 - scores.health) * 0.4,
        reason: 'Tighten TP to protect profits as health declines.',
      });
    }

    // --- PROFIT PROTECTION (>3R) ---
    if (profitR > 3.0 && currentStage !== 'PROTECTING') {
      const minSL = direction === 1 ? entryPrice + riskDistance : entryPrice - riskDistance;
      if ((direction === 1 && trade.stopLoss < minSL) || (direction === -1 && trade.stopLoss > minSL)) {
        actions.push({
          type: 'MODIFY',
          stopLoss: minSL,
          ev: holdEV * 0.9,
          confidence: 80,
          reason: 'Lock in 1R profit (minimum)',
        });
      }
      if (!trade._partialClosed) {
        const fraction = 0.25;
        const futureEV = prediction.continuationProbability * (analogues?.avgMFE || 0) + (1 - prediction.continuationProbability) * (analogues?.avgMAE || -0.5);
        const ev = fraction * profitR + (1 - fraction) * futureEV;
        actions.push({
          type: 'PARTIAL',
          volume: trade.lotSize * fraction,
          ev: ev,
          confidence: 70,
          reason: 'Partial close to lock in profit.',
        });
      }
    }

    actions.sort((a, b) => b.ev - a.ev);

    if (currentStage === 'PROTECTING') {
      return actions.filter(a => !['OPEN', 'MODIFY'].includes(a.type) || a.type === 'MODIFY' && (a.stopLoss || a.takeProfit));
    }
    if (currentStage === 'EXTENDED') {
      return actions.filter(a => !(a.type === 'MODIFY' && a.takeProfit));
    }
    return actions;
  }

  updateTradeStage(tradeId, action) {
    const stage = this.tradeStates[tradeId] || 'INITIAL';
    if (action.type === 'PARTIAL' && action.volume > 0) {
      this.tradeStates[tradeId] = 'PROTECTING';
    } else if (action.type === 'MODIFY' && action.takeProfit && stage !== 'EXTENDED') {
      this.tradeStates[tradeId] = 'EXTENDED';
    } else if (action.type === 'CLOSE') {
      this.tradeStates[tradeId] = 'CLOSED';
    }
  }

  updatePeakProfit(tradeId, profitR) {
    if (!this.peakProfit[tradeId] || profitR > this.peakProfit[tradeId]) {
      this.peakProfit[tradeId] = profitR;
    }
    return this.peakProfit[tradeId];
  }
}

// ========================================================================
// 10. REGRET ANALYZER
// ========================================================================
class RegretAnalyzer {
  async analyzeClosedTrade(trade, decisions) {
    if (decisions.length === 0) return null;
    const finalProfitR = trade.realizedProfit / (trade.riskAmount || 1);
    const similarity = await stateStore.findSimilar({ symbol: trade.instrument }, trade.instrument, 'M5', 100, 5);
    const maxMFE = similarity?.stats?.avgMFE || 1.0;
    const regret = {
      actualProfit: finalProfitR,
      potentialProfit: maxMFE,
      missedProfit: Math.max(0, maxMFE - finalProfitR),
      efficiency: finalProfitR / maxMFE,
    };
    return regret;
  }
}

// ========================================================================
// 11. ACTION VALIDATOR
// ========================================================================
class ActionValidator {
  async validate(trade, action) {
    if (!action || !action.type) return { valid: false, reason: 'No action' };

    const lastAction = await TradeManagementDecision.findOne({
      tradeId: trade.contractId,
      'chosenAction.type': action.type,
    }).sort({ timestamp: -1 });
    if (lastAction) {
      const timeDiff = Date.now() - new Date(lastAction.timestamp).getTime();
      if (timeDiff < 10000) {
        let same = true;
        if (action.stopLoss !== undefined && lastAction.chosenAction.executedParams?.stopLoss !== undefined) {
          if (Math.abs(action.stopLoss - lastAction.chosenAction.executedParams.stopLoss) > 0.0001) same = false;
        }
        if (action.takeProfit !== undefined && lastAction.chosenAction.executedParams?.takeProfit !== undefined) {
          if (Math.abs(action.takeProfit - lastAction.chosenAction.executedParams.takeProfit) > 0.0001) same = false;
        }
        if (same) {
          return { valid: false, reason: 'Duplicate action sent recently' };
        }
      }
    }

    if (action.stopLoss !== undefined) {
      const side = trade.side.toUpperCase();
      if (side === 'BUY') {
        if (action.stopLoss >= trade.currentPrice) {
          return { valid: false, reason: 'Stop loss must be below current price for BUY' };
        }
      } else {
        if (action.stopLoss <= trade.currentPrice) {
          return { valid: false, reason: 'Stop loss must be above current price for SELL' };
        }
      }
      const pipSize = getPipSize(trade.instrument);
      if (Math.abs(action.stopLoss - trade.currentPrice) < pipSize) {
        return { valid: false, reason: 'Stop loss too close to current price' };
      }
    }

    if (action.type === 'PARTIAL' && action.volume && action.volume > trade.lotSize) {
      return { valid: false, reason: 'Cannot close more than position size' };
    }

    return { valid: true };
  }
}

// ========================================================================
// 12. LEARNING ENGINE
// ========================================================================
class LearningEngine {
  async updateEVWeights() {
    const decisions = await TradeManagementDecision.find({ 'chosenAction.executed': true }).limit(2000);
    if (decisions.length < 50) return;
    const actionPerformance = {};
    for (const d of decisions) {
      const type = d.chosenAction.type;
      if (!actionPerformance[type]) actionPerformance[type] = { total: 0, count: 0, evSum: 0 };
      actionPerformance[type].count++;
      actionPerformance[type].total += (d.outcome?.profitR || 0);
      actionPerformance[type].evSum += (d.chosenAction.ev || 0);
    }
    const adjustments = {};
    for (const [type, data] of Object.entries(actionPerformance)) {
      const avgActual = data.total / data.count;
      const avgExpected = data.evSum / data.count;
      adjustments[type] = avgActual - avgExpected;
    }
    logger.info('[LearningEngine] Action performance adjustments:', adjustments);
    return adjustments;
  }

  async calibrateConfidence() {
    const decisions = await TradeManagementDecision.find({ 'chosenAction.executed': true }).limit(500);
    if (decisions.length < CONFIG.CALIBRATION_MIN_SAMPLES) return null;
    const buckets = {};
    for (const d of decisions) {
      const conf = d.chosenAction.confidence || 50;
      const bucket = Math.floor(conf / 10) * 10;
      if (!buckets[bucket]) buckets[bucket] = { total: 0, wins: 0 };
      buckets[bucket].total++;
      if (d.outcome?.profitR > 0) buckets[bucket].wins++;
    }
    const calibration = {};
    for (const [bucket, data] of Object.entries(buckets)) {
      calibration[bucket] = data.wins / data.total;
    }
    return calibration;
  }
}

// ========================================================================
// 13. MAIN OTIE V5 ENGINE WITH BROADCASTING
// ========================================================================
class OpenTradeIntelligenceV5 extends EventEmitter {
  constructor(broker = null, socketServer = null) {
    super();
    this.broker = broker || new MT5Broker();
    this._socketServer = socketServer;  // socket.io instance
    this._timer = null;
    this._isRunning = false;
    this._tradeHistory = {};
    this._peakProfit = {};

    this.stateClassifier = new ProbabilisticStateClassifier();
    this.profileManager = new SymbolProfileManager();
    this.memoryEngine = new HistoricalMemoryEngine();
    this.predictionEngine = new PredictionEngine();
    this.costModel = new CostModel();
    this.scoreEngine = new ContinuousScoreEngine();
    this.forwardSim = new ForwardSimulation();
    this.actionCompetition = new ActionCompetition();
    this.validator = new ActionValidator();
    this.regretAnalyzer = new RegretAnalyzer();
    this.learningEngine = new LearningEngine();

    this.broker.connect().catch(err => {
      logger.error('[OTIE V5] Broker connection failed:', err.message);
    });

    awarenessEngine.on('marketAwareness', (data) => {
      if (data.unusualEvents && data.unusualEvents.length > 0) {
        this._evaluate().catch(err => logger.warn('[OTIE V5] Fast eval error:', err.message));
      }
    });

    // ---- Broadcast internal events to WebSocket clients ----
    this.on('otieV5State', (state) => {
      this._broadcast('otieState', state);
    });
    this.on('otieV5Action', (action) => {
      this._broadcast('otieAction', action);
    });

    this._startTimer();
    this._scheduleBackgroundJobs();
    this.profileManager.updateAllProfiles().catch(err => logger.warn('[Profiles] Initial update failed:', err.message));

    logger.info('[OTIE V5] Initialized with MT5Broker and real‑time broadcasting.');
  }

  // ---- Set WebSocket server after construction ----
  setWebSocket(socketServer) {
    this._socketServer = socketServer;
    logger.info('[OTIE V5] WebSocket server attached.');
  }

  // ---- Broadcast to all connected clients ----
  _broadcast(event, data) {
    if (!this._socketServer) return;
    // If using socket.io, emit to all clients in the default room.
    if (this._socketServer.emit) {
      this._socketServer.emit(event, data);
    } else if (this._socketServer.clients) {
      // If using 'ws' library, send to all clients (you'll need to JSON.stringify)
      this._socketServer.clients.forEach(client => {
        if (client.readyState === 1) {
          client.send(JSON.stringify({ event, data }));
        }
      });
    }
  }

  // ---- Other methods (unchanged) ----

  _startTimer() {
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => {
      this._evaluate().catch(err => {
        logger.error('[OTIE V5] Evaluation error:', err.message);
      });
    }, CONFIG.EVALUATION_INTERVAL_MS);
    logger.info(`[OTIE V5] Timer started (${CONFIG.EVALUATION_INTERVAL_MS}ms)`);
  }

  _scheduleBackgroundJobs() {
    setInterval(() => {
      this.profileManager.updateAllProfiles().catch(err => logger.warn('[Profiles] Update failed:', err.message));
    }, CONFIG.PROFILE_UPDATE_INTERVAL_MS);

    setInterval(() => {
      this.learningEngine.updateEVWeights().catch(err => logger.warn('[Learning] Update failed:', err.message));
    }, 7 * 24 * 60 * 60 * 1000);

    setInterval(() => {
      this.learningEngine.calibrateConfidence().then(cal => {
        if (cal) logger.info('[Calibration] Confidence calibration updated:', cal);
      }).catch(err => logger.warn('[Calibration] Failed:', err.message));
    }, 7 * 24 * 60 * 60 * 1000);
  }

  async _evaluate() {
    if (this._isRunning) return;
    this._isRunning = true;

    try {
      const openTrades = await Trade.find({
        status: 'OPEN',
        pendingClose: { $ne: true }
      });

      if (openTrades.length === 0) {
        this._isRunning = false;
        return;
      }

      logger.info(`[OTIE V5] Found ${openTrades.length} open trade(s).`);

      for (const trade of openTrades) {
        await this._evaluateTrade(trade);
      }
    } catch (err) {
      logger.error('[OTIE V5] Evaluation error:', err.message);
    } finally {
      this._isRunning = false;
    }
  }

  async _evaluateTrade(trade) {
    const symbol = trade.instrument;
    const side = trade.side.toUpperCase();

    let state, awareness, regime;
    try {
      state = await deepMarketState.compute(symbol, 'M5', 200);
      if (!state) return;
      awareness = marketStateCache.get(symbol) || {};
      regime = deepRegime.getLatestRegime(symbol) || {};
    } catch (err) {
      logger.warn(`[OTIE V5] Could not get state for ${symbol}:`, err.message);
      return;
    }

    // ---- Risk-based profitR ----
    const riskDistance = Math.abs(trade.openPrice - trade.stopLoss);
    const currentProfitR = (state.price.current - trade.openPrice) * (side === 'BUY' ? 1 : -1) / riskDistance;

    const tradeId = trade.contractId;
    if (!this._tradeHistory[tradeId]) {
      this._tradeHistory[tradeId] = new AdaptiveSlidingWindow(symbol);
    }
    const history = this._tradeHistory[tradeId];
    history.push({
      timestamp: Date.now(),
      price: state.price.current,
      profitR: currentProfitR,
      adx: state.trend.adx || 0,
      rsi: state.momentum.rsi || 50,
      macdHist: state.momentum.macdHist || 0,
      bbWidth: state.volatility.bbWidth || 0,
      velocity: state.momentum.velocity || 0,
    });

    const peakProfitR = this.actionCompetition.updatePeakProfit(tradeId, currentProfitR);

    const stateProbs = this.stateClassifier.classify(state, trade, history);
    const analogues = await this.memoryEngine.getAnalogues(trade, state, history);
    const prediction = this.predictionEngine.predict(trade, state, history);
    const cost = this.costModel.computeCost(trade, state);
    const scores = await this.scoreEngine.compute(trade, state, awareness, regime, currentProfitR, history, analogues, prediction, {});
    const profile = await this.profileManager.getProfile(symbol);

    const actions = this.actionCompetition.generateActions(trade, state, scores, analogues, prediction, profile, cost, peakProfitR);
    let filteredActions = actions.filter(a => a.confidence >= CONFIG.MIN_ACTION_CONFIDENCE);
    if (filteredActions.length === 0) {
      filteredActions = [{ type: 'HOLD', ev: 0, confidence: 50, reason: 'No action meets threshold' }];
    }

    const simulated = await this.forwardSim.simulate(trade, state, filteredActions, analogues);
    const bestAction = simulated[0] || { type: 'HOLD', ev: 0, confidence: 50 };

    logger.info(`[OTIE V5] Trade ${tradeId} (${symbol}) profitR=${currentProfitR.toFixed(2)} peak=${peakProfitR.toFixed(2)} bestAction=${bestAction.type} (ev=${bestAction.ev.toFixed(3)}, conf=${bestAction.confidence.toFixed(0)}%)`);

    const validation = await this.validator.validate(trade, bestAction);
    if (!validation.valid) {
      logger.debug(`[OTIE V5] Action rejected: ${validation.reason}`);
      bestAction.type = 'HOLD';
      bestAction.reason = 'Validation failed: ' + validation.reason;
    }

    if (bestAction.type !== 'HOLD' && bestAction.confidence >= CONFIG.MIN_ACTION_CONFIDENCE) {
      await this._executeAction(trade, bestAction);
      this.actionCompetition.updateTradeStage(tradeId, bestAction);
    } else {
      logger.debug(`[OTIE V5] Trade ${tradeId}: no action taken (${bestAction.type}, conf=${bestAction.confidence})`);
    }

    const decision = new TradeManagementDecision({
      tradeId: trade.contractId,
      symbol: trade.instrument,
      timestamp: new Date(),
      marketState: {
        price: state.price.current,
        trend: state.trend,
        momentum: state.momentum,
        volatility: state.volatility,
        structure: state.structure,
        session: state.session,
        regime: state.regime,
        awareness,
      },
      tradeStateProbs: stateProbs.probabilities,
      prediction: prediction,
      analogueSummary: analogues ? {
        sampleSize: analogues.sampleSize,
        winRate: analogues.winRate,
        avgReturnR: analogues.avgReturnR,
        survivalProb: analogues.survivalProb,
      } : null,
      candidateActions: filteredActions.map(a => ({
        type: a.type,
        ev: a.ev || 0,
        confidence: a.confidence || 0,
        reason: a.reason || '',
        proposedParams: { stopLoss: a.stopLoss, takeProfit: a.takeProfit, volume: a.volume },
      })),
      chosenAction: {
        type: bestAction.type,
        ev: bestAction.ev || 0,
        confidence: bestAction.confidence || 0,
        reason: bestAction.reason || '',
        executedParams: { stopLoss: bestAction.stopLoss, takeProfit: bestAction.takeProfit, volume: bestAction.volume },
        executed: bestAction.type !== 'HOLD',
      },
      scores: scores,
      cost: cost,
      regret: null,
      peakProfitR: peakProfitR,
    });
    await decision.save();

    // ---- Emit state for broadcasting (and internal listeners) ----
    this.emit('otieV5State', {
      tradeId: trade.contractId,
      symbol,
      profitR: currentProfitR,
      peakProfitR,
      scores,
      prediction,
      stateProbs: stateProbs.probabilities,
      bestAction: bestAction.type,
      actions: filteredActions.slice(0, 3).map(a => ({ type: a.type, ev: a.ev, confidence: a.confidence })),
      timestamp: new Date().toISOString(),
    });
  }

  // ---- Execute action via broker (no local DB updates) ----
  async _executeAction(trade, action) {
    try {
      logger.info(`[OTIE V5] Executing action: ${action.type} on trade ${trade.contractId} (reason: ${action.reason})`);

      const freshTrade = await Trade.findOne({ contractId: trade.contractId, status: 'OPEN' });
      if (!freshTrade) {
        logger.warn(`[OTIE V5] Trade ${trade.contractId} no longer open – skipping action.`);
        return;
      }

      if (action.type === 'CLOSE') {
        await Trade.updateOne({ contractId: trade.contractId }, { $set: { pendingClose: true } });
      }

      let result;
      switch (action.type) {
        case 'MODIFY':
          result = await this.broker.modifySLTP(trade.contractId, action.stopLoss, action.takeProfit);
          break;
        case 'PARTIAL':
          if (this.broker.capabilities.supportsPartialClose) {
            result = await this.broker.partialClose(trade.contractId, action.volume);
          } else {
            logger.warn('[OTIE V5] Broker does not support partial close – closing full position.');
            result = await this.broker.closeTrade(trade.contractId);
            action.type = 'CLOSE';
          }
          break;
        case 'CLOSE':
          result = await this.broker.closeTrade(trade.contractId);
          break;
        default:
          logger.warn(`[OTIE V5] Unknown action type: ${action.type}`);
          return;
      }

      if (result && result.success) {
        logger.info(`[OTIE V5] ✅ Action ${action.type} executed successfully for trade ${trade.contractId}`);
        // Emit action for broadcasting
        this.emit('otieV5Action', {
          tradeId: trade.contractId,
          action: action.type,
          details: action,
          result,
          timestamp: new Date().toISOString(),
        });
      } else {
        if (action.type === 'CLOSE') {
          await Trade.updateOne({ contractId: trade.contractId }, { $set: { pendingClose: false } });
        }
        const errorMsg = result?.error || 'Unknown error';
        logger.error(`[OTIE V5] ❌ Action ${action.type} failed: ${errorMsg}`);
      }
    } catch (err) {
      logger.error(`[OTIE V5] ❌ Failed to execute action:`, err.message);
      if (action.type === 'CLOSE') {
        await Trade.updateOne({ contractId: trade.contractId }, { $set: { pendingClose: false } });
      }
    }
  }

  updateConfig(newThresholds) {
    CONFIG.BREAKEVEN_PROFIT_R = newThresholds.breakevenProfitR ?? CONFIG.BREAKEVEN_PROFIT_R;
    if (newThresholds.progressiveSLSteps) {
      CONFIG.PROGRESSIVE_SL_STEPS = newThresholds.progressiveSLSteps;
    }
    CONFIG.PARTIAL_FRACTION_MIN = newThresholds.partialFractionMin ?? CONFIG.PARTIAL_FRACTION_MIN;
    CONFIG.PARTIAL_FRACTION_MAX = newThresholds.partialFractionMax ?? CONFIG.PARTIAL_FRACTION_MAX;
    CONFIG.EXPECTED_REMAINING_THRESHOLD = newThresholds.expectedRemainingThreshold ?? CONFIG.EXPECTED_REMAINING_THRESHOLD;
    logger.info('[OTIE V5] Configuration updated by Performance Monitor.');
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    logger.info('[OTIE V5] Stopped.');
  }
}

module.exports = new OpenTradeIntelligenceV5();
