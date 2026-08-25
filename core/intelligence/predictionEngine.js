// core/intelligence/predictionEngine.js
// Prediction Engine – Converts historical evidence into a calibrated forecast.
// Uses enhanced StateStore to retrieve analogues with path data.
// Outputs a Prediction object for use by Opportunity Engine.
// REFACTORED: Removed sample‑size confidence boost, added uncertainty metrics.
// Confidence is now a placeholder for future calibration.

const stateStore = require('./lab/stateStore');
const deepMarketState = require('./deep/marketState');
const deepRegime = require('./deep/regime');
const marketStateCache = require('../data/marketStateCache');
const { getFeatureKeys, getDefaultFeatures, normalizeFeatures } = require('../../shared/helpers');
const logger = require('../../infrastructure/logger') || console;

// ---- Symbol Normalization ----
function normalizeSymbol(sym) {
  if (!sym) return '';
  return sym.replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
}

// ---- Configuration ----
const CONFIG = {
  DEFAULT_LOOKAHEAD: 5,
  MIN_SAMPLES: 20,
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
 * @param {string} symbol - Symbol (used for fallback).
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
 * Compute prediction entropy (uncertainty) from probabilities.
 * Higher entropy = more uncertain.
 */
function calculateEntropy(probs) {
  const values = Object.values(probs).filter(p => p > 0);
  if (values.length === 0) return 1.0;
  const sum = values.reduce((a, b) => a + b, 0);
  return -values.reduce((s, p) => s + (p / sum) * Math.log(p / sum), 0) / Math.log(values.length);
}

/**
 * Compute a prediction from a market state.
 * @param {Object} state - Full market state from deepMarketState.compute().
 * @param {string} symbol - Symbol (e.g., 'EURUSD', 'frxEURUSD', etc.).
 * @param {number} lookahead - Lookahead in candles (default 5).
 * @param {number} k - Number of analogues to retrieve (default 500).
 * @returns {Promise<Object>} Prediction object.
 */
async function predict(state, symbol, lookahead = CONFIG.DEFAULT_LOOKAHEAD, k = 500) {
  console.log(`[PredictionEngine] >>> predict() called for ${symbol} (lookahead=${lookahead})`);

  try {
    // 1. Normalize symbol
    const canonicalSymbol = normalizeSymbol(symbol);
    console.log(`[PredictionEngine]   normalized symbol: ${canonicalSymbol}`);
    if (!canonicalSymbol) {
      console.warn(`[PredictionEngine] Invalid symbol: ${symbol}`);
      return null;
    }

    // 2. Extract features
    const features = extractFeatures(state);
    console.log(`[PredictionEngine]   features:`, JSON.stringify(features).slice(0, 200));

    // 3. Get regime code (for logging only – not used in query)
    const regimeCode = getRegimeCode(state, canonicalSymbol);
    console.log(`[PredictionEngine]   regime (current): ${regimeCode} (filter disabled)`);

    // 4. Call stateStore WITHOUT regime filter
    console.log(`[PredictionEngine]   calling stateStore.getPredictionDistribution (regime=null)...`);
    const distribution = await stateStore.getPredictionDistribution(
      features,
      canonicalSymbol,
      state.timeframe || 'M5',
      lookahead,
      k,
      null // <-- bypass regime filter
    );
    console.log(`[PredictionEngine]   distribution received:`, distribution ? `sampleSize=${distribution.sampleSize}, qualified=${distribution.qualifiedCount}` : 'null');

    if (!distribution || distribution.qualifiedCount < CONFIG.MIN_SAMPLES) {
      console.warn(`[PredictionEngine] Insufficient qualified samples (${distribution?.qualifiedCount || 0}) for ${canonicalSymbol}`);
      return null;
    }

    // 5. Compute probabilities (already normalized by stateStore)
    const probs = {
      up: distribution.probUp,
      down: distribution.probDown,
      neutral: distribution.probNeutral,
    };
    // Ensure they sum to 1
    const sum = probs.up + probs.down + probs.neutral;
    if (sum !== 0 && Math.abs(sum - 1) > 0.0001) {
      probs.up /= sum;
      probs.down /= sum;
      probs.neutral /= sum;
    }

    // 6. Confidence – placeholder for future calibration
    // For now, we use the raw win rate, but we do NOT apply a sample-size bonus.
    // We will calibrate this later using historical decision outcomes.
    const rawConfidence = distribution.winRate * 100;
    // TEMPORARY: just pass through raw win rate as "confidence", with a note.
    // In production, we will replace this with a calibrated value.
    const calibratedConfidence = rawConfidence; // placeholder

    // 7. Uncertainty – entropy of probabilities
    const entropy = calculateEntropy(probs);

    // 8. Confidence interval – use standard deviation of analogue returns
    const returns = distribution.analogues.map(a => a.outcome?.returnR).filter(r => r !== null && typeof r === 'number' && !isNaN(r));
    let confidenceInterval = { lower: 0, upper: 0 };
    if (returns.length > 1) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
      const half = 1.96 * std / Math.sqrt(returns.length);
      confidenceInterval = { lower: mean - half, upper: mean + half };
    }

    // 9. Build the Prediction object
    const prediction = {
      symbol: canonicalSymbol,
      timeframe: state.timeframe || 'M5',
      timestamp: new Date().toISOString(),
      regime: regimeCode,

      // Probabilities
      probabilities: probs,

      // Expected moves
      expectedMove: distribution.expectedMove || 0,
      expectedAdverse: distribution.expectedAdverse || 0,
      expectedFavorable: distribution.expectedFavorable || 0,

      // Path extremes
      mfe: distribution.mfe || 0,
      mae: distribution.mae || 0,
      timeToMaxFavorable: distribution.timeToMaxFavorable || null,
      timeToMaxAdverse: distribution.timeToMaxAdverse || null,

      // Sample & quality
      sampleSize: distribution.sampleSize || 0,
      effectiveSampleSize: distribution.effectiveSampleSize || 0,
      candidateCount: distribution.candidateCount || 0,
      qualifiedCount: distribution.qualifiedCount || 0,
      averageDistance: distribution.averageDistance || 0,
      weightedAverageDistance: distribution.weightedAverageDistance || 0,
      maxDistance: distribution.maxDistance || 0,
      medianDistance: distribution.medianDistance || 0,
      distanceDistribution: distribution.distanceDistribution || {},

      // Confidence & uncertainty
      confidence: Math.round(rawConfidence), // raw win rate
      calibratedConfidence: Math.round(calibratedConfidence), // placeholder
      predictionUncertainty: entropy, // 0 = certain, 1 = maximally uncertain
      confidenceInterval: confidenceInterval,

      // Market quality
      marketQuality: state.summary?.marketQuality || 50,
      noiseLevel: state.summary?.noiseLevel || 'medium',

      // Raw analogues (for debugging)
      analogues: distribution.analogues || [],
    };

    console.log(`[PredictionEngine] ✅ Prediction for ${canonicalSymbol}: UP=${(prediction.probabilities.up*100).toFixed(1)}%, DOWN=${(prediction.probabilities.down*100).toFixed(1)}%, NEUTRAL=${(prediction.probabilities.neutral*100).toFixed(1)}%, Qualified=${prediction.qualifiedCount}, Confidence=${prediction.confidence}%`);
    return prediction;
  } catch (err) {
    console.error(`[PredictionEngine] ❌ Error predicting for ${symbol}:`, err.message);
    console.error(err.stack);
    return null;
  }
}

/**
 * Get a NO TRADE reason based on prediction quality.
 * This is a convenience helper – Opportunity Engine will make the final decision.
 * @param {Object} prediction - Prediction object.
 * @returns {string} NO TRADE reason code.
 */
function getNoTradeReason(prediction) {
  if (!prediction) return 'LOW_SAMPLE';
  if (prediction.qualifiedCount < CONFIG.MIN_SAMPLES) return 'LOW_SAMPLE';
  if (prediction.averageDistance > 0.30) return 'POOR_SIMILARITY';
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
