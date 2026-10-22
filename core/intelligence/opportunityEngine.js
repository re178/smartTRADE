// core/intelligence/opportunityEngine.js – Trade Filter
// Evaluates whether a prediction is tradeable and selects the best
// multiplier. Uses path simulation when analogues are available;
// uses strategy-derived EV when they aren't.
//
// [FILE-6] Strategy integration:
//   • modeLabel='conflict'  → immediate NO_TRADE, reason STRATEGY_CONFLICT
//   • modeLabel='strategy_only' → new evaluateStrategyOnly() path:
//       - requires 2+ agreeing strategies
//       - requires consensus confidence >= MIN_CONFIDENCE
//       - requires valid strategyLevels (entry/stop/target present and ordered)
//       - computes probTP from consensus confidence (conservative, capped)
//       - computes EV per multiplier from TP/SL distances × probTP
//       - does NOT require analogue sample size
//   • modeLabel='combined' → uses path simulation but prefers strategyLevels
//       for TP/SL prices when present (more precise than MFE percentiles)
//       - probSL threshold relaxed from 50% to 45% (stronger evidence)
//   • modeLabel='analogue_only' / 'silent' / 'no_data' → NO_TRADE
//       with clear reason
//
// All existing path-simulation, multiplier selection, and risk gating
// logic preserved for the analogue and combined paths.

const riskEngine = require('../risk/riskEngine');
const { getPipSize } = require('../../shared/helpers');
const logger = require('../../infrastructure/logger') || console;

// ---- Configuration ----
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
  MAX_KNOCKOUT_PROBABILITY: 0.50,           // analogue-only path
  MAX_KNOCKOUT_PROBABILITY_COMBINED: 0.45,  // combined path (tighter, evidence is stronger)
  TP_MULTIPLIER: 1.5,
  SL_MULTIPLIER: 1.2,
  RISK_AVERSION: 2.0,
  MIN_PATHS: 10,

  MIN_DURATION_SEC: 60,
  MAX_DURATION_SEC: 900,

  // [FILE-6] Strategy-only gate thresholds
  STRATEGY_ONLY_MIN_AGREEING: 2,
  STRATEGY_ONLY_CONFIDENCE_FLOOR: 0.35,  // clamp probTP lower bound
  STRATEGY_ONLY_CONFIDENCE_CEIL: 0.75,   // clamp probTP upper bound
  STRATEGY_ONLY_NEUTRAL_BUFFER: 0.10,    // 10% of paths assumed neutral
  STRATEGY_ONLY_MAX_STAKE_PCT: 0.03,     // 3% of balance (lower than analogue)
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
  // [FILE-6]
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

  // ---- 1. Conflict rejection (highest priority) ----
  if (modeLabel === 'conflict' || source === 'conflict') {
    const reasons = prediction.strategyConsensus?.reasons || [];
    logger.info(
      `[Opportunity] ${prediction.symbol} NO_TRADE STRATEGY_CONFLICT — ` +
      `${prediction.strategyConsensus?.agreeing?.length || 0} agree vs ` +
      `${prediction.strategyConsensus?.conflicting?.length || 0} disagree. ` +
      `Reasons: ${reasons.join('; ')}`
    );
    return createNoTradeResponse(
      NO_TRADE_REASONS.STRATEGY_CONFLICT,
      'Analogue and strategy signals disagree',
      prediction
    );
  }

  // ---- 2. No data ----
  if (modeLabel === 'no_data') {
    return createNoTradeResponse(
      NO_TRADE_REASONS.NO_DATA,
      'No analogue data and no strategy consensus',
      prediction
    );
  }

  // ---- 3. Direction must be set ----
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

  // ---- 4. Common pre-checks (apply to all paths) ----
  const preCheck = preCheckCommon(prediction, account, marketData);
  if (preCheck) return preCheck;

  // ---- 5. Route by mode ----
  if (modeLabel === 'strategy_only') {
    return evaluateStrategyOnly(prediction, account, openPositions, marketData, riskConfig);
  }

  // 'combined' and 'analogue_only' both use path simulation
  return evaluateWithPaths(
    prediction,
    account,
    openPositions,
    marketData,
    riskConfig,
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
    return createNoTradeResponse(
      NO_TRADE_REASONS.NO_DATA,
      'Strategy-only mode but no consensus data',
      prediction
    );
  }

  // ---- Require 2+ agreeing strategies ----
  const agreeingCount = (consensus.agreeing || []).length;
  if (agreeingCount < CONFIG.STRATEGY_ONLY_MIN_AGREEING) {
    logger.info(
      `[Opportunity] ${prediction.symbol} NO_TRADE STRATEGY_WEAK — ` +
      `only ${agreeingCount} strategy(ies) agree (need ${CONFIG.STRATEGY_ONLY_MIN_AGREEING})`
    );
    return createNoTradeResponse(
      NO_TRADE_REASONS.STRATEGY_WEAK,
      `Strategy-only requires ${CONFIG.STRATEGY_ONLY_MIN_AGREEING}+ agreeing strategies, got ${agreeingCount}`,
      prediction
    );
  }

  // ---- Validate strategyLevels ----
  const levels = prediction.strategyLevels;
  if (!levels || !Number.isFinite(levels.entry) || !Number.isFinite(levels.stop) || !Number.isFinite(levels.target)) {
    logger.info(
      `[Opportunity] ${prediction.symbol} NO_TRADE INVALID_STRATEGY_LEVELS — ` +
      `levels=${JSON.stringify(levels)}`
    );
    return createNoTradeResponse(
      NO_TRADE_REASONS.INVALID_STRATEGY_LEVELS,
      'Strategy consensus fired but price levels are missing',
      prediction
    );
  }

  const entry = levels.entry;
  const stop = levels.stop;
  const target = levels.target;
  const direction = prediction.direction;

  // ---- Validate level ordering ----
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

  // ---- Stake sizing (lower cap for strategy-only) ----
  const balance = account?.balance ? parseFloat(account.balance) : 10000;
  const riskPerTrade = riskConfig.riskPerTradePct || 1.0;
  const stake = Math.max(
    0.5,
    Math.min(
      balance * (riskPerTrade / 100),
      balance * CONFIG.STRATEGY_ONLY_MAX_STAKE_PCT
    )
  );

  // ---- Probabilities from strategy consensus confidence ----
  // Consensus confidence is the ranker's blend of historical win rates
  // and signal strength. It is a reasonable proxy for "how often this
  // pattern wins". Clamp to avoid overconfidence.
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

  // ---- Multiplier selection ----
  let bestMultiplier = null;
  let bestMetrics = null;
  let bestEv = -Infinity;

  for (const mult of CONFIG.CANDIDATE_MULTIPLIERS) {
    const profitTP = stake * mult * (targetDist / entry);
    const lossSL = stake * mult * (stopDist / entry);
    const ev = probTP * profitTP - probSL * lossSL;
    const evOverStake = ev / stake;

    if (ev > CONFIG.MIN_EV && evOverStake >= CONFIG.MIN_EV_OVER_STAKE && ev > bestEv) {
      bestEv = ev;
      bestMultiplier = mult;
      bestMetrics = {
        probTP, probSL, probNeutral,
        profitTP, lossSL,
        ev, evOverStake,
        targetDist, stopDist,
      };
    }
  }

  if (!bestMultiplier) {
    logger.info(
      `[Opportunity] ${prediction.symbol} NO_TRADE NO_VALID_MULTIPLIER — ` +
      `strategy-only, probTP=${probTP.toFixed(2)} targetDist=${targetDist.toFixed(5)} stopDist=${stopDist.toFixed(5)}`
    );
    return createNoTradeResponse(
      NO_TRADE_REASONS.NO_VALID_MULTIPLIER,
      `No multiplier yielded EV/stake >= ${CONFIG.MIN_EV_OVER_STAKE}`,
      prediction
    );
  }

  // ---- Duration from strategy anchor signal (default 300s) ----
  const anchorSig = consensus.anchorSignal;
  const rawDuration = anchorSig?.duration || 300;
  const duration = Math.max(
    CONFIG.MIN_DURATION_SEC,
    Math.min(CONFIG.MAX_DURATION_SEC, Math.round(rawDuration))
  );

  // ---- Risk engine gate ----
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
      logger.info(
        `[Opportunity] ${prediction.symbol} NO_TRADE ${reason} — ` +
        `${riskCheck.message || riskCheck.reason}`
      );
      return createNoTradeResponse(reason, riskCheck.message || 'Risk validation failed', prediction);
    }
  } catch (err) {
    logger.error(`[Opportunity] ${prediction.symbol} risk engine error: ${err.message}`);
    return createNoTradeResponse(
      NO_TRADE_REASONS.MODEL_UNCERTAINTY,
      `Risk engine error: ${err.message}`,
      prediction
    );
  }

  // ---- All checks passed ----
  logger.info(
    `[Opportunity] ${prediction.symbol} TRADE ${direction} (STRATEGY_ONLY) ` +
    `${bestMultiplier}x stake=${stake.toFixed(2)} ` +
    `agree=[${(consensus.agreeing || []).join(',')}] ` +
    `probTP=${(probTP*100).toFixed(0)}% probSL=${(probSL*100).toFixed(0)}% ` +
    `ev=${bestMetrics.ev.toFixed(2)} evOverStake=${(bestMetrics.evOverStake*100).toFixed(2)}% ` +
    `entry=${entry.toFixed(5)} tp=${target.toFixed(5)} ko=${stop.toFixed(5)} ` +
    `duration=${duration}s`
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
// Path-based evaluation (combined or analogue_only)
// ========================================================================
async function evaluateWithPaths(prediction, account, openPositions, marketData, riskConfig, mode) {
  const {
    symbol = 'UNKNOWN',
    direction = 'NEUTRAL',
    probabilities = { up: 0, down: 0, neutral: 0 },
    calibratedConfidence = 50,
    effectiveSampleSize = 0,
    qualifiedCount = 0,
    weightedAverageDistance = 0,
    expectedMove = 0,
    expectedFavorable = 0,
    expectedAdverse = 0,
    timeToMaxFavorable = 5,
    analogues = [],
  } = prediction;

  const { up = 0, down = 0 } = probabilities;

  // ---- Sample-size gates (mode-specific) ----
  const isCombined = mode === 'combined';

  if (!isCombined) {
    // Analogue-only: original strict gates
    const maxProb = Math.max(up, down);
    if (maxProb < 0.50) {
      return createNoTradeResponse(
        NO_TRADE_REASONS.UNCERTAIN_DIRECTION,
        `max probability ${maxProb.toFixed(2)} below 0.50`,
        prediction
      );
    }
    if (effectiveSampleSize < CONFIG.MIN_EFFECTIVE_SAMPLE || qualifiedCount < CONFIG.MIN_QUALIFIED_COUNT) {
      logger.info(
        `[Opportunity] ${symbol} NO_TRADE LOW_SAMPLE_SIZE — ` +
        `ESS=${effectiveSampleSize.toFixed(1)} qual=${qualifiedCount}`
      );
      return createNoTradeResponse(
        NO_TRADE_REASONS.LOW_SAMPLE_SIZE,
        `Insufficient analogue data`,
        prediction
      );
    }
    if (weightedAverageDistance > CONFIG.MAX_WEIGHTED_DISTANCE) {
      return createNoTradeResponse(
        NO_TRADE_REASONS.POOR_SIMILARITY,
        `Weighted distance ${weightedAverageDistance.toFixed(2)} above ${CONFIG.MAX_WEIGHTED_DISTANCE}`,
        prediction
      );
    }
  } else {
    // Combined: strategy + analogue both have data; sample-size gates relaxed
    // but still require some analogue presence
    if (effectiveSampleSize < 5 && qualifiedCount < 5) {
      logger.info(
        `[Opportunity] ${symbol} NO_TRADE LOW_SAMPLE_SIZE — ` +
        `combined mode but ESS=${effectiveSampleSize.toFixed(1)} qual=${qualifiedCount}`
      );
      return createNoTradeResponse(
        NO_TRADE_REASONS.LOW_SAMPLE_SIZE,
        'Combined mode requires at least minimal analogue data',
        prediction
      );
    }
  }

  if (Math.abs(expectedMove) < 0.0001) {
    return createNoTradeResponse(
      NO_TRADE_REASONS.LOW_EXPECTED_MOVE,
      `expectedMove ${expectedMove.toFixed(6)} too small`,
      prediction
    );
  }

  const maeRatio = Math.abs(expectedAdverse) / (Math.abs(expectedMove) || 0.0001);
  if (maeRatio > 0.8) {
    return createNoTradeResponse(
      NO_TRADE_REASONS.HIGH_MAE_RATIO,
      `maeRatio ${maeRatio.toFixed(2)} above 0.8`,
      prediction
    );
  }

  // ---- Extract paths ----
  const lookahead = prediction.timeframe === 'M5' ? 5 : (prediction.timeframe === 'M15' ? 15 : 5);
  const paths = (analogues || [])
    .map(a => {
      const prices = a.futurePrices?.[lookahead];
      if (!prices || prices.length < 2) return null;
      return { prices, weight: a.totalWeight || 1.0, mfe: a.mfe, mae: a.mae };
    })
    .filter(p => p !== null);

  if (paths.length < CONFIG.MIN_PATHS) {
    return createNoTradeResponse(
      NO_TRADE_REASONS.INSUFFICIENT_PATHS,
      `Only ${paths.length} valid analogue paths`,
      prediction
    );
  }

  // ---- TP/SL: prefer strategyLevels when available (combined mode) ----
  let tpDist, slDist;
  let usingStrategyLevels = false;

  if (isCombined && prediction.strategyLevels) {
    const lv = prediction.strategyLevels;
    const entry = marketData?.currentPrice || prediction.entryPrice || lv.entry;
    if (
      Number.isFinite(lv.target) && Number.isFinite(lv.stop) && Number.isFinite(entry) &&
      ((direction === 'BUY' && lv.stop < entry && lv.target > entry) ||
       (direction === 'SELL' && lv.stop > entry && lv.target < entry))
    ) {
      tpDist = Math.abs(lv.target - entry);
      slDist = Math.abs(lv.stop - entry);
      usingStrategyLevels = true;
    }
  }

  if (!usingStrategyLevels) {
    // Fall back to expectedFavorable/Adverse
    const favorable = Math.abs(expectedFavorable || 0);
    const adverse = Math.abs(expectedAdverse || 0);
    if (favorable <= 0 || adverse <= 0) {
      return createNoTradeResponse(
        NO_TRADE_REASONS.LOW_EXPECTED_MOVE,
        `Missing favorable/adverse estimates`,
        prediction
      );
    }
    tpDist = favorable * CONFIG.TP_MULTIPLIER;
    slDist = adverse * CONFIG.SL_MULTIPLIER;
  }

  const entryPrice = marketData?.currentPrice || prediction.entryPrice || 0;
  if (!entryPrice || entryPrice <= 0) {
    return createNoTradeResponse(
      NO_TRADE_REASONS.MODEL_UNCERTAINTY,
      'No entry price',
      prediction
    );
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

  // ---- Multiplier selection with path simulation ----
  const maxProbSL = isCombined
    ? CONFIG.MAX_KNOCKOUT_PROBABILITY_COMBINED
    : CONFIG.MAX_KNOCKOUT_PROBABILITY;

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
        weightedSLLoss += Math.abs(profit) * w;
      }
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
      `mode=${mode} direction=${direction} stake=${stake.toFixed(2)} paths=${paths.length} ` +
      `tpDist=${tpDist.toFixed(5)} slDist=${slDist.toFixed(5)} maxProbSL=${maxProbSL}`
    );
    return createNoTradeResponse(
      NO_TRADE_REASONS.NO_VALID_MULTIPLIER,
      'No multiplier yielded positive EV with acceptable knockout probability',
      prediction
    );
  }

  if (bestMetrics.evOverStake < CONFIG.MIN_EV_OVER_STAKE) {
    logger.info(
      `[Opportunity] ${symbol} NO_TRADE LOW_EV_OVER_STAKE — ` +
      `selected=${bestMultiplier}x evOverStake=${bestMetrics.evOverStake.toFixed(5)}`
    );
    return createNoTradeResponse(
      NO_TRADE_REASONS.LOW_EV_OVER_STAKE,
      `EV/stake ${bestMetrics.evOverStake.toFixed(5)} below ${CONFIG.MIN_EV_OVER_STAKE}`,
      prediction
    );
  }

  // ---- Duration ----
  const duration = Math.max(
    CONFIG.MIN_DURATION_SEC,
    Math.min(CONFIG.MAX_DURATION_SEC, Math.round((timeToMaxFavorable || 5) * 60))
  );

  // ---- Risk engine ----
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
      const reason = mapRiskReason(riskCheck.reason);
      logger.info(`[Opportunity] ${symbol} NO_TRADE ${reason} — ${riskCheck.message || riskCheck.reason}`);
      return createNoTradeResponse(reason, riskCheck.message || 'Risk validation failed', prediction);
    }
  } catch (err) {
    logger.error(`[Opportunity] ${symbol} risk engine error: ${err.message}`);
    return createNoTradeResponse(
      NO_TRADE_REASONS.MODEL_UNCERTAINTY,
      `Risk engine error: ${err.message}`,
      prediction
    );
  }

  // ---- All checks passed ----
  logger.info(
    `[Opportunity] ${symbol} TRADE ${direction} (${mode.toUpperCase()}) ` +
    `${bestMultiplier}x stake=${stake.toFixed(2)} ` +
    `probTP=${(bestMetrics.probTP*100).toFixed(0)}% probSL=${(bestMetrics.probSL*100).toFixed(0)}% ` +
    `ev=${bestMetrics.ev.toFixed(2)} evOverStake=${(bestMetrics.evOverStake*100).toFixed(2)}% ` +
    `entry=${entryPrice.toFixed(5)} tp=${takeProfitLevel.toFixed(5)} ko=${knockoutLevel.toFixed(5)} ` +
    `duration=${duration}s${usingStrategyLevels ? ' [strategy-levels]' : ''}`
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
      : `Analogue ${bestMultiplier}x (EV: ${bestMetrics.ev.toFixed(2)}, KO prob: ${(bestMetrics.probSL*100).toFixed(1)}%)`,
    prediction,
    direction,
    stake,
    multiplier: bestMultiplier,
    duration,
    entryPrice,
    knockoutLevel,
    takeProfitLevel,
    probabilities: { up, down, neutral: probabilities.neutral || 0 },
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
    source: prediction?.source || null,
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
