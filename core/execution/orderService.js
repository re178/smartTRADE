// core/execution/orderService.js – Order Management with Multiplier Support
// Skips CFD validation for Multiplier trades.
// Uses options object for clarity.
//
// [CHANGE-2A] contractId / entryPrice / purchasePrice are now resolved
//   explicitly. entryPrice prefers the broker's confirmed entry spot and
//   falls back to RTS's currentPrice (approximation). The old ambiguous
//   `price` is kept only as a compat alias = entryPrice.
// [CHANGE-2B] orderData.filledPrice now stores purchasePrice (amount paid
//   for the contract), not the entry spot. tradeData.openPrice and
//   currentPrice store the underlying entryPrice. Added
//   tradeData.purchasePrice (multiplier only).
// [CHANGE-2C] Spread is pre-computed with Promise.resolve().then(...).catch(0)
//   before the analytics call; fixes the ".catch is not a function" error.
// [CHANGE-2D] Order/Trade save failures are NOT swallowed. They are logged
//   with the contractId and surfaced via the returned `recording` object
//   and a `*.recordFailed` event. We do NOT throw on DB failure — the
//   purchase is already confirmed at Deriv, so the caller must be able to
//   tell "confirmed but unrecorded" apart from "rejected". Recovery is via
//   the broker's portfolio reconciliation, not by re-buying.
// [CHANGE-8] Multiplier is passed to broker.placeMarketOrder(..., { multiplier }).
//   Removed the deceptive result._multiplier / result._duration mutations.
//   Validate against Deriv's accepted multiplier set BEFORE the broker call.
// [FIX-1] Pass `duration` in the options object too, so the broker sends it
//   to Deriv. Without this, Deriv uses its ~60s default regardless of what
//   the user selected and the contract expires mid-session.
// [SUPPORTING] cancelOrder / closeTrade query with String(contractId) to
//   survive the Number -> String migration in models/Trade.js and
//   models/Order.js.

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

// [CHANGE-8] Mirror of the broker's accepted multiplier set. Used for
// fail-fast validation BEFORE any network call so invalid values never
// reach Deriv and the caller gets a clear error.
const ACCEPTED_MULTIPLIERS = [100, 200, 300, 500, 800];

function validateAutoTradeSignal(signal) {
  if (!signal || !signal.side) return { valid: false, reason: 'No valid signal side' };
  if (signal.confidence < MIN_CONFIDENCE) return { valid: false, reason: `Confidence ${signal.confidence}% below minimum` };
  if (signal.expectedValue < MIN_EDGE) return { valid: false, reason: `Expected value ${signal.expectedValue} below minimum` };
  return { valid: true };
}

/**
 * Place a market order – supports both CFD and Multiplier.
 * @returns {Promise<Object>} {
 *   contractId, price, entryPrice, purchasePrice, raw,
 *   recording: { order: {ok, error?}, trade: {ok, error?} }
 * }
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
    // [CHANGE-8] Multiplier validation — fail fast before any network call.
    const normalizedMultiplier = Math.floor(Number(multiplier));
    if (!Number.isFinite(normalizedMultiplier) || !ACCEPTED_MULTIPLIERS.includes(normalizedMultiplier)) {
      throw new Error(
        `Multiplier must be one of: ${ACCEPTED_MULTIPLIERS.join(', ')} (got ${multiplier})`
      );
    }
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
    // [CHANGE-8] Multiplier: pass stake as units AND the selected
    // multiplier as the 5th (options) argument.
    // [FIX-1] Also pass `duration` so broker.placeMarketOrder sends it to
    // Deriv. Without this, Deriv uses its ~60s default regardless of what
    // the user selected and the contract expires mid-session.
    const units = side.toUpperCase() === 'BUY' ? stake : -stake;
    result = await broker.placeMarketOrder(
      instrument,
      units,
      knockoutLevel || null,
      takeProfitLevel || null,
      {
        multiplier: Math.floor(Number(multiplier)),
        duration: parseInt(duration, 10) || 300,
      }
    );
  }

  const latency = Date.now() - startTime;

  // ---- [CHANGE-2A] Resolve contractId / entryPrice / purchasePrice ----
  const contractId = String(
    result.contractId ?? result.tradeID ?? result.id ?? result.ticket ?? ''
  );

  if (!contractId) {
    const err = new Error('Broker did not return a contract ID');
    err.executionConfirmed = false;
    throw err;
  }

  const entryPriceRaw = Number(result.entryPrice ?? currentPrice);
  if (!Number.isFinite(entryPriceRaw) || entryPriceRaw <= 0) {
    const err = new Error(
      `Execution confirmed for contract ${contractId} but no valid entry spot ` +
      `(broker entryPrice=${JSON.stringify(result.entryPrice)}, RTS currentPrice=${JSON.stringify(currentPrice)}). ` +
      `The contract is live at Deriv; repair the record via reconciliation, do NOT retry the purchase.`
    );
    err.contractId = contractId;
    err.executionConfirmed = true;
    throw err;
  }
  const entryPrice = entryPriceRaw;

  let purchasePrice = Number(
    result.purchasePrice
    ?? result.raw?.buy?.buy_price
    ?? (isMultiplier ? stake : (result.price ?? currentPrice))
  );
  if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) {
    logger.warn(
      `[orderService] Broker returned invalid purchasePrice for contract ${contractId}; ` +
      `falling back to ${isMultiplier ? 'stake' : 'entryPrice'}=${isMultiplier ? stake : entryPrice}`
    );
    purchasePrice = Number(isMultiplier ? stake : entryPrice);
  }

  // ---- Save Order ----
  // [CHANGE-2B] filledPrice = purchasePrice (amount paid), not entry spot.
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
    filledPrice: purchasePrice,
    placedAt: new Date(),
    stake: isMultiplier ? stake : null,
    multiplier: isMultiplier ? multiplier : null,
    duration: isMultiplier ? duration : null,
    knockoutLevel: isMultiplier ? knockoutLevel : null,
    takeProfitLevel: isMultiplier ? takeProfitLevel : null,
  };

  // [CHANGE-2D] Do NOT swallow failures. Track them, log with contractId,
  // emit an event so monitoring/reconciliation can pick up the gap, and
  // let the caller see the partial success. Never throw here — the buy is
  // already confirmed at Deriv; a retry would create a second contract.
  let orderSaveError = null;
  try {
    const order = new Order(orderData);
    await order.save();
  } catch (err) {
    orderSaveError = err;
    logger.error(
      `[orderService] EXECUTION CONFIRMED but ORDER RECORD FAILED for contractId=${contractId}: ${err.message}`
    );
    try {
      eventBus.emit('order.recordFailed', {
        contractId,
        instrument,
        orderData,
        error: err.message,
        timestamp: new Date().toISOString(),
      });
    } catch (_) {}
  }

  // ---- Save Trade ----
  // [CHANGE-2B] openPrice / currentPrice = entryPrice (underlying market).
  // [CHANGE-3]  purchasePrice stored separately (multiplier only).
  let trade = null;
  let tradeSaveError = null;
  try {
    const tradeData = {
      contractId,
      instrument,
      side: side.toLowerCase(),
      lotSize: isCFD ? lotSize : stake,
      openPrice: entryPrice,
      status: 'OPEN',
      openTime: new Date(),
      product,
      decisionId: decisionId || null,
      currentPrice: entryPrice,
      floatingProfit: 0,
      atrAtEntry: null,
      riskAmount: null,
      maxFloatingProfit: 0,
      stake: isMultiplier ? stake : null,
      multiplier: isMultiplier ? multiplier : null,
      duration: isMultiplier ? duration : null,
      knockoutLevel: isMultiplier ? knockoutLevel : null,
      takeProfitLevel: isMultiplier ? takeProfitLevel : null,
      purchasePrice: isMultiplier ? purchasePrice : null,
    };
    trade = new Trade(tradeData);
    await trade.save();
    logger.info(`[orderService] Trade created (OPEN) for ${contractId}`);
  } catch (err) {
    tradeSaveError = err;
    logger.error(
      `[orderService] EXECUTION CONFIRMED but TRADE RECORD FAILED for contractId=${contractId}: ${err.message}`
    );
    try {
      eventBus.emit('trade.recordFailed', {
        contractId,
        instrument,
        error: err.message,
        timestamp: new Date().toISOString(),
      });
    } catch (_) {}
  }

  // ---- [CHANGE-2C] Pre-compute spread safely ----
  const spread = await Promise.resolve()
    .then(() => broker.getSpread(instrument))
    .catch(() => 0);

  // ---- Analytics & Events ----
  executionAnalytics.recordExecution({
    orderId: contractId,
    instrument,
    side,
    requestedPrice: currentPrice,
    filledPrice: entryPrice,
    latency,
    spread,
    status: 'FILLED',
    ticket: contractId,
    broker: product,
  });

  const eventPayload = {
    instrument,
    side,
    contractId,
    price: entryPrice,
    entryPrice,
    purchasePrice,
    decisionId,
    timestamp: new Date().toISOString(),
    isMultiplier,
    recording: {
      order: orderSaveError ? { ok: false, error: orderSaveError.message } : { ok: true },
      trade: tradeSaveError ? { ok: false, error: tradeSaveError.message } : { ok: true },
    },
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
  eventBus.emit('trade.placed', { instrument, side, contractId, price: entryPrice });

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

  return {
    contractId,
    price: entryPrice,
    entryPrice,
    purchasePrice,
    raw: result,
    recording: {
      order: orderSaveError ? { ok: false, error: orderSaveError.message } : { ok: true },
      trade: tradeSaveError ? { ok: false, error: tradeSaveError.message } : { ok: true },
    },
  };
}

// ---- Other functions (unchanged unless noted) ----
async function cancelOrder(contractId, product) {
  if (!contractId) throw new Error('contractId is required');
  const broker = getBroker(product);
  if (!broker.capabilities?.supportsCancel) throw new Error('Broker does not support cancelling pending orders');
  if (!broker.isConnected()) await broker.connect();
  const result = await broker.cancelOrder(contractId);
  // [SUPPORTING] String() to survive the Number -> String migration.
  await Order.findOneAndUpdate(
    { contractId: String(contractId) },
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
    // [SUPPORTING] String() to survive the Number -> String migration.
    const closedTrade = await Trade.findOne({ contractId: String(contractId) });
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

function getExecutionAnalytics() { return executionAnalytics.getReport(); }

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
