// core/risk/riskEngine.js
// Risk Engine – Centralised risk management for Multiplier trading.
// Handles account, trade, portfolio, and safety risks.
// Returns approval/rejection with detailed reason.

const { getBroker } = require('../execution/brokerFactory');
const accountService = require('../portfolio/accountService');
const portfolioIntelligence = require('../portfolio/intelligence');
const { getPipSize } = require('../../shared/helpers');
const logger = require('../../infrastructure/logger') || console;

// Configuration
const CONFIG = {
  // Account risk
  MAX_RISK_PER_TRADE_PCT: parseFloat(process.env.MAX_RISK_PER_TRADE_PCT) || 1.0, // 1% of balance
  MAX_DAILY_LOSS_PCT: parseFloat(process.env.MAX_DAILY_LOSS_PCT) || 5.0, // 5% of balance
  MAX_DRAWDOWN_PCT: parseFloat(process.env.MAX_DRAWDOWN_PCT) || 10.0, // 10% of balance
  MAX_CONSECUTIVE_LOSSES: parseInt(process.env.MAX_CONSECUTIVE_LOSSES) || 3,

  // Portfolio risk
  MAX_OPEN_TRADES: parseInt(process.env.MAX_OPEN_TRADES) || 5,
  MAX_TOTAL_EXPOSURE_PCT: parseFloat(process.env.MAX_TOTAL_EXPOSURE_PCT) || 20.0, // 20% of balance
  MAX_PAIR_EXPOSURE_PCT: parseFloat(process.env.MAX_PAIR_EXPOSURE_PCT) || 10.0, // 10% of balance
  CORRELATION_THRESHOLD: parseFloat(process.env.CORRELATION_THRESHOLD) || 0.7,

  // Safety checks
  MAX_SPREAD_PIPS: parseFloat(process.env.MAX_SPREAD_PIPS) || 2.0,
  MAX_PRICE_AGE_MS: parseInt(process.env.MAX_PRICE_AGE_MS) || 5000, // 5 seconds
  MIN_BALANCE: parseFloat(process.env.MIN_BALANCE) || 100, // minimum account balance to trade
};

/**
 * Validate a trade against all risk rules.
 * @param {Object} tradeParams - { symbol, direction, stake, multiplier, duration, knockoutLevel, takeProfitLevel }
 * @param {Object} account - Account object (balance, equity, currency).
 * @param {Array} openPositions - Array of open positions.
 * @param {Object} marketData - { currentPrice, spread, timestamp }.
 * @param {Object} dailyStats - { dailyPnL, consecutiveLosses, maxDrawdown }.
 * @returns {Promise<Object>} { approved: boolean, reason: string, message: string, adjustedParams?: Object }
 */
async function validateTrade(tradeParams, account, openPositions = [], marketData = {}, dailyStats = {}) {
  const {
    symbol,
    direction,
    stake,
    multiplier,
    duration,
    knockoutLevel,
    takeProfitLevel,
  } = tradeParams;

  // ---- 1. Basic input validation ----
  if (!symbol || typeof symbol !== 'string') {
    return { approved: false, reason: 'INVALID_INPUT', message: 'Symbol is required' };
  }
  if (!['BUY', 'SELL'].includes(direction)) {
    return { approved: false, reason: 'INVALID_INPUT', message: 'Direction must be BUY or SELL' };
  }
  if (!stake || stake <= 0) {
    return { approved: false, reason: 'INVALID_INPUT', message: 'Stake must be positive' };
  }
  if (!multiplier || multiplier < 1) {
    return { approved: false, reason: 'INVALID_INPUT', message: 'Multiplier must be at least 1' };
  }
  if (!duration || duration < 10) {
    return { approved: false, reason: 'INVALID_INPUT', message: 'Duration must be at least 10 seconds' };
  }

  // ---- 2. Account risk checks ----
  const balance = parseFloat(account.balance) || 0;
  const equity = parseFloat(account.equity) || balance;

  // Minimum balance
  if (balance < CONFIG.MIN_BALANCE) {
    return { approved: false, reason: 'INSUFFICIENT_BALANCE', message: `Balance ${balance} below minimum ${CONFIG.MIN_BALANCE}` };
  }

  // Risk per trade (stake as % of balance)
  const riskPct = (stake / balance) * 100;
  if (riskPct > CONFIG.MAX_RISK_PER_TRADE_PCT) {
    return {
      approved: false,
      reason: 'RISK_PER_TRADE_EXCEEDED',
      message: `Stake ${stake} (${riskPct.toFixed(2)}%) exceeds max ${CONFIG.MAX_RISK_PER_TRADE_PCT}% of balance`,
    };
  }

  // Daily loss limit
  const dailyLoss = dailyStats.dailyPnL || 0;
  const maxDailyLoss = balance * (CONFIG.MAX_DAILY_LOSS_PCT / 100);
  if (dailyLoss < -maxDailyLoss) {
    return {
      approved: false,
      reason: 'DAILY_LOSS_LIMIT_EXCEEDED',
      message: `Daily loss ${dailyLoss.toFixed(2)} exceeds limit ${maxDailyLoss.toFixed(2)}`,
    };
  }

  // Consecutive losses
  const consecutiveLosses = dailyStats.consecutiveLosses || 0;
  if (consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) {
    return {
      approved: false,
      reason: 'CONSECUTIVE_LOSSES_EXCEEDED',
      message: `Consecutive losses ${consecutiveLosses} exceeds max ${CONFIG.MAX_CONSECUTIVE_LOSSES}`,
    };
  }

  // Max drawdown
  const currentDrawdown = dailyStats.maxDrawdown || 0;
  const maxDrawdownAllowed = balance * (CONFIG.MAX_DRAWDOWN_PCT / 100);
  if (currentDrawdown < -maxDrawdownAllowed) {
    return {
      approved: false,
      reason: 'DRAWDOWN_LIMIT_EXCEEDED',
      message: `Drawdown ${currentDrawdown.toFixed(2)} exceeds limit ${maxDrawdownAllowed.toFixed(2)}`,
    };
  }

  // ---- 3. Portfolio risk checks ----
  // Open trades count
  const openCount = openPositions ? openPositions.length : 0;
  if (openCount >= CONFIG.MAX_OPEN_TRADES) {
    return {
      approved: false,
      reason: 'MAX_OPEN_TRADES_EXCEEDED',
      message: `Open trades ${openCount} exceeds max ${CONFIG.MAX_OPEN_TRADES}`,
    };
  }

  // Total exposure (using stake as exposure)
  const totalExposure = openPositions.reduce((sum, p) => sum + (p.stake || p.units || 0), 0) + stake;
  const maxExposure = balance * (CONFIG.MAX_TOTAL_EXPOSURE_PCT / 100);
  if (totalExposure > maxExposure) {
    return {
      approved: false,
      reason: 'EXPOSURE_LIMIT_EXCEEDED',
      message: `Total exposure ${totalExposure.toFixed(2)} exceeds limit ${maxExposure.toFixed(2)}`,
    };
  }

  // Pair exposure
  const pairExposure = openPositions
    .filter(p => p.instrument === symbol)
    .reduce((sum, p) => sum + (p.stake || p.units || 0), 0) + stake;
  const maxPairExposure = balance * (CONFIG.MAX_PAIR_EXPOSURE_PCT / 100);
  if (pairExposure > maxPairExposure) {
    return {
      approved: false,
      reason: 'PAIR_EXPOSURE_LIMIT_EXCEEDED',
      message: `Pair exposure ${pairExposure.toFixed(2)} exceeds limit ${maxPairExposure.toFixed(2)}`,
    };
  }

  // Correlated positions (using portfolioIntelligence)
  try {
    const correlatedCheck = await portfolioIntelligence.assessNewTrade(
      { symbol, side: direction, recommendedLotSize: stake },
      balance,
      openPositions
    );
    if (!correlatedCheck.approved) {
      return {
        approved: false,
        reason: 'CORRELATED_EXPOSURE',
        message: correlatedCheck.reason || 'Correlated exposure risk detected',
      };
    }
  } catch (err) {
    logger.warn('[RiskEngine] Portfolio intelligence error:', err.message);
    // Continue – we don't block on correlation check failure
  }

  // ---- 4. Safety checks ----
  // Broker availability
  let broker;
  try {
    broker = getBroker('deriv_cfd');
    if (!broker.isConnected()) {
      await broker.connect();
    }
  } catch (err) {
    return {
      approved: false,
      reason: 'BROKER_UNAVAILABLE',
      message: `Broker connection failed: ${err.message}`,
    };
  }

  // Price freshness
  if (marketData.timestamp) {
    const ageMs = Date.now() - new Date(marketData.timestamp).getTime();
    if (ageMs > CONFIG.MAX_PRICE_AGE_MS) {
      return {
        approved: false,
        reason: 'STALE_DATA',
        message: `Price age ${ageMs}ms exceeds limit ${CONFIG.MAX_PRICE_AGE_MS}ms`,
      };
    }
  }

  // Spread check
  if (marketData.spread) {
    const pipSize = getPipSize(symbol);
    const spreadPips = marketData.spread / pipSize;
    if (spreadPips > CONFIG.MAX_SPREAD_PIPS) {
      return {
        approved: false,
        reason: 'SPREAD_TOO_HIGH',
        message: `Spread ${spreadPips.toFixed(1)} pips exceeds max ${CONFIG.MAX_SPREAD_PIPS} pips`,
      };
    }
  }

  // ---- 5. TP/SL sanity checks ----
  if (knockoutLevel !== null && knockoutLevel !== undefined) {
    const currentPrice = marketData.currentPrice || account.currentPrice || 0;
    if (direction === 'BUY' && knockoutLevel >= currentPrice) {
      return {
        approved: false,
        reason: 'INVALID_KNOCKOUT',
        message: 'Knockout must be below current price for BUY',
      };
    }
    if (direction === 'SELL' && knockoutLevel <= currentPrice) {
      return {
        approved: false,
        reason: 'INVALID_KNOCKOUT',
        message: 'Knockout must be above current price for SELL',
      };
    }
  }

  if (takeProfitLevel !== null && takeProfitLevel !== undefined) {
    const currentPrice = marketData.currentPrice || account.currentPrice || 0;
    if (direction === 'BUY' && takeProfitLevel <= currentPrice) {
      return {
        approved: false,
        reason: 'INVALID_TP',
        message: 'Take-profit must be above current price for BUY',
      };
    }
    if (direction === 'SELL' && takeProfitLevel >= currentPrice) {
      return {
        approved: false,
        reason: 'INVALID_TP',
        message: 'Take-profit must be below current price for SELL',
      };
    }
  }

  // ---- 6. All checks passed ----
  return {
    approved: true,
    reason: 'ALL_CHECKS_PASSED',
    message: 'Trade passes all risk checks.',
    adjustedParams: {
      // Could adjust stake or multiplier here if needed
    },
  };
}

/**
 * Get current daily statistics (PnL, consecutive losses, drawdown).
 * @param {string} symbol - Optional symbol filter.
 * @param {string} product - Trading product.
 * @returns {Promise<Object>} { dailyPnL, consecutiveLosses, maxDrawdown, totalTrades }
 */
async function getDailyStats(symbol = null, product = 'deriv_cfd') {
  const Trade = require('../../models/Trade');
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const filter = {
    status: 'CLOSED',
    closeTime: { $gte: today },
  };
  if (symbol) filter.instrument = symbol;

  const trades = await Trade.find(filter).sort({ closeTime: 1 }).lean();

  let dailyPnL = 0;
  let consecutiveLosses = 0;
  let maxDrawdown = 0;
  let currentDrawdown = 0;
  let wins = 0;
  let losses = 0;

  for (const t of trades) {
    const pnl = t.realizedProfit || t.pnl || 0;
    dailyPnL += pnl;
    if (pnl < 0) {
      consecutiveLosses++;
      currentDrawdown += Math.abs(pnl);
    } else {
      consecutiveLosses = 0;
      currentDrawdown = Math.max(0, currentDrawdown - pnl);
    }
    if (pnl > 0) wins++;
    else losses++;
    if (currentDrawdown > maxDrawdown) maxDrawdown = currentDrawdown;
  }

  return {
    dailyPnL,
    consecutiveLosses,
    maxDrawdown: -maxDrawdown, // negative to represent loss
    totalTrades: trades.length,
    wins,
    losses,
    winRate: trades.length > 0 ? wins / trades.length : 0,
  };
}

/**
 * Get account balance and equity (convenience wrapper).
 * @param {string} product - Trading product.
 * @returns {Promise<Object>} Account object.
 */
async function getAccount(product = 'deriv_cfd') {
  return accountService.getAccount(product);
}

/**
 * Get open positions (convenience wrapper).
 * @param {string} product - Trading product.
 * @returns {Promise<Array>} Array of open positions.
 */
async function getOpenPositions(product = 'deriv_cfd') {
  const broker = getBroker(product);
  if (!broker.isConnected()) {
    await broker.connect();
  }
  return broker.getOpenTrades();
}

module.exports = {
  validateTrade,
  getDailyStats,
  getAccount,
  getOpenPositions,
  CONFIG,
};
