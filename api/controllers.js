// api/controllers.js – Complete Request Handlers (with product support)

const Trade = require('../models/Trade');
const marketProvider = require('../core/market/provider');
const { getBroker } = require('../core/execution/brokerFactory');
const orderService = require('../core/execution/orderService');
const strategyEngine = require('../core/strategy/engine');
const riskManager = require('../core/risk/manager');
const portfolioLogger = require('../core/portfolio/logger');
const accountService = require('../core/portfolio/accountService');
const { PortfolioManager, PerformanceLearner } = require('../core/analytics/performanceSuite');
const { notifyTrade } = require('../core/notifications/notificationService');
const { validateOrderInput } = require('../shared/validators');
const logger = require('../infrastructure/logger') || console;

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
  return req.user?.tradingProduct || process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd';
}

// ---------- Account ----------
exports.getAccount = async (req, res) => {
  try {
    const product = getProduct(req);
    const broker = getBroker(product);
    const account = await broker.getAccount();
    res.json(account);
  } catch (error) {
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

// ---------- Positions & Trades ----------
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
    const trades = await broker.getOpenTrades();
    res.json(trades);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getTradeHistory = async (req, res) => {
  try {
    const trades = await Trade.find().sort({ createdAt: -1 });
    res.json(trades);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ---------- Manual Order ----------
exports.placeOrder = async (req, res) => {
  const { pair, side, lotSize, stopLoss, takeProfit } = req.body;

  const validation = validateOrderInput({ pair, side, lotSize, stopLoss, takeProfit });
  if (!validation.valid) {
    return res.status(400).json({ error: validation.message });
  }

  try {
    const product = getProduct(req);
    const instrument = pair.toUpperCase();

    // Get broker for this product
    const broker = getBroker(product);
    const account = await broker.getAccount();
    const currentPositions = await broker.getOpenTrades();

    // Get current price from market provider (with product)
    const currentPrice = await marketProvider.getCurrentPrice(instrument, product);
    const signal = {
      pair: instrument,
      side,
      entryPrice: currentPrice,
      stopLoss: stopLoss || null,
      takeProfit: takeProfit || null,
      recommendedLotSize: lotSize,
    };

    // Portfolio Manager approval
    const approval = await portfolioManager.canOpenTrade(signal, parseFloat(account.balance), currentPositions);
    if (!approval.allowed) {
      return res.status(400).json({ error: approval.reason });
    }

    // Place the order via orderService (which also needs product)
    const orderResult = await orderService.placeMarketOrder(
      instrument,
      side,
      lotSize,
      stopLoss || null,
      takeProfit || null,
      product   // <-- pass product so orderService uses correct broker
    );

    // Save to database
    const trade = await portfolioLogger.logTrade({
      pair: instrument,
      side,
      entryPrice: orderResult.price || orderResult.averagePrice,
      stopLoss: stopLoss || null,
      takeProfit: takeProfit || null,
      lotSize,
      status: 'OPEN',
      oandaTradeId: orderResult.tradeID || orderResult.id,
      oandaOrderId: orderResult.id,
      broker: product === 'mt5' ? 'MT5' : 'Deriv',
      strategy: 'Manual',
    });

    // Send notification
    notifyTrade('OPENED', trade, account).catch(err => logger.error('[Notification] Error:', err.message));

    res.json({ success: true, trade, oanda: orderResult });
  } catch (error) {
    logger.error('[placeOrder] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

// ---------- Close Trade ----------
exports.closeTrade = async (req, res) => {
  const { tradeId } = req.params;
  if (!tradeId) return res.status(400).json({ error: 'tradeId required' });
  try {
    const product = getProduct(req);
    const result = await orderService.closeTrade(tradeId, product); // pass product
    const updated = await Trade.findOneAndUpdate(
      { oandaTradeId: tradeId },
      {
        status: 'CLOSED',
        closeTime: new Date(),
        closePrice: result.price || null,
        pnl: result.pl || 0,
      },
      { new: true }
    );
    portfolioManager.updateDailyPnL(result.pl || 0);

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

    res.json({ success: true, result });
  } catch (error) {
    logger.error('[closeTrade] Error:', error.message);
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
    // strategyEngine might need market data – we pass product to marketProvider internally?
    // We'll assume strategyEngine uses marketProvider which now accepts product.
    // But strategyEngine may not accept product; we may need to modify it too.
    // For now, we'll pass product to strategyEngine if it supports it.
    // We'll assume strategyEngine can accept an options object with product.
    const signal = await strategyEngine.generateSignal(instrument, strategy, { ...params, product });
    if (!signal) {
      return res.json({ signal: null, message: 'No signal generated' });
    }
    res.json(signal);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ---------- Auto Trade ----------
exports.autoTrade = async (req, res) => {
  const { pair, riskPercent = 1, strategy = 'sma', ...params } = req.body;
  if (!pair) return res.status(400).json({ error: 'pair required' });
  try {
    const product = getProduct(req);
    const instrument = pair.toUpperCase();

    // Generate signal (pass product)
    const signal = await strategyEngine.generateSignal(instrument, strategy, { ...params, product });
    if (!signal) {
      return res.json({ success: false, message: 'No trading signal' });
    }

    const broker = getBroker(product);
    const account = await broker.getAccount();
    const currentPositions = await broker.getOpenTrades();

    const approval = await portfolioManager.canOpenTrade(signal, parseFloat(account.balance), currentPositions);
    if (!approval.allowed) {
      return res.json({ success: false, message: approval.reason });
    }

    let lotSize = signal.recommendedLotSize;
    if (!lotSize) {
      lotSize = await riskManager.calculateLotSize(
        instrument,
        signal.entryPrice,
        signal.stopLoss,
        riskPercent
      );
    }

    const orderResult = await orderService.placeMarketOrder(
      instrument,
      signal.side,
      lotSize,
      signal.stopLoss,
      signal.takeProfit,
      product
    );

    const trade = await portfolioLogger.logTrade({
      pair: instrument,
      side: signal.side,
      entryPrice: orderResult.price || orderResult.averagePrice,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      lotSize,
      status: 'OPEN',
      oandaTradeId: orderResult.tradeID || orderResult.id,
      oandaOrderId: orderResult.id,
      broker: product === 'mt5' ? 'MT5' : 'Deriv',
      strategy: signal.strategy || strategy,
      notes: 'Auto-trade from strategy',
    });

    notifyTrade('OPENED', trade, account).catch(err => logger.error('[Notification] Error:', err.message));

    res.json({ success: true, signal, trade, oanda: orderResult });
  } catch (error) {
    logger.error('[autoTrade] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};
