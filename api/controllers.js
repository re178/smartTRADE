// src/api/controllers.js – Complete Request Handlers (with Portfolio Manager & Notifications)

const Trade = require('../models/Trade');
const marketProvider = require('../core/market/provider');
const broker = require('../core/execution/broker');
const orderService = require('../core/execution/orderService');
const strategyEngine = require('../core/strategy/engine');
const riskManager = require('../core/risk/manager');
const portfolioLogger = require('../core/portfolio/logger');
const accountService = require('../core/portfolio/accountService');
const { PortfolioManager, PerformanceLearner } = require('../core/analytics/performanceSuite');
const { notifyTrade } = require('../core/notifications/notificationService');
const { formatPrice, validatePair } = require('../shared/helpers');
const { validateOrderInput } = require('../shared/validators');
const logger = require('../infrastructure/logger') || console;

// ---------- Portfolio Manager Instance ----------
const portfolioManager = new PortfolioManager({
  maxOpenTrades: parseInt(process.env.MAX_OPEN_TRADES) || 5,
  maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS) || 0,
  maxExposure: parseFloat(process.env.MAX_EXPOSURE) || Infinity,
  maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE) || 100,
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

// ---------- Account ----------
exports.getAccount = async (req, res) => {
  try {
    const account = await accountService.getAccount();
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
    const pairs = instruments.split(',');
    const prices = await marketProvider.getPrices(pairs);
    res.json(prices);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getCandles = async (req, res) => {
  const { pair, count = 100, granularity = 'M5' } = req.query;
  if (!pair) return res.status(400).json({ error: 'pair query param required' });
  try {
    const candles = await marketProvider.getCandles(pair, parseInt(count), granularity);
    res.json(candles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ---------- Positions & Trades ----------
exports.getPositions = async (req, res) => {
  try {
    const positions = await broker.getPositions();
    res.json(positions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getTrades = async (req, res) => {
  try {
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

// ---------- Manual Order (with Portfolio Manager & Notifications) ----------
exports.placeOrder = async (req, res) => {
  const { pair, side, lotSize, stopLoss, takeProfit } = req.body;

  const validation = validateOrderInput({ pair, side, lotSize, stopLoss, takeProfit });
  if (!validation.valid) {
    return res.status(400).json({ error: validation.message });
  }

  try {
    const instrument = pair.toUpperCase();

    // Get current account and positions for portfolio check
    const account = await accountService.getAccount();
    const currentPositions = await broker.getOpenTrades();

    // Create a synthetic signal for portfolio check
    const currentPrice = await marketProvider.getCurrentPrice(instrument);
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

    // Place the order
    const orderResult = await orderService.placeMarketOrder(
      instrument,
      side,
      lotSize,
      stopLoss || null,
      takeProfit || null
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
      broker: 'OANDA',
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
    const result = await orderService.closeTrade(tradeId);
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
    // Update portfolio daily P&L
    portfolioManager.updateDailyPnL(result.pl || 0);

    // Send notification
    if (updated) {
      const account = await accountService.getAccount();
      notifyTrade('CLOSED', updated, account).catch(err => logger.error('[Notification] Error:', err.message));

      // Record trade in performance learner
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
    const instrument = pair.toUpperCase();
    const signal = await strategyEngine.generateSignal(instrument, strategy, params);
    if (!signal) {
      return res.json({ signal: null, message: 'No signal generated' });
    }
    res.json(signal);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ---------- Auto Trade (with Portfolio Manager & Notifications) ----------
exports.autoTrade = async (req, res) => {
  const { pair, riskPercent = 1, strategy = 'sma', ...params } = req.body;
  if (!pair) return res.status(400).json({ error: 'pair required' });
  try {
    const instrument = pair.toUpperCase();

    // Generate signal
    const signal = await strategyEngine.generateSignal(instrument, strategy, params);
    if (!signal) {
      return res.json({ success: false, message: 'No trading signal' });
    }

    // Get account and positions for portfolio check
    const account = await accountService.getAccount();
    const currentPositions = await broker.getOpenTrades();

    // Portfolio Manager approval
    const approval = await portfolioManager.canOpenTrade(signal, parseFloat(account.balance), currentPositions);
    if (!approval.allowed) {
      return res.json({ success: false, message: approval.reason });
    }

    // Calculate lot size (use recommended if provided, else risk manager)
    const lotSize = signal.recommendedLotSize || await riskManager.calculateLotSize(
      instrument,
      signal.entryPrice,
      signal.stopLoss,
      riskPercent
    );

    // Place order
    const orderResult = await orderService.placeMarketOrder(
      instrument,
      signal.side,
      lotSize,
      signal.stopLoss,
      signal.takeProfit
    );

    // Log to DB
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
      broker: 'OANDA',
      strategy: signal.strategy || strategy,
      notes: 'Auto-trade from strategy',
    });

    // Send notification
    notifyTrade('OPENED', trade, account).catch(err => logger.error('[Notification] Error:', err.message));

    res.json({ success: true, signal, trade, oanda: orderResult });
  } catch (error) {
    logger.error('[autoTrade] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};
