// core/intelligence/predictionEngine.js – Forecast Engine
// Consumes raw evidence from StateStore, applies direction and computes
// directional-specific favorable/adverse moves, uncertainty, and confidence.
// Preserves analogues for OpportunityEngine.
//
// [FILE-5] Strategy consensus integration:
//   • predict() now accepts options.strategyConsensus (from StrategyRanker)
//   • Analogue and strategy signals vote together
//     - agree    → confidence boosted, source='combined'
//     - conflict → direction NEUTRAL, source='conflict', no trade
//     - analogue alone → source='analogue' (unchanged behavior)
//     - strategy alone → source='strategy', confidence discounted (0.8x)
//   • Returns a prediction object in all non-error cases, even when
//     direction is NEUTRAL, so the dashboard can display WHY there is
//     no trade (via modeLabel + strategyConsensus.reasons).
//   • strategyLevels (entry/stop/target from the anchor strategy)
//     included for OpportunityEngine to prefer over expectedMove-derived
//     levels when present.
//   • All existing fields preserved for backward compatibility.
//
// IMPORTANT: File 6 (opportunityEngine) must also be deployed to allow
// strategy-only predictions through the sample-size gate. Until then,
// strategy-only predictions will be rejected by opportunityEngine with
// LOW_SAMPLE_SIZE — that is the safe transitional behavior.

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
  // Minimum probability for analogue to be "directional". Below this,
  // the analogue considers the market too uncertain to bet on.
  DIRECTION_MIN_PROB: 0.40,
  CALIBRATION_MIN_SAMPLE: 10,
  MAX_CONFIDENCE: 95,
  STRATEGY_ONLY_DISCOUNT: 0.8,
  COMBINED_ANALOGUE_WEIGHT: 0.6,
  COMBINED_STRATEGY_WEIGHT: 0.4,
  FALLBACK_MOVE_THRESHOLD: 0.0005,
  DIRECTION_FALLBACK_RATIO: 0.5,
};

/**
 * Extract a flat feature vector from a market state.
 * (Unchanged from prior version.)
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
 * Get the regime code from state.
 */
function getRegimeCode(state) {
  return state?.regime?.code || 'NEUTRAL';
}

/**
 * Determine the analogue's direction from probabilities.
 * Returns 'BUY', 'SELL', or null if too uncertain.
 */
function analogueDirection(probs) {
  const maxProb = Math.max(probs.up, probs.down);
  if (maxProb < CONFIG.DIRECTION_MIN_PROB) return null;
  if (probs.up > probs.down && probs.up > probs.neutral) return 'BUY';
  if (probs.down > probs.up && probs.down > probs.neutral) return 'SELL';
  return null;
}

/**
 * Resolve the final direction from analogue + strategy votes.
 */
function resolveDirection(analogueDir, strategyDir, strategyAction) {
  // Conflict case — both present, disagree
  if (analogueDir && strategyDir && analogueDir !== strategyDir) {
    return { direction: 'NEUTRAL', source: 'conflict' };
  }
  // Both agree
  if (analogueDir && strategyDir && analogueDir === strategyDir) {
    return { direction: analogueDir, source: 'combined' };
  }
  // Analogue only
  if (analogueDir && !strategyDir) {
    return { direction: analogueDir, source: 'analogue' };
  }
  // Strategy only
  if (!analogueDir && strategyDir) {
    return { direction: strategyDir, source: 'strategy' };
  }
  // Neither
  return { direction: 'NEUTRAL', source: strategyAction === 'CONFLICT' ? 'conflict' : 'silent' };
}

/**
 * Blend confidence from analogue and strategy sources.
 * @param {number} analogueConf  — 0..100
 * @param {number} strategyConf  — 0..100
 * @param {string} source        — 'combined' | 'analogue' | 'strategy' | 'conflict' | 'silent'
 */
function resolveConfidence(analogueConf, strategyConf, source) {
  let out;
  if (source === 'combined') {
    out = analogueConf * CONFIG.COMBINED_ANALOGUE_WEIGHT
        + strategyConf * CONFIG.COMBINED_STRATEGY_WEIGHT;
  } else if (source === 'analogue') {
    out = analogueConf;
  } else if (source === 'strategy') {
    out = strategyConf * CONFIG.STRATEGY_ONLY_DISCOUNT;
  } else {
    out = 0;
  }
  return Math.round(Math.max(0, Math.min(CONFIG.MAX_CONFIDENCE, out)));
}

/**
 * Determine modeLabel for diagnostics + dashboard.
 */
function resolveModeLabel(analogueOk, strategyOk, source) {
  if (source === 'combined') return 'combined';
  if (source === 'conflict') return 'conflict';
  if (source === 'strategy') return 'strategy_only';
  if (source === 'analogue') return 'analogue_only';
  if (!analogueOk && !strategyOk) return 'no_data';
  if (!analogueOk && strategyOk) return 'strategy_only';
  if (analogueOk && !strategyOk) return 'analogue_only';
  return 'silent';
}

/**
 * Compute a prediction from a market state.
 *
 * @param {Object} state    — from deepMarketState.compute()
 * @param {string} symbol   — e.g. 'EURUSD'
 * @param {Object} [options]
 * @param {number} [options.lookahead=5]
 * @param {number} [options.k=500]
 * @param {Object} [options.strategyConsensus] — from StrategyRanker.rank()
 * @returns {Promise<Object>} — prediction object (never null except on true error)
 */
async function predict(state, symbol, options = {}) {
  try {
    const lookahead = options.lookahead || CONFIG.DEFAULT_LOOKAHEAD;
    const k = options.k || 500;
    const strategyConsensus = options.strategyConsensus || null;

    // 1. Normalize symbol
    const canonicalSymbol = normalizeSymbol(symbol);
    if (!canonicalSymbol) {
      logger.debug('[PredictionEngine] Empty symbol — skipping.');
      return null;
    }

    // 2. Extract features
    const features = extractFeatures(state);

    // 3. Regime code
    const regimeCode = getRegimeCode(state);

    // 4. Query analogue distribution
    let distribution = null;
    try {
      distribution = await stateStore.getPredictionDistribution(
        features,
        canonicalSymbol,
        state.timeframe || 'M5',
        lookahead,
        k,
        regimeCode
      );
    } catch (err) {
      logger.warn(`[PredictionEngine] StateStore query failed for ${canonicalSymbol}: ${err.message}`);
      distribution = null;
    }

    // 5. Extract strategy view from consensus (if provided)
    const strategyView = (() => {
      if (!strategyConsensus || !strategyConsensus.consensus) return null;
      const c = strategyConsensus.consensus;
      return {
        action: c.action,                    // 'SIGNAL' | 'NEUTRAL' | 'CONFLICT'
        direction: c.direction,              // 'BUY' | 'SELL' | null
        confidence: c.confidence || 0,       // 0..100
        anchorStrategy: c.anchorStrategy || null,
        anchorSignal: c.anchorSignal || null,
        agreeing: c.agreeing || [],
        conflicting: c.conflicting || [],
        reasons: c.reasons || [],
        buyWeight: c.buyWeight || 0,
        sellWeight: c.sellWeight || 0,
        activeCount: c.activeCount || 0,
        flaggedCount: c.flaggedCount || 0,
      };
    })();

    const strategyOk = strategyView && strategyView.action === 'SIGNAL' && strategyView.direction;
    const strategyDir = strategyOk ? strategyView.direction : null;

    // 6. Handle no analogue data gracefully
    //    (do NOT return null — return a NEUTRAL prediction with reason
    //     so the dashboard can show what happened)
    const hasAnalogueData = distribution &&
      distribution.sampleSize > 0 &&
      distribution.candidateCount > 0;

    const analogueSufficient = hasAnalogueData &&
      (distribution.qualifiedCount >= CONFIG.MIN_QUALIFIED) &&
      (distribution.effectiveSampleSize >= CONFIG.MIN_EFFECTIVE_SAMPLE);

    if (!hasAnalogueData && !strategyOk) {
      // Neither engine has signal
      return buildNeutralPrediction({
        symbol: canonicalSymbol,
        timeframe: state.timeframe || 'M5',
        regimeCode,
        regimeDetail: state.regime || null,
        modeLabel: 'no_data',
        reason: 'No analogue data and no strategy consensus',
        strategyView,
        marketQuality: state.summary?.marketQuality || 50,
        noiseLevel: state.summary?.noiseLevel || 'medium',
      });
    }

    // 7. Compute analogue probabilities + direction
    let probs = { up: 0.33, down: 0.33, neutral: 0.34 };
    let expectedMove = 0;
    let expectedFavorable = 0;
    let expectedAdverse = 0;
    let rawWinRate = 0.5;
    let avgReturnR = 0;
    let analogueDir = null;
    let analogues = [];
    let distQuality = {
      sampleSize: 0, effectiveSampleSize: 0, candidateCount: 0,
      qualifiedCount: 0, averageDistance: 0, weightedAverageDistance: 0,
      maxDistance: 0, medianDistance: 0, distanceDistribution: {},
    };

    if (hasAnalogueData) {
      probs = {
        up: distribution.probUp || 0,
        down: distribution.probDown || 0,
        neutral: distribution.probNeutral || 0,
      };
      const sum = probs.up + probs.down + probs.neutral;
      if (sum !== 0 && Math.abs(sum - 1) > 0.0001) {
        probs.up /= sum; probs.down /= sum; probs.neutral /= sum;
      }

      expectedMove = distribution.expectedMove || 0;
      expectedFavorable = distribution.expectedFavorable || 0;
      expectedAdverse = distribution.expectedAdverse || 0;
      rawWinRate = distribution.winRate || 0.5;
      avgReturnR = distribution.avgReturnR || 0;
      analogues = distribution.analogues || [];

      distQuality = {
        sampleSize: distribution.sampleSize || 0,
        effectiveSampleSize: distribution.effectiveSampleSize || 0,
        candidateCount: distribution.candidateCount || 0,
        qualifiedCount: distribution.qualifiedCount || 0,
        averageDistance: distribution.averageDistance || 0,
        weightedAverageDistance: distribution.weightedAverageDistance || 0,
        maxDistance: distribution.maxDistance || 0,
        medianDistance: distribution.medianDistance || 0,
        distanceDistribution: distribution.distanceDistribution || {},
      };

      // Only treat analogue as directional if it has enough data
      if (analogueSufficient) {
        analogueDir = analogueDirection(probs);
      }
    }

    // 8. Resolve final direction
    const { direction, source } = resolveDirection(
      analogueDir,
      strategyDir,
      strategyView?.action || null
    );

    // 9. Resolve confidence
    const analogueRawConf = rawWinRate * 100;
    const strategyConf = strategyView ? strategyView.confidence : 0;
    const combinedConf = resolveConfidence(analogueRawConf, strategyConf, source);

    // 10. Directional-specific favorable/adverse for the resolved direction
    let dirFavorable = 0;
    let dirAdverse = 0;
    let dirMove = 0;
    if (direction === 'BUY') {
      dirFavorable = expectedFavorable;
      dirAdverse = -expectedAdverse;
      dirMove = expectedMove;
    } else if (direction === 'SELL') {
      dirFavorable = -expectedAdverse;
      dirAdverse = expectedFavorable;
      dirMove = -expectedMove;
    }

    // 11. Calibration — only meaningful when analogue has data
    let calibratedConfidence = combinedConf;
    let calibrationSampleSize = 0;
    if (hasAnalogueData && analogueSufficient) {
      try {
        const cal = await stateStore.calibrateConfidence({
          symbol: canonicalSymbol,
          confidence: analogueRawConf,
          timeframe: state.timeframe || 'M5',
        }, lookahead, k);
        if (cal && cal.sampleSize >= CONFIG.CALIBRATION_MIN_SAMPLE) {
          calibrationSampleSize = cal.sampleSize;
          // Only apply calibration to the analogue portion, then re-blend
          const calibratedAnalogue = Math.round(analogueRawConf * 0.6 + cal.calibratedConfidence * 0.4);
          calibratedConfidence = resolveConfidence(calibratedAnalogue, strategyConf, source);
        }
      } catch (calErr) {
        logger.debug(`[PredictionEngine] Calibration failed for ${canonicalSymbol}: ${calErr.message}`);
      }
    }

    // 12. Confidence interval from analogue returnR
    const returns = analogues
      .map(a => a.outcome?.returnR)
      .filter(r => r !== null && r !== undefined && typeof r === 'number' && !isNaN(r));
    let confidenceInterval = { lower: null, upper: null };
    if (returns.length > 1) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
      const half = 1.96 * std / Math.sqrt(returns.length);
      confidenceInterval = { lower: mean - half, upper: mean + half };
    }

    // 13. modeLabel
    const modeLabel = resolveModeLabel(analogueSufficient, strategyOk, source);

    // 14. Strategy levels (entry/stop/target from the anchor signal)
    let strategyLevels = null;
    if (strategyOk && strategyView.anchorSignal) {
      const sig = strategyView.anchorSignal;
      strategyLevels = {
        entry: Number(sig.entry) || null,
        stop: Number(sig.stop) || null,
        target: Number(sig.target) || null,
      };
    }

    // 15. Build prediction
    const prediction = {
      symbol: canonicalSymbol,
      timeframe: state.timeframe || 'M5',
      timestamp: new Date().toISOString(),
      regime: regimeCode,
      regimeDetail: state.regime || null,

      direction,
      source,                          // [FILE-5] 'combined' | 'analogue' | 'strategy' | 'conflict' | 'silent'
      modeLabel,                       // [FILE-5]

      probabilities: probs,

      expectedMove: dirMove,
      expectedFavorable: dirFavorable,
      expectedAdverse: dirAdverse,

      mfe: distribution?.mfe || 0,
      mae: distribution?.mae || 0,
      timeToMaxFavorable: distribution?.timeToMaxFavorable ?? null,
      timeToMaxAdverse: distribution?.timeToMaxAdverse ?? null,

      // Quality
      sampleSize: distQuality.sampleSize,
      effectiveSampleSize: distQuality.effectiveSampleSize,
      candidateCount: distQuality.candidateCount,
      qualifiedCount: distQuality.qualifiedCount,
      averageDistance: distQuality.averageDistance,
      weightedAverageDistance: distQuality.weightedAverageDistance,
      maxDistance: distQuality.maxDistance,
      medianDistance: distQuality.medianDistance,
      distanceDistribution: distQuality.distanceDistribution,

      // Confidence
      confidence: Math.round(analogueRawConf),        // raw analogue confidence (0-100)
      calibratedConfidence,                            // blended final confidence
      calibrationSampleSize,
      predictionUncertainty: calculateEntropy(probs),
      confidenceInterval,

      marketQuality: state.summary?.marketQuality || 50,
      noiseLevel: state.summary?.noiseLevel || 'medium',

      analogues,
      winRate: rawWinRate,
      avgReturnR,

      // ---- [FILE-5] Strategy consensus snapshot ----
      strategyConsensus: strategyView ? {
        action: strategyView.action,
        direction: strategyView.direction,
        confidence: strategyView.confidence,
        anchorStrategy: strategyView.anchorStrategy,
        agreeing: strategyView.agreeing,
        conflicting: strategyView.conflicting,
        activeCount: strategyView.activeCount,
        flaggedCount: strategyView.flaggedCount,
        buyWeight: strategyView.buyWeight,
        sellWeight: strategyView.sellWeight,
        reasons: strategyView.reasons,
      } : null,

      // ---- [FILE-5] Strategy price levels (anchor signal) ----
      strategyLevels,
    };

    // 16. Log
    const logLine = `[PredictionEngine] ${canonicalSymbol} ${direction || 'NEUTRAL'} ` +
      `source=${source} conf=${calibratedConfidence}% ` +
      `analogue(q=${distQuality.qualifiedCount},ess=${distQuality.effectiveSampleSize.toFixed(1)}) ` +
      `strategy(${strategyView?.action || 'none'}${strategyDir ? '/' + strategyDir : ''} conf=${strategyConf})`;
    if (direction !== 'NEUTRAL') {
      logger.info(logLine);
    } else {
      logger.debug(logLine);
    }

    return prediction;
  } catch (err) {
    logger.warn(`[PredictionEngine] Error for ${symbol}: ${err.message}`);
    return null;
  }
}

/**
 * Build a NEUTRAL prediction when neither engine has signal.
 * Preserves the shape callers expect.
 */
function buildNeutralPrediction({
  symbol, timeframe, regimeCode, regimeDetail,
  modeLabel, reason, strategyView,
  marketQuality, noiseLevel,
}) {
  return {
    symbol,
    timeframe,
    timestamp: new Date().toISOString(),
    regime: regimeCode,
    regimeDetail: regimeDetail || null,
    direction: 'NEUTRAL',
    source: 'silent',
    modeLabel,
    reason,
    probabilities: { up: 0.33, down: 0.33, neutral: 0.34 },
    expectedMove: 0,
    expectedFavorable: 0,
    expectedAdverse: 0,
    mfe: 0, mae: 0,
    timeToMaxFavorable: null, timeToMaxAdverse: null,
    sampleSize: 0, effectiveSampleSize: 0, candidateCount: 0, qualifiedCount: 0,
    averageDistance: 0, weightedAverageDistance: 0,
    maxDistance: 0, medianDistance: 0, distanceDistribution: {},
    confidence: 0,
    calibratedConfidence: 0,
    calibrationSampleSize: 0,
    predictionUncertainty: 1.0,
    confidenceInterval: { lower: null, upper: null },
    marketQuality,
    noiseLevel,
    analogues: [],
    winRate: 0,
    avgReturnR: 0,
    strategyConsensus: strategyView ? {
      action: strategyView.action,
      direction: strategyView.direction,
      confidence: strategyView.confidence,
      anchorStrategy: strategyView.anchorStrategy,
      agreeing: strategyView.agreeing,
      conflicting: strategyView.conflicting,
      activeCount: strategyView.activeCount,
      flaggedCount: strategyView.flaggedCount,
      buyWeight: strategyView.buyWeight,
      sellWeight: strategyView.sellWeight,
      reasons: strategyView.reasons,
    } : null,
    strategyLevels: null,
  };
}

/**
 * Get a NO TRADE reason based on prediction quality.
 */
function getNoTradeReason(prediction) {
  if (!prediction) return 'LOW_SAMPLE';
  if (prediction.modeLabel === 'conflict') return 'STRATEGY_CONFLICT';
  if (prediction.modeLabel === 'no_data') return 'NO_DATA';
  if (prediction.direction === 'NEUTRAL') return 'NEUTRAL_DIRECTION';
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
