// core/portfolio/accountService.js – Account Information (uses brokerFactory)

const { getBroker } = require('../execution/brokerFactory');
const eventBus = require('../../infrastructure/eventBus');
const logger = require('../../infrastructure/logger') || console;

// Get the appropriate broker instance (live or paper)
const broker = getBroker();

/**
 * Get account details (balance, equity, margin, currency, etc.).
 * @returns {Promise<Object>} Account object.
 */
async function getAccount() {
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
 * @returns {Promise<number>} Balance in account currency.
 */
async function getBalance() {
  const account = await getAccount();
  return parseFloat(account.balance);
}

/**
 * Get current equity (balance + unrealized P&L).
 * @returns {Promise<number>} Equity in account currency.
 */
async function getEquity() {
  const account = await getAccount();
  return parseFloat(account.equity);
}

/**
 * Get available margin.
 * @returns {Promise<number>} Margin available.
 */
async function getAvailableMargin() {
  const account = await getAccount();
  return parseFloat(account.marginAvailable);
}

/**
 * Check if the account is healthy (positive equity, sufficient margin).
 * @returns {Promise<boolean>} True if healthy.
 */
async function isAccountHealthy() {
  try {
    const account = await getAccount();
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
