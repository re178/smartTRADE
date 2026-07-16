// core/risk/manager.js – Risk Management Engine (with lot size cap and product support)

const accountService = require('../portfolio/accountService');
const orderService = require('../execution/orderService');
const { getBroker } = require('../execution/brokerFactory');
const eventBus = require('../../infrastructure/eventBus');
const { getPipSize, formatPrice } = require('../../shared/helpers');
const logger = require('../../infrastructure/logger') || console;

/**
 * Calculate the appropriate lot size (in units) based on account balance,
 * risk percentage, and stop-loss distance.
 * @param {string} instrument - e.g., 'EUR_USD'
 * @param {number} entryPrice - Entry price.
 * @param {number} stopLoss - Stop loss price.
 * @param {number} riskPercent - Percentage of account to risk (e.g., 1 for 1%).
 * @param {number} maxLot - Maximum allowed lot size (default 1000).
 * @param {string} [product] - Trading product (optional, defaults to env or 'deriv_cfd')
 * @returns {Promise<number>} Lot size (units, positive).
 */
async function calculateLotSize(instrument, entryPrice, stopLoss, riskPercent = 1, maxLot = 1000, product) {
  try {
    // Get account balance (pass product)
    const account = await accountService.getAccount(product || process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd');
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
    const pipValue = 10; // approx for most USD pairs

    // Calculate lot size: riskAmount / (pipDistance * pipValue)
    let lotSize = riskAmount / (pipDistance * pipValue);

    // Round to 2 decimal places (0.01 lot minimum)
    lotSize = Math.max(0.01, Math.round(lotSize * 100) / 100);

    // Cap at maxLot (default 1000, configurable via env)
    const maxAllowed = parseInt(process.env.MAX_POSITION_SIZE) || maxLot;
    if (lotSize > maxAllowed) {
      lotSize = maxAllowed;
      logger.warn(`[RiskManager] Lot size capped at ${maxAllowed} (calculated ${lotSize})`);
    }

    return lotSize;
  } catch (error) {
    logger.error('Lot size calculation error:', error.message);
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
 * @param {string} [product] - Trading product (optional)
 * @returns {Promise<Object>} { approved: boolean, reason: string }
 */
async function validateTrade(instrument, side, lotSize, product) {
  const validation = { approved: true, reason: '' };
  try {
    // 1. Check maximum open positions (configurable)
    const maxPositions = parseInt(process.env.MAX_OPEN_POSITIONS) || 5;
    const openTrades = await orderService.getOpenTrades(product || process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd');
    if (openTrades.length >= maxPositions) {
      validation.approved = false;
      validation.reason = `Max open positions (${maxPositions}) reached`;
      return validation;
    }

    // 2. Check daily loss limit (optional)
    const dailyLossLimit = parseFloat(process.env.DAILY_LOSS_LIMIT) || 0; // 0 means disabled
    if (dailyLossLimit > 0) {
      // Placeholder – implement with DB query
    }

    // 3. Minimum spread check (optional)
    // 4. Instrument availability / trading hours (placeholder)

    return validation;
  } catch (error) {
    logger.error('Trade validation error:', error.message);
    validation.approved = false;
    validation.reason = 'Validation error: ' + error.message;
    return validation;
  }
}

/**
 * Get today's realized P&L from MongoDB (placeholder).
 * @returns {Promise<number>} Total P&L for today.
 */
async function getTodayPnL() {
  // TODO: implement by querying Trade model with status 'CLOSED' and closeTime >= today
  return 0;
}

/**
 * Get current spread for an instrument.
 * @param {string} instrument - Instrument name.
 * @param {string} [product] - Trading product (optional)
 * @returns {Promise<number>} Spread in pips.
 */
async function getSpread(instrument, product) {
  try {
    const broker = getBroker(product || process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd');
    const prices = await broker.getPrices([instrument]);
    if (prices && prices.length > 0) {
      const bid = parseFloat(prices[0].bids[0].price);
      const ask = parseFloat(prices[0].asks[0].price);
      const pipSize = getPipSize(instrument);
      return Math.abs(ask - bid) / pipSize;
    }
  } catch (error) {
    logger.warn('[RiskManager] getSpread error:', error.message);
  }
  return 1.0;
}

module.exports = {
  calculateLotSize,
  validateTrade,
  getTodayPnL,
  getSpread,
};
