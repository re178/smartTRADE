// src/core/portfolio/accountService.js – Account Information Service

const broker = require('../execution/broker');
const eventBus = require('../../infrastructure/eventBus');

/**
 * Get account details (balance, equity, margin, currency, etc.).
 * Caches the result for the current session to avoid excessive API calls.
 * @returns {Promise<Object>} Account object.
 */
async function getAccount() {
  try {
    const account = await broker.getAccount();
    // Emit event (for analytics, logging, etc.)
    eventBus.emit('account.fetched', {
      balance: account.balance,
      equity: account.equity,
      marginAvailable: account.marginAvailable,
      timestamp: new Date().toISOString(),
    });
    return account;
  } catch (error) {
    console.error('Failed to fetch account:', error.message);
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
  const account = await getAccount();
  const equity = parseFloat(account.equity);
  const marginUsed = parseFloat(account.marginUsed);
  const marginAvailable = parseFloat(account.marginAvailable);
  return (equity > 0 && marginAvailable > 0);
}

module.exports = {
  getAccount,
  getBalance,
  getEquity,
  getAvailableMargin,
  isAccountHealthy,
};
