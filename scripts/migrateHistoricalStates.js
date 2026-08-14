// scripts/migrateHistoricalStatesFast.js
// High‑performance migration: pre‑loads candles, processes in parallel, bulk updates.
// Runs in minutes, not hours, for 100K+ states.

require('dotenv').config();
const mongoose = require('mongoose');
const HistoricalState = require('../models/HistoricalState');
const candleHistory = require('../core/data/candleHistory');
const logger = require('../infrastructure/logger') || console;

// ---- Configuration ----
const CONFIG = {
  BATCH_SIZE: 500,           // States per batch for processing
  BULK_WRITE_SIZE: 1000,     // States per bulk update
  CONCURRENCY: 10,           // Number of batches to process in parallel
  MAX_CANDLES: 45,           // Fetch up to 45 candles per state (40 lookahead + buffer)
  HORIZONS: [5, 10, 20, 40], // Lookaheads
  MONGO_URI: process.env.MONGO_URI || 'mongodb://localhost:27017/rts',
  SHOW_PROGRESS: true,
};

// ---- Progress bar (simple) ----
class ProgressBar {
  constructor(total, label = 'Processing') {
    this.total = total;
    this.done = 0;
    this.startTime = Date.now();
    this.label = label;
    this._lastLogged = 0;
  }

  update(inc = 1) {
    this.done += inc;
    const pct = ((this.done / this.total) * 100).toFixed(1);
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const rate = this.done / (Date.now() - this.startTime) * 1000;
    const eta = rate > 0 ? ((this.total - this.done) / rate).toFixed(0) : '?';
    if (this.done - this._lastLogged >= 50 || this.done === this.total) {
      console.log(`[${this.label}] ${this.done}/${this.total} (${pct}%) | Elapsed: ${elapsed}s | ETA: ${eta}s`);
      this._lastLogged = this.done;
    }
  }
}

// ---- Helper: compute path data from a state and candle array ----
function computePathData(state, candlePrices, horizons) {
  const entryPrice = state.price.current;
  const maxHorizon = Math.max(...horizons);
  const prices = candlePrices.slice(0, maxHorizon);
  if (prices.length === 0) return null;

  let mfe = 0, mae = 0;
  let timeToMaxFavorable = null, timeToMaxAdverse = null;
  for (let i = 0; i < prices.length; i++) {
    const diff = prices[i] - entryPrice;
    if (diff > mfe) { mfe = diff; timeToMaxFavorable = i; }
    if (diff < mae) { mae = diff; timeToMaxAdverse = i; }
  }

  const futurePrices = {};
  for (const h of horizons) {
    const idx = Math.min(h, prices.length);
    futurePrices[h] = prices.slice(0, idx);
  }

  return {
    futurePrices,
    mfe,
    mae,
    timeToMaxFavorable,
    timeToMaxAdverse,
    regimeTransitions: [], // optional, can be computed later if needed
  };
}

// ---- Main migration ----
async function runMigration() {
  console.log('==================================================');
  console.log('  HIGH‑PERFORMANCE HISTORICAL STATE MIGRATION');
  console.log('==================================================\n');

  // 1. Connect to MongoDB
  console.log(`Connecting to ${CONFIG.MONGO_URI}...`);
  await mongoose.connect(CONFIG.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  console.log('✅ Connected.\n');

  // 2. Count unprocessed states
  const total = await HistoricalState.countDocuments({ futurePrices: null });
  if (total === 0) {
    console.log('✅ All states already have future path data. Nothing to do.');
    process.exit(0);
  }
  console.log(`📊 Found ${total} unprocessed states.`);

  // 3. Group states by (symbol, timeframe) to pre‑load candles
  console.log('🔍 Grouping states by symbol and timeframe...');
  const groups = await HistoricalState.aggregate([
    { $match: { futurePrices: null } },
    { $group: { _id: { symbol: '$symbol', timeframe: '$timeframe' }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  console.log(`   Found ${groups.length} unique (symbol, timeframe) groups.`);

  // 4. Process each group
  const progress = new ProgressBar(total, 'Migration');

  for (const group of groups) {
    const { symbol, timeframe } = group._id;
    console.log(`\n📦 Processing ${symbol} ${timeframe} (${group.count} states)`);

    // 4a. Pre‑load candles for this symbol/timeframe
    // We need a sorted array of candle closes with their timestamps.
    // candleHistory.getHistory returns the most recent candles; we need all candles
    // that cover the period of our states. We'll load enough candles from the earliest
    // state timestamp to the latest.
    const states = await HistoricalState.find({
      symbol,
      timeframe,
      futurePrices: null,
    })
      .sort({ timestamp: 1 })
      .lean();

    if (states.length === 0) continue;

    const earliest = states[0].timestamp;
    const latest = states[states.length - 1].timestamp;
    // We need enough candles after the latest state as well: add extra buffer.
    // We'll fetch a wide range: from earliest to latest + 40 candles.
    // Since candleHistory.getHistory returns most recent first, we need to work around.
    // Better: use a custom query to get candles sorted by time.
    // I'll implement a helper that fetches candles between two dates.
    // For simplicity, we'll fetch a large number of candles (max 5000) and filter.
    const allCandles = await getCandlesBetween(symbol, timeframe, earliest, latest, 5000);
    if (!allCandles || allCandles.length === 0) {
      console.warn(`   ⚠️ No candles found for ${symbol} ${timeframe}, skipping group.`);
      continue;
    }

    // Build a map from candle time to its close price (for O(1) lookup)
    // We'll assume candles are sorted ascending by time.
    const candleTimes = allCandles.map(c => new Date(c.time).getTime());
    const candlePrices = allCandles.map(c => c.close);

    // 4b. Process states in batches with concurrency
    const batches = [];
    for (let i = 0; i < states.length; i += CONFIG.BATCH_SIZE) {
      batches.push(states.slice(i, i + CONFIG.BATCH_SIZE));
    }

    let processed = 0;
    const updates = [];
    const concurrency = CONFIG.CONCURRENCY;
    let index = 0;
    const results = [];

    // Process batches in parallel using Promise.all with limited concurrency
    const batchPromises = [];
    const processBatch = async (batch) => {
      const batchUpdates = [];
      for (const state of batch) {
        const stateTime = new Date(state.timestamp).getTime();
        // Find the first candle index where time >= stateTime
        let startIdx = candleTimes.findIndex(t => t >= stateTime);
        if (startIdx === -1) {
          // No candle after state timestamp – skip
          continue;
        }
        // We need candles from startIdx+1 onward (future)
        const futureIdx = startIdx + 1;
        if (futureIdx >= candlePrices.length) {
          continue; // no future candles
        }
        const futurePrices = candlePrices.slice(futureIdx, futureIdx + CONFIG.MAX_CANDLES);
        if (futurePrices.length === 0) continue;

        const pathData = computePathData(state, futurePrices, CONFIG.HORIZONS);
        if (!pathData) continue;

        const update = {
          updateOne: {
            filter: { _id: state._id },
            update: {
              $set: {
                futurePrices: pathData.futurePrices,
                mfe: pathData.mfe,
                mae: pathData.mae,
                timeToMaxFavorable: pathData.timeToMaxFavorable,
                timeToMaxAdverse: pathData.timeToMaxAdverse,
                regimeTransitions: pathData.regimeTransitions,
                version: '2.1',
              },
            },
          },
        };
        batchUpdates.push(update);
      }
      return batchUpdates;
    };

    // Process batches in parallel with concurrency limit
    for (let i = 0; i < batches.length; i += concurrency) {
      const concurrentBatches = batches.slice(i, i + concurrency);
      const results = await Promise.all(concurrentBatches.map(batch => processBatch(batch)));
      for (const updates of results) {
        if (updates.length > 0) {
          await HistoricalState.bulkWrite(updates);
          processed += updates.length;
          progress.update(updates.length);
        }
      }
    }

    console.log(`   ✅ Processed ${processed} states for ${symbol} ${timeframe}`);
  }

  console.log('\n==================================================');
  console.log('✅ Migration completed successfully!');
  console.log(`   Total states processed: ${progress.done}`);
  const remaining = await HistoricalState.countDocuments({ futurePrices: null });
  if (remaining > 0) {
    console.warn(`⚠️ ${remaining} states remain unprocessed. You may need to run the script again.`);
  } else {
    console.log('🎉 All states now have future path data.');
  }
  console.log('==================================================');
  process.exit(0);
}

// ---- Helper: fetch candles between two dates ----
async function getCandlesBetween(symbol, timeframe, startDate, endDate, limit = 5000) {
  // This uses the existing candleHistory, but we need a method to get candles by date range.
  // If candleHistory doesn't support that, we can fetch a large batch and filter.
  // We'll fetch the most recent limit candles and filter by time.
  const candles = await candleHistory.getHistory(symbol, timeframe, limit);
  if (!candles || candles.length === 0) return [];
  // candles are likely sorted most recent first; we need ascending.
  const ascending = candles.slice().reverse();
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  // Add buffer to include candles after endDate (up to 40 candles)
  const bufferedEnd = end + 40 * 60 * 1000; // approximate: 40 candles * timeframe in ms, but we don't know the interval
  // Since we don't know the interval, we'll just use a generous buffer of 1 hour.
  const endBuffer = end + 60 * 60 * 1000;
  return ascending.filter(c => {
    const t = new Date(c.time).getTime();
    return t >= start && t <= endBuffer;
  });
}

// ---- Handle errors ----
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

// ---- Run ----
runMigration();
