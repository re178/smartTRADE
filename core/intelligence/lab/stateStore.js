// core/intelligence/lab/stateStore.js
// Similarity search, edge computation – handles symbol variants and logs diagnostics.

const HistoricalState = require('../../../models/HistoricalState');
const HistoricalOutcome = require('../../../models/HistoricalOutcome');
const logger = require('../../../infrastructure/logger') || console;

const CONFIG = {
  DEFAULT_LOOKAHEAD: 5,
  DEFAULT_K: 100,
  MIN_SAMPLES_FOR_EDGE: 20,
};

// ---- Symbol variants (with and without underscore) ----
function getSymbolVariants(symbol) {
  if (!symbol) return [];
  const clean = symbol.replace(/_/g, '').toUpperCase();
  const withUnderscore = clean.slice(0, 3) + '_' + clean.slice(3);
  const variants = [clean, withUnderscore];
  return [...new Set(variants)];
}

// ---- Feature normalizer ----
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
          },
        },
      ]);
      if (sample.length === 0) {
        this.featureStats = this._getDefaultStats();
      } else {
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
      logger.debug('[StateStore] Feature stats loaded.');
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

// ---- Main StateStore ----
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

  // ---- Get total state count for a symbol (for debugging) ----
  async getStateCount(symbol) {
    const variants = getSymbolVariants(symbol);
    const counts = {};
    for (const sym of variants) {
      counts[sym] = await HistoricalState.countDocuments({ symbol: sym });
    }
    return counts;
  }

  // ---- Main similarity search ----
  async findSimilar(queryFeatures, symbol = null, timeframe = 'M5', k = CONFIG.DEFAULT_K, lookahead = CONFIG.DEFAULT_LOOKAHEAD) {
    const cacheKey = this._getCacheKey(queryFeatures, symbol, timeframe, k, lookahead);
    if (this._similarityCache.has(cacheKey)) {
      const cached = this._similarityCache.get(cacheKey);
      if (Date.now() - cached.timestamp < 300000) {
        return cached.data;
      }
      this._similarityCache.delete(cacheKey);
    }

    await this.init();

    const normalizedQuery = this.normalizer.normalizeVector(queryFeatures);
    const featureFields = Object.keys(normalizedQuery);

    // Build filter with symbol variants
    const filter = {};
    if (timeframe) filter.timeframe = timeframe;

    if (symbol) {
      const variants = getSymbolVariants(symbol);
      if (variants.length === 1) {
        filter.symbol = variants[0];
      } else {
        filter.$or = variants.map(sym => ({ symbol: sym }));
      }
    }

    // ---- Log filter ----
    logger.info(`[StateStore] findSimilar filter: ${JSON.stringify(filter)}`);

    // ---- Fetch states ----
    const states = await HistoricalState.find(filter)
      .sort({ timestamp: -1 })
      .limit(50000)
      .lean();

    logger.info(`[StateStore] Found ${states.length} states for ${symbol || 'any'} ${timeframe}`);

    if (states.length === 0) {
      // Try a case-insensitive regex fallback
      const regexFilter = {
        timeframe,
        symbol: { $regex: new RegExp(symbol.replace(/_/g, ''), 'i') }
      };
      const regexStates = await HistoricalState.find(regexFilter)
        .sort({ timestamp: -1 })
        .limit(50000)
        .lean();
      if (regexStates.length > 0) {
        logger.info(`[StateStore] Regex fallback found ${regexStates.length} states`);
        // Continue with regexStates
        return this._computeFromStates(regexStates, normalizedQuery, featureFields, lookahead, k);
      }
      return { states: [], stats: { count: 0, winRate: 0, avgReturnR: 0, maxDrawdown: 0, profitFactor: 0 } };
    }

    return this._computeFromStates(states, normalizedQuery, featureFields, lookahead, k);
  }

  // ---- Helper to compute distances and stats from a state array ----
  _computeFromStates(states, normalizedQuery, featureFields, lookahead, k) {
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
      const outcomeKey = `outcome${lookahead}`;
      const outcome = state[outcomeKey] || { return: null, returnR: null, win: null, maxDrawdown: null };
      return { state, distance, outcome };
    });

    withDistances.sort((a, b) => a.distance - b.distance);
    const topK = withDistances.slice(0, k);

    // Count how many have labelled outcomes
    const labelled = topK.filter(item => item.outcome.return !== null);
    const stats = this._computeStats(labelled.map(item => item.outcome));

    // Log stats
    logger.info(`[StateStore] Similarity stats: sampleSize=${stats.count}, winRate=${stats.winRate}, avgReturnR=${stats.avgReturnR}`);

    const result = {
      states: topK.map(item => ({ state: item.state, distance: item.distance, outcome: item.outcome })),
      stats,
    };

    // Cache
    const cacheKey = this._getCacheKeyFromQuery(...arguments);
    this._similarityCache.set(cacheKey, { data: result, timestamp: Date.now() });

    return result;
  }

  // ---- Edge computation ----
  async computeEdge(features, symbol = null, timeframe = 'M5', lookahead = CONFIG.DEFAULT_LOOKAHEAD, k = CONFIG.DEFAULT_K) {
    const cacheKey = `edge:${symbol || '*'}:${timeframe}:${lookahead}:${k}:${JSON.stringify(features)}`;
    if (this._edgeCache.has(cacheKey)) {
      const cached = this._edgeCache.get(cacheKey);
      if (Date.now() - cached.timestamp < 300000) {
        return cached.data;
      }
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

  // ---- Stats calculator ----
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

  // ---- Calibration ----
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

  _getCacheKey(...args) {
    // simplified for caching
    return JSON.stringify(args);
  }
}

// ---- Singleton ----
const stateStore = new StateStore();
module.exports = stateStore;
