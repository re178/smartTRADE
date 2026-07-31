// core/intelligence/lab/stateStore.js
// Similarity search using HistoricalState, outcomes from HistoricalOutcome.

const HistoricalState = require('../../../models/HistoricalState');
const HistoricalOutcome = require('../../../models/HistoricalOutcome');
const logger = require('../../../infrastructure/logger') || console;

const CONFIG = {
  DEFAULT_LOOKAHEAD: 5,
  DEFAULT_K: 100,
  MIN_SAMPLES_FOR_EDGE: 20,
};

function getSymbolVariants(symbol) {
  if (!symbol) return [];
  const clean = symbol.replace(/_/g, '').toUpperCase();
  const withUnderscore = clean.slice(0, 3) + '_' + clean.slice(3);
  return [...new Set([clean, withUnderscore])];
}

class FeatureNormalizer {
  constructor() {
    this.featureStats = {};
    this.isLoaded = false;
  }

  async loadStats() {
    if (this.isLoaded) return;
    try {
      const sample = await HistoricalState.aggregate([
        { $sample: { size: 1000 } },
        { $group: {
            _id: null,
            adxMin: { $min: '$trend.adx' },
            adxMax: { $max: '$trend.adx' },
            rsiMin: { $min: '$momentum.rsi' },
            rsiMax: { $max: '$momentum.rsi' },
            atrPercentMin: { $min: '$volatility.atrPercent' },
            atrPercentMax: { $max: '$volatility.atrPercent' },
            bbWidthMin: { $min: '$volatility.bbWidth' },
            bbWidthMax: { $max: '$volatility.bbWidth' },
            macdHistMin: { $min: '$momentum.macdHist' },
            macdHistMax: { $max: '$momentum.macdHist' },
            liquidityMin: { $min: '$liquidity.score' },
            liquidityMax: { $max: '$liquidity.score' },
            velocityMin: { $min: '$momentum.velocity' },
            velocityMax: { $max: '$momentum.velocity' },
            accelerationMin: { $min: '$momentum.acceleration' },
            accelerationMax: { $max: '$momentum.acceleration' },
            pricePositionMin: { $min: '$structure.pricePosition' },
            pricePositionMax: { $max: '$structure.pricePosition' },
            marketQualityMin: { $min: '$summary.marketQuality' },
            marketQualityMax: { $max: '$summary.marketQuality' },
          }
        }}
      ]);
      if (sample.length === 0) this.featureStats = this._getDefaultStats();
      else {
        const stats = sample[0];
        this.featureStats = {
          adx: { min: stats.adxMin || 0, max: stats.adxMax || 100 },
          rsi: { min: stats.rsiMin || 0, max: stats.rsiMax || 100 },
          atrPercent: { min: stats.atrPercentMin || 0, max: stats.atrPercentMax || 0.05 },
          bbWidth: { min: stats.bbWidthMin || 0, max: stats.bbWidthMax || 0.5 },
          macdHist: { min: stats.macdHistMin || -0.01, max: stats.macdHistMax || 0.01 },
          liquidity: { min: stats.liquidityMin || 0, max: stats.liquidityMax || 1 },
          velocity: { min: stats.velocityMin || -0.001, max: stats.velocityMax || 0.001 },
          acceleration: { min: stats.accelerationMin || -0.0001, max: stats.accelerationMax || 0.0001 },
          pricePosition: { min: stats.pricePositionMin || 0, max: stats.pricePositionMax || 1 },
          marketQuality: { min: stats.marketQualityMin || 0, max: stats.marketQualityMax || 100 },
        };
      }
      this.isLoaded = true;
    } catch (err) {
      logger.warn('[StateStore] Failed to load stats, using defaults.', err.message);
      this.featureStats = this._getDefaultStats();
      this.isLoaded = true;
    }
  }

  _getDefaultStats() {
    return {
      adx: { min: 0, max: 100 },
      rsi: { min: 0, max: 100 },
      atrPercent: { min: 0, max: 0.05 },
      bbWidth: { min: 0, max: 0.5 },
      macdHist: { min: -0.01, max: 0.01 },
      liquidity: { min: 0, max: 1 },
      velocity: { min: -0.001, max: 0.001 },
      acceleration: { min: -0.0001, max: 0.0001 },
      pricePosition: { min: 0, max: 1 },
      marketQuality: { min: 0, max: 100 },
    };
  }

  normalize(featureName, value) {
    const stats = this.featureStats[featureName];
    if (!stats) return value;
    const { min, max } = stats;
    if (max === min) return 0.5;
    return (value - min) / (max - min);
  }

  normalizeVector(features) {
    const normalized = {};
    for (const [key, val] of Object.entries(features)) {
      normalized[key] = this.normalize(key, val);
    }
    return normalized;
  }
}

class StateStore {
  constructor() {
    this.normalizer = new FeatureNormalizer();
    this._isReady = false;
    this._similarityCache = new Map();
    this._edgeCache = new Map();
  }

  async init() {
    if (this._isReady) return;
    await this.normalizer.loadStats();
    this._isReady = true;
    logger.info('[StateStore] Initialized.');
  }

  async findSimilar(queryFeatures, symbol = null, timeframe = 'M5', k = CONFIG.DEFAULT_K, lookahead = CONFIG.DEFAULT_LOOKAHEAD) {
    await this.init();

    const normalizedQuery = this.normalizer.normalizeVector(queryFeatures);
    const featureFields = Object.keys(normalizedQuery);

    const filter = {};
    if (timeframe) filter.timeframe = timeframe;
    if (symbol) {
      const variants = getSymbolVariants(symbol);
      filter.$or = variants.map(sym => ({ symbol: sym }));
    }

    logger.info(`[StateStore] findSimilar filter: ${JSON.stringify(filter)}`);

    const states = await HistoricalState.find(filter)
      .sort({ timestamp: -1 })
      .limit(50000)
      .lean();

    logger.info(`[StateStore] Found ${states.length} states for ${symbol || 'any'} ${timeframe}`);

    if (states.length === 0) {
      return { states: [], stats: { count: 0, winRate: 0, avgReturnR: 0, maxDrawdown: 0, profitFactor: 0 } };
    }

    // Compute distances
    const withDistances = states.map(state => {
      const stateFeatures = {
        adx: state.trend.adx,
        rsi: state.momentum.rsi,
        atrPercent: state.volatility.atrPercent,
        bbWidth: state.volatility.bbWidth,
        macdHist: state.momentum.macdHist,
        liquidity: state.liquidity.score,
        velocity: state.momentum.velocity,
        acceleration: state.momentum.acceleration,
        pricePosition: state.structure.pricePosition,
        marketQuality: state.summary.marketQuality,
      };
      const normalizedState = this.normalizer.normalizeVector(stateFeatures);
      let squaredSum = 0;
      for (const field of featureFields) {
        const q = normalizedQuery[field] || 0;
        const s = normalizedState[field] || 0;
        squaredSum += (q - s) ** 2;
      }
      const distance = Math.sqrt(squaredSum);
      return { state, distance };
    });

    withDistances.sort((a, b) => a.distance - b.distance);
    const topK = withDistances.slice(0, k);

    // ---- Get outcomes from HistoricalOutcome for these state IDs ----
    const stateIds = topK.map(item => item.state._id);
    const outcomes = await HistoricalOutcome.find({
      stateId: { $in: stateIds },
      lookahead: lookahead
    }).lean();

    // Create a map: stateId -> outcome
    const outcomeMap = {};
    outcomes.forEach(o => {
      outcomeMap[o.stateId.toString()] = o.outcome;
    });

    // Build result with outcomes
    const resultStates = topK.map(item => ({
      state: item.state,
      distance: item.distance,
      outcome: outcomeMap[item.state._id.toString()] || null
    }));

    // Filter only labelled outcomes (where returnR is a number)
    const labelled = resultStates.filter(item => item.outcome && item.outcome.returnR !== null && typeof item.outcome.returnR === 'number' && !isNaN(item.outcome.returnR));

    const stats = this._computeStats(labelled.map(item => item.outcome));

    logger.info(`[StateStore] Similarity stats: sampleSize=${stats.count}, winRate=${stats.winRate}, avgReturnR=${stats.avgReturnR}`);

    return {
      states: resultStates,
      stats,
    };
  }

  async computeEdge(features, symbol = null, timeframe = 'M5', lookahead = CONFIG.DEFAULT_LOOKAHEAD, k = CONFIG.DEFAULT_K) {
    const cacheKey = `edge:${symbol || '*'}:${timeframe}:${lookahead}:${k}:${JSON.stringify(features)}`;
    if (this._edgeCache.has(cacheKey)) {
      const cached = this._edgeCache.get(cacheKey);
      if (Date.now() - cached.timestamp < 300000) return cached.data;
      this._edgeCache.delete(cacheKey);
    }

    const similarityResult = await this.findSimilar(features, symbol, timeframe, k, lookahead);
    const stats = similarityResult.stats;
    const result = {
      edge: stats.avgReturnR || 0,
      winRate: stats.winRate || 0,
      avgReturnR: stats.avgReturnR || 0,
      maxDrawdown: stats.maxDrawdown || 0,
      sampleSize: stats.count || 0,
      profitFactor: stats.profitFactor || 0,
    };
    this._edgeCache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
  }

  _computeStats(outcomes) {
    if (!outcomes || outcomes.length === 0) {
      return { count: 0, winRate: 0, avgReturnR: 0, maxDrawdown: 0, profitFactor: 0 };
    }
    const total = outcomes.length;
    const wins = outcomes.filter(o => o.win === true).length;
    const winRate = total > 0 ? wins / total : 0;
    const avgReturnR = outcomes.reduce((sum, o) => sum + (o.returnR || 0), 0) / total;
    const maxDrawdown = Math.min(0, ...outcomes.map(o => o.maxDrawdown || 0));
    const totalWins = outcomes.filter(o => (o.returnR || 0) > 0).reduce((sum, o) => sum + (o.returnR || 0), 0);
    const totalLosses = outcomes.filter(o => (o.returnR || 0) < 0).reduce((sum, o) => sum + Math.abs(o.returnR || 0), 0);
    const profitFactor = totalLosses > 0 ? totalWins / totalLosses : (totalWins > 0 ? Infinity : 0);
    return { count: total, winRate, avgReturnR, maxDrawdown, profitFactor };
  }

  async calibrateConfidence(decision, lookahead = CONFIG.DEFAULT_LOOKAHEAD, k = CONFIG.DEFAULT_K) {
    const features = decision.features || decision;
    const similarityResult = await this.findSimilar(features, decision.symbol, decision.timeframe, k, lookahead);
    const stats = similarityResult.stats;
    return {
      calibratedConfidence: Math.min(100, Math.max(0, stats.winRate * 100)),
      sampleSize: stats.count,
      originalConfidence: decision.confidence || 50,
      calibrationError: Math.abs((decision.confidence || 50) - stats.winRate * 100) / 100,
    };
  }

  invalidateCache() {
    this._similarityCache.clear();
    this._edgeCache.clear();
    logger.debug('[StateStore] Cache invalidated.');
  }
}

const stateStore = new StateStore();
module.exports = stateStore;
