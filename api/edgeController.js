// api/edgeController.js
// REST endpoints for the Edge Validation dashboard section.
// Mounted at /api/edge-test in server.js.
//
// Security note: these routes assume they are already protected by
// whatever auth middleware wraps the rest of /api/* in your app.
// If not, add requireAuth at the router level before deploying.

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
// Returns a CSV download of every edge-test BotRun (40 columns).
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

// ── RESET ─────────────────────────────────────────────────────────
// POST /api/edge-test/reset
// Deletes all isEdgeTest:true BotRun docs. Refuses if test is running.
router.post('/reset', async (req, res) => {
  try {
    const result = await edgeTest.reset();
    res.json(result);
  } catch (err) {
    logger.error(`[edgeController] reset failed: ${err.message}`);
    res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
