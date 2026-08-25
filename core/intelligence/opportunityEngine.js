// core/intelligence/opportunityEngine.js – Trade Filter
// Uses analogues from PredictionEngine to simulate TP/SL probabilities,
// evaluates multiple multipliers, selects best risk‑adjusted one.
// Corrected MAE sign convention, weighted percentiles, path simulation,
// and risk‑adjusted utility.

const riskEngine = require('../risk/riskEngine');
const { getPipSize } = require('../../shared/helpers');
const logger = require('../../infrastructure/logger') || console;

// ---- Configuration ----
const CONFIG = {
  // Quality filters
  MIN_CONFIDENCE: 55,
  MIN_EV: 0.0,
  MIN_EV_OVER_STAKE: 0.02,
  MIN_EFFECTIVE_SAMPLE: 15,
  MIN_QUALIFIED_COUNT: 20,
  MAX_WEIGHTED_DISTANCE: 0.30,
  MIN_MARKET_QUALITY: 40,
  MAX_SPREAD_PIPS: 2.0,

  // Multiplier selection
  CANDIDATE_MULTIPLIERS: [2, 3, 5, 10, 15, 20, 30],
  MAX_KNOCKOUT_PROBABILITY: 0.30,   // maximum acceptable probability of hitting knockout
  TP_PERCENTILE: 0.70,              // percentile of MFE distribution for TP
  SL_PERCENTILE: 0.30,              // percentile of MAE distribution for SL
  RISK_AVERSION: 2.0,               // penalty factor for knockout probability in utility

  // Minimum number of paths required for simulation
  MIN_PATHS: 10,
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

  // 2. Extract key values from prediction
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
    analogues = [], // contains futurePrices, mfe, mae, totalWeight, etc.
  } = prediction;

  const { up = 0, down = 0, neutral = 0 } = probabilities;

  // 3. Basic quality filters
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

  // Check spread if marketData provided
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

  // MAE ratio: adverse vs expected move (using directional-specific adverse)
  const maeRatio = Math.abs(expectedAdverse) / (Math.abs(expectedMove) || 0.0001);
  if (maeRatio > 0.8) {
    reasons.push(NO_TRADE_REASONS.HIGH_MAE_RATIO);
  }

  if (reasons.length > 0) {
    return createNoTradeResponse(reasons[0], `Basic checks failed: ${reasons.join(', ')}`, prediction);
  }

  // 4. If direction is neutral, no trade
  if (direction === 'NEUTRAL') {
    return createNoTradeResponse(NO_TRADE_REASONS.UNCERTAIN_DIRECTION, 'Direction is neutral.', prediction);
  }

  // 5. Extract analogue paths (futurePrices) from analogues
  const lookahead = prediction.timeframe === 'M5' ? 5 : (prediction.timeframe === 'M15' ? 15 : 5);
  const paths = analogues
    .map(a => {
      const prices = a.futurePrices?.[lookahead];
      if (!prices || !prices.length) return null;
      return {
        prices,
        weight: a.totalWeight || 1.0,
        mfe: a.mfe,
        mae: a.mae,
      };
    })
    .filter(p => p !== null);

  if (paths.length < CONFIG.MIN_PATHS) {
    return createNoTradeResponse(NO_TRADE_REASONS.INSUFFICIENT_PATHS, `Only ${paths.length} valid paths.`, prediction);
  }

  // 6. Compute TP and SL levels using weighted percentiles of MFE and MAE (positive distances)
  // MFE and MAE are stored as positive distances (we ensured that in StateStore)
  const mfeData = paths.map(p => ({ value: p.mfe, weight: p.weight })).filter(d => d.value !== null && d.value !== undefined);
  const maeData = paths.map(p => ({ value: p.mae, weight: p.weight })).filter(d => d.value !== null && d.value !== undefined);

  if (mfeData.length < 5 || maeData.length < 5) {
    return createNoTradeResponse(NO_TRADE_REASONS.LOW_SAMPLE_SIZE, 'Insufficient MFE/MAE data.', prediction);
  }

  // Weighted percentile function (local)
  function weightedPercentile(data, p) {
    const sorted = data.slice().sort((a, b) => a.value - b.value);
    const totalW = sorted.reduce((s, d) => s + d.weight, 0);
    if (totalW === 0) return 0;
    let cum = 0;
    for (const d of sorted) {
      cum += d.weight / totalW;
      if (cum >= p) return d.value;
    }
    return sorted[sorted.length - 1].value;
  }

  const tpDistance = weightedPercentile(mfeData, CONFIG.TP_PERCENTILE);
  const slDistance = weightedPercentile(maeData, CONFIG.SL_PERCENTILE);

  // Ensure positive
  const tpDist = Math.abs(tpDistance);
  const slDist = Math.abs(slDistance);

  const entryPrice = marketData?.currentPrice || 0;
  if (!entryPrice) {
    return createNoTradeResponse(NO_TRADE_REASONS.MODEL_UNCERTAINTY, 'No entry price.', prediction);
  }

  let takeProfitLevel, knockoutLevel;
  if (direction === 'BUY') {
    takeProfitLevel = entryPrice + tpDist;
    knockoutLevel = entryPrice - slDist;
  } else { // SELL
    takeProfitLevel = entryPrice - tpDist;
    knockoutLevel = entryPrice + slDist;
  }

  // 7. Determine stake from account
  const balance = account?.balance ? parseFloat(account.balance) : 10000;
  const riskPerTrade = riskConfig.riskPerTradePct || 1.0;
  const maxLossAmount = balance * (riskPerTrade / 100);
  const stake = Math.min(maxLossAmount, balance * 0.05);

  // 8. Evaluate candidate multipliers using path simulation
  let bestMultiplier = null;
  let bestUtility = -Infinity;
  let bestMetrics = null;

  for (const mult of CONFIG.CANDIDATE_MULTIPLIERS) {
    let totalProfit = 0;
    let totalWeight = 0;
    let hitsTP = 0;
    let hitsSL = 0;

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
        } else { // SELL
          if (price <= takeProfitLevel) { hitTP = true; exitPrice = takeProfitLevel; break; }
          if (price >= knockoutLevel) { hitSL = true; exitPrice = knockoutLevel; break; }
        }
      }
      if (!exitPrice) exitPrice = prices[prices.length - 1];

      // Compute profit: profit = stake * multiplier * (priceChange / entryPrice)
      const priceChange = (direction === 'BUY') ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
      const profit = stake * mult * (priceChange / entryPrice);
      totalProfit += profit * w;
      if (hitTP) hitsTP++;
      if (hitSL) hitsSL++;
    }

    if (totalWeight === 0) continue;

    const avgProfit = totalProfit / totalWeight;
    const probTP = hitsTP / paths.length;
    const probSL = hitsSL / paths.length;
    const ev = avgProfit;

    // Risk-adjusted utility: EV - riskAversion * (probSL * avgLoss)
    // We approximate loss as stake (worst-case) * probSL, but can refine.
    const utility = ev - CONFIG.RISK_AVERSION * (probSL * stake);

    // Check if EV is positive and knockout probability is acceptable
    if (ev > CONFIG.MIN_EV && probSL < CONFIG.MAX_KNOCKOUT_PROBABILITY && utility > bestUtility) {
      bestUtility = utility;
      bestMultiplier = mult;
      bestMetrics = {
        probTP,
        probSL,
        probOther: 1 - probTP - probSL,
        avgProfit,
        ev,
        evOverStake: ev / stake,
      };
    }
  }

  if (!bestMultiplier) {
    return createNoTradeResponse(NO_TRADE_REASONS.NO_VALID_MULTIPLIER, 'No multiplier yielded positive EV with acceptable knockout probability.', prediction);
  }

  // 9. Risk engine checks (exposure, correlated positions, etc.)
  try {
    const riskCheck = await riskEngine.validateTrade({
      symbol,
      direction,
      stake,
      multiplier: bestMultiplier,
      duration: Math.max(60, (timeToMaxFavorable || 5) * 60),
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

  // 10. All checks passed – return TRADE opportunity
  return {
    tradable: true,
    reason: `Selected ${bestMultiplier}x (EV: ${bestMetrics.ev.toFixed(2)}, KO prob: ${(bestMetrics.probSL*100).toFixed(1)}%)`,
    prediction,
    direction,
    stake,
    multiplier: bestMultiplier,
    duration: Math.max(60, (timeToMaxFavorable || 5) * 60),
    entryPrice,
    knockoutLevel,
    takeProfitLevel,
    probabilities: { up, down, neutral },
    tradeEconomics: {
      probTP: bestMetrics.probTP,
      probSL: bestMetrics.probSL,
      probOther: bestMetrics.probOther,
      expectedProfit: bestMetrics.avgProfit,
      expectedLoss: Math.max(0, -bestMetrics.avgProfit), // only if negative, but we only allow positive EV
      ev: bestMetrics.ev,
      evOverStake: bestMetrics.evOverStake,
    },
    riskMetrics: {
      maxLoss: stake,
      targetProfit: bestMetrics.ev > 0 ? bestMetrics.ev : 0,
      riskRewardRatio: bestMetrics.ev / (stake || 1),
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
    // Defaults for fields that might be expected
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
