// core/intelligence/opportunityEngine.js
// Opportunity Engine – Evaluates whether a Prediction is tradable.
// Computes Expected Value, probability of TP/SL, and recommends trade parameters.
// Outputs TRADE / NO TRADE with detailed reason taxonomy.

const { getNoTradeReason } = require('./predictionEngine');
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
  // Maximum MAE (as fraction of expected move)
  MAX_MAE_RATIO: 0.8,
  // Minimum sample size
  MIN_SAMPLE_SIZE: 20,
  // Maximum allowable distance (lower = more similar)
  MAX_SIMILARITY_DISTANCE: 0.30,
  // Minimum market quality
  MIN_MARKET_QUALITY: 40,
  // Maximum spread (in pips)
  MAX_SPREAD_PIPS: 2.0,
  // Maximum volatility (ATR %)
  MAX_VOLATILITY_PCT: 0.03, // 3%
  // Minimum expected move (in price units)
  MIN_EXPECTED_MOVE: 0.0001,
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
};

/**
 * Evaluate a Prediction and determine if it is tradable.
 * @param {Object} prediction - Prediction object from predictionEngine.
 * @param {Object} account - Account object (balance, currency, etc.).
 * @param {Object} openPositions - Array of open positions.
 * @param {Object} marketData - Current market data (spread, price, etc.).
 * @param {Object} riskConfig - Risk configuration (max risk per trade, etc.).
 * @returns {Promise<Object>} TradeOpportunity object.
 */
async function evaluate(prediction, account, openPositions, marketData, riskConfig = {}) {
  // 1. Validate inputs
  if (!prediction) {
    return createNoTradeResponse(NO_TRADE_REASONS.MODEL_UNCERTAINTY, 'No prediction provided.');
  }

  // 2. Extract key values
  const {
    symbol,
    timeframe,
    probabilities,
    expectedMove,
    expectedAdverse,
    expectedFavorable,
    mfe,
    mae,
    sampleSize,
    averageSimilarity,
    maxDistance,
    calibratedConfidence,
    marketQuality,
    noiseLevel,
  } = prediction;

  const { up, down, neutral } = probabilities;

  // 3. Check basic thresholds (first gate)
  const reasons = [];

  // 3a. Confidence check
  if (calibratedConfidence < CONFIG.MIN_CONFIDENCE) {
    reasons.push(NO_TRADE_REASONS.LOW_CONFIDENCE);
  }

  // 3b. Direction uncertainty
  const maxProb = Math.max(up, down);
  if (maxProb < 0.55) {
    reasons.push(NO_TRADE_REASONS.UNCERTAIN_DIRECTION);
  }

  // 3c. Sample size
  if (sampleSize < CONFIG.MIN_SAMPLE_SIZE) {
    reasons.push(NO_TRADE_REASONS.LOW_SAMPLE_SIZE);
  }

  // 3d. Similarity quality
  if (averageSimilarity > CONFIG.MAX_SIMILARITY_DISTANCE) {
    reasons.push(NO_TRADE_REASONS.POOR_SIMILARITY);
  }

  // 3e. Market quality
  if (marketQuality < CONFIG.MIN_MARKET_QUALITY) {
    reasons.push(NO_TRADE_REASONS.LOW_MARKET_QUALITY);
  }

  // 3f. Expected move
  if (Math.abs(expectedMove) < CONFIG.MIN_EXPECTED_MOVE) {
    reasons.push(NO_TRADE_REASONS.LOW_EXPECTED_MOVE);
  }

  // 3g. MAE ratio (adverse movement relative to expected)
  const maeRatio = Math.abs(expectedAdverse) / (Math.abs(expectedMove) || 0.0001);
  if (maeRatio > CONFIG.MAX_MAE_RATIO) {
    reasons.push(NO_TRADE_REASONS.HIGH_MAE_RATIO);
  }

  // 4. If any critical reasons exist, return NO TRADE immediately
  if (reasons.length > 0) {
    return createNoTradeResponse(reasons[0], `Failed basic checks: ${reasons.join(', ')}`, prediction);
  }

  // 5. Determine trade direction
  const direction = up > down ? 'BUY' : (down > up ? 'SELL' : 'NO_TRADE');
  if (direction === 'NO_TRADE') {
    return createNoTradeResponse(NO_TRADE_REASONS.UNCERTAIN_DIRECTION, 'Direction uncertain (up≈down).', prediction);
  }

  // 6. Compute trade economics
  const entryPrice = marketData.currentPrice || prediction.entryPrice;
  const pipSize = getPipSize(symbol);

  // 6a. Estimate TP and SL levels based on expected moves
  const moveAmount = Math.abs(expectedMove);
  const adverseAmount = Math.abs(expectedAdverse) * 1.2; // buffer

  let takeProfitLevel, knockoutLevel;
  if (direction === 'BUY') {
    takeProfitLevel = entryPrice + moveAmount * 1.5;
    knockoutLevel = entryPrice - adverseAmount * 1.2;
  } else {
    takeProfitLevel = entryPrice - moveAmount * 1.5;
    knockoutLevel = entryPrice + adverseAmount * 1.2;
  }

  // 7. Calculate stake via risk engine
  const accountBalance = parseFloat(account.balance) || 10000;
  const riskPerTrade = riskConfig.riskPerTradePct || 1.0; // 1% default

  // Simple stake calculation: risk % of balance, capped by max loss
  const maxLossAmount = accountBalance * (riskPerTrade / 100);
  const stake = Math.min(maxLossAmount, accountBalance * 0.05); // cap at 5% of balance

  // 8. Calculate multiplier based on expected move and target profit
  const targetProfit = stake * 0.5; // target 50% return on stake
  const expectedPriceMove = Math.abs(expectedMove);
  const multiplier = Math.min(100, Math.max(2, Math.floor(targetProfit / (stake * expectedPriceMove))));

  // 9. Calculate duration based on time to extremes
  const timeToMaxFavorable = prediction.timeToMaxFavorable || 5;
  const duration = Math.max(60, timeToMaxFavorable * 60); // at least 1 minute, convert candles to seconds

  // 10. Compute probability of TP and SL
  const probTP = up * 0.7 + (1 - up) * 0.1;
  const probSL = (1 - up) * 0.6 + up * 0.1;
  const probOther = 1 - probTP - probSL;

  // 11. Compute Expected Value (EV)
  const expectedProfit = probTP * (stake * multiplier * 0.5);
  const expectedLoss = probSL * stake;
  const ev = expectedProfit - expectedLoss;

  // 12. Additional checks based on EV
  if (ev <= CONFIG.MIN_EV) {
    reasons.push(NO_TRADE_REASONS.NEGATIVE_EV);
  }

  const evOverStake = ev / stake;
  if (evOverStake < CONFIG.MIN_EV_OVER_STAKE) {
    reasons.push(NO_TRADE_REASONS.LOW_EV_OVER_STAKE);
  }

  if (reasons.length > 0) {
    return createNoTradeResponse(reasons[0], `EV checks failed: ${reasons.join(', ')}`, prediction);
  }

  // 13. Risk engine checks (exposure, correlated positions, etc.)
  try {
    const riskCheck = await riskEngine.validateTrade({
      symbol,
      direction,
      stake,
      multiplier,
      duration,
      knockoutLevel,
      takeProfitLevel,
      account,
      openPositions,
    });
    if (!riskCheck.approved) {
      return createNoTradeResponse(
        riskCheck.reason === 'EXPOSURE_LIMIT' ? NO_TRADE_REASONS.RISK_LIMIT_EXCEEDED :
        riskCheck.reason === 'CORRELATED' ? NO_TRADE_REASONS.CORRELATED_EXPOSURE :
        NO_TRADE_REASONS.RISK_LIMIT_EXCEEDED,
        riskCheck.message,
        prediction
      );
    }
  } catch (err) {
    logger.error('[OpportunityEngine] Risk engine error:', err.message);
    return createNoTradeResponse(NO_TRADE_REASONS.MODEL_UNCERTAINTY, `Risk engine error: ${err.message}`, prediction);
  }

  // 14. All checks passed – return TRADE opportunity
  return {
    tradable: true,
    reason: 'All checks passed. Trade approved.',
    prediction,
    direction,
    stake,
    multiplier,
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
      probTP,
      probSL,
      probOther,
      expectedProfit,
      expectedLoss,
      ev,
      evOverStake,
    },
    riskMetrics: {
      maxLoss: stake,
      targetProfit: stake * multiplier * 0.5,
      riskRewardRatio: (stake * multiplier * 0.5) / stake,
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
