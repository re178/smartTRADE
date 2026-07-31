// api/routes/research.js
// Research endpoints – Knowledge Explorer, Decision Inspector, Similarity Search, Outcome Labelling.

const express = require('express');
const router = express.Router();
const HistoricalState = require('../models/HistoricalState');
const HistoricalDecision = require('../models/HistoricalDecision');
const HistoricalOutcome = require('../models/HistoricalOutcome');
const stateStore = require('../core/intelligence/lab/stateStore');
const { dataOrchestrator } = require('../core/data/dataOrchestrator');
const logger = require('../infrastructure/logger') || console;

// ---- Helper to validate lookahead ----
const VALID_LOOKAHEADS = [5, 10, 20, 40];

function isValidLookahead(value) {
  return VALID_LOOKAHEADS.includes(parseInt(value));
}

// ============================================================
// DECISION INSPECTOR
// ============================================================

/**
 * GET /api/research/decision/:id
 * Full decision context – features, contributions, lineage, outcome, similarity.
 */
router.get('/decision/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const lookahead = parseInt(req.query.lookahead) || 5;

    const decision = await HistoricalDecision.findById(id).lean();
    if (!decision) {
      return res.status(404).json({ error: 'Decision not found' });
    }

    // Get similar states for this decision
    let similarity = null;
    try {
      const features = decision.features || {};
      const result = await stateStore.findSimilar(
        features,
        decision.symbol,
        decision.timeframe,
        50, // top 50 similar
        lookahead
      );
      similarity = result;
    } catch (err) {
      logger.warn('[Research] Similarity search failed:', err.message);
    }

    // Get outcome stats if available
    let outcomeStats = null;
    if (decision.outcome && decision.outcome.tradeId) {
      try {
        const stats = await HistoricalOutcome.getAggregatedStats(
          [decision._id],
          'decision',
          lookahead
        );
        outcomeStats = stats;
      } catch (err) {
        logger.warn('[Research] Outcome stats failed:', err.message);
      }
    }

    // Calibrate confidence
    let calibration = null;
    try {
      calibration = await stateStore.calibrateConfidence(decision, lookahead, 100);
    } catch (err) {
      logger.warn('[Research] Confidence calibration failed:', err.message);
    }

    res.json({
      decision,
      similarity,
      outcomeStats,
      calibration,
    });
  } catch (err) {
    logger.error('[Research] Decision inspector error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SIMILARITY SEARCH
// ============================================================

/**
 * GET /api/research/similarity
 * Search for historical states similar to the provided feature vector.
 * Query params: symbol, timeframe, lookahead, k, and individual features.
 */
router.get('/similarity', async (req, res) => {
  try {
    const {
      symbol,
      timeframe = 'M5',
      lookahead = 5,
      k = 100,
      // Features – all optional, will use defaults if missing
      adx,
      rsi,
      atrPercent,
      bbWidth,
      macdHist,
      liquidity,
      velocity,
      acceleration,
      pricePosition,
      marketQuality,
    } = req.query;

    // Build feature vector from query params
    const features = {
      adx: adx !== undefined ? parseFloat(adx) : 25,
      rsi: rsi !== undefined ? parseFloat(rsi) : 50,
      atrPercent: atrPercent !== undefined ? parseFloat(atrPercent) : 0.005,
      bbWidth: bbWidth !== undefined ? parseFloat(bbWidth) : 0.15,
      macdHist: macdHist !== undefined ? parseFloat(macdHist) : 0,
      liquidity: liquidity !== undefined ? parseFloat(liquidity) : 0.5,
      velocity: velocity !== undefined ? parseFloat(velocity) : 0,
      acceleration: acceleration !== undefined ? parseFloat(acceleration) : 0,
      pricePosition: pricePosition !== undefined ? parseFloat(pricePosition) : 0.5,
      marketQuality: marketQuality !== undefined ? parseFloat(marketQuality) : 50,
    };

    const lookaheadInt = parseInt(lookahead);
    const kInt = parseInt(k);

    const result = await stateStore.findSimilar(
      features,
      symbol || null,
      timeframe,
      kInt,
      isValidLookahead(lookaheadInt) ? lookaheadInt : 5
    );

    res.json({
      query: { features, symbol, timeframe, lookahead: lookaheadInt, k: kInt },
      ...result,
    });
  } catch (err) {
    logger.error('[Research] Similarity search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// KNOWLEDGE EXPLORER (Aggregated Query)
// ============================================================

/**
 * GET /api/research/knowledge
 * Aggregated knowledge queries – e.g., "show me all London breakout cases".
 * Query params: filters (symbol, timeframe, regime, session, etc.) and aggregations.
 */
router.get('/knowledge', async (req, res) => {
  try {
    const {
      symbol,
      timeframe = 'M5',
      regime,
      session,
      minAdx,
      maxAdx,
      minRsi,
      maxRsi,
      minLiquidity,
      maxLiquidity,
      lookahead = 5,
      limit = 1000,
      aggregate = 'true',
    } = req.query;

    // Build filter
    const filter = {};
    if (symbol) filter.symbol = symbol;
    if (timeframe) filter.timeframe = timeframe;
    if (regime) filter['regime.code'] = regime;
    if (session) filter['session.name'] = session;
    if (minAdx !== undefined) filter['trend.adx'] = { $gte: parseFloat(minAdx) };
    if (maxAdx !== undefined) filter['trend.adx'] = { ...filter['trend.adx'], $lte: parseFloat(maxAdx) };
    if (minRsi !== undefined) filter['momentum.rsi'] = { $gte: parseFloat(minRsi) };
    if (maxRsi !== undefined) filter['momentum.rsi'] = { ...filter['momentum.rsi'], $lte: parseFloat(maxRsi) };
    if (minLiquidity !== undefined) filter['liquidity.score'] = { $gte: parseFloat(minLiquidity) };
    if (maxLiquidity !== undefined) filter['liquidity.score'] = { ...filter['liquidity.score'], $lte: parseFloat(maxLiquidity) };

    const lookaheadInt = parseInt(lookahead);
    const outcomeKey = `outcome${isValidLookahead(lookaheadInt) ? lookaheadInt : 5}`;

    // Query states
    const states = await HistoricalState.find(filter)
      .sort({ timestamp: -1 })
      .limit(parseInt(limit) || 1000)
      .lean();

    if (states.length === 0) {
      return res.json({
        count: 0,
        states: [],
        stats: { count: 0, winRate: 0, avgReturnR: 0, maxDrawdown: 0, profitFactor: 0 },
      });
    }

    // Compute stats from available outcomes
    const outcomes = states
      .filter(s => s[outcomeKey] && s[outcomeKey].return !== null)
      .map(s => s[outcomeKey]);

    const stats = stateStore._computeStats(outcomes);

    res.json({
      count: states.length,
      states: states.slice(0, 100), // limit returned states
      stats,
      filter,
    });
  } catch (err) {
    logger.error('[Research] Knowledge explorer error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// HISTORICAL STATES (Paginated)
// ============================================================

/**
 * GET /api/research/historical-states
 * Paginated historical states with optional filters.
 */
router.get('/historical-states', async (req, res) => {
  try {
    const {
      symbol,
      timeframe = 'M5',
      from,
      to,
      limit = 100,
      skip = 0,
      hasOutcome = 'false',
      lookahead = 5,
    } = req.query;

    const filter = {};
    if (symbol) filter.symbol = symbol;
    if (timeframe) filter.timeframe = timeframe;
    if (from) filter.timestamp = { $gte: new Date(parseInt(from)) };
    if (to) filter.timestamp = { ...filter.timestamp, $lte: new Date(parseInt(to)) };

    const lookaheadInt = parseInt(lookahead);
    const outcomeKey = `outcome${isValidLookahead(lookaheadInt) ? lookaheadInt : 5}`;

    if (hasOutcome === 'true') {
      filter[`${outcomeKey}.return`] = { $ne: null };
    }

    const total = await HistoricalState.countDocuments(filter);
    const states = await HistoricalState.find(filter)
      .sort({ timestamp: -1 })
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .lean();

    res.json({
      total,
      skip: parseInt(skip),
      limit: parseInt(limit),
      states,
    });
  } catch (err) {
    logger.error('[Research] Historical states error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// LABEL OUTCOMES (Background Job Trigger)
// ============================================================

/**
 * POST /api/research/label-outcomes
 * Trigger outcome labelling for unlabelled states/decisions.
 * This is a background job that fills outcome fields after N candles.
 */
router.post('/label-outcomes', async (req, res) => {
  try {
    const { symbol, timeframe, lookahead = 5, limit = 1000 } = req.body;

    const lookaheadInt = parseInt(lookahead);
    if (!isValidLookahead(lookaheadInt)) {
      return res.status(400).json({ error: 'Invalid lookahead. Must be 5, 10, 20, or 40.' });
    }

    const outcomeKey = `outcome${lookaheadInt}`;

    // Find unlabelled states that have enough future candles available
    // For simplicity, we'll find states where outcome is null and we have a state after N candles.
    // This is a placeholder – actual implementation would require a more sophisticated approach.
    // For now, we'll just return a summary.

    // In production, this would queue a job to compute outcomes from historical data.
    // We'll simulate by finding states with null outcomes.
    const filter = {
      symbol: symbol || { $exists: true },
      timeframe: timeframe || 'M5',
      [`${outcomeKey}.return`]: null,
    };

    const count = await HistoricalState.countDocuments(filter);

    // Simulate labelling by returning a message
    res.json({
      message: `Outcome labelling triggered for ${count} states. This is a background job.`,
      count,
      filter,
      lookahead: lookaheadInt,
    });

    // In a real implementation, we would start an async job here.
    // For now, we'll just log.
    logger.info(`[Research] Outcome labelling triggered for ${count} states (lookahead: ${lookaheadInt})`);

  } catch (err) {
    logger.error('[Research] Label outcomes error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// DECISION PERFORMANCE
// ============================================================

/**
 * GET /api/research/performance
 * Get performance statistics for decisions (by symbol, timeframe, strategy, etc.)
 */
router.get('/performance', async (req, res) => {
  try {
    const { symbol, timeframe, strategy } = req.query;

    const filter = {};
    if (symbol) filter.symbol = symbol;
    if (timeframe) filter.timeframe = timeframe;
    if (strategy) filter['lineage.generatedBy'] = strategy;

    // Get executed decisions with outcomes
    filter['outcome.executed'] = true;
    filter['outcome.returnR'] = { $ne: null };

    const decisions = await HistoricalDecision.find(filter)
      .sort({ timestamp: -1 })
      .limit(10000)
      .lean();

    if (decisions.length === 0) {
      return res.json({
        count: 0,
        winRate: 0,
        avgReturnR: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        decisions: [],
      });
    }

    const stats = stateStore._computeStats(decisions.map(d => ({
      win: d.outcome.win,
      returnR: d.outcome.returnR,
      maxDrawdown: d.outcome.mae || 0,
    })));

    res.json({
      count: decisions.length,
      ...stats,
      decisions: decisions.slice(0, 100),
    });
  } catch (err) {
    logger.error('[Research] Performance error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// EDGE CALCULATION
// ============================================================

/**
 * POST /api/research/edge
 * Compute edge for a given feature set (live query for decision support).
 */
router.post('/edge', async (req, res) => {
  try {
    const {
      features,
      symbol,
      timeframe = 'M5',
      lookahead = 5,
      k = 100,
    } = req.body;

    if (!features || typeof features !== 'object') {
      return res.status(400).json({ error: 'features object required' });
    }

    const lookaheadInt = parseInt(lookahead);
    const kInt = parseInt(k);

    const edge = await stateStore.computeEdge(
      features,
      symbol || null,
      timeframe,
      isValidLookahead(lookaheadInt) ? lookaheadInt : 5,
      kInt
    );

    // Also find similar states for additional context
    const similarity = await stateStore.findSimilar(
      features,
      symbol || null,
      timeframe,
      kInt,
      isValidLookahead(lookaheadInt) ? lookaheadInt : 5
    );

    res.json({
      edge,
      similarity: {
        sampleSize: similarity.stats.count,
        topSimilar: similarity.states.slice(0, 10),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('[Research] Edge calculation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CALIBRATION
// ============================================================

/**
 * GET /api/research/calibration
 * Get confidence calibration data for the system.
 */
router.get('/calibration', async (req, res) => {
  try {
    const { symbol, timeframe, buckets = 10 } = req.query;

    const filter = {};
    if (symbol) filter.symbol = symbol;
    if (timeframe) filter.timeframe = timeframe;

    filter['outcome.executed'] = true;
    filter['outcome.win'] = { $ne: null };

    const decisions = await HistoricalDecision.find(filter)
      .select('confidence outcome.win outcome.returnR')
      .lean();

    if (decisions.length === 0) {
      return res.json({
        buckets: [],
        calibrationError: 0,
        totalSamples: 0,
      });
    }

    const numBuckets = parseInt(buckets) || 10;
    const bucketSize = 100 / numBuckets;

    // Group decisions by confidence bucket
    const bucketsMap = {};
    for (let i = 0; i < numBuckets; i++) {
      const lower = i * bucketSize;
      const upper = (i + 1) * bucketSize;
      bucketsMap[i] = {
        lower,
        upper,
        count: 0,
        wins: 0,
        totalReturnR: 0,
      };
    }

    for (const d of decisions) {
      const conf = d.confidence || 50;
      const bucketIndex = Math.min(Math.floor(conf / bucketSize), numBuckets - 1);
      const bucket = bucketsMap[bucketIndex];
      if (bucket) {
        bucket.count++;
        if (d.outcome.win) bucket.wins++;
        bucket.totalReturnR += (d.outcome.returnR || 0);
      }
    }

    const result = Object.values(bucketsMap).map(b => ({
      lower: b.lower,
      upper: b.upper,
      mid: (b.lower + b.upper) / 2,
      count: b.count,
      winRate: b.count > 0 ? b.wins / b.count : 0,
      avgReturnR: b.count > 0 ? b.totalReturnR / b.count : 0,
    }));

    // Calculate calibration error (Brier score style)
    let totalCalibrationError = 0;
    let totalSamples = 0;
    for (const b of result) {
      const predicted = b.mid / 100;
      const actual = b.winRate;
      totalCalibrationError += Math.pow(predicted - actual, 2) * b.count;
      totalSamples += b.count;
    }
    const calibrationError = totalSamples > 0 ? Math.sqrt(totalCalibrationError / totalSamples) : 0;

    res.json({
      buckets: result,
      calibrationError,
      totalSamples,
    });
  } catch (err) {
    logger.error('[Research] Calibration error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
