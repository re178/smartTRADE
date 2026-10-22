// core/intelligence/lab/outcomeLabeler.js
// Labels historical states with future outcomes for the evidence engine.
//
// [FILE-3A] Writes outcome5 / outcome15 / outcome40 with
//   { return, returnR, win, maxDrawdown } — the exact shape consumed by
//   stateStore.findSimilar ($outcome${lookahead}) and predictionEngine.
// [FILE-3B] Writes futurePrices: { 5, 15, 40 } as arrays of close prices —
//   required by opportunityEngine.evaluate() for path simulation.
// [FILE-3C] Writes top-level mfe, mae, timeToMaxFavorable, timeToMaxAdverse —
//   required by predictionEngine and getPredictionDistribution.
// [FILE-3D] Symbol-format tolerant — normalizes frxEURUSD / EURUSD / EUR_USD
//   to the same candle query so existing documents get labeled regardless
//   of when they were created.
// [FILE-3E] Bypasses Mongoose strict mode via .collection.updateOne() so
//   the new fields persist even if models/HistoricalState.js doesn't
//   declare them.
// [FILE-3F] Idempotent. Skips documents with existing outcome5. Gives up
//   after MAX_ATTEMPTS per document to prevent infinite retry.
// [FILE-3G] Batched (200/cycle) and grouped by symbol+timeframe so candle
//   data is fetched once per group.
// [FILE-3H] 30-min grace window on the young side; 30-day cutoff on the
//   old side (matches stateStore's 365-day query window with margin).

const mongoose = require('mongoose');
const HistoricalState = require('../../../models/HistoricalState');
// Force the HistoricalCandle model to be registered (candleHistory.js owns it)
require('../../data/candleHistory');
const HistoricalCandle = mongoose.model('HistoricalCandle');
const logger = require('../../../infrastructure/logger') || console;

const CONFIG = {
  LOOKAHEADS: [5, 15, 40],
  BATCH_SIZE: 200,
  INTERVAL_MS: 5 * 60 * 1000,        // 5 minutes between cycles
  MIN_AGE_MS: 30 * 60 * 1000,        // state must be ≥30 min old
  MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000, // 30 days max
  MAX_ATTEMPTS: 3,
  MIN_CANDLES_REQUIRED: 45,          // enough for 40 lookahead + a few warmup
  TIMEFRAME_MS: {
    M1: 60 * 1000,
    M5: 5 * 60 * 1000,
    M15: 15 * 60 * 1000,
    M30: 30 * 60 * 1000,
    H1: 60 * 60 * 1000,
    H4: 4 * 60 * 60 * 1000,
    D1: 24 * 60 * 60 * 1000,
  },
};

let _timer = null;
let _running = false;

// ---------- Symbol normalization ----------
function normalizeSymbol(symbol) {
  if (!symbol) return '';
  return symbol.replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
}

function symbolVariants(symbol) {
  const norm = normalizeSymbol(symbol);
  const variants = new Set([norm]);
  if (norm.length === 6) {
    const underscored = norm.slice(0, 3) + '_' + norm.slice(3);
    variants.add(underscored);
    variants.add('frx' + underscored);
  }
  variants.add('frx' + norm);
  return Array.from(variants);
}

// ---------- Candle fetch ----------
// [FILE-3D] Tolerant of all symbol formats via symbolVariants().
async function fetchCandles(symbol, timeframe, fromTime, toTime) {
  const variants = symbolVariants(symbol);
  const candles = await HistoricalCandle.find({
    symbol: { $in: variants },
    timeframe,
    time: { $gte: fromTime, $lte: toTime },
  }).sort({ time: 1 }).lean();

  return candles
    .map(c => ({
      time: c.time instanceof Date ? c.time.getTime() : new Date(c.time).getTime(),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
    }))
    .filter(c =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.close > 0
    );
}

// ---------- Outcome computation ----------
// [FILE-3A/B/C] Pure function — no side effects, easy to test.
function computeOutcomesForState(state, candles) {
  const entryPrice = Number(state?.price?.current);
  const atr = Number(state?.volatility?.atr);

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  if (!Number.isFinite(atr) || atr <= 0) return null;

  const stateTime = new Date(state.timestamp).getTime();
  if (!Number.isFinite(stateTime)) return null;

  // Find the last candle at or before the state timestamp
  let startIdx = -1;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].time <= stateTime) { startIdx = i; break; }
  }
  if (startIdx < 0) return null;

  const maxLookahead = Math.max(...CONFIG.LOOKAHEADS);
  const futureCandles = candles.slice(startIdx + 1, startIdx + 1 + maxLookahead);
  if (futureCandles.length < maxLookahead) return null;

  const updates = {};

  // Per-lookahead outcomes
  for (const L of CONFIG.LOOKAHEADS) {
    const window = futureCandles.slice(0, L);
    if (window.length < L) continue;

    const lastClose = window[window.length - 1].close;
    const minLow = Math.min(...window.map(c => c.low));
    const returnVal = (lastClose - entryPrice) / entryPrice;
    const returnR = (lastClose - entryPrice) / atr;
    const maxDrawdownR = (minLow - entryPrice) / atr;

    updates[`outcome${L}`] = {
      return: returnVal,
      returnR,
      win: returnVal > 0,
      maxDrawdown: maxDrawdownR,
    };
  }

  // MFE / MAE over the short window
  const shortWindow = futureCandles.slice(0, CONFIG.LOOKAHEADS[0]);
  const maxHigh = Math.max(...shortWindow.map(c => c.high));
  const minLow = Math.min(...shortWindow.map(c => c.low));
  const mfe = (maxHigh - entryPrice) / atr;
  const mae = (minLow - entryPrice) / atr;

  // Time-to-max for MFE and MAE (1-based candle index)
  let mfeIdx = 1, mfeVal = -Infinity;
  let maeIdx = 1, maeVal = Infinity;
  for (let i = 0; i < shortWindow.length; i++) {
    if (shortWindow[i].high > mfeVal) { mfeVal = shortWindow[i].high; mfeIdx = i + 1; }
    if (shortWindow[i].low < maeVal) { maeVal = shortWindow[i].low; maeIdx = i + 1; }
  }

  updates.mfe = mfe;
  updates.mae = mae;
  updates.timeToMaxFavorable = mfeIdx;
  updates.timeToMaxAdverse = maeIdx;

  // [FILE-3B] futurePrices: arrays of close prices for path simulation
  const futurePrices = {};
  for (const L of CONFIG.LOOKAHEADS) {
    const window = futureCandles.slice(0, L);
    if (window.length === L) {
      futurePrices[L] = window.map(c => c.close);
    }
  }
  updates.futurePrices = futurePrices;

  updates.labeled = true;
  updates.labeledAt = new Date();

  return updates;
}

// ---------- Main labeling cycle ----------
async function runOnce() {
  if (_running) {
    logger.debug('[OutcomeLabeler] Cycle already running, skipping.');
    return { skipped: true };
  }
  _running = true;
  const cycleStart = Date.now();
  let labeled = 0;
  let failed = 0;
  let skipped = 0;

  try {
    const now = Date.now();
    const minTime = new Date(now - CONFIG.MAX_AGE_MS);
    const maxTime = new Date(now - CONFIG.MIN_AGE_MS);

    // [FILE-3F] Skip documents that already have outcome5, skip documents
    // that failed labeling MAX_ATTEMPTS times.
    const query = {
      outcome5: { $exists: false },
      timestamp: { $gte: minTime, $lte: maxTime },
      $or: [
        { labelAttempts: { $exists: false } },
        { labelAttempts: { $lt: CONFIG.MAX_ATTEMPTS } },
      ],
    };

    const batch = await HistoricalState.find(query)
      .select('_id symbol timeframe timestamp price.current volatility.atr')
      .limit(CONFIG.BATCH_SIZE)
      .lean();

    if (batch.length === 0) {
      logger.info('[OutcomeLabeler] No unlabeled states in window. Idle.');
      return { labeled: 0, failed: 0, skipped: 0, elapsedMs: Date.now() - cycleStart };
    }

    logger.info(`[OutcomeLabeler] Processing ${batch.length} unlabeled state(s).`);

    // [FILE-3G] Group by symbol + timeframe so candles are fetched once per group
    const grouped = new Map();
    for (const state of batch) {
      const tf = state.timeframe || 'M5';
      const key = `${normalizeSymbol(state.symbol)}::${tf}`;
      if (!grouped.has(key)) grouped.set(key, { symbol: state.symbol, timeframe: tf, states: [] });
      grouped.get(key).states.push(state);
    }

    for (const group of grouped.values()) {
      const { symbol, timeframe, states } = group;
      const tfMs = CONFIG.TIMEFRAME_MS[timeframe] || CONFIG.TIMEFRAME_MS.M5;
      const maxLookahead = Math.max(...CONFIG.LOOKAHEADS);

      const times = states
        .map(s => new Date(s.timestamp).getTime())
        .filter(Number.isFinite);

      if (times.length === 0) {
        skipped += states.length;
        continue;
      }

      const minStateTime = Math.min(...times);
      const maxStateTime = Math.max(...times);
      const fromTime = new Date(minStateTime - tfMs);
      const toTime = new Date(maxStateTime + (maxLookahead + 2) * tfMs);

      let candles;
      try {
        candles = await fetchCandles(symbol, timeframe, fromTime, toTime);
      } catch (err) {
        logger.warn(`[OutcomeLabeler] Candle fetch failed for ${symbol}:${timeframe}: ${err.message}`);
        await incrementAttempts(states.map(s => s._id));
        failed += states.length;
        continue;
      }

      if (!candles || candles.length < CONFIG.MIN_CANDLES_REQUIRED) {
        logger.debug(
          `[OutcomeLabeler] ${symbol}:${timeframe}: only ${candles?.length || 0} candles — insufficient`
        );
        await incrementAttempts(states.map(s => s._id));
        failed += states.length;
        continue;
      }

      for (const state of states) {
        const updates = computeOutcomesForState(state, candles);
        if (!updates) {
          await incrementAttempts([state._id]);
          failed++;
          continue;
        }
        try {
          // [FILE-3E] Direct collection update bypasses Mongoose strict mode
          await HistoricalState.collection.updateOne(
            { _id: state._id },
            { $set: updates }
          );
          labeled++;
        } catch (err) {
          logger.warn(`[OutcomeLabeler] Update failed for ${state._id}: ${err.message}`);
          await incrementAttempts([state._id]);
          failed++;
        }
      }
    }

    const elapsedMs = Date.now() - cycleStart;
    logger.info(
      `[OutcomeLabeler] Cycle complete: labeled=${labeled} failed=${failed} ` +
      `skipped=${skipped} elapsed=${elapsedMs}ms`
    );
    return { labeled, failed, skipped, elapsedMs };
  } catch (err) {
    logger.error(`[OutcomeLabeler] Cycle error: ${err.message}`);
    return { labeled, failed, skipped, error: err.message };
  } finally {
    _running = false;
  }
}

async function incrementAttempts(ids) {
  try {
    // [FILE-3E] Bypass Mongoose so labelAttempts persists regardless of schema
    await HistoricalState.collection.updateMany(
      { _id: { $in: ids } },
      { $inc: { labelAttempts: 1 } }
    );
  } catch (_) { /* best-effort */ }
}

// ---------- Scheduler ----------
function startScheduler() {
  if (_timer) {
    logger.info('[OutcomeLabeler] Scheduler already running.');
    return;
  }
  logger.info(`[OutcomeLabeler] Scheduler started (interval: ${CONFIG.INTERVAL_MS}ms).`);

  // Kick off one cycle immediately so the first batch doesn't wait 5 minutes
  runOnce().catch(err => {
    logger.error(`[OutcomeLabeler] Initial run error: ${err.message}`);
  });

  _timer = setInterval(() => {
    runOnce().catch(err => {
      logger.error(`[OutcomeLabeler] Scheduled run error: ${err.message}`);
    });
  }, CONFIG.INTERVAL_MS);

  if (typeof _timer.unref === 'function') _timer.unref();
}

function stopScheduler() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    logger.info('[OutcomeLabeler] Scheduler stopped.');
  }
}

module.exports = {
  startScheduler,
  stopScheduler,
  runOnce,
  computeOutcomesForState,   // exported for testing
  CONFIG,
};
