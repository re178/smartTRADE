// core/execution/orderService.js – Order Management (uses brokerFactory)

const { getBroker } = require('./brokerFactory');
const eventBus = require('../../infrastructure/eventBus');
const { validateOrderInput } = require('../../shared/validators');
const { formatPrice } = require('../../shared/helpers');
const { ExecutionAnalytics } = require('../analytics/performanceSuite');
const logger = require('../../infrastructure/logger') || console;

// Singleton Execution Analytics instance
const executionAnalytics = new ExecutionAnalytics({
  slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE) || 1,
});

// Get the appropriate broker instance (CFD or Multiplier)
const broker = getBroker();

/**
 * Place a market order (BUY/SELL).
 * @param {string} instrument - e.g., 'EUR_USD'
 * @param {string} side - 'BUY' or 'SELL'
 * @param {number} lotSize - Number of units (positive)
 * @param {number|null} stopLoss - Stop loss price (optional)
 * @param {number|null} takeProfit - Take profit price (optional)
 * @returns {Promise<Object>} { tradeId, orderId, price, ... }
 */
async function placeMarketOrder(instrument, side, lotSize, stopLoss = null, takeProfit = null) {
  const validation = validateOrderInput({ pair: instrument, side, lotSize, stopLoss, takeProfit });
  if (!validation.valid) {
    throw new Error(validation.message);
  }

  const units = side.toUpperCase() === 'BUY' ? lotSize : -lotSize;
  const startTime = Date.now();

  // Ensure broker is connected
  if (!broker.isConnected()) {
    await broker.connect();
  }

  try {
    const result = await broker.placeMarketOrder(instrument, units, stopLoss, takeProfit);
    const latency = Date.now() - startTime;

    // Record execution analytics
    const spread = await getSpread(instrument);
    executionAnalytics.recordExecution({
      orderId: result.id || 'N/A',
      instrument,
      side,
      requestedPrice: result.price || 0,
      filledPrice: result.price || 0,
      latency,
      spread: spread || 0,
      status: 'FILLED',
    });

    const tradeId = result.tradeID || result.id || null;
    const orderId = result.id || null;
    const price = result.price || result.averagePrice || null;

    eventBus.emit('order.placed', {
      instrument,
      side,
      lotSize,
      stopLoss,
      takeProfit,
      tradeId,
      orderId,
      price,
      timestamp: new Date().toISOString(),
    });

    return { tradeId, orderId, price, raw: result };
  } catch (err) {
    // Record rejection
    executionAnalytics.recordExecution({
      orderId: 'N/A',
      instrument,
      side,
      requestedPrice: 0,
      filledPrice: 0,
      latency: Date.now() - startTime,
      spread: 0,
      status: 'REJECTED',
    });
    throw err;
  }
}

/**
 * Close an open trade by its ID.
 * @param {string} tradeId - Trade ID (contract ID)
 * @returns {Promise<Object>} Result from broker.
 */
async function closeTrade(tradeId) {
  if (!tradeId) throw new Error('tradeId is required');
  const startTime = Date.now();
  if (!broker.isConnected()) {
    await broker.connect();
  }
  try {
    const result = await broker.closeTrade(tradeId);
    const latency = Date.now() - startTime;
    eventBus.emit('trade.closed', { tradeId, result, timestamp: new Date().toISOString() });
    return result;
  } catch (err) {
    logger.error('[closeTrade] Error:', err.message);
    throw err;
  }
}

/**
 * Get current spread for an instrument (stub – implement with real data).
 * @param {string} instrument
 * @returns {Promise<number>} Spread in pips.
 */
async function getSpread(instrument) {
  try {
    const prices = await broker.getPrices([instrument]);
    if (prices && prices.length > 0) {
      const bid = parseFloat(prices[0].bids[0].price);
      const ask = parseFloat(prices[0].asks[0].price);
      return Math.abs(ask - bid) / 0.0001;
    }
  } catch (e) {}
  return 0;
}

/**
 * Get all open trades from the broker.
 * @returns {Promise<Array>} List of open trade objects.
 */
async function getOpenTrades() {
  if (!broker.isConnected()) {
    await broker.connect();
  }
  return broker.getOpenTrades();
}

/**
 * Get all positions from the broker.
 * @returns {Promise<Array>} List of position objects.
 */
async function getPositions() {
  if (!broker.isConnected()) {
    await broker.connect();
  }
  return broker.getPositions();
}

/**
 * Get execution analytics report.
 * @returns {Object} Analytics report.
 */
function getExecutionAnalytics() {
  return executionAnalytics.getReport();
}

module.exports = {
  placeMarketOrder,
  closeTrade,
  getOpenTrades,
  getPositions,
  getExecutionAnalytics,
};
