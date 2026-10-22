// core/execution/orderService.js – Order Management with Multiplier Support
//
// [FILE-ORDERFIX-1] Robust current-price fetch before SL/TP validation.
//   (See prior revision notes — retained unchanged.)
// [FILE-4] Strategy attribution:
//   • placeMarketOrder accepts { strategy, regimeCode, entryThesis }
//   • strategy name stored on Trade.strategy
//   • regimeCode stored on Trade.entryThesis.regime
//   • entryThesis (optional) stored on Trade.entryThesis
//   • Order.metadata.strategy records the same for audit
//   • trade.closed event includes strategy so the performance recorder
//     knows which strategy to credit without a second DB query
//   • closeTrade reads strategy from Trade and includes in its result
//
// All callers that don't pass `strategy` still work — fields default to null.
// This file does NOT wire the ranker or server; it only stores what the
// caller passes. The pipeline integration happens in File 7.

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
const ACCEPTED_MULTIPLIERS = [100, 200, 300, 500, 800];

// ---- Pip size lookup ----
function getPipSize(symbol) {
  if (!symbol) return 0.0001;
  const clean = symbol.replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
  const pipMap = {
    EURUSD: 0.0001, GBPUSD: 0.0001, AUDUSD: 0.0001, NZDUSD: 0.0001,
    USDCHF: 0.0001, USDCAD: 0.0001,
    USDJPY: 0.01, EURJPY: 0.01, GBPJPY: 0.01, AUDJPY: 0.01,
    XAUUSD: 0.01, XAGUSD: 0.001,
    BTCUSD: 0.1, ETHUSD: 0.01,
  };
  return pipMap[clean] || 0.0001;
}

function validateAutoTradeSignal(signal) {
  if (!signal || !signal.side) return { valid: false, reason: 'No valid signal side' };
  if (signal.confidence < MIN_CONFIDENCE) return { valid: false, reason: `Confidence ${signal.confidence}% below minimum` };
  if (signal.expectedValue < MIN_EDGE) return { valid: false, reason: `Expected value ${signal.expectedValue} below minimum` };
  return { valid: true };
}

/**
 * Fetch current price. Broker cache first (authoritative), marketProvider
 * fallback. Returns null if neither source has a usable number.
 */
async function fetchCurrentPrice(broker, instrument, product) {
  try {
    const prices = await broker.getPrices([instrument]);
    if (prices && prices.length > 0) {
      const p = prices[0];
      if (p.bids?.[0]?.price != null && p.asks?.[0]?.price != null) {
        const bid = parseFloat(p.bids[0].price);
        const ask = parseFloat(p.asks[0].price);
        if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
          return (bid + ask) / 2;
        }
      }
    }
  } catch (err) {
    logger.warn(`[orderService] Broker price fetch failed for ${instrument}: ${err.message}`);
  }

  try {
    const mp = await marketProvider.getCurrentPrice(instrument, product);
    if (Number.isFinite(mp) && mp > 0) return mp;
  } catch (err) {
    logger.warn(`[orderService] marketProvider price fetch failed for ${instrument}: ${err.message}`);
  }

  return null;
}

/**
 * Place a market order – supports both CFD and Multiplier.
 *
 * @param {Object} options
 * @param {string} [options.strategy]       — strategy that generated the signal (File 4)
 * @param {string} [options.regimeCode]     — market regime at open time (File 4)
 * @param {Object} [options.entryThesis]    — optional thesis snapshot (File 4)
 * @returns {Promise<Object>}
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
    // [FILE-4]
    strategy = null,
    regimeCode = null,
    entryThesis = null,
  } = options;

  const isMultiplier = stake !== undefined && stake !== null && stake > 0;
  const isCFD = lotSize !== undefined && lotSize !== null && lotSize > 0;

  if (!isMultiplier && !isCFD) {
    throw new Error('Either stake (Multiplier) or lotSize (CFD) must be provided.');
  }

  // ============ STEP 1: Broker + connection FIRST ============
  const broker = getBroker(product);
  if (!broker.isConnected()) {
    try {
      await broker.connect();
    } catch (err) {
      logger.warn(`[orderService] Broker connect failed: ${err.message}`);
    }
  }

  // ============ STEP 2: Fetch price with validated fallback ============
  const currentPrice = await fetchCurrentPrice(broker, instrument, product);
  const hasValidPrice = Number.isFinite(currentPrice) && currentPrice > 0;

  if (hasValidPrice) {
    logger.info(`[orderService] ${instrument} current price: ${currentPrice.toFixed(5)}`);
  } else {
    logger.warn(`[orderService] No valid price for ${instrument} (got ${currentPrice}) — SL/TP validation will require price.`);
  }

  // ============ STEP 3: Validation ============
  const pipSize = getPipSize(instrument);
  const tolerance = pipSize * 0.5;

  if (isCFD) {
    if (!hasValidPrice) {
      throw new Error(
        `Cannot validate CFD order: current market price for ${instrument} is unavailable. ` +
        `Wait a few seconds and retry.`
      );
    }
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
    const normalizedMultiplier = Math.floor(Number(multiplier));
    if (!Number.isFinite(normalizedMultiplier) || !ACCEPTED_MULTIPLIERS.includes(normalizedMultiplier)) {
      throw new Error(`Multiplier must be one of: ${ACCEPTED_MULTIPLIERS.join(', ')} (got ${multiplier})`);
    }
    if (!duration || duration < 10) throw new Error('Duration must be at least 10 seconds');
    if (stake <= 0) throw new Error('Stake must be positive');

    const hasSL = knockoutLevel != null && knockoutLevel !== '';
    const hasTP = takeProfitLevel != null && takeProfitLevel !== '';

    if (hasSL || hasTP) {
      if (!hasValidPrice) {
        throw new Error(
          `Cannot validate ${hasSL ? 'stop loss' : 'take profit'}: ` +
          `current market price for ${instrument} is unavailable. ` +
          `Wait a few seconds and retry, or remove the ${hasSL ? 'stop loss' : 'take profit'}.`
        );
      }

      const isBuy = side.toUpperCase() === 'BUY';
      const slNum = hasSL ? Number(knockoutLevel) : null;
      const tpNum = hasTP ? Number(takeProfitLevel) : null;

      if (slNum != null && Number.isFinite(slNum)) {
        if (isBuy && slNum >= currentPrice - tolerance) {
          const suggested = (currentPrice - pipSize * 10).toFixed(5);
          throw new Error(
            `Stop loss (${slNum.toFixed(5)}) must be below current price (${currentPrice.toFixed(5)}) for BUY. ` +
            `Suggested SL: ${suggested} (10 pips below current price).`
          );
        }
        if (!isBuy && slNum <= currentPrice + tolerance) {
          const suggested = (currentPrice + pipSize * 10).toFixed(5);
          throw new Error(
            `Stop loss (${slNum.toFixed(5)}) must be above current price (${currentPrice.toFixed(5)}) for SELL. ` +
            `Suggested SL: ${suggested} (10 pips above current price).`
          );
        }
      }

      if (tpNum != null && Number.isFinite(tpNum)) {
        if (isBuy && tpNum <= currentPrice + tolerance) {
          const suggested = (currentPrice + pipSize * 10).toFixed(5);
          throw new Error(
            `Take profit (${tpNum.toFixed(5)}) must be above current price (${currentPrice.toFixed(5)}) for BUY. ` +
            `Suggested TP: ${suggested} (10 pips above current price).`
          );
        }
        if (!isBuy && tpNum >= currentPrice - tolerance) {
          const suggested = (currentPrice - pipSize * 10).toFixed(5);
          throw new Error(
            `Take profit (${tpNum.toFixed(5)}) must be below current price (${currentPrice.toFixed(5)}) for SELL. ` +
            `Suggested TP: ${suggested} (10 pips below current price).`
          );
        }
      }
    }
  }

  // ============ STEP 4: Portfolio risk ============
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

  const portfolioApproval = await portfolioIntelligence.assessNewTrade(
    signal, parseFloat(account.balance), currentPositions
  );
  if (!portfolioApproval.approved) {
    logger.warn(`[orderService] Portfolio risk rejected ${instrument} ${side}: ${portfolioApproval.reason}`);
    eventBus.emit('order.rejected', { instrument, side, reason: portfolioApproval.reason });
    throw new Error(`Portfolio risk rejection: ${portfolioApproval.reason}`);
  }

  // ============ STEP 5: Auto-trade pre-flight ============
  if (autoTrade && decisionId) {
    const Decision = require('../../models/HistoricalDecision');
    const decision = await Decision.findById(decisionId);
    if (decision) {
      const autoCheck = validateAutoTradeSignal(decision);
      if (!autoCheck.valid) {
        logger.warn(`[orderService] Auto-trade signal invalid: ${autoCheck.reason}`);
        eventBus.emit('order.rejected', { instrument, side, reason: autoCheck.reason });
        throw new Error(`Auto-trade rejected: ${autoCheck.reason}`);
      }
    }
  }

  // ============ STEP 6: Execute order ============
  const startTime = Date.now();
  if (!broker.capabilities?.supportsMarketOrders) throw new Error('Broker does not support market orders');

  let result;
  if (isCFD) {
    const units = side.toUpperCase() === 'BUY' ? lotSize : -lotSize;
    result = await broker.placeMarketOrder(instrument, units, stopLoss || null, takeProfit || null);
  } else {
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

  // ============ STEP 7: Resolve contractId / prices ============
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
      `(broker entryPrice=${JSON.stringify(result.entryPrice)}, currentPrice=${JSON.stringify(currentPrice)}). ` +
      `Contract is live at Deriv; repair via reconciliation, do NOT retry.`
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

  // ============ STEP 8: Save Order ============
  // [FILE-4] strategy in metadata.strategy for audit
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
    metadata: {
      strategy: strategy || null,
      regimeCode: regimeCode || null,
    },
  };

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
        contractId, instrument, orderData, error: err.message,
        timestamp: new Date().toISOString(),
      });
    } catch (_) {}
  }

  // ============ STEP 9: Save Trade ============
  // [FILE-4] strategy + regimeCode + entryThesis stored on Trade
  // - strategy → Trade.strategy (schema field, already exists)
  // - regimeCode → Trade.entryThesis.regime (schema field, already exists)
  // - entryThesis → merged over Trade.entryThesis
  let trade = null;
  let tradeSaveError = null;
  try {
    const thesisSnapshot = {
      ...(entryThesis && typeof entryThesis === 'object' ? entryThesis : {}),
    };
    if (regimeCode != null) thesisSnapshot.regime = regimeCode;
    if (Object.keys(thesisSnapshot).length === 0) thesisSnapshot.regime = null;

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
      // [FILE-4]
      strategy: strategy || null,
      entryThesis: thesisSnapshot,
    };
    trade = new Trade(tradeData);
    await trade.save();
    logger.info(
      `[orderService] Trade created (OPEN) for ${contractId}` +
      (strategy ? ` [strategy=${strategy}${regimeCode ? `, regime=${regimeCode}` : ''}]` : '')
    );
  } catch (err) {
    tradeSaveError = err;
    logger.error(
      `[orderService] EXECUTION CONFIRMED but TRADE RECORD FAILED for contractId=${contractId}: ${err.message}`
    );
    try {
      eventBus.emit('trade.recordFailed', {
        contractId, instrument, error: err.message,
        timestamp: new Date().toISOString(),
      });
    } catch (_) {}
  }

  // ============ STEP 10: Spread (safe) ============
  const spread = await Promise.resolve()
    .then(() => broker.getSpread(instrument))
    .catch(() => 0);

  // ============ STEP 11: Analytics & events ============
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
    // [FILE-4]
    strategy: strategy || null,
    regimeCode: regimeCode || null,
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
  eventBus.emit('trade.placed', {
    instrument,
    side,
    contractId,
    price: entryPrice,
    strategy: strategy || null,   // [FILE-4]
    regimeCode: regimeCode || null,
  });

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
    // [FILE-4] echo back so the caller / frontend can confirm
    strategy: strategy || null,
    regimeCode: regimeCode || null,
    raw: result,
    recording: {
      order: orderSaveError ? { ok: false, error: orderSaveError.message } : { ok: true },
      trade: tradeSaveError ? { ok: false, error: tradeSaveError.message } : { ok: true },
    },
  };
}

// ---- Other functions ----
async function cancelOrder(contractId, product) {
  if (!contractId) throw new Error('contractId is required');
  const broker = getBroker(product);
  if (!broker.capabilities?.supportsCancel) throw new Error('Broker does not support cancelling pending orders');
  if (!broker.isConnected()) await broker.connect();
  const result = await broker.cancelOrder(contractId);
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

  // [FILE-4] Load trade to get strategy + regime + P/L for downstream credit
  let closedTrade = null;
  try {
    closedTrade = await Trade.findOne({ contractId: String(contractId) });
  } catch (err) {
    logger.warn(`[orderService] closeTrade lookup failed for ${contractId}: ${err.message}`);
  }

  // SelfLearner update (existing behaviour, preserved)
  try {
    if (closedTrade && closedTrade.decisionId) {
      await selfLearner.updateDecisionOutcome(closedTrade.decisionId, closedTrade);
    }
  } catch (err) {
    logger.warn(`[orderService] Failed to update decision outcome for ${contractId}:`, err.message);
  }

  executionAnalytics.recordExecution({
    orderId: contractId, instrument: 'unknown', side: 'unknown',
    requestedPrice: 0, filledPrice: result.price || 0,
    latency: 0, spread: 0, status: 'CLOSED', ticket: contractId,
    broker: product || 'default',
  });

  // [FILE-4] trade.closed now carries strategy + regime + profit + risk for
  // the StrategyPerformance recorder (File 7 wires the listener)
  const closedPayload = {
    contractId,
    result,
    timestamp: new Date().toISOString(),
    // [FILE-4]
    strategy: closedTrade?.strategy || null,
    regimeCode: closedTrade?.entryThesis?.regime || null,
    realizedProfit: closedTrade?.realizedProfit ?? closedTrade?.pnl ?? null,
    riskAmount: closedTrade?.riskAmount ?? closedTrade?.stake ?? null,
    instrument: closedTrade?.instrument || null,
  };
  eventBus.emit('trade.closed', closedPayload);
  eventBus.emit('trade.closed.sound', { contractId });

  return {
    ...result,
    pl: 0,
    // [FILE-4] echo strategy for callers (e.g. dashboard notification)
    strategy: closedTrade?.strategy || null,
  };
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
