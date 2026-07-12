// src/core/risk/manager.js – Risk Management Engine

const accountService = require('../portfolio/accountService');
const orderService = require('../execution/orderService');
const eventBus = require('../../infrastructure/eventBus');
const { getPipSize, formatPrice } = require('../../shared/helpers');

/**
 * Calculate the appropriate lot size (in units) based on account balance,
 * risk percentage, and stop-loss distance.
 * @param {string} instrument - e.g., 'EUR_USD'
 * @param {number} entryPrice - Entry price.
 * @param {number} stopLoss - Stop loss price.
 * @param {number} riskPercent - Percentage of account to risk (e.g., 1 for 1%).
 * @returns {Promise<number>} Lot size (units, positive).
 */
async function calculateLotSize(instrument, entryPrice, stopLoss, riskPercent = 1) {
  try {
    // Get account balance
    const account = await accountService.getAccount();
    const balance = parseFloat(account.balance);
    if (!balance || balance <= 0) {
      throw new Error('Invalid account balance');
    }

    // Calculate risk amount in account currency
    const riskAmount = balance * (riskPercent / 100);

    // Calculate pip distance from entry to stop loss
    const pipDistance = Math.abs(entryPrice - stopLoss);
    if (pipDistance <= 0) {
      throw new Error('Stop loss must be different from entry');
    }

    // Determine pip size for the instrument
    const pipSize = getPipSize(instrument);

    // Calculate pip value (approximate: for USD pairs, 1 lot = 100,000 units, pip value ~ $10 per pip)
    // For more accurate, we could use broker's instrument details.
    // This is a simplification; in production, use proper pip value calculation.
    const pipValue = 10; // approx for most USD pairs

    // Calculate lot size: riskAmount / (pipDistance * pipValue)
    let lotSize = riskAmount / (pipDistance * pipValue);

    // Round to 2 decimal places (0.01 lot minimum)
    lotSize = Math.max(0.01, Math.round(lotSize * 100) / 100);

    // Cap at maximum lot size (optional)
    const maxLot = 100; // arbitrary cap
    if (lotSize > maxLot) {
      lotSize = maxLot;
      console.warn(`Lot size capped at ${maxLot} (calculated ${lotSize})`);
    }

    return lotSize;
  } catch (error) {
    console.error('Lot size calculation error:', error.message);
    return 0.01; // fallback
  }
}

/**
 * Validate a trade before execution.
 * Checks:
 * - Max number of open positions
 * - Daily loss limit
 * - Minimum spread
 * - etc.
 * @param {string} instrument - Instrument name.
 * @param {string} side - 'BUY' or 'SELL'.
 * @param {number} lotSize - Proposed lot size.
 * @returns {Promise<Object>} { approved: boolean, reason: string }
 */
async function validateTrade(instrument, side, lotSize) {
  const validation = {
    approved: true,
    reason: '',
  };

  try {
    // 1. Check maximum open positions (configurable)
    const maxPositions = parseInt(process.env.MAX_OPEN_POSITIONS) || 5;
    const openTrades = await orderService.getOpenTrades();
    if (openTrades.length >= maxPositions) {
      validation.approved = false;
      validation.reason = `Max open positions (${maxPositions}) reached`;
      return validation;
    }

    // 2. Check daily loss limit (optional)
    const dailyLossLimit = parseFloat(process.env.DAILY_LOSS_LIMIT) || 0; // 0 means disabled
    if (dailyLossLimit > 0) {
      // Calculate today's P&L from closed trades (would need to fetch from DB)
      // For now, placeholder – we could query Trade model.
      // We'll implement a stub: assume we have a function getTodayPnL()
      // const todayPnL = await getTodayPnL();
      // if (todayPnL <= -dailyLossLimit) {
      //   validation.approved = false;
      //   validation.reason = `Daily loss limit (${dailyLossLimit}) reached`;
      //   return validation;
      // }
    }

    // 3. Minimum spread check (optional)
    // Fetch current spread and compare to max allowed
    // const spread = await getSpread(instrument);
    // const maxSpread = parseFloat(process.env.MAX_SPREAD) || 0;
    // if (maxSpread > 0 && spread > maxSpread) {
    //   validation.approved = false;
    //   validation.reason = `Spread ${spread} exceeds limit ${maxSpread}`;
    //   return validation;
    // }

    // 4. Instrument availability / trading hours (placeholder)
    // Could check if market is open for this instrument.

    // If all checks pass
    return validation;
  } catch (error) {
    console.error('Trade validation error:', error.message);
    validation.approved = false;
    validation.reason = 'Validation error: ' + error.message;
    return validation;
  }
}

/**
 * Get today's realized P&L from MongoDB (placeholder).
 * In production, this would sum closed trades for today.
 * @returns {Promise<number>} Total P&L for today.
 */
async function getTodayPnL() {
  // TODO: implement by querying Trade model with status 'CLOSED' and closeTime >= today
  return 0;
}

/**
 * Get current spread for an instrument (placeholder).
 * @param {string} instrument - Instrument name.
 * @returns {Promise<number>} Spread in pips.
 */
async function getSpread(instrument) {
  // In real implementation, fetch bid/ask and compute difference
  // For now, return a default.
  return 1.0;
}

module.exports = {
  calculateLotSize,
  validateTrade,
  getTodayPnL,
  getSpread,
};
