// scripts/migrateHistoricalStatesFast.js – Corrected Symbol Mapping & Timestamp Tolerance

require('dotenv').config();
const mongoose = require('mongoose');
const HistoricalState = require('../models/HistoricalState');
const candleHistory = require('../core/data/candleHistory');

const CONFIG = {
  BATCH_SIZE: 500,
  BULK_WRITE_SIZE: 1000,
  CONCURRENCY: 8,
  HORIZONS: [5, 10, 20, 40],
  TIMESTAMP_TOLERANCE_MS: 60000, // ±1 minute
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

// ---- Symbol Variants ----
function getSymbolVariants(symbol) {
  if (!symbol) return [];
  const clean = symbol.replace(/[/\-_]/g, '').toUpperCase();
  const variants = new Set();
  variants.add(clean);
  // with underscore
  if (clean.length === 6) variants.add(clean.slice(0, 3) + '_' + clean.slice(3));
  // with frx prefix
  variants.add('frx' + clean);
  // with frx and underscore
  if (clean.length === 6) variants.add('frx' + clean.slice(0, 3) + '_' + clean.slice(3));
  return Array.from(variants);
}

// ---- Binary Search with Tolerance ----
function findCandleIndex(times, target, toleranceMs = CONFIG.TIMESTAMP_TOLERANCE_MS) {
  if (!times.length) return -1;
  // Simple linear search from the end (since we expect target near the end)
  // For performance, we can use binary search with tolerance.
  let lo = 0, hi = times.length - 1;
  let bestIdx = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const diff = times[mid] - target;
    if (Math.abs(diff) <= toleranceMs) {
      // Exact or within tolerance – return this index
      return mid;
    }
    if (diff < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  // If not exact, find the closest within tolerance by checking neighbours
  const candidates = [lo, hi, lo-1, lo+1, hi-1, hi+1];
  for (const idx of candidates) {
    if (idx >= 0 && idx < times.length) {
      if (Math.abs(times[idx] - target) <= toleranceMs) return idx;
    }
  }
  return -1;
}

// ---- Load Candles for a Group with Symbol Variants ----
async function loadCandlesForGroup(symbol, timeframe) {
  const variants = getSymbolVariants(symbol);
  for (const sym of variants) {
    try {
      const candles = await candleHistory.getHistory(sym, timeframe, 20000);
      if (candles && candles.length > 0) {
        console.log(`   Loaded ${candles.length} candles for ${sym} ${timeframe}`);
        const sorted = candles.slice().reverse(); // ascending
        const valid = sorted.filter(c => c.time && c.close !== undefined);
        if (valid.length > 0) return valid;
      }
    } catch (err) {
      // ignore
    }
  }
  console.warn(`   No candles found for ${symbol} ${timeframe} (tried variants: ${variants.join(', ')})`);
  return null;
}

// ---- Compute Path Data ----
function computePathData(state, candlePrices, candleTimes, stateTime, horizons, toleranceMs) {
  const entryPrice = state.price.current;
  const maxHorizon = Math.max(...horizons);

  const startIdx = findCandleIndex(candleTimes, stateTime, toleranceMs);
  if (startIdx === -1) return null;
  const futureStart = startIdx + 1;
  if (futureStart >= candlePrices.length) return null;

  const prices = candlePrices.slice(futureStart, futureStart + maxHorizon);
  if (prices.length < maxHorizon) return null;

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

  return { futurePrices, mfe, mae, timeToMaxFavorable, timeToMaxAdverse, regimeTransitions: [] };
}

// ---- Main ----
async function runMigration() {
  console.log('==================================================');
  console.log('  HISTORICAL STATE PATH MIGRATION (Corrected)');
  console.log('==================================================\n');

  const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/rts';
  console.log(`Connecting to ${MONGO_URI}...`);
  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected.\n');

  const total = await HistoricalState.countDocuments({
    $or: [
      { 'futurePrices.5': { $exists: false } },
      { 'futurePrices.5': null },
      { 'futurePrices.5': { $size: 0 } }
    ]
  });

  if (total === 0) {
    console.log('✅ All states already have future path data.');
    process.exit(0);
  }
  console.log(`📊 Found ${total} unprocessed states.\n`);

  // Group
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
        earliest: { $min: '$timestamp' },
        latest: { $max: '$timestamp' }
      }
    },
    { $sort: { count: -1 } }
  ]);

  console.log(`   Found ${groups.length} groups.\n`);

  const progress = new ProgressBar(total, 'Migration');
  let totalProcessed = 0, totalSkipped = 0, totalInsufficient = 0;

  for (const group of groups) {
    const { symbol, timeframe, count, earliest, latest } = group._id;
    console.log(`\n📦 Processing ${symbol} ${timeframe} (${count} states)`);

    const candles = await loadCandlesForGroup(symbol, timeframe);
    if (!candles || candles.length < 50) {
      console.warn(`   ⚠️ Insufficient candles, skipping group.`);
      totalSkipped += count;
      continue;
    }

    const candleTimes = candles.map(c => new Date(c.time).getTime());
    const candlePrices = candles.map(c => c.close);

    // Check if we have enough future candles after the latest state
    const latestTime = new Date(latest).getTime();
    const lastIdx = findCandleIndex(candleTimes, latestTime, CONFIG.TIMESTAMP_TOLERANCE_MS);
    if (lastIdx === -1) {
      console.warn(`   ⚠️ Latest state time not found in candles (tolerance: ${CONFIG.TIMESTAMP_TOLERANCE_MS}ms), skipping group.`);
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

    // Fetch states
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
          CONFIG.HORIZONS,
          CONFIG.TIMESTAMP_TOLERANCE_MS
        );
        if (!pathData) continue;
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

    let groupProcessed = 0, groupInsufficient = 0;
    for (let i = 0; i < batches.length; i += CONFIG.CONCURRENCY) {
      const concurrent = batches.slice(i, i + CONFIG.CONCURRENCY);
      const results = await Promise.all(concurrent.map(b => processBatch(b)));
      for (const updates of results) {
        if (updates.length === 0) continue;
        try {
          await HistoricalState.bulkWrite(updates);
          groupProcessed += updates.length;
          totalProcessed += updates.length;
          progress.update(updates.length);
        } catch (err) {
          console.error(`   ❌ Bulk write error: ${err.message}`);
          for (const u of updates) {
            try {
              await HistoricalState.updateOne(u.filter, u.update);
              groupProcessed++;
              totalProcessed++;
              progress.update(1);
            } catch (e) {
              console.error(`      Failed for state ${u.filter._id}: ${e.message}`);
              groupInsufficient++;
            }
          }
        }
      }
    }

    totalInsufficient += groupInsufficient;
    console.log(`   ✅ Processed ${groupProcessed} states, insufficient: ${groupInsufficient}`);
  }

  console.log('\n==================================================');
  console.log('✅ MIGRATION COMPLETE');
  console.log(`   Total processed: ${totalProcessed}`);
  console.log(`   Total skipped: ${totalSkipped}`);
  console.log(`   Total insufficient: ${totalInsufficient}`);

  const remaining = await HistoricalState.countDocuments({
    $or: [
      { 'futurePrices.5': { $exists: false } },
      { 'futurePrices.5': null },
      { 'futurePrices.5': { $size: 0 } }
    ]
  });

  if (remaining > 0) {
    console.warn(`⚠️ ${remaining} states still lack future path data.`);
  } else {
    console.log('🎉 All states now have future path data.');
  }
  console.log('==================================================');
  process.exit(0);
}

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

runMigration();
