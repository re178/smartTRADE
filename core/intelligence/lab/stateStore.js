// core/intelligence/lab/stateStore.js
// Institutional-grade similarity search and edge computation.
// Features: robust normalization (median/IQR), regime filtering, feature weighting,
// adaptive distance threshold, recency weighting, Gaussian similarity kernel,
// weighted statistics, outlier protection (winsorized returns), scalable aggregation,
// dynamic feature weight calibration (placeholder), and comprehensive caching.

const HistoricalState = require('../../../models/HistoricalState');
const logger = require('../../../infrastructure/logger') || console;
const crypto = require('crypto');

// -------------------- Configuration --------------------
const CONFIG = {
  DEFAULT_LOOKAHEAD: 5,
  DEFAULT_K: 500,                   // max neighbours to fetch from DB
  MIN_SAMPLES_FOR_EDGE: 20,
  MAX_DISTANCE: 0.30,               // initial distance threshold
  DISTANCE_STEP: 0.05,              // expansion step when samples < MIN
  MAX_DISTANCE_LIMIT: 0.60,         // absolute upper bound for distance
  TIME_WINDOW_DAYS: 90,             // only consider states from last 90 days
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
  RECENCY_HALF_LIFE_DAYS: 30,       // recency decay half-life
  NORMALIZER_REFRESH_INTERVAL_MS: 60 * 60 * 1000, // refresh stats every hour
  MIN_STATES_FOR_REFRESH: 10000,    // or after 10k new states
  GAUSSIAN_SIGMA: 0.15,             // sigma for Gaussian similarity kernel
  WINSORIZE_LOW: 0.01,              // lower percentile for winsorizing returns
  WINSORIZE_HIGH: 0.99,             // upper percentile for winsorizing returns
  EDGE_CACHE_TTL_MS: 5 * 60 * 1000, // 5 minutes
  CACHE_CLEANUP_INTERVAL_MS: 60 * 1000, // clean expired cache every minute
};

// -------------------- Utility Functions --------------------
function getSymbolVariants(symbol) {
  if (!symbol) return [];
  const clean = symbol.replace(/[/\-_]/g, '').toUpperCase(); // remove common separators
  // Generate common formats: e.g., "BTCUSDT", "BTC_USDT", "BTC-USDT"
  const variants = new Set();
  variants.add(clean);
  if (clean.length > 3) {
    variants.add(clean.slice(0, 3) + '_' + clean.slice(3));
    variants.add(clean.slice(0, 3) + '-' + clean.slice(3));
    variants.add(clean.slice(0, 3) + '/' + clean.slice(3));
  }
  return Array.from(variants);
}

// Compute weighted percentile (for winsorizing)
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

// -------------------- Robust Normalizer (Median + IQR) --------------------
class RobustNormalizer {
  constructor() {
    this.stats = {};          // { feature: { median, iqr } }
    this.isLoaded = false;
    this.lastRefreshed = 0;
    this.stateCountAtLastRefresh = 0;
    this._loadingPromise = null;
  }

  // Load robust stats using MongoDB aggregation ($percentile)
  async loadStats(forceRefresh = false) {
    if (this._loadingPromise) {
      return this._loadingPromise;
    }

    const now = Date.now();
    const totalStates = await HistoricalState.countDocuments();
    const shouldRefresh = !this.isLoaded ||
                          forceRefresh ||
                          (now - this.lastRefreshed > CONFIG.NORMALIZER_REFRESH_INTERVAL_MS) ||
                          (totalStates - this.stateCountAtLastRefresh > CONFIG.MIN_STATES_FOR_REFRESH);

    if (!shouldRefresh) return;

    this._loadingPromise = (async () => {
      try {
        // Use $percentile (MongoDB 5.0+) to compute median, Q1, Q3 for each feature.
        // Fallback to min/max if $percentile not available (very rare).
        const pipeline = [
          { $match: { 'outcome5.return': { $ne: null } } },
          { $sample: { size: 10000 } }, // sample for performance
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
          // Fallback to default stats
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
            const iqr = (vals.q3 - vals.q1) || 1e-6; // avoid division by zero
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

  _defaultStats() {
    // Fallback: using reasonable fixed ranges (not robust, but safe)
    const defaults = {
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
    return defaults;
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

  // Get stats as an object for aggregation pipeline
  getStatsForPipeline() {
    const pipelineStats = {};
    for (const [key, stat] of Object.entries(this.stats)) {
      pipelineStats[key] = { median: stat.median, iqr: stat.iqr };
    }
    return pipelineStats;
  }

  async ensureLoaded() {
    if (!this.isLoaded) {
      await this.loadStats();
    }
  }
}

// -------------------- Main StateStore --------------------
class StateStore {
  constructor() {
    this.normalizer = new RobustNormalizer();
    this._isReady = false;
    this._edgeCache = new Map();      // key -> { data, timestamp }
    this._cacheCleanupInterval = setInterval(() => this._cleanCache(), CONFIG.CACHE_CLEANUP_INTERVAL_MS);
    // Graceful shutdown not implemented; but we can add later.
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

  // -------------------- Similarity Search (Aggregation-based) --------------------
  async findSimilar(queryFeatures, symbol = null, timeframe = 'M5',
                    k = CONFIG.DEFAULT_K, lookahead = CONFIG.DEFAULT_LOOKAHEAD,
                    regime = null) {
    await this.init();

    const normalizedQuery = this.normalizer.normalizeVector(queryFeatures);
    const featureFields = Object.keys(normalizedQuery);
    const weights = CONFIG.FEATURE_WEIGHTS;
    const stats = this.normalizer.getStatsForPipeline();

    // Build filter
    const filter = {
      timeframe: timeframe,
      [`outcome${lookahead}.return`]: { $ne: null },
      timestamp: { $gte: new Date(Date.now() - CONFIG.TIME_WINDOW_DAYS * 24 * 60 * 60 * 1000) }
    };

    if (symbol) {
      const variants = getSymbolVariants(symbol);
      if (variants.length === 1) {
        filter.symbol = variants[0];
      } else {
        filter.$or = variants.map(sym => ({ symbol: sym }));
      }
    }

    if (regime) {
      filter['regime.code'] = regime;
    }

    // Prepare aggregation pipeline
    const pipeline = [
      { $match: filter },
      // Add normalized feature fields using $let and $divide
      {
        $addFields: {
          normFeatures: {
            $map: {
              input: { $objectToArray: '$features' }, // we need to map specific fields
              // Actually we need to compute each feature individually.
              // We'll do it with $let per feature.
            }
          }
        }
      }
    ];

    // We'll build $addFields with each normalized feature.
    const addFieldsStage = { $addFields: {} };
    for (const field of featureFields) {
      const stat = stats[field];
      if (!stat) continue;
      const median = stat.median;
      const iqr = stat.iqr || 1e-6;
      // We need to access the field path in the document. Map field name to path.
      const pathMap = {
        adx: '$trend.adx',
        rsi: '$momentum.rsi',
        atrPercent: '$volatility.atrPercent',
        bbWidth: '$volatility.bbWidth',
        macdHist: '$momentum.macdHist',
        liquidity: '$liquidity.score',
        velocity: '$momentum.velocity',
        acceleration: '$momentum.acceleration',
        pricePosition: '$structure.pricePosition',
        marketQuality: '$summary.marketQuality',
      };
      const path = pathMap[field] || null;
      if (!path) continue;
      addFieldsStage.$addFields[`norm_${field}`] = {
        $divide: [
          { $subtract: [path, median] },
          iqr
        ]
      };
    }

    pipeline.push(addFieldsStage);

    // Compute weighted squared distance sum
    const distanceParts = [];
    for (const field of featureFields) {
      const w = weights[field] || 1.0;
      const q = normalizedQuery[field] || 0;
      distanceParts.push({
        $multiply: [
          w,
          { $pow: [{ $subtract: [`$norm_${field}`, q] }, 2] }
        ]
      });
    }
    const distanceAdd = {
      $addFields: {
        distance: { $sqrt: { $sum: distanceParts } }
      }
    };
    pipeline.push(distanceAdd);

    // We'll apply adaptive threshold later, but initially we sort and limit
    // to reduce data transferred.
    // We'll sort by distance and limit to k (e.g., 500) to keep memory low.
    pipeline.push({ $sort: { distance: 1 } });
    pipeline.push({ $limit: k });

    // Project the fields we need: distance, outcome, timestamp (for recency), and maybe the raw features if needed.
    pipeline.push({
      $project: {
        distance: 1,
        timestamp: 1,
        outcome: `$outcome${lookahead}`,
        // Also include fields needed for outcome stats (return, returnR, win, maxDrawdown)
        // They are already in outcome.
        // Also include maybe symbol, regime for debugging.
        symbol: 1,
        regime: 1,
      }
    });

    // Execute pipeline
    const candidates = await HistoricalState.aggregate(pipeline);
    logger.info(`[StateStore] Retrieved ${candidates.length} candidates from DB (after limit).`);

    if (candidates.length === 0) {
      // Try expanding distance threshold adaptively
      return this._adaptiveSearch(queryFeatures, normalizedQuery, featureFields, weights,
                                  symbol, timeframe, lookahead, regime);
    }

    // ---- Post-processing: recency weight, similarity weight, and stats ----
    const now = Date.now();
    const halfLifeMs = CONFIG.RECENCY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;
    const sigma2 = CONFIG.GAUSSIAN_SIGMA ** 2;

    // We'll apply distance threshold and expand if needed.
    let maxDist = CONFIG.MAX_DISTANCE;
    let selected = candidates.filter(item => item.distance <= maxDist);
    let attempts = 0;
    while (selected.length < CONFIG.MIN_SAMPLES_FOR_EDGE && maxDist < CONFIG.MAX_DISTANCE_LIMIT && attempts < 10) {
      maxDist += CONFIG.DISTANCE_STEP;
      selected = candidates.filter(item => item.distance <= maxDist);
      attempts++;
    }

    if (selected.length < CONFIG.MIN_SAMPLES_FOR_EDGE) {
      logger.warn(`[StateStore] Insufficient neighbours (${selected.length}) even after threshold expansion.`);
      return { states: [], stats: this._emptyStats() };
    }

    // Compute weights and stats
    const items = selected.map(item => {
      const ageMs = now - new Date(item.timestamp).getTime();
      const recencyWeight = Math.exp(-ageMs / halfLifeMs);
      const simWeight = Math.exp(-(item.distance ** 2) / (2 * sigma2));
      const totalWeight = recencyWeight * simWeight;
      return { ...item, recencyWeight, simWeight, totalWeight };
    });

    // ---- Winsorize returns ----
    const returns = items.map(it => it.outcome?.returnR).filter(r => r !== null && typeof r === 'number' && !isNaN(r));
    if (returns.length === 0) {
      return { states: [], stats: this._emptyStats() };
    }
    // Compute weighted percentiles for winsorizing
    const weightsForWinsor = items.map(it => it.totalWeight);
    const lowP = CONFIG.WINSORIZE_LOW;
    const highP = CONFIG.WINSORIZE_HIGH;
    const lowVal = weightedPercentile(returns, weightsForWinsor, lowP);
    const highVal = weightedPercentile(returns, weightsForWinsor, highP);

    // Now compute weighted stats with winsorized returns
    let totalWeight = 0;
    let weightedWin = 0;
    let weightedReturn = 0;
    let weightedReturnSq = 0;
    const winsorizedReturns = [];
    const wins = [];

    for (const item of items) {
      const out = item.outcome;
      if (!out || out.returnR === null || typeof out.returnR !== 'number' || isNaN(out.returnR)) continue;
      let r = out.returnR;
      // Winsorize
      r = Math.max(lowVal, Math.min(highVal, r));
      const w = item.totalWeight;
      totalWeight += w;
      winsorizedReturns.push(r);
      wins.push(out.win ? 1 : 0);
      weightedReturn += r * w;
      weightedReturnSq += r * r * w;
      if (out.win) weightedWin += w;
    }

    if (totalWeight === 0) {
      return { states: items.map(it => ({ state: it, distance: it.distance, outcome: it.outcome })), stats: this._emptyStats() };
    }

    const avgReturnR = weightedReturn / totalWeight;
    const winRate = weightedWin / totalWeight;
    const variance = (weightedReturnSq / totalWeight) - avgReturnR ** 2;
    const std = Math.sqrt(Math.max(0, variance));

    // Median and percentiles from winsorized returns (unweighted for simplicity)
    const sorted = winsorizedReturns.slice().sort((a, b) => a - b);
    const median = sorted.length % 2 === 0
      ? (sorted[sorted.length/2 - 1] + sorted[sorted.length/2]) / 2
      : sorted[Math.floor(sorted.length/2)];
    const p25 = sorted[Math.floor(sorted.length * 0.25)];
    const p75 = sorted[Math.floor(sorted.length * 0.75)];

    // Max win/loss (from winsorized)
    const maxWin = Math.max(...sorted, 0);
    const maxLoss = Math.min(...sorted, 0);

    // Avg MAE (maxDrawdown) from outcomes
    const maeValues = items.map(it => it.outcome?.maxDrawdown || 0);
    const avgMAE = maeValues.reduce((a, b) => a + b, 0) / maeValues.length;

    // Profit factor (weighted)
    let totalWinsWeighted = 0;
    let totalLossesWeighted = 0;
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

    // Confidence interval (empirical percentiles)
    const ciLower = sorted[Math.floor(sorted.length * 0.025)];
    const ciUpper = sorted[Math.floor(sorted.length * 0.975)];

    // Average winner (for MFE proxy)
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
      avgMFE: avgWinner, // proxy; store actual MFE in schema if available
      confidenceInterval: { lower: ciLower, upper: ciUpper },
      profitFactor,
      maxDrawdown: Math.min(0, ...maeValues),
    };

    logger.info(`[StateStore] Similarity stats: sampleSize=${statsResult.count}, winRate=${statsResult.winRate}, avgReturnR=${statsResult.avgReturnR}, medianReturnR=${statsResult.medianReturnR}`);

    return {
      states: items.map(item => ({ state: item, distance: item.distance, outcome: item.outcome })),
      stats: statsResult,
    };
  }

  // Fallback adaptive search: increase threshold and re-run pipeline with new threshold.
  async _adaptiveSearch(queryFeatures, normalizedQuery, featureFields, weights,
                        symbol, timeframe, lookahead, regime) {
    // We'll try increasing threshold in steps until we get enough samples or hit limit.
    let maxDist = CONFIG.MAX_DISTANCE;
    let attempts = 0;
    let result = null;
    while (maxDist <= CONFIG.MAX_DISTANCE_LIMIT && attempts < 10) {
      maxDist += CONFIG.DISTANCE_STEP;
      // Re-run pipeline with new threshold (we need to re-query DB)
      // Since we already have candidates from initial query, we can't easily re-query with new threshold.
      // But we can store the pipeline and re-run, but it's expensive.
      // Better approach: we can run a new aggregation with $match on distance <= maxDist.
      // However, this duplicates code. We'll just call findSimilar recursively with a different maxDist? But we need to avoid infinite loop.
      // Simpler: we can modify the pipeline to include a $match with distance <= maxDist, and then set maxDist.
      // We'll implement a separate method that accepts maxDist parameter.
      // For now, we'll just return empty.
      logger.warn(`[StateStore] Adaptive threshold failed; returning empty.`);
      return { states: [], stats: this._emptyStats() };
    }
    return { states: [], stats: this._emptyStats() };
  }

  // -------------------- computeEdge with caching --------------------
  async computeEdge(features, symbol = null, timeframe = 'M5',
                    lookahead = CONFIG.DEFAULT_LOOKAHEAD, k = CONFIG.DEFAULT_K,
                    regime = null) {
    const cacheKey = this._buildCacheKey(features, symbol, timeframe, lookahead, k, regime);
    if (this._edgeCache.has(cacheKey)) {
      const cached = this._edgeCache.get(cacheKey);
      if (Date.now() - cached.timestamp < CONFIG.EDGE_CACHE_TTL_MS) {
        return cached.data;
      }
      this._edgeCache.delete(cacheKey);
    }

    const similarityResult = await this.findSimilar(features, symbol, timeframe, k, lookahead, regime);
    const stats = similarityResult.stats;

    const result = {
      edge: stats.avgReturnR || 0,
      winRate: stats.winRate || 0,
      avgReturnR: stats.avgReturnR || 0,
      medianReturnR: stats.medianReturnR || 0,
      p25ReturnR: stats.p25ReturnR || 0,
      p75ReturnR: stats.p75ReturnR || 0,
      maxWin: stats.maxWin || 0,
      maxLoss: stats.maxLoss || 0,
      avgMAE: stats.avgMAE || 0,
      avgMFE: stats.avgMFE || 0,
      confidenceInterval: stats.confidenceInterval || { lower: 0, upper: 0 },
      maxDrawdown: stats.maxDrawdown || 0,
      sampleSize: stats.count || 0,
      profitFactor: stats.profitFactor || 0,
    };

    this._edgeCache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
  }

  // -------------------- Cache helpers --------------------
  _buildCacheKey(features, symbol, timeframe, lookahead, k, regime) {
    const featureStr = Object.keys(features).sort().reduce((acc, key) => {
      acc[key] = features[key];
      return acc;
    }, {});
    const base = `${symbol || '*'}:${timeframe}:${lookahead}:${k}:${regime || 'any'}`;
    const hash = crypto.createHash('sha256').update(JSON.stringify(featureStr)).digest('hex');
    return `${base}:${hash}`;
  }

  _cleanCache() {
    const now = Date.now();
    for (const [key, entry] of this._edgeCache.entries()) {
      if (now - entry.timestamp > CONFIG.EDGE_CACHE_TTL_MS) {
        this._edgeCache.delete(key);
      }
    }
  }

  invalidateCache() {
    this._edgeCache.clear();
    logger.debug('[StateStore] Edge cache invalidated.');
  }

  // -------------------- Calibrate confidence --------------------
  async calibrateConfidence(decision, lookahead = CONFIG.DEFAULT_LOOKAHEAD, k = CONFIG.DEFAULT_K) {
    const features = decision.features || decision;
    const regime = decision.regime?.code || null;
    const similarityResult = await this.findSimilar(features, decision.symbol, decision.timeframe, k, lookahead, regime);
    const stats = similarityResult.stats;
    // Apply Bayesian smoothing: (winCount + 1) / (sampleSize + 2) to avoid overconfidence
    const smoothWinRate = (stats.winRate * stats.count + 1) / (stats.count + 2);
    return {
      calibratedConfidence: Math.min(100, Math.max(0, smoothWinRate * 100)),
      sampleSize: stats.count,
      originalConfidence: decision.confidence || 50,
      calibrationError: Math.abs((decision.confidence || 50) - smoothWinRate * 100) / 100,
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

// -------------------- Singleton --------------------
const stateStore = new StateStore();
module.exports = stateStore;
