// api/botRoutes.js
// Bot lifecycle + run history + digit analysis endpoints.
// Mounted at /api in server.js: app.use('/api', botRoutes)

'use strict';

const express = require('express');
const router = express.Router();
const botRunner = require('../core/bots/runner');
const { listBots, getBot } = require('../core/bots/registry');
const BotRun = require('../models/BotRun');
const digitAnalyzer = require('../core/intelligence/digit/analyzer');
const logger = require('../infrastructure/logger') || console;

// ============================================================
// Bot catalog
// ============================================================
router.get('/bots', (req, res) => {
  try {
    const bots = listBots().map(b => ({
      id: b.id,
      name: b.name,
      description: b.description,
      assetClass: b.assetClass,
      contractClass: b.contractClass,
      defaultConfig: b.defaultConfig,
    }));
    res.json(bots);
  } catch (err) {
    logger.error('[botRoutes] /bots failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/bots/:botId', (req, res) => {
  const bot = getBot(req.params.botId);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  res.json({
    id: bot.id, name: bot.name, description: bot.description,
    assetClass: bot.assetClass, contractClass: bot.contractClass,
    defaultConfig: bot.defaultConfig,
  });
});

// ============================================================
// Lifecycle
// ============================================================
router.get('/bots/running', (req, res) => {
  res.json(botRunner.list());
});

router.post('/bots/:botId/start', (req, res) => {
  try {
    const instance = botRunner.start(req.params.botId, req.body || {});
    res.json({ success: true, instance });
  } catch (err) {
    logger.warn(`[botRoutes] start ${req.params.botId} failed: ${err.message}`);
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/bots/instance/:instanceId/stop', (req, res) => {
  const result = botRunner.stop(req.params.instanceId);
  if (!result) return res.status(404).json({ error: 'Instance not found' });
  res.json({ success: true, instance: result });
});

router.post('/bots/stop-all', (req, res) => {
  const count = botRunner.stopAll();
  res.json({ success: true, stoppedCount: count });
});

// ============================================================
// Run history + stats
// ============================================================
router.get('/bots/:botId/runs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const runs = await BotRun.find({ botId: req.params.botId })
      .sort({ openedAt: -1 })
      .limit(limit)
      .lean();
    res.json(runs);
  } catch (err) {
    logger.error(`[botRoutes] runs failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/bots/instance/:instanceId/runs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const runs = await BotRun.find({ instanceId: req.params.instanceId })
      .sort({ openedAt: -1 })
      .limit(limit)
      .lean();
    res.json(runs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/bots/:botId/stats', async (req, res) => {
  try {
    const since = req.query.since ? new Date(req.query.since) : null;
    const stats = await BotRun.statsFor(req.params.botId, since);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Digit analysis (used by Even/Odd, Rise/Fall, Digits panels)
// ============================================================
router.get('/digit/:symbol', (req, res) => {
  try {
    const view = digitAnalyzer.getView(req.params.symbol);
    if (!view) return res.status(404).json({ error: 'No digit data for symbol' });
    res.json(view);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/digit', (req, res) => {
  try {
    res.json(digitAnalyzer.getAllViews());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/digit/:symbol/signal', (req, res) => {
  try {
    const sig = digitAnalyzer.getLastSignal(req.params.symbol);
    if (!sig) return res.json({ message: 'No signal yet' });
    res.json(sig);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
