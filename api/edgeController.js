// api/edgeController.js
// REST endpoints for the Edge Validation dashboard section.
// Mounted at /api/edge-test in server.js.
//
// Security note: these routes assume they are already protected by
// whatever auth middleware wraps the rest of /api/* in your app.
// If not, add requireAuth at the router level before deploying.
//
// v2 additions:
//   DELETE /bot/:botId  — delete one bot's edge history (stops its
//                         running instance first so stale flip state
//                         doesn't carry over into the next run)
//   DELETE /reset-all   — stop the test (if running), then wipe ALL
//                         edge history. Used by the "Reset & Restart"
//                         button — safer than /reset (which throws if
//                         test is running).

'use strict';

const express = require('express');
const router = express.Router();
const edgeTest = require('../core/bots/edgeTest');
const logger = require('../infrastructure/logger') || console;

// ── START ─────────────────────────────────────────────────────────
// POST /api/edge-test/start
// Body: { targetSample?: number, stake?: number }
// Returns: { ok, running, startedBots, skippedBots, targetSample, stake }
router.post('/start', async (req, res) => {
  try {
    const { targetSample, stake } = req.body || {};
    const result = await edgeTest.start({ targetSample, stake });
    res.json(result);
  } catch (err) {
    logger.error(`[edgeController] start failed: ${err.message}`);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ── STOP ──────────────────────────────────────────────────────────
// POST /api/edge-test/stop
// Halts all running edge-test instances. Data preserved in BotRun.
router.post('/stop', (req, res) => {
  try {
    const result = edgeTest.stop();
    res.json(result);
  } catch (err) {
    logger.error(`[edgeController] stop failed: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── STATUS ────────────────────────────────────────────────────────
// GET /api/edge-test/status
// Live progress per bot (polled by dashboard every 3–5s).
router.get('/status', async (req, res) => {
  try {
    const status = await edgeTest.status();
    res.json(status);
  } catch (err) {
    logger.error(`[edgeController] status failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── RESULTS ───────────────────────────────────────────────────────
// GET /api/edge-test/results
// Full statistical analysis with verdicts, regime/session breakdowns,
// and per-regime recommendations.
router.get('/results', async (req, res) => {
  try {
    const results = await edgeTest.results();
    res.json(results);
  } catch (err) {
    logger.error(`[edgeController] results failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── EXPORT CSV ────────────────────────────────────────────────────
// GET /api/edge-test/export
// Returns a CSV download of every edge-test BotRun (now includes
// Flip and RecentWinRateAtEntry columns).
router.get('/export', async (req, res) => {
  try {
    const csv = await edgeTest.exportCSV();
    if (!csv) {
      return res.status(404).json({ error: 'No edge test data to export. Run a test first.' });
    }
    const filename = `rts_edge_test_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    logger.error(`[edgeController] export failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── RESET (strict — requires stopped state) ──────────────────────
// POST /api/edge-test/reset
// Deletes all isEdgeTest:true BotRun docs. Throws if test is running.
// Kept for backward compat — new UI uses reset-all instead.
router.post('/reset', async (req, res) => {
  try {
    const result = await edgeTest.reset();
    res.json(result);
  } catch (err) {
    logger.error(`[edgeController] reset failed: ${err.message}`);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ── DELETE ONE BOT ───────────────────────────────────────────────
// DELETE /api/edge-test/bot/:botId
// Deletes the specified bot's edge history. Also stops the bot's
// running instance first (so its in-memory flip state is discarded).
// Other bots continue unaffected.
//
// Example: DELETE /api/edge-test/bot/matches_differs_trader
// Response: { ok, botId, deletedCount, stoppedInstance }
router.delete('/bot/:botId', async (req, res) => {
  try {
    const { botId } = req.params;
    if (!botId) return res.status(400).json({ ok: false, error: 'botId required' });
    const result = await edgeTest.deleteBot(botId);
    res.json(result);
  } catch (err) {
    logger.error(`[edgeController] deleteBot failed: ${err.message}`);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ── RESET ALL (safe — stops test first if running) ────────────────
// DELETE /api/edge-test/reset-all
// Stops the edge test if running, then wipes ALL edge history.
// Used by the "Reset & Restart" button in the UI.
//
// Response: { ok, deletedCount, wasRunning }
router.delete('/reset-all', async (req, res) => {
  try {
    const result = await edgeTest.resetAll();
    res.json(result);
  } catch (err) {
    logger.error(`[edgeController] resetAll failed: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
