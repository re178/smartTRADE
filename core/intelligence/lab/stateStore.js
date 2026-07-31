// core/intelligence/lab/stateStore.js
// Market State Store – similarity search and edge computation.
// Provides empirical edge measurement based on historical analogues.

const path = require('path');
const HistoricalState = require(path.resolve(__dirname, '../../models/HistoricalState'));
const HistoricalOutcome = require(path.resolve(__dirname, '../../models/HistoricalOutcome'));
const logger = require('../../../infrastructure/logger') || console;

// ---- Configuration ----
const CONFIG = {
  DEFAULT_SIMILARITY_K: 100,
  MAX_SIMILARITY_RESULTS: 1000,
  MIN_SIMILARITY_OVERLAP: 10,  // Minimum number of states to compute edge
  SIMILARITY_WEIGHTS: {
    adx: 1.0,
    rsi: 0.8,
    atrPercent: 0.7,
    bbWidth: 0.6,
    macdHist: 0.7,
    liquidity: 0.9,
    velocity: 0.5,
    acceleration: 0.4,
    pricePosition: 0.6,
    session: 0.3,
    trendStrength: 0.8,
    trendDirection: 0.9,
    volatilityRegime: 0.5,
    regimeCode: 0.8,
    marketQuality: 0.5,
    noiseLevel: 0.4,
  },
};

class StateStore {
  constructor() {
    this._cache = new Map(); // key → { states, timestamp }
    this._similarityCache = new Map(); // key → { results, timestamp }

    // Feature normalisation bounds (computed from data or set manually)
    this._featureBounds = {
      adx: { min: 0, max: 100 },
      rsi: { min: 0, max: 100 },
      atrPercent: { min: 0, max: 0.05 },
      bbWidth: { min: 0, max: 0.5 },
      macdHist: { min: -0.005, max: 0.005 },
      liquidity: { min: 0, max: 1 },
      velocity: { min: -0.01, max: 0.01 },
      acceleration: { min: -0.001, max: 0.001 },
      pricePosition: { min: 0, max: 1 },
      trendStrength: { min: 0, max: 100 },
      marketQuality: { min: 0, max: 100 },
    };

    logger.info('[StateStore] Initialized.');
  }

  // ============================================================
  // CORE OPERATIONS
  // ============================================================

  /**
   * Append a new state to the store (persists to DB).
   * @param {Object} state - Full MarketState object (must include symbol, timeframe, timestamp, features)
   * @returns {Promise<Object>} Saved state document.
   */
  async append(state) {
    try {
      // Ensure all required fields are present
      if (!state.symbol || !state.timeframe || !state.timestamp) {
        throw new Error('State missing required fields (symbol, timeframe, timestamp)');
      }

      // Create a HistoricalState document
      const doc = new HistoricalState({
        symbol: state.symbol,
        timeframe: state.timeframe,
        timestamp: state.timestamp,
        price: state.price || {},
        trend: state.trend || {},
        momentum: state.momentum || {},
        volatility: state.volatility || {},
        liquidity: state.liquidity || {},
        structure: state.structure || {},
        session: state.session || {},
        regime: state.regime || {},
        awareness: state.awareness || {},
        summary: state.summary || {},
        confidence: state.confidence || 50,
        reason: state.reason || '',
        source: state.source || 'live',
        version: state.version || '2.0',
      });

      await doc.save();
      // Invalidate cache for this symbol/timeframe
      this._invalidateCache(state.symbol, state.timeframe);
      return doc;
    } catch (err) {
      logger.error('[StateStore] Append error:', err.message);
      throw err;
    }
  }

  /**
   * Find similar historical states based on a query state.
   * @param {Object} query - { symbol, timeframe, features (object), k (optional) }
   * @param {number} k - Number of similar states to return.
   * @param {Object} filter - Additional filter (e.g., { source: 'live' }).
   * @returns {Promise<Array>} Array of similar states with similarity score.
   */
  async findSimilar(query, k = CONFIG.DEFAULT_SIMILARITY_K, filter = {}) {
    const { symbol, timeframe, features } = query;
    if (!features) {
      throw new Error('Query features required');
    }

    // Check cache
    const cacheKey = this._getSimilarityCacheKey(query, k, filter);
    if (this._similarityCache.has(cacheKey)) {
      const cached = this._similarityCache.get(cacheKey);
      const age = Date.now() - cached.timestamp;
      if (age < 60000) { // 1 minute cache
        return cached.results;
      }
    }

    try {
      // Build the query
      const dbFilter = { symbol, timeframe, ...filter };
      // Exclude states with no outcomes if we're computing edge
      // For similarity, we don't need outcomes, but we want states with data.
      const states = await HistoricalState.find(dbFilter)
        .sort({ timestamp: -1 })
        .limit(10000) // Reasonable limit for similarity search
        .lean();

      if (states.length === 0) {
        return [];
      }

      // Compute similarity for each state
      const results = states.map(state => {
        const similarity = this._computeSimilarity(features, state.getFeatureVector ? state.getFeatureVector() : this._extractFeatures(state));
        return { ...state, similarity };
      });

      // Sort by similarity (descending)
      results.sort((a, b) => b.similarity - a.similarity);

      // Take top k
      const top = results.slice(0, k);

      // Cache the results
      this._similarityCache.set(cacheKey, { results: top, timestamp: Date.now() });

      return top;
    } catch (err) {
      logger.error('[StateStore] findSimilar error:', err.message);
      return [];
    }
  }

  /**
   * Compute edge (expected return) from historical analogues.
   * @param {Object} query - { features, lookahead (5,10,20,40) }
   * @param {number} k - Number of analogues to use.
   * @returns {Promise<Object>} { count, winRate, avgReturnR, maxDrawdown, profitFactor, edge }
   */
  async computeEdge(query, k = CONFIG.DEFAULT_SIMILARITY_K) {
    const { features, lookahead = 5 } = query;
    if (!features) {
      throw new Error('Query features required');
    }

    // Find similar states
    const similar = await this.findSimilar({ features }, k, {});
    if (similar.length === 0 || similar.length < CONFIG.MIN_SIMILARITY_OVERLAP) {
      return {
        count: 0,
        winRate: 0,
        avgReturnR: 0,
        maxDrawdown: 0,
        profitFactor: 0,
        edge: 0,
        insufficientData: true,
      };
    }

    // Extract state IDs for outcome lookup
    const stateIds = similar.map(s => s._id);

    // Get outcomes for these states
    const outcomes = await HistoricalOutcome.getAggregatedStats(stateIds, 'state', lookahead);

    // Compute edge (expectancy): winRate * avgReturnR (assuming R = 1)
    const edge = outcomes.winRate * outcomes.avgReturnR;

    return {
      ...outcomes,
      edge,
      insufficientData: false,
    };
  }

  /**
   * Calibrate confidence based on historical outcomes.
   * @param {number} confidence - Predicted confidence (0-100).
   * @param {string} symbol - Symbol (optional).
   * @param {string} timeframe - Timeframe (optional).
   * @param {number} lookahead - Lookahead period (5,10,20,40).
   * @returns {Promise<Object>} { calibratedConfidence, calibrationError }
   */
  async calibrateConfidence(confidence, symbol, timeframe, lookahead = 5) {
    // We need historical decisions with confidence and outcome.
    // For simplicity, we'll use the aggregation from HistoricalOutcome.
    // We'll query for decisions with confidence close to this one and compute actual win rate.

    try {
      const HistoricalDecision = require('../../models/HistoricalDecision');
      // Get decisions with confidence within ±10% of the given confidence
      const lower = Math.max(0, confidence - 10);
      const upper = Math.min(100, confidence + 10);

      const filter = {
        'outcome.executed': true,
        'outcome.win': { $ne: null },
        confidence: { $gte: lower, $lte: upper },
      };
      if (symbol) filter.symbol = symbol;
      if (timeframe) filter.timeframe = timeframe;

      const decisions = await HistoricalDecision.find(filter).lean();
      if (decisions.length < 10) {
        // Not enough data – return original confidence
        return { calibratedConfidence: confidence, calibrationError: null };
      }

      const wins = decisions.filter(d => d.outcome.win === true).length;
      const total = decisions.length;
      const actualWinRate = total > 0 ? wins / total : 0.5;
      const predictedWinRate = confidence / 100;

      // Calibrate: shift confidence towards actual win rate
      // Simple approach: weighted average (more weight to actual if sample size is large)
      const sampleWeight = Math.min(1, total / 100); // up to 100 samples
      const calibrated = (1 - sampleWeight) * predictedWinRate + sampleWeight * actualWinRate;
      const calibratedConfidence = Math.round(calibrated * 100);

      return {
        calibratedConfidence,
        calibrationError: Math.abs(predictedWinRate - actualWinRate),
        sampleSize: total,
      };
    } catch (err) {
      logger.error('[StateStore] calibrateConfidence error:', err.message);
      return { calibratedConfidence: confidence, calibrationError: null };
    }
  }

  // ============================================================
  // FEATURE EXTRACTION & SIMILARITY
  // ============================================================

  /**
   * Extract feature vector from a state object.
   * @param {Object} state - HistoricalState document or plain object.
   * @returns {Object} Feature vector.
   */
  _extractFeatures(state) {
    // If state already has a getFeatureVector method, use it
    if (typeof state.getFeatureVector === 'function') {
      return state.getFeatureVector();
    }

    // Otherwise, extract from the state's fields
    return {
      adx: state.trend?.adx ?? 0,
      rsi: state.momentum?.rsi ?? 50,
      atrPercent: state.volatility?.atrPercent ?? 0,
      bbWidth: state.volatility?.bbWidth ?? 0,
      macdHist: state.momentum?.macdHist ?? 0,
      liquidity: state.liquidity?.score ?? 0.5,
      velocity: state.momentum?.velocity ?? 0,
      acceleration: state.momentum?.acceleration ?? 0,
      pricePosition: state.structure?.pricePosition ?? 0.5,
      session: state.session?.name ?? 'Other',
      sessionMultiplier: state.session?.liquidityMultiplier ?? 1,
      trendStrength: state.trend?.strength ?? 0,
      trendDirection: state.trend?.direction === 'bullish' ? 1 : (state.trend?.direction === 'bearish' ? -1 : 0),
      volatilityRegime: state.volatility?.regime ?? 'normal',
      regimeCode: state.regime?.code ?? 'NEUTRAL',
      marketQuality: state.summary?.marketQuality ?? 50,
      noiseLevel: state.summary?.noiseLevel === 'high' ? 1 : (state.summary?.noiseLevel === 'medium' ? 0.5 : 0),
    };
  }

  /**
   * Compute similarity between two feature vectors.
   * @param {Object} queryFeatures - Feature vector of the query.
   * @param {Object} stateFeatures - Feature vector of the state.
   * @returns {number} Similarity score (0-1).
   */
  _computeSimilarity(queryFeatures, stateFeatures) {
    // Normalise features
    const normQuery = this._normaliseFeatures(queryFeatures);
    const normState = this._normaliseFeatures(stateFeatures);

    // Compute weighted Euclidean distance
    const weights = CONFIG.SIMILARITY_WEIGHTS;
    let weightedDistance = 0;
    let totalWeight = 0;

    for (const [key, weight] of Object.entries(weights)) {
      if (normQuery[key] !== undefined && normState[key] !== undefined) {
        const diff = (normQuery[key] - normState[key]);
        weightedDistance += weight * diff * diff;
        totalWeight += weight;
      }
    }

    if (totalWeight === 0) return 0;

    // Normalise distance to similarity (1 - normalised distance)
    // Euclidean distance in n-dimensional space, max distance is sqrt(n)
    const n = Object.keys(weights).filter(k => normQuery[k] !== undefined && normState[k] !== undefined).length;
    const maxDistance = Math.sqrt(n);
    const euclideanDistance = Math.sqrt(weightedDistance / totalWeight);
    const similarity = Math.max(0, 1 - (euclideanDistance / maxDistance));

    return similarity;
  }

  /**
   * Normalise feature values to 0-1 range.
   * @param {Object} features - Raw feature vector.
   * @returns {Object} Normalised features.
   */
  _normaliseFeatures(features) {
    const norm = {};
    for (const [key, value] of Object.entries(features)) {
      const bounds = this._featureBounds[key];
      if (bounds) {
        const min = bounds.min;
        const max = bounds.max;
        if (max === min) {
          norm[key] = 0.5;
        } else {
          norm[key] = Math.max(0, Math.min(1, (value - min) / (max - min)));
        }
      } else {
        // For categorical features like session, we'll handle separately
        if (key === 'session') {
          // Convert to one-hot or ordinal – for simplicity, we use a numeric mapping
          const sessionMap = { Sydney: 0, Asia: 0.25, London: 0.5, NewYork: 0.75, Other: 0.5 };
          norm[key] = sessionMap[value] || 0.5;
        } else if (key === 'regimeCode') {
          // Ordinal mapping for regime
          const regimeMap = {
            STRONG_TREND_BULL: 1,
            WEAK_TREND: 0.75,
            STRONG_TREND_BEAR: 0.25,
            RANGING: 0.5,
            BREAKOUT: 0.8,
            REVERSAL: 0.6,
            HIGH_VOLATILITY: 0.4,
            LOW_VOLATILITY: 0.3,
            NEUTRAL: 0.5,
          };
          norm[key] = regimeMap[value] || 0.5;
        } else if (key === 'volatilityRegime') {
          const regMap = { high: 1, medium: 0.5, low: 0, normal: 0.5 };
          norm[key] = regMap[value] || 0.5;
        } else {
          // Unknown feature – assume 0.5
          norm[key] = 0.5;
        }
      }
    }
    return norm;
  }

  // ============================================================
  // CACHE MANAGEMENT
  // ============================================================

  _invalidateCache(symbol, timeframe) {
    const key = `${symbol}:${timeframe}`;
    this._cache.delete(key);
  }

  _getSimilarityCacheKey(query, k, filter) {
    const sortedFeatures = Object.entries(query.features).sort((a, b) => a[0].localeCompare(b[0]));
    const featureStr = sortedFeatures.map(([k, v]) => `${k}=${v}`).join('&');
    const filterStr = Object.entries(filter).sort().map(([k, v]) => `${k}=${v}`).join('&');
    return `${query.symbol}:${query.timeframe}:${k}:${featureStr}:${filterStr}`;
  }

  // ============================================================
  // BULK OPERATIONS
  // ============================================================

  /**
   * Label outcomes for all unlabelled states.
   * @param {number} lookahead - Lookahead in candles (5,10,20,40).
   * @param {number} limit - Max number of states to label.
   * @returns {Promise<number>} Number of labelled states.
   */
  async labelOutcomes(lookahead = 5, limit = 1000) {
    try {
      const HistoricalOutcome = require('../../models/HistoricalOutcome');

      // Find states without outcomes for this lookahead
      const filter = {
        [`outcome${lookahead}.return`]: null,
      };
      const states = await HistoricalState.find(filter)
        .sort({ timestamp: 1 })
        .limit(limit)
        .lean();

      if (states.length === 0) return 0;

      let labelled = 0;
      for (const state of states) {
        // Find the candle at `lookahead` candles later
        // For simplicity, we'll assume we can find the candle by timestamp.
        // In production, this should use the candleHistory to get the future price.
        // For now, we'll simulate a placeholder.
        const futurePrice = await this._getFuturePrice(state.symbol, state.timeframe, state.timestamp, lookahead);
        if (futurePrice === null) continue;

        const startPrice = state.price?.current || state.price?.close || 0;
        if (startPrice === 0) continue;

        const returnValue = futurePrice - startPrice;
        const atr = state.volatility?.atr || 0.001;
        const returnR = atr > 0 ? returnValue / atr : 0;
        const win = returnValue > 0;

        // Update the state's outcome
        const update = {
          [`outcome${lookahead}.return`]: returnValue,
          [`outcome${lookahead}.returnR`]: returnR,
          [`outcome${lookahead}.win`]: win,
          [`outcome${lookahead}.filledAt`]: new Date(),
        };

        await HistoricalState.updateOne({ _id: state._id }, { $set: update });

        // Also create an outcome document (for model training)
        const outcomeDoc = new HistoricalOutcome({
          symbol: state.symbol,
          timeframe: state.timeframe,
          stateId: state._id,
          lookahead,
          outcome: {
            return: returnValue,
            returnR,
            win,
            maxDrawdown: 0, // placeholder
            maxFavourable: 0,
            volatility: state.volatility?.atr || 0,
            endPrice: futurePrice,
            startPrice,
          },
          featuresSnapshot: this._extractFeatures(state),
          source: state.source || 'live',
          filledAt: new Date(),
        });
        await outcomeDoc.save();

        labelled++;
      }

      logger.info(`[StateStore] Labelled ${labelled} outcomes for lookahead ${lookahead}`);
      return labelled;
    } catch (err) {
      logger.error('[StateStore] labelOutcomes error:', err.message);
      return 0;
    }
  }

  /**
   * Get future price at a given lookahead (placeholder).
   * In production, this should use the candleHistory service.
   */
  async _getFuturePrice(symbol, timeframe, timestamp, lookahead) {
    // Placeholder – implement with candleHistory.
    // For now, return null.
    return null;
  }
}

// ---- Singleton ----
const stateStore = new StateStore();
module.exports = stateStore;
