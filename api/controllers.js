// api/controllers.js – Complete Request Handlers (with defensive candles)

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

const { generateReport } = require('../core/reporting/reportGenerator');
const { broadcastToDashboards } = require('../server');

const portfolioManager = new PortfolioManager({
  maxOpenTrades: parseInt(process.env.MAX_OPEN_TRADES) || 5,
  maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS) || 0,
  maxExposure: parseFloat(process.env.MAX_EXPOSURE) || Infinity,
  maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE) || 1000,
  correlatedPairs: process.env.CORRELATED_PAIRS ? JSON.parse(process.env.CORRELATED_PAIRS) : [],
});

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

function getProduct(req) {
  if (req.user && req.user.tradingProduct) return req.user.tradingProduct;
  return process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd';
}

function enhanceAccount(accountData, broker) {
  if (!accountData) return accountData;
  let tradeMode = 0;
  let server = 'Unknown';
  if (broker && broker._account) {
    tradeMode = broker._account.is_virtual !== undefined ? (broker._account.is_virtual ? 1 : 0) : 0;
    server = broker._account.landing_company_name || 'Unknown';
  }
  return { ...accountData, tradeMode, server };
}

const PRE_PURCHASE_VALIDATION_PATTERNS = [
  /^Multiplier must be/, /^Duration must be/, /^Stake must be/,
  /^Knockout must be/, /^Take profit must be/, /^Portfolio risk rejection/,
  /^Auto[- ]trade rejected/, /^Either stake/, /^Order units must be/,
  /^Unknown instrument/, /^Invalid multiplier/,
];

function classifyOrderOutcome(orderResult) {
  const rec = orderResult && orderResult.recording;
  if (!rec) return 'FILLED';
  const orderOk = !rec.order || rec.order.ok !== false;
  const tradeOk = !rec.trade || rec.trade.ok !== false;
  return (orderOk && tradeOk) ? 'FILLED' : 'CONFIRMED_RECORD_FAILED';
}

function respondConfirmedButUnrecorded(res, contractId, details, reason) {
  logger.warn(`[controllers] Purchase CONFIRMED for ${contractId || '<unknown>'} but not recorded: ${reason}`);
  return res.status(200).json({
    success: true,
    status: 'CONFIRMED_RECORD_FAILED',
    contractId: contractId ? String(contractId) : null,
    ...details,
    warning: 'Deriv confirmed the purchase. The database record could not be written. DO NOT retry.',
  });
}

function handleOrderError(res, error, logTag) {
  logger.error(`[${logTag}] Error:`, error.message);
  if (error.executionConfirmed === true || error.contractId) {
    return respondConfirmedButUnrecorded(res, error.contractId || null, {}, error.message);
  }
  const isValidation = PRE_PURCHASE_VALIDATION_PATTERNS.some(re => re.test(error.message || ''));
  if (isValidation) {
    return res.status(400).json({ success: false, status: 'REJECTED', error: error.message, canRetry: true });
  }
  return res.status(500).json({
    success: false, status: 'BROKER_ERROR', error: error.message, canRetry: false,
    warning: 'The broker returned an error. Check open positions before retrying.',
  });
}

async function broadcastHistoryUpdate() {
  try {
    const recentClosed = await Trade.find({ status: 'CLOSED' })
      .sort({ closeTime: -1 }).limit(200).lean();
    const historyPayload = recentClosed.map(t => ({
      pair: t.instrument || t.pair || 'N/A',
      side: t.side || 'N/A',
      entryPrice: t.openPrice || t.entryPrice || null,
      exitPrice: t.closePrice || t.exitPrice || null,
      lotSize: t.lotSize || 0,
      pnl: t.realizedProfit !== undefined ? t.realizedProfit : (t.pnl || 0),
      status: t.status || 'CLOSED',
      date: t.closeTime || t.updatedAt || t.createdAt,
    }));
    broadcastToDashboards('history', historyPayload);
  } catch (err) {
    logger.warn(`[controllers] broadcastHistoryUpdate failed: ${err.message}`);
  }
}

// ---------- Preferences ----------
exports.getPreferences = async (req, res) => {
  try {
    const userId = req.user?.id || 'admin';
    let user = await User.findOne({ userId });
    if (!user) { user = new User({ userId, tradingProduct: 'deriv_cfd' }); await user.save(); }
    res.json({ tradingProduct: user.tradingProduct });
  } catch (error) { res.status(500).json({ error: error.message }); }
};

exports.updatePreferences = async (req, res) => {
  const { tradingProduct } = req.body;
  const validProducts = ['mt5', 'deriv_cfd', 'deriv_multiplier', 'deriv_basic'];
  if (!validProducts.includes(tradingProduct)) return res.status(400).json({ error: 'Invalid product' });
  try {
    const userId = req.user?.id || 'admin';
    let user = await User.findOne({ userId });
    if (!user) { user = new User({ userId, tradingProduct }); } else { user.tradingProduct = tradingProduct; }
    await user.save();
    if (req.user) req.user.tradingProduct = tradingProduct;
    res.json({ success: true, tradingProduct });
  } catch (error) { res.status(500).json({ error: error.message }); }
};

// ---------- Account ----------
exports.getAccount = async (req, res) => {
  try {
    const product = getProduct(req);
    const account = await accountService.getAccount(product);
    let enhanced = account;
    try { const broker = getBroker(product); enhanced = enhanceAccount(account, broker); } catch (_) {}
    res.json(enhanced);
  } catch (error) {
    logger.error('[getAccount] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

// ---------- Prices ----------
exports.getPrices = async (req, res) => {
  const { instruments } = req.query;
  if (!instruments) return res.status(400).json({ error: 'instruments query param required' });
  try {
    const product = getProduct(req);
    const pairs = instruments.split(',');
    const prices = await marketProvider.getPrices(pairs, product);
    res.json(prices);
  } catch (error) { res.status(500).json({ error: error.message }); }
};

// ---------- CANDLES — DEFENSIVE ----------
exports.getCandles = async (req, res) => {
  const { pair, count = 100, granularity = 'M5' } = req.query;
  if (!pair) return res.status(400).json({ error: 'pair query param required' });

  try {
    const product = getProduct(req);

    // Build every plausible symbol format the broker might accept.
    const clean = String(pair).toUpperCase().replace(/[/\-_]/g, '');  // EURUSD
    const formats = [clean];
    if (clean.length === 6) {
      formats.push(clean.slice(0, 3) + '_' + clean.slice(3));           // EUR_USD
      formats.push('frx' + clean);                                      // frxEURUSD
      formats.push('frx' + clean.slice(0, 3) + '_' + clean.slice(3));   // frxEUR_USD
    } else {
      // Synthetic indices like R_100, 1HZ100V
      formats.push(pair);
    }

    // Wait for broker if it's still connecting (Render cold start).
    try {
      const broker = getBroker(product);
      if (!broker.isConnected || !broker.isConnected()) {
        logger.warn('[getCandles] Broker not connected — attempting connect');
        await broker.connect();
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (e) {
      logger.warn('[getCandles] Broker connect attempt failed:', e.message);
    }

    let lastErr = null;
    const attempts = [];

    for (const fmt of formats) {
      try {
        const candles = await marketProvider.getCandles(fmt, parseInt(count), granularity, product);
        attempts.push({ format: fmt, count: Array.isArray(candles) ? candles.length : 'not-array' });
        if (Array.isArray(candles) && candles.length > 0) {
          logger.info(`[getCandles] ${pair}: success with "${fmt}" (${candles.length} candles)`);
          return res.json(candles);
        }
      } catch (err) {
        attempts.push({ format: fmt, error: err.message });
        lastErr = err;
      }
    }

    let brokerConnected = false;
    try { const b = getBroker(product); brokerConnected = b.isConnected ? b.isConnected() : false; } catch (_) {}

    logger.error(`[getCandles] All formats failed for ${pair}. Attempts: ${JSON.stringify(attempts)}`);
    return res.status(500).json({
      error: 'No candles returned from any symbol format',
      pair, attempts,
      lastError: lastErr ? lastErr.message : 'All formats returned empty',
      brokerConnected,
      hint: brokerConnected ? 'Broker connected but candle endpoint failed.' : 'Broker not connected — wait 30s on Render cold start and retry.',
    });
  } catch (error) {
    logger.error('[getCandles] Fatal:', error.message);
    return res.status(500).json({ error: error.message, stage: 'outer-catch' });
  }
};

// ---------- Symbols ----------
exports.getSymbols = async (req, res) => {
  try {
    const product = getProduct(req);
    const broker = getBroker(product);
    if (!broker.isConnected()) await broker.connect();
    let symbols = [];
    if (broker.symbolManager && typeof broker.symbolManager._symbols === 'object') {
      symbols = Array.from(broker.symbolManager._symbols.values());
    } else if (broker.symbols) {
      symbols = typeof broker.symbols === 'function' ? await broker.symbols() : broker.symbols;
    }
    res.json(symbols);
  } catch (error) { res.status(500).json({ error: error.message }); }
};

exports.getCapabilities = async (req, res) => {
  try {
    const product = getProduct(req);
    const broker = getBroker(product);
    res.json({
      product, name: broker.serverName || product,
      connected: broker.isConnected(),
      state: broker._state || 'unknown',
      capabilities: broker.capabilities || {},
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
};

// ---------- Positions / Trades ----------
exports.getPositions = async (req, res) => {
  try {
    const product = getProduct(req);
    const broker = getBroker(product);
    const positions = await broker.getPositions();
    res.json(positions);
  } catch (error) { res.status(500).json({ error: error.message }); }
};

exports.getTrades = async (req, res) => {
  try {
    const product = getProduct(req);
    const broker = getBroker(product);
    const rawTrades = await broker.getOpenTrades();
    const trades = rawTrades.map(t => ({
      id: t.id, instrument: t.instrument, side: t.side, price: t.price,
      entryPrice: t.entryPrice ?? null, purchasePrice: t.purchasePrice ?? null,
      currentPrice: t.currentPrice, units: t.units, unrealizedPL: t.unrealizedPL,
      stopLoss: t.stopLoss, takeProfit: t.takeProfit, openTime: t.openTime,
    }));
    res.json(trades);
  } catch (error) { res.status(500).json({ error: error.message }); }
};

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
  } catch (error) { res.status(500).json({ error: error.message }); }
};

exports.getPendingOrders = async (req, res) => {
  try {
    const pending = await Order.find({ status: { $in: ['PENDING', 'ACCEPTED', 'EXECUTING'] } })
      .sort({ createdAt: -1 }).lean();
    res.json(pending.map(o => ({
      contractId: o.contractId || o.clientOrderId,
      instrument: o.instrument, side: o.side,
      entryPrice: o.entryPrice || o.placedPrice,
      units: o.units || o.lotSize,
      status: o.status, clientOrderId: o.clientOrderId,
    })));
  } catch (error) { res.status(500).json({ error: error.message }); }
};

// ---------- Place Order ----------
exports.placeOrder = async (req, res) => {
  const {
    pair, side, lotSize, stopLoss, takeProfit, stake, multiplier,
    duration, knockoutLevel, takeProfitLevel, product: overrideProduct,
  } = req.body;

  try {
    const product = overrideProduct || getProduct(req);
    const instrument = pair.toUpperCase();
    const isMultiplier = stake !== undefined && stake !== null && stake > 0;
    const isCFD = lotSize !== undefined && lotSize !== null && lotSize > 0;

    if (!isMultiplier && !isCFD) {
      return res.status(400).json({
        success: false, status: 'REJECTED',
        error: 'Either stake (Multiplier) or lotSize (CFD) must be provided.',
        canRetry: true,
      });
    }

    let orderResult;

    if (isMultiplier) {
      orderResult = await orderService.placeMarketOrder({
        instrument, side, stake, multiplier, duration,
        knockoutLevel: knockoutLevel || null,
        takeProfitLevel: takeProfitLevel || null,
        product,
      });
    } else {
      const currentPrice = await marketProvider.getCurrentPrice(instrument, product);
      const validation = validateOrderInput({
        pair: instrument, side, lotSize,
        stopLoss: stopLoss || null, takeProfit: takeProfit || null, currentPrice,
      });
      if (!validation.valid) {
        return res.status(400).json({ success: false, status: 'REJECTED', error: validation.message, canRetry: true });
      }
      const broker = getBroker(product);
      const account = await broker.getAccount();
      const currentPositions = await broker.getOpenTrades();
      const signal = { pair: instrument, side, entryPrice: currentPrice, stopLoss, takeProfit, recommendedLotSize: lotSize };
      const approval = await portfolioManager.canOpenTrade(signal, parseFloat(account.balance), currentPositions);
      if (!approval.allowed) {
        return res.status(400).json({ success: false, status: 'REJECTED', error: approval.reason, canRetry: true });
      }
      orderResult = await orderService.placeMarketOrder({
        instrument, side, lotSize,
        stopLoss: stopLoss || null, takeProfit: takeProfit || null, product,
      });
    }

    const contractId = String(orderResult.contractId);
    const outcome = classifyOrderOutcome(orderResult);

    if (outcome === 'CONFIRMED_RECORD_FAILED') {
      return respondConfirmedButUnrecorded(res, contractId, {
        entryPrice: orderResult.entryPrice, purchasePrice: orderResult.purchasePrice,
        recording: orderResult.recording, raw: orderResult,
      }, (orderResult.recording?.order?.error || orderResult.recording?.trade?.error || 'unknown'));
    }

    const trade = await Trade.findOne({ contractId: String(contractId) });
    if (!trade) {
      return res.status(200).json({
        success: true, status: 'CONFIRMED_RECORD_MISSING', contractId, trade: null, raw: orderResult,
        warning: 'Purchase confirmed but record not yet visible. Reconciliation will fix.',
      });
    }

    const broker = getBroker(product);
    const account = await broker.getAccount();
    notifyTrade('OPENED', trade, account).catch(() => {});

    return res.status(200).json({
      success: true, status: 'FILLED', contractId,
      entryPrice: orderResult.entryPrice, purchasePrice: orderResult.purchasePrice,
      trade, raw: orderResult,
    });
  } catch (error) {
    return handleOrderError(res, error, 'placeOrder');
  }
};

// ---------- Close ----------
exports.closeTrade = async (req, res) => {
  const { tradeId } = req.params;
  if (!tradeId) return res.status(400).json({ error: 'tradeId required' });
  try {
    const product = getProduct(req);
    const result = await orderService.closeTrade(tradeId, product);
    try {
      const openTrades = await orderService.getOpenTrades(product);
      broadcastToDashboards('positions', openTrades);
    } catch (_) {}
    try {
      const account = await accountService.getAccount(product);
      const broker = getBroker(product);
      broadcastToDashboards('account', enhanceAccount(account, broker));
    } catch (_) {}
    await broadcastHistoryUpdate();
    portfolioManager.updateDailyPnL(result.pl || 0);
    const updated = await Trade.findOne({ contractId: String(tradeId) });
    if (updated) {
      const broker = getBroker(product);
      const account = await broker.getAccount();
      notifyTrade('CLOSED', updated, account).catch(() => {});
      try { const learner = await getPerformanceLearner(); learner.recordTrade(updated); } catch (_) {}
    }
    res.json({ success: true, contractId: String(tradeId), result });
  } catch (error) {
    logger.error('[closeTrade] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

exports.cancelOrder = async (req, res) => {
  const { orderId } = req.params;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  try {
    const product = getProduct(req);
    const result = await orderService.cancelOrder(orderId, product);
    res.json({ success: true, result });
  } catch (error) { res.status(500).json({ error: error.message }); }
};

exports.deleteHistory = async (req, res) => {
  try {
    const count = await orderService.deleteClosedTrades();
    await broadcastHistoryUpdate();
    res.json({ success: true, deletedCount: count });
  } catch (error) { res.status(500).json({ error: error.message }); }
};

exports.getSignal = async (req, res) => {
  const { pair, strategy = 'sma', ...params } = req.query;
  if (!pair) return res.status(400).json({ error: 'pair query param required' });
  try {
    const product = getProduct(req);
    const signal = await strategyEngine.generateSignal(pair.toUpperCase(), strategy, { ...params, product });
    if (!signal) return res.json({ signal: null, message: 'No signal generated' });
    res.json(signal);
  } catch (error) { res.status(500).json({ error: error.message }); }
};

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
        instrument, side: signal.side, stake, multiplier, duration,
        knockoutLevel: knockoutLevel || null, takeProfitLevel: takeProfitLevel || null,
        product, decisionId: null, autoTrade: true,
      });
    } else {
      const validation = validateOrderInput({
        pair: instrument, side: signal.side, lotSize: signal.recommendedLotSize || 0.01,
        stopLoss: signal.stopLoss || null, takeProfit: signal.takeProfit || null, currentPrice,
      });
      if (!validation.valid) {
        return res.status(400).json({ success: false, status: 'REJECTED', error: validation.message, canRetry: true });
      }
      const broker = getBroker(product);
      const account = await broker.getAccount();
      const currentPositions = await broker.getOpenTrades();
      const approval = await portfolioManager.canOpenTrade(signal, parseFloat(account.balance), currentPositions);
      if (!approval.allowed) {
        return res.status(400).json({ success: false, status: 'REJECTED', error: approval.reason, canRetry: true });
      }
      let lotSize = signal.recommendedLotSize;
      if (!lotSize) {
        lotSize = await riskManager.calculateLotSize(instrument, signal.entryPrice, signal.stopLoss, riskPercent, 1000, product);
      }
      orderResult = await orderService.placeMarketOrder({
        instrument, side: signal.side, lotSize,
        stopLoss: signal.stopLoss || null, takeProfit: signal.takeProfit || null,
        product, decisionId: null, autoTrade: true,
      });
    }

    const contractId = String(orderResult.contractId);
    const outcome = classifyOrderOutcome(orderResult);
    if (outcome === 'CONFIRMED_RECORD_FAILED') {
      return respondConfirmedButUnrecorded(res, contractId, {
        signal, entryPrice: orderResult.entryPrice, purchasePrice: orderResult.purchasePrice,
        recording: orderResult.recording, raw: orderResult,
      }, (orderResult.recording?.order?.error || orderResult.recording?.trade?.error || 'unknown'));
    }
    const trade = await Trade.findOne({ contractId: String(contractId) });
    if (!trade) {
      return res.status(200).json({
        success: true, status: 'CONFIRMED_RECORD_MISSING', contractId, signal, trade: null, raw: orderResult,
      });
    }
    const broker = getBroker(product);
    const account = await broker.getAccount();
    notifyTrade('OPENED', trade, account).catch(() => {});
    return res.status(200).json({ success: true, status: 'FILLED', contractId, signal, trade, raw: orderResult });
  } catch (error) {
    return handleOrderError(res, error, 'autoTrade');
  }
};

exports.executeSignal = async (req, res) => {
  const {
    pair, side, entryPrice, stopLoss, takeProfit, lotSize,
    stake, multiplier, duration, knockoutLevel, takeProfitLevel,
  } = req.body;

  if (!pair || !side) return res.status(400).json({ error: 'pair and side are required' });
  const formattedPair = formatSymbol(pair);
  const cleanSide = side.toUpperCase().trim();
  if (!['BUY', 'SELL'].includes(cleanSide)) return res.status(400).json({ error: 'Side must be BUY or SELL' });

  try {
    const product = getProduct(req);
    const instrument = formattedPair;
    const currentPrice = entryPrice || await marketProvider.getCurrentPrice(instrument, product);
    const isMultiplier = stake !== undefined && stake !== null && stake > 0;

    let orderResult;
    if (isMultiplier) {
      orderResult = await orderService.placeMarketOrder({
        instrument, side: cleanSide, stake, multiplier, duration,
        knockoutLevel: knockoutLevel || null, takeProfitLevel: takeProfitLevel || null, product,
      });
    } else {
      if (!lotSize || lotSize <= 0) {
        return res.status(400).json({ success: false, status: 'REJECTED', error: 'lotSize is required for CFD trade', canRetry: true });
      }
      const validation = validateOrderInput({
        pair: instrument, side: cleanSide, lotSize,
        stopLoss: stopLoss || null, takeProfit: takeProfit || null, currentPrice,
      });
      if (!validation.valid) {
        return res.status(400).json({ success: false, status: 'REJECTED', error: validation.message, canRetry: true });
      }
      orderResult = await orderService.placeMarketOrder({
        instrument, side: cleanSide, lotSize: parseFloat(lotSize),
        stopLoss: stopLoss || null, takeProfit: takeProfit || null, product,
      });
    }

    const contractId = String(orderResult.contractId);
    const outcome = classifyOrderOutcome(orderResult);
    if (outcome === 'CONFIRMED_RECORD_FAILED') {
      return respondConfirmedButUnrecorded(res, contractId, {
        entryPrice: orderResult.entryPrice, purchasePrice: orderResult.purchasePrice,
        recording: orderResult.recording, raw: orderResult,
      }, (orderResult.recording?.order?.error || orderResult.recording?.trade?.error || 'unknown'));
    }
    const trade = await Trade.findOne({ contractId: String(contractId) });
    if (!trade) {
      return res.status(200).json({
        success: true, status: 'CONFIRMED_RECORD_MISSING', contractId, trade: null, raw: orderResult,
      });
    }
    const broker = getBroker(product);
    const account = await broker.getAccount();
    notifyTrade('OPENED', trade, account).catch(() => {});
    return res.status(200).json({
      success: true, status: 'FILLED', contractId,
      entryPrice: orderResult.entryPrice, purchasePrice: orderResult.purchasePrice, trade, raw: orderResult,
    });
  } catch (error) {
    return handleOrderError(res, error, 'executeSignal');
  }
};

exports.generateReport = async (req, res) => {
  try {
    const { from, to, includeTrades = true } = req.body;
    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const toDate = to ? new Date(to) : new Date();
    if (fromDate > toDate) return res.status(400).json({ error: 'From date must be before To date' });
    let trades = [];
    if (includeTrades) {
      const rawTrades = await Trade.find({ status: 'CLOSED', closeTime: { $gte: fromDate, $lte: toDate } })
        .sort({ closeTime: -1 }).lean();
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
      .digest('hex').slice(0, 16);
    const pdfBuffer = await generateReport({
      fromDate, toDate, trades, metrics, account,
      verificationCode: reportHash, systemName: 'RTS v2.0',
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=RTS_Report_${new Date().toISOString().slice(0, 10)}.pdf`);
    res.send(pdfBuffer);
  } catch (error) {
    logger.error('[generateReport] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

exports.getProduct = getProduct;
