// src/api/routes.js – Complete API Routes (with notifications, analytics, backtesting)

const express = require('express');
const router = express.Router();
const controllers = require('./controllers');
const { getBroker } = require('../core/execution/brokerFactory'); // <-- use factory
const {
  BacktestingEngine,
  PortfolioManager,
  ExecutionAnalytics,
  WalkForwardOptimizer,
  PerformanceLearner,
} = require('../core/analytics/performanceSuite');
const { sendTestEmail } = require('../core/notifications/emailService');
const logger = require('../infrastructure/logger') || console;

// ---------- Helper to get broker for current user ----------
function getBrokerForRequest(req) {
  const product = req.user?.tradingProduct || process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd';
  return getBroker(product);
}

// ---------- Existing Endpoints ----------
router.get('/account', async (req, res) => {
  try {
    const broker = getBrokerForRequest(req);
    const account = await broker.getAccount();
    res.json(account);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/prices', async (req, res) => {
  try {
    const broker = getBrokerForRequest(req);
    const { instruments } = req.query;
    const prices = await broker.getPrices(instruments ? instruments.split(',') : ['EUR_USD']);
    res.json(prices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/candles', async (req, res) => {
  try {
    const broker = getBrokerForRequest(req);
    const { instrument, count, granularity } = req.query;
    const candles = await broker.getCandles(instrument, parseInt(count) || 100, granularity || 'M5');
    res.json(candles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/positions', async (req, res) => {
  try {
    const broker = getBrokerForRequest(req);
    const positions = await broker.getPositions();
    res.json(positions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/trades', async (req, res) => {
  try {
    const broker = getBrokerForRequest(req);
    const trades = await broker.getOpenTrades();
    res.json(trades);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/trade-history', async (req, res) => {
  try {
    // Assuming you have a history method – if not, fallback to getOpenTrades
    const broker = getBrokerForRequest(req);
    // Placeholder: you might have a getTradeHistory method; if not, return open trades.
    if (typeof broker.getTradeHistory === 'function') {
      const history = await broker.getTradeHistory();
      res.json(history);
    } else {
      const trades = await broker.getOpenTrades();
      res.json(trades);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/order', async (req, res) => {
  try {
    const broker = getBrokerForRequest(req);
    const { instrument, units, stopLoss, takeProfit, orderType, price } = req.body;
    let result;
    if (orderType === 'limit') {
      result = await broker.placeLimitOrder(instrument, units, price, stopLoss, takeProfit);
    } else {
      result = await broker.placeMarketOrder(instrument, units, stopLoss, takeProfit);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/close/:tradeId', async (req, res) => {
  try {
    const broker = getBrokerForRequest(req);
    const { tradeId } = req.params;
    const result = await broker.closeTrade(tradeId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/signal', controllers.getSignal);
router.post('/auto-trade', controllers.autoTrade);

router.get('/health', (req, res) => res.json({ status: 'OK' }));

router.post('/broker/reset-circuit-breaker', (req, res) => {
  // This is broker‑specific – we need to get the current broker and reset its circuit breaker.
  // However, the factory may return a different broker per user; we cannot reset all.
  // We'll either remove this or make it reset the active broker's internal breaker.
  const broker = getBrokerForRequest(req);
  if (broker._resetCircuitBreaker) {
    broker._resetCircuitBreaker();
    res.json({ status: 'Circuit breaker reset successfully' });
  } else {
    res.status(500).json({ error: 'Method not available on this broker' });
  }
});

// ---------- Notification Endpoints ----------
router.get('/notifications/status', (req, res) => {
  const emailEnabled = process.env.ENABLE_EMAIL_NOTIFICATIONS === 'true';
  const instagramEnabled = process.env.ENABLE_INSTAGRAM_NOTIFICATIONS === 'true';
  const email = process.env.NOTIFICATION_EMAIL || '';
  res.json({
    emailEnabled,
    instagramEnabled,
    email,
  });
});

router.post('/test-email', async (req, res) => {
  try {
    const email = process.env.NOTIFICATION_EMAIL;
    if (!email) {
      return res.status(400).json({ error: 'NOTIFICATION_EMAIL not set' });
    }
    const result = await sendTestEmail(email);
    res.json({ success: true, result });
  } catch (err) {
    logger.error('[test-email] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Performance Suite Endpoints ----------

/**
 * Run a backtest
 * POST /api/backtest
 * Body: { instrument, strategy, timeframe, startDate, endDate, initialBalance, slippage, params }
 */
router.post('/backtest', async (req, res) => {
  try {
    const engine = new BacktestingEngine(req.body);
    const result = await engine.run();
    res.json(result);
  } catch (err) {
    logger.error('[Backtest] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get portfolio status (open trades, exposure, daily P&L)
 * GET /api/portfolio/status
 */
router.get('/portfolio/status', async (req, res) => {
  try {
    const broker = getBrokerForRequest(req);
    const account = await broker.getAccount();
    const trades = await broker.getOpenTrades();
    const totalExposure = trades.reduce((sum, t) => sum + Math.abs(t.units * t.price), 0);
    res.json({
      account,
      openTrades: trades,
      totalExposure,
    });
  } catch (err) {
    logger.error('[portfolio/status] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get execution analytics report
 * GET /api/execution/analytics
 */
router.get('/execution/analytics', (req, res) => {
  try {
    // In production, you would have a persistent ExecutionAnalytics instance.
    // For now, we return a placeholder – you can integrate with orderService.
    res.json({
      message: 'Execution analytics – integrate with orderService.getExecutionAnalytics()',
      // You could store analytics in a database and return them here.
    });
  } catch (err) {
    logger.error('[execution/analytics] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Run walk‑forward optimization
 * POST /api/walkforward
 * Body: { instrument, strategy, timeframe, startDate, endDate, paramRanges, windowSize, stepSize, initialBalance }
 */
router.post('/walkforward', async (req, res) => {
  try {
    const optimizer = new WalkForwardOptimizer(req.body);
    const results = await optimizer.run();
    res.json(results);
  } catch (err) {
    logger.error('[WalkForward] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Initialise performance learning (loads historical trades)
 * POST /api/performance/learn
 * Body: { learningRate, minSamples } (optional)
 */
router.post('/performance/learn', async (req, res) => {
  try {
    const learner = new PerformanceLearner(req.body);
    await learner.loadHistory();
    res.json({ message: 'Performance learner initialised successfully' });
  } catch (err) {
    logger.error('[PerformanceLearn] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
