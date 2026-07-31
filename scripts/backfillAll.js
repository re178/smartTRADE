// scripts/backfillAll.js
// Robust backfill: for each historical candle, compute features from previous 200 candles,
// store state with future outcomes (5,10,20,40 candles ahead).

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const candleHistory = require('../core/data/candleHistory');
const HistoricalState = require('../models/HistoricalState');
const HistoricalOutcome = require('../models/HistoricalOutcome');
const {
  ADX,
  ATR,
  RSI,
  MACD,
  BollingerBands,
  findSupportResistance,
} = require('../core/strategy/engine');
const logger = require('../infrastructure/logger') || console;

// ---- CONFIGURATION ----
const SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'];
const TIMEFRAMES = ['M5', 'M15', 'H1'];
const LOOKAHEADS = [5, 10, 20, 40];
const MAX_CANDLES = 5000;          // How many candles to fetch per symbol/timeframe
const BATCH_SIZE = 20;             // States per batch (to avoid memory spikes)
const INDICATOR_LOOKBACK = 200;    // Candles needed for indicators

// Helper: try both symbol formats (with/without underscore)
function normalizeSymbol(sym) {
  // If it contains '_', keep as is; else add underscore
  if (sym.includes('_')) return sym;
  return sym.slice(0, 3) + '_' + sym.slice(3);
}

function getSessionName(timestamp) {
  const date = new Date(timestamp);
  const hour = date.getUTCHours();
  if (hour >= 22 || hour < 6) return 'Sydney';
  if (hour >= 0 && hour < 8) return 'Asia';
  if (hour >= 7 && hour < 15) return 'London';
  if (hour >= 12 && hour < 20) return 'New York';
  return 'Other';
}

// ---- MAIN ----
async function run() {
  await connectDB();
  logger.info('✅ Connected to MongoDB.');

  // Drop old collections to start fresh
  await HistoricalState.deleteMany({});
  await HistoricalOutcome.deleteMany({});
  logger.info('🧹 Dropped existing HistoricalState and HistoricalOutcome.');

  let totalStates = 0;
  let totalOutcomes = 0;

  for (const rawSymbol of SYMBOLS) {
    const symbol = normalizeSymbol(rawSymbol);
    for (const tf of TIMEFRAMES) {
      logger.info(`📥 Processing ${symbol} ${tf}...`);

      // 1. Fetch candles
      const candles = await candleHistory.getHistory(symbol, tf, MAX_CANDLES);
      if (!candles || candles.length < INDICATOR_LOOKBACK + 50) {
        logger.warn(`⚠️ Not enough candles for ${symbol} ${tf} (need ${INDICATOR_LOOKBACK + 50})`);
        continue;
      }

      const totalCandles = candles.length;
      const maxLookahead = Math.max(...LOOKAHEADS);
      // We can only label states that have enough future candles
      const usableEnd = totalCandles - maxLookahead - 5; // leave buffer

      if (usableEnd < INDICATOR_LOOKBACK + 10) {
        logger.warn(`⚠️ Not enough usable candles for ${symbol} ${tf}`);
        continue;
      }

      // 2. Process in batches
      for (let startIdx = INDICATOR_LOOKBACK; startIdx < usableEnd; startIdx += BATCH_SIZE) {
        const endIdx = Math.min(startIdx + BATCH_SIZE, usableEnd);
        const batchPromises = [];

        for (let idx = startIdx; idx < endIdx; idx++) {
          batchPromises.push(processCandle(candles, idx, symbol, tf));
        }

        const results = await Promise.allSettled(batchPromises);
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value) {
            totalStates++;
            totalOutcomes += r.value.outcomesCreated || 0;
          }
        }
        logger.info(`   ➜ Processed up to candle ${endIdx}/${usableEnd} (${totalStates} states so far)`);
      }
      logger.info(`✅ Finished ${symbol} ${tf} – total states: ${totalStates}`);
    }
  }

  logger.info(`🎉 All done. Created ${totalStates} states and ${totalOutcomes} outcome records.`);
  process.exit(0);
}

// ---- Process a single candle (compute features + outcomes) ----
async function processCandle(candles, idx, symbol, timeframe) {
  const currentCandle = candles[idx];
  const currentPrice = currentCandle.close;

  // 1. Slice for indicators: previous 199 candles + current = 200
  const startSlice = Math.max(0, idx - INDICATOR_LOOKBACK + 1);
  const slice = candles.slice(startSlice, idx + 1);
  if (slice.length < 50) return null;

  // 2. Compute indicators
  const indicators = computeIndicators(slice);
  if (!indicators) return null;

  // 3. Build HistoricalState document
  const state = new HistoricalState({
    symbol,
    timeframe,
    timestamp: new Date(currentCandle.time),
    price: {
      current: currentPrice,
      open: currentCandle.open,
      high: currentCandle.high,
      low: currentCandle.low,
      close: currentCandle.close,
    },
    trend: {
      direction: indicators.trendDirection,
      strength: indicators.adx,
      adx: indicators.adx,
      plusDI: indicators.plusDI,
      minusDI: indicators.minusDI,
      slope: indicators.slope,
    },
    momentum: {
      rsi: indicators.rsi,
      macdLine: indicators.macdLine,
      macdSignal: indicators.macdSignal,
      macdHist: indicators.macdHist,
      velocity: 0,
      acceleration: 0,
    },
    volatility: {
      atr: indicators.atr,
      atrPercent: indicators.atr / currentPrice,
      bbWidth: indicators.bbWidth,
      regime: indicators.volatilityRegime,
    },
    liquidity: { score: 0.5, spread: 0, tickFrequency: 0 },
    structure: {
      support: indicators.support,
      resistance: indicators.resistance,
      pricePosition: indicators.pricePosition,
      isAtSupport: indicators.isAtSupport,
      isAtResistance: indicators.isAtResistance,
    },
    session: {
      name: getSessionName(currentCandle.time),
      liquidityMultiplier: 1,
      isWeekday: true,
    },
    regime: {
      code: indicators.regimeCode || 'NEUTRAL',
      name: 'Neutral',
      confidence: 50,
      description: '',
    },
    summary: {
      marketQuality: 50,
      noiseLevel: 'medium',
      regimeSuggestion: indicators.regimeSuggestion || 'neutral',
      trendConfidence: indicators.adx,
    },
    confidence: 50,
    reason: 'Backfill',
    source: 'backfill',
    version: '2.0',
  });

  // 4. Compute outcomes for each lookahead
  let outcomesCreated = 0;
  for (const lookahead of LOOKAHEADS) {
    const endIdx = idx + lookahead;
    if (endIdx >= candles.length) continue;

    const endCandle = candles[endIdx];
    const endPrice = endCandle.close;
    const returnVal = endPrice - currentPrice;
    const returnR = returnVal / (indicators.atr || 0.001);
    const win = returnVal > 0;

    // Max drawdown during the period
    let maxDrawdown = 0;
    for (let k = idx; k <= endIdx; k++) {
      const drawdown = (candles[k].low - currentPrice) / currentPrice;
      if (drawdown < maxDrawdown) maxDrawdown = drawdown;
    }

    const outcomeKey = `outcome${lookahead}`;
    state[outcomeKey] = {
      return: returnVal,
      returnR: returnR,
      win: win,
      maxDrawdown: maxDrawdown,
      volatility: indicators.atr || 0.001,
      filledAt: new Date(),
    };

    // Also create HistoricalOutcome record
    await HistoricalOutcome.create({
      stateId: state._id,
      symbol,
      timeframe,
      lookahead: lookahead,
      outcome: {
        return: returnVal,
        returnR: returnR,
        win: win,
        maxDrawdown: maxDrawdown,
        volatility: indicators.atr || 0.001,
        startPrice: currentPrice,
        endPrice: endPrice,
      },
      featuresSnapshot: {
        adx: indicators.adx,
        rsi: indicators.rsi,
        atr: indicators.atr,
        bbWidth: indicators.bbWidth,
        macdHist: indicators.macdHist,
      },
      source: 'backfill',
      filledAt: new Date(),
    });
    outcomesCreated++;
  }

  await state.save();
  return { outcomesCreated };
}

// ---- Compute indicators from a slice of candles ----
function computeIndicators(candles) {
  try {
    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const candlesForInd = candles.map(c => ({ mid: { h: c.high, l: c.low, c: c.close } }));

    const adxData = ADX(candlesForInd, 14);
    const atrArray = ATR(candlesForInd, 14);
    const rsi = RSI(closes, 14);
    const macd = MACD(closes, 12, 26, 9);
    const bb = BollingerBands(closes, 20, 2);
    const sr = findSupportResistance(candlesForInd, 30, 0.001);

    const adx = adxData ? adxData.adx : 0;
    const plusDI = adxData ? adxData.plusDI : 0;
    const minusDI = adxData ? adxData.minusDI : 0;
    const atr = atrArray ? atrArray[atrArray.length - 1] : 0.001;
    const lastIdx = closes.length - 1;
    const currentPrice = closes[lastIdx];
    const trendLookback = Math.min(50, closes.length - 1);
    const direction = closes[lastIdx] > closes[lastIdx - trendLookback] ? 'bullish' : 'bearish';

    const support = sr && sr.support ? sr.support.price : null;
    const resistance = sr && sr.resistance ? sr.resistance.price : null;
    const pricePosition = (support && resistance) ? (currentPrice - support) / (resistance - support) : 0.5;
    const isAtSupport = support ? Math.abs(currentPrice - support) / currentPrice < 0.001 : false;
    const isAtResistance = resistance ? Math.abs(currentPrice - resistance) / currentPrice < 0.001 : false;

    const bbWidth = bb ? (bb.upper[bb.upper.length - 1] - bb.lower[bb.lower.length - 1]) / bb.middle[bb.middle.length - 1] : 0;
    const atrPercent = atr / currentPrice;
    let volRegime = 'normal';
    if (atrPercent > 0.015) volRegime = 'high';
    else if (atrPercent < 0.005) volRegime = 'low';

    let regimeCode = 'NEUTRAL';
    if (adx > 30) regimeCode = direction === 'bullish' ? 'STRONG_TREND_BULL' : 'STRONG_TREND_BEAR';
    else if (adx > 20) regimeCode = 'WEAK_TREND';
    else if (bbWidth < 0.15 && adx < 20) regimeCode = 'RANGING';
    else if (volRegime === 'high') regimeCode = 'HIGH_VOLATILITY';
    else if (volRegime === 'low') regimeCode = 'LOW_VOLATILITY';

    return {
      adx,
      plusDI,
      minusDI,
      atr,
      rsi: rsi || 50,
      macdLine: macd ? macd.macd[macd.macd.length - 1] : 0,
      macdSignal: macd ? macd.signal[macd.signal.length - 1] : 0,
      macdHist: macd ? macd.histogram[macd.histogram.length - 1] : 0,
      bbWidth,
      support,
      resistance,
      pricePosition,
      isAtSupport,
      isAtResistance,
      trendDirection: direction,
      slope: (closes[lastIdx] - closes[0]) / (closes[0] || 0.0001),
      volatilityRegime: volRegime,
      regimeCode,
      regimeSuggestion: regimeCode,
    };
  } catch (err) {
    logger.error(`Indicator error: ${err.message}`);
    return null;
  }
}

run().catch(err => {
  logger.error('❌ Script failed:', err.message);
  process.exit(1);
});
