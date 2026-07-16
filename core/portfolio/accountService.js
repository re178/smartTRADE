// core/portfolio/accountService.js – Account Information (uses brokerFactory with product support)

const { getBroker } = require('../execution/brokerFactory');
const eventBus = require('../../infrastructure/eventBus');
const logger = require('../../infrastructure/logger') || console;

const DEFAULT_PRODUCT = process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd';

/**
 * Get the broker instance for the given product (or default).
 */
function getBrokerForProduct(product) {
  return getBroker(product || DEFAULT_PRODUCT);
}

/**
 * Get account details (balance, equity, margin, currency, etc.).
 * @param {string} [product] - Trading product (optional, uses default if not provided)
 * @returns {Promise<Object>} Account object.
 */
async function getAccount(product) {
  const broker = getBrokerForProduct(product);
  if (!broker.isConnected()) {
    await broker.connect();
  }
  try {
    const account = await broker.getAccount();
    eventBus.emit('account.fetched', {
      balance: account.balance,
      equity: account.equity,
      marginAvailable: account.marginAvailable,
      timestamp: new Date().toISOString(),
    });
    return account;
  } catch (error) {
    logger.error('[AccountService] Failed to fetch account:', error.message);
    throw error;
  }
}

/**
 * Get current account balance.
 * @param {string} [product] - Trading product (optional)
 * @returns {Promise<number>} Balance in account currency.
 */
async function getBalance(product) {
  const account = await getAccount(product);
  return parseFloat(account.balance);
}

/**
 * Get current equity (balance + unrealized P&L).
 * @param {string} [product] - Trading product (optional)
 * @returns {Promise<number>} Equity in account currency.
 */
async function getEquity(product) {
  const account = await getAccount(product);
  return parseFloat(account.equity);
}

/**
 * Get available margin.
 * @param {string} [product] - Trading product (optional)
 * @returns {Promise<number>} Margin available.
 */
async function getAvailableMargin(product) {
  const account = await getAccount(product);
  return parseFloat(account.marginAvailable);
}

/**
 * Check if the account is healthy (positive equity, sufficient margin).
 * @param {string} [product] - Trading product (optional)
 * @returns {Promise<boolean>} True if healthy.
 */
async function isAccountHealthy(product) {
  try {
    const account = await getAccount(product);
    const equity = parseFloat(account.equity);
    const marginAvailable = parseFloat(account.marginAvailable);
    return (equity > 0 && marginAvailable > 0);
  } catch (error) {
    logger.error('[AccountService] Health check failed:', error.message);
    return false;
  }
}

module.exports = {
  getAccount,
  getBalance,
  getEquity,
  getAvailableMargin,
  isAccountHealthy,
};
