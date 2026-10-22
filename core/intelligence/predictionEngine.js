// core/intelligence/predictionEngine.js – Forecast Engine
// Consumes raw evidence from StateStore, applies direction and computes
// directional-specific favorable/adverse moves, uncertainty, and confidence.
// Preserves analogues for OpportunityEngine.
//
// [FILE-5A] Real confidence calibration via stateStore.calibrateConfidence.
//   Previous version used rawConfidence as calibratedConfidence (placeholder).
// [FILE-5B] Uses real regime from state.regime.code (File 2). Previously
//   state.regime was always 'NEUTRAL', so regime weighting in stateStore
//   was uniformly uniform.
// [FILE-5C] Distinct null-return log reasons so we can diagnose where the
//   pipeline is blocked: no candidates / low qualified / low ESS.
// [FILE-5D] Direction fallback from expectedMove sign when discrete
//   probabilities are ambiguous (rare after File 4.1 threshold fix).
// [FILE-5E] confidenceInterval guards against missing outcome.returnR.
// [FILE-5F] modeLabel distinguishes 'empirical_edge', 'low_sample', 'no_data'.
// [FILE-5G] analogues array passed through untouched for opportunityEngine.
// [FILE-5H] regime + regimeDetail both returned.

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
  MOVEMENT_THRESHOLD: 0.0005,     // fallback if expectedMove-based fallback used
  // [FILE-5D] Direction fallback: expectedMove must exceed this fraction of
  // expectedAdverse before we accept a direction from move alone.
  DIRECTION_FALLBACK_RATIO: 0.5,
  // [FILE-5A] Calibration minimum sample before trusting the empirical rate.
  CALIBRATION_MIN_SAMPLE: 10,
};

/**
 * Extract a flat feature vector from a market state.
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
 */
function calculateEntropy(probs) {
  const values = Object.values(probs).filter(p => p > 0);
  if (values.length === 0) return 1.0;
  const sum = values.reduce((a, b) => a + b, 0);
  return -values.reduce((s, p) => s + (p / sum) * Math.log(p / sum), 0) / Math.log(values.length);
}

/**
 * Get the regime code from state. [FILE-5B] state.regime.code is now real.
 */
function getRegimeCode(state) {
  return state?.regime?.code || 'NEUTRAL';
}

/**
 * Compute a prediction from a market state.
 */
async function predict(state, symbol, lookahead = CONFIG.DEFAULT_LOOKAHEAD, k = 500) {
  try {
    // 1. Normalize symbol
    const canonicalSymbol = normalizeSymbol(symbol);
    if (!canonicalSymbol) {
      logger.debug('[PredictionEngine] Empty symbol — skipping.');
      return null;
    }

    // 2. Extract features
    const features = extractFeatures(state);

    // 3. Get regime code — real after File 2
    const regimeCode = getRegimeCode(state);

    // 4. Call StateStore
    const distribution = await stateStore.getPredictionDistribution(
      features,
      canonicalSymbol,
      state.timeframe || 'M5',
      lookahead,
      k,
      regimeCode
    );

    // 5. Distinct null-return diagnostics
    if (!distribution || distribution.sampleSize === 0) {
      logger.debug(
        `[PredictionEngine] ${canonicalSymbol}: no candidates ` +
        `(candidateCount=${distribution?.candidateCount ?? 0}). ` +
        `Historical data may not be labeled yet (see File 3).`
      );
      return null;
    }

    if (distribution.qualifiedCount < CONFIG.MIN_QUALIFIED) {
      logger.debug(
        `[PredictionEngine] ${canonicalSymbol}: low qualified count ` +
        `(${distribution.qualifiedCount}/${CONFIG.MIN_QUALIFIED}, ` +
        `candidateCount=${distribution.candidateCount}, ` +
        `avgDist=${distribution.averageDistance.toFixed(2)}, ` +
        `weightedAvgDist=${distribution.weightedAverageDistance.toFixed(2)}). ` +
        `Analogue pool may be too dissimilar to current state.`
      );
      return null;
    }

    if (distribution.effectiveSampleSize < CONFIG.MIN_EFFECTIVE_SAMPLE) {
      logger.debug(
        `[PredictionEngine] ${canonicalSymbol}: low effective sample ` +
        `(ESS=${distribution.effectiveSampleSize.toFixed(1)}/${CONFIG.MIN_EFFECTIVE_SAMPLE}). ` +
        `Weights too concentrated on few analogues.`
      );
      return null;
    }

    // 6. Probabilities — already normalized by StateStore
    const probs = {
      up: distribution.probUp,
      down: distribution.probDown,
      neutral: distribution.probNeutral,
    };
    const sum = probs.up + probs.down + probs.neutral;
    if (sum !== 0 && Math.abs(sum - 1) > 0.0001) {
      probs.up /= sum;
      probs.down /= sum;
      probs.neutral /= sum;
    }

    // 7. Direction determination
    let direction = 'NEUTRAL';
    let expectedFavorable = 0;
    let expectedAdverse = 0;
    let expectedMove = distribution.expectedMove || 0;

    // [FILE-5D] Primary rule: discrete probabilities
    if (probs.up > probs.down && probs.up > probs.neutral) {
      direction = 'BUY';
    } else if (probs.down > probs.up && probs.down > probs.neutral) {
      direction = 'SELL';
    } else {
      // [FILE-5D] Fallback: expectedMove magnitude vs expectedAdverse
      const absMove = Math.abs(expectedMove);
      const absAdverse = Math.abs(distribution.expectedAdverse || 0);
      const meaningfullyDirectional =
        absMove > CONFIG.MOVEMENT_THRESHOLD * 0.5 &&
        absMove > absAdverse * CONFIG.DIRECTION_FALLBACK_RATIO;

      if (meaningfullyDirectional) {
        direction = expectedMove > 0 ? 'BUY' : 'SELL';
      }
    }

    // 8. Directional-specific favorable/adverse
    if (direction === 'BUY') {
      expectedFavorable = distribution.expectedFavorable;
      expectedAdverse = -distribution.expectedAdverse;
      expectedMove = distribution.expectedMove;
    } else if (direction === 'SELL') {
      expectedFavorable = -distribution.expectedAdverse;
      expectedAdverse = distribution.expectedFavorable;
      expectedMove = -distribution.expectedMove;
    }

    // 9. [FILE-5A] Real confidence calibration
    const rawConfidence = distribution.winRate * 100;  // 0-100
    let calibratedConfidence = rawConfidence;
    let calibrationSampleSize = 0;

    try {
      const cal = await stateStore.calibrateConfidence({
        symbol: canonicalSymbol,
        confidence: rawConfidence,
        timeframe: state.timeframe || 'M5',
      }, lookahead, k);

      if (cal && cal.sampleSize >= CONFIG.CALIBRATION_MIN_SAMPLE) {
        // Blend: 60% raw win rate, 40% calibrated empirical rate
        calibratedConfidence = Math.round(rawConfidence * 0.6 + cal.calibratedConfidence * 0.4);
        calibrationSampleSize = cal.sampleSize;
      }
    } catch (calErr) {
      logger.debug(`[PredictionEngine] Calibration failed for ${canonicalSymbol}: ${calErr.message}`);
    }

    // 10. Uncertainty
    const entropy = calculateEntropy(probs);

    // 11. [FILE-5E] Confidence interval from outcome.returnR
    const returns = (distribution.analogues || [])
      .map(a => a.outcome?.returnR)
      .filter(r => r !== null && r !== undefined && typeof r === 'number' && !isNaN(r));

    let confidenceInterval = { lower: null, upper: null };
    if (returns.length > 1) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
      const half = 1.96 * std / Math.sqrt(returns.length);
      confidenceInterval = { lower: mean - half, upper: mean + half };
    }

    // 12. [FILE-5F] Mode label
    let modeLabel = 'empirical_edge';
    if (distribution.qualifiedCount < CONFIG.MIN_QUALIFIED * 2) {
      modeLabel = 'low_sample';
    }

    // 13. [FILE-5H] Regime detail from state
    const regimeDetail = state.regime ? {
      code: state.regime.code,
      name: state.regime.name,
      confidence: state.regime.confidence,
      description: state.regime.description,
    } : { code: 'NEUTRAL', name: 'Neutral / Mixed', confidence: 50, description: '' };

    // 14. Build the Prediction object
    const prediction = {
      symbol: canonicalSymbol,
      timeframe: state.timeframe || 'M5',
      timestamp: new Date().toISOString(),
      regime: regimeCode,
      regimeDetail,
      direction,

      probabilities: probs,

      expectedMove,
      expectedFavorable,
      expectedAdverse,

      mfe: distribution.mfe || 0,
      mae: distribution.mae || 0,
      timeToMaxFavorable: distribution.timeToMaxFavorable ?? null,
      timeToMaxAdverse: distribution.timeToMaxAdverse ?? null,

      sampleSize: distribution.sampleSize || 0,
      effectiveSampleSize: distribution.effectiveSampleSize || 0,
      candidateCount: distribution.candidateCount || 0,
      qualifiedCount: distribution.qualifiedCount || 0,
      averageDistance: distribution.averageDistance || 0,
      weightedAverageDistance: distribution.weightedAverageDistance || 0,
      maxDistance: distribution.maxDistance || 0,
      medianDistance: distribution.medianDistance || 0,
      distanceDistribution: distribution.distanceDistribution || {},

      confidence: Math.round(rawConfidence),
      calibratedConfidence: Math.round(calibratedConfidence),
      calibrationSampleSize,
      predictionUncertainty: entropy,
      confidenceInterval,

      marketQuality: state.summary?.marketQuality || 50,
      noiseLevel: state.summary?.noiseLevel || 'medium',

      // [FILE-5G] Analogue array preserved untouched
      analogues: distribution.analogues || [],

      // [FILE-5F] Pipeline status marker
      modeLabel,

      // Compat field for callers that still read prediction.winRate directly
      winRate: distribution.winRate,
      avgReturnR: distribution.avgReturnR,
    };

    return prediction;
  } catch (err) {
    logger.warn(`[PredictionEngine] Error for ${symbol}: ${err.message}`);
    return null;
  }
}

/**
 * Get a NO TRADE reason based on prediction quality.
 * Convenience helper — OpportunityEngine makes the final decision.
 */
function getNoTradeReason(prediction) {
  if (!prediction) return 'LOW_SAMPLE';
  if (prediction.qualifiedCount < CONFIG.MIN_QUALIFIED) return 'LOW_SAMPLE';
  if (prediction.effectiveSampleSize < CONFIG.MIN_EFFECTIVE_SAMPLE) return 'LOW_SAMPLE';
  if (prediction.weightedAverageDistance > 2.0) return 'POOR_SIMILARITY';
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
