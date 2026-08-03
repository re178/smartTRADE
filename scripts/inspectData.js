// backfillEverything.js – Complete Backfill with Robust Model Loading
// Run: node scripts/backfillEverything.js

require('dotenv').config();
const mongoose = require('mongoose');
const { performance } = require('perf_hooks');

// ----- Configuration -----
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/rts';
const STATE_BATCH_SIZE = 2000;    // increased for speed
const OUTCOME_BATCH_SIZE = 2000;
const MIN_CANDLES_FOR_INDICATORS = 50;
const LOOKAHEADS = [5, 10, 20, 40];

// ----- Import Models (use your actual paths) -----
const HistoricalState = require('../models/HistoricalState');
const HistoricalOutcome = require('../models/HistoricalOutcome');

// ----- Indicator Functions (from strategy/engine) -----
const {
  ADX,
  ATR,
  RSI,
  MACD,
  BollingerBands,
  findSupportResistance,
} = require('../core/strategy/engine');

// ----- Local helpers (not exported from engine) -----
function EMA(prices, period) {
  const result = [];
  const multiplier = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 0; i < prices.length; i++) {
    if (i === 0) ema = prices[0];
    else ema = (prices[i] - ema) * multiplier + ema;
    result.push(ema);
  }
  return result;
}

function getSession() {
  const hour = new Date().getUTCHours();
  if (hour >= 7 && hour < 15) return 'London';
  if (hour >= 12 && hour < 20) return 'New York';
  if (hour >= 0 && hour < 8) return 'Asia';
  if (hour >= 22 || hour < 6) return 'Sydney';
  return 'Other';
}

function formatCandle(c) {
  return { mid: { h: c.high, l: c.low, c: c.close } };
}

function detectRegimeManual(adx, atr, bbWidth, rsi, direction) {
  if (adx > 30) {
    if (direction === 'bullish') return 'STRONG_TREND_BULL';
    if (direction === 'bearish') return 'STRONG_TREND_BEAR';
  }
  if (adx > 20) return 'WEAK_TREND';
  if (bbWidth < 0.15) return 'RANGING';
  if (atr > 0.005) return 'HIGH_VOLATILITY';
  if (rsi > 70 || rsi < 30) return 'REVERSAL';
  return 'NEUTRAL';
}

// ----- Build state (matches HistoricalState schema) -----
function buildState(symbol, timeframe, candles, idx, awareness) {
  if (!awareness) {
    awareness = { velocity: 0, acceleration: 0, liquidity: 0.5, spread: 0.0002, unusualEvents: [] };
  }

  const closes = candles.map(c => c.close);
  const currentIdx = idx;
  const currentPrice = closes[currentIdx];
  if (currentIdx < MIN_CANDLES_FOR_INDICATORS - 1) return null;

  const start = Math.max(0, currentIdx - 199);
  const windowCandles = candles.slice(start, currentIdx + 1);
  const windowFormatted = windowCandles.map(c => formatCandle(c));
  const windowCloses = windowCandles.map(c => c.close);

  const adxData = ADX(windowFormatted, 14);
  const atrArray = ATR(windowFormatted, 14);
  const rsi = RSI(windowCloses, 14);
  const macd = MACD(windowCloses, 12, 26, 9);
  const bb = BollingerBands(windowCloses, 20, 2);
  const sr = findSupportResistance(windowFormatted, 30, 0.001);

  const atr = atrArray ? atrArray[atrArray.length - 1] : 0.001;
  const rsiVal = rsi || 50;
  const macdHist = macd ? macd.histogram[macd.histogram.length - 1] : 0;
  const bbWidth = bb ? (bb.upper[bb.upper.length - 1] - bb.lower[bb.lower.length - 1]) / bb.middle[bb.middle.length - 1] : 0;
  const support = sr && sr.support ? sr.support.price : null;
  const resistance = sr && sr.resistance ? sr.resistance.price : null;
  const pricePosition = (support && resistance) ? (currentPrice - support) / (resistance - support) : 0.5;
  const isAtSupport = support ? Math.abs(currentPrice - support) / currentPrice < 0.001 : false;
  const isAtResistance = resistance ? Math.abs(currentPrice - resistance) / currentPrice < 0.001 : false;

  const ema50 = EMA(windowCloses, 50);
  const ema200 = EMA(windowCloses, 200);
  let direction = 'neutral';
  if (ema50.length >= 2 && ema200.length >= 2) {
    const lastEma50 = ema50[ema50.length - 1];
    const prevEma50 = ema50[ema50.length - 2];
    const lastEma200 = ema200[ema200.length - 1];
    const prevEma200 = ema200[ema200.length - 2];
    if (lastEma50 > prevEma50 && lastEma200 > prevEma200) direction = 'bullish';
    else if (lastEma50 < prevEma50 && lastEma200 < prevEma200) direction = 'bearish';
  }

  const adx = adxData ? adxData.adx : 0;
  const regimeCode = detectRegimeManual(adx, atr, bbWidth, rsiVal, direction);
  const session = getSession();

  const sessionName = ['Sydney','Asia','London','New York','Other'].includes(session) ? session : 'Other';

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
      direction: direction,
      strength: adx,
      adx: adx,
      plusDI: adxData ? adxData.plusDI : 0,
      minusDI: adxData ? adxData.minusDI : 0,
      slope: (closes[currentIdx] - closes[Math.max(0, currentIdx - 50)]) / (closes[Math.max(0, currentIdx - 50)] || 0.0001),
    },
    momentum: {
      rsi: rsiVal,
      macdLine: macd ? macd.macd[macd.macd.length - 1] : 0,
      macdSignal: macd ? macd.signal[macd.signal.length - 1] : 0,
      macdHist: macdHist,
      velocity: awareness.velocity || 0,
      acceleration: awareness.acceleration || 0,
    },
    volatility: {
      atr: atr,
      atrPercent: atr / (currentPrice || 0.0001),
      bbWidth: bbWidth,
      regime: atr > 0 ? (atr / (atrArray ? atrArray.slice(-20).reduce((a,b)=>a+b,0)/20 : 0.001) > 1.5 ? 'high' : 'normal') : 'normal',
    },
    liquidity: {
      score: awareness.liquidity || 0.5,
      spread: awareness.spread || 0.0002,
      tickFrequency: 0,
    },
    structure: {
      support: support,
      resistance: resistance,
      pricePosition: pricePosition,
      isAtSupport: isAtSupport,
      isAtResistance: isAtResistance,
    },
    session: {
      name: sessionName,
      liquidityMultiplier: (sessionName === 'London' || sessionName === 'New York') ? 1.5 : 1.0,
      isWeekday: true,
    },
    regime: {
      code: regimeCode,
      name: regimeCode.charAt(0).toUpperCase() + regimeCode.slice(1).toLowerCase().replace('_', ' '),
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
      regimeSuggestion: regimeCode.toLowerCase().includes('trend') ? 'trending' : 
                         regimeCode === 'RANGING' ? 'ranging' :
                         regimeCode === 'HIGH_VOLATILITY' ? 'volatile' :
                         regimeCode === 'LOW_VOLATILITY' ? 'quiet' :
                         regimeCode === 'REVERSAL' ? 'reversal' : 'neutral',
      trendConfidence: adx,
    },
    confidence: 50,
    reason: 'Backfill',
    source: 'backfill',
    version: '2.0',
  };

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

// ----- Insert states with full error logging -----
async function insertStatesWithLogging(states, batchNum) {
  if (states.length === 0) return;
  try {
    const docs = states.map(s => {
      const { _id, ...rest } = s;
      return rest;
    });
    console.log(`   📦 Batch ${batchNum}: attempting ${docs.length} inserts...`);
    const result = await HistoricalState.insertMany(docs, { ordered: false });
    console.log(`   ✅ Batch ${batchNum}: inserted ${result.length} states.`);
  } catch (err) {
    if (err.code === 11000) {
      console.log(`   ⚠️  Batch ${batchNum}: duplicates skipped.`);
      return;
    }
    console.error(`   ❌ Batch ${batchNum} error:`, err.message);
    if (err.name === 'ValidationError') {
      const errors = err.errors;
      for (const field in errors) {
        console.error(`      - ${field}: ${errors[field].message}`);
      }
      if (states.length > 0) {
        console.error('   First document causing validation error:', JSON.stringify(states[0], null, 2));
      }
    } else {
      console.error('   First document:', JSON.stringify(states[0], null, 2));
    }
  }
}

// ----- Main -----
async function backfill() {
  console.log('🔌 Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected.\n');

  // ----- Get HistoricalCandle model with fallback (same as inspectData.js) -----
  let HistoricalCandle;
  try {
    HistoricalCandle = mongoose.model('HistoricalCandle');
    console.log('✅ Using existing HistoricalCandle model.');
  } catch (e) {
    console.log('⚠️  HistoricalCandle model not found; defining schema...');
    const candleSchema = new mongoose.Schema({
      symbol: String,
      timeframe: String,
      time: Date,
      open: Number,
      high: Number,
      low: Number,
      close: Number,
      volume: Number,
      source: String,
    });
    HistoricalCandle = mongoose.model('HistoricalCandle', candleSchema);
    console.log('✅ HistoricalCandle model registered.');
  }

  console.log(`📂 HistoricalState collection: ${HistoricalState.collection.collectionName}`);
  console.log(`📂 HistoricalCandle collection: ${HistoricalCandle.collection.collectionName}`);

  const startTime = performance.now();

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

  console.log('\n🧠 Generating states from candles...');
  let totalStatesGenerated = 0;
  let batch = [];
  let batchCounter = 0;

  for (const [key, candleList] of Object.entries(groups)) {
    const [symbol, timeframe] = key.split(':');
    console.log(`   Processing ${symbol} ${timeframe} (${candleList.length} candles)...`);

    if (candleList.length < MIN_CANDLES_FOR_INDICATORS) {
      console.log(`      ⏭️  Skipping (need at least ${MIN_CANDLES_FOR_INDICATORS} candles).`);
      continue;
    }

    candleList.sort((a, b) => new Date(a.time) - new Date(b.time));

    for (let i = MIN_CANDLES_FOR_INDICATORS - 1; i < candleList.length; i++) {
      const state = buildState(symbol, timeframe, candleList, i, null);
      if (state) {
        batch.push(state);
        totalStatesGenerated++;
        if (batch.length >= STATE_BATCH_SIZE) {
          batchCounter++;
          await insertStatesWithLogging(batch, batchCounter);
          batch = [];
        }
      }
    }
  }

  if (batch.length > 0) {
    batchCounter++;
    await insertStatesWithLogging(batch, batchCounter);
  }

  const finalCount = await HistoricalState.countDocuments();
  console.log(`\n✅ Generated ${totalStatesGenerated} states, saved ${finalCount} states.`);

  // ---- Label outcomes ----
  console.log('\n🏷️  Labelling outcomes...');

  const states = await HistoricalState.find({ 'outcome5.return': null }).lean();

  if (states.length === 0) {
    console.log('   No states to label (all already labelled).');
  } else {
    console.log(`   Found ${states.length} states to label.`);
    let labelled = 0, skipped = 0, errors = 0;

    for (const state of states) {
      const key = `${state.symbol}:${state.timeframe}`;
      const candleList = groups[key];
      if (!candleList) { skipped++; continue; }

      const stateTime = new Date(state.timestamp).getTime();
      let idx = -1;
      for (let i = 0; i < candleList.length; i++) {
        if (new Date(candleList[i].time).getTime() === stateTime) {
          idx = i;
          break;
        }
      }
      if (idx === -1) { skipped++; continue; }

      const atr = state.volatility.atr || 0.001;
      const startPrice = state.price.current;
      const updates = {};

      for (const la of LOOKAHEADS) {
        const endIdx = idx + la;
        if (endIdx >= candleList.length) continue;
        const endPrice = candleList[endIdx].close;
        const returnVal = endPrice - startPrice;
        const returnR = returnVal / atr;
        const win = returnVal > 0;
        let maxDD = 0;
        for (let k = idx; k <= endIdx; k++) {
          const dd = (candleList[k].low - startPrice) / startPrice;
          if (dd < maxDD) maxDD = dd;
        }
        updates[`outcome${la}`] = {
          return: returnVal,
          returnR: returnR,
          win: win,
          maxDrawdown: maxDD,
          volatility: atr,
          filledAt: new Date(),
        };
      }

      if (Object.keys(updates).length > 0) {
        await HistoricalState.updateOne({ _id: state._id }, { $set: updates });
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

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
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

backfill().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
