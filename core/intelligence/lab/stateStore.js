// core/intelligence/lab/stateStore.js
// Historical state store – similarity search, edge computation, and prediction distribution.
// REFACTORED: Returns raw evidence, no forced sample-size expansion.
// Uses weighted analogues for all statistics.
// Exposes distance distribution and candidate counts.

const HistoricalState = require('../../../models/HistoricalState');
const logger = require('../../../infrastructure/logger') || console;
const crypto = require('crypto');

// -------------------- Configuration --------------------
const CONFIG = {
  DEFAULT_LOOKAHEAD: 5,
  DEFAULT_K: 500,
  MAX_DISTANCE: 1.0,          // Maximum distance for a state to be considered "close"
  MAX_DISTANCE_LIMIT: 2.0,    // Hard limit for accepting any analogue (safety)
  TIME_WINDOW_DAYS: 365,
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
  MOVEMENT_THRESHOLD: 0.0005,
};

// -------------------- Symbol Variants --------------------
function getSymbolVariants(symbol) {
  if (!symbol) return [];
  const clean = symbol.replace(/[/\-_]/g, '').toUpperCase();
  const variants = new Set();
  variants.add(clean);
  if (clean.length === 6) {
    variants.add(clean.slice(0, 3) + '_' + clean.slice(3));
    variants.add('frx' + clean.slice(0, 3) + '_' + clean.slice(3));
  }
  variants.add('frx' + clean);
  variants.add(symbol.toUpperCase());
  return Array.from(variants);
}

// -------------------- Utility Functions --------------------
function weightedPercentile(values, weights, p) {
  if (!values.length || !weights.length || values.length !== weights.length) return 0;
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

// -------------------- Robust Normalizer --------------------
class RobustNormalizer {
  constructor() {
    this.stats = this._defaultStats();
    this.isLoaded = false;
    this.lastRefreshed = 0;
    this.stateCountAtLastRefresh = 0;
    this._loadingPromise = null;
  }

  _defaultStats() {
    return {
      adx: { median: 25, iqr: 20 },
      rsi: { median: 50, iqr: 30 },
      atrPercent: { median: 0.01, iqr: 0.01 },
      bbWidth: { median: 0.1, iqr: 0.15 },
      macdHist: { median: 0, iqr: 0.005 },
      liquidity: { median: 0.5, iqr: 0.3 },
      velocity: { median: 0, iqr: 0.0005 },
      acceleration: { median: 0, iqr: 0.00005 },
      pricePosition: { median: 0.5, iqr: 0.3 },
      marketQuality: { median: 50, iqr: 30 },
    };
  }

  async loadStats(forceRefresh = false) {
    if (this._loadingPromise) return this._loadingPromise;

    const now = Date.now();
    const totalStates = await HistoricalState.countDocuments();
    const shouldRefresh = !this.isLoaded ||
                          forceRefresh ||
                          (now - this.lastRefreshed > CONFIG.NORMALIZER_REFRESH_INTERVAL_MS) ||
                          (totalStates - this.stateCountAtLastRefresh > CONFIG.MIN_STATES_FOR_REFRESH);

    if (!shouldRefresh) return;

    this._loadingPromise = (async () => {
      try {
        const pipeline = [
          { $match: { 'outcome5.return': { $ne: null } } },
          { $sample: { size: 10000 } },
          { $group: {
              _id: null,
              adx_p50: { $percentile: { p: 50, key: '$trend.adx' } },
              adx_p25: { $percentile: { p: 25, key: '$trend.adx' } },
              adx_p75: { $percentile: { p: 75, key: '$trend.adx' } },
              rsi_p50: { $percentile: { p: 50, key: '$momentum.rsi' } },
              rsi_p25: { $percentile: { p: 25, key: '$momentum.rsi' } },
              rsi_p75: { $percentile: { p: 75, key: '$momentum.rsi' } },
              atrPercent_p50: { $percentile: { p: 50, key: '$volatility.atrPercent' } },
              atrPercent_p25: { $percentile: { p: 25, key: '$volatility.atrPercent' } },
              atrPercent_p75: { $percentile: { p: 75, key: '$volatility.atrPercent' } },
              bbWidth_p50: { $percentile: { p: 50, key: '$volatility.bbWidth' } },
              bbWidth_p25: { $percentile: { p: 25, key: '$volatility.bbWidth' } },
              bbWidth_p75: { $percentile: { p: 75, key: '$volatility.bbWidth' } },
              macdHist_p50: { $percentile: { p: 50, key: '$momentum.macdHist' } },
              macdHist_p25: { $percentile: { p: 25, key: '$momentum.macdHist' } },
              macdHist_p75: { $percentile: { p: 75, key: '$momentum.macdHist' } },
              liquidity_p50: { $percentile: { p: 50, key: '$liquidity.score' } },
              liquidity_p25: { $percentile: { p: 25, key: '$liquidity.score' } },
              liquidity_p75: { $percentile: { p: 75, key: '$liquidity.score' } },
              velocity_p50: { $percentile: { p: 50, key: '$momentum.velocity' } },
              velocity_p25: { $percentile: { p: 25, key: '$momentum.velocity' } },
              velocity_p75: { $percentile: { p: 75, key: '$momentum.velocity' } },
              acceleration_p50: { $percentile: { p: 50, key: '$momentum.acceleration' } },
              acceleration_p25: { $percentile: { p: 25, key: '$momentum.acceleration' } },
              acceleration_p75: { $percentile: { p: 75, key: '$momentum.acceleration' } },
              pricePosition_p50: { $percentile: { p: 50, key: '$structure.pricePosition' } },
              pricePosition_p25: { $percentile: { p: 25, key: '$structure.pricePosition' } },
              pricePosition_p75: { $percentile: { p: 75, key: '$structure.pricePosition' } },
              marketQuality_p50: { $percentile: { p: 50, key: '$summary.marketQuality' } },
              marketQuality_p25: { $percentile: { p: 25, key: '$summary.marketQuality' } },
              marketQuality_p75: { $percentile: { p: 75, key: '$summary.marketQuality' } },
            }
          }
        ];

        let result = await HistoricalState.aggregate(pipeline);
        if (result.length === 0) {
          this.stats = this._defaultStats();
        } else {
          const s = result[0];
          const featureMap = {
            adx: { med: s.adx_p50, q1: s.adx_p25, q3: s.adx_p75 },
            rsi: { med: s.rsi_p50, q1: s.rsi_p25, q3: s.rsi_p75 },
            atrPercent: { med: s.atrPercent_p50, q1: s.atrPercent_p25, q3: s.atrPercent_p75 },
            bbWidth: { med: s.bbWidth_p50, q1: s.bbWidth_p25, q3: s.bbWidth_p75 },
            macdHist: { med: s.macdHist_p50, q1: s.macdHist_p25, q3: s.macdHist_p75 },
            liquidity: { med: s.liquidity_p50, q1: s.liquidity_p25, q3: s.liquidity_p75 },
            velocity: { med: s.velocity_p50, q1: s.velocity_p25, q3: s.velocity_p75 },
            acceleration: { med: s.acceleration_p50, q1: s.acceleration_p25, q3: s.acceleration_p75 },
            pricePosition: { med: s.pricePosition_p50, q1: s.pricePosition_p25, q3: s.pricePosition_p75 },
            marketQuality: { med: s.marketQuality_p50, q1: s.marketQuality_p25, q3: s.marketQuality_p75 },
          };
          this.stats = {};
          for (const [key, vals] of Object.entries(featureMap)) {
            const iqr = (vals.q3 - vals.q1) || 1e-6;
            this.stats[key] = { median: vals.med, iqr };
          }
        }

        this.isLoaded = true;
        this.lastRefreshed = now;
        this.stateCountAtLastRefresh = totalStates;
        logger.info('[StateStore] Robust normalizer stats refreshed (median/IQR).');
      } catch (err) {
        logger.warn('[StateStore] Failed to refresh robust stats, using defaults.', err.message);
        this.stats = this._defaultStats();
        this.isLoaded = true;
      } finally {
        this._loadingPromise = null;
      }
    })();

    return this._loadingPromise;
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
  //  SIMILARITY SEARCH – Returns raw candidates with distances
  // ============================================================
  async findSimilar(queryFeatures, symbol = null, timeframe = 'M5',
                    k = CONFIG.DEFAULT_K, lookahead = CONFIG.DEFAULT_LOOKAHEAD,
                    regime = null) {
    await this.init();

    console.log(`[StateStore] findSimilar called for ${symbol || 'any'} ${timeframe}, lookahead=${lookahead}, regime=${regime || 'any'}`);

    const normalizedQuery = this.normalizer.normalizeVector(queryFeatures);
    const weights = CONFIG.FEATURE_WEIGHTS;
    const stats = this.normalizer.getStatsForPipeline();

    const filter = {
      timeframe: timeframe,
      [`outcome${lookahead}.return`]: { $ne: null },
    };

    if (CONFIG.TIME_WINDOW_DAYS > 0) {
      filter.timestamp = { $gte: new Date(Date.now() - CONFIG.TIME_WINDOW_DAYS * 24 * 60 * 60 * 1000) };
    }

    if (symbol) {
      const variants = getSymbolVariants(symbol);
      if (variants.length === 1) filter.symbol = variants[0];
      else filter.$or = variants.map(sym => ({ symbol: sym }));
    }

    if (regime) filter['regime.code'] = regime;

    console.log(`[StateStore] Filter:`, JSON.stringify(filter, null, 2));

    const pipeline = [
      { $match: filter },
      {
        $addFields: {
          norm_adx: { $divide: [{ $subtract: ['$trend.adx', stats.adx?.median || 0] }, stats.adx?.iqr || 1e-6] },
          norm_rsi: { $divide: [{ $subtract: ['$momentum.rsi', stats.rsi?.median || 0] }, stats.rsi?.iqr || 1e-6] },
          norm_atrPercent: { $divide: [{ $subtract: ['$volatility.atrPercent', stats.atrPercent?.median || 0] }, stats.atrPercent?.iqr || 1e-6] },
          norm_bbWidth: { $divide: [{ $subtract: ['$volatility.bbWidth', stats.bbWidth?.median || 0] }, stats.bbWidth?.iqr || 1e-6] },
          norm_macdHist: { $divide: [{ $subtract: ['$momentum.macdHist', stats.macdHist?.median || 0] }, stats.macdHist?.iqr || 1e-6] },
          norm_liquidity: { $divide: [{ $subtract: ['$liquidity.score', stats.liquidity?.median || 0] }, stats.liquidity?.iqr || 1e-6] },
          norm_velocity: { $divide: [{ $subtract: ['$momentum.velocity', stats.velocity?.median || 0] }, stats.velocity?.iqr || 1e-6] },
          norm_acceleration: { $divide: [{ $subtract: ['$momentum.acceleration', stats.acceleration?.median || 0] }, stats.acceleration?.iqr || 1e-6] },
          norm_pricePosition: { $divide: [{ $subtract: ['$structure.pricePosition', stats.pricePosition?.median || 0] }, stats.pricePosition?.iqr || 1e-6] },
          norm_marketQuality: { $divide: [{ $subtract: ['$summary.marketQuality', stats.marketQuality?.median || 0] }, stats.marketQuality?.iqr || 1e-6] },
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
          price: 1,
        }
      }
    ];

    const candidates = await HistoricalState.aggregate(pipeline);
    console.log(`[StateStore] Aggregation returned ${candidates.length} candidates.`);

    if (candidates.length === 0) {
      return { states: [], distanceStats: null, candidateCount: 0, qualifiedCount: 0 };
    }

    // ---- Compute distance statistics ----
    const dists = candidates.map(c => c.distance);
    const minDist = Math.min(...dists);
    const maxDist = Math.max(...dists);
    const avgDist = dists.reduce((a, b) => a + b, 0) / dists.length;
    const sortedDists = [...dists].sort((a, b) => a - b);
    const medianDist = sortedDists[Math.floor(sortedDists.length / 2)];

    // Weighted average using recency*similarity
    const now = Date.now();
    const halfLifeMs = CONFIG.RECENCY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;
    const sigma2 = CONFIG.GAUSSIAN_SIGMA ** 2;
    let weightedSum = 0, totalWeight = 0;
    for (const c of candidates) {
      const ageMs = now - new Date(c.timestamp).getTime();
      const recencyWeight = Math.exp(-ageMs / halfLifeMs);
      const simWeight = Math.exp(-(c.distance ** 2) / (2 * sigma2));
      const w = recencyWeight * simWeight;
      weightedSum += c.distance * w;
      totalWeight += w;
    }
    const weightedAvgDist = totalWeight > 0 ? weightedSum / totalWeight : avgDist;

    // ---- Count close analogues (distance <= MAX_DISTANCE) ----
    const qualified = candidates.filter(c => c.distance <= CONFIG.MAX_DISTANCE);

    console.log(`[StateStore] Distance stats: min=${minDist.toFixed(4)}, max=${maxDist.toFixed(4)}, avg=${avgDist.toFixed(4)}, median=${medianDist.toFixed(4)}, weightedAvg=${weightedAvgDist.toFixed(4)}, qualified=${qualified.length}`);

    return {
      states: candidates, // all candidates
      distanceStats: {
        min: minDist,
        max: maxDist,
        avg: avgDist,
        median: medianDist,
        weightedAvg: weightedAvgDist,
        distribution: {
          '< 0.1': candidates.filter(c => c.distance < 0.1).length,
          '0.1-0.2': candidates.filter(c => c.distance >= 0.1 && c.distance < 0.2).length,
          '0.2-0.3': candidates.filter(c => c.distance >= 0.2 && c.distance < 0.3).length,
          '0.3-0.5': candidates.filter(c => c.distance >= 0.3 && c.distance < 0.5).length,
          '0.5-1.0': candidates.filter(c => c.distance >= 0.5 && c.distance < 1.0).length,
          '>=1.0': candidates.filter(c => c.distance >= 1.0).length,
        }
      },
      candidateCount: candidates.length,
      qualifiedCount: qualified.length,
    };
  }

  // ============================================================
  //  PREDICTION DISTRIBUTION – Weighted Evidence
  // ============================================================
  async getPredictionDistribution(features, symbol, timeframe = 'M5', lookahead = CONFIG.DEFAULT_LOOKAHEAD, k = CONFIG.DEFAULT_K, regime = null) {
    await this.init();

    const similarityResult = await this.findSimilar(features, symbol, timeframe, k, lookahead, regime);
    const candidates = similarityResult.states;
    if (candidates.length === 0) {
      return this._emptyDistribution();
    }

    // ---- Compute weights ----
    const now = Date.now();
    const halfLifeMs = CONFIG.RECENCY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;
    const sigma2 = CONFIG.GAUSSIAN_SIGMA ** 2;

    const weightedStates = candidates.map(c => {
      const ageMs = now - new Date(c.timestamp).getTime();
      const recencyWeight = Math.exp(-ageMs / halfLifeMs);
      const simWeight = Math.exp(-(c.distance ** 2) / (2 * sigma2));
      const totalWeight = recencyWeight * simWeight;
      return { ...c, recencyWeight, simWeight, totalWeight };
    });

    // ---- Weighted statistics ----
    let totalWeight = 0;
    let weightedWin = 0;
    let weightedReturnR = 0;
    let weightedReturn = 0;
    let weightedMFE = 0;
    let weightedMAE = 0;
    let weightedTimeMFE = 0;
    let weightedTimeMAE = 0;

    const upMoves = [], downMoves = [], neutralMoves = [];
    let total = 0;

    for (const s of weightedStates) {
      const w = s.totalWeight;
      totalWeight += w;

      // Outcome
      const out = s.outcome;
      if (out && out.returnR !== null && typeof out.returnR === 'number' && !isNaN(out.returnR)) {
        weightedReturnR += out.returnR * w;
        if (out.win) weightedWin += w;
        // Return in price units
        if (out.return !== null) weightedReturn += out.return * w;
      }

      // MFE/MAE
      if (s.mfe !== null) weightedMFE += s.mfe * w;
      if (s.mae !== null) weightedMAE += s.mae * w;

      // Timing
      if (s.timeToMaxFavorable !== null) weightedTimeMFE += s.timeToMaxFavorable * w;
      if (s.timeToMaxAdverse !== null) weightedTimeMAE += s.timeToMaxAdverse * w;

      // Direction counts (using futurePrices, same as before)
      const entry = s.price?.current || 0;
      const futurePrices = s.futurePrices || {};
      if (futurePrices[lookahead] && futurePrices[lookahead].length > 0) {
        const lastPrice = futurePrices[lookahead][futurePrices[lookahead].length - 1];
        const move = lastPrice - entry;
        const threshold = CONFIG.MOVEMENT_THRESHOLD;
        if (move > threshold) upMoves.push({ move, weight: w });
        else if (move < -threshold) downMoves.push({ move, weight: w });
        else neutralMoves.push({ move, weight: w });
        total++;
      }
    }

    // ---- Probabilities ----
    const probUp = upMoves.reduce((sum, m) => sum + m.weight, 0) / totalWeight;
    const probDown = downMoves.reduce((sum, m) => sum + m.weight, 0) / totalWeight;
    const probNeutral = neutralMoves.reduce((sum, m) => sum + m.weight, 0) / totalWeight;

    // ---- Expected moves (weighted) ----
    const allMoves = [...upMoves, ...downMoves, ...neutralMoves];
    let expectedMove = 0, expectedAdverse = 0, expectedFavorable = 0;
    if (allMoves.length > 0) {
      const weightedSum = allMoves.reduce((sum, m) => sum + m.move * m.weight, 0);
      expectedMove = weightedSum / totalWeight;
      const adverse = allMoves.filter(m => m.move < 0);
      const favorable = allMoves.filter(m => m.move > 0);
      if (adverse.length > 0) {
        const wSum = adverse.reduce((sum, m) => sum + m.weight, 0);
        expectedAdverse = adverse.reduce((sum, m) => sum + m.move * m.weight, 0) / wSum;
      }
      if (favorable.length > 0) {
        const wSum = favorable.reduce((sum, m) => sum + m.weight, 0);
        expectedFavorable = favorable.reduce((sum, m) => sum + m.move * m.weight, 0) / wSum;
      }
    }

    // ---- MFE/MAE (weighted) ----
    const avgMFE = totalWeight > 0 ? weightedMFE / totalWeight : 0;
    const avgMAE = totalWeight > 0 ? weightedMAE / totalWeight : 0;

    // ---- Timing (weighted median) ----
    const timeMFEValues = weightedStates.map(s => s.timeToMaxFavorable).filter(t => t !== null);
    const timeMAEValues = weightedStates.map(s => s.timeToMaxAdverse).filter(t => t !== null);
    const medianTimeMFE = timeMFEValues.length > 0 ? timeMFEValues.sort((a,b) => a-b)[Math.floor(timeMFEValues.length/2)] : null;
    const medianTimeMAE = timeMAEValues.length > 0 ? timeMAEValues.sort((a,b) => a-b)[Math.floor(timeMAEValues.length/2)] : null;

    // ---- Win rate & returnR ----
    const winRate = totalWeight > 0 ? weightedWin / totalWeight : 0;
    const avgReturnR = totalWeight > 0 ? weightedReturnR / totalWeight : 0;

    // ---- Build distribution ----
    return {
      // Probabilities
      probUp,
      probDown,
      probNeutral,

      // Expected moves
      expectedMove,
      expectedAdverse,
      expectedFavorable,

      // Path extremes
      mfe: avgMFE,
      mae: avgMAE,

      // Timing
      timeToMaxFavorable: medianTimeMFE,
      timeToMaxAdverse: medianTimeMAE,

      // Sample & quality
      sampleSize: weightedStates.length,
      effectiveSampleSize: Math.min(weightedStates.length, Math.round(totalWeight)), // approximate effective sample
      candidateCount: similarityResult.candidateCount,
      qualifiedCount: similarityResult.qualifiedCount,
      averageDistance: similarityResult.distanceStats?.avg || 0,
      maxDistance: similarityResult.distanceStats?.max || 0,
      medianDistance: similarityResult.distanceStats?.median || 0,
      weightedAverageDistance: similarityResult.distanceStats?.weightedAvg || 0,
      distanceDistribution: similarityResult.distanceStats?.distribution || {},

      // Outcomes
      winRate,
      avgReturnR,

      // Raw analogues (for debugging)
      analogues: weightedStates.map(s => ({
        distance: s.distance,
        mfe: s.mfe,
        mae: s.mae,
        outcome: s.outcome,
        timestamp: s.timestamp,
        weight: s.totalWeight,
      })),
    };
  }

  // ---- Existing methods (placeholder) ----
  async computeEdge(features, symbol = null, timeframe = 'M5', lookahead = CONFIG.DEFAULT_LOOKAHEAD, k = CONFIG.DEFAULT_K, regime = null) {
    // ... (keep existing, but could call getPredictionDistribution and extract edge)
  }

  async calibrateConfidence(decision, lookahead = CONFIG.DEFAULT_LOOKAHEAD, k = CONFIG.DEFAULT_K) {
    // ... (keep existing)
  }

  _buildCacheKey(features, symbol, timeframe, lookahead, k, regime) {
    // ... (keep existing)
  }

  _cleanCache() {
    // ... (keep existing)
  }

  invalidateCache() {
    this._edgeCache.clear();
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
      effectiveSampleSize: 0,
      candidateCount: 0,
      qualifiedCount: 0,
      averageDistance: 0,
      maxDistance: 0,
      medianDistance: 0,
      weightedAverageDistance: 0,
      distanceDistribution: {},
      winRate: 0,
      avgReturnR: 0,
      analogues: [],
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
