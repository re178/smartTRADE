// api/botRoutes.js
// Bot lifecycle + run history + FULL ANALYTICS + digit analysis endpoints.

'use strict';

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const botRunner = require('../core/bots/runner');
const { listBots, getBot } = require('../core/bots/registry');
const BotRun = require('../models/BotRun');
const digitAnalyzer = require('../core/intelligence/digit/analyzer');
const logger = require('../infrastructure/logger') || console;

// ============================================================
// 1. FIXED PATHS
// ============================================================

router.get('/bots', (req, res) => {
  try {
    const bots = listBots().map(b => ({
      id: b.id, name: b.name, description: b.description,
      assetClass: b.assetClass, contractClass: b.contractClass,
      defaultConfig: b.defaultConfig,
    }));
    res.json(bots);
  } catch (err) {
    logger.error('[botRoutes] /bots failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/bots/running', (req, res) => {
  try {
    const list = botRunner.list();
    res.json(Array.isArray(list) ? list : []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bots/stop-all', (req, res) => {
  try {
    const count = botRunner.stopAll();
    res.json({ success: true, stoppedCount: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 2. EXPORT & CLEAR RUNS
// ============================================================

router.get('/bots/runs/export', async (req, res) => {
  try {
    const runs = await BotRun.find({}).sort({ openedAt: -1 }).lean();
    res.json(runs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/bots/runs', async (req, res) => {
  try {
    await BotRun.deleteMany({});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 3. FULL ANALYTICS ENGINE (New)
// ============================================================
// Generates deep reports: Overall stats per bot, Daily breakdown, Monthly breakdown.
router.get('/bots/analytics', async (req, res) => {
  try {
    const runs = await BotRun.find({ status: 'CLOSED' }).lean();
    
    const byBot = {};
    const byDay = {};
    const byMonth = {};
    let globalTotalPnL = 0;
    let globalWins = 0;
    let globalLosses = 0;
    let globalTrades = 0;

    runs.forEach(run => {
      const pnl = Number(run.pnl) || 0;
      const isWin = run.result === 'WIN';
      const botId = run.botId;
      const dateObj = new Date(run.closedAt || run.openedAt);
      
      // Date grouping keys (YYYY-MM-DD and YYYY-MM)
      const dayKey = dateObj.toISOString().slice(0, 10);
      const monthKey = dateObj.toISOString().slice(0, 7);

      globalTotalPnL += pnl;
      globalTrades++;
      if (isWin) globalWins++;
      else if (run.result === 'LOSS') globalLosses++;

      // --- 1. Group by Bot ---
      if (!byBot[botId]) {
        byBot[botId] = { botId, trades: 0, wins: 0, losses: 0, pnl: 0, winRate: 0, avgPnl: 0 };
      }
      byBot[botId].trades++;
      byBot[botId].pnl += pnl;
      if (isWin) byBot[botId].wins++;
      else if (run.result === 'LOSS') byBot[botId].losses++;

      // --- 2. Group by Day ---
      if (!byDay[dayKey]) {
        byDay[dayKey] = { date: dayKey, trades: 0, wins: 0, losses: 0, pnl: 0 };
      }
      byDay[dayKey].trades++;
      byDay[dayKey].pnl += pnl;
      if (isWin) byDay[dayKey].wins++;
      else if (run.result === 'LOSS') byDay[dayKey].losses++;

      // --- 3. Group by Month ---
      if (!byMonth[monthKey]) {
        byMonth[monthKey] = { month: monthKey, trades: 0, wins: 0, losses: 0, pnl: 0 };
      }
      byMonth[monthKey].trades++;
      byMonth[monthKey].pnl += pnl;
      if (isWin) byMonth[monthKey].wins++;
      else if (run.result === 'LOSS') byMonth[monthKey].losses++;
    });

    // Calculate win rates and averages for Bots
    Object.values(byBot).forEach(b => {
      b.winRate = b.trades > 0 ? ((b.wins / b.trades) * 100).toFixed(1) : 0;
      b.avgPnl = b.trades > 0 ? (b.pnl / b.trades).toFixed(2) : 0;
    });

    const globalWinRate = globalTrades > 0 ? ((globalWins / globalTrades) * 100).toFixed(1) : 0;

    res.json({
      summary: {
        totalTrades: globalTrades,
        wins: globalWins,
        losses: globalLosses,
        winRate: globalWinRate,
        totalPnL: globalTotalPnL.toFixed(2),
      },
      bots: Object.values(byBot).sort((a, b) => b.pnl - a.pnl), // Ranked by PnL
      daily: Object.values(byDay).sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 30),
      monthly: Object.values(byMonth).sort((a, b) => new Date(b.month) - new Date(a.month)).slice(0, 12),
    });
  } catch (err) {
    logger.error('[botRoutes] Analytics failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 4. SPECIFIC INSTANCE & BOT ROUTES
// ============================================================

router.get('/bots/instance/:instanceId/runs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const runs = await BotRun.find({ instanceId: req.params.instanceId })
      .sort({ openedAt: -1 }).limit(limit).lean();
    res.json(runs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bots/instance/:instanceId/stop', (req, res) => {
  try {
    const result = botRunner.stop(req.params.instanceId);
    if (!result) return res.status(404).json({ error: 'Instance not found' });
    res.json({ success: true, instance: result });
  } catch (err) {
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

router.post('/bots/:botId/start', (req, res) => {
  try {
    const instance = botRunner.start(req.params.botId, req.body || {});
    res.json({ success: true, instance });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/bots/:botId/runs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const runs = await BotRun.find({ botId: req.params.botId })
      .sort({ openedAt: -1 }).limit(limit).lean();
    res.json(runs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 5. DIGIT ANALYSIS
// ============================================================

router.get('/digit', (req, res) => {
  try { res.json(digitAnalyzer.getAllViews() || {}); } 
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/digit/:symbol', (req, res) => {
  try {
    const view = digitAnalyzer.getView(req.params.symbol);
    if (!view) return res.status(404).json({ error: 'No digit data for symbol yet' });
    res.json(view);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/digit/:symbol/signal', (req, res) => {
  try { res.json(digitAnalyzer.getLastSignal(req.params.symbol) || { message: 'No signal yet' }); } 
  catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
