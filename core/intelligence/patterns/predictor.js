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

'use strict';

const candleHistory = require('../../data/candleHistory');
const candlePatterns = require('./candlePatterns');
const logger = require('../../../infrastructure/logger') || console;

const TF_SECONDS = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 };

function normalizeSymbol(s) {
  return String(s || '').replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
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

  let direction = 'NEUTRAL';
  let confidence = 0;
  let source = 'pattern_only';
  const reasons = [];

  if (votes.BULLISH > votes.BEARISH && votes.BULLISH > 30) {
    direction = 'BUY';
    confidence = Math.min(95, votes.BULLISH);
    source = stratBias === 'BULLISH' ? 'combined' : 'pattern_only';
  } else if (votes.BEARISH > votes.BULLISH && votes.BEARISH > 30) {
    direction = 'SELL';
    confidence = Math.min(95, votes.BEARISH);
    source = stratBias === 'BEARISH' ? 'combined' : 'pattern_only';
  } else {
    direction = 'NEUTRAL';
    confidence = Math.max(votes.BULLISH, votes.BEARISH);
    source = stratBias === 'CONFLICT' ? 'conflict' : 'silent';
  }

  // ---- 6. Volatility adjustment ----
  if (vol.regime === 'high') confidence *= 0.85;
  else if (vol.regime === 'low') confidence *= 0.95;
  confidence = Math.round(Math.max(0, Math.min(95, confidence)));

  // ---- 7. Reasons ----
  reasons.push(`Pattern: ${pattern.bias} (${pattern.confidence}%)`);
  if (pattern.patterns.length) reasons.push(`Patterns: ${pattern.patterns.join(', ')}`);
  reasons.push(`Momentum: ${momBias} RoC=${(momentum.roc * 100).toFixed(3)}%`);
  if (stratBias !== 'NEUTRAL' && stratBias !== 'CONFLICT') {
    reasons.push(`Strategies: ${agreeing.join(', ')} agree ${strategyDirection}`);
  }
  if (stratBias === 'CONFLICT') reasons.push('Strategy conflict — no trade');
  reasons.push(`Volatility: ${vol.regime} (${vol.ratio}x)`);

  // ---- 8. Mode label ----
  let modeLabel = 'silent';
  if (stratBias === 'CONFLICT') modeLabel = 'conflict';
  else if (direction !== 'NEUTRAL') modeLabel = source;

  // ---- 9. ATR-derived levels (used by opportunityEngine) ----
  const atr = vol.currentATR || 0.0005;
  const entryPrice = candles[candles.length - 1].close;
  let strategyLevels = null;
  if (direction !== 'NEUTRAL') {
    const ko = direction === 'BUY' ? entryPrice - atr * 1.5 : entryPrice + atr * 1.5;
    const tp = direction === 'BUY' ? entryPrice + atr * 3.0 : entryPrice - atr * 3.0;
    strategyLevels = {
      entry: Number(entryPrice.toFixed(8)),
      stop: Number(ko.toFixed(8)),
      target: Number(tp.toFixed(8)),
    };
  }

  // ---- 10. Directional probabilities (for dashboard) ----
  const confPct = confidence / 100;
  let probabilities;
  if (direction === 'BUY') {
    probabilities = { up: confPct, down: (1 - confPct) * 0.7, neutral: (1 - confPct) * 0.3 };
  } else if (direction === 'SELL') {
    probabilities = { up: (1 - confPct) * 0.7, down: confPct, neutral: (1 - confPct) * 0.3 };
  } else {
    probabilities = { up: 0.33, down: 0.33, neutral: 0.34 };
  }

  // ---- 11. Build prediction ----
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
    entryPrice,
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
