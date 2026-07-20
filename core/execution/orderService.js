// core/execution/orderService.js – Order Management (with Order & Trade models)

const { getBroker } = require('./brokerFactory');
const eventBus = require('../../infrastructure/eventBus');
const { validateOrderInput } = require('../../shared/validators');
const { ExecutionAnalytics } = require('../analytics/performanceSuite');
const Order = require('../../models/Order');
const Trade = require('../../models/Trade');
const logger = require('../../infrastructure/logger') || console;

// Singleton Execution Analytics instance
const executionAnalytics = new ExecutionAnalytics({
  slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE) || 1,
});

/**
 * Place a market order (BUY/SELL) – unchanged
 */
async function placeMarketOrder(instrument, side, lotSize, stopLoss = null, takeProfit = null, product) {
  const validation = validateOrderInput({ pair: instrument, side, lotSize, stopLoss, takeProfit });
  if (!validation.valid) {
    throw new Error(validation.message);
  }

  const broker = getBroker(product);
  const startTime = Date.now();

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

    const contractId = result.tradeID || result.id || null;
    const price = result.price || result.averagePrice || null;

    if (!contractId) {
      throw new Error('Broker did not return a trade ID');
    }

    // ---- Create Order document ----
    const newOrder = new Order({
      contractId: String(contractId),
      instrument,
      side: side.toUpperCase(),
      lotSize,
      stopLoss,
      takeProfit,
      status: 'FILLED',
      product,
      filledPrice: price,
      placedAt: new Date(),
    });
    await newOrder.save();

    // ---- Create Trade record (open trade) ----
    const newTrade = new Trade({
      contractId: String(contractId),
      instrument,
      side: side.toUpperCase(),
      lotSize,
      openPrice: price,
      status: 'OPEN',
      openTime: new Date(),
      product,
      broker: product === 'mt5' ? 'MT5' : 'Deriv',
    });
    await newTrade.save();

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
      timestamp: new Date().toISOString(),
    });

    return { contractId: String(contractId), price, raw: result };
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
 * Cancel a pending order – unchanged
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
  await Order.findOneAndUpdate(
    { contractId: String(contractId) },
    { status: 'CANCELLED', updatedAt: new Date() },
    { upsert: false }
  );
  eventBus.emit('order.cancelled', { contractId, result, timestamp: new Date().toISOString() });
  return result;
}

/**
 * Close an open trade – **ONLY CHANGE: string coercion for history**
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
    const id = String(contractId);   // <-- FORCE STRING FOR QUERY

    // ---- Update Trade record ----
    const updatedTrade = await Trade.findOneAndUpdate(
      { contractId: id },
      {
        status: 'CLOSED',
        closeTime: new Date(),
        closePrice: result.price || null,
        pnl: result.pl || 0,
      },
      { new: true }
    );
    if (!updatedTrade) {
      logger.warn(`[closeTrade] No Trade found with contractId: ${id}`);
    } else {
      logger.info(`[closeTrade] Trade ${id} updated to CLOSED.`);
      // ---- Also update Order status to CLOSED ----
      await Order.findOneAndUpdate(
        { contractId: id },
        { status: 'CLOSED', updatedAt: new Date() },
        { upsert: false }
      );
    }

    // ---- Record analytics for close ----
    executionAnalytics.recordExecution({
      orderId: contractId,
      instrument: updatedTrade?.instrument || 'unknown',
      side: updatedTrade?.side || 'unknown',
      requestedPrice: 0,
      filledPrice: result.price || 0,
      latency,
      spread: 0,
      status: 'CLOSED',
      ticket: contractId,
      broker: product || 'default',
    });

    eventBus.emit('trade.closed', { contractId: id, result, timestamp: new Date().toISOString() });
    return result;
  } catch (err) {
    logger.error('[closeTrade] Error:', err.message);
    throw err;
  }
}

/**
 * Modify stop-loss and take-profit – unchanged
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
  await Order.findOneAndUpdate(
    { contractId: String(contractId) },
    { stopLoss, takeProfit, updatedAt: new Date() },
    { upsert: false }
  );
  await Trade.findOneAndUpdate(
    { contractId: String(contractId) },
    { stopLoss, takeProfit, updatedAt: new Date() },
    { upsert: false }
  );
  eventBus.emit('order.modified', { contractId, stopLoss, takeProfit, result, timestamp: new Date().toISOString() });
  return result;
}

/**
 * Get all open trades from the broker – unchanged
 */
async function getOpenTrades(product) {
  const broker = getBroker(product);
  if (!broker.isConnected()) {
    await broker.connect();
  }
  return broker.getOpenTrades();
}

async function getPositions(product) {
  const broker = getBroker(product);
  if (!broker.isConnected()) {
    await broker.connect();
  }
  return broker.getPositions();
}

function getExecutionAnalytics() {
  return executionAnalytics.getReport();
}

async function deleteClosedTrades() {
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
