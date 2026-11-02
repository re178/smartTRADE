// core/intelligence/lab/stateStore.js – Evidence Engine
// Returns raw historical evidence (candidates, distances, weighted stats).
// Preserves futurePrices, mfe, mae, timing for downstream use.
// Uses proper Effective Sample Size (ESS).
// Regime compatibility weighting.
//
// [FILE-4A] computeEdge()
// [FILE-4B] calibrateConfidence()
// [FILE-4C] avgReturnR from real outcomes (was hardcoded 0)
// [FILE-4D] findSimilar returns `stats` alias
// [FILE-4E] getSymbolVariants strips 'frx'
// [FILE-4F] qualifiedCount threshold raised to 2.0
// [FILE-4G] MIN_STATES_FOR_REFRESH lowered to 200
// [FILE-4H] loadStats logs failures
// [FILE-4I] findSimilar projection includes `confidence`
// [FILE-4J] getPredictionDistribution reads s.outcome.win
// [FILE-4K] Empty-result handling returns stats: {}
// [FILE-4.1] Per-symbol movement threshold
//
// [FIX-SS1] calibrateConfidence() is now **opt-in via CONFIG.CALIBRATION_ENABLED**
//           (default false). The historical state data in the current database
//           was produced during a broken era (InvalidSymbol failures,
//           take_profit rejections, LOW_MARKET_QUALITY rejects). Every sample
//           labeled with confidence 50-59 has outcome5.win=false, so the
//           empirical win rate in that bucket is 0%. Applying that rate to
//           the now-fixed pipeline was downgrading every healthy 55% signal
//           to 33% → NO_TRADE. The flag lets you start clean; once 7-30 days
//           of healthy trades have accumulated you can flip it on and the
//           calibration will self-correct from real data.
//
// [FIX-SS2] Sample-size-aware blending replaces hard replacement. Previously
//           the empirical rate fully replaced the caller's confidence as soon
//           as the bucket had 10+ samples (regardless of the rate's variance).
//           Now:
//             blend = min(MAX_BLEND, samples / FULL_TRUST_SAMPLES)
//           So 30 samples contribute 15% of the final value, 100 samples
//           contribute 50%, 200+ samples cap at 70%. The caller's calibrated
//           confidence never gets hijacked by a noisy 15-sample bucket.
//
// [FIX-SS3] Recency filter (CALIBRATION_WINDOW_DAYS, default 30). Only
//           samples younger than the window are used. Without this, a clean
//           pipeline running for a week would still be calibrated against
//           year-old data from the broken era.
//
// [FIX-SS4] Minimum win-rate guard (CALIBRATION_MIN_WINS = 3). If a bucket
//           has 30+ samples but fewer than 3 wins, treat the bucket as
//           "insufficient evidence" and return raw confidence rather than
//           zero. Prevents the exact failure mode we're in now even if the
//           flag is on by mistake.
//
// [FIX-SS5] Diagnostic log when calibration actually affects the result.
//           Shows: bucket, sample count, win rate, raw → calibrated,
//           blend percentage. Makes future drift debuggable from the log
//           alone without needing a DB query.
//
// [FIX-SS6] Runtime toggle methods setCalibrationEnabled(bool) and
//           getConfig() exposed for /debug endpoints. No restart required
//           to disable calibration mid-session.
//
// [FIX-SS7] All console.warn / console.log replaced with logger.warn /
//           logger.info so logs go through the configured transport and
//           respect LOG_LEVEL.
//
// [FIX-SS8] computeEdge() returns null on failure instead of a fully-zero
//           object. The decision engine's `edge && edge.sampleSize >= 20`
//           gate now correctly rejects a null edge and falls back to the
//           rule-based scorer, rather than treating a fake zero-edge as real
//           signal absence.

const HistoricalState = require('../../../models/HistoricalState');
const logger = require('../../../infrastructure/logger') || console;

// -------------------- Configuration --------------------
const CONFIG = {
  DEFAULT_K: 500,
  MAX_DISTANCE_LIMIT: 2.0,
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
  MIN_STATES_FOR_REFRESH: 200,
  GAUSSIAN_SIGMA: 0.15,
  MOVEMENT_THRESHOLD: 0.0005,
  QUALIFIED_DISTANCE_THRESHOLD: 2.0,
  MOVEMENT_THRESHOLD_PIPS: 2,

  // [FIX-SS1] Default OFF until post-fix data accumulates.
  CALIBRATION_ENABLED: false,
  // [FIX-SS3] Only use data within this many days.
  CALIBRATION_WINDOW_DAYS: 30,
  // Bucket width for confidence calibration.
  CALIBRATION_BUCKET_SIZE: 10,
  // [FIX-SS2] Minimum samples in a bucket before calibration considers it.
  CALIBRATION_MIN_SAMPLES: 30,
  // [FIX-SS4] Minimum wins — below this, bucket is treated as insufficient.
  CALIBRATION_MIN_WINS: 3,
  // [FIX-SS2] Samples needed for the blend to reach max weight.
  CALIBRATION_FULL_TRUST_SAMPLES: 200,
  // [FIX-SS2] Maximum weight the empirical rate can carry.
  CALIBRATION_MAX_BLEND: 0.70,
  // Cap on how many historical rows to pull per calibration call.
  CALIBRATION_MAX_SAMPLES: 5000,

  REGIME_WEIGHTS: {
    'STRONG_TREND_BULL':   { 'STRONG_TREND_BULL': 1.0, 'WEAK_TREND': 0.7, 'NEUTRAL': 0.5, 'STRONG_TREND_BEAR': 0.1, 'HIGH_VOLATILITY': 0.4, 'LOW_VOLATILITY': 0.6, 'RANGING': 0.3, 'BREAKOUT': 0.6, 'REVERSAL': 0.3 },
    'STRONG_TREND_BEAR':   { 'STRONG_TREND_BEAR': 1.0, 'WEAK_TREND': 0.7, 'NEUTRAL': 0.5, 'STRONG_TREND_BULL': 0.1, 'HIGH_VOLATILITY': 0.4, 'LOW_VOLATILITY': 0.6, 'RANGING': 0.3, 'BREAKOUT': 0.6, 'REVERSAL': 0.3 },
    'NEUTRAL':             { 'NEUTRAL': 1.0, 'WEAK_TREND': 0.7, 'RANGING': 0.8, 'STRONG_TREND_BULL': 0.4, 'STRONG_TREND_BEAR': 0.4, 'HIGH_VOLATILITY': 0.5, 'LOW_VOLATILITY': 0.7, 'BREAKOUT': 0.5, 'REVERSAL': 0.5 },
    'WEAK_TREND':          { 'WEAK_TREND': 1.0, 'NEUTRAL': 0.7, 'STRONG_TREND_BULL': 0.6, 'STRONG_TREND_BEAR': 0.6, 'RANGING': 0.5, 'HIGH_VOLATILITY': 0.5, 'LOW_VOLATILITY': 0.6, 'BREAKOUT': 0.5, 'REVERSAL': 0.4 },
    'RANGING':             { 'RANGING': 1.0, 'NEUTRAL': 0.8, 'WEAK_TREND': 0.5, 'LOW_VOLATILITY': 0.7, 'BREAKOUT': 0.4, 'STRONG_TREND_BULL': 0.2, 'STRONG_TREND_BEAR': 0.2, 'HIGH_VOLATILITY': 0.3, 'REVERSAL': 0.3 },
    'BREAKOUT':            { 'BREAKOUT': 1.0, 'STRONG_TREND_BULL': 0.6, 'STRONG_TREND_BEAR': 0.6, 'WEAK_TREND': 0.5, 'HIGH_VOLATILITY': 0.6, 'NEUTRAL': 0.5, 'LOW_VOLATILITY': 0.3, 'RANGING': 0.4, 'REVERSAL': 0.4 },
    'REVERSAL':            { 'REVERSAL': 1.0, 'WEAK_TREND': 0.5, 'NEUTRAL': 0.5, 'STRONG_TREND_BULL': 0.3, 'STRONG_TREND_BEAR': 0.3, 'HIGH_VOLATILITY': 0.5, 'LOW_VOLATILITY': 0.4, 'RANGING': 0.4, 'BREAKOUT': 0.4 },
    'HIGH_VOLATILITY':     { 'HIGH_VOLATILITY': 1.0, 'BREAKOUT': 0.6, 'REVERSAL': 0.5, 'STRONG_TREND_BULL': 0.4, 'STRONG_TREND_BEAR': 0.4, 'WEAK_TREND': 0.5, 'NEUTRAL': 0.5, 'LOW_VOLATILITY': 0.2, 'RANGING': 0.3 },
    'LOW_VOLATILITY':      { 'LOW_VOLATILITY': 1.0, 'RANGING': 0.7, 'NEUTRAL': 0.7, 'WEAK_TREND': 0.6, 'STRONG_TREND_BULL': 0.4, 'STRONG_TREND_BEAR': 0.4, 'HIGH_VOLATILITY': 0.2, 'BREAKOUT': 0.3, 'REVERSAL': 0.3 },
  },
};

// -------------------- Pip sizes --------------------
function getPipSize(symbol) {
  if (!symbol) return 0.0001;
  const clean = symbol.replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
  const pipMap = {
    EURUSD: 0.0001, GBPUSD: 0.0001, AUDUSD: 0.0001, NZDUSD: 0.0001,
    USDCHF: 0.0001, USDCAD: 0.0001,
    USDJPY: 0.01, EURJPY: 0.01, GBPJPY: 0.01, AUDJPY: 0.01,
    XAUUSD: 0.01, XAGUSD: 0.001,
    BTCUSD: 0.1, ETHUSD: 0.01,
  };
  return pipMap[clean] || 0.0001;
}

// -------------------- Symbol variants --------------------
function getSymbolVariants(symbol) {
  if (!symbol) return [];
  const stripped = symbol.replace(/^frx/i, '');
  const clean = stripped.replace(/[/\-_]/g, '').toUpperCase();
  const variants = new Set();
  variants.add(clean);
  if (clean.length === 6) {
    const withUnderscore = clean.slice(0, 3) + '_' + clean.slice(3);
    variants.add(withUnderscore);
    variants.add('frx' + withUnderscore);
  }
  variants.add('frx' + clean);
  variants.add(symbol.toUpperCase());
  return Array.from(variants);
}

// -------------------- Utilities --------------------
// (weightedPercentile is unused; retained for API compatibility.)
function weightedPercentile(values, weights, p) {
  if (!values.length || !weights.length || values.length !== weights.length) return 0;
  const sorted = values.map((v, i) => ({ v, w: weights[i] })).sort((a, b) => a.v - b.v);
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
    let totalStates = 0;
    try {
      totalStates = await HistoricalState.countDocuments({ 'outcome5.return': { $ne: null } });
    } catch (_) {
      totalStates = 0;
    }

    const shouldRefresh =
      !this.isLoaded ||
      forceRefresh ||
      (now - this.lastRefreshed > CONFIG.NORMALIZER_REFRESH_INTERVAL_MS) ||
      (totalStates - this.stateCountAtLastRefresh > CONFIG.MIN_STATES_FOR_REFRESH);

    if (!shouldRefresh) return;

    this._loadingPromise = (async () => {
      try {
        const pipeline = [
          { $match: { 'outcome5.return': { $ne: null } } },
          { $sample: { size: 10000 } },
          {
            $group: {
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
            },
          },
        ];

        let result = await HistoricalState.aggregate(pipeline);
        if (result.length === 0) {
          logger.warn('[StateStore] loadStats: no outcome5-labeled states yet — using default stats.');
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
          logger.info(`[StateStore] loadStats refreshed from ${totalStates} labeled states.`);
        }

        this.isLoaded = true;
        this.lastRefreshed = now;
        this.stateCountAtLastRefresh = totalStates;
      } catch (err) {
        logger.warn('[StateStore] loadStats failed:', err.message);
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
  }

  async init() {
    if (this._isReady) return;
    await this.normalizer.ensureLoaded();
    this._isReady = true;
  }

  async refreshNormalizer() {
    await this.normalizer.loadStats(true);
  }

  // ============================================================
  //  SIMILARITY SEARCH
  // ============================================================
  async findSimilar(queryFeatures, symbol = null, timeframe = 'M5',
                    k = CONFIG.DEFAULT_K, lookahead = 5,
                    regimeCode = null) {
    await this.init();

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
        },
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
              ],
            },
          },
        },
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
          trend: 1,
          momentum: 1,
          volatility: 1,
          liquidity: 1,
          structure: 1,
          session: 1,
          summary: 1,
          confidence: 1,
        },
      },
    ];

    const candidates = await HistoricalState.aggregate(pipeline);

    if (candidates.length === 0) {
      return {
        states: [],
        distanceStats: null,
        stats: {},
        candidateCount: 0,
        qualifiedCount: 0,
        effectiveSampleSize: 0,
        totalWeight: 0,
        distanceDistribution: {},
      };
    }

    const now = Date.now();
    const halfLifeMs = CONFIG.RECENCY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;
    const sigma2 = CONFIG.GAUSSIAN_SIGMA ** 2;

    const getRegimeWeight = (candidateRegime, targetRegime) => {
      if (!targetRegime || !candidateRegime) return 1.0;
      const map = CONFIG.REGIME_WEIGHTS[targetRegime];
      if (!map) return 0.5;
      return map[candidateRegime] || 0.5;
    };

    const weightedStates = candidates.map(c => {
      const ageMs = now - new Date(c.timestamp).getTime();
      const recencyWeight = Math.exp(-ageMs / halfLifeMs);
      const simWeight = Math.exp(-(c.distance ** 2) / (2 * sigma2));
      const regimeWeight = getRegimeWeight(c.regime?.code, regimeCode);
      const totalWeight = recencyWeight * simWeight * regimeWeight;
      return { ...c, recencyWeight, simWeight, regimeWeight, totalWeight };
    });

    const dists = weightedStates.map(s => s.distance);
    const minDist = Math.min(...dists);
    const maxDist = Math.max(...dists);
    const avgDist = dists.reduce((a, b) => a + b, 0) / dists.length;
    const sortedDists = [...dists].sort((a, b) => a - b);
    const medianDist = sortedDists[Math.floor(sortedDists.length / 2)];

    const totalW = weightedStates.reduce((s, c) => s + c.totalWeight, 0);
    const weightedAvgDist = totalW > 0
      ? weightedStates.reduce((s, c) => s + c.distance * c.totalWeight, 0) / totalW
      : avgDist;

    const qualified = weightedStates.filter(c => c.distance <= CONFIG.QUALIFIED_DISTANCE_THRESHOLD);

    const distBuckets = {
      '<0.1': 0, '0.1-0.2': 0, '0.2-0.3': 0, '0.3-0.5': 0,
      '0.5-1.0': 0, '1.0-2.0': 0, '>=2.0': 0,
    };
    for (const c of weightedStates) {
      if (c.distance < 0.1) distBuckets['<0.1']++;
      else if (c.distance < 0.2) distBuckets['0.1-0.2']++;
      else if (c.distance < 0.3) distBuckets['0.2-0.3']++;
      else if (c.distance < 0.5) distBuckets['0.3-0.5']++;
      else if (c.distance < 1.0) distBuckets['0.5-1.0']++;
      else if (c.distance < 2.0) distBuckets['1.0-2.0']++;
      else distBuckets['>=2.0']++;
    }

    const ess = totalW > 0
      ? totalW * totalW / weightedStates.reduce((s, c) => s + c.totalWeight * c.totalWeight, 0)
      : 0;

    const outcomeStates = weightedStates.filter(s => s.outcome && s.outcome.returnR != null);
    const totalOutcomeWeight = outcomeStates.reduce((s, c) => s + c.totalWeight, 0);

    const statsAlias = {
      count: weightedStates.length,
      outcomeCount: outcomeStates.length,
      winRate: 0,
      avgReturnR: 0,
      avgMFE: 0,
      avgMAE: 0,
      medianReturnR: 0,
      profitFactor: 0,
    };

    if (outcomeStates.length > 0 && totalOutcomeWeight > 0) {
      let winW = 0, retW = 0, mfeW = 0, maeW = 0;
      let posW = 0, negW = 0;
      const returnRs = [];
      for (const s of outcomeStates) {
        const w = s.totalWeight;
        if (s.outcome.win) winW += w;
        retW += s.outcome.returnR * w;
        if (s.mfe != null) mfeW += s.mfe * w;
        if (s.mae != null) maeW += s.mae * w;
        if (s.outcome.returnR > 0) posW += s.outcome.returnR * w;
        else negW += Math.abs(s.outcome.returnR) * w;
        returnRs.push(s.outcome.returnR);
      }
      statsAlias.winRate = winW / totalOutcomeWeight;
      statsAlias.avgReturnR = retW / totalOutcomeWeight;
      statsAlias.avgMFE = mfeW / totalOutcomeWeight;
      statsAlias.avgMAE = maeW / totalOutcomeWeight;
      statsAlias.profitFactor = negW > 0 ? (posW / negW) : (posW > 0 ? Infinity : 0);
      returnRs.sort((a, b) => a - b);
      statsAlias.medianReturnR = returnRs[Math.floor(returnRs.length / 2)];
    }

    return {
      states: weightedStates,
      distanceStats: {
        min: minDist, max: maxDist, avg: avgDist,
        median: medianDist, weightedAvg: weightedAvgDist,
      },
      stats: statsAlias,
      candidateCount: weightedStates.length,
      qualifiedCount: qualified.length,
      effectiveSampleSize: ess,
      distanceDistribution: distBuckets,
      totalWeight: totalW,
    };
  }

  // ============================================================
  //  getPredictionDistribution
  // ============================================================
  async getPredictionDistribution(features, symbol, timeframe = 'M5', lookahead = 5, k = CONFIG.DEFAULT_K, regimeCode = null) {
    await this.init();

    const result = await this.findSimilar(features, symbol, timeframe, k, lookahead, regimeCode);
    const states = result.states;
    if (!states || states.length === 0) {
      return this._emptyDistribution();
    }

    let totalValidWeight = 0;
    let upWeight = 0, downWeight = 0, neutralWeight = 0;
    let sumMove = 0, sumFavorable = 0, sumAdverse = 0;
    let sumMFE = 0, sumMAE = 0;
    let sumTimeMFE = 0, sumTimeMAE = 0;
    let sumReturnR = 0, sumWeightR = 0;

    const symbolPipSize = getPipSize(symbol || 'EURUSD');
    const moveThreshold = symbolPipSize * CONFIG.MOVEMENT_THRESHOLD_PIPS;

    for (const s of states) {
      const w = s.totalWeight;
      const entry = s.price?.current || 0;
      const futurePrices = s.futurePrices;
      if (!futurePrices || !futurePrices[lookahead] || futurePrices[lookahead].length === 0) continue;
      const lastPrice = futurePrices[lookahead][futurePrices[lookahead].length - 1];
      const move = lastPrice - entry;
      totalValidWeight += w;
      if (move > moveThreshold) upWeight += w;
      else if (move < -moveThreshold) downWeight += w;
      else neutralWeight += w;

      sumMove += move * w;
      if (move > 0) sumFavorable += move * w;
      else sumAdverse += move * w;

      if (s.mfe !== null && s.mfe !== undefined) sumMFE += s.mfe * w;
      if (s.mae !== null && s.mae !== undefined) sumMAE += s.mae * w;
      if (s.timeToMaxFavorable !== null && s.timeToMaxFavorable !== undefined) sumTimeMFE += s.timeToMaxFavorable * w;
      if (s.timeToMaxAdverse !== null && s.timeToMaxAdverse !== undefined) sumTimeMAE += s.timeToMaxAdverse * w;

      if (s.outcome?.returnR != null) {
        sumReturnR += s.outcome.returnR * w;
        sumWeightR += w;
      }
    }

    if (totalValidWeight === 0) return this._emptyDistribution();

    const probUp = upWeight / totalValidWeight;
    const probDown = downWeight / totalValidWeight;
    const probNeutral = neutralWeight / totalValidWeight;
    const expectedMove = sumMove / totalValidWeight;
    const expectedFavorable = sumFavorable / totalValidWeight;
    const expectedAdverse = sumAdverse / totalValidWeight;
    const mfe = sumMFE / totalValidWeight;
    const mae = sumMAE / totalValidWeight;
    const timeToMaxFavorable = sumTimeMFE / totalValidWeight;
    const timeToMaxAdverse = sumTimeMAE / totalValidWeight;
    const avgReturnR = sumWeightR > 0 ? sumReturnR / sumWeightR : 0;

    let winWeight = 0;
    for (const s of states) {
      if (s.outcome?.win) winWeight += s.totalWeight;
    }
    const winRate = totalValidWeight > 0 ? winWeight / totalValidWeight : 0;

    return {
      probUp,
      probDown,
      probNeutral,
      expectedMove,
      expectedFavorable,
      expectedAdverse,
      mfe,
      mae,
      timeToMaxFavorable,
      timeToMaxAdverse,
      sampleSize: states.length,
      effectiveSampleSize: result.effectiveSampleSize,
      candidateCount: result.candidateCount,
      qualifiedCount: result.qualifiedCount,
      averageDistance: result.distanceStats?.avg || 0,
      weightedAverageDistance: result.distanceStats?.weightedAvg || 0,
      maxDistance: result.distanceStats?.max || 0,
      medianDistance: result.distanceStats?.median || 0,
      distanceDistribution: result.distanceDistribution || {},
      analogues: states,
      winRate: winRate,
      avgReturnR: avgReturnR,
    };
  }

  _emptyDistribution() {
    return {
      probUp: 0.33,
      probDown: 0.33,
      probNeutral: 0.34,
      expectedMove: 0,
      expectedFavorable: 0,
      expectedAdverse: 0,
      mfe: 0,
      mae: 0,
      timeToMaxFavorable: null,
      timeToMaxAdverse: null,
      sampleSize: 0,
      effectiveSampleSize: 0,
      candidateCount: 0,
      qualifiedCount: 0,
      averageDistance: 0,
      weightedAverageDistance: 0,
      maxDistance: 0,
      medianDistance: 0,
      distanceDistribution: {},
      analogues: [],
      winRate: 0,
      avgReturnR: 0,
    };
  }

  // ============================================================
  //  [FILE-4A] computeEdge
  //  [FIX-SS8] Return null on failure so decision/engine.js correctly
  //  falls back to rule-based scoring instead of treating a zero-edge
  //  as a real signal absence.
  // ============================================================
  async computeEdge(features, symbol, timeframe = 'M5', lookahead = 5, k = CONFIG.DEFAULT_K, regimeCode = null) {
    try {
      const dist = await this.getPredictionDistribution(features, symbol, timeframe, lookahead, k, regimeCode);
      return {
        winRate: dist.winRate,
        avgReturnR: dist.avgReturnR,
        sampleSize: dist.sampleSize,
        effectiveSampleSize: dist.effectiveSampleSize,
        qualifiedCount: dist.qualifiedCount,
        candidateCount: dist.candidateCount,
        probUp: dist.probUp,
        probDown: dist.probDown,
        probNeutral: dist.probNeutral,
        expectedMove: dist.expectedMove,
        averageDistance: dist.averageDistance,
        weightedAverageDistance: dist.weightedAverageDistance,
      };
    } catch (err) {
      logger.warn('[StateStore] computeEdge failed:', err.message);
      // [FIX-SS8] null, not a fake zero-edge
      return null;
    }
  }

  // ============================================================
  //  [FIX-SS1..SS5] calibrateConfidence
  // ============================================================
  async calibrateConfidence(query, lookahead = 5, k = CONFIG.DEFAULT_K) {
    const rawConfidence = Number(query && query.confidence);

    // [FIX-SS1] Kill switch — off by default until data catches up.
    if (!CONFIG.CALIBRATION_ENABLED) {
      return {
        calibratedConfidence: rawConfidence,
        sampleSize: 0,
        bucket: null,
        disabled: true,
      };
    }

    try {
      const { symbol, timeframe = 'M5' } = query;
      if (!Number.isFinite(rawConfidence)) {
        return { calibratedConfidence: rawConfidence, sampleSize: 0, bucket: null };
      }

      // [FIX-SS3] Recency filter
      const cutoff = new Date(
        Date.now() - CONFIG.CALIBRATION_WINDOW_DAYS * 24 * 60 * 60 * 1000
      );

      const variants = getSymbolVariants(symbol || '');
      const symbolFilter = variants.length === 1
        ? { symbol: variants[0] }
        : { $or: variants.map(s => ({ symbol: s })) };

      const pipeline = [
        {
          $match: {
            ...symbolFilter,
            timeframe,
            timestamp: { $gte: cutoff },
            confidence: { $ne: null, $gte: 0 },
            [`outcome${lookahead}.win`]: { $exists: true },
          },
        },
        { $sort: { timestamp: -1 } },
        { $limit: CONFIG.CALIBRATION_MAX_SAMPLES },
        {
          $project: {
            confidence: 1,
            win: `$outcome${lookahead}.win`,
            returnR: `$outcome${lookahead}.returnR`,
          },
        },
      ];

      const docs = await HistoricalState.aggregate(pipeline);

      const bucketSize = CONFIG.CALIBRATION_BUCKET_SIZE;
      const buckets = new Map();
      for (const d of docs) {
        const b = Math.floor(d.confidence / bucketSize) * bucketSize;
        if (!buckets.has(b)) buckets.set(b, { wins: 0, total: 0 });
        const bucket = buckets.get(b);
        bucket.total++;
        if (d.win) bucket.wins++;
      }

      const queryBucket = Math.floor(rawConfidence / bucketSize) * bucketSize;
      const match = buckets.get(queryBucket);

      // [FIX-SS2] Insufficient samples
      if (!match || match.total < CONFIG.CALIBRATION_MIN_SAMPLES) {
        return {
          calibratedConfidence: rawConfidence,
          sampleSize: match?.total || 0,
          bucket: queryBucket,
          insufficientSamples: true,
        };
      }

      // [FIX-SS4] Guard against zero-win buckets (broken-era data or noise)
      if (match.wins < CONFIG.CALIBRATION_MIN_WINS) {
        logger.warn(
          `[StateStore] calibrateConfidence: bucket ${queryBucket} has ` +
          `${match.wins}/${match.total} wins — below min ${CONFIG.CALIBRATION_MIN_WINS}, ` +
          `returning raw ${rawConfidence}`
        );
        return {
          calibratedConfidence: rawConfidence,
          sampleSize: match.total,
          bucket: queryBucket,
          lowWins: true,
        };
      }

      const empiricalWinRate = match.wins / match.total;
      const empiricalConfidence = empiricalWinRate * 100;

      // [FIX-SS2] Sample-size-aware blend
      const blend = Math.min(
        CONFIG.CALIBRATION_MAX_BLEND,
        match.total / CONFIG.CALIBRATION_FULL_TRUST_SAMPLES
      );
      const calibrated = rawConfidence * (1 - blend) + empiricalConfidence * blend;

      // [FIX-SS5] Diagnostic log
      logger.info(
        `[StateStore] calibrateConfidence ${symbol}/${timeframe} bucket=${queryBucket}: ` +
        `${match.wins}/${match.total} wins (${(empiricalWinRate * 100).toFixed(1)}%), ` +
        `raw=${Math.round(rawConfidence)} → ${Math.round(calibrated)} (blend=${(blend * 100).toFixed(0)}%)`
      );

      return {
        calibratedConfidence: Math.round(calibrated),
        sampleSize: match.total,
        bucket: queryBucket,
        winRate: empiricalWinRate,
        blend,
        empiricalConfidence,
      };
    } catch (err) {
      logger.warn('[StateStore] calibrateConfidence failed:', err.message);
      return { calibratedConfidence: rawConfidence, sampleSize: 0, bucket: null };
    }
  }

  // [FIX-SS6] Runtime toggles for /debug endpoints — no restart needed.
  setCalibrationEnabled(enabled) {
    CONFIG.CALIBRATION_ENABLED = !!enabled;
    logger.info(`[StateStore] calibration ${CONFIG.CALIBRATION_ENABLED ? 'ENABLED' : 'DISABLED'}`);
    return CONFIG.CALIBRATION_ENABLED;
  }

  isCalibrationEnabled() {
    return !!CONFIG.CALIBRATION_ENABLED;
  }

  getConfig() {
    return {
      CALIBRATION_ENABLED: CONFIG.CALIBRATION_ENABLED,
      CALIBRATION_WINDOW_DAYS: CONFIG.CALIBRATION_WINDOW_DAYS,
      CALIBRATION_MIN_SAMPLES: CONFIG.CALIBRATION_MIN_SAMPLES,
      CALIBRATION_MIN_WINS: CONFIG.CALIBRATION_MIN_WINS,
      CALIBRATION_FULL_TRUST_SAMPLES: CONFIG.CALIBRATION_FULL_TRUST_SAMPLES,
      CALIBRATION_MAX_BLEND: CONFIG.CALIBRATION_MAX_BLEND,
      CALIBRATION_BUCKET_SIZE: CONFIG.CALIBRATION_BUCKET_SIZE,
    };
  }

  // ---- Cleanup ----
  _cleanCache() { /* no-op */ }
  invalidateCache() { this._edgeCache.clear(); }
}

// ---- Singleton ----
const stateStore = new StateStore();
module.exports = stateStore;
