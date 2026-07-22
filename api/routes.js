// api/routes.js – Complete API Routes (with Developer Key Management & new endpoints)

const express = require('express');
const router = express.Router();
const controllers = require('./controllers');
const {
  BacktestingEngine,
  WalkForwardOptimizer,
  PerformanceLearner,
} = require('../core/analytics/performanceSuite');
const { sendTestEmail } = require('../core/notifications/emailService');

// Use your existing logger
const logger = require('../infrastructure/logger') || console;

// ---------- Developer Key Management (Models + Services) ----------
const ApiKey = require('../models/ApiKey');
const { generateApiKey, generateApiSecret, hashSecret } = require('../services/apiKeyGenerator');

// ================================================================
// ================ EXISTING ENDPOINTS =============================
// ================================================================

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
router.post('/broker/reset-circuit-breaker', (req, res) => {
  const broker = controllers.getBrokerForRequest(req);
  if (broker._resetCircuitBreaker) {
    broker._resetCircuitBreaker();
    res.json({ status: 'Circuit breaker reset successfully' });
  } else {
    res.status(500).json({ error: 'Method not available' });
  }
});

// ---------- User Preferences ----------
router.get('/user/preferences', controllers.getPreferences);
router.post('/user/preferences', controllers.updatePreferences);

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

// ---------- Performance Suite ----------
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

router.get('/portfolio/status', async (req, res) => {
  try {
    const product = controllers.getProduct(req);
    const broker = require('../core/execution/brokerFactory').getBroker(product);
    const account = await broker.getAccount();
    const trades = await broker.getOpenTrades();
    const totalExposure = trades.reduce((sum, t) => sum + Math.abs(t.units * t.price), 0);
    res.json({ account, openTrades: trades, totalExposure });
  } catch (err) {
    logger.error('[portfolio/status] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/execution/analytics', (req, res) => {
  res.json({ message: 'Execution analytics – integrate with orderService.getExecutionAnalytics()' });
});

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

// ================================================================
// ================ NEW ENDPOINTS (expose to dashboard) ===========
// ================================================================

router.get('/symbols', controllers.getSymbols);           // symbol metadata
router.get('/capabilities', controllers.getCapabilities); // broker capabilities

// ================================================================
// ================ DEVELOPER API KEY MANAGEMENT ===================
// ================================================================

router.get('/dashboard/developer-keys', async (req, res) => {
  try {
    const keys = await ApiKey.find().sort({ createdAt: -1 }).select('-hashedSecret');
    res.json(keys);
  } catch (err) {
    logger.error('Error fetching API keys:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/dashboard/developer-keys/generate', async (req, res) => {
  try {
    const { applicationName, description, permissions } = req.body;
    if (!applicationName) {
      return res.status(400).json({ error: 'Application name is required' });
    }
    const apiKey = generateApiKey();
    const apiSecret = generateApiSecret();
    const hashedSecret = await hashSecret(apiSecret);

    const newKey = new ApiKey({
      applicationName,
      description: description || '',
      apiKey,
      hashedSecret,
      permissions: permissions || [],
      status: 'active',
      owner: req.user?.userId || 'admin'
    });

    await newKey.save();
    logger.info(`API Key created for ${applicationName}`);

    res.status(201).json({
      apiKey: newKey.apiKey,
      apiSecret,
      applicationName: newKey.applicationName,
      permissions: newKey.permissions,
      createdAt: newKey.createdAt
    });
  } catch (err) {
    logger.error('Error generating API key:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/dashboard/developer-keys/:id/disable', async (req, res) => {
  try {
    const key = await ApiKey.findByIdAndUpdate(req.params.id, { status: 'disabled' }, { new: true }).select('-hashedSecret');
    if (!key) return res.status(404).json({ error: 'Key not found' });
    logger.info(`API Key disabled: ${key.apiKey}`);
    res.json(key);
  } catch (err) {
    logger.error('Error disabling key:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/dashboard/developer-keys/:id/enable', async (req, res) => {
  try {
    const key = await ApiKey.findByIdAndUpdate(req.params.id, { status: 'active' }, { new: true }).select('-hashedSecret');
    if (!key) return res.status(404).json({ error: 'Key not found' });
    logger.info(`API Key enabled: ${key.apiKey}`);
    res.json(key);
  } catch (err) {
    logger.error('Error enabling key:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/dashboard/developer-keys/:id', async (req, res) => {
  try {
    const key = await ApiKey.findByIdAndDelete(req.params.id);
    if (!key) return res.status(404).json({ error: 'Key not found' });
    logger.info(`API Key deleted: ${key.apiKey}`);
    res.json({ message: 'Key deleted' });
  } catch (err) {
    logger.error('Error deleting key:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/dashboard/developer-keys/:id/regenerate-secret', async (req, res) => {
  try {
    const apiSecret = generateApiSecret();
    const hashedSecret = await hashSecret(apiSecret);
    const key = await ApiKey.findByIdAndUpdate(
      req.params.id,
      { hashedSecret, updatedAt: new Date() },
      { new: true }
    ).select('-hashedSecret');
    if (!key) return res.status(404).json({ error: 'Key not found' });
    logger.info(`API Secret regenerated for: ${key.apiKey}`);
    res.json({
      message: 'Secret regenerated',
      apiKey: key.apiKey,
      apiSecret
    });
  } catch (err) {
    logger.error('Error regenerating secret:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ================================================================
// ================ SERVE THE DEVELOPER PORTAL PAGE ================
// ================================================================
router.get('/developer-api', (req, res) => {
  res.render('developerApi');
});

module.exports = router;
