// src/api/routes.js – Complete API Routes (with notifications, analytics, backtesting, pending orders, delete history)

const express = require('express');
const router = express.Router();
const controllers = require('./controllers');
const { getBroker } = require('../core/execution/brokerFactory');
const {
  BacktestingEngine,
  PortfolioManager,
  ExecutionAnalytics,
  WalkForwardOptimizer,
  PerformanceLearner,
} = require('../core/analytics/performanceSuite');
const { sendTestEmail } = require('../core/notifications/emailService');
const logger = require('../infrastructure/logger') || console;

// ---------- Existing Endpoints ----------
router.get('/account', controllers.getAccount);
router.get('/prices', controllers.getPrices);
router.get('/candles', controllers.getCandles);
router.get('/positions', controllers.getPositions);
router.get('/trades', controllers.getTrades);
router.get('/trade-history', controllers.getTradeHistory);
router.post('/order', controllers.placeOrder);
router.put('/close/:tradeId', controllers.closeTrade);
router.get('/signal', controllers.getSignal);
router.post('/auto-trade', controllers.autoTrade);
router.get('/health', (req, res) => res.json({ status: 'OK' }));

// ---------- Broker Management ----------
router.post('/broker/reset-circuit-breaker', (req, res) => {
  // Get product from request (if available)
  const product = req.user?.tradingProduct || process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd';
  const broker = getBroker(product);
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

// ---------- Pending Orders ----------
router.get('/pending-orders', controllers.getPendingOrders);
router.delete('/order/:orderId', controllers.cancelOrder);

// ---------- Delete History ----------
router.delete('/history', controllers.deleteHistory);

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
    const product = req.user?.tradingProduct || process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd';
    const broker = getBroker(product);
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
