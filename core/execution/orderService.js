// core/execution/orderService.js – Order Management (multi‑broker)

const { getBroker } = require('./brokerFactory');
const eventBus = require('../../infrastructure/eventBus');
const { validateOrderInput } = require('../../shared/validators');
const { ExecutionAnalytics } = require('../analytics/performanceSuite');
const Order = require('../../models/Order');
const Trade = require('../../models/Trade');
const logger = require('../../infrastructure/logger') || console;

const executionAnalytics = new ExecutionAnalytics({
  slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE) || 1,
});

// ---- Place Market Order ----
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

    const idStr = String(contractId);

    // ---- Create Order document ----
    const newOrder = new Order({
      contractId: idStr,
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
      pair: instrument,
      side: side.toUpperCase(),
      lotSize,
      entryPrice: price,
      stopLoss,
      takeProfit,
      status: 'OPEN',
      openTime: new Date(),
      product,
      broker: product === 'mt5' ? 'MT5' : 'Deriv',
      oandaTradeId: idStr,          // <-- the ticket number is stored here
      strategy: 'Manual',
    });
    await newTrade.save();

    const spread = await broker.getSpread(instrument).catch(() => 0);
    executionAnalytics.recordExecution({
      orderId: idStr,
      instrument,
      side,
      requestedPrice: price || 0,
      filledPrice: price || 0,
      latency,
      spread: spread || 0,
      status: 'FILLED',
      ticket: result.ticket || idStr,
      server: broker.serverName || 'unknown',
      broker: product || 'default',
    });

    eventBus.emit('order.placed', {
      instrument,
      side,
      lotSize,
      stopLoss,
      takeProfit,
      contractId: idStr,
      price,
      timestamp: new Date().toISOString(),
    });

    return { contractId: idStr, price, raw: result };
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

// ---- Cancel Order ----
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

// ---- Close Trade (FIXED: uses oandaTradeId) ----
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
    const idStr = String(contractId);

    // ---- Update Trade by oandaTradeId (the field that stores the ticket) ----
    const updatedTrade = await Trade.findOneAndUpdate(
      { oandaTradeId: idStr },   // <-- this is the key change
      {
        status: 'CLOSED',
        closeTime: new Date(),
        closePrice: result.price || null,
        pnl: result.pl || 0,
      },
      { new: true }
    );

    if (!updatedTrade) {
      logger.warn(`[closeTrade] No Trade found with oandaTradeId: ${idStr}`);
    } else {
      logger.info(`[closeTrade] Trade ${idStr} updated to CLOSED.`);
      // Also update Order if exists
      await Order.findOneAndUpdate(
        { contractId: idStr },
        { status: 'CLOSED', updatedAt: new Date() },
        { upsert: false }
      );
    }

    // ---- Record analytics ----
    executionAnalytics.recordExecution({
      orderId: contractId,
      instrument: updatedTrade?.pair || 'unknown',
      side: updatedTrade?.side || 'unknown',
      requestedPrice: 0,
      filledPrice: result.price || 0,
      latency,
      spread: 0,
      status: 'CLOSED',
      ticket: contractId,
      broker: product || 'default',
    });

    eventBus.emit('trade.closed', { contractId: idStr, result, timestamp: new Date().toISOString() });
    return result;
  } catch (err) {
    logger.error('[closeTrade] Error:', err.message);
    throw err;
  }
}

// ---- Modify Trade ----
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
  const idStr = String(contractId);
  await Order.findOneAndUpdate(
    { contractId: idStr },
    { stopLoss, takeProfit, updatedAt: new Date() },
    { upsert: false }
  );
  await Trade.findOneAndUpdate(
    { oandaTradeId: idStr },
    { stopLoss, takeProfit, updatedAt: new Date() },
    { upsert: false }
  );
  eventBus.emit('order.modified', { contractId, stopLoss, takeProfit, result, timestamp: new Date().toISOString() });
  return result;
}

// ---- Get Open Trades (unchanged) ----
async function getOpenTrades(product) {
  const broker = getBroker(product);
  if (!broker.isConnected()) {
    await broker.connect();
  }
  return broker.getOpenTrades();
}

async function getPositions(product) {
  return getOpenTrades(product);
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
