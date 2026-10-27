// api/botRoutes.js
// Bot lifecycle + run history + digit analysis endpoints.
// Mounted at /api in server.js: app.use('/api', botRoutes)
//
// ROUTE ORDER MATTERS — Express matches in declaration order.
// All specific routes (/bots/running, /bots/stop-all) MUST come BEFORE
// parameterized routes (/bots/:botId) or they'll be swallowed.

'use strict';

const express = require('express');
const router = express.Router();
const botRunner = require('../core/bots/runner');
const { listBots, getBot } = require('../core/bots/registry');
const BotRun = require('../models/BotRun');
const digitAnalyzer = require('../core/intelligence/digit/analyzer');
const logger = require('../infrastructure/logger') || console;

// ============================================================
// 1. FIXED-PATH ROUTES (must come first — no params)
// ============================================================

// List all available bot types
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

// Currently running bot instances
router.get('/bots/running', (req, res) => {
  try {
    const list = botRunner.list();
    res.json(Array.isArray(list) ? list : []);
  } catch (err) {
    logger.error('[botRoutes] /bots/running failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Stop ALL bots
router.post('/bots/stop-all', (req, res) => {
  try {
    const count = botRunner.stopAll();
    res.json({ success: true, stoppedCount: count });
  } catch (err) {
    logger.error('[botRoutes] /bots/stop-all failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 2. NAMED-PARAMETER ROUTES (specific prefix, no full-path conflicts)
// ============================================================

// Runs for a specific INSTANCE (must come before /bots/:botId/runs)
router.get('/bots/instance/:instanceId/runs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const runs = await BotRun.find({ instanceId: req.params.instanceId })
      .sort({ openedAt: -1 })
      .limit(limit)
      .lean();
    res.json(runs);
  } catch (err) {
    logger.error('[botRoutes] instance runs failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Stop a specific INSTANCE
router.post('/bots/instance/:instanceId/stop', (req, res) => {
  try {
    const result = botRunner.stop(req.params.instanceId);
    if (!result) return res.status(404).json({ error: 'Instance not found', instanceId: req.params.instanceId });
    res.json({ success: true, instance: result });
  } catch (err) {
    logger.error('[botRoutes] instance stop failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 3. BOT-ID ROUTES (generic param — MUST be last among /bots/* GETs)
// ============================================================

// Single bot definition
router.get('/bots/:botId', (req, res) => {
  const bot = getBot(req.params.botId);
  if (!bot) return res.status(404).json({ error: 'Bot not found', botId: req.params.botId });
  res.json({
    id: bot.id, name: bot.name, description: bot.description,
    assetClass: bot.assetClass, contractClass: bot.contractClass,
    defaultConfig: bot.defaultConfig,
  });
});

// Start a bot
router.post('/bots/:botId/start', (req, res) => {
  try {
    const instance = botRunner.start(req.params.botId, req.body || {});
    res.json({ success: true, instance });
  } catch (err) {
    logger.warn(`[botRoutes] start ${req.params.botId} failed: ${err.message}`);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Runs history for a bot type
router.get('/bots/:botId/runs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const runs = await BotRun.find({ botId: req.params.botId })
      .sort({ openedAt: -1 })
      .limit(limit)
      .lean();
    res.json(runs);
  } catch (err) {
    logger.error(`[botRoutes] runs failed for ${req.params.botId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Aggregated stats for a bot type
router.get('/bots/:botId/stats', async (req, res) => {
  try {
    const since = req.query.since ? new Date(req.query.since) : null;
    const stats = await BotRun.statsFor(req.params.botId, since);
    res.json(stats);
  } catch (err) {
    logger.error(`[botRoutes] stats failed for ${req.params.botId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 4. DIGIT ANALYSIS ROUTES
// ============================================================

router.get('/digit', (req, res) => {
  try {
    const views = digitAnalyzer.getAllViews();
    res.json(views || {});
  } catch (err) {
    logger.error('[botRoutes] /digit failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/digit/:symbol', (req, res) => {
  try {
    const view = digitAnalyzer.getView(req.params.symbol);
    if (!view) return res.status(404).json({ error: 'No digit data for symbol yet' });
    res.json(view);
  } catch (err) {
    logger.error(`[botRoutes] /digit/${req.params.symbol} failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/digit/:symbol/signal', (req, res) => {
  try {
    const sig = digitAnalyzer.getLastSignal(req.params.symbol);
    res.json(sig || { message: 'No signal yet' });
  } catch (err) {
    logger.error(`[botRoutes] /digit/${req.params.symbol}/signal failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
