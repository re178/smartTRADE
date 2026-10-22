// core/intelligence/opportunityEngine.js – Trade Filter
// Uses analogues from PredictionEngine to simulate TP/SL probabilities,
// evaluates multiple multipliers, selects best risk-adjusted one.
//
// [FILE-6A] CANDIDATE_MULTIPLIERS now [100, 200, 300, 500, 800] to match
//   the broker's accepted set. Old values [2..30] were rejected at execution.
// [FILE-6B] TP/SL levels computed from expectedFavorable / expectedAdverse
//   (price units) rather than MFE/MAE percentiles (which are R-multiples).
//   The old code added 2.5 (R) to 1.12 (price) producing unusable levels.
// [FILE-6C] Utility uses actual loss per SL-hit path, not stake.
//   stake × multiplier × (slDistance/entryPrice) is the real loss; for $99
//   at 500x with a 2-pip SL, actual loss ≈ $8.81, not $99. Old formula
//   over-penalized by ~10x.
// [FILE-6D] probSL and probTP are weighted by path weight.
// [FILE-6E] MAX_WEIGHTED_DISTANCE = 2.5 (was 0.30 — unreachable).
// [FILE-6F] MIN_EV_OVER_STAKE = 0.005 (was 0.02 — unreachable at 100x).
// [FILE-6G] MAX_KNOCKOUT_PROBABILITY = 0.50 (was 0.30 — over-strict).
// [FILE-6H] Every rejection gate logs a structured one-line reason.
// [FILE-6I] MIN_EV_OVER_STAKE checked once on selected multiplier.
// [FILE-6J] TP_MULTIPLIER and SL_MULTIPLIER scale expected moves.
// [FILE-6K] Paths with <2 prices skipped (fallback exit bug).
// [FILE-6L] Duration derived from timeToMaxFavorable, capped at 15 min.

const riskEngine = require('../risk/riskEngine');
const { getPipSize } = require('../../shared/helpers');
const logger = require('../../infrastructure/logger') || console;

// ---- Configuration ----
const CONFIG = {
  // Quality filters
  MIN_CONFIDENCE: 55,
  MIN_EV: 0.0,
  MIN_EV_OVER_STAKE: 0.005,         // [FILE-6F] was 0.02
  MIN_EFFECTIVE_SAMPLE: 15,
  MIN_QUALIFIED_COUNT: 20,
  MAX_WEIGHTED_DISTANCE: 2.5,        // [FILE-6E] was 0.30
  MIN_MARKET_QUALITY: 30,            // was 40 — realistic for current data
  MAX_SPREAD_PIPS: 3.0,              // was 2.0

  // Multiplier selection
  CANDIDATE_MULTIPLIERS: [100, 200, 300, 500, 800],   // [FILE-6A]
  MAX_KNOCKOUT_PROBABILITY: 0.50,    // [FILE-6G] was 0.30
  TP_MULTIPLIER: 1.5,                // [FILE-6J] TP = 1.5 × expected favorable move
  SL_MULTIPLIER: 1.2,                // [FILE-6J] SL = 1.2 × expected adverse move
  RISK_AVERSION: 2.0,
  MIN_PATHS: 10,

  // [FILE-6L] Duration bounds
  MIN_DURATION_SEC: 60,
  MAX_DURATION_SEC: 900,             // 15 min
};

// ---- NO TRADE Reason Taxonomy ----
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
};

async function evaluate(prediction, account, openPositions, marketData, riskConfig = {}) {
  if (!prediction) {
    return createNoTradeResponse(NO_TRADE_REASONS.MODEL_UNCERTAINTY, 'No prediction provided.');
  }

  const {
    symbol = 'UNKNOWN',
    direction = 'NEUTRAL',
    probabilities = { up: 0, down: 0, neutral: 0 },
    calibratedConfidence = 50,
    marketQuality = 50,
    effectiveSampleSize = 0,
    qualifiedCount = 0,
    weightedAverageDistance = 0,
    expectedMove = 0,
    expectedFavorable = 0,
    expectedAdverse = 0,
    mfe = 0,
    mae = 0,
    timeToMaxFavorable = 5,
    analogues = [],
  } = prediction;

  const { up = 0, down = 0, neutral = 0 } = probabilities;

  // ---- Basic quality filters ----
  const reasons = [];

  if (calibratedConfidence < CONFIG.MIN_CONFIDENCE) {
    reasons.push(NO_TRADE_REASONS.LOW_CONFIDENCE);
  }

  const maxProb = Math.max(up, down);
  if (maxProb < 0.50) {
    reasons.push(NO_TRADE_REASONS.UNCERTAIN_DIRECTION);
  }

  if (effectiveSampleSize < CONFIG.MIN_EFFECTIVE_SAMPLE || qualifiedCount < CONFIG.MIN_QUALIFIED_COUNT) {
    reasons.push(NO_TRADE_REASONS.LOW_SAMPLE_SIZE);
  }

  if (weightedAverageDistance > CONFIG.MAX_WEIGHTED_DISTANCE) {
    reasons.push(NO_TRADE_REASONS.POOR_SIMILARITY);
  }

  if (marketQuality < CONFIG.MIN_MARKET_QUALITY) {
    reasons.push(NO_TRADE_REASONS.LOW_MARKET_QUALITY);
  }

  if (marketData?.spread) {
    const pipSize = getPipSize(symbol);
    const spreadPips = marketData.spread / pipSize;
    if (spreadPips > CONFIG.MAX_SPREAD_PIPS) {
      reasons.push(NO_TRADE_REASONS.HIGH_SPREAD);
    }
  }

  if (Math.abs(expectedMove) < 0.0001) {
    reasons.push(NO_TRADE_REASONS.LOW_EXPECTED_MOVE);
  }

  const maeRatio = Math.abs(expectedAdverse) / (Math.abs(expectedMove) || 0.0001);
  if (maeRatio > 0.8) {
    reasons.push(NO_TRADE_REASONS.HIGH_MAE_RATIO);
  }

  if (reasons.length > 0) {
    // [FILE-6H] Structured rejection log
    logger.info(
      `[Opportunity] ${symbol} NO_TRADE ${reasons[0]} — ` +
      `conf=${calibratedConfidence.toFixed(0)} ` +
      `maxProb=${maxProb.toFixed(2)} ` +
      `ESS=${effectiveSampleSize.toFixed(1)} ` +
      `qual=${qualifiedCount} ` +
      `avgDist=${weightedAverageDistance.toFixed(2)} ` +
      `mktQ=${marketQuality.toFixed(0)} ` +
      `expMove=${expectedMove.toFixed(6)} ` +
      `maeRatio=${maeRatio.toFixed(2)}`
    );
    return createNoTradeResponse(reasons[0], `Basic checks failed: ${reasons.join(', ')}`, prediction);
  }

  // Direction must be non-neutral
  if (direction === 'NEUTRAL') {
    logger.info(`[Opportunity] ${symbol} NO_TRADE UNCERTAIN_DIRECTION — direction=NEUTRAL`);
    return createNoTradeResponse(NO_TRADE_REASONS.UNCERTAIN_DIRECTION, 'Direction is neutral.', prediction);
  }

  // ---- Extract path simulations ----
  const lookahead = prediction.timeframe === 'M5' ? 5 : (prediction.timeframe === 'M15' ? 15 : 5);
  const paths = analogues
    .map(a => {
      const prices = a.futurePrices?.[lookahead];
      // [FILE-6K] Skip paths with <2 prices (fallback exit bug)
      if (!prices || prices.length < 2) return null;
      return {
        prices,
        weight: a.totalWeight || 1.0,
        mfe: a.mfe,
        mae: a.mae,
      };
    })
    .filter(p => p !== null);

  if (paths.length < CONFIG.MIN_PATHS) {
    logger.info(`[Opportunity] ${symbol} NO_TRADE INSUFFICIENT_PATHS — only ${paths.length} valid paths (need ${CONFIG.MIN_PATHS})`);
    return createNoTradeResponse(NO_TRADE_REASONS.INSUFFICIENT_PATHS, `Only ${paths.length} valid paths.`, prediction);
  }

  // ---- [FILE-6B] TP/SL from expectedFavorable/expectedAdverse (price units) ----
  const favorable = Math.abs(expectedFavorable || 0);
  const adverse = Math.abs(expectedAdverse || 0);

  if (favorable <= 0 || adverse <= 0) {
    logger.info(`[Opportunity] ${symbol} NO_TRADE LOW_EXPECTED_MOVE — fav=${favorable.toFixed(6)} adv=${adverse.toFixed(6)}`);
    return createNoTradeResponse(NO_TRADE_REASONS.LOW_EXPECTED_MOVE, 'Missing favorable/adverse move estimates.', prediction);
  }

  const tpDist = favorable * CONFIG.TP_MULTIPLIER;
  const slDist = adverse * CONFIG.SL_MULTIPLIER;

  const entryPrice = marketData?.currentPrice || prediction.entryPrice || 0;
  if (!entryPrice || entryPrice <= 0) {
    logger.info(`[Opportunity] ${symbol} NO_TRADE MODEL_UNCERTAINTY — no entry price`);
    return createNoTradeResponse(NO_TRADE_REASONS.MODEL_UNCERTAINTY, 'No entry price.', prediction);
  }

  let takeProfitLevel, knockoutLevel;
  if (direction === 'BUY') {
    takeProfitLevel = entryPrice + tpDist;
    knockoutLevel = entryPrice - slDist;
  } else {
    takeProfitLevel = entryPrice - tpDist;
    knockoutLevel = entryPrice + slDist;
  }

  // ---- Stake sizing ----
  const balance = account?.balance ? parseFloat(account.balance) : 10000;
  const riskPerTrade = riskConfig.riskPerTradePct || 1.0;
  // Max loss is the stake itself (Deriv Multipliers cap loss at stake)
  const stake = Math.max(0.5, Math.min(balance * (riskPerTrade / 100), balance * 0.05));

  // ---- Evaluate candidate multipliers via path simulation ----
  let bestMultiplier = null;
  let bestUtility = -Infinity;
  let bestMetrics = null;

  for (const mult of CONFIG.CANDIDATE_MULTIPLIERS) {
    let totalProfit = 0;
    let totalWeight = 0;
    let weightedHitsTP = 0;
    let weightedHitsSL = 0;
    let weightedSLLoss = 0;

    for (const path of paths) {
      const w = path.weight || 1.0;
      totalWeight += w;
      const prices = path.prices;

      let exitPrice = null;
      let hitTP = false;
      let hitSL = false;

      for (const price of prices) {
        if (direction === 'BUY') {
          if (price >= takeProfitLevel) { hitTP = true; exitPrice = takeProfitLevel; break; }
          if (price <= knockoutLevel) { hitSL = true; exitPrice = knockoutLevel; break; }
        } else {
          if (price <= takeProfitLevel) { hitTP = true; exitPrice = takeProfitLevel; break; }
          if (price >= knockoutLevel) { hitSL = true; exitPrice = knockoutLevel; break; }
        }
      }
      if (!exitPrice) exitPrice = prices[prices.length - 1];

      const priceChange = (direction === 'BUY') ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
      const profit = stake * mult * (priceChange / entryPrice);
      totalProfit += profit * w;

      if (hitTP) weightedHitsTP += w;
      if (hitSL) {
        weightedHitsSL += w;
        weightedSLLoss += Math.abs(profit) * w;   // [FILE-6C] actual loss magnitude
      }
    }

    if (totalWeight === 0) continue;

    const avgProfit = totalProfit / totalWeight;
    // [FILE-6D] Weighted probabilities
    const probTP = weightedHitsTP / totalWeight;
    const probSL = weightedHitsSL / totalWeight;
    const avgLossOnSLHit = weightedHitsSL > 0 ? (weightedSLLoss / weightedHitsSL) : 0;

    const ev = avgProfit;

    // [FILE-6C] Risk-adjusted utility: penalize tail risk using ACTUAL loss per SL hit
    const utility = ev - CONFIG.RISK_AVERSION * probSL * avgLossOnSLHit;

    if (ev > CONFIG.MIN_EV && probSL < CONFIG.MAX_KNOCKOUT_PROBABILITY && utility > bestUtility) {
      bestUtility = utility;
      bestMultiplier = mult;
      bestMetrics = {
        probTP,
        probSL,
        probOther: 1 - probTP - probSL,
        avgProfit,
        avgLossOnSLHit,
        ev,
        evOverStake: ev / stake,
        utility,
      };
    }
  }

  if (!bestMultiplier) {
    logger.info(
      `[Opportunity] ${symbol} NO_TRADE NO_VALID_MULTIPLIER — ` +
      `direction=${direction} stake=${stake.toFixed(2)} ` +
      `tpDist=${tpDist.toFixed(6)} slDist=${slDist.toFixed(6)} ` +
      `paths=${paths.length}`
    );
    return createNoTradeResponse(NO_TRADE_REASONS.NO_VALID_MULTIPLIER, 'No multiplier yielded positive EV with acceptable knockout probability.', prediction);
  }

  // [FILE-6I] Check EV/stake once on selected multiplier
  if (bestMetrics.evOverStake < CONFIG.MIN_EV_OVER_STAKE) {
    logger.info(
      `[Opportunity] ${symbol} NO_TRADE LOW_EV_OVER_STAKE — ` +
      `selected=${bestMultiplier}x evOverStake=${bestMetrics.evOverStake.toFixed(5)} ` +
      `threshold=${CONFIG.MIN_EV_OVER_STAKE}`
    );
    return createNoTradeResponse(NO_TRADE_REASONS.LOW_EV_OVER_STAKE, `EV/stake ${bestMetrics.evOverStake.toFixed(5)} below threshold.`, prediction);
  }

  // ---- [FILE-6L] Duration ----
  const duration = Math.max(
    CONFIG.MIN_DURATION_SEC,
    Math.min(CONFIG.MAX_DURATION_SEC, Math.round((timeToMaxFavorable || 5) * 60))
  );

  // ---- Risk engine gate ----
  try {
    const riskCheck = await riskEngine.validateTrade({
      symbol,
      direction,
      stake,
      multiplier: bestMultiplier,
      duration,
      knockoutLevel,
      takeProfitLevel,
      account,
      openPositions,
      marketData,
    });
    if (!riskCheck.approved) {
      const reason = riskCheck.reason === 'EXPOSURE_LIMIT' ? NO_TRADE_REASONS.RISK_LIMIT_EXCEEDED :
                     riskCheck.reason === 'CORRELATED' ? NO_TRADE_REASONS.CORRELATED_EXPOSURE :
                     NO_TRADE_REASONS.RISK_LIMIT_EXCEEDED;
      logger.info(`[Opportunity] ${symbol} NO_TRADE ${reason} — ${riskCheck.message || riskCheck.reason || 'risk rejection'}`);
      return createNoTradeResponse(reason, riskCheck.message || 'Risk validation failed', prediction);
    }
  } catch (err) {
    logger.error(`[Opportunity] ${symbol} risk engine error: ${err.message}`);
    return createNoTradeResponse(NO_TRADE_REASONS.MODEL_UNCERTAINTY, `Risk engine error: ${err.message}`, prediction);
  }

  // ---- All checks passed ----
  logger.info(
    `[Opportunity] ${symbol} TRADE ${direction} ` +
    `${bestMultiplier}x stake=${stake.toFixed(2)} ` +
    `probTP=${(bestMetrics.probTP*100).toFixed(0)}% probSL=${(bestMetrics.probSL*100).toFixed(0)}% ` +
    `ev=${bestMetrics.ev.toFixed(2)} evOverStake=${(bestMetrics.evOverStake*100).toFixed(2)}% ` +
    `entry=${entryPrice.toFixed(5)} tp=${takeProfitLevel.toFixed(5)} ko=${knockoutLevel.toFixed(5)} ` +
    `duration=${duration}s`
  );

  return {
    tradable: true,
    reason: `Selected ${bestMultiplier}x (EV: ${bestMetrics.ev.toFixed(2)}, KO prob: ${(bestMetrics.probSL*100).toFixed(1)}%)`,
    prediction,
    direction,
    stake,
    multiplier: bestMultiplier,
    duration,
    entryPrice,
    knockoutLevel,
    takeProfitLevel,
    probabilities: { up, down, neutral },
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
      riskRewardRatio: (tpDist / slDist),
    },
    decision: 'TRADE',
    timestamp: new Date().toISOString(),
  };
}

function createNoTradeResponse(reason, message, prediction = null) {
  return {
    tradable: false,
    reason: reason,
    message: message,
    prediction: prediction,
    decision: 'NO_TRADE',
    timestamp: new Date().toISOString(),
    stake: 0,
    multiplier: 0,
    duration: 0,
    entryPrice: null,
    knockoutLevel: null,
    takeProfitLevel: null,
    tradeEconomics: {
      probTP: 0,
      probSL: 0,
      probOther: 0,
      expectedProfit: 0,
      expectedLoss: 0,
      ev: 0,
      evOverStake: 0,
    },
    riskMetrics: {
      maxLoss: 0,
      targetProfit: 0,
      riskRewardRatio: 0,
    },
  };
}

module.exports = {
  evaluate,
  createNoTradeResponse,
  CONFIG,
  NO_TRADE_REASONS,
};
