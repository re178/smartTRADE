// core/execution/orderService.js – Order Management (with Portfolio Risk Integration)
// FIX: Order model validation (units, clientOrderId) now correctly populated.
// FIX: Trade side uses lowercase to match schema enum.
// FIX: Trade is created even if Order fails (order already placed).
// FIX: P&L is computed correctly on trade close.
// ADDED: Real‑time broadcasts via WebSocket when trades are closed.

const { getBroker } = require('./brokerFactory');
const marketProvider = require('../market/provider');
const eventBus = require('../../infrastructure/eventBus');
const { validateOrderInput } = require('../../shared/validators');
const { ExecutionAnalytics } = require('../analytics/performanceSuite');
const portfolioIntelligence = require('../portfolio/intelligence');
const Order = require('../../models/Order');
const Trade = require('../../models/Trade');
const selfLearner = require('../learning/learner');
const logger = require('../../infrastructure/logger') || console;

// ---- IMPORT broadcast function from server for real‑time updates ----
const { broadcastToDashboards } = require('../../server');

// Singleton Execution Analytics instance
const executionAnalytics = new ExecutionAnalytics({
  slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE) || 1,
});

// Minimum confidence for auto‑trade
const MIN_CONFIDENCE = 60;
const MIN_EDGE = 0.2;

/**
 * Pre‑flight validation for auto‑trade
 */
function validateAutoTradeSignal(signal) {
  if (!signal || !signal.side) {
    return { valid: false, reason: 'No valid signal side' };
  }
  if (signal.confidence < MIN_CONFIDENCE) {
    return { valid: false, reason: `Confidence ${signal.confidence}% below minimum ${MIN_CONFIDENCE}%` };
  }
  if (signal.expectedValue < MIN_EDGE) {
    return { valid: false, reason: `Expected value ${signal.expectedValue} below minimum ${MIN_EDGE}R` };
  }
  return { valid: true, reason: 'Signal passes pre‑flight checks' };
}

/**
 * Place a market order (BUY/SELL) with portfolio risk checks.
 */
async function placeMarketOrder(instrument, side, lotSize, stopLoss = null, takeProfit = null, product, decisionId = null, autoTrade = false) {
  // 1. Validate input
  const validation = validateOrderInput({ pair: instrument, side, lotSize, stopLoss, takeProfit });
  if (!validation.valid) {
    throw new Error(validation.message);
  }

  // 2. Portfolio risk assessment
  const broker = getBroker(product);
  const account = await broker.getAccount();
  const currentPositions = await broker.getOpenTrades();
  const signal = {
    symbol: instrument,
    side,
    entryPrice: 0,
    stopLoss,
    takeProfit,
    recommendedLotSize: lotSize,
  };

  const currentPrice = await marketProvider.getCurrentPrice(instrument, product);
  signal.entryPrice = currentPrice;

  const portfolioApproval = await portfolioIntelligence.assessNewTrade(signal, parseFloat(account.balance), currentPositions);
  if (!portfolioApproval.approved) {
    logger.warn(`[orderService] Portfolio risk rejected ${instrument} ${side}: ${portfolioApproval.reason}`);
    eventBus.emit('order.rejected', { instrument, side, reason: portfolioApproval.reason });
    throw new Error(`Portfolio risk rejection: ${portfolioApproval.reason}`);
  }

  const finalLotSize = portfolioApproval.adjustedLotSize || lotSize;

  // 3. Auto-trade pre-flight
  if (autoTrade && decisionId) {
    try {
      const Decision = require('../../models/HistoricalDecision');
      const decision = await Decision.findById(decisionId);
      if (decision) {
        const autoCheck = validateAutoTradeSignal(decision);
        if (!autoCheck.valid) {
          logger.warn(`[orderService] Auto‑trade signal invalid: ${autoCheck.reason}`);
          eventBus.emit('order.rejected', { instrument, side, reason: autoCheck.reason });
          throw new Error(`Auto‑trade rejected: ${autoCheck.reason}`);
        }
      }
    } catch (err) {
      logger.warn(`[orderService] Could not validate auto‑trade signal: ${err.message}`);
    }
  }

  // 4. Execute order
  const startTime = Date.now();
  if (!broker.capabilities?.supportsMarketOrders) {
    throw new Error('Broker does not support market orders');
  }
  if (!broker.isConnected()) {
    await broker.connect();
  }

  const units = side.toUpperCase() === 'BUY' ? finalLotSize : -finalLotSize;

  try {
    const result = await broker.placeMarketOrder(instrument, units, stopLoss, takeProfit);
    const latency = Date.now() - startTime;

    const contractId = result.tradeID || result.id || result.ticket || null;
    const price = result.price || result.averagePrice || null;

    if (!contractId) {
      throw new Error('Broker did not return a trade ID');
    }

    // ---- 5. Create Order document (with required fields) ----
    const orderData = {
      contractId,
      instrument,
      side: side.toUpperCase(),
      lotSize: finalLotSize,
      units: finalLotSize,                 // required by Order schema
      clientOrderId: contractId,           // required by Order schema
      stopLoss,
      takeProfit,
      status: 'FILLED',
      product,
      filledPrice: price,
      placedAt: new Date(),
    };
    let order = null;
    try {
      order = new Order(orderData);
      await order.save();
      logger.debug(`[orderService] Order saved for ${contractId}`);
    } catch (orderErr) {
      logger.error(`[orderService] Failed to save Order for ${contractId}:`, orderErr.message);
      // We still continue to create Trade because the order is already placed.
    }

    // ---- 6. Create Trade record (with correct side case) ----
    let trade = null;
    try {
      const tradeData = {
        contractId,
        instrument,
        side: side.toLowerCase(),          // ✅ schema expects lowercase
        lotSize: finalLotSize,
        openPrice: price,
        status: 'OPEN',
        openTime: new Date(),
        product,
        decisionId: decisionId || null,
        currentPrice: price,
        floatingProfit: 0,
        atrAtEntry: null,
        riskAmount: null,
        maxFloatingProfit: 0,
      };
      trade = new Trade(tradeData);
      await trade.save();
      logger.info(`[orderService] Trade created (OPEN) for ${contractId} (${instrument} ${side})`);
    } catch (tradeErr) {
      logger.error(`[orderService] Failed to create Trade for ${contractId}:`, tradeErr.message);
      // We'll still continue; the positions sync may create it later.
    }

    // 7. Record analytics
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

    // 8. Emit events
    eventBus.emit('order.placed', {
      instrument,
      side,
      lotSize: finalLotSize,
      stopLoss,
      takeProfit,
      contractId,
      price,
      decisionId: decisionId || null,
      timestamp: new Date().toISOString(),
    });
    eventBus.emit('trade.placed', { instrument, side, contractId, price });

    // 9. Update HistoricalDecision if decisionId provided
    if (decisionId) {
      try {
        const Decision = require('../../models/HistoricalDecision');
        const decision = await Decision.findById(decisionId);
        if (decision) {
          decision.outcome.executed = true;
          decision.outcome.tradeId = trade?._id || contractId;
          await decision.save();
        }
      } catch (err) {
        logger.warn(`[orderService] Could not update decision ${decisionId}:`, err.message);
      }
    }

    return { contractId, price, raw: result };
  } catch (err) {
    eventBus.emit('order.rejected', { instrument, side, reason: err.message });
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
    { contractId },
    { status: 'CANCELLED', updatedAt: new Date() },
    { upsert: false }
  );
  eventBus.emit('order.cancelled', { contractId, result, timestamp: new Date().toISOString() });
  return result;
}

/**
 * Close an open trade by its contract ID.
 * FIX: Compute P&L from openPrice, closePrice, lotSize, side.
 * FIX: Broadcast positions and tradeClosed via WebSocket for real‑time dashboard.
 */
async function closeTrade(contractId, product) {
  if (!contractId) throw new Error('contractId is required');
  const broker = getBroker(product);
  if (!broker.capabilities?.supportsClose) {
    throw new Error('Broker does not support closing trades');
  }
  if (!broker.isConnected()) {
    await broker.connect();
  }
  const result = await broker.closeTrade(contractId);
  
  // ---- FIX: Compute P&L ourselves ----
  const trade = await Trade.findOne({ contractId });
  let pl = 0;
  if (trade && trade.openPrice && result.price) {
    const multiplier = trade.side && trade.side.toUpperCase() === 'BUY' ? 1 : -1;
    pl = (result.price - trade.openPrice) * trade.lotSize * multiplier;
  }
  
  const updatedTrade = await Trade.findOneAndUpdate(
    { contractId },
    {
      status: 'CLOSED',
      closeTime: new Date(),
      closePrice: result.price || null,
      pnl: pl,
      realizedProfit: pl,
    },
    { new: true }
  );
  if (!updatedTrade) {
    logger.warn(`[closeTrade] No Trade found with contractId: ${contractId}`);
  } else {
    await Order.findOneAndUpdate(
      { contractId },
      { status: 'CLOSED', updatedAt: new Date() },
      { upsert: false }
    );
    if (updatedTrade.decisionId) {
      try {
        await selfLearner.updateDecisionOutcome(updatedTrade.decisionId, updatedTrade);
        logger.debug(`[orderService] Decision ${updatedTrade.decisionId} outcome updated from trade ${contractId}`);
      } catch (err) {
        logger.warn(`[orderService] Failed to update decision outcome for ${updatedTrade.decisionId}:`, err.message);
      }
    }
  }

  // ---- BROADCAST REAL‑TIME EVENTS ----
  try {
    const openTrades = await getOpenTrades('mt5');
    // broadcast positions and tradeClosed to all dashboard clients
    broadcastToDashboards('positions', openTrades);
    broadcastToDashboards('tradeClosed', { contractId, price: result.price, pl });
  } catch (err) {
    logger.warn('[orderService] Failed to broadcast trade close:', err.message);
  }

  executionAnalytics.recordExecution({
    orderId: contractId,
    instrument: updatedTrade?.instrument || 'unknown',
    side: updatedTrade?.side || 'unknown',
    requestedPrice: 0,
    filledPrice: result.price || 0,
    latency: 0,
    spread: 0,
    status: 'CLOSED',
    ticket: contractId,
    broker: product || 'default',
  });

  eventBus.emit('trade.closed', { contractId, result, timestamp: new Date().toISOString() });
  eventBus.emit('trade.closed.sound', { contractId });
  return { ...result, pl };
}

/**
 * Modify stop-loss and take-profit for an open trade.
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
    { contractId },
    { stopLoss, takeProfit, updatedAt: new Date() },
    { upsert: false }
  );
  await Trade.findOneAndUpdate(
    { contractId },
    { stopLoss, takeProfit, updatedAt: new Date() },
    { upsert: false }
  );
  eventBus.emit('order.modified', { contractId, stopLoss, takeProfit, result, timestamp: new Date().toISOString() });
  
  // ---- BROADCAST updated positions ----
  try {
    const openTrades = await getOpenTrades('mt5');
    broadcastToDashboards('positions', openTrades);
  } catch (err) {
    logger.warn('[orderService] Failed to broadcast positions after modify:', err.message);
  }
  
  return result;
}

/**
 * Get all open trades from the broker.
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
 */
function getExecutionAnalytics() {
  return executionAnalytics.getReport();
}

/**
 * Delete all closed trades from the Trade collection.
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
  modifyTrade,
  getOpenTrades,
  getPositions,
  getExecutionAnalytics,
  deleteClosedTrades,
};
