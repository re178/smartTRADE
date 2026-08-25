// core/intelligence/predictionEngine.js – Forecast Engine
// Consumes raw evidence from StateStore, applies direction and computes
// directional‑specific favorable/adverse moves, uncertainty, and confidence.
// Preserves analogues for OpportunityEngine.

const stateStore = require('./lab/stateStore');
const logger = require('../../infrastructure/logger') || console;

// ---- Symbol Normalization ----
function normalizeSymbol(sym) {
  if (!sym) return '';
  return sym.replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
}

// ---- Configuration ----
const CONFIG = {
  DEFAULT_LOOKAHEAD: 5,
  MIN_QUALIFIED: 20,
  MIN_EFFECTIVE_SAMPLE: 15,
  MOVEMENT_THRESHOLD: 0.0005,
  // Confidence calibration placeholder – will be replaced with real calibration later
  CALIBRATION_PLACEHOLDER: true,
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
 * Get the regime code from state, with fallback to deepRegime cache.
 * @param {Object} state - Market state.
 * @param {string} symbol - Symbol (used for fallback).
 * @returns {string} Regime code.
 */
function getRegimeCode(state, symbol) {
  if (state.regime?.code) {
    return state.regime.code;
  }
  // Fallback: we could call deepRegime.getLatestRegime(symbol) if needed
  return 'NEUTRAL';
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

    // 3. Get regime code (for logging and regime weighting)
    const regimeCode = getRegimeCode(state, canonicalSymbol);
    console.log(`[PredictionEngine]   regime (current): ${regimeCode}`);

    // 4. Call StateStore (regime is passed for compatibility weighting)
    console.log(`[PredictionEngine]   calling stateStore.getPredictionDistribution...`);
    const distribution = await stateStore.getPredictionDistribution(
      features,
      canonicalSymbol,
      state.timeframe || 'M5',
      lookahead,
      k,
      regimeCode  // passed for regime weighting
    );
    console.log(`[PredictionEngine]   distribution received:`, distribution ? `sampleSize=${distribution.sampleSize}, qualified=${distribution.qualifiedCount}, ESS=${distribution.effectiveSampleSize}` : 'null');

    if (!distribution || distribution.qualifiedCount < CONFIG.MIN_QUALIFIED || distribution.effectiveSampleSize < CONFIG.MIN_EFFECTIVE_SAMPLE) {
      console.warn(`[PredictionEngine] Insufficient qualified samples (${distribution?.qualifiedCount || 0}) for ${canonicalSymbol}`);
      return null;
    }

    // 5. Compute probabilities (already normalized by StateStore)
    const probs = {
      up: distribution.probUp,
      down: distribution.probDown,
      neutral: distribution.probNeutral,
    };
    // Ensure they sum to 1 (should already, but guard against floating errors)
    const sum = probs.up + probs.down + probs.neutral;
    if (sum !== 0 && Math.abs(sum - 1) > 0.0001) {
      probs.up /= sum;
      probs.down /= sum;
      probs.neutral /= sum;
    }

    // 6. Determine direction and directional‑specific favorable/adverse moves
    let direction = 'NEUTRAL';
    let expectedFavorable = 0;
    let expectedAdverse = 0;
    let expectedMove = distribution.expectedMove || 0;

    if (probs.up > probs.down && probs.up > probs.neutral) {
      direction = 'BUY';
      // For BUY: favorable = upward moves, adverse = downward moves
      expectedFavorable = distribution.expectedFavorable;   // positive moves
      expectedAdverse = -distribution.expectedAdverse;      // negative moves converted to positive distance
      expectedMove = distribution.expectedMove; // signed move (positive)
    } else if (probs.down > probs.up && probs.down > probs.neutral) {
      direction = 'SELL';
      // For SELL: favorable = downward moves, adverse = upward moves
      expectedFavorable = -distribution.expectedAdverse;    // negative moves become favorable (positive distance)
      expectedAdverse = distribution.expectedFavorable;     // positive moves become adverse (positive distance)
      expectedMove = -distribution.expectedMove; // signed move (negative)
    } else {
      direction = 'NEUTRAL';
    }

    // 7. Confidence – placeholder for calibration
    // Use raw win rate, no sample-size boost. We'll replace with calibrated value later.
    const rawConfidence = distribution.winRate * 100; // 0-100
    // TEMPORARY: just pass through raw win rate as "confidence".
    const calibratedConfidence = rawConfidence; // placeholder

    // 8. Uncertainty – entropy
    const entropy = calculateEntropy(probs);

    // 9. Confidence interval – standard deviation of analogue returns
    const returns = distribution.analogues.map(a => a.outcome?.returnR).filter(r => r !== null && typeof r === 'number' && !isNaN(r));
    let confidenceInterval = { lower: 0, upper: 0 };
    if (returns.length > 1) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
      const half = 1.96 * std / Math.sqrt(returns.length);
      confidenceInterval = { lower: mean - half, upper: mean + half };
    }

    // 10. Build the Prediction object
    const prediction = {
      symbol: canonicalSymbol,
      timeframe: state.timeframe || 'M5',
      timestamp: new Date().toISOString(),
      regime: regimeCode,
      direction, // 'BUY', 'SELL', or 'NEUTRAL'

      // Probabilities
      probabilities: probs,

      // Expected moves (direction‑specific)
      expectedMove: expectedMove,
      expectedFavorable: expectedFavorable,
      expectedAdverse: expectedAdverse,

      // Path extremes (absolute)
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
      confidence: Math.round(rawConfidence),
      calibratedConfidence: Math.round(calibratedConfidence),
      predictionUncertainty: entropy,
      confidenceInterval: confidenceInterval,

      // Market quality
      marketQuality: state.summary?.marketQuality || 50,
      noiseLevel: state.summary?.noiseLevel || 'medium',

      // ---- CRITICAL: Preserve analogues with full data ----
      analogues: distribution.analogues || [], // contains futurePrices, mfe, mae, etc.
    };

    console.log(`[PredictionEngine] ✅ Prediction for ${canonicalSymbol}: Direction=${direction}, UP=${(prediction.probabilities.up*100).toFixed(1)}%, DOWN=${(prediction.probabilities.down*100).toFixed(1)}%, NEUTRAL=${(prediction.probabilities.neutral*100).toFixed(1)}%, Qualified=${prediction.qualifiedCount}, Confidence=${prediction.confidence}%`);
    return prediction;
  } catch (err) {
    console.error(`[PredictionEngine] ❌ Error predicting for ${symbol}:`, err.message);
    console.error(err.stack);
    return null;
  }
}

/**
 * Get a NO TRADE reason based on prediction quality.
 * This is a convenience helper – OpportunityEngine will make the final decision.
 * @param {Object} prediction - Prediction object.
 * @returns {string} NO TRADE reason code.
 */
function getNoTradeReason(prediction) {
  if (!prediction) return 'LOW_SAMPLE';
  if (prediction.qualifiedCount < CONFIG.MIN_QUALIFIED) return 'LOW_SAMPLE';
  if (prediction.effectiveSampleSize < CONFIG.MIN_EFFECTIVE_SAMPLE) return 'LOW_SAMPLE';
  if (prediction.weightedAverageDistance > 0.30) return 'POOR_SIMILARITY';
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
