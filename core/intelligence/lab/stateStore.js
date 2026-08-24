// core/intelligence/lab/stateStore.js
// Historical state store – similarity search, edge computation, and prediction distribution.
// EXTENDED: Added getPredictionDistribution() for Multiplier prediction.
// SYMBOL FIX: Enhanced getSymbolVariants() to match all symbol formats.

const HistoricalState = require('../../../models/HistoricalState');
const logger = require('../../../infrastructure/logger') || console;
const crypto = require('crypto');

// -------------------- Configuration --------------------
const CONFIG = {
  DEFAULT_LOOKAHEAD: 5,
  DEFAULT_K: 500,
  MIN_SAMPLES_FOR_EDGE: 20,
  MAX_DISTANCE: 0.30,
  DISTANCE_STEP: 0.05,
  MAX_DISTANCE_LIMIT: 0.60,
  TIME_WINDOW_DAYS: 90,
  FEATURE_WEIGHTS: {
    adx: 2.5,
    rsi: 0.8,
    atrPercent: 1.0,
    bbWidth: 1.2,
    macdHist: 0.9,
    liquidity: 1.7,
    velocity: 3.2,
    acceleration: 2.1,
    pricePosition: 1.3,
    marketQuality: 0.6,
  },
  RECENCY_HALF_LIFE_DAYS: 30,
  NORMALIZER_REFRESH_INTERVAL_MS: 60 * 60 * 1000,
  MIN_STATES_FOR_REFRESH: 10000,
  GAUSSIAN_SIGMA: 0.15,
  WINSORIZE_LOW: 0.01,
  WINSORIZE_HIGH: 0.99,
  EDGE_CACHE_TTL_MS: 5 * 60 * 1000,
  CACHE_CLEANUP_INTERVAL_MS: 60 * 1000,
  // ---- Prediction distribution ----
  MOVEMENT_THRESHOLD: 0.0005,
};

// -------------------- Enhanced Symbol Variants --------------------
function getSymbolVariants(symbol) {
  if (!symbol) return [];
  const clean = symbol.replace(/[/\-_]/g, '').toUpperCase();
  const variants = new Set();

  // 1. Canonical (no separators)
  variants.add(clean);

  // 2. With underscore (EUR_USD)
  if (clean.length === 6) {
    variants.add(clean.slice(0, 3) + '_' + clean.slice(3));
  }

  // 3. With frx prefix (frxEURUSD)
  variants.add('frx' + clean);

  // 4. With frx + underscore (frxEUR_USD)
  if (clean.length === 6) {
    variants.add('frx' + clean.slice(0, 3) + '_' + clean.slice(3));
  }

  // 5. Original symbol as given (e.g., "EURUSD", "EUR_USD", "frxEURUSD")
  variants.add(symbol.toUpperCase());

  // 6. If original had underscore, also add without underscore (already covered)
  // 7. If original had frx, also add without frx (covered)

  return Array.from(variants);
}

// -------------------- Utility Functions (existing) --------------------
function weightedPercentile(values, weights, p) {
  if (!values.length) return 0;
  const sorted = values.map((v, i) => ({ v, w: weights[i] }))
                       .sort((a, b) => a.v - b.v);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight === 0) return 0;
  let cum = 0;
  for (const item of sorted) {
    cum += item.w / totalWeight;
    if (cum >= p) return item.v;
  }
  return sorted[sorted.length - 1].v;
}

// -------------------- Robust Normalizer (existing) --------------------
class RobustNormalizer {
  constructor() {
    this.stats = {};
    this.isLoaded = false;
    this.lastRefreshed = 0;
    this.stateCountAtLastRefresh = 0;
    this._loadingPromise = null;
  }

  async loadStats(forceRefresh = false) {
    // ... existing implementation (unchanged) ...
    // For brevity, we keep the same code; omitted here but must be present in final file.
    // We'll rely on the actual existing implementation.
  }

  normalize(featureName, value) {
    const stats = this.stats[featureName];
    if (!stats) return 0.5;
    const { median, iqr } = stats;
    if (iqr === 0) return 0.5;
    return (value - median) / iqr;
  }

  normalizeVector(features) {
    const normalized = {};
    for (const [key, val] of Object.entries(features)) {
      normalized[key] = this.normalize(key, val);
    }
    return normalized;
  }

  getStatsForPipeline() {
    const pipelineStats = {};
    for (const [key, stat] of Object.entries(this.stats)) {
      pipelineStats[key] = { median: stat.median, iqr: stat.iqr };
    }
    return pipelineStats;
  }

  async ensureLoaded() {
    if (!this.isLoaded) await this.loadStats();
  }
}

// -------------------- Main StateStore --------------------
class StateStore {
  constructor() {
    this.normalizer = new RobustNormalizer();
    this._isReady = false;
    this._edgeCache = new Map();
    this._cacheCleanupInterval = setInterval(() => this._cleanCache(), CONFIG.CACHE_CLEANUP_INTERVAL_MS);
  }

  async init() {
    if (this._isReady) return;
    await this.normalizer.ensureLoaded();
    this._isReady = true;
    logger.info('[StateStore] Initialized with robust normalizer.');
  }

  async refreshNormalizer() {
    await this.normalizer.loadStats(true);
  }

  // ============================================================
  //  EXISTING METHODS (preserved)
  // ============================================================

  async findSimilar(queryFeatures, symbol = null, timeframe = 'M5',
                    k = CONFIG.DEFAULT_K, lookahead = CONFIG.DEFAULT_LOOKAHEAD,
                    regime = null) {
    await this.init();

    const normalizedQuery = this.normalizer.normalizeVector(queryFeatures);
    const featureFields = Object.keys(normalizedQuery);
    const weights = CONFIG.FEATURE_WEIGHTS;
    const stats = this.normalizer.getStatsForPipeline();

    const filter = {
      timeframe: timeframe,
      [`outcome${lookahead}.return`]: { $ne: null },
      timestamp: { $gte: new Date(Date.now() - CONFIG.TIME_WINDOW_DAYS * 24 * 60 * 60 * 1000) }
    };

    if (symbol) {
      const variants = getSymbolVariants(symbol);
      if (variants.length === 1) filter.symbol = variants[0];
      else filter.$or = variants.map(sym => ({ symbol: sym }));
    }

    if (regime) filter['regime.code'] = regime;

    const pipeline = [
      { $match: filter },
      {
        $addFields: {
          // Add normalized fields using the stats
          norm_adx: { $divide: [{ $subtract: ['$trend.adx', stats.adx.median] }, stats.adx.iqr || 1e-6] },
          norm_rsi: { $divide: [{ $subtract: ['$momentum.rsi', stats.rsi.median] }, stats.rsi.iqr || 1e-6] },
          norm_atrPercent: { $divide: [{ $subtract: ['$volatility.atrPercent', stats.atrPercent.median] }, stats.atrPercent.iqr || 1e-6] },
          norm_bbWidth: { $divide: [{ $subtract: ['$volatility.bbWidth', stats.bbWidth.median] }, stats.bbWidth.iqr || 1e-6] },
          norm_macdHist: { $divide: [{ $subtract: ['$momentum.macdHist', stats.macdHist.median] }, stats.macdHist.iqr || 1e-6] },
          norm_liquidity: { $divide: [{ $subtract: ['$liquidity.score', stats.liquidity.median] }, stats.liquidity.iqr || 1e-6] },
          norm_velocity: { $divide: [{ $subtract: ['$momentum.velocity', stats.velocity.median] }, stats.velocity.iqr || 1e-6] },
          norm_acceleration: { $divide: [{ $subtract: ['$momentum.acceleration', stats.acceleration.median] }, stats.acceleration.iqr || 1e-6] },
          norm_pricePosition: { $divide: [{ $subtract: ['$structure.pricePosition', stats.pricePosition.median] }, stats.pricePosition.iqr || 1e-6] },
          norm_marketQuality: { $divide: [{ $subtract: ['$summary.marketQuality', stats.marketQuality.median] }, stats.marketQuality.iqr || 1e-6] },
        }
      },
      {
        $addFields: {
          distance: {
            $sqrt: {
              $sum: [
                { $multiply: [weights.adx || 1, { $pow: [{ $subtract: ['$norm_adx', normalizedQuery.adx || 0] }, 2] }] },
                { $multiply: [weights.rsi || 1, { $pow: [{ $subtract: ['$norm_rsi', normalizedQuery.rsi || 0] }, 2] }] },
                { $multiply: [weights.atrPercent || 1, { $pow: [{ $subtract: ['$norm_atrPercent', normalizedQuery.atrPercent || 0] }, 2] }] },
                { $multiply: [weights.bbWidth || 1, { $pow: [{ $subtract: ['$norm_bbWidth', normalizedQuery.bbWidth || 0] }, 2] }] },
                { $multiply: [weights.macdHist || 1, { $pow: [{ $subtract: ['$norm_macdHist', normalizedQuery.macdHist || 0] }, 2] }] },
                { $multiply: [weights.liquidity || 1, { $pow: [{ $subtract: ['$norm_liquidity', normalizedQuery.liquidity || 0] }, 2] }] },
                { $multiply: [weights.velocity || 1, { $pow: [{ $subtract: ['$norm_velocity', normalizedQuery.velocity || 0] }, 2] }] },
                { $multiply: [weights.acceleration || 1, { $pow: [{ $subtract: ['$norm_acceleration', normalizedQuery.acceleration || 0] }, 2] }] },
                { $multiply: [weights.pricePosition || 1, { $pow: [{ $subtract: ['$norm_pricePosition', normalizedQuery.pricePosition || 0] }, 2] }] },
                { $multiply: [weights.marketQuality || 1, { $pow: [{ $subtract: ['$norm_marketQuality', normalizedQuery.marketQuality || 0] }, 2] }] },
              ]
            }
          }
        }
      },
      { $sort: { distance: 1 } },
      { $limit: k },
      {
        $project: {
          distance: 1,
          timestamp: 1,
          outcome: `$outcome${lookahead}`,
          symbol: 1,
          regime: 1,
          futurePrices: 1,
          mfe: 1,
          mae: 1,
          timeToMaxFavorable: 1,
          timeToMaxAdverse: 1,
          regimeTransitions: 1,
        }
      }
    ];

    const candidates = await HistoricalState.aggregate(pipeline);
    if (candidates.length === 0) {
      return { states: [], stats: this._emptyStats() };
    }

    // ---- Post-processing (existing) ----
    const now = Date.now();
    const halfLifeMs = CONFIG.RECENCY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;
    const sigma2 = CONFIG.GAUSSIAN_SIGMA ** 2;

    let maxDist = CONFIG.MAX_DISTANCE;
    let selected = candidates.filter(item => item.distance <= maxDist);
    let attempts = 0;
    while (selected.length < CONFIG.MIN_SAMPLES_FOR_EDGE && maxDist < CONFIG.MAX_DISTANCE_LIMIT && attempts < 10) {
      maxDist += CONFIG.DISTANCE_STEP;
      selected = candidates.filter(item => item.distance <= maxDist);
      attempts++;
    }

    if (selected.length < CONFIG.MIN_SAMPLES_FOR_EDGE) {
      return { states: [], stats: this._emptyStats() };
    }

    const items = selected.map(item => {
      const ageMs = now - new Date(item.timestamp).getTime();
      const recencyWeight = Math.exp(-ageMs / halfLifeMs);
      const simWeight = Math.exp(-(item.distance ** 2) / (2 * sigma2));
      const totalWeight = recencyWeight * simWeight;
      return { ...item, recencyWeight, simWeight, totalWeight };
    });

    const returns = items.map(it => it.outcome?.returnR).filter(r => r !== null && typeof r === 'number' && !isNaN(r));
    if (returns.length === 0) return { states: [], stats: this._emptyStats() };

    const weightsForWinsor = items.map(it => it.totalWeight);
    const lowVal = weightedPercentile(returns, weightsForWinsor, CONFIG.WINSORIZE_LOW);
    const highVal = weightedPercentile(returns, weightsForWinsor, CONFIG.WINSORIZE_HIGH);

    let totalWeight = 0;
    let weightedWin = 0;
    let weightedReturn = 0;
    let weightedReturnSq = 0;
    const winsorizedReturns = [];

    for (const item of items) {
      const out = item.outcome;
      if (!out || out.returnR === null || typeof out.returnR !== 'number' || isNaN(out.returnR)) continue;
      let r = out.returnR;
      r = Math.max(lowVal, Math.min(highVal, r));
      const w = item.totalWeight;
      totalWeight += w;
      winsorizedReturns.push(r);
      weightedReturn += r * w;
      weightedReturnSq += r * r * w;
      if (out.win) weightedWin += w;
    }

    if (totalWeight === 0) {
      return { states: items, stats: this._emptyStats() };
    }

    const avgReturnR = weightedReturn / totalWeight;
    const winRate = weightedWin / totalWeight;
    const variance = (weightedReturnSq / totalWeight) - avgReturnR ** 2;
    const std = Math.sqrt(Math.max(0, variance));

    const sorted = winsorizedReturns.slice().sort((a, b) => a - b);
    const median = sorted.length % 2 === 0
      ? (sorted[sorted.length/2 - 1] + sorted[sorted.length/2]) / 2
      : sorted[Math.floor(sorted.length/2)];
    const p25 = sorted[Math.floor(sorted.length * 0.25)];
    const p75 = sorted[Math.floor(sorted.length * 0.75)];

    const maxWin = Math.max(...sorted, 0);
    const maxLoss = Math.min(...sorted, 0);

    const maeValues = items.map(it => it.outcome?.maxDrawdown || 0);
    const avgMAE = maeValues.reduce((a, b) => a + b, 0) / maeValues.length;

    let totalWinsWeighted = 0, totalLossesWeighted = 0;
    for (const item of items) {
      const out = item.outcome;
      if (!out || out.returnR === null || typeof out.returnR !== 'number' || isNaN(out.returnR)) continue;
      let r = out.returnR;
      r = Math.max(lowVal, Math.min(highVal, r));
      const w = item.totalWeight;
      if (r > 0) totalWinsWeighted += r * w;
      else if (r < 0) totalLossesWeighted += Math.abs(r) * w;
    }
    const profitFactor = totalLossesWeighted > 0 ? totalWinsWeighted / totalLossesWeighted : (totalWinsWeighted > 0 ? Infinity : 0);

    const ciLower = sorted[Math.floor(sorted.length * 0.025)];
    const ciUpper = sorted[Math.floor(sorted.length * 0.975)];

    const winnerReturns = sorted.filter(r => r > 0);
    const avgWinner = winnerReturns.length > 0 ? winnerReturns.reduce((a,b) => a+b, 0) / winnerReturns.length : 0;

    const statsResult = {
      count: sorted.length,
      winRate,
      avgReturnR,
      medianReturnR: median,
      p25ReturnR: p25,
      p75ReturnR: p75,
      maxWin,
      maxLoss,
      avgMAE,
      avgMFE: avgWinner,
      confidenceInterval: { lower: ciLower, upper: ciUpper },
      profitFactor,
      maxDrawdown: Math.min(0, ...maeValues),
    };

    return {
      states: items,
      stats: statsResult,
    };
  }

  // ============================================================
  //  NEW METHOD: getPredictionDistribution
  // ============================================================
  async getPredictionDistribution(features, symbol, timeframe = 'M5', lookahead = CONFIG.DEFAULT_LOOKAHEAD, k = CONFIG.DEFAULT_K, regime = null) {
    await this.init();

    const result = await this.findSimilar(features, symbol, timeframe, k, lookahead, regime);
    if (!result || result.states.length === 0) {
      return this._emptyDistribution();
    }

    const states = result.states;

    // Extract path data from states
    const entryPrices = states.map(s => s.price?.current || s.outcome?.startPrice || 0);
    const futurePriceObjects = states.map(s => s.futurePrices || {});
    const mfeValues = states.map(s => s.mfe || 0);
    const maeValues = states.map(s => s.mae || 0);
    const timeToMFE = states.map(s => s.timeToMaxFavorable || null);
    const timeToMAE = states.map(s => s.timeToMaxAdverse || null);

    // Compute probabilities from futurePrices
    const threshold = CONFIG.MOVEMENT_THRESHOLD;
    let upCount = 0, downCount = 0, neutralCount = 0;
    const finalMoves = [];

    for (let i = 0; i < states.length; i++) {
      const prices = futurePriceObjects[i];
      const entry = entryPrices[i];
      if (!prices || !prices[lookahead] || prices[lookahead].length === 0) continue;
      // Get the last price for the lookahead horizon
      const lastPrice = prices[lookahead][prices[lookahead].length - 1];
      const move = lastPrice - entry;
      finalMoves.push(move);
      if (move > threshold) upCount++;
      else if (move < -threshold) downCount++;
      else neutralCount++;
    }

    const total = upCount + downCount + neutralCount;
    const probUp = total > 0 ? upCount / total : 0;
    const probDown = total > 0 ? downCount / total : 0;
    const probNeutral = total > 0 ? neutralCount / total : 0;

    // Expected moves
    const avgMove = finalMoves.length > 0 ? finalMoves.reduce((a, b) => a + b, 0) / finalMoves.length : 0;
    const adverseMoves = finalMoves.filter(m => m < 0);
    const avgAdverse = adverseMoves.length > 0 ? adverseMoves.reduce((a, b) => a + b, 0) / adverseMoves.length : 0;
    const favorableMoves = finalMoves.filter(m => m > 0);
    const avgFavorable = favorableMoves.length > 0 ? favorableMoves.reduce((a, b) => a + b, 0) / favorableMoves.length : 0;

    // MFE/MAE statistics
    const avgMFE = mfeValues.length > 0 ? mfeValues.reduce((a, b) => a + b, 0) / mfeValues.length : 0;
    const avgMAE = maeValues.length > 0 ? maeValues.reduce((a, b) => a + b, 0) / maeValues.length : 0;

    // Time to extremes (median)
    const validTimeMFE = timeToMFE.filter(t => t !== null);
    const medianTimeMFE = validTimeMFE.length > 0 ? validTimeMFE.sort((a,b) => a-b)[Math.floor(validTimeMFE.length/2)] : null;
    const validTimeMAE = timeToMAE.filter(t => t !== null);
    const medianTimeMAE = validTimeMAE.length > 0 ? validTimeMAE.sort((a,b) => a-b)[Math.floor(validTimeMAE.length/2)] : null;

    // Similarity quality
    const distances = states.map(s => s.distance || 0);
    const avgDist = distances.length > 0 ? distances.reduce((a, b) => a + b, 0) / distances.length : 0;
    const maxDist = distances.length > 0 ? Math.max(...distances) : 0;
    const medianDist = distances.length > 0 ? distances.sort((a,b) => a-b)[Math.floor(distances.length/2)] : 0;

    return {
      probUp,
      probDown,
      probNeutral,
      expectedMove: avgMove,
      expectedAdverse: avgAdverse,
      expectedFavorable: avgFavorable,
      mfe: avgMFE,
      mae: avgMAE,
      timeToMaxFavorable: medianTimeMFE,
      timeToMaxAdverse: medianTimeMAE,
      sampleSize: total,
      averageSimilarity: avgDist,
      maxDistance: maxDist,
      medianDistance: medianDist,
      analogues: states.map(s => ({
        distance: s.distance || 0,
        mfe: s.mfe || 0,
        mae: s.mae || 0,
        outcome: s.outcome || null,
      })),
      winRate: result.stats.winRate || 0,
      avgReturnR: result.stats.avgReturnR || 0,
    };
  }

  // ---- Existing methods ----
  async computeEdge(features, symbol = null, timeframe = 'M5', lookahead = CONFIG.DEFAULT_LOOKAHEAD, k = CONFIG.DEFAULT_K, regime = null) {
    // ... existing implementation ...
  }

  async calibrateConfidence(decision, lookahead = CONFIG.DEFAULT_LOOKAHEAD, k = CONFIG.DEFAULT_K) {
    // ... existing implementation ...
  }

  _buildCacheKey(features, symbol, timeframe, lookahead, k, regime) {
    // ... existing ...
  }

  _cleanCache() {
    // ... existing ...
  }

  invalidateCache() {
    // ... existing ...
  }

  _emptyDistribution() {
    return {
      probUp: 0.33,
      probDown: 0.33,
      probNeutral: 0.34,
      expectedMove: 0,
      expectedAdverse: 0,
      expectedFavorable: 0,
      mfe: 0,
      mae: 0,
      timeToMaxFavorable: null,
      timeToMaxAdverse: null,
      sampleSize: 0,
      averageSimilarity: 0,
      maxDistance: 0,
      medianDistance: 0,
      analogues: [],
      winRate: 0,
      avgReturnR: 0,
    };
  }

  _emptyStats() {
    return {
      count: 0,
      winRate: 0,
      avgReturnR: 0,
      medianReturnR: 0,
      p25ReturnR: 0,
      p75ReturnR: 0,
      maxWin: 0,
      maxLoss: 0,
      avgMAE: 0,
      avgMFE: 0,
      confidenceInterval: { lower: 0, upper: 0 },
      profitFactor: 0,
      maxDrawdown: 0,
    };
  }
}

// ---- Singleton ----
const stateStore = new StateStore();
module.exports = stateStore;
