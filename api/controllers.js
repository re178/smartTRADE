// api/controllers.js – Complete Request Handlers (with Multiplier support)
// Updated to accept stake, multiplier, duration, knockoutLevel, takeProfitLevel.
// Falls back to legacy lotSize/stopLoss for backward compatibility.
// Calls orderService.placeMarketOrder with options object.
//
// [CHANGE-6] Order-entry endpoints now distinguish three outcomes:
//   * FILLED                      — purchase confirmed AND DB record saved
//   * CONFIRMED_RECORD_FAILED     — purchase confirmed at Deriv but the
//                                   Order/Trade record could not be written
//                                   (returned HTTP 200 with contractId and
//                                   warning; do NOT retry)
//   * REJECTED / BROKER_ERROR     — no confirmed purchase; validation vs
//                                   unknown-error paths are distinguished
//                                   so the UI does not treat a broker error
//                                   as an ordinary rejection.
//   A confirmed purchase is never reported as `success: false`.
//   All endpoints include the confirmed contractId at the top level when
//   it is known. Queries by contractId use String(...) for consistency
//   with the models/Trade.js migration.

const Trade = require('../models/Trade');
const Order = require('../models/Order');
const User = require('../models/User');
const marketProvider = require('../core/market/provider');
const { getBroker } = require('../core/execution/brokerFactory');
const orderService = require('../core/execution/orderService');
const strategyEngine = require('../core/strategy/engine');
const riskManager = require('../core/risk/manager');
const accountService = require('../core/portfolio/accountService');
const { PortfolioManager, PerformanceLearner } = require('../core/analytics/performanceSuite');
const { notifyTrade } = require('../core/notifications/notificationService');
const { validateOrderInput } = require('../shared/validators');
const { formatSymbol } = require('../shared/helpers');
const logger = require('../infrastructure/logger') || console;

// ---- Report Generator ----
const { generateReport } = require('../core/reporting/reportGenerator');

// ---- Import broadcast function from server ----
const { broadcastToDashboards } = require('../server');

// ---------- Portfolio Manager Instance ----------
const portfolioManager = new PortfolioManager({
  maxOpenTrades: parseInt(process.env.MAX_OPEN_TRADES) || 5,
  maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS) || 0,
  maxExposure: parseFloat(process.env.MAX_EXPOSURE) || Infinity,
  maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE) || 1000,
  correlatedPairs: process.env.CORRELATED_PAIRS ? JSON.parse(process.env.CORRELATED_PAIRS) : [],
});

// ---------- Performance Learner (lazy init) ----------
let performanceLearner = null;
async function getPerformanceLearner() {
  if (!performanceLearner) {
    performanceLearner = new PerformanceLearner({
      learningRate: parseFloat(process.env.LEARNING_RATE) || 0.1,
      minSamples: parseInt(process.env.MIN_SAMPLES) || 20,
    });
    await performanceLearner.loadHistory();
  }
  return performanceLearner;
}

// ---------- Helper to get product from request ----------
function getProduct(req) {
  if (req.user && req.user.tradingProduct) {
    return req.user.tradingProduct;
  }
  return process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd';
}

// ---------- Helper: Enhance account with tradeMode and server ----------
function enhanceAccount(accountData, broker) {
  if (!accountData) return accountData;
  let tradeMode = 0;
  let server = 'Unknown';
  if (broker && broker._account) {
    tradeMode = broker._account.is_virtual !== undefined ? (broker._account.is_virtual ? 1 : 0) : 0;
    server = broker._account.landing_company_name || 'Unknown';
  }
  return {
    ...accountData,
    tradeMode,
    server,
  };
}

// ================================================================
//  [CHANGE-6] Shared order-outcome helpers
// ================================================================
// Known pre-purchase validation errors thrown by orderService before any
// broker call. Matching these is safe: no purchase can have occurred, so a
// retry (after fixing the input) is safe.
const PRE_PURCHASE_VALIDATION_PATTERNS = [
  /^Multiplier must be/,
  /^Duration must be/,
  /^Stake must be/,
  /^Knockout must be/,
  /^Take profit must be/,
  /^Portfolio risk rejection/,
  /^Auto[- ]trade rejected/,
  /^Either stake/,
  /^Order units must be/,
  /^Unknown instrument/,
  /^Invalid multiplier/,
];

// Classify the *result* of a successful orderService call. Returns 'FILLED'
// when both Order and Trade were saved, otherwise 'CONFIRMED_RECORD_FAILED'.
function classifyOrderOutcome(orderResult) {
  const rec = orderResult && orderResult.recording;
  if (!rec) return 'FILLED';
  const orderOk = !rec.order || rec.order.ok !== false;
  const tradeOk = !rec.trade || rec.trade.ok !== false;
  return (orderOk && tradeOk) ? 'FILLED' : 'CONFIRMED_RECORD_FAILED';
}

// Response for a confirmed purchase whose DB record could not be written.
// HTTP 200 so any frontend "success" check passes; the payload makes the
// failure explicit so the UI can surface it without encouraging a retry.
function respondConfirmedButUnrecorded(res, contractId, details, reason) {
  logger.warn(
    `[controllers] Purchase CONFIRMED for contract ${contractId || '<unknown>'} but not recorded: ${reason}`
  );
  return res.status(200).json({
    success: true,
    status: 'CONFIRMED_RECORD_FAILED',
    contractId: contractId ? String(contractId) : null,
    ...details,
    warning:
      'Deriv confirmed the purchase. The database record could not be written. ' +
      'DO NOT retry — the broker will reconcile this contract against its portfolio. ' +
      'Verify open positions before taking any further action.',
  });
}

// Central error handler for all order-entry endpoints.
// Distinguishes:
//   * confirmed-but-unrecorded (err.executionConfirmed / err.contractId)
//   * pre-purchase validation rejections (safe to retry)
//   * unknown broker errors (may or may not have purchased)
function handleOrderError(res, error, logTag) {
  logger.error(`[${logTag}] Error:`, error.message);

  // Case 1: purchase confirmed but the record could not be written.
  if (error.executionConfirmed === true || error.contractId) {
    return respondConfirmedButUnrecorded(
      res,
      error.contractId || null,
      {},
      error.message
    );
  }

  // Case 2: known pre-purchase validation errors — safe to retry after fix.
  const isValidation = PRE_PURCHASE_VALIDATION_PATTERNS.some(
    (re) => re.test(error.message || '')
  );
  if (isValidation) {
    return res.status(400).json({
      success: false,
      status: 'REJECTED',
      error: error.message,
      canRetry: true,
    });
  }

  // Case 3: unknown broker error. We cannot know whether a purchase went
  // through, so we MUST NOT report this as an ordinary rejection.
  return res.status(500).json({
    success: false,
    status: 'BROKER_ERROR',
    error: error.message,
    canRetry: false,
    warning:
      'The broker returned an error during execution. The purchase may or may not have gone through. ' +
      'Check open positions before retrying.',
  });
}

// ---------- User Preferences ----------
exports.getPreferences = async (req, res) => {
  try {
    const userId = req.user?.id || 'admin';
    let user = await User.findOne({ userId });
    if (!user) {
      user = new User({ userId, tradingProduct: 'deriv_cfd' });
      await user.save();
    }
    res.json({ tradingProduct: user.tradingProduct });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updatePreferences = async (req, res) => {
  const { tradingProduct } = req.body;
  const validProducts = ['mt5', 'deriv_cfd', 'deriv_multiplier', 'deriv_basic'];
  if (!validProducts.includes(tradingProduct)) {
    return res.status(400).json({ error: 'Invalid product' });
  }
  try {
    const userId = req.user?.id || 'admin';
    let user = await User.findOne({ userId });
    if (!user) {
      user = new User({ userId, tradingProduct });
    } else {
      user.tradingProduct = tradingProduct;
    }
    await user.save();
    if (req.user) req.user.tradingProduct = tradingProduct;
    res.json({ success: true, tradingProduct });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ================================================================
//  ACCOUNT – ENHANCED with tradeMode and server
// ================================================================
exports.getAccount = async (req, res) => {
  try {
    const product = getProduct(req);
    const account = await accountService.getAccount(product);

    let enhanced = account;
    try {
      const broker = getBroker(product);
      enhanced = enhanceAccount(account, broker);
    } catch (err) {
      logger.warn('[getAccount] Could not fetch broker internal state:', err.message);
    }

    res.json(enhanced);
  } catch (error) {
    logger.error('[getAccount] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

// ---------- Market Data ----------
exports.getPrices = async (req, res) => {
  const { instruments } = req.query;
  if (!instruments) return res.status(400).json({ error: 'instruments query param required' });
  try {
    const product = getProduct(req);
    const pairs = instruments.split(',');
    const prices = await marketProvider.getPrices(pairs, product);
    res.json(prices);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getCandles = async (req, res) => {
  const { pair, count = 100, granularity = 'M5' } = req.query;
  if (!pair) return res.status(400).json({ error: 'pair query param required' });
  try {
    const product = getProduct(req);
    const candles = await marketProvider.getCandles(pair, parseInt(count), granularity, product);
    res.json(candles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ---------- Symbol Metadata ----------
exports.getSymbols = async (req, res) => {
  try {
    const product = getProduct(req);
    const broker = getBroker(product);
    if (!broker.isConnected()) {
      await broker.connect();
    }
    let symbols = [];
    if (broker.symbolManager && typeof broker.symbolManager._symbols === 'object') {
      symbols = Array.from(broker.symbolManager._symbols.values());
    } else if (broker.symbols) {
      symbols = typeof broker.symbols === 'function' ? await broker.symbols() : broker.symbols;
    } else {
      try {
        const allSymbols = await marketProvider.getSymbols(product);
        if (allSymbols) symbols = allSymbols;
      } catch (e) {
        // ignore
      }
    }
    res.json(symbols);
  } catch (error) {
    logger.error('[getSymbols] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

// ---------- Broker Capabilities ----------
exports.getCapabilities = async (req, res) => {
  try {
    const product = getProduct(req);
    const broker = getBroker(product);
    const caps = broker.capabilities || {};
    const info = {
      product,
      name: broker.serverName || product,
      connected: broker.isConnected(),
      state: broker._state || 'unknown',
      capabilities: caps,
    };
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ================================================================
//  POSITIONS & TRADES – Normalised for frontend
// ================================================================
exports.getPositions = async (req, res) => {
  try {
    const product = getProduct(req);
    const broker = getBroker(product);
    const positions = await broker.getPositions();
    res.json(positions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getTrades = async (req, res) => {
  try {
    const product = getProduct(req);
    const broker = getBroker(product);
    const rawTrades = await broker.getOpenTrades();
    // [CHANGE-6-H] Additive fields entryPrice / purchasePrice from the new
    // _normalizeContract shape. `price` kept as compat alias = entryPrice.
    const trades = rawTrades.map(t => ({
      id: t.id,
      instrument: t.instrument,
      side: t.side,
      price: t.price,
      entryPrice: t.entryPrice ?? null,
      purchasePrice: t.purchasePrice ?? null,
      currentPrice: t.currentPrice,
      units: t.units,
      unrealizedPL: t.unrealizedPL,
      stopLoss: t.stopLoss,
      takeProfit: t.takeProfit,
      openTime: t.openTime,
    }));
    res.json(trades);
  } catch (error) {
    logger.error('[getTrades] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

// ================================================================
//  TRADE HISTORY – Fixed field mapping
// ================================================================
exports.getTradeHistory = async (req, res) => {
  try {
    const trades = await Trade.find({ status: 'CLOSED' }).sort({ closeTime: -1 }).lean();
    const mapped = trades.map(t => ({
      pair: t.instrument || t.pair || 'N/A',
      side: t.side || 'N/A',
      entryPrice: t.openPrice || t.entryPrice || null,
      exitPrice: t.closePrice || t.exitPrice || null,
      lotSize: t.lotSize || 0,
      pnl: t.realizedProfit !== undefined ? t.realizedProfit : (t.pnl || 0),
      status: t.status || 'CLOSED',
      date: t.closeTime || t.updatedAt || t.createdAt,
    }));
    res.json(mapped);
  } catch (error) {
    logger.error('[getTradeHistory] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

// ================================================================
//  PENDING ORDERS – Normalised for frontend
// ================================================================
exports.getPendingOrders = async (req, res) => {
  try {
    const pending = await Order.find({
      status: { $in: ['PENDING', 'ACCEPTED', 'EXECUTING'] }
    }).sort({ createdAt: -1 }).lean();
    const mapped = pending.map(o => ({
      contractId: o.contractId || o.clientOrderId,
      instrument: o.instrument,
      side: o.side,
      entryPrice: o.entryPrice || o.placedPrice,
      units: o.units || o.lotSize,
      status: o.status,
      clientOrderId: o.clientOrderId,
    }));
    res.json(mapped);
  } catch (error) {
    logger.error('[getPendingOrders] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

// ================================================================
//  PLACE ORDER – Multiplier-aware, uses orderService options
//  [CHANGE-6] Outcome-aware response shape.
// ================================================================
exports.placeOrder = async (req, res) => {
  const {
    pair,
    side,
    lotSize,
    stopLoss,
    takeProfit,
    stake,
    multiplier,
    duration,
    knockoutLevel,
    takeProfitLevel,
    product: overrideProduct,
  } = req.body;

  try {
    const product = overrideProduct || getProduct(req);
    const instrument = pair.toUpperCase();

    const isMultiplier = stake !== undefined && stake !== null && stake > 0;
    const isCFD = lotSize !== undefined && lotSize !== null && lotSize > 0;

    if (!isMultiplier && !isCFD) {
      return res.status(400).json({
        success: false,
        status: 'REJECTED',
        error: 'Either stake (Multiplier) or lotSize (CFD) must be provided.',
        canRetry: true,
      });
    }

    let orderResult;

    if (isMultiplier) {
      orderResult = await orderService.placeMarketOrder({
        instrument,
        side,
        stake,
        multiplier,
        duration,
        knockoutLevel: knockoutLevel || null,
        takeProfitLevel: takeProfitLevel || null,
        product,
      });
    } else {
      const currentPrice = await marketProvider.getCurrentPrice(instrument, product);
      const validation = validateOrderInput({
        pair: instrument,
        side,
        lotSize,
        stopLoss: stopLoss || null,
        takeProfit: takeProfit || null,
        currentPrice,
      });
      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          status: 'REJECTED',
          error: validation.message,
          canRetry: true,
        });
      }

      const broker = getBroker(product);
      const account = await broker.getAccount();
      const currentPositions = await broker.getOpenTrades();

      const signal = {
        pair: instrument,
        side,
        entryPrice: currentPrice,
        stopLoss: stopLoss || null,
        takeProfit: takeProfit || null,
        recommendedLotSize: lotSize,
      };

      const approval = await portfolioManager.canOpenTrade(signal, parseFloat(account.balance), currentPositions);
      if (!approval.allowed) {
        return res.status(400).json({
          success: false,
          status: 'REJECTED',
          error: approval.reason,
          canRetry: true,
        });
      }

      orderResult = await orderService.placeMarketOrder({
        instrument,
        side,
        lotSize,
        stopLoss: stopLoss || null,
        takeProfit: takeProfit || null,
        product,
      });
    }

    // ---- [CHANGE-6] Outcome-aware response ----
    const contractId = String(orderResult.contractId);
    const outcome = classifyOrderOutcome(orderResult);

    // Confirmed but not recorded: never report as failure, never drop the
    // contractId. The broker will repair the record via reconciliation.
    if (outcome === 'CONFIRMED_RECORD_FAILED') {
      return respondConfirmedButUnrecorded(
        res,
        contractId,
        {
          entryPrice: orderResult.entryPrice,
          purchasePrice: orderResult.purchasePrice,
          recording: orderResult.recording,
          raw: orderResult,
        },
        (orderResult.recording?.order?.error || orderResult.recording?.trade?.error || 'unknown')
      );
    }

    // Normal path — Trade should exist.
    // [CHANGE-6-G] String() for cross-model consistency with the schema migration.
    const trade = await Trade.findOne({ contractId: String(contractId) });
    if (!trade) {
      logger.warn(
        `[placeOrder] Purchase confirmed for ${contractId} but no Trade document found; ` +
        `returning contractId so the UI can track it.`
      );
      return res.status(200).json({
        success: true,
        status: 'CONFIRMED_RECORD_MISSING',
        contractId,
        trade: null,
        raw: orderResult,
        warning: 'Purchase confirmed but the Trade record is not yet visible. It should appear after reconciliation.',
      });
    }

    const broker = getBroker(product);
    const account = await broker.getAccount();
    notifyTrade('OPENED', trade, account).catch(err => logger.error('[Notification] Error:', err.message));

    return res.status(200).json({
      success: true,
      status: 'FILLED',
      contractId,
      entryPrice: orderResult.entryPrice,
      purchasePrice: orderResult.purchasePrice,
      trade,
      raw: orderResult,
    });
  } catch (error) {
    return handleOrderError(res, error, 'placeOrder');
  }
};

// ---------- Close Trade ----------
exports.closeTrade = async (req, res) => {
  const { tradeId } = req.params;
  if (!tradeId) return res.status(400).json({ error: 'tradeId required' });
  try {
    const product = getProduct(req);
    const result = await orderService.closeTrade(tradeId, product);

    try {
      const openTrades = await orderService.getOpenTrades(product);
      broadcastToDashboards('positions', openTrades);
      const account = await accountService.getAccount(product);
      const broker = getBroker(product);
      const enhanced = enhanceAccount(account, broker);
      broadcastToDashboards('account', enhanced);
    } catch (broadcastErr) {
      logger.warn('[controllers] Failed to broadcast after close:', broadcastErr.message);
    }

    portfolioManager.updateDailyPnL(result.pl || 0);
    // [CHANGE-6-G] String() for cross-model consistency.
    const updated = await Trade.findOne({ contractId: String(tradeId) });
    if (updated) {
      const broker = getBroker(product);
      const account = await broker.getAccount();
      notifyTrade('CLOSED', updated, account).catch(err => logger.error('[Notification] Error:', err.message));
      try {
        const learner = await getPerformanceLearner();
        learner.recordTrade(updated);
      } catch (err) {
        logger.warn('[PerformanceLearner] Failed to record trade:', err.message);
      }
    }
    res.json({ success: true, contractId: String(tradeId), result });
  } catch (error) {
    logger.error('[closeTrade] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

// ---------- Cancel Order ----------
exports.cancelOrder = async (req, res) => {
  const { orderId } = req.params;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  try {
    const product = getProduct(req);
    const result = await orderService.cancelOrder(orderId, product);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ---------- Delete History ----------
exports.deleteHistory = async (req, res) => {
  try {
    const count = await orderService.deleteClosedTrades();
    res.json({ success: true, deletedCount: count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ---------- Strategy & Signal ----------
exports.getSignal = async (req, res) => {
  const { pair, strategy = 'sma', ...params } = req.query;
  if (!pair) return res.status(400).json({ error: 'pair query param required' });
  try {
    const product = getProduct(req);
    const instrument = pair.toUpperCase();
    const signal = await strategyEngine.generateSignal(instrument, strategy, { ...params, product });
    if (!signal) return res.json({ signal: null, message: 'No signal generated' });
    res.json(signal);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ---------- Auto Trade (Multiplier-aware) ----------
// [CHANGE-6] Outcome-aware response shape.
exports.autoTrade = async (req, res) => {
  const { pair, riskPercent = 1, strategy = 'sma', ...params } = req.body;
  if (!pair) return res.status(400).json({ error: 'pair required' });
  try {
    const product = getProduct(req);
    const instrument = pair.toUpperCase();

    const signal = await strategyEngine.generateSignal(instrument, strategy, { ...params, product });
    if (!signal) return res.json({ success: false, status: 'NO_SIGNAL', message: 'No trading signal' });

    const currentPrice = signal.entryPrice;
    const { stake, multiplier, duration, knockoutLevel, takeProfitLevel } = req.body;
    const isMultiplier = stake !== undefined && stake !== null && stake > 0;

    let orderResult;
    if (isMultiplier) {
      orderResult = await orderService.placeMarketOrder({
        instrument,
        side: signal.side,
        stake,
        multiplier,
        duration,
        knockoutLevel: knockoutLevel || null,
        takeProfitLevel: takeProfitLevel || null,
        product,
        decisionId: null,
        autoTrade: true,
      });
    } else {
      const validation = validateOrderInput({
        pair: instrument,
        side: signal.side,
        lotSize: signal.recommendedLotSize || 0.01,
        stopLoss: signal.stopLoss || null,
        takeProfit: signal.takeProfit || null,
        currentPrice,
      });
      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          status: 'REJECTED',
          error: validation.message,
          canRetry: true,
        });
      }

      const broker = getBroker(product);
      const account = await broker.getAccount();
      const currentPositions = await broker.getOpenTrades();

      const approval = await portfolioManager.canOpenTrade(signal, parseFloat(account.balance), currentPositions);
      if (!approval.allowed) {
        return res.status(400).json({
          success: false,
          status: 'REJECTED',
          error: approval.reason,
          canRetry: true,
        });
      }

      let lotSize = signal.recommendedLotSize;
      if (!lotSize) {
        lotSize = await riskManager.calculateLotSize(instrument, signal.entryPrice, signal.stopLoss, riskPercent, 1000, product);
      }

      orderResult = await orderService.placeMarketOrder({
        instrument,
        side: signal.side,
        lotSize,
        stopLoss: signal.stopLoss || null,
        takeProfit: signal.takeProfit || null,
        product,
        decisionId: null,
        autoTrade: true,
      });
    }

    const contractId = String(orderResult.contractId);
    const outcome = classifyOrderOutcome(orderResult);

    if (outcome === 'CONFIRMED_RECORD_FAILED') {
      return respondConfirmedButUnrecorded(
        res,
        contractId,
        {
          signal,
          entryPrice: orderResult.entryPrice,
          purchasePrice: orderResult.purchasePrice,
          recording: orderResult.recording,
          raw: orderResult,
        },
        (orderResult.recording?.order?.error || orderResult.recording?.trade?.error || 'unknown')
      );
    }

    const trade = await Trade.findOne({ contractId: String(contractId) });
    if (!trade) {
      logger.warn(`[autoTrade] Purchase confirmed for ${contractId} but no Trade document found; returning contractId.`);
      return res.status(200).json({
        success: true,
        status: 'CONFIRMED_RECORD_MISSING',
        contractId,
        signal,
        trade: null,
        raw: orderResult,
      });
    }

    const broker = getBroker(product);
    const account = await broker.getAccount();
    notifyTrade('OPENED', trade, account).catch(err => logger.error('[Notification] Error:', err.message));

    return res.status(200).json({
      success: true,
      status: 'FILLED',
      contractId,
      signal,
      trade,
      raw: orderResult,
    });
  } catch (error) {
    return handleOrderError(res, error, 'autoTrade');
  }
};

// ---------- Execute Live Signal (Multiplier-aware) ----------
// [CHANGE-6] Outcome-aware response shape.
exports.executeSignal = async (req, res) => {
  const {
    pair,
    side,
    entryPrice,
    stopLoss,
    takeProfit,
    lotSize,
    stake,
    multiplier,
    duration,
    knockoutLevel,
    takeProfitLevel,
  } = req.body;

  if (!pair || !side) {
    return res.status(400).json({ error: 'pair and side are required' });
  }

  const formattedPair = formatSymbol(pair);
  const cleanSide = side.toUpperCase().trim();
  if (!['BUY', 'SELL'].includes(cleanSide)) {
    return res.status(400).json({ error: 'Side must be BUY or SELL' });
  }

  try {
    const product = getProduct(req);
    const instrument = formattedPair;

    const currentPrice = entryPrice || await marketProvider.getCurrentPrice(instrument, product);
    const isMultiplier = stake !== undefined && stake !== null && stake > 0;

    let orderResult;
    if (isMultiplier) {
      orderResult = await orderService.placeMarketOrder({
        instrument,
        side: cleanSide,
        stake,
        multiplier,
        duration,
        knockoutLevel: knockoutLevel || null,
        takeProfitLevel: takeProfitLevel || null,
        product,
      });
    } else {
      if (!lotSize || lotSize <= 0) {
        return res.status(400).json({
          success: false,
          status: 'REJECTED',
          error: 'lotSize is required for CFD trade',
          canRetry: true,
        });
      }

      const validation = validateOrderInput({
        pair: instrument,
        side: cleanSide,
        lotSize,
        stopLoss: stopLoss || null,
        takeProfit: takeProfit || null,
        currentPrice,
      });
      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          status: 'REJECTED',
          error: validation.message,
          canRetry: true,
        });
      }

      orderResult = await orderService.placeMarketOrder({
        instrument,
        side: cleanSide,
        lotSize: parseFloat(lotSize),
        stopLoss: stopLoss || null,
        takeProfit: takeProfit || null,
        product,
      });
    }

    const contractId = String(orderResult.contractId);
    const outcome = classifyOrderOutcome(orderResult);

    if (outcome === 'CONFIRMED_RECORD_FAILED') {
      return respondConfirmedButUnrecorded(
        res,
        contractId,
        {
          entryPrice: orderResult.entryPrice,
          purchasePrice: orderResult.purchasePrice,
          recording: orderResult.recording,
          raw: orderResult,
        },
        (orderResult.recording?.order?.error || orderResult.recording?.trade?.error || 'unknown')
      );
    }

    const trade = await Trade.findOne({ contractId: String(contractId) });
    if (!trade) {
      logger.warn(`[executeSignal] Purchase confirmed for ${contractId} but no Trade document found; returning contractId.`);
      return res.status(200).json({
        success: true,
        status: 'CONFIRMED_RECORD_MISSING',
        contractId,
        trade: null,
        raw: orderResult,
      });
    }

    const broker = getBroker(product);
    const account = await broker.getAccount();
    notifyTrade('OPENED', trade, account).catch(err => logger.error('[Notification] Error:', err.message));

    return res.status(200).json({
      success: true,
      status: 'FILLED',
      contractId,
      entryPrice: orderResult.entryPrice,
      purchasePrice: orderResult.purchasePrice,
      trade,
      raw: orderResult,
    });
  } catch (error) {
    return handleOrderError(res, error, 'executeSignal');
  }
};

// ============================================================
//  REPORT GENERATION – Fully Implemented
// ============================================================

exports.generateReport = async (req, res) => {
  try {
    const { from, to, includeTrades = true } = req.body;

    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const toDate = to ? new Date(to) : new Date();

    if (fromDate > toDate) {
      return res.status(400).json({ error: 'From date must be before To date' });
    }

    let trades = [];
    if (includeTrades) {
      const rawTrades = await Trade.find({
        status: 'CLOSED',
        closeTime: { $gte: fromDate, $lte: toDate }
      }).sort({ closeTime: -1 }).lean();

      trades = rawTrades.map(t => ({
        pair: t.instrument || t.pair || 'N/A',
        side: t.side || 'N/A',
        entryPrice: t.openPrice || t.entryPrice || null,
        exitPrice: t.closePrice || t.exitPrice || null,
        lotSize: t.lotSize || 0,
        pnl: t.realizedProfit !== undefined ? t.realizedProfit : (t.pnl || 0),
        status: t.status || 'CLOSED',
        date: t.closeTime || t.updatedAt || t.createdAt,
      }));
    }

    const product = getProduct(req);
    const account = await accountService.getAccount(product);

    const { calculateMetrics } = require('../core/analytics/performanceSuite');
    const metrics = calculateMetrics(trades, account.balance || 10000);

    const crypto = require('crypto');
    const reportHash = crypto.createHash('sha256')
      .update(JSON.stringify({ trades, metrics, account, fromDate, toDate }))
      .digest('hex')
      .slice(0, 16);

    const pdfBuffer = await generateReport({
      fromDate,
      toDate,
      trades,
      metrics,
      account,
      verificationCode: reportHash,
      systemName: 'RTS/CTOS v3.0 (Multiplier)',
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=RTS_Report_${new Date().toISOString().slice(0,10)}.pdf`);
    res.send(pdfBuffer);
  } catch (error) {
    logger.error('[generateReport] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

// ---------- Export helper ----------
exports.getProduct = getProduct;
