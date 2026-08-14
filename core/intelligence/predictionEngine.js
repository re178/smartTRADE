// core/intelligence/predictionEngine.js
// Prediction Engine – Converts market state into a probability distribution of future path.
// Uses enhanced StateStore to retrieve analogues with path data.
// Outputs a Prediction object for use by Opportunity Engine.

const stateStore = require('./lab/stateStore');
const deepMarketState = require('./deep/marketState');
const deepRegime = require('./deep/regime');
const marketStateCache = require('../data/marketStateCache');
const { getFeatureKeys, getDefaultFeatures, normalizeFeatures } = require('../../shared/helpers');
const logger = require('../../infrastructure/logger') || console;

// Configuration
const CONFIG = {
  // Default lookahead (candles)
  DEFAULT_LOOKAHEAD: 5,
  // Minimum analogues required for a prediction
  MIN_SAMPLES: 20,
  // Maximum distance for analogues (higher = more similar)
  MAX_SIMILARITY_DISTANCE: 0.30,
  // Threshold for UP/DOWN classification (price movement in price units)
  // For EUR/USD, 0.0005 ≈ 5 pips
  MOVEMENT_THRESHOLD: 0.0005,
};

/**
 * Extract a flat feature vector from a market state.
 * @param {Object} state - Full market state from deepMarketState.compute().
 * @returns {Object} Feature vector with numeric values.
 */
function extractFeatures(state) {
  const features = {
    adx: state.trend?.adx || 0,
    rsi: state.momentum?.rsi || 50,
    atrPercent: state.volatility?.atrPercent || 0.001,
    bbWidth: state.volatility?.bbWidth || 0.15,
    macdHist: state.momentum?.macdHist || 0,
    liquidity: state.liquidity?.score || state.awareness?.liquidity || 0.5,
    velocity: state.momentum?.velocity || state.awareness?.velocity || 0,
    acceleration: state.momentum?.acceleration || state.awareness?.acceleration || 0,
    pricePosition: state.structure?.pricePosition || 0.5,
    marketQuality: state.summary?.marketQuality || 50,
  };
  // Ensure all are numbers
  for (const key of Object.keys(features)) {
    if (typeof features[key] !== 'number' || isNaN(features[key])) {
      features[key] = 0;
    }
  }
  return features;
}

/**
 * Get the regime code from state, with fallback to deepRegime cache.
 * @param {Object} state - Market state.
 * @param {string} symbol - Symbol.
 * @returns {string} Regime code.
 */
function getRegimeCode(state, symbol) {
  if (state.regime?.code) {
    return state.regime.code;
  }
  const regime = deepRegime.getLatestRegime(symbol);
  return regime?.code || 'NEUTRAL';
}

/**
 * Compute a prediction from a market state.
 * @param {Object} state - Full market state from deepMarketState.compute().
 * @param {string} symbol - Symbol (e.g., 'EUR_USD').
 * @param {number} lookahead - Lookahead in candles (default 5).
 * @param {number} k - Number of analogues to retrieve (default 500).
 * @returns {Promise<Object>} Prediction object.
 */
async function predict(state, symbol, lookahead = CONFIG.DEFAULT_LOOKAHEAD, k = 500) {
  try {
    // 1. Extract features
    const features = extractFeatures(state);
    logger.debug(`[PredictionEngine] Features for ${symbol}:`, features);

    // 2. Get regime code
    const regimeCode = getRegimeCode(state, symbol);

    // 3. Call enhanced stateStore to get prediction distribution
    const distribution = await stateStore.getPredictionDistribution(
      features,
      symbol,
      state.timeframe || 'M5',
      lookahead,
      k,
      regimeCode
    );

    if (!distribution || distribution.sampleSize < CONFIG.MIN_SAMPLES) {
      logger.warn(`[PredictionEngine] Insufficient samples (${distribution?.sampleSize || 0}) for ${symbol}`);
      return null;
    }

    // 4. Compute calibrated confidence (if available)
    // Placeholder: we'll use the raw winRate from the distribution and adjust by sample size
    const rawConfidence = distribution.winRate * 100;
    const calibratedConfidence = Math.min(100, rawConfidence * (1 + Math.min(0.1, distribution.sampleSize / 1000)));

    // 5. Build the Prediction object
    const prediction = {
      symbol,
      timeframe: state.timeframe || 'M5',
      timestamp: new Date().toISOString(),
      regime: regimeCode,

      // Probability distribution
      probabilities: {
        up: distribution.probUp || 0.33,
        down: distribution.probDown || 0.33,
        neutral: distribution.probNeutral || 0.34,
      },

      // Expected moves
      expectedMove: distribution.expectedMove || 0,
      expectedAdverse: distribution.expectedAdverse || 0,
      expectedFavorable: distribution.expectedFavorable || 0,

      // Path statistics
      mfe: distribution.mfe || 0,
      mae: distribution.mae || 0,
      timeToMaxFavorable: distribution.timeToMaxFavorable || null,
      timeToMaxAdverse: distribution.timeToMaxAdverse || null,

      // Sample & quality
      sampleSize: distribution.sampleSize || 0,
      averageSimilarity: distribution.averageSimilarity || 0,
      maxDistance: distribution.maxDistance || 0,
      medianDistance: distribution.medianDistance || 0,

      // Confidence (raw and calibrated)
      confidence: Math.round(rawConfidence),
      calibratedConfidence: Math.round(calibratedConfidence),

      // Additional metrics
      marketQuality: state.summary?.marketQuality || 50,
      noiseLevel: state.summary?.noiseLevel || 'medium',

      // Raw analogues (optional – for debugging)
      analogues: distribution.analogues || [],
    };

    logger.info(`[PredictionEngine] Prediction for ${symbol}: UP=${(prediction.probabilities.up*100).toFixed(1)}%, DOWN=${(prediction.probabilities.down*100).toFixed(1)}%, NEUTRAL=${(prediction.probabilities.neutral*100).toFixed(1)}%, Sample=${prediction.sampleSize}`);

    return prediction;
  } catch (err) {
    logger.error(`[PredictionEngine] Error predicting for ${symbol}:`, err.message);
    return null;
  }
}

/**
 * Get a NO TRADE reason based on prediction quality.
 * @param {Object} prediction - Prediction object.
 * @returns {string} NO TRADE reason code.
 */
function getNoTradeReason(prediction) {
  if (!prediction) return 'LOW_SAMPLE';
  if (prediction.sampleSize < CONFIG.MIN_SAMPLES) return 'LOW_SAMPLE';
  if (prediction.averageSimilarity > CONFIG.MAX_SIMILARITY_DISTANCE) return 'POOR_SIMILARITY';
  if (prediction.probabilities.up < 0.50 && prediction.probabilities.down < 0.50) return 'LOW_PROBABILITY';
  if (Math.abs(prediction.expectedMove) < 0.0001) return 'LOW_EXPECTED_MOVE';
  if (prediction.mae < -0.001) return 'HIGH_MAE';
  if (prediction.marketQuality < 40) return 'LOW_MARKET_QUALITY';
  return 'NONE';
}

module.exports = {
  predict,
  extractFeatures,
  getRegimeCode,
  getNoTradeReason,
  CONFIG,
};
