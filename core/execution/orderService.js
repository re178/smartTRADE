// core/execution/orderService.js – Order Management with Multiplier Support
// Skips CFD validation for Multiplier trades.
// Uses options object for clarity.

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

const executionAnalytics = new ExecutionAnalytics({ slippageTolerance: 1 });
const MIN_CONFIDENCE = 60;
const MIN_EDGE = 0.2;

function validateAutoTradeSignal(signal) {
  if (!signal || !signal.side) return { valid: false, reason: 'No valid signal side' };
  if (signal.confidence < MIN_CONFIDENCE) return { valid: false, reason: `Confidence ${signal.confidence}% below minimum` };
  if (signal.expectedValue < MIN_EDGE) return { valid: false, reason: `Expected value ${signal.expectedValue} below minimum` };
  return { valid: true };
}

/**
 * Place a market order – supports both CFD and Multiplier.
 * @param {Object} options
 * @param {string} options.instrument - Pair (e.g., 'EURUSD')
 * @param {string} options.side - 'BUY' or 'SELL'
 * @param {number} [options.lotSize] - CFD lot size
 * @param {number} [options.stopLoss] - CFD stop loss
 * @param {number} [options.takeProfit] - CFD take profit
 * @param {number} [options.stake] - Multiplier stake
 * @param {number} [options.multiplier] - Multiplier multiplier
 * @param {number} [options.duration] - Multiplier duration (seconds)
 * @param {number} [options.knockoutLevel] - Multiplier knockout price
 * @param {number} [options.takeProfitLevel] - Multiplier take profit price
 * @param {string} [options.product='deriv_cfd'] - Trading product
 * @param {string} [options.decisionId=null] - Decision ID
 * @param {boolean} [options.autoTrade=false] - Auto-trade flag
 * @returns {Promise<Object>} { contractId, price, raw }
 */
async function placeMarketOrder(options) {
  const {
    instrument,
    side,
    lotSize,
    stopLoss,
    takeProfit,
    stake,
    multiplier,
    duration,
    knockoutLevel,
    takeProfitLevel,
    product = 'deriv_cfd',
    decisionId = null,
    autoTrade = false,
  } = options;

  const isMultiplier = stake !== undefined && stake !== null && stake > 0;
  const isCFD = lotSize !== undefined && lotSize !== null && lotSize > 0;

  if (!isMultiplier && !isCFD) {
    throw new Error('Either stake (Multiplier) or lotSize (CFD) must be provided.');
  }

  const currentPrice = await marketProvider.getCurrentPrice(instrument, product);

  // ---- Validation ----
  if (isCFD) {
    const validation = validateOrderInput({
      pair: instrument,
      side,
      lotSize,
      stopLoss: stopLoss || null,
      takeProfit: takeProfit || null,
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
    if (knockoutLevel !== null && knockoutLevel !== undefined) {
      if (side.toUpperCase() === 'BUY' && knockoutLevel >= currentPrice) {
        throw new Error('Knockout must be below current price for BUY');
      }
      if (side.toUpperCase() === 'SELL' && knockoutLevel <= currentPrice) {
        throw new Error('Knockout must be above current price for SELL');
      }
    }
    if (takeProfitLevel !== null && takeProfitLevel !== undefined) {
      if (side.toUpperCase() === 'BUY' && takeProfitLevel <= currentPrice) {
        throw new Error('Take profit must be above current price for BUY');
      }
      if (side.toUpperCase() === 'SELL' && takeProfitLevel >= currentPrice) {
        throw new Error('Take profit must be below current price for SELL');
      }
    }
  }

  // ---- Portfolio risk assessment ----
  const broker = getBroker(product);
  const account = await broker.getAccount();
  const currentPositions = await broker.getOpenTrades();

  const signal = {
    symbol: instrument,
    side,
    entryPrice: currentPrice,
    stopLoss: isCFD ? stopLoss : knockoutLevel,
    takeProfit: isCFD ? takeProfit : takeProfitLevel,
    recommendedLotSize: isCFD ? lotSize : stake,
  };

  const portfolioApproval = await portfolioIntelligence.assessNewTrade(signal, parseFloat(account.balance), currentPositions);
  if (!portfolioApproval.approved) {
    logger.warn(`[orderService] Portfolio risk rejected ${instrument} ${side}: ${portfolioApproval.reason}`);
    eventBus.emit('order.rejected', { instrument, side, reason: portfolioApproval.reason });
    throw new Error(`Portfolio risk rejection: ${portfolioApproval.reason}`);
  }

  // ---- Auto-trade pre-flight ----
  if (autoTrade && decisionId) {
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
  }

  // ---- Execute order ----
  const startTime = Date.now();
  if (!broker.capabilities?.supportsMarketOrders) throw new Error('Broker does not support market orders');
  if (!broker.isConnected()) await broker.connect();

  let result;
  if (isCFD) {
    const units = side.toUpperCase() === 'BUY' ? lotSize : -lotSize;
    result = await broker.placeMarketOrder(instrument, units, stopLoss || null, takeProfit || null);
  } else {
    // Multiplier: pass stake as units (broker expects amount = Math.abs(units))
    const units = side.toUpperCase() === 'BUY' ? stake : -stake;
    result = await broker.placeMarketOrder(instrument, units, knockoutLevel || null, takeProfitLevel || null);
    result._multiplier = multiplier;
    result._duration = duration;
  }

  const latency = Date.now() - startTime;
  const contractId = result.tradeID || result.id || result.ticket || null;
  const price = result.price || result.averagePrice || null;
  if (!contractId) throw new Error('Broker did not return a trade ID');

  // ---- Save Order ----
  const orderData = {
    contractId,
    instrument,
    side: side.toUpperCase(),
    lotSize: isCFD ? lotSize : stake,
    units: isCFD ? lotSize : stake,
    clientOrderId: contractId,
    stopLoss: isCFD ? stopLoss : knockoutLevel,
    takeProfit: isCFD ? takeProfit : takeProfitLevel,
    status: 'FILLED',
    product,
    filledPrice: price,
    placedAt: new Date(),
    // Multiplier fields
    stake: isMultiplier ? stake : null,
    multiplier: isMultiplier ? multiplier : null,
    duration: isMultiplier ? duration : null,
    knockoutLevel: isMultiplier ? knockoutLevel : null,
    takeProfitLevel: isMultiplier ? takeProfitLevel : null,
  };
  try {
    const order = new Order(orderData);
    await order.save();
  } catch (err) {
    logger.error(`[orderService] Failed to save Order: ${err.message}`);
  }

  // ---- Save Trade ----
  let trade = null;
  try {
    const tradeData = {
      contractId,
      instrument,
      side: side.toLowerCase(),
      lotSize: isCFD ? lotSize : stake,
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
      // Multiplier fields
      stake: isMultiplier ? stake : null,
      multiplier: isMultiplier ? multiplier : null,
      duration: isMultiplier ? duration : null,
      knockoutLevel: isMultiplier ? knockoutLevel : null,
      takeProfitLevel: isMultiplier ? takeProfitLevel : null,
    };
    trade = new Trade(tradeData);
    await trade.save();
    logger.info(`[orderService] Trade created (OPEN) for ${contractId}`);
  } catch (err) {
    logger.error(`[orderService] Failed to create Trade: ${err.message}`);
  }

  // ---- Analytics & Events ----
  executionAnalytics.recordExecution({
    orderId: contractId,
    instrument,
    side,
    requestedPrice: price,
    filledPrice: price,
    latency,
    spread: await broker.getSpread(instrument).catch(() => 0),
    status: 'FILLED',
    ticket: contractId,
    broker: product,
  });

  const eventPayload = {
    instrument,
    side,
    contractId,
    price,
    decisionId,
    timestamp: new Date().toISOString(),
    isMultiplier,
  };
  if (isCFD) {
    eventPayload.lotSize = lotSize;
    eventPayload.stopLoss = stopLoss;
    eventPayload.takeProfit = takeProfit;
  } else {
    eventPayload.stake = stake;
    eventPayload.multiplier = multiplier;
    eventPayload.duration = duration;
    eventPayload.knockoutLevel = knockoutLevel;
    eventPayload.takeProfitLevel = takeProfitLevel;
  }
  eventBus.emit('order.placed', eventPayload);
  eventBus.emit('trade.placed', { instrument, side, contractId, price });

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
}

// ---- Other functions (unchanged) ----
async function cancelOrder(contractId, product) {
  if (!contractId) throw new Error('contractId is required');
  const broker = getBroker(product);
  if (!broker.capabilities?.supportsCancel) throw new Error('Broker does not support cancelling pending orders');
  if (!broker.isConnected()) await broker.connect();
  const result = await broker.cancelOrder(contractId);
  await Order.findOneAndUpdate(
    { contractId },
    { status: 'CANCELLED', updatedAt: new Date() },
    { upsert: false }
  );
  eventBus.emit('order.cancelled', { contractId, result, timestamp: new Date().toISOString() });
  return result;
}

async function closeTrade(contractId, product) {
  if (!contractId) throw new Error('contractId is required');
  const broker = getBroker(product);
  if (!broker.capabilities?.supportsClose) throw new Error('Broker does not support closing trades');
  if (!broker.isConnected()) await broker.connect();
  const result = await broker.closeTrade(contractId);

  try {
    const closedTrade = await Trade.findOne({ contractId });
    if (closedTrade && closedTrade.decisionId) {
      await selfLearner.updateDecisionOutcome(closedTrade.decisionId, closedTrade);
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

async function modifyTrade(contractId, stopLoss, takeProfit, product) {
  if (!contractId) throw new Error('contractId is required');
  const broker = getBroker(product);
  if (!broker.capabilities?.supportsModify) throw new Error('Broker does not support modifying SL/TP');
  if (!broker.isConnected()) await broker.connect();
  const result = await broker.modifySLTP(contractId, stopLoss, takeProfit);

  eventBus.emit('order.modified', { contractId, stopLoss, takeProfit, result, timestamp: new Date().toISOString() });
  return result;
}

async function partialCloseTrade(contractId, closeUnits, product) {
  if (!contractId) throw new Error('contractId is required');
  if (!closeUnits || closeUnits <= 0) throw new Error('closeUnits must be a positive number');
  const broker = getBroker(product);
  if (!broker.capabilities?.supportsPartialClose) throw new Error('Broker does not support partial close');
  if (!broker.isConnected()) await broker.connect();
  const result = await broker.partialClose(contractId, closeUnits);
  eventBus.emit('trade.partialClosed', { contractId, closeUnits, result, timestamp: new Date().toISOString() });
  return result;
}

async function getOpenTrades(product) {
  const broker = getBroker(product);
  if (!broker.isConnected()) await broker.connect();
  return broker.getOpenTrades();
}

async function getPositions(product) {
  const broker = getBroker(product);
  if (!broker.isConnected()) await broker.connect();
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
  partialCloseTrade,
  getOpenTrades,
  getPositions,
  getExecutionAnalytics,
  deleteClosedTrades,
};
