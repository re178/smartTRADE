// core/intelligence/opportunityEngine.js
// Opportunity Engine – Evaluates whether a Prediction is tradable.
// Uses historical analogue paths to estimate real probabilities of TP/SL.
// Evaluates candidate multipliers and selects the best risk‑adjusted opportunity.
// Outputs TRADE / NO TRADE with detailed reason taxonomy.

const riskEngine = require('../risk/riskEngine');
const { getPipSize } = require('../../shared/helpers');
const logger = require('../../infrastructure/logger') || console;

// Configuration
const CONFIG = {
  // Minimum calibrated confidence required
  MIN_CONFIDENCE: 55,
  // Minimum EV (in absolute currency) required
  MIN_EV: 0.0,
  // Minimum EV / stake ratio (percentage)
  MIN_EV_OVER_STAKE: 0.02, // 2%
  // Maximum MAE (as fraction of expected move) – used for basic filter
  MAX_MAE_RATIO: 0.8,
  // Minimum effective sample size
  MIN_EFFECTIVE_SAMPLE: 15,
  // Minimum qualified analogue count
  MIN_QUALIFIED_COUNT: 20,
  // Maximum allowable distance (weighted average)
  MAX_WEIGHTED_DISTANCE: 0.30,
  // Minimum market quality
  MIN_MARKET_QUALITY: 40,
  // Maximum spread (in pips)
  MAX_SPREAD_PIPS: 2.0,
  // Candidate multipliers to evaluate
  CANDIDATE_MULTIPLIERS: [2, 3, 5, 10, 15, 20, 30],
  // Maximum allowable knockout probability (for the chosen multiplier)
  MAX_KNOCKOUT_PROBABILITY: 0.30,
  // TP multiplier (relative to expected favorable move) – will be derived from path distribution
  TP_PERCENTILE: 0.70, // use 70th percentile of MFE distribution as TP
  SL_PERCENTILE: 0.30, // use 30th percentile of MAE distribution as SL
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
};

/**
 * Evaluate a Prediction and determine if it is tradable.
 * @param {Object} prediction - Prediction object from predictionEngine.
 * @param {Object} account - Account object (balance, currency, etc.).
 * @param {Array} openPositions - Array of open positions.
 * @param {Object} marketData - Current market data (spread, price, etc.).
 * @param {Object} riskConfig - Risk configuration (max risk per trade, etc.).
 * @returns {Promise<Object>} TradeOpportunity object.
 */
async function evaluate(prediction, account, openPositions, marketData, riskConfig = {}) {
  // 1. Validate inputs
  if (!prediction) {
    return createNoTradeResponse(NO_TRADE_REASONS.MODEL_UNCERTAINTY, 'No prediction provided.');
  }

  // 2. Extract key values with safe defaults
  const {
    symbol = 'UNKNOWN',
    timeframe = 'M5',
    probabilities = { up: 0, down: 0, neutral: 0 },
    expectedMove = 0,
    expectedAdverse = 0,
    expectedFavorable = 0,
    mfe = 0,
    mae = 0,
    sampleSize = 0,
    effectiveSampleSize = 0,
    qualifiedCount = 0,
    weightedAverageDistance = 0,
    averageDistance = 0,
    calibratedConfidence = 50,
    marketQuality = 50,
    noiseLevel = 'medium',
    timeToMaxFavorable = null,
    timeToMaxAdverse = null,
    analogues = [],
    // Other fields from new prediction
    candidateCount = 0,
    distanceDistribution = {},
  } = prediction;

  const { up = 0, down = 0, neutral = 0 } = probabilities;

  // 3. Basic quality filters (first gate)
  const reasons = [];

  if (calibratedConfidence < CONFIG.MIN_CONFIDENCE) {
    reasons.push(NO_TRADE_REASONS.LOW_CONFIDENCE);
  }

  const maxProb = Math.max(up, down);
  if (maxProb < 0.55) {
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

  if (Math.abs(expectedMove) < 0.0001) {
    reasons.push(NO_TRADE_REASONS.LOW_EXPECTED_MOVE);
  }

  const maeRatio = Math.abs(expectedAdverse) / (Math.abs(expectedMove) || 0.0001);
  if (maeRatio > CONFIG.MAX_MAE_RATIO) {
    reasons.push(NO_TRADE_REASONS.HIGH_MAE_RATIO);
  }

  if (reasons.length > 0) {
    return createNoTradeResponse(reasons[0], `Failed basic checks: ${reasons.join(', ')}`, prediction);
  }

  // 4. Determine trade direction
  const direction = up > down ? 'BUY' : (down > up ? 'SELL' : 'NO_TRADE');
  if (direction === 'NO_TRADE') {
    return createNoTradeResponse(NO_TRADE_REASONS.UNCERTAIN_DIRECTION, 'Direction uncertain (up≈down).', prediction);
  }

  // 5. Compute trade entry
  const entryPrice = marketData?.currentPrice || 0;
  if (!entryPrice) {
    return createNoTradeResponse(NO_TRADE_REASONS.MODEL_UNCERTAINTY, 'No entry price available.', prediction);
  }

  // 6. Extract analogue paths (futurePrices)
  // Each analogue: { distance, mfe, mae, outcome, timestamp, weight, futurePrices }
  // futurePrices is an object with keys 5,10,20,40 (arrays of prices)
  // We'll use the lookahead from prediction (default 5)
  const lookahead = prediction.timeframe === 'M5' ? 5 : (prediction.timeframe === 'M15' ? 15 : 5);
  const paths = analogues
    .map(a => {
      const prices = a.futurePrices?.[lookahead];
      if (!prices || !prices.length) return null;
      return {
        prices,
        weight: a.weight || 1.0,
        mfe: a.mfe,
        mae: a.mae,
      };
    })
    .filter(p => p !== null);

  if (paths.length < CONFIG.MIN_QUALIFIED_COUNT) {
    return createNoTradeResponse(NO_TRADE_REASONS.LOW_SAMPLE_SIZE, `Not enough valid paths (${paths.length}).`, prediction);
  }

  // 7. Determine TP and SL levels from path distribution
  // Compute weighted percentiles of MFE and MAE from analogue paths
  const mfeValues = paths.map(p => p.mfe).filter(v => v !== null && v !== undefined);
  const maeValues = paths.map(p => p.mae).filter(v => v !== null && v !== undefined);

  if (mfeValues.length < 10 || maeValues.length < 10) {
    return createNoTradeResponse(NO_TRADE_REASONS.LOW_SAMPLE_SIZE, 'Insufficient MFE/MAE data.', prediction);
  }

  // Sort and weight
  const mfeSorted = mfeValues.sort((a, b) => a - b);
  const maeSorted = maeValues.sort((a, b) => a - b);

  const tpLevel = direction === 'BUY'
    ? entryPrice + mfeSorted[Math.floor(mfeSorted.length * CONFIG.TP_PERCENTILE)]
    : entryPrice - mfeSorted[Math.floor(mfeSorted.length * CONFIG.TP_PERCENTILE)];

  const slLevel = direction === 'BUY'
    ? entryPrice - maeSorted[Math.floor(maeSorted.length * CONFIG.SL_PERCENTILE)]
    : entryPrice + maeSorted[Math.floor(maeSorted.length * CONFIG.SL_PERCENTILE)];

  // 8. Evaluate candidate multipliers using path simulation
  const accountBalance = account?.balance ? parseFloat(account.balance) : 10000;
  const riskPerTrade = riskConfig.riskPerTradePct || 1.0;
  const baseStake = Math.min(accountBalance * (riskPerTrade / 100), accountBalance * 0.05);

  let bestMultiplier = null;
  let bestEV = -Infinity;
  let bestMetrics = null;

  for (const mult of CONFIG.CANDIDATE_MULTIPLIERS) {
    // For each multiplier, simulate all paths
    let totalProfit = 0;
    let totalWeight = 0;
    let wins = 0;
    let losses = 0;
    let hitsTP = 0;
    let hitsSL = 0;

    for (const path of paths) {
      const w = path.weight || 1.0;
      totalWeight += w;

      // Simulate trade: starting from entry, step through prices until TP or SL hit
      const prices = path.prices;
      let exitPrice = null;
      let hitTP = false;
      let hitSL = false;

      for (const price of prices) {
        if (direction === 'BUY') {
          if (price >= tpLevel) { hitTP = true; exitPrice = tpLevel; break; }
          if (price <= slLevel) { hitSL = true; exitPrice = slLevel; break; }
        } else {
          if (price <= tpLevel) { hitTP = true; exitPrice = tpLevel; break; }
          if (price >= slLevel) { hitSL = true; exitPrice = slLevel; break; }
        }
      }
      // If not exited by end of path, use final price
      if (!exitPrice) exitPrice = prices[prices.length - 1];

      // Compute P&L
      const priceChange = direction === 'BUY' ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
      const profit = baseStake * mult * (priceChange / entryPrice); // simplified: profit = stake * multiplier * percentage move
      totalProfit += profit * w;
      if (hitTP) { wins++; hitsTP++; } else if (hitSL) { losses++; hitsSL++; }
    }

    if (totalWeight === 0) continue;

    const avgProfit = totalProfit / totalWeight;
    const winRate = wins / paths.length;
    const lossRate = losses / paths.length;
    const probTP = hitsTP / paths.length;
    const probSL = hitsSL / paths.length;
    const ev = avgProfit;

    // Check if EV is positive and within risk constraints
    if (ev > CONFIG.MIN_EV && probSL < CONFIG.MAX_KNOCKOUT_PROBABILITY) {
      if (ev > bestEV) {
        bestEV = ev;
        bestMultiplier = mult;
        bestMetrics = {
          probTP,
          probSL,
          probOther: 1 - probTP - probSL,
          winRate,
          lossRate,
          avgProfit,
          ev,
          evOverStake: ev / baseStake,
          maxLoss: baseStake,
          targetProfit: baseStake * mult * ( (direction === 'BUY' ? (tpLevel - entryPrice) : (entryPrice - tpLevel)) / entryPrice ),
        };
      }
    }
  }

  // 9. Check if we found a valid multiplier
  if (!bestMultiplier) {
    return createNoTradeResponse(NO_TRADE_REASONS.NO_VALID_MULTIPLIER, 'No multiplier yielded positive EV with acceptable knockout probability.', prediction);
  }

  // 10. Risk engine checks (exposure, correlated positions, etc.)
  const stake = baseStake;
  const duration = Math.max(60, (timeToMaxFavorable || 5) * 60);
  const knockoutLevel = slLevel;
  const takeProfitLevel = tpLevel;

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
      return createNoTradeResponse(
        riskCheck.reason === 'EXPOSURE_LIMIT' ? NO_TRADE_REASONS.RISK_LIMIT_EXCEEDED :
        riskCheck.reason === 'CORRELATED' ? NO_TRADE_REASONS.CORRELATED_EXPOSURE :
        NO_TRADE_REASONS.RISK_LIMIT_EXCEEDED,
        riskCheck.message || 'Risk validation failed',
        prediction
      );
    }
  } catch (err) {
    logger.error('[OpportunityEngine] Risk engine error:', err.message);
    return createNoTradeResponse(NO_TRADE_REASONS.MODEL_UNCERTAINTY, `Risk engine error: ${err.message}`, prediction);
  }

  // 11. All checks passed – return TRADE opportunity
  return {
    tradable: true,
    reason: `Trade approved with ${bestMultiplier}x multiplier (EV: ${bestEV.toFixed(2)})`,
    prediction,
    direction,
    stake,
    multiplier: bestMultiplier,
    duration,
    entryPrice,
    knockoutLevel,
    takeProfitLevel,
    probabilities: {
      up,
      down,
      neutral,
    },
    tradeEconomics: {
      probTP: bestMetrics.probTP,
      probSL: bestMetrics.probSL,
      probOther: bestMetrics.probOther,
      expectedProfit: bestMetrics.avgProfit,
      expectedLoss: bestMetrics.avgProfit < 0 ? -bestMetrics.avgProfit : 0, // we only use positive EV
      ev: bestMetrics.ev,
      evOverStake: bestMetrics.evOverStake,
    },
    riskMetrics: {
      maxLoss: stake,
      targetProfit: bestMetrics.targetProfit,
      riskRewardRatio: bestMetrics.targetProfit / stake,
    },
    decision: 'TRADE',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create a NO TRADE response.
 * @param {string} reason - NO_TRADE_REASONS code.
 * @param {string} message - Human-readable message.
 * @param {Object} prediction - Prediction object (optional).
 * @returns {Object} TradeOpportunity with tradable: false.
 */
function createNoTradeResponse(reason, message, prediction = null) {
  return {
    tradable: false,
    reason: reason,
    message: message,
    prediction: prediction,
    decision: 'NO_TRADE',
    timestamp: new Date().toISOString(),
    // Provide defaults for fields that might be expected
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

/**
 * Get the NO TRADE reason taxonomy (for reference).
 */
function getNoTradeReasons() {
  return { ...NO_TRADE_REASONS };
}

module.exports = {
  evaluate,
  createNoTradeResponse,
  getNoTradeReasons,
  CONFIG,
  NO_TRADE_REASONS,
};
