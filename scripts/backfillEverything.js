// backfillEverything.js – Complete Backfill: Candles → States → Outcomes
// Run: node backfillEverything.js

require('dotenv').config();
const mongoose = require('mongoose');
const { performance } = require('perf_hooks');

// ----- Configuration -----
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/rts';
const STATE_BATCH_SIZE = 500;           // states per insert batch
const OUTCOME_BATCH_SIZE = 500;         // outcomes per update batch
const MIN_CANDLES_FOR_INDICATORS = 50;  // need at least this many candles to compute indicators
const LOOKAHEADS = [5, 10, 20, 40];

// ----- Import Models (only, no core modules) -----
const HistoricalCandle = mongoose.model('HistoricalCandle', new mongoose.Schema({
  symbol: String,
  timeframe: String,
  time: Date,
  open: Number,
  high: Number,
  low: Number,
  close: Number,
  volume: Number,
  source: String,
}));

const HistoricalState = require('./models/HistoricalState');
const HistoricalOutcome = require('./models/HistoricalOutcome');

// ----- Import Indicator Functions (from strategy/engine) -----
const {
  ADX,
  ATR,
  RSI,
  MACD,
  BollingerBands,
  findSupportResistance,
  getSession,
  detectRegime,
} = require('./core/strategy/engine');

// ----- Helper: Format candle for indicators -----
function formatCandle(c) {
  return { mid: { h: c.high, l: c.low, c: c.close } };
}

// ----- Helper: Build state from indicators -----
function buildState(symbol, timeframe, candles, idx, awareness) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const currentIdx = idx;
  const currentPrice = closes[currentIdx];

  // Ensure we have enough data
  if (currentIdx < MIN_CANDLES_FOR_INDICATORS - 1) return null;

  // Slice only the needed history for indicators (using a window of 200)
  const start = Math.max(0, currentIdx - 199);
  const windowCandles = candles.slice(start, currentIdx + 1);
  const windowCandlesFormatted = windowCandles.map(c => formatCandle(c));
  const windowCloses = windowCandles.map(c => c.close);
  const windowHighs = windowCandles.map(c => c.high);
  const windowLows = windowCandles.map(c => c.low);

  // Compute indicators
  const adxData = ADX(windowCandlesFormatted, 14);
  const atrArray = ATR(windowCandlesFormatted, 14);
  const rsi = RSI(windowCloses, 14);
  const macd = MACD(windowCloses, 12, 26, 9);
  const bb = BollingerBands(windowCloses, 20, 2);
  const sr = findSupportResistance(windowCandlesFormatted, 30, 0.001);
  const regime = detectRegime(windowCandles);
  const session = getSession();

  const atr = atrArray ? atrArray[atrArray.length - 1] : 0.001;
  const rsiVal = rsi || 50;
  const macdHist = macd ? macd.histogram[macd.histogram.length - 1] : 0;
  const bbWidth = bb ? (bb.upper[bb.upper.length - 1] - bb.lower[bb.lower.length - 1]) / bb.middle[bb.middle.length - 1] : 0;
  const support = sr && sr.support ? sr.support.price : null;
  const resistance = sr && sr.resistance ? sr.resistance.price : null;
  const pricePosition = (support && resistance) ? (currentPrice - support) / (resistance - support) : 0.5;
  const isAtSupport = support ? Math.abs(currentPrice - support) / currentPrice < 0.001 : false;
  const isAtResistance = resistance ? Math.abs(currentPrice - resistance) / currentPrice < 0.001 : false;

  // Get awareness (default if not available)
  const awareness = awareness || { velocity: 0, acceleration: 0, liquidity: 0.5, spread: 0.0002, unusualEvents: [] };

  // Determine trend direction
  const ema50 = require('./core/strategy/engine').EMA(windowCloses, 50);
  const ema200 = require('./core/strategy/engine').EMA(windowCloses, 200);
  const lastEma50 = ema50[ema50.length - 1];
  const prevEma50 = ema50[ema50.length - 2];
  const lastEma200 = ema200[ema200.length - 1];
  const prevEma200 = ema200[ema200.length - 2];
  const direction = (lastEma50 > prevEma50 && lastEma200 > prevEma200) ? 'bullish' :
                    (lastEma50 < prevEma50 && lastEma200 < prevEma200) ? 'bearish' : 'neutral';

  // Build state object (matching HistoricalState schema)
  const state = {
    symbol,
    timeframe,
    timestamp: new Date(candles[currentIdx].time),
    price: {
      current: currentPrice,
      open: candles[currentIdx].open,
      high: candles[currentIdx].high,
      low: candles[currentIdx].low,
      close: candles[currentIdx].close,
    },
    trend: {
      direction,
      strength: adxData ? adxData.adx : 0,
      adx: adxData ? adxData.adx : 0,
      plusDI: adxData ? adxData.plusDI : 0,
      minusDI: adxData ? adxData.minusDI : 0,
      slope: (closes[currentIdx] - closes[Math.max(0, currentIdx - 50)]) / (closes[Math.max(0, currentIdx - 50)] || 0.0001),
    },
    momentum: {
      rsi: rsiVal,
      macdLine: macd ? macd.macd[macd.macd.length - 1] : 0,
      macdSignal: macd ? macd.signal[macd.signal.length - 1] : 0,
      macdHist,
      velocity: awareness.velocity || 0,
      acceleration: awareness.acceleration || 0,
    },
    volatility: {
      atr,
      atrPercent: atr / (currentPrice || 0.0001),
      bbWidth,
      regime: atr > 0 ? (atr / (atrArray ? atrArray.slice(-20).reduce((a,b)=>a+b,0)/20 : 0.001) > 1.5 ? 'high' : 'normal') : 'normal',
    },
    liquidity: {
      score: awareness.liquidity || 0.5,
      spread: awareness.spread || 0.0002,
      tickFrequency: 0,
    },
    structure: {
      support,
      resistance,
      pricePosition,
      isAtSupport,
      isAtResistance,
    },
    session: {
      name: session,
      liquidityMultiplier: (session === 'London' || session === 'New York') ? 1.5 : 1.0,
      isWeekday: true,
    },
    regime: {
      code: regime.regime.toUpperCase(),
      name: regime.regime.charAt(0).toUpperCase() + regime.regime.slice(1),
      confidence: 50,
      description: '',
    },
    awareness: {
      unusualEvents: [],
      pressure: 'neutral',
    },
    summary: {
      marketQuality: 50,
      noiseLevel: 'medium',
      regimeSuggestion: regime.regime || 'neutral',
      trendConfidence: adxData ? adxData.adx : 50,
    },
    confidence: 50,
    reason: 'Backfill',
    source: 'backfill',
    version: '2.0',
  };

  // Set outcome fields to null initially (will be filled later)
  for (const la of LOOKAHEADS) {
    state[`outcome${la}`] = {
      return: null,
      returnR: null,
      win: null,
      maxDrawdown: null,
      volatility: null,
      filledAt: null,
    };
  }

  return state;
}

// ----- Main Backfill Function -----
async function backfill() {
  console.log('🔌 Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected.\n');

  const startTime = performance.now();

  // ---- 1. Fetch all candles ----
  console.log('📥 Fetching candles from HistoricalCandle...');
  const candles = await HistoricalCandle.find().lean();
  console.log(`   Found ${candles.length} candles.`);

  if (candles.length === 0) {
    console.log('❌ No candles found. Please run the EA to fetch candles first.');
    process.exit(0);
  }

  // Group by symbol+timeframe
  const groups = {};
  for (const c of candles) {
    const key = `${c.symbol}:${c.timeframe}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  }
  console.log(`   Grouped into ${Object.keys(groups).length} symbol/timeframe pairs.`);

  // ---- 2. Process each group: generate states ----
  console.log('\n🧠 Generating states from candles...');
  let totalStatesGenerated = 0;
  let stateBatch = [];

  for (const [key, candleList] of Object.entries(groups)) {
    const [symbol, timeframe] = key.split(':');
    console.log(`   Processing ${symbol} ${timeframe} (${candleList.length} candles)...`);

    if (candleList.length < MIN_CANDLES_FOR_INDICATORS) {
      console.log(`      ⏭️  Skipping (need at least ${MIN_CANDLES_FOR_INDICATORS} candles).`);
      continue;
    }

    // Sort candles by time (ascending)
    candleList.sort((a, b) => new Date(a.time) - new Date(b.time));

    // For each candle starting from the minimum index
    for (let i = MIN_CANDLES_FOR_INDICATORS - 1; i < candleList.length; i++) {
      const state = buildState(symbol, timeframe, candleList, i, null);
      if (state) {
        stateBatch.push(state);
        totalStatesGenerated++;
        if (stateBatch.length >= STATE_BATCH_SIZE) {
          await insertStates(stateBatch);
          stateBatch.length = 0;
        }
      }
    }
  }

  // Insert any remaining states
  if (stateBatch.length > 0) {
    await insertStates(stateBatch);
  }

  console.log(`   ✅ Generated ${totalStatesGenerated} states.`);

  // ---- 3. Label outcomes ----
  console.log('\n🏷️  Labelling outcomes...');

  const states = await HistoricalState.find({
    'outcome5.return': null, // only process unlabelled
  }).lean();

  if (states.length === 0) {
    console.log('   No states to label (all already labelled).');
  } else {
    console.log(`   Found ${states.length} states to label.`);
    let labelled = 0;
    let skipped = 0;
    let errors = 0;
    let outcomeBatch = [];

    for (const state of states) {
      const symbol = state.symbol;
      const timeframe = state.timeframe;
      const stateTime = new Date(state.timestamp).getTime();

      // Find the candle index in the group
      const key = `${symbol}:${timeframe}`;
      const candleList = groups[key];
      if (!candleList) {
        skipped++;
        continue;
      }

      // Find index of candle matching state time
      let idx = -1;
      for (let i = 0; i < candleList.length; i++) {
        if (new Date(candleList[i].time).getTime() === stateTime) {
          idx = i;
          break;
        }
      }
      if (idx === -1) {
        skipped++;
        continue;
      }

      const atr = state.volatility.atr || 0.001;
      const startPrice = state.price.current;
      const updates = {};

      for (const la of LOOKAHEADS) {
        const endIdx = idx + la;
        if (endIdx >= candleList.length) {
          // Not enough future candles – leave as null
          continue;
        }
        const endPrice = candleList[endIdx].close;
        const returnVal = endPrice - startPrice;
        const returnR = returnVal / atr;
        const win = returnVal > 0;
        // Max drawdown during period
        let maxDD = 0;
        for (let k = idx; k <= endIdx; k++) {
          const dd = (candleList[k].low - startPrice) / startPrice;
          if (dd < maxDD) maxDD = dd;
        }

        updates[`outcome${la}`] = {
          return: returnVal,
          returnR,
          win,
          maxDrawdown: maxDD,
          volatility: atr,
          filledAt: new Date(),
        };
      }

      if (Object.keys(updates).length > 0) {
        await HistoricalState.updateOne(
          { _id: state._id },
          { $set: updates }
        );
        labelled++;
      } else {
        skipped++;
      }

      if (labelled % OUTCOME_BATCH_SIZE === 0) {
        console.log(`      Labelled ${labelled} states...`);
      }
    }

    console.log(`   ✅ Labelled ${labelled} states, skipped ${skipped}, errors ${errors}.`);
  }

  // ---- 4. Summary ----
  const endTime = performance.now();
  const elapsed = ((endTime - startTime) / 1000).toFixed(1);
  const stateCount = await HistoricalState.countDocuments();
  const outcomeCount = await HistoricalOutcome.countDocuments();

  console.log('\n=========================================================');
  console.log('✅ BACKFILL COMPLETE');
  console.log(`   Total states: ${stateCount}`);
  console.log(`   Total outcomes: ${outcomeCount}`);
  console.log(`   Time taken: ${elapsed} seconds`);
  console.log('=========================================================');

  process.exit(0);
}

// ---- Helper: insert states in bulk (idempotent) ----
async function insertStates(states) {
  try {
    // Remove _id to let MongoDB generate new ones
    const docs = states.map(s => {
      const { _id, ...rest } = s;
      return rest;
    });
    await HistoricalState.insertMany(docs, { ordered: false });
  } catch (err) {
    // Ignore duplicate key errors (if any)
    if (err.code === 11000) {
      // Duplicate key – skip
    } else {
      console.error('   ❌ Error inserting states:', err.message);
    }
  }
}

// ---- Run ----
backfill().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
