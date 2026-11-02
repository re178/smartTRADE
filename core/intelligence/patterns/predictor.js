// core/intelligence/patterns/predictor.js
// Real-time prediction. Combines:
//   • Candle pattern report
//   • Momentum
//   • Volatility state
//   • Strategy consensus (from ranker)
//   • Current regime
// Returns a prediction with direction + confidence + reasons + levels.
// NO historical data. NO k-NN. NO analogues.
// Output is compatible with opportunityEngine + dashboard.
//
// [FIX-P1] Confidence output no longer inherits the vote-tally discount.
//          Before: strategy fired at 55% → votes got 55 × 0.6 = 33 →
//          direction=SELL (33 > 30 gate) → confidence=33 → rejected by
//          opportunityEngine's MIN_CONFIDENCE=55. Every strategy-only
//          signal was silently halved. Now: when strategy agrees with the
//          computed direction, strategyConfidence is the base — the same
//          number the ranker calibrated. Confirming pattern/momentum add
//          small boosts; strong disagreement applies mild penalties. This
//          is the exact source of GBPUSD 55 → 33, USDJPY 55 → 31,
//          AUDUSD 55 → 33 in the log.
// [FIX-P2] One INFO log per emitted signal so the pipeline can be traced.
//          Shows direction, final confidence, source, and each contributor.
// [FIX-P3] Defensive candle-close getter. Broker returns {mid:{o,h,l,c}},
//          other modules may return {close}/{c}. The predictor now
//          tolerates all three shapes instead of `candles[last].close`
//          silently becoming undefined.
// [FIX-P4] Guard strategyLevels generation on entryPrice > 0. If candle
//          extraction fails, we no longer emit NaN levels that propagate
//          to opportunityEngine and trigger a downstream crash path.

'use strict';

const candleHistory = require('../../data/candleHistory');
const candlePatterns = require('./candlePatterns');
const logger = require('../../../infrastructure/logger') || console;

const TF_SECONDS = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 };

function normalizeSymbol(s) {
  return String(s || '').replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
}

// [FIX-P3] Tolerant candle-close extraction. Supports the three shapes
// seen across this codebase:
//   • broker.getCandles →   { mid: { o, h, l, c }, time, complete }
//   • candleHistory may   →  { open, high, low, close }  or  { o,h,l,c }
function extractClose(candle) {
  if (!candle || typeof candle !== 'object') return null;
  if (typeof candle.close === 'number' && Number.isFinite(candle.close)) return candle.close;
  if (typeof candle.c === 'number' && Number.isFinite(candle.c)) return candle.c;
  if (candle.mid && typeof candle.mid.c === 'number' && Number.isFinite(candle.mid.c)) return candle.mid.c;
  return null;
}

function oppositeBias(bias) {
  if (bias === 'BULLISH') return 'BEARISH';
  if (bias === 'BEARISH') return 'BULLISH';
  return null;
}

/**
 * predict(symbol, state, strategyConsensus, options)
 *
 * @param {string} symbol
 * @param {Object} state — deepMarketState output
 * @param {Object} strategyConsensus — from ranker.rank()
 * @param {Object} options — { timeframe }
 * @returns {Promise<Object>} prediction object
 */
async function predict(symbol, state, strategyConsensus = null, options = {}) {
  const timeframe = options.timeframe || state?.timeframe || 'M5';
  const canonical = normalizeSymbol(symbol);
  const tfSec = TF_SECONDS[timeframe] || 300;

  // ---- 1. Load recent candles ----
  let candles = [];
  try {
    candles = await candleHistory.getHistory(canonical, timeframe, 120);
  } catch (err) {
    logger.warn(`[Predictor] candle fetch failed for ${canonical}: ${err.message}`);
  }
  if (!candles || candles.length < 20) {
    return _neutral(canonical, timeframe, 'Insufficient candles');
  }

  // ---- 2. Pattern / momentum / volatility ----
  const pattern = candlePatterns.analyze(candles);
  const momentum = candlePatterns.momentum(candles, 5);
  const vol = candlePatterns.volatility(candles, 14);

  // ---- 3. Strategy consensus ----
  const strategyDirection = strategyConsensus?.consensus?.direction || null;
  const strategyConfidence = strategyConsensus?.consensus?.confidence || 0;
  const strategyAction = strategyConsensus?.consensus?.action || 'NEUTRAL';
  const agreeing = strategyConsensus?.consensus?.agreeing || [];
  const conflicting = strategyConsensus?.consensus?.conflicting || [];
  const anchorStrategy = strategyConsensus?.consensus?.anchorStrategy || null;
  const anchorSignal = strategyConsensus?.consensus?.anchorSignal || null;

  // ---- 4. Regime ----
  const regimeCode = state?.regime?.code || 'NEUTRAL';
  const regimeConfidence = state?.regime?.confidence || 50;

  // ---- 5. Combine votes ----
  let momBias = 'NEUTRAL';
  if (momentum.roc > 0.0003 && momentum.consecutive >= 2) momBias = 'BULLISH';
  else if (momentum.roc < -0.0003 && momentum.consecutive >= 2) momBias = 'BEARISH';

  let stratBias = 'NEUTRAL';
  if (strategyAction === 'SIGNAL' && strategyDirection === 'BUY') stratBias = 'BULLISH';
  else if (strategyAction === 'SIGNAL' && strategyDirection === 'SELL') stratBias = 'BEARISH';
  else if (strategyAction === 'CONFLICT') stratBias = 'CONFLICT';

  const votes = { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 };
  votes[pattern.bias] += pattern.confidence * 0.5;
  votes[momBias] += 20;
  if (stratBias === 'CONFLICT') {
    votes.NEUTRAL += 40;
  } else if (stratBias !== 'NEUTRAL') {
    votes[stratBias] += strategyConfidence * 0.6;
  }

  // ---- 6. Direction from votes ----
  let direction = 'NEUTRAL';
  let source = 'pattern_only';
  if (votes.BULLISH > votes.BEARISH && votes.BULLISH > 30) {
    direction = 'BUY';
    source = stratBias === 'BULLISH' ? 'combined' : 'pattern_only';
  } else if (votes.BEARISH > votes.BULLISH && votes.BEARISH > 30) {
    direction = 'SELL';
    source = stratBias === 'BEARISH' ? 'combined' : 'pattern_only';
  } else {
    direction = 'NEUTRAL';
    source = stratBias === 'CONFLICT' ? 'conflict' : 'silent';
  }

  // ---- 7. Confidence — [FIX-P1] ----
  // Direction is still decided by votes (with the 0.6 discount, which keeps
  // strategy from dominating pattern+momentum combined). But the reported
  // CONFIDENCE no longer inherits that discount. If the ranker calibrated
  // 55% and pattern/momentum don't strongly disagree, we report ~55%.
  const dirBias = direction === 'BUY' ? 'BULLISH' : direction === 'SELL' ? 'BEARISH' : null;
  const opposite = oppositeBias(dirBias);

  let confidence = 0;
  if (direction === 'NEUTRAL') {
    confidence = Math.max(votes.BULLISH, votes.BEARISH);
  } else if (stratBias === dirBias && strategyConfidence > 0) {
    // Strategy fired in the same direction — treat its confidence as the
    // calibrated base probability. Small boosts for confirmation, mild
    // penalties for strong disagreement.
    let conf = strategyConfidence;

    // Boost: pattern confirms direction with decent strength
    if (pattern.bias === dirBias && pattern.confidence >= 50) {
      conf += Math.min(8, (pattern.confidence - 50) * 0.15);
    }
    // Boost: momentum confirms
    if (momBias === dirBias) conf += 3;

    // Penalty: pattern strongly disagrees
    if (pattern.bias === opposite && pattern.confidence >= 60) {
      conf *= 0.85;
    }
    // Penalty: momentum disagrees
    if (momBias === opposite) {
      conf *= 0.95;
    }

    confidence = conf;
  } else {
    // No strategy confirmation — direction came from pattern and/or momentum
    confidence = Math.max(votes.BULLISH, votes.BEARISH);
  }

  // ---- 8. Volatility adjustment ----
  if (vol.regime === 'high') confidence *= 0.85;
  else if (vol.regime === 'low') confidence *= 0.95;
  confidence = Math.round(Math.max(0, Math.min(95, confidence)));

  // ---- 9. Reasons ----
  const reasons = [];
  reasons.push(`Pattern: ${pattern.bias} (${pattern.confidence}%)`);
  if (pattern.patterns.length) reasons.push(`Patterns: ${pattern.patterns.join(', ')}`);
  reasons.push(`Momentum: ${momBias} RoC=${(momentum.roc * 100).toFixed(3)}%`);
  if (stratBias !== 'NEUTRAL' && stratBias !== 'CONFLICT') {
    reasons.push(`Strategies: ${agreeing.join(', ')} agree ${strategyDirection}`);
  }
  if (stratBias === 'CONFLICT') reasons.push('Strategy conflict — no trade');
  reasons.push(`Volatility: ${vol.regime} (${vol.ratio}x)`);

  // ---- 10. Mode label ----
  let modeLabel = 'silent';
  if (stratBias === 'CONFLICT') modeLabel = 'conflict';
  else if (direction !== 'NEUTRAL') modeLabel = source;

  // ---- 11. ATR-derived levels (used by opportunityEngine) ----
  const atr = vol.currentATR || 0.0005;
  // [FIX-P3] Tolerant close extraction from the last candle.
  const rawClose = extractClose(candles[candles.length - 1]);
  const entryPrice = Number.isFinite(rawClose) && rawClose > 0 ? rawClose : null;

  let strategyLevels = null;
  // [FIX-P4] Only emit levels when we have a valid entry price.
  // Previously `entryPrice.toFixed(8)` on undefined would throw and turn
  // the whole prediction into a caught-null at the caller.
  if (direction !== 'NEUTRAL' && entryPrice != null) {
    const ko = direction === 'BUY' ? entryPrice - atr * 1.5 : entryPrice + atr * 1.5;
    const tp = direction === 'BUY' ? entryPrice + atr * 3.0 : entryPrice - atr * 3.0;
    strategyLevels = {
      entry: Number(entryPrice.toFixed(8)),
      stop: Number(ko.toFixed(8)),
      target: Number(tp.toFixed(8)),
    };
  }

  // ---- 12. Directional probabilities (for dashboard) ----
  const confPct = confidence / 100;
  let probabilities;
  if (direction === 'BUY') {
    probabilities = { up: confPct, down: (1 - confPct) * 0.7, neutral: (1 - confPct) * 0.3 };
  } else if (direction === 'SELL') {
    probabilities = { up: (1 - confPct) * 0.7, down: confPct, neutral: (1 - confPct) * 0.3 };
  } else {
    probabilities = { up: 0.33, down: 0.33, neutral: 0.34 };
  }

  // ---- 13. [FIX-P2] Trace log for emitted signals ----
  if (direction !== 'NEUTRAL') {
    logger.info(
      `[Predictor] ${canonical} ${timeframe}: ${direction} conf=${confidence} source=${source} ` +
      `strat=${stratBias}@${strategyConfidence} pattern=${pattern.bias}@${pattern.confidence} mom=${momBias}`
    );
  }

  // ---- 14. Build prediction ----
  return {
    symbol: canonical,
    timeframe,
    timestamp: new Date().toISOString(),

    direction,
    source,
    modeLabel,
    reasons,

    pattern: {
      bias: pattern.bias,
      confidence: pattern.confidence,
      patterns: pattern.patterns,
      bodyRatio: pattern.bodyRatio,
      hhCount: pattern.hhCount,
      llCount: pattern.llCount,
    },
    momentum: {
      roc: momentum.roc,
      consecutive: momentum.consecutive,
      direction: momentum.direction,
    },
    volatility: {
      currentATR: vol.currentATR,
      avgATR: vol.avgATR,
      ratio: vol.ratio,
      regime: vol.regime,
    },

    strategyConsensus: strategyConsensus ? {
      action: strategyAction,
      direction: strategyDirection,
      confidence: strategyConfidence,
      anchorStrategy,
      anchorSignal,
      agreeing,
      conflicting,
    } : null,

    calibratedConfidence: confidence,
    confidence,
    probabilities,

    strategyLevels,
    entryPrice: entryPrice ?? 0,
    expectedMove: direction === 'BUY' ? atr * 2 : direction === 'SELL' ? -atr * 2 : 0,
    expectedFavorable: atr * 1.5,
    expectedAdverse: -atr * 1.5,
    mfe: 0,
    mae: 0,
    timeToMaxFavorable: 3,
    timeToMaxAdverse: 3,
    timeToMaxFavorableSec: 3 * tfSec,

    regime: regimeCode,
    regimeConfidence,
    marketQuality: state?.summary?.marketQuality || 50,
    noiseLevel: state?.summary?.noiseLevel || 'medium',

    sampleSize: candles.length,
    effectiveSampleSize: candles.length,
    qualifiedCount: candles.length,
    candidateCount: candles.length,
    averageDistance: 0,
    weightedAverageDistance: 0,
    maxDistance: 0,
    medianDistance: 0,
    distanceDistribution: {},

    analogues: [],  // explicitly empty — no historical matching
  };
}

function _neutral(symbol, timeframe, reason) {
  return {
    symbol, timeframe,
    timestamp: new Date().toISOString(),
    direction: 'NEUTRAL', source: 'silent', modeLabel: 'no_data',
    reasons: [reason],
    pattern: { bias: 'NEUTRAL', confidence: 0, patterns: [] },
    momentum: { roc: 0, consecutive: 0, direction: 'NEUTRAL' },
    volatility: { currentATR: 0, avgATR: 0, ratio: 1, regime: 'normal' },
    strategyConsensus: null,
    calibratedConfidence: 0, confidence: 0,
    probabilities: { up: 0.33, down: 0.33, neutral: 0.34 },
    strategyLevels: null,
    entryPrice: 0,
    expectedMove: 0, expectedFavorable: 0, expectedAdverse: 0,
    mfe: 0, mae: 0, timeToMaxFavorable: null, timeToMaxAdverse: null,
    regime: 'NEUTRAL', regimeConfidence: 50,
    marketQuality: 50, noiseLevel: 'medium',
    sampleSize: 0, effectiveSampleSize: 0, qualifiedCount: 0, candidateCount: 0,
    averageDistance: 0, weightedAverageDistance: 0, maxDistance: 0, medianDistance: 0,
    distanceDistribution: {},
    analogues: [],
  };
}

module.exports = { predict, normalizeSymbol };
