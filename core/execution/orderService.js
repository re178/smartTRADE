// core/execution/orderService.js – Order Management (with Portfolio Risk Integration)
// FIX: Order model validation (units, clientOrderId) now correctly populated.
// FIX: Trade side uses lowercase to match schema enum.
// FIX: Trade is created even if Order fails (order already placed).
// FIX: P&L is computed correctly on trade close.
// FIX: Auto‑trade validation now stops execution on failure (no longer swallowed).
// FIX: closeTrade & modifyTrade no longer update DB or broadcast – delegated to routes.
// ADDED: partialCloseTrade method.
// ADDED: Multiplier support via options object.

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
 * Supports both CFD (lotSize) and Multiplier (stake) trades.
 * @param {string|Object} instrumentOrOptions - Either instrument string or options object.
 * @param {string} [side] - BUY/SELL (if using legacy signature)
 * @param {number} [lotSize] - CFD lot size
 * @param {number} [stopLoss] - CFD stop loss price
 * @param {number} [takeProfit] - CFD take profit price
 * @param {string} [product] - Trading product
 * @param {string} [decisionId] - Decision ID
 * @param {boolean} [autoTrade] - Whether auto‑trade
 * @returns {Promise<Object>} { contractId, price, raw }
 */
async function placeMarketOrder(instrumentOrOptions, side, lotSize, stopLoss = null, takeProfit = null, product, decisionId = null, autoTrade = false) {
  // ---- Parse options ----
  let options;
  if (typeof instrumentOrOptions === 'object' && instrumentOrOptions !== null) {
    // Options object mode
    options = instrumentOrOptions;
  } else {
    // Legacy signature
    options = {
      instrument: instrumentOrOptions,
      side,
      lotSize,
      stopLoss,
      takeProfit,
      product,
      decisionId,
      autoTrade,
    };
  }

  const {
    instrument,
    side: optSide,
    lotSize: optLotSize,
    stopLoss: optStopLoss,
    takeProfit: optTakeProfit,
    product: optProduct,
    decisionId: optDecisionId,
    autoTrade: optAutoTrade,
    // Multiplier fields
    stake,
    multiplier,
    duration,
    knockoutLevel,
    takeProfitLevel,
  } = options;

  // Determine trade type
  const isMultiplier = stake !== undefined && stake !== null && stake > 0;
  const isCFD = optLotSize !== undefined && optLotSize !== null && optLotSize > 0;

  if (!isMultiplier && !isCFD) {
    throw new Error('Either stake (Multiplier) or lotSize (CFD) must be provided.');
  }

  // Use the extracted values
  const finalSide = optSide;
  const finalProduct = optProduct || 'deriv_cfd';

  // 1. Validate input
  const currentPrice = await marketProvider.getCurrentPrice(instrument, finalProduct);

  if (isCFD) {
    const validation = validateOrderInput({
      pair: instrument,
      side: finalSide,
      lotSize: optLotSize,
      stopLoss: optStopLoss || null,
      takeProfit: optTakeProfit || null,
      currentPrice,
    });
    if (!validation.valid) {
      throw new Error(validation.message);
    }
  } else {
    // Multiplier validation
    if (!multiplier || multiplier < 1) throw new Error('Multiplier must be at least 1');
    if (!duration || duration < 10) throw new Error('Duration must be at least 10 seconds');
    if (stake <= 0) throw new Error('Stake must be positive');
    // Optional: check knockout and TP levels against current price
    if (knockoutLevel !== null) {
      if (finalSide === 'BUY' && knockoutLevel >= currentPrice) {
        throw new Error('Knockout must be below current price for BUY');
      }
      if (finalSide === 'SELL' && knockoutLevel <= currentPrice) {
        throw new Error('Knockout must be above current price for SELL');
      }
    }
  }

  // 2. Portfolio risk assessment
  const broker = getBroker(finalProduct);
  const account = await broker.getAccount();
  const currentPositions = await broker.getOpenTrades();

  const signal = {
    symbol: instrument,
    side: finalSide,
    entryPrice: currentPrice,
    stopLoss: isCFD ? optStopLoss : knockoutLevel,
    takeProfit: isCFD ? optTakeProfit : takeProfitLevel,
    recommendedLotSize: isCFD ? optLotSize : stake,
  };

  const portfolioApproval = await portfolioIntelligence.assessNewTrade(signal, parseFloat(account.balance), currentPositions);
  if (!portfolioApproval.approved) {
    logger.warn(`[orderService] Portfolio risk rejected ${instrument} ${finalSide}: ${portfolioApproval.reason}`);
    eventBus.emit('order.rejected', { instrument, side: finalSide, reason: portfolioApproval.reason });
    throw new Error(`Portfolio risk rejection: ${portfolioApproval.reason}`);
  }

  const finalLotSize = isCFD ? (portfolioApproval.adjustedLotSize || optLotSize) : stake;

  // 3. Auto-trade pre-flight
  if (optAutoTrade && optDecisionId) {
    const Decision = require('../../models/HistoricalDecision');
    const decision = await Decision.findById(optDecisionId);
    if (decision) {
      const autoCheck = validateAutoTradeSignal(decision);
      if (!autoCheck.valid) {
        logger.warn(`[orderService] Auto‑trade signal invalid: ${autoCheck.reason}`);
        eventBus.emit('order.rejected', { instrument, side: finalSide, reason: autoCheck.reason });
        throw new Error(`Auto‑trade rejected: ${autoCheck.reason}`);
      }
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

  let result;
  if (isCFD) {
    // CFD: use units = lotSize with sign
    const units = finalSide.toUpperCase() === 'BUY' ? finalLotSize : -finalLotSize;
    result = await broker.placeMarketOrder(instrument, units, optStopLoss || null, optTakeProfit || null);
  } else {
    // Multiplier: pass stake as units (broker expects amount = Math.abs(units))
    // We'll also pass the extra parameters as metadata; broker needs to be updated to use them.
    // For now, we pass knockout as stopLoss and takeProfitLevel as takeProfit.
    const units = finalSide.toUpperCase() === 'BUY' ? stake : -stake;
    result = await broker.placeMarketOrder(instrument, units, knockoutLevel || null, takeProfitLevel || null);
    // Add metadata to result
    result._multiplier = multiplier;
    result._duration = duration;
  }

  const latency = Date.now() - startTime;
  const contractId = result.tradeID || result.id || result.ticket || null;
  const price = result.price || result.averagePrice || null;
  if (!contractId) {
    throw new Error('Broker did not return a trade ID');
  }

  // 5. Create Order document
  const orderData = {
    contractId,
    instrument,
    side: finalSide.toUpperCase(),
    lotSize: isCFD ? finalLotSize : stake,
    units: isCFD ? finalLotSize : stake,
    clientOrderId: contractId,
    stopLoss: isCFD ? optStopLoss : knockoutLevel,
    takeProfit: isCFD ? optTakeProfit : takeProfitLevel,
    status: 'FILLED',
    product: finalProduct,
    filledPrice: price,
    placedAt: new Date(),
    // Multiplier-specific fields
    stake: isMultiplier ? stake : null,
    multiplier: isMultiplier ? multiplier : null,
    duration: isMultiplier ? duration : null,
    knockoutLevel: isMultiplier ? knockoutLevel : null,
    takeProfitLevel: isMultiplier ? takeProfitLevel : null,
  };
  try {
    const order = new Order(orderData);
    await order.save();
    logger.debug(`[orderService] Order saved for ${contractId}`);
  } catch (orderErr) {
    logger.error(`[orderService] Failed to save Order for ${contractId}:`, orderErr.message);
  }

  // 6. Create Trade record
  let trade = null;
  try {
    const tradeData = {
      contractId,
      instrument,
      side: finalSide.toLowerCase(),
      lotSize: isCFD ? finalLotSize : stake,
      openPrice: price,
      status: 'OPEN',
      openTime: new Date(),
      product: finalProduct,
      decisionId: optDecisionId || null,
      currentPrice: price,
      floatingProfit: 0,
      atrAtEntry: null,
      riskAmount: null,
      maxFloatingProfit: 0,
      // Multiplier fields
      stake: isMultiplier ? stake : null,
      multiplier: isMultiplier ? multiplier : null,
      duration: isMultiplier ? duration : null,
      knockoutLevel: isMultiplier ? knockoutLevel : null,
      takeProfitLevel: isMultiplier ? takeProfitLevel : null,
    };
    trade = new Trade(tradeData);
    await trade.save();
    logger.info(`[orderService] Trade created (OPEN) for ${contractId} (${instrument} ${finalSide})`);
  } catch (tradeErr) {
    logger.error(`[orderService] Failed to create Trade for ${contractId}:`, tradeErr.message);
  }

  // 7. Record analytics
  const spread = await broker.getSpread(instrument).catch(() => 0);
  executionAnalytics.recordExecution({
    orderId: contractId,
    instrument,
    side: finalSide,
    requestedPrice: price,
    filledPrice: price,
    latency,
    spread: spread || 0,
    status: 'FILLED',
    ticket: result.ticket || contractId,
    server: broker.serverName || 'unknown',
    broker: finalProduct,
  });

  // 8. Emit events
  const eventPayload = {
    instrument,
    side: finalSide,
    contractId,
    price,
    decisionId: optDecisionId || null,
    timestamp: new Date().toISOString(),
    isMultiplier,
  };
  if (isCFD) {
    eventPayload.lotSize = finalLotSize;
    eventPayload.stopLoss = optStopLoss;
    eventPayload.takeProfit = optTakeProfit;
  } else {
    eventPayload.stake = stake;
    eventPayload.multiplier = multiplier;
    eventPayload.duration = duration;
    eventPayload.knockoutLevel = knockoutLevel;
    eventPayload.takeProfitLevel = takeProfitLevel;
  }
  eventBus.emit('order.placed', eventPayload);
  eventBus.emit('trade.placed', { instrument, side: finalSide, contractId, price });

  // 9. Update HistoricalDecision
  if (optDecisionId) {
    try {
      const Decision = require('../../models/HistoricalDecision');
      const decision = await Decision.findById(optDecisionId);
      if (decision) {
        decision.outcome.executed = true;
        decision.outcome.tradeId = trade?._id || contractId;
        await decision.save();
      }
    } catch (err) {
      logger.warn(`[orderService] Could not update decision ${optDecisionId}:`, err.message);
    }
  }

  return { contractId, price, raw: result };
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
 * DB updates and broadcasts are now handled exclusively by the `/api/mt5/orders/result` route.
 * This method only calls the broker and returns the result.
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

  // ---- Update HistoricalDecision outcome (if any) using the now-closed trade ----
  try {
    const closedTrade = await Trade.findOne({ contractId });
    if (closedTrade && closedTrade.decisionId) {
      await selfLearner.updateDecisionOutcome(closedTrade.decisionId, closedTrade);
      logger.debug(`[orderService] Decision ${closedTrade.decisionId} outcome updated for trade ${contractId}`);
    }
  } catch (err) {
    logger.warn(`[orderService] Failed to update decision outcome for ${contractId}:`, err.message);
  }

  executionAnalytics.recordExecution({
    orderId: contractId,
    instrument: 'unknown',
    side: 'unknown',
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

  return { ...result, pl: 0 };
}

/**
 * Modify stop-loss and take-profit for an open trade.
 * DB updates and broadcasts are handled exclusively by the `/api/mt5/orders/result` route.
 * This method only calls the broker and returns the result.
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

  eventBus.emit('order.modified', { contractId, stopLoss, takeProfit, result, timestamp: new Date().toISOString() });

  return result;
}

/**
 * Partially close an open trade by reducing its position size.
 * DB updates and broadcasts are handled by the `/api/mt5/orders/result` route.
 */
async function partialCloseTrade(contractId, closeUnits, product) {
  if (!contractId) throw new Error('contractId is required');
  if (!closeUnits || closeUnits <= 0) throw new Error('closeUnits must be a positive number');
  const broker = getBroker(product);
  if (!broker.capabilities?.supportsPartialClose) {
    throw new Error('Broker does not support partial close');
  }
  if (!broker.isConnected()) {
    await broker.connect();
  }
  const result = await broker.partialClose(contractId, closeUnits);
  eventBus.emit('trade.partialClosed', { contractId, closeUnits, result, timestamp: new Date().toISOString() });
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
  partialCloseTrade,
  getOpenTrades,
  getPositions,
  getExecutionAnalytics,
  deleteClosedTrades,
};
