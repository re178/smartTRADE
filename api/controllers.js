// api/controllers.js – Complete Request Handlers (with product support, Order & Trade models)

const Trade = require('../models/Trade');
const Order = require('../models/Order');
const User = require('../models/User');
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

// ---------- User Preferences ----------
exports.getPreferences = async (req, res) => {
  try {
    const userId = req.user?.id || 'admin';
    let user = await User.findOne({ userId });
    if (!user) {
      user = new User({ userId, tradingProduct: process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd' });
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

// ---------- Account ----------
exports.getAccount = async (req, res) => {
  try {
    const product = getProduct(req);
    const account = await accountService.getAccount(product);
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

// ---------- Trade History (ENHANCED with logging) ----------
exports.getTradeHistory = async (req, res) => {
  try {
    const trades = await Trade.find().sort({ createdAt: -1 });
    logger.info(`[getTradeHistory] Found ${trades.length} total trades.`);
    res.json(trades);
  } catch (error) {
    logger.error('[getTradeHistory] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

// ---------- Manual Order (unchanged) ----------
exports.placeOrder = async (req, res) => {
  const { pair, side, lotSize, stopLoss, takeProfit } = req.body;
  const validation = validateOrderInput({ pair, side, lotSize, stopLoss, takeProfit });
  if (!validation.valid) {
    return res.status(400).json({ error: validation.message });
  }
  try {
    const product = getProduct(req);
    const instrument = pair.toUpperCase();
    const broker = getBroker(product);
    const account = await broker.getAccount();
    const currentPositions = await broker.getOpenTrades();
    const currentPrice = await marketProvider.getCurrentPrice(instrument, product);
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
      return res.status(400).json({ error: approval.reason });
    }
    const orderResult = await orderService.placeMarketOrder(
      instrument, side, lotSize, stopLoss || null, takeProfit || null, product
    );
    const trade = await Trade.findOne({ contractId: orderResult.contractId });
    notifyTrade('OPENED', trade, account).catch(err => logger.error('[Notification] Error:', err.message));
    res.json({ success: true, trade, raw: orderResult });
  } catch (error) {
    logger.error('[placeOrder] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

// ---------- Close Trade (YOUR WORKING VERSION – unchanged) ----------
exports.closeTrade = async (req, res) => {
  const { tradeId } = req.params;
  if (!tradeId) return res.status(400).json({ error: 'tradeId required' });
  try {
    const product = getProduct(req);
    const result = await orderService.closeTrade(tradeId, product);
    const updated = await Trade.findOneAndUpdate(
      { contractId: tradeId },
      {
        status: 'CLOSED',
        closeTime: new Date(),
        closePrice: result.price || null,
        pnl: result.pl || 0,
      },
      { new: true }
    );
    if (updated) {
      portfolioManager.updateDailyPnL(result.pl || 0);
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
    res.json({ success: true, result, updated });
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
    const signal = await strategyEngine.generateSignal(instrument, strategy, { ...params, product });
    if (!signal) return res.json({ signal: null, message: 'No signal generated' });
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
    const signal = await strategyEngine.generateSignal(instrument, strategy, { ...params, product });
    if (!signal) return res.json({ success: false, message: 'No trading signal' });
    const broker = getBroker(product);
    const account = await broker.getAccount();
    const currentPositions = await broker.getOpenTrades();
    const approval = await portfolioManager.canOpenTrade(signal, parseFloat(account.balance), currentPositions);
    if (!approval.allowed) return res.json({ success: false, message: approval.reason });
    let lotSize = signal.recommendedLotSize;
    if (!lotSize) {
      lotSize = await riskManager.calculateLotSize(instrument, signal.entryPrice, signal.stopLoss, riskPercent, 1000, product);
    }
    const orderResult = await orderService.placeMarketOrder(
      instrument, signal.side, lotSize, signal.stopLoss, signal.takeProfit, product
    );
    const trade = await Trade.findOne({ contractId: orderResult.contractId });
    notifyTrade('OPENED', trade, account).catch(err => logger.error('[Notification] Error:', err.message));
    res.json({ success: true, signal, trade, raw: orderResult });
  } catch (error) {
    logger.error('[autoTrade] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

// ---------- Pending Orders ----------
exports.getPendingOrders = async (req, res) => {
  try {
    const pending = await Order.find({
      status: { $in: ['PENDING', 'ACCEPTED', 'EXECUTING'] }
    }).sort({ createdAt: -1 });
    res.json(pending);
  } catch (error) {
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

// ---------- Export helper ----------
exports.getProduct = getProduct;
