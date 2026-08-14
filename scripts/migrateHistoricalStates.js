// scripts/migrateHistoricalStatesFast.js
// High‑performance migration – fixed connection and removed deprecated options.

require('dotenv').config();
const mongoose = require('mongoose');
const HistoricalState = require('../models/HistoricalState');
const candleHistory = require('../core/data/candleHistory');

// ---- Configuration ----
const CONFIG = {
  BATCH_SIZE: 500,
  BULK_WRITE_SIZE: 1000,
  CONCURRENCY: 10,
  MAX_CANDLES: 45,
  HORIZONS: [5, 10, 20, 40],
  MONGO_URI: process.env.MONGO_URI || 'mongodb://localhost:27017/rts',
};

// ---- Progress Bar ----
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

// ---- Helper: compute path data ----
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
    regimeTransitions: [],
  };
}

// ---- Helper: fetch candles between dates ----
async function getCandlesBetween(symbol, timeframe, startDate, endDate, limit = 5000) {
  const candles = await candleHistory.getHistory(symbol, timeframe, limit);
  if (!candles || candles.length === 0) return [];
  const ascending = candles.slice().reverse();
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  const endBuffer = end + 60 * 60 * 1000;
  return ascending.filter(c => {
    const t = new Date(c.time).getTime();
    return t >= start && t <= endBuffer;
  });
}

// ---- Main migration ----
async function runMigration() {
  console.log('==================================================');
  console.log('  HIGH‑PERFORMANCE HISTORICAL STATE MIGRATION');
  console.log('==================================================\n');

  // 1. Connect to MongoDB (removed deprecated options)
  console.log(`Connecting to ${CONFIG.MONGO_URI}...`);
  try {
    await mongoose.connect(CONFIG.MONGO_URI);
    console.log('✅ Connected.\n');
  } catch (err) {
    console.error('❌ Failed to connect to MongoDB. Please check your MONGO_URI in .env');
    console.error(`   Error: ${err.message}`);
    process.exit(1);
  }

  // 2. Count unprocessed states
  const total = await HistoricalState.countDocuments({ futurePrices: null });
  if (total === 0) {
    console.log('✅ All states already have future path data. Nothing to do.');
    process.exit(0);
  }
  console.log(`📊 Found ${total} unprocessed states.`);

  // 3. Group states by (symbol, timeframe)
  console.log('🔍 Grouping states by symbol and timeframe...');
  const groups = await HistoricalState.aggregate([
    { $match: { futurePrices: null } },
    { $group: { _id: { symbol: '$symbol', timeframe: '$timeframe' }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  console.log(`   Found ${groups.length} unique (symbol, timeframe) groups.\n`);

  // 4. Process each group
  const progress = new ProgressBar(total, 'Migration');

  for (const group of groups) {
    const { symbol, timeframe } = group._id;
    console.log(`\n📦 Processing ${symbol} ${timeframe} (${group.count} states)`);

    // 4a. Fetch states for this group
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

    // 4b. Pre‑load candles for this group
    const allCandles = await getCandlesBetween(symbol, timeframe, earliest, latest, 5000);
    if (!allCandles || allCandles.length === 0) {
      console.warn(`   ⚠️ No candles found for ${symbol} ${timeframe}, skipping group.`);
      continue;
    }

    const candleTimes = allCandles.map(c => new Date(c.time).getTime());
    const candlePrices = allCandles.map(c => c.close);

    // 4c. Process in parallel batches
    const batches = [];
    for (let i = 0; i < states.length; i += CONFIG.BATCH_SIZE) {
      batches.push(states.slice(i, i + CONFIG.BATCH_SIZE));
    }

    let processed = 0;
    const concurrency = CONFIG.CONCURRENCY;

    const processBatch = async (batch) => {
      const batchUpdates = [];
      for (const state of batch) {
        const stateTime = new Date(state.timestamp).getTime();
        let startIdx = candleTimes.findIndex(t => t >= stateTime);
        if (startIdx === -1) continue;
        const futureIdx = startIdx + 1;
        if (futureIdx >= candlePrices.length) continue;
        const futurePrices = candlePrices.slice(futureIdx, futureIdx + CONFIG.MAX_CANDLES);
        if (futurePrices.length === 0) continue;

        const pathData = computePathData(state, futurePrices, CONFIG.HORIZONS);
        if (!pathData) continue;

        batchUpdates.push({
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
        });
      }
      return batchUpdates;
    };

    // Process batches with concurrency limit
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

// ---- Error Handling ----
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

runMigration();
