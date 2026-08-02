// backfillStatesAndOutcomes.js – Generate States and Outcomes from Candles
// Run: node backfillStatesAndOutcomes.js

require('dotenv').config();
const mongoose = require('mongoose');

// ----- Import required modules -----
const candleHistory = require('./core/data/candleHistory');
const deepMarketState = require('./core/intelligence/deep/marketState');
const { dataOrchestrator } = require('./core/data/dataOrchestrator');
const HistoricalState = require('./models/HistoricalState');
const HistoricalOutcome = require('./models/HistoricalOutcome');

// ----- Configuration -----
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/rts';
const BATCH_SIZE = 100;  // states to insert per batch
const OUTCOME_LOOKAHEADS = [5, 10, 20, 40];

async function backfill() {
  console.log('🔌 Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected.\n');

  // ---- Step 1: Fetch all candles grouped by symbol/timeframe ----
  console.log('📊 Fetching candles from HistoricalCandle...');
  const candles = await candleHistory._cache ? 
    // If you want to use the cached version, we can query directly
    await mongoose.connection.db.collection('historicalcandles').find().toArray() :
    // Fallback: use the model (if defined)
    await mongoose.model('HistoricalCandle').find().lean();

  if (!candles || candles.length === 0) {
    console.log('❌ No candles found. Please run the EA to fetch candles first.');
    process.exit(0);
  }

  console.log(`📊 Found ${candles.length} candles.\n`);

  // Group by symbol+timeframe
  const groups = {};
  for (const c of candles) {
    const key = `${c.symbol}:${c.timeframe}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  }

  console.log(`📊 Grouped into ${Object.keys(groups).length} symbol/timeframe combinations.\n`);

  // ---- Step 2: Generate states for each group ----
  let totalStates = 0;
  const stateBatch = [];

  for (const [key, candleList] of Object.entries(groups)) {
    const [symbol, timeframe] = key.split(':');
    console.log(`🔄 Processing ${symbol} ${timeframe} (${candleList.length} candles)...`);

    // Sort by time ascending
    candleList.sort((a, b) => new Date(a.time) - new Date(b.time));

    // We need at least 50 candles for indicators (as per deepMarketState)
    if (candleList.length < 50) {
      console.log(`   ⏭️  Skipping ${symbol} ${timeframe} – only ${candleList.length} candles (need 50).`);
      continue;
    }

    // For each candle index starting from 50 (to have enough history for indicators)
    for (let i = 50; i < candleList.length; i++) {
      // Build a "candle" array up to i (inclusive) for the indicator functions
      const candlesUpTo = candleList.slice(0, i + 1);

      // Use deepMarketState.compute() to generate a state from these candles
      // But we need to pass the symbol and timeframe, and the function expects to fetch from DB.
      // Instead, we'll directly call the indicator functions ourselves (like deepMarketState does).
      // However, deepMarketState already has the logic – we can reuse it by mocking the history.
      // The simplest is to use deepMarketState.compute() with the symbol and timeframe,
      // but it will fetch from DB again. To avoid that, we'll temporarily override the buffer.
      // We'll use a simpler approach: call deepMarketState._ensureBuffer and then compute.

      // Since deepMarketState is a singleton and uses in-memory buffers, we can preload the buffer.
      // We'll create a new instance of DeepMarketState? Not ideal.
      // Better to directly compute indicators using strategy/engine functions.
      // But to keep consistency with the live system, we should use the same code path.
      // We'll inject the candle list into deepMarketState's buffer manually.

      // Get the internal buffer
      const bufferKey = `${symbol}:${timeframe}`;
      if (!deepMarketState._buffers.has(bufferKey)) {
        // Convert candles to the format expected by deepMarketState (array of objects with mid, etc.)
        const formatted = candlesUpTo.map(c => ({
          symbol: c.symbol,
          timeframe: c.timeframe,
          time: c.time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          source: c.source || 'broker'
        }));
        deepMarketState._buffers.set(bufferKey, formatted);
      } else {
        // Update buffer to include all up to i
        const currentBuffer = deepMarketState._buffers.get(bufferKey);
        // If the buffer is shorter than i+1, extend it
        while (currentBuffer.length < i+1) {
          const c = candleList[currentBuffer.length];
          currentBuffer.push({
            symbol: c.symbol,
            timeframe: c.timeframe,
            time: c.time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
            source: c.source || 'broker'
          });
        }
      }

      // Now call deepMarketState.compute() – it will use the buffer
      try {
        const state = await deepMarketState.compute(symbol, timeframe, 200);
        if (state) {
          // Ensure the state has a timestamp matching the candle time
          state.timestamp = new Date(candleList[i].time);
          // Override source: backfill
          state.source = 'backfill';
          // Add to batch
          stateBatch.push(state);
          totalStates++;
          if (stateBatch.length >= BATCH_SIZE) {
            await insertStates(stateBatch);
            stateBatch.length = 0;
          }
        }
      } catch (err) {
        console.error(`   ❌ Error computing state for ${symbol} ${timeframe} at index ${i}:`, err.message);
      }
    }
  }

  // Insert remaining states
  if (stateBatch.length > 0) {
    await insertStates(stateBatch);
  }

  console.log(`\n✅ Generated ${totalStates} states.`);

  // ---- Step 3: Label outcomes ----
  console.log('\n🏷️  Labelling outcomes...');
  await labelOutcomes();

  console.log('\n✅ Backfill complete!');
  process.exit(0);
}

// ---- Helper: insert states in batches ----
async function insertStates(states) {
  try {
    // We need to remove _id if present, as we want new ones
    const docs = states.map(s => {
      const { _id, ...rest } = s;
      return rest;
    });
    await HistoricalState.insertMany(docs, { ordered: false });
    console.log(`   📦 Inserted ${docs.length} states.`);
  } catch (err) {
    console.error('   ❌ Error inserting states:', err.message);
  }
}

// ---- Helper: label outcomes (using outcomeLabeler logic) ----
async function labelOutcomes() {
  const OutcomeLabeler = require('./core/intelligence/lab/outcomeLabeler');
  // Run the labeler with a high limit to process all states
  const result = await OutcomeLabeler.labelOutcomes(10000);
  console.log(`   🏷️  Labelled ${result.labelled} states, skipped ${result.skipped}, errors ${result.errors}.`);
}

// Run the backfill
backfill().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
