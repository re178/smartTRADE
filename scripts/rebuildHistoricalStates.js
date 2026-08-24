// scripts/rebuildHistoricalStates.js
// Complete rebuild of HistoricalState from HistoricalCandle.
// Self-contained – uses only mongoose and internal indicator engine.
// Run after dropping historicalstates and historicaloutcomes.

require('dotenv').config();
const mongoose = require('mongoose');
const { performance } = require('perf_hooks');

// ---- Import Models ----
const HistoricalState = require('../models/HistoricalState');
const HistoricalCandle = mongoose.model('HistoricalCandle', require('../models/HistoricalCandle'));

// ---- Import Indicator Engine (from your codebase) ----
const {
  ADX,
  ATR,
  RSI,
  MACD,
  BollingerBands,
  findSupportResistance,
} = require('../core/strategy/engine');

// ---- Configuration ----
const CONFIG = {
  MONGO_URI: process.env.MONGO_URI || 'mongodb://localhost:27017/rts',
  BATCH_SIZE: 1000,             // States per batch insert
  MIN_CANDLES_FOR_INDICATORS: 50,
  LOOKAHEADS: [5, 10, 20, 40],
  MAX_FUTURE_CANDLES: 40,
  // All symbols we care about (canonical)
  SYMBOLS: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'],
  TIMEFRAMES: ['M5', 'M15', 'H1'],
};

// ---- Helpers ----
function normalizeSymbol(symbol) {
  if (!symbol) return '';
  let s = symbol.replace(/[/\-_]/g, '').toUpperCase();
  // Remove 'frx' prefix if present
  if (s.startsWith('FRX')) s = s.slice(3);
  return s;
}

function getSession(hour) {
  if (hour >= 7 && hour < 15) return 'London';
  if (hour >= 12 && hour < 20) return 'New York';
  if (hour >= 0 && hour < 8) return 'Asia';
  if (hour >= 22 || hour < 6) return 'Sydney';
  return 'Other';
}

function detectRegime(adx, atr, bbWidth, rsi, direction) {
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

function formatCandle(c) {
  return { mid: { h: c.high, l: c.low, c: c.close } };
}

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

// ---- Build a complete state ----
function buildState(symbol, timeframe, candles, idx) {
  const closes = candles.map(c => c.close);
  const currentIdx = idx;
  const currentPrice = closes[currentIdx];
  if (currentIdx < CONFIG.MIN_CANDLES_FOR_INDICATORS - 1) return null;

  const start = Math.max(0, currentIdx - 199);
  const windowCandles = candles.slice(start, currentIdx + 1);
  const windowFormatted = windowCandles.map(c => formatCandle(c));
  const windowCloses = windowCandles.map(c => c.close);

  // Compute indicators
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
  const regimeCode = detectRegime(adx, atr, bbWidth, rsiVal, direction);
  const hour = new Date(candles[currentIdx].time).getUTCHours();
  const sessionName = getSession(hour);

  return {
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
      strength: adx,
      adx,
      plusDI: adxData ? adxData.plusDI : 0,
      minusDI: adxData ? adxData.minusDI : 0,
      slope: (closes[currentIdx] - closes[Math.max(0, currentIdx - 50)]) / (closes[Math.max(0, currentIdx - 50)] || 0.0001),
    },
    momentum: {
      rsi: rsiVal,
      macdLine: macd ? macd.macd[macd.macd.length - 1] : 0,
      macdSignal: macd ? macd.signal[macd.signal.length - 1] : 0,
      macdHist,
      velocity: 0,
      acceleration: 0,
    },
    volatility: {
      atr,
      atrPercent: atr / (currentPrice || 0.0001),
      bbWidth,
      regime: atr > 0 ? (atr / (atrArray ? atrArray.slice(-20).reduce((a,b)=>a+b,0)/20 : 0.001) > 1.5 ? 'high' : 'normal') : 'normal',
    },
    liquidity: {
      score: 0.5,
      spread: 0.0002,
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
    reason: 'Rebuild',
    source: 'backfill',
    version: '2.1',
  };
}

// ---- Compute future path data ----
function computeFuturePath(candles, idx, horizons, maxCandles) {
  const entryPrice = candles[idx].close;
  const futureCandles = candles.slice(idx + 1, idx + 1 + maxCandles);
  if (futureCandles.length < Math.max(...horizons)) return null;

  const prices = futureCandles.map(c => c.close);
  const futurePrices = {};
  for (const h of horizons) {
    futurePrices[h] = prices.slice(0, h);
  }

  // MFE/MAE for the full path (up to maxCandles)
  let mfe = 0, mae = 0;
  let timeToMaxFavorable = null, timeToMaxAdverse = null;
  for (let i = 0; i < prices.length; i++) {
    const diff = prices[i] - entryPrice;
    if (diff > mfe) { mfe = diff; timeToMaxFavorable = i; }
    if (diff < mae) { mae = diff; timeToMaxAdverse = i; }
  }

  // Outcome labels for each horizon (return, returnR, win, maxDrawdown)
  const outcomes = {};
  const atr = 0.001; // placeholder – we could compute from state but will use fixed for now
  for (const h of horizons) {
    if (prices.length >= h) {
      const endPrice = prices[h - 1];
      const ret = endPrice - entryPrice;
      const retR = ret / atr;
      const win = ret > 0;
      let maxDD = 0;
      for (let i = 0; i < h; i++) {
        const dd = (prices[i] - entryPrice) / entryPrice;
        if (dd < maxDD) maxDD = dd;
      }
      outcomes[h] = { return: ret, returnR: retR, win, maxDrawdown: maxDD, volatility: atr, filledAt: new Date() };
    } else {
      outcomes[h] = { return: null, returnR: null, win: null, maxDrawdown: null, volatility: null, filledAt: null };
    }
  }

  return { futurePrices, mfe, mae, timeToMaxFavorable, timeToMaxAdverse, outcomes };
}

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

// ---- Main ----
async function rebuild() {
  console.log('==================================================');
  console.log('  HISTORICAL STATE REBUILD (from candles)');
  console.log('==================================================\n');

  // Connect
  console.log(`Connecting to ${CONFIG.MONGO_URI}...`);
  await mongoose.connect(CONFIG.MONGO_URI);
  console.log('✅ Connected.\n');

  // Verify candles exist
  const candleCount = await HistoricalCandle.countDocuments();
  console.log(`📂 Found ${candleCount} candles.\n`);
  if (candleCount === 0) {
    console.error('❌ No candles found. Please import candles first.');
    process.exit(1);
  }

  // Load all candles (filter by symbols/timeframes we care about)
  const filter = {
    symbol: { $in: CONFIG.SYMBOLS.map(s => new RegExp(s, 'i')) },
    timeframe: { $in: CONFIG.TIMEFRAMES },
  };
  console.log(`🔍 Fetching candles with filter:`, filter);
  const allCandles = await HistoricalCandle.find(filter).lean();

  if (allCandles.length === 0) {
    console.error('❌ No candles match the filter. Check symbol/timeframe names.');
    process.exit(1);
  }

  // Group by (normalized symbol, timeframe)
  const groups = {};
  for (const c of allCandles) {
    const norm = normalizeSymbol(c.symbol);
    if (!norm) continue;
    const key = `${norm}:${c.timeframe}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  }

  console.log(`   Grouped into ${Object.keys(groups).length} groups.\n`);

  // Process each group
  let totalStates = 0;
  const allStateDocs = [];

  for (const [key, candles] of Object.entries(groups)) {
    const [symbol, timeframe] = key.split(':');
    console.log(`\n📦 Processing ${symbol} ${timeframe} (${candles.length} candles)`);

    // Sort by time
    candles.sort((a, b) => new Date(a.time) - new Date(b.time));

    // We need at least MIN_CANDLES_FOR_INDICATORS + maxHorizon
    const minNeeded = CONFIG.MIN_CANDLES_FOR_INDICATORS + Math.max(...CONFIG.LOOKAHEADS);
    if (candles.length < minNeeded) {
      console.warn(`   ⏭️  Skipping (need ${minNeeded}, have ${candles.length})`);
      continue;
    }

    const progress = new ProgressBar(candles.length, `${symbol} ${timeframe}`);

    for (let i = CONFIG.MIN_CANDLES_FOR_INDICATORS - 1; i < candles.length; i++) {
      const stateData = buildState(symbol, timeframe, candles, i);
      if (!stateData) continue;

      // Compute future paths
      const pathData = computeFuturePath(candles, i, CONFIG.LOOKAHEADS, CONFIG.MAX_FUTURE_CANDLES);
      if (!pathData) continue; // not enough future candles

      // Populate futurePrices and MFE/MAE
      stateData.futurePrices = pathData.futurePrices;
      stateData.mfe = pathData.mfe;
      stateData.mae = pathData.mae;
      stateData.timeToMaxFavorable = pathData.timeToMaxFavorable;
      stateData.timeToMaxAdverse = pathData.timeToMaxAdverse;
      stateData.regimeTransitions = [];

      // Populate outcomes (for compatibility)
      for (const h of CONFIG.LOOKAHEADS) {
        const out = pathData.outcomes[h];
        stateData[`outcome${h}`] = out || { return: null, returnR: null, win: null, maxDrawdown: null, volatility: null, filledAt: null };
      }

      allStateDocs.push(stateData);
      totalStates++;
      progress.update(1);

      // Bulk insert when batch size reached
      if (allStateDocs.length >= CONFIG.BATCH_SIZE) {
        try {
          await HistoricalState.insertMany(allStateDocs, { ordered: false });
          console.log(`   ✅ Inserted batch of ${allStateDocs.length} states`);
          allStateDocs.length = 0;
        } catch (err) {
          console.error(`   ❌ Batch insert error:`, err.message);
          // Continue
        }
      }
    }
  }

  // Insert remaining
  if (allStateDocs.length > 0) {
    try {
      await HistoricalState.insertMany(allStateDocs, { ordered: false });
      console.log(`   ✅ Inserted final batch of ${allStateDocs.length} states`);
    } catch (err) {
      console.error(`   ❌ Final batch insert error:`, err.message);
    }
  }

  // Verify
  const finalCount = await HistoricalState.countDocuments();
  console.log('\n==================================================');
  console.log('✅ REBUILD COMPLETE');
  console.log(`   Total states inserted: ${finalCount}`);
  console.log('==================================================');

  process.exit(0);
}

// ---- Run ----
rebuild().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
