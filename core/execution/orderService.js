// core/execution/orderService.js – Order Management (with Order & Trade models)

const { getBroker } = require('./brokerFactory');
const eventBus = require('../../infrastructure/eventBus');
const { validateOrderInput } = require('../../shared/validators');
const { ExecutionAnalytics } = require('../analytics/performanceSuite');
const Order = require('../../models/Order');   // for pending orders
const Trade = require('../../models/Trade');   // for completed trades
const logger = require('../../infrastructure/logger') || console;

// Singleton Execution Analytics instance
const executionAnalytics = new ExecutionAnalytics({
  slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE) || 1,
});

/**
 * Place a market order (BUY/SELL) – uses product parameter for per‑user broker selection.
 * @param {string} instrument - e.g., 'EUR_USD'
 * @param {string} side - 'BUY' or 'SELL'
 * @param {number} lotSize - Number of units (positive)
 * @param {number|null} stopLoss - Stop loss price (optional)
 * @param {number|null} takeProfit - Take profit price (optional)
 * @param {string} [product] - Trading product (optional, default from env)
 * @returns {Promise<Object>} { contractId, price, raw }
 */
async function placeMarketOrder(instrument, side, lotSize, stopLoss = null, takeProfit = null, product) {
  const validation = validateOrderInput({ pair: instrument, side, lotSize, stopLoss, takeProfit });
  if (!validation.valid) {
    throw new Error(validation.message);
  }

  const broker = getBroker(product);
  const units = side.toUpperCase() === 'BUY' ? lotSize : -lotSize;
  const startTime = Date.now();

  if (!broker.isConnected()) {
    await broker.connect();
  }

  try {
    const result = await broker.placeMarketOrder(instrument, units, stopLoss, takeProfit);
    const latency = Date.now() - startTime;

    const spread = await getSpread(instrument, product);
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

    const contractId = result.tradeID || result.id || null;
    const price = result.price || result.averagePrice || null;

    eventBus.emit('order.placed', {
      instrument,
      side,
      lotSize,
      stopLoss,
      takeProfit,
      contractId,
      price,
      timestamp: new Date().toISOString(),
    });

    return { contractId, price, raw: result };
  } catch (err) {
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
 * Cancel a pending order by its contract ID.
 * @param {string} contractId - The contract/trade ID
 * @param {string} [product] - Trading product (optional)
 * @returns {Promise<Object>} Result from broker.
 */
async function cancelOrder(contractId, product) {
  if (!contractId) throw new Error('contractId is required');
  const broker = getBroker(product);
  if (!broker.isConnected()) {
    await broker.connect();
  }
  // Use broker's cancelOrder if available, else closeTrade (Deriv)
  let result;
  if (typeof broker.cancelOrder === 'function') {
    result = await broker.cancelOrder(contractId);
  } else {
    result = await broker.closeTrade(contractId);
  }
  // Update Order status to CANCELLED
  await Order.findOneAndUpdate(
    { contractId: contractId },
    { status: 'CANCELLED', updatedAt: new Date() },
    { upsert: false }
  );
  eventBus.emit('order.cancelled', { contractId, result, timestamp: new Date().toISOString() });
  return result;
}

/**
 * Close an open trade by its contract ID (updates Trade model).
 * @param {string} contractId - Trade ID (contract ID)
 * @param {string} [product] - Trading product (optional)
 * @returns {Promise<Object>} Result from broker.
 */
async function closeTrade(contractId, product) {
  if (!contractId) throw new Error('contractId is required');
  const broker = getBroker(product);
  const startTime = Date.now();
  if (!broker.isConnected()) {
    await broker.connect();
  }
  try {
    const result = await broker.closeTrade(contractId);
    const latency = Date.now() - startTime;
    // Update Trade status to CLOSED
    await Trade.findOneAndUpdate(
      { oandaTradeId: contractId }, // or contractId if you store it
      { status: 'CLOSED', closeTime: new Date(), closePrice: result.price || null, pnl: result.pl || 0 },
      { new: true }
    );
    eventBus.emit('trade.closed', { contractId, result, timestamp: new Date().toISOString() });
    return result;
  } catch (err) {
    logger.error('[closeTrade] Error:', err.message);
    throw err;
  }
}

/**
 * Get current spread for an instrument.
 * @param {string} instrument
 * @param {string} [product]
 * @returns {Promise<number>} Spread in pips.
 */
async function getSpread(instrument, product) {
  const broker = getBroker(product);
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
 * Get all open trades from the broker (not from DB).
 * @param {string} [product]
 * @returns {Promise<Array>} List of open trade objects.
 */
async function getOpenTrades(product) {
  const broker = getBroker(product);
  if (!broker.isConnected()) {
    await broker.connect();
  }
  return broker.getOpenTrades();
}

/**
 * Get all positions from the broker.
 * @param {string} [product]
 * @returns {Promise<Array>} List of position objects.
 */
async function getPositions(product) {
  const broker = getBroker(product);
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

/**
 * Delete all closed trades from the Trade collection.
 * @returns {Promise<number>} Number of deleted records.
 */
async function deleteClosedTrades() {
  const result = await Trade.deleteMany({ status: 'CLOSED' });
  logger.info(`Deleted ${result.deletedCount} closed trades from history.`);
  return result.deletedCount;
}

module.exports = {
  placeMarketOrder,
  cancelOrder,
  closeTrade,
  getOpenTrades,
  getPositions,
  getExecutionAnalytics,
  getSpread,
  deleteClosedTrades,
};
