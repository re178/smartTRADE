// core/execution/orderService.js – Order Management (with Portfolio Risk Integration)

const { getBroker } = require('./brokerFactory');
const eventBus = require('../../infrastructure/eventBus');
const { validateOrderInput } = require('../../shared/validators');
const { ExecutionAnalytics } = require('../analytics/performanceSuite');
const portfolioIntelligence = require('../portfolio/intelligence');
const Order = require('../../models/Order');
const Trade = require('../../models/Trade');
const selfLearner = require('../learning/learner');
const logger = require('../../infrastructure/logger') || console;

// Singleton Execution Analytics instance
const executionAnalytics = new ExecutionAnalytics({
  slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE) || 1,
});

// Minimum confidence for auto‑trade
const MIN_CONFIDENCE = 60;
const MIN_EDGE = 0.2;

/**
 * Pre‑flight validation for auto‑trade (checks confidence and edge)
 * @param {Object} signal - signal object from decision engine
 * @returns {Object} { valid: boolean, reason: string }
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
 * @param {string} instrument - e.g., 'EUR_USD'
 * @param {string} side - 'BUY' or 'SELL'
 * @param {number} lotSize - Number of units (positive)
 * @param {number|null} stopLoss - Stop loss price (optional)
 * @param {number|null} takeProfit - Take profit price (optional)
 * @param {string} [product] - Trading product (optional, default from env)
 * @param {string} [decisionId] - HistoricalDecision ID (optional)
 * @param {boolean} [autoTrade=false] - Whether this is an auto‑trade (for additional checks)
 * @returns {Promise<Object>} { contractId, price, raw }
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
    entryPrice: 0, // will be filled by broker
    stopLoss,
    takeProfit,
    recommendedLotSize: lotSize,
  };

  // Get current price for exposure calculation
  const currentPrice = await broker.getCurrentPrice(instrument);
  signal.entryPrice = currentPrice;

  const portfolioApproval = await portfolioIntelligence.assessNewTrade(signal, parseFloat(account.balance), currentPositions);
  if (!portfolioApproval.approved) {
    logger.warn(`[orderService] Portfolio risk rejected ${instrument} ${side}: ${portfolioApproval.reason}`);
    eventBus.emit('order.rejected', { instrument, side, reason: portfolioApproval.reason });
    throw new Error(`Portfolio risk rejection: ${portfolioApproval.reason}`);
  }

  // Use adjusted lot size from portfolio assessment
  const finalLotSize = portfolioApproval.adjustedLotSize || lotSize;

  // 3. If auto‑trade, perform extra pre‑flight checks (if decisionId is provided, we can check confidence/edge from decision)
  // The caller (autoTrade controller) should pass the decision object; for now, we rely on the controller to have validated.
  // If decisionId is provided and autoTrade is true, we could fetch the decision and check confidence/edge.
  // We'll trust the controller to have done that, but we add a safety check.
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
      // If we can't fetch the decision, log but proceed (the controller should have validated)
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

    const contractId = result.tradeID || result.id || null;
    const price = result.price || result.averagePrice || null;

    if (!contractId) {
      throw new Error('Broker did not return a trade ID');
    }

    // 5. Create Order document
    const newOrder = new Order({
      contractId,
      instrument,
      side: side.toUpperCase(),
      lotSize: finalLotSize,
      stopLoss,
      takeProfit,
      status: 'FILLED',
      product,
      filledPrice: price,
      placedAt: new Date(),
    });
    await newOrder.save();

    // 6. Create Trade record (with fallback if creation fails)
    let trade = null;
    try {
      const newTrade = new Trade({
        contractId,
        instrument,
        side: side.toUpperCase(),
        lotSize: finalLotSize,
        openPrice: price,
        status: 'OPEN',
        openTime: new Date(),
        product,
        decisionId: decisionId || null,
        currentPrice: price,
        floatingProfit: 0,
      });
      trade = await newTrade.save();
      logger.debug(`[orderService] Trade created for ${contractId}`);
    } catch (tradeErr) {
      logger.warn(`[orderService] Could not create Trade for ${contractId}, but order placed:`, tradeErr.message);
      // We'll still continue; the positions sync will create the Trade later.
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
    eventBus.emit('trade.placed', { instrument, side, contractId, price }); // for sound alerts

    // 9. Update HistoricalDecision if decisionId provided
    if (decisionId) {
      try {
        const Decision = require('../../models/HistoricalDecision');
        const decision = await Decision.findById(decisionId);
        if (decision) {
          decision.outcome.executed = true;
          decision.outcome.tradeId = newTrade?._id || contractId;
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
  // Update Order status to CANCELLED
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
 * @param {string} contractId - Trade ID (ticket)
 * @param {string} [product] - Trading product (optional)
 * @returns {Promise<Object>} Result from broker.
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
  // Update Trade record
  const updatedTrade = await Trade.findOneAndUpdate(
    { contractId },
    {
      status: 'CLOSED',
      closeTime: new Date(),
      closePrice: result.price || null,
      pnl: result.pl || 0,
      realizedProfit: result.pl || 0,
    },
    { new: true }
  );
  if (!updatedTrade) {
    logger.warn(`[closeTrade] No Trade found with contractId: ${contractId}`);
  } else {
    // Update Order status to CLOSED
    await Order.findOneAndUpdate(
      { contractId },
      { status: 'CLOSED', updatedAt: new Date() },
      { upsert: false }
    );
    // If decisionId is stored, update HistoricalDecision outcome
    if (updatedTrade.decisionId) {
      try {
        await selfLearner.updateDecisionOutcome(updatedTrade.decisionId, updatedTrade);
        logger.debug(`[orderService] Decision ${updatedTrade.decisionId} outcome updated from trade ${contractId}`);
      } catch (err) {
        logger.warn(`[orderService] Failed to update decision outcome for ${updatedTrade.decisionId}:`, err.message);
      }
    }
  }

  // Record analytics for close
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
  eventBus.emit('trade.closed.sound', { contractId }); // for sound alerts
  return result;
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
  // Update Order and Trade records
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
  modifyTrade,
  getOpenTrades,
  getPositions,
  getExecutionAnalytics,
  deleteClosedTrades,
};
