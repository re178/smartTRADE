// core/intelligence/opportunityEngine.js – Trade Filter
// Evaluates whether a prediction is tradeable and selects the best
// multiplier. Uses ATR-based path simulation (no historical analogues).
//
// Routes by prediction.modeLabel:
//   • conflict          → NO_TRADE STRATEGY_CONFLICT
//   • no_data           → NO_TRADE NO_DATA
//   • strategy_only     → strategy-consensus gate (2+ agree, valid levels)
//   • combined / pattern_only / analogue_only → ATR path simulation
//
// Every candidate multiplier is evaluated on 500 synthetic ATR-drawn paths.
// No historical state is consulted.

'use strict';

const riskEngine = require('../risk/riskEngine');
const { getPipSize } = require('../../shared/helpers');
const logger = require('../../infrastructure/logger') || console;

const CONFIG = {
  MIN_CONFIDENCE: 55,
  MIN_EV: 0.0,
  MIN_EV_OVER_STAKE: 0.005,
  MIN_EFFECTIVE_SAMPLE: 15,
  MIN_QUALIFIED_COUNT: 20,
  MAX_WEIGHTED_DISTANCE: 2.5,
  MIN_MARKET_QUALITY: 30,
  MAX_SPREAD_PIPS: 3.0,

  CANDIDATE_MULTIPLIERS: [100, 200, 300, 500, 800],
  MAX_KNOCKOUT_PROBABILITY: 0.50,
  MAX_KNOCKOUT_PROBABILITY_COMBINED: 0.45,
  TP_MULTIPLIER: 1.5,
  SL_MULTIPLIER: 1.2,
  RISK_AVERSION: 2.0,
  MIN_PATHS: 10,

  MIN_DURATION_SEC: 60,
  MAX_DURATION_SEC: 900,

  STRATEGY_ONLY_MIN_AGREEING: 2,
  STRATEGY_ONLY_CONFIDENCE_FLOOR: 0.35,
  STRATEGY_ONLY_CONFIDENCE_CEIL: 0.75,
  STRATEGY_ONLY_NEUTRAL_BUFFER: 0.10,
  STRATEGY_ONLY_MAX_STAKE_PCT: 0.03,
};

const NO_TRADE_REASONS = {
  NONE: 'NONE',
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  NEGATIVE_EV: 'NEGATIVE_EV',
  LOW_EV_OVER_STAKE: 'LOW_EV_OVER_STAKE',
  HIGH_MAE_RATIO: 'HIGH_MAE_RATIO',
  LOW_SAMPLE_SIZE: 'LOW_SAMPLE_SIZE',
  POOR_SIMILARITY: 'POOR_SIMILARITY',
  LOW_MARKET_QUALITY: 'LOW_MARKET_QUALITY',
  HIGH_SPREAD: 'HIGH_SPREAD',
  HIGH_VOLATILITY: 'HIGH_VOLATILITY',
  LOW_EXPECTED_MOVE: 'LOW_EXPECTED_MOVE',
  UNCERTAIN_DIRECTION: 'UNCERTAIN_DIRECTION',
  RISK_LIMIT_EXCEEDED: 'RISK_LIMIT_EXCEEDED',
  CORRELATED_EXPOSURE: 'CORRELATED_EXPOSURE',
  BROKER_UNAVAILABLE: 'BROKER_UNAVAILABLE',
  STALE_DATA: 'STALE_DATA',
  PROPOSAL_REJECTED: 'PROPOSAL_REJECTED',
  MODEL_UNCERTAINTY: 'MODEL_UNCERTAINTY',
  NO_VALID_MULTIPLIER: 'NO_VALID_MULTIPLIER',
  INSUFFICIENT_PATHS: 'INSUFFICIENT_PATHS',
  STRATEGY_CONFLICT: 'STRATEGY_CONFLICT',
  STRATEGY_WEAK: 'STRATEGY_WEAK',
  INVALID_STRATEGY_LEVELS: 'INVALID_STRATEGY_LEVELS',
  NO_DATA: 'NO_DATA',
};

// ========================================================================
// Main entry
// ========================================================================
async function evaluate(prediction, account, openPositions, marketData, riskConfig = {}) {
  if (!prediction) {
    return createNoTradeResponse(NO_TRADE_REASONS.NO_DATA, 'No prediction provided.');
  }

  const modeLabel = prediction.modeLabel || 'analogue_only';
  const source = prediction.source || 'analogue';

  // 1. Conflict
  if (modeLabel === 'conflict' || source === 'conflict') {
    const reasons = prediction.strategyConsensus?.reasons || [];
    logger.info(
      `[Opportunity] ${prediction.symbol} NO_TRADE STRATEGY_CONFLICT — ` +
      `Reasons: ${reasons.join('; ')}`
    );
    return createNoTradeResponse(
      NO_TRADE_REASONS.STRATEGY_CONFLICT,
      'Analogue and strategy signals disagree',
      prediction
    );
  }

  // 2. No data
  if (modeLabel === 'no_data') {
    return createNoTradeResponse(
      NO_TRADE_REASONS.NO_DATA,
      'No usable market data',
      prediction
    );
  }

  // 3. Direction
  if (prediction.direction === 'NEUTRAL' || !prediction.direction) {
    logger.info(
      `[Opportunity] ${prediction.symbol} NO_TRADE UNCERTAIN_DIRECTION ` +
      `(source=${source}, modeLabel=${modeLabel})`
    );
    return createNoTradeResponse(
      NO_TRADE_REASONS.UNCERTAIN_DIRECTION,
      `No clear direction from ${source}`,
      prediction
    );
  }

  // 4. Common pre-checks
  const preCheck = preCheckCommon(prediction, account, marketData);
  if (preCheck) return preCheck;

  // 5. Route
  if (modeLabel === 'strategy_only') {
    return evaluateStrategyOnly(prediction, account, openPositions, marketData, riskConfig);
  }

  return evaluateWithPaths(
    prediction, account, openPositions, marketData, riskConfig,
    modeLabel === 'combined' ? 'combined' : 'analogue'
  );
}

// ========================================================================
// Common pre-checks
// ========================================================================
function preCheckCommon(prediction, account, marketData) {
  const { calibratedConfidence = 0, marketQuality = 50 } = prediction;

  if (calibratedConfidence < CONFIG.MIN_CONFIDENCE) {
    logger.info(
      `[Opportunity] ${prediction.symbol} NO_TRADE LOW_CONFIDENCE — ` +
      `conf=${calibratedConfidence.toFixed(0)} (min ${CONFIG.MIN_CONFIDENCE})`
    );
    return createNoTradeResponse(
      NO_TRADE_REASONS.LOW_CONFIDENCE,
      `Confidence ${calibratedConfidence.toFixed(0)} below ${CONFIG.MIN_CONFIDENCE}`,
      prediction
    );
  }

  if (marketQuality < CONFIG.MIN_MARKET_QUALITY) {
    logger.info(
      `[Opportunity] ${prediction.symbol} NO_TRADE LOW_MARKET_QUALITY — ` +
      `quality=${marketQuality.toFixed(0)} (min ${CONFIG.MIN_MARKET_QUALITY})`
    );
    return createNoTradeResponse(
      NO_TRADE_REASONS.LOW_MARKET_QUALITY,
      `Market quality ${marketQuality.toFixed(0)} below ${CONFIG.MIN_MARKET_QUALITY}`,
      prediction
    );
  }

  if (marketData?.spread) {
    const pipSize = getPipSize(prediction.symbol);
    const spreadPips = marketData.spread / pipSize;
    if (spreadPips > CONFIG.MAX_SPREAD_PIPS) {
      logger.info(
        `[Opportunity] ${prediction.symbol} NO_TRADE HIGH_SPREAD — ` +
        `spread=${spreadPips.toFixed(2)} pips (max ${CONFIG.MAX_SPREAD_PIPS})`
      );
      return createNoTradeResponse(
        NO_TRADE_REASONS.HIGH_SPREAD,
        `Spread ${spreadPips.toFixed(2)} pips exceeds ${CONFIG.MAX_SPREAD_PIPS}`,
        prediction
      );
    }
  }

  return null;
}

// ========================================================================
// Strategy-only path
// ========================================================================
async function evaluateStrategyOnly(prediction, account, openPositions, marketData, riskConfig) {
  const consensus = prediction.strategyConsensus;
  if (!consensus) {
    return createNoTradeResponse(NO_TRADE_REASONS.NO_DATA, 'Strategy-only mode but no consensus data', prediction);
  }

  const agreeingCount = (consensus.agreeing || []).length;
  if (agreeingCount < CONFIG.STRATEGY_ONLY_MIN_AGREEING) {
    return createNoTradeResponse(
      NO_TRADE_REASONS.STRATEGY_WEAK,
      `Strategy-only requires ${CONFIG.STRATEGY_ONLY_MIN_AGREEING}+ agreeing strategies, got ${agreeingCount}`,
      prediction
    );
  }

  const levels = prediction.strategyLevels;
  if (!levels || !Number.isFinite(levels.entry) || !Number.isFinite(levels.stop) || !Number.isFinite(levels.target)) {
    return createNoTradeResponse(
      NO_TRADE_REASONS.INVALID_STRATEGY_LEVELS,
      'Strategy consensus fired but price levels are missing',
      prediction
    );
  }

  const { entry, stop, target } = levels;
  const direction = prediction.direction;

  if (direction === 'BUY' && !(stop < entry && entry < target)) {
    return createNoTradeResponse(
      NO_TRADE_REASONS.INVALID_STRATEGY_LEVELS,
      `Invalid BUY levels: stop=${stop} entry=${entry} target=${target}`,
      prediction
    );
  }
  if (direction === 'SELL' && !(target < entry && entry < stop)) {
    return createNoTradeResponse(
      NO_TRADE_REASONS.INVALID_STRATEGY_LEVELS,
      `Invalid SELL levels: target=${target} entry=${entry} stop=${stop}`,
      prediction
    );
  }

  const balance = account?.balance ? parseFloat(account.balance) : 10000;
  const riskPerTrade = riskConfig.riskPerTradePct || 1.0;
  const stake = Math.max(
    0.5,
    Math.min(
      balance * (riskPerTrade / 100),
      balance * CONFIG.STRATEGY_ONLY_MAX_STAKE_PCT
    )
  );

  const probTPRaw = Math.max(
    CONFIG.STRATEGY_ONLY_CONFIDENCE_FLOOR,
    Math.min(CONFIG.STRATEGY_ONLY_CONFIDENCE_CEIL, (consensus.confidence || 0) / 100)
  );
  const neutralBuffer = CONFIG.STRATEGY_ONLY_NEUTRAL_BUFFER;
  const probTP = probTPRaw * (1 - neutralBuffer);
  const probSL = (1 - probTPRaw) * (1 - neutralBuffer);
  const probNeutral = neutralBuffer;

  const targetDist = Math.abs(target - entry);
  const stopDist = Math.abs(stop - entry);
  if (targetDist <= 0 || stopDist <= 0) {
    return createNoTradeResponse(
      NO_TRADE_REASONS.INVALID_STRATEGY_LEVELS,
      'Zero distance between entry and target/stop',
      prediction
    );
  }

  let bestMultiplier = null;
  let bestMetrics = null;
  let bestEv = -Infinity;

  for (const mult of CONFIG.CANDIDATE_MULTIPLIERS) {
    const profitTP = stake * mult * (targetDist / entry);
    const lossSL = Math.min(stake, stake * mult * (stopDist / entry));
    const ev = probTP * profitTP - probSL * lossSL;
    const evOverStake = ev / stake;

    if (ev > CONFIG.MIN_EV && evOverStake >= CONFIG.MIN_EV_OVER_STAKE && ev > bestEv) {
      bestEv = ev;
      bestMultiplier = mult;
      bestMetrics = { probTP, probSL, probNeutral, profitTP, lossSL, ev, evOverStake, targetDist, stopDist };
    }
  }

  if (!bestMultiplier) {
    return createNoTradeResponse(
      NO_TRADE_REASONS.NO_VALID_MULTIPLIER,
      `No multiplier yielded EV/stake >= ${CONFIG.MIN_EV_OVER_STAKE}`,
      prediction
    );
  }

  const anchorSig = consensus.anchorSignal;
  const rawDuration = (anchorSig && anchorSig.duration) || 300;
  const duration = Math.max(
    CONFIG.MIN_DURATION_SEC,
    Math.min(CONFIG.MAX_DURATION_SEC, Math.round(rawDuration))
  );

  try {
    const riskCheck = await riskEngine.validateTrade({
      symbol: prediction.symbol,
      direction,
      stake,
      multiplier: bestMultiplier,
      duration,
      knockoutLevel: stop,
      takeProfitLevel: target,
      account,
      openPositions,
      marketData,
    });
    if (!riskCheck.approved) {
      const reason = mapRiskReason(riskCheck.reason);
      return createNoTradeResponse(reason, riskCheck.message || 'Risk validation failed', prediction);
    }
  } catch (err) {
    return createNoTradeResponse(
      NO_TRADE_REASONS.MODEL_UNCERTAINTY,
      `Risk engine error: ${err.message}`,
      prediction
    );
  }

  logger.info(
    `[Opportunity] ${prediction.symbol} TRADE ${direction} (STRATEGY_ONLY) ` +
    `${bestMultiplier}x stake=${stake.toFixed(2)} ` +
    `probTP=${(probTP*100).toFixed(0)}% probSL=${(probSL*100).toFixed(0)}% ` +
    `ev=${bestMetrics.ev.toFixed(2)}`
  );

  return {
    tradable: true,
    reason: `Strategy consensus (${agreeingCount} agree) — ${consensus.anchorStrategy} anchor`,
    prediction,
    direction,
    stake,
    multiplier: bestMultiplier,
    duration,
    entryPrice: entry,
    knockoutLevel: stop,
    takeProfitLevel: target,
    probabilities: { up: probTP, down: probSL, neutral: probNeutral },
    source: 'strategy_only',
    tradeEconomics: {
      probTP,
      probSL,
      probOther: probNeutral,
      expectedProfit: bestMetrics.ev,
      expectedLoss: bestMetrics.lossSL * probSL,
      ev: bestMetrics.ev,
      evOverStake: bestMetrics.evOverStake,
    },
    riskMetrics: {
      maxLoss: bestMetrics.lossSL,
      targetProfit: bestMetrics.profitTP,
      riskRewardRatio: bestMetrics.profitTP / bestMetrics.lossSL,
    },
    strategyInfo: {
      anchorStrategy: consensus.anchorStrategy,
      agreeing: consensus.agreeing,
      conflicting: consensus.conflicting,
      confidence: consensus.confidence,
    },
    decision: 'TRADE',
    timestamp: new Date().toISOString(),
  };
}

// ========================================================================
// ATR-based path evaluation (replaces analogue-based)
// ========================================================================
async function evaluateWithPaths(prediction, account, openPositions, marketData, riskConfig, mode) {
  const {
    symbol = 'UNKNOWN',
    direction = 'NEUTRAL',
    calibratedConfidence = 50,
  } = prediction;

  const isCombined = mode === 'combined';

  // ---- Sample-size gate (relaxed — pattern predictor supplies candles.length) ----
  const sampleSize = prediction.sampleSize || 0;
  if (sampleSize < 20) {
    logger.info(`[Opportunity] ${symbol} NO_TRADE LOW_SAMPLE_SIZE — ${sampleSize} candles`);
    return createNoTradeResponse(
      NO_TRADE_REASONS.LOW_SAMPLE_SIZE,
      'Insufficient candle history',
      prediction
    );
  }

  // ---- ATR ----
  const atr = prediction.volatility && prediction.volatility.currentATR;
  if (!Number.isFinite(atr) || atr <= 0) {
    return createNoTradeResponse(
      NO_TRADE_REASONS.LOW_EXPECTED_MOVE,
      'No ATR available',
      prediction
    );
  }

  // ---- Expected move pip-normalized ----
  const pipSize = getPipSize(prediction.symbol);
  if (Math.abs(prediction.expectedMove || 0) < pipSize * 2) {
    return createNoTradeResponse(
      NO_TRADE_REASONS.LOW_EXPECTED_MOVE,
      `Expected move ${((prediction.expectedMove || 0) / pipSize).toFixed(2)} pips < 2`,
      prediction
    );
  }

  // ---- MAE ratio ----
  const expFav = Math.abs(prediction.expectedFavorable || 0);
  const expAdv = Math.abs(prediction.expectedAdverse || 0);
  const maeRatio = expAdv / (Math.abs(prediction.expectedMove) || 0.0001);
  if (maeRatio > 0.8) {
    return createNoTradeResponse(
      NO_TRADE_REASONS.HIGH_MAE_RATIO,
      `maeRatio ${maeRatio.toFixed(2)} above 0.8`,
      prediction
    );
  }

  // ---- Build synthetic ATR paths ----
  const LOOKAHEAD_CANDLES = 5;
  const N_PATHS = 500;
  const entryPrice = marketData?.currentPrice || prediction.entryPrice || 0;
  if (!entryPrice || entryPrice <= 0) {
    return createNoTradeResponse(NO_TRADE_REASONS.MODEL_UNCERTAINTY, 'No entry price', prediction);
  }

  const paths = [];
  for (let p = 0; p < N_PATHS; p++) {
    const pathHighs = [], pathLows = [], pathCloses = [];
    let price = entryPrice;
    for (let c = 0; c < LOOKAHEAD_CANDLES; c++) {
      const body = (Math.random() - 0.5) * atr * 1.2;
      const wickUp = Math.random() * atr * 0.4;
      const wickDown = Math.random() * atr * 0.4;
      const open = price;
      const close = open + body;
      pathHighs.push(Math.max(open, close) + wickUp);
      pathLows.push(Math.min(open, close) - wickDown);
      pathCloses.push(close);
      price = close;
    }
    paths.push({ prices: pathCloses, highs: pathHighs, lows: pathLows, weight: 1.0 });
  }

  // ---- TP/SL ----
  let tpDist, slDist, usingStrategyLevels = false;
  if (isCombined && prediction.strategyLevels) {
    const lv = prediction.strategyLevels;
    const entry = marketData?.currentPrice || prediction.entryPrice || lv.entry;
    const validBuy = direction === 'BUY' && lv.stop < entry && lv.target > entry;
    const validSell = direction === 'SELL' && lv.stop > entry && lv.target < entry;
    if (Number.isFinite(lv.target) && Number.isFinite(lv.stop) && Number.isFinite(entry) && (validBuy || validSell)) {
      tpDist = Math.abs(lv.target - entry);
      slDist = Math.abs(lv.stop - entry);
      usingStrategyLevels = true;
    }
  }

  if (!usingStrategyLevels) {
    const favorable = expFav;
    const adverse = expAdv;
    if (favorable <= 0 || adverse <= 0) {
      return createNoTradeResponse(
        NO_TRADE_REASONS.LOW_EXPECTED_MOVE,
        'Missing favorable/adverse estimates',
        prediction
      );
    }
    tpDist = favorable * CONFIG.TP_MULTIPLIER;
    slDist = adverse * CONFIG.SL_MULTIPLIER;
  }

  let takeProfitLevel, knockoutLevel;
  if (direction === 'BUY') {
    takeProfitLevel = entryPrice + tpDist;
    knockoutLevel = entryPrice - slDist;
  } else {
    takeProfitLevel = entryPrice - tpDist;
    knockoutLevel = entryPrice + slDist;
  }

  // ---- Stake ----
  const balance = account?.balance ? parseFloat(account.balance) : 10000;
  const riskPerTrade = riskConfig.riskPerTradePct || 1.0;
  const stake = Math.max(0.5, Math.min(balance * (riskPerTrade / 100), balance * 0.05));

  // ---- Multiplier selection ----
  const maxProbSL = isCombined
    ? CONFIG.MAX_KNOCKOUT_PROBABILITY_COMBINED
    : CONFIG.MAX_KNOCKOUT_PROBABILITY;

  let bestMultiplier = null;
  let bestUtility = -Infinity;
  let bestMetrics = null;

  for (const mult of CONFIG.CANDIDATE_MULTIPLIERS) {
    let totalProfit = 0, totalWeight = 0;
    let weightedHitsTP = 0, weightedHitsSL = 0, weightedSLLoss = 0;

    for (const path of paths) {
      const w = path.weight || 1.0;
      totalWeight += w;
      let exitPrice = null, hitTP = false, hitSL = false;

      for (let i = 0; i < path.prices.length; i++) {
        const hi = path.highs[i], lo = path.lows[i];
        if (direction === 'BUY') {
          if (hi >= takeProfitLevel) { hitTP = true; exitPrice = takeProfitLevel; break; }
          if (lo <= knockoutLevel)   { hitSL = true; exitPrice = knockoutLevel;   break; }
        } else {
          if (lo <= takeProfitLevel) { hitTP = true; exitPrice = takeProfitLevel; break; }
          if (hi >= knockoutLevel)   { hitSL = true; exitPrice = knockoutLevel;   break; }
        }
      }
      if (!exitPrice) exitPrice = path.prices[path.prices.length - 1];

      const priceChange = (direction === 'BUY') ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
      const profit = Math.max(-stake, stake * mult * (priceChange / entryPrice));
      totalProfit += profit * w;
      if (hitTP) weightedHitsTP += w;
      if (hitSL) { weightedHitsSL += w; weightedSLLoss += Math.abs(profit) * w; }
    }

    if (totalWeight === 0) continue;

    const avgProfit = totalProfit / totalWeight;
    const probTP = weightedHitsTP / totalWeight;
    const probSL = weightedHitsSL / totalWeight;
    const avgLossOnSLHit = weightedHitsSL > 0 ? (weightedSLLoss / weightedHitsSL) : 0;

    const ev = avgProfit;
    const utility = ev - CONFIG.RISK_AVERSION * probSL * avgLossOnSLHit;

    if (ev > CONFIG.MIN_EV && probSL < maxProbSL && utility > bestUtility) {
      bestUtility = utility;
      bestMultiplier = mult;
      bestMetrics = {
        probTP, probSL, probOther: 1 - probTP - probSL,
        avgProfit, avgLossOnSLHit, ev,
        evOverStake: ev / stake,
        utility,
      };
    }
  }

  if (!bestMultiplier) {
    return createNoTradeResponse(
      NO_TRADE_REASONS.NO_VALID_MULTIPLIER,
      'No multiplier yielded positive EV with acceptable knockout probability',
      prediction
    );
  }

  if (bestMetrics.evOverStake < CONFIG.MIN_EV_OVER_STAKE) {
    return createNoTradeResponse(
      NO_TRADE_REASONS.LOW_EV_OVER_STAKE,
      `EV/stake ${bestMetrics.evOverStake.toFixed(5)} below ${CONFIG.MIN_EV_OVER_STAKE}`,
      prediction
    );
  }

  // ---- Duration: convert candles → seconds via timeframe ----
  const TF_SECONDS = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 };
  const tfSec = TF_SECONDS[prediction.timeframe] || 300;
  const candlesToMax = prediction.timeToMaxFavorable || 5;
  const duration = Math.max(
    CONFIG.MIN_DURATION_SEC,
    Math.min(CONFIG.MAX_DURATION_SEC, Math.round(candlesToMax * tfSec))
  );

  // ---- Risk engine ----
  try {
    const riskCheck = await riskEngine.validateTrade({
      symbol, direction, stake, multiplier: bestMultiplier, duration,
      knockoutLevel, takeProfitLevel, account, openPositions, marketData,
    });
    if (!riskCheck.approved) {
      const reason = mapRiskReason(riskCheck.reason);
      return createNoTradeResponse(reason, riskCheck.message || 'Risk validation failed', prediction);
    }
  } catch (err) {
    return createNoTradeResponse(
      NO_TRADE_REASONS.MODEL_UNCERTAINTY,
      `Risk engine error: ${err.message}`,
      prediction
    );
  }

  logger.info(
    `[Opportunity] ${symbol} TRADE ${direction} (${mode.toUpperCase()}) ` +
    `${bestMultiplier}x stake=${stake.toFixed(2)} ` +
    `probTP=${(bestMetrics.probTP*100).toFixed(0)}% probSL=${(bestMetrics.probSL*100).toFixed(0)}% ` +
    `ev=${bestMetrics.ev.toFixed(2)} duration=${duration}s`
  );

  const strategyInfo = isCombined && prediction.strategyConsensus ? {
    anchorStrategy: prediction.strategyConsensus.anchorStrategy,
    agreeing: prediction.strategyConsensus.agreeing,
    conflicting: prediction.strategyConsensus.conflicting,
    confidence: prediction.strategyConsensus.confidence,
  } : null;

  return {
    tradable: true,
    reason: isCombined
      ? `Combined (${prediction.strategyConsensus?.agreeing?.length || 0} agree) ${bestMultiplier}x`
      : `Pattern ${bestMultiplier}x (EV: ${bestMetrics.ev.toFixed(2)}, KO prob: ${(bestMetrics.probSL*100).toFixed(1)}%)`,
    prediction,
    direction,
    stake,
    multiplier: bestMultiplier,
    duration,
    entryPrice,
    knockoutLevel,
    takeProfitLevel,
    probabilities: prediction.probabilities || { up: 0.33, down: 0.33, neutral: 0.34 },
    source: mode,
    tradeEconomics: {
      probTP: bestMetrics.probTP,
      probSL: bestMetrics.probSL,
      probOther: bestMetrics.probOther,
      expectedProfit: bestMetrics.avgProfit,
      expectedLoss: bestMetrics.avgLossOnSLHit,
      ev: bestMetrics.ev,
      evOverStake: bestMetrics.evOverStake,
      utility: bestMetrics.utility,
    },
    riskMetrics: {
      maxLoss: stake,
      targetProfit: tpDist * bestMultiplier * stake / entryPrice,
      riskRewardRatio: tpDist / slDist,
    },
    strategyInfo,
    decision: 'TRADE',
    timestamp: new Date().toISOString(),
  };
}

// ========================================================================
// Helpers
// ========================================================================
function mapRiskReason(riskReason) {
  switch (riskReason) {
    case 'EXPOSURE_LIMIT': return NO_TRADE_REASONS.RISK_LIMIT_EXCEEDED;
    case 'CORRELATED': return NO_TRADE_REASONS.CORRELATED_EXPOSURE;
    case 'DUPLICATE_TRADE': return NO_TRADE_REASONS.RISK_LIMIT_EXCEEDED;
    case 'MAX_POSITIONS': return NO_TRADE_REASONS.RISK_LIMIT_EXCEEDED;
    case 'DAILY_LOSS_LIMIT': return NO_TRADE_REASONS.RISK_LIMIT_EXCEEDED;
    default: return NO_TRADE_REASONS.RISK_LIMIT_EXCEEDED;
  }
}

function createNoTradeResponse(reason, message, prediction = null) {
  return {
    tradable: false,
    reason, message, prediction,
    decision: 'NO_TRADE',
    timestamp: new Date().toISOString(),
    stake: 0, multiplier: 0, duration: 0,
    entryPrice: null, knockoutLevel: null, takeProfitLevel: null,
    source: prediction?.source || null,
    tradeEconomics: { probTP: 0, probSL: 0, probOther: 0, expectedProfit: 0, expectedLoss: 0, ev: 0, evOverStake: 0 },
    riskMetrics: { maxLoss: 0, targetProfit: 0, riskRewardRatio: 0 },
  };
}

module.exports = {
  evaluate,
  createNoTradeResponse,
  CONFIG,
  NO_TRADE_REASONS,
};
