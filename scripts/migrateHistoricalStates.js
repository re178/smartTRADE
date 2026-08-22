// scripts/migrateHistoricalStatesFast.js
// High‑performance migration for adding future path data to HistoricalState.
// Corrected for horizon‑specific futurePrices, binary search, and sufficient candle loading.

require('dotenv').config();
const mongoose = require('mongoose');
const HistoricalState = require('../models/HistoricalState');
const candleHistory = require('../core/data/candleHistory');

// ---- Configuration ----
const CONFIG = {
  BATCH_SIZE: 500,           // States per batch for processing
  BULK_WRITE_SIZE: 1000,     // States per bulk MongoDB update
  CONCURRENCY: 8,            // Parallel batch processes
  HORIZONS: [5, 10, 20, 40], // Lookaheads
  // We will load all available candles for each group; no fixed limit.
};

// ---- Simple Progress Bar ----
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

// ---- Binary Search Helper ----
// Returns the index of the first candle time >= target time.
function binarySearch(times, target) {
  let lo = 0, hi = times.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (times[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return (lo < times.length && times[lo] >= target) ? lo : -1;
}

// ---- Compute Path Data for a Given State ----
function computePathData(state, candlePrices, candleTimes, stateTime, horizons) {
  const entryPrice = state.price.current;
  const maxHorizon = Math.max(...horizons);

  // Locate state index using binary search on candleTimes
  let startIdx = binarySearch(candleTimes, stateTime);
  if (startIdx === -1) return null;
  // We want the candle *after* the state time (future)
  const futureStart = startIdx + 1;
  if (futureStart >= candlePrices.length) return null;

  // Extract prices up to maxHorizon
  const prices = candlePrices.slice(futureStart, futureStart + maxHorizon);
  if (prices.length < maxHorizon) {
    // Not enough future candles for full horizon
    return null;
  }

  // Compute MFE/MAE for the entire path (up to maxHorizon)
  let mfe = 0, mae = 0;
  let timeToMaxFavorable = null, timeToMaxAdverse = null;
  for (let i = 0; i < prices.length; i++) {
    const diff = prices[i] - entryPrice;
    if (diff > mfe) { mfe = diff; timeToMaxFavorable = i; }
    if (diff < mae) { mae = diff; timeToMaxAdverse = i; }
  }

  // Build horizon-specific arrays
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
    regimeTransitions: [], // placeholder; can be added later
  };
}

// ---- Fetch All Candles for a Group (symbol, timeframe) ----
async function loadAllCandlesForGroup(symbol, timeframe) {
  // Fetch a large batch – we assume we have enough in DB.
  // candleHistory.getHistory returns most recent first; we reverse.
  const candles = await candleHistory.getHistory(symbol, timeframe, 20000);
  if (!candles || candles.length === 0) return null;
  // Sort ascending by time
  const sorted = candles.slice().reverse();
  // Ensure each candle has numeric time and close
  const valid = sorted.filter(c =>
    c.time && c.close !== undefined && typeof c.close === 'number'
  );
  if (valid.length < 2) return null;
  return valid;
}

// ---- Main Migration ----
async function runMigration() {
  console.log('==================================================');
  console.log('  HISTORICAL STATE PATH MIGRATION (Corrected)');
  console.log('==================================================\n');

  const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/rts';
  console.log(`Connecting to ${MONGO_URI}...`);
  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected.\n');

  // Count total unprocessed states (futurePrices is null or incomplete)
  // We will consider a state unprocessed if futurePrices.5 is null or empty.
  const total = await HistoricalState.countDocuments({
    $or: [
      { 'futurePrices.5': { $exists: false } },
      { 'futurePrices.5': null },
      { 'futurePrices.5': { $size: 0 } }
    ]
  });

  if (total === 0) {
    console.log('✅ All states already have future path data. Nothing to do.');
    process.exit(0);
  }
  console.log(`📊 Found ${total} unprocessed states.\n`);

  // ---- Group states by (symbol, timeframe) ----
  console.log('🔍 Grouping states...');
  const groups = await HistoricalState.aggregate([
    {
      $match: {
        $or: [
          { 'futurePrices.5': { $exists: false } },
          { 'futurePrices.5': null },
          { 'futurePrices.5': { $size: 0 } }
        ]
      }
    },
    {
      $group: {
        _id: { symbol: '$symbol', timeframe: '$timeframe' },
        count: { $sum: 1 },
        // Get earliest and latest timestamps to load candles
        earliest: { $min: '$timestamp' },
        latest: { $max: '$timestamp' }
      }
    },
    { $sort: { count: -1 } }
  ]);

  console.log(`   Found ${groups.length} groups.\n`);

  const progress = new ProgressBar(total, 'Migration');
  let totalProcessed = 0;
  let totalSkipped = 0;
  let totalInsufficient = 0;

  for (const group of groups) {
    const { symbol, timeframe, count, earliest, latest } = group._id;
    console.log(`\n📦 Processing ${symbol} ${timeframe} (${count} states)`);

    // ---- Load all candles for this group ----
    const candles = await loadAllCandlesForGroup(symbol, timeframe);
    if (!candles || candles.length < 50) {
      console.warn(`   ⚠️ Insufficient candles for ${symbol} ${timeframe}, skipping group.`);
      totalSkipped += count;
      continue;
    }

    const candleTimes = candles.map(c => new Date(c.time).getTime());
    const candlePrices = candles.map(c => c.close);

    // Check if we have enough candles after the latest state
    const latestTime = new Date(latest).getTime();
    const lastIdx = candleTimes.findIndex(t => t >= latestTime);
    if (lastIdx === -1) {
      console.warn(`   ⚠️ Latest state time not found in candles, skipping group.`);
      totalSkipped += count;
      continue;
    }
    const futureAvailable = candleTimes.length - (lastIdx + 1);
    const needed = Math.max(...CONFIG.HORIZONS);
    if (futureAvailable < needed) {
      console.warn(`   ⚠️ Not enough future candles after latest state (need ${needed}, have ${futureAvailable}), skipping group.`);
      totalSkipped += count;
      continue;
    }

    // ---- Fetch states in batches ----
    const states = await HistoricalState.find({
      symbol,
      timeframe,
      $or: [
        { 'futurePrices.5': { $exists: false } },
        { 'futurePrices.5': null },
        { 'futurePrices.5': { $size: 0 } }
      ]
    })
      .sort({ timestamp: 1 })
      .lean();

    if (states.length === 0) continue;

    // Process in batches with concurrency
    const batches = [];
    for (let i = 0; i < states.length; i += CONFIG.BATCH_SIZE) {
      batches.push(states.slice(i, i + CONFIG.BATCH_SIZE));
    }

    const processBatch = async (batch) => {
      const updates = [];
      for (const state of batch) {
        const stateTime = new Date(state.timestamp).getTime();
        const pathData = computePathData(
          state,
          candlePrices,
          candleTimes,
          stateTime,
          CONFIG.HORIZONS
        );
        if (!pathData) {
          // Not enough future candles for this state
          continue;
        }
        updates.push({
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
      return updates;
    };

    // Run concurrently
    let groupProcessed = 0;
    let groupInsufficient = 0;

    for (let i = 0; i < batches.length; i += CONFIG.CONCURRENCY) {
      const concurrentBatches = batches.slice(i, i + CONFIG.CONCURRENCY);
      const results = await Promise.all(concurrentBatches.map(batch => processBatch(batch)));

      for (const updates of results) {
        if (updates.length === 0) continue;
        // Bulk write
        try {
          await HistoricalState.bulkWrite(updates);
          const count = updates.length;
          groupProcessed += count;
          totalProcessed += count;
          progress.update(count);
        } catch (err) {
          console.error(`   ❌ Bulk write error: ${err.message}`);
          // Fallback to individual updates
          for (const update of updates) {
            try {
              await HistoricalState.updateOne(update.filter, update.update);
              groupProcessed++;
              totalProcessed++;
              progress.update(1);
            } catch (e) {
              console.error(`      Failed for state ${update.filter._id}: ${e.message}`);
              groupInsufficient++;
            }
          }
        }
      }
    }

    totalInsufficient += groupInsufficient;
    console.log(`   ✅ Processed ${groupProcessed} states, insufficient future data: ${groupInsufficient}`);
  }

  console.log('\n==================================================');
  console.log('✅ MIGRATION COMPLETE');
  console.log(`   Total processed: ${totalProcessed}`);
  console.log(`   Total skipped (no candles): ${totalSkipped}`);
  console.log(`   Total insufficient future data: ${totalInsufficient}`);

  // Verify final count of states with full path data
  const remaining = await HistoricalState.countDocuments({
    $or: [
      { 'futurePrices.5': { $exists: false } },
      { 'futurePrices.5': null },
      { 'futurePrices.5': { $size: 0 } }
    ]
  });

  if (remaining > 0) {
    console.warn(`⚠️ ${remaining} states still lack future path data.`);
    console.warn('   This may be due to insufficient candles. You may need to re-run with more candles.');
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
