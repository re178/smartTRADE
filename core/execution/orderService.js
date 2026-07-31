// core/execution/orderService.js – Order Management (Execution Layer only)
// ⚠️ Trade persistence is now handled by the MT5 sync (POST /positions and POST /orders/result)
// This service remains responsible for: sending commands, analytics, and event emission.

const { getBroker } = require('./brokerFactory');
const eventBus = require('../../infrastructure/eventBus');
const { validateOrderInput } = require('../../shared/validators');
const { ExecutionAnalytics } = require('../analytics/performanceSuite');
const Order = require('../../models/Order'); // optional internal tracking (kept for compatibility)
const logger = require('../../infrastructure/logger') || console;

// Singleton Execution Analytics instance
const executionAnalytics = new ExecutionAnalytics({
  slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE) || 1,
});

/**
 * Place a market order (BUY/SELL)
 * @param {string} instrument - e.g., 'EUR_USD'
 * @param {string} side - 'BUY' or 'SELL'
 * @param {number} lotSize - Number of units (positive)
 * @param {number|null} stopLoss - Stop loss price (optional)
 * @param {number|null} takeProfit - Take profit price (optional)
 * @param {string} [product] - Trading product (optional, default from env)
 * @param {string} [decisionId] - ID of the HistoricalDecision that generated this trade (for audit)
 * @returns {Promise<Object>} { contractId, price, raw }
 */
async function placeMarketOrder(instrument, side, lotSize, stopLoss = null, takeProfit = null, product, decisionId = null) {
  const validation = validateOrderInput({ pair: instrument, side, lotSize, stopLoss, takeProfit });
  if (!validation.valid) {
    throw new Error(validation.message);
  }

  const broker = getBroker(product);
  const startTime = Date.now();

  // ---- Capability check ----
  if (!broker.capabilities?.supportsMarketOrders) {
    throw new Error('Broker does not support market orders');
  }

  if (!broker.isConnected()) {
    await broker.connect();
  }

  const units = side.toUpperCase() === 'BUY' ? lotSize : -lotSize;

  try {
    const result = await broker.placeMarketOrder(instrument, units, stopLoss, takeProfit);
    const latency = Date.now() - startTime;

    // ---- Extract contractId and price from result ----
    const contractId = result.tradeID || result.id || null;
    const price = result.price || result.averagePrice || null;

    if (!contractId) {
      throw new Error('Broker did not return a trade ID');
    }

    // ---- (Optional) Create an internal Order record for tracking the request ----
    // This is kept for compatibility; the actual trade state comes from MT5 sync.
    const newOrder = new Order({
      contractId,
      instrument,
      side: side.toUpperCase(),
      lotSize,
      stopLoss,
      takeProfit,
      status: 'FILLED',
      product,
      filledPrice: price,
      placedAt: new Date(),
      decisionId: decisionId || null,
    });
    await newOrder.save().catch(err => logger.warn('[orderService] Order save failed (non‑critical):', err.message));

    // ---- Record analytics ----
    const spread = await broker.getSpread(instrument).catch(() => 0);
    executionAnalytics.recordExecution({
      orderId: contractId,
      instrument,
      side,
      requestedPrice: price || 0,
      filledPrice: price || 0,
      latency,
      spread: spread || 0,
      status: 'FILLED',
      ticket: result.ticket || contractId,
      server: broker.serverName || 'unknown',
      broker: product || 'default',
    });

    eventBus.emit('order.placed', {
      instrument,
      side,
      lotSize,
      stopLoss,
      takeProfit,
      contractId,
      price,
      decisionId: decisionId || null,
      timestamp: new Date().toISOString(),
    });

    // ⚠️ Trade persistence is now handled by POST /positions sync.
    // Decision outcome updates are handled in POST /orders/result.

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
      error: err.message,
      broker: product || 'default',
    });
    throw err;
  }
}

/**
 * Cancel a pending order by its contract ID.
 * @param {string} contractId - The contract/trade ID (ticket)
 * @param {string} [product] - Trading product (optional)
 * @returns {Promise<Object>} Result from broker.
 */
async function cancelOrder(contractId, product) {
  if (!contractId) throw new Error('contractId is required');
  const broker = getBroker(product);
  if (!broker.capabilities?.supportsCancel) {
    throw new Error('Broker does not support cancelling pending orders');
  }
  if (!broker.isConnected()) {
    await broker.connect();
  }
  const result = await broker.cancelOrder(contractId);
  // Update internal Order status (optional, non‑critical)
  await Order.findOneAndUpdate(
    { contractId },
    { status: 'CANCELLED', updatedAt: new Date() },
    { upsert: false }
  ).catch(err => logger.warn('[orderService] Order update failed:', err.message));
  eventBus.emit('order.cancelled', { contractId, result, timestamp: new Date().toISOString() });
  return result;
}

/**
 * Close an open trade by its contract ID.
 * @param {string} contractId - Trade ID (contract ID)
 * @param {string} [product] - Trading product (optional)
 * @returns {Promise<Object>} Result from broker.
 */
async function closeTrade(contractId, product) {
  if (!contractId) throw new Error('contractId is required');
  const broker = getBroker(product);
  if (!broker.capabilities?.supportsClose) {
    throw new Error('Broker does not support closing trades');
  }
  const startTime = Date.now();
  if (!broker.isConnected()) {
    await broker.connect();
  }
  try {
    const result = await broker.closeTrade(contractId);
    const latency = Date.now() - startTime;

    // ---- Record analytics for close ----
    executionAnalytics.recordExecution({
      orderId: contractId,
      instrument: 'unknown', // could be fetched from Trade if needed, but not critical
      side: 'unknown',
      requestedPrice: 0,
      filledPrice: result.price || 0,
      latency,
      spread: 0,
      status: 'CLOSED',
      ticket: contractId,
      broker: product || 'default',
    });

    eventBus.emit('trade.closed', { contractId, result, timestamp: new Date().toISOString() });

    // ⚠️ Trade finalization is handled by POST /orders/result when the command completes.
    // We do NOT update Trade model here.

    return result;
  } catch (err) {
    logger.error('[closeTrade] Error:', err.message);
    throw err;
  }
}

/**
 * Modify stop-loss and take-profit for an open trade.
 * @param {string} contractId - Trade ID (ticket)
 * @param {number|null} stopLoss - New stop loss (or null to leave unchanged)
 * @param {number|null} takeProfit - New take profit (or null to leave unchanged)
 * @param {string} [product] - Trading product (optional)
 * @returns {Promise<Object>} Result from broker.
 */
async function modifyTrade(contractId, stopLoss, takeProfit, product) {
  if (!contractId) throw new Error('contractId is required');
  const broker = getBroker(product);
  if (!broker.capabilities?.supportsModify) {
    throw new Error('Broker does not support modifying SL/TP');
  }
  if (!broker.isConnected()) {
    await broker.connect();
  }
  const result = await broker.modifySLTP(contractId, stopLoss, takeProfit);
  // Update internal Order/Trade records (non‑critical, MT5 sync will catch up)
  await Order.findOneAndUpdate(
    { contractId },
    { stopLoss, takeProfit, updatedAt: new Date() },
    { upsert: false }
  ).catch(err => logger.warn('[orderService] Order update failed:', err.message));
  // We no longer update Trade here – the MT5 sync will pick up the new SL/TP.
  eventBus.emit('order.modified', { contractId, stopLoss, takeProfit, result, timestamp: new Date().toISOString() });
  return result;
}

/**
 * Get all open trades from the broker.
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
 * Delete all closed trades from the Trade collection (utility, if needed).
 * NOTE: This operates on the Trade model, which is now synced from MT5.
 * @returns {Promise<number>} Number of deleted records.
 */
async function deleteClosedTrades() {
  const Trade = require('../../models/Trade'); // lazy require to avoid circular
  const result = await Trade.deleteMany({ status: 'CLOSED' });
  logger.info(`Deleted ${result.deletedCount} closed trades from history.`);
  return result.deletedCount;
}

module.exports = {
  placeMarketOrder,
  cancelOrder,
  closeTrade,
  modifyTrade,
  getOpenTrades,
  getPositions,
  getExecutionAnalytics,
  deleteClosedTrades,
};
