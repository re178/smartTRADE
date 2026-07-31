// scripts/backfillAll.js
// Corrected: summary.regimeSuggestion uses allowed enum values.

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

// ---- CONFIG ----
const SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'];
const TIMEFRAMES = ['M5', 'M15', 'H1'];
const LOOKAHEADS = [5, 10, 20, 40];
const MAX_CANDLES = 5000;
const BATCH_SIZE = 10;
const INDICATOR_LOOKBACK = 200;

function normalizeSymbol(sym) {
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

async function run() {
  await connectDB();
  logger.info('✅ Connected to MongoDB.');

  await HistoricalState.deleteMany({});
  await HistoricalOutcome.deleteMany({});
  logger.info('🧹 Dropped existing HistoricalState and HistoricalOutcome.');

  let totalStates = 0;
  let totalOutcomes = 0;
  let skippedCount = 0;

  for (const rawSymbol of SYMBOLS) {
    const symbol = normalizeSymbol(rawSymbol);
    for (const tf of TIMEFRAMES) {
      logger.info(`📥 Processing ${symbol} ${tf}...`);

      const candles = await candleHistory.getHistory(symbol, tf, MAX_CANDLES);
      if (!candles || candles.length < INDICATOR_LOOKBACK + 50) {
        logger.warn(`⚠️ Not enough candles for ${symbol} ${tf} (got ${candles?.length})`);
        continue;
      }

      const totalCandles = candles.length;
      const maxLookahead = Math.max(...LOOKAHEADS);
      const usableEnd = totalCandles - maxLookahead - 5;
      if (usableEnd < INDICATOR_LOOKBACK + 10) {
        logger.warn(`⚠️ Not enough usable candles for ${symbol} ${tf}`);
        continue;
      }

      logger.info(`   Total candles: ${totalCandles}, usable until: ${usableEnd}`);

      for (let startIdx = INDICATOR_LOOKBACK; startIdx < usableEnd; startIdx += BATCH_SIZE) {
        const endIdx = Math.min(startIdx + BATCH_SIZE, usableEnd);
        const batchPromises = [];
        for (let idx = startIdx; idx < endIdx; idx++) {
          batchPromises.push(processCandle(candles, idx, symbol, tf));
        }
        const results = await Promise.allSettled(batchPromises);
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value) {
            if (r.value.created) {
              totalStates++;
              totalOutcomes += r.value.outcomesCreated || 0;
            } else {
              skippedCount++;
            }
          } else {
            skippedCount++;
            logger.error(`   ❌ Batch promise rejected: ${r.reason}`);
          }
        }
        logger.info(`   ➜ Processed up to candle ${endIdx}/${usableEnd} (${totalStates} states, ${skippedCount} skipped)`);
      }
      logger.info(`✅ Finished ${symbol} ${tf} – total states: ${totalStates}, skipped: ${skippedCount}`);
    }
  }

  logger.info(`🎉 All done. Created ${totalStates} states and ${totalOutcomes} outcome records. Skipped ${skippedCount} candles.`);
  process.exit(0);
}

async function processCandle(candles, idx, symbol, timeframe) {
  const currentCandle = candles[idx];
  const currentPrice = currentCandle.close;

  const startSlice = Math.max(0, idx - INDICATOR_LOOKBACK + 1);
  const slice = candles.slice(startSlice, idx + 1);
  if (slice.length < 50) return { created: false };

  let indicators;
  try {
    indicators = computeIndicators(slice);
  } catch (err) {
    logger.error(`   ❌ Indicator error at idx ${idx}: ${err.message}`);
    return { created: false };
  }

  if (!indicators) return { created: false };

  // ---- Fix: map regimeSuggestion to allowed enum ----
  const allowedSuggestions = {
    'trending': 'trending',
    'ranging': 'ranging',
    'volatile': 'volatile',
    'quiet': 'quiet',
    'reversal': 'reversal',
    'neutral': 'neutral',
  };
  // Default to 'neutral' if mapping fails
  const suggestionKey = indicators.regimeSuggestion || 'neutral';
  const regimeSuggestion = allowedSuggestions[suggestionKey] || 'neutral';

  // Build state document with corrected summary.regimeSuggestion
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
      direction: indicators.trendDirection || 'neutral',
      strength: indicators.adx || 0,
      adx: indicators.adx || 0,
      plusDI: indicators.plusDI || 0,
      minusDI: indicators.minusDI || 0,
      slope: indicators.slope || 0,
    },
    momentum: {
      rsi: indicators.rsi || 50,
      macdLine: indicators.macdLine || 0,
      macdSignal: indicators.macdSignal || 0,
      macdHist: indicators.macdHist || 0,
      velocity: 0,
      acceleration: 0,
    },
    volatility: {
      atr: indicators.atr || 0.001,
      atrPercent: (indicators.atr || 0.001) / currentPrice,
      bbWidth: indicators.bbWidth || 0.15,
      regime: indicators.volatilityRegime || 'normal',
    },
    liquidity: { score: 0.5, spread: 0, tickFrequency: 0 },
    structure: {
      support: indicators.support || null,
      resistance: indicators.resistance || null,
      pricePosition: indicators.pricePosition || 0.5,
      isAtSupport: indicators.isAtSupport || false,
      isAtResistance: indicators.isAtResistance || false,
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
      // ---- Fix: use mapped value ----
      regimeSuggestion: regimeSuggestion,
      trendConfidence: indicators.adx || 0,
    },
    confidence: 50,
    reason: 'Backfill',
    source: 'backfill',
    version: '2.0',
  });

  let outcomesCreated = 0;
  for (const lookahead of LOOKAHEADS) {
    const endIdx = idx + lookahead;
    if (endIdx >= candles.length) continue;

    const endCandle = candles[endIdx];
    const endPrice = endCandle.close;
    const returnVal = endPrice - currentPrice;
    const returnR = returnVal / (indicators.atr || 0.001);
    const win = returnVal > 0;

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
        adx: indicators.adx || 0,
        rsi: indicators.rsi || 50,
        atr: indicators.atr || 0.001,
        bbWidth: indicators.bbWidth || 0.15,
        macdHist: indicators.macdHist || 0,
      },
      source: 'backfill',
      filledAt: new Date(),
    });
    outcomesCreated++;
  }

  await state.save();
  return { created: true, outcomesCreated };
}

function computeIndicators(candles) {
  try {
    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const candlesForInd = candles.map(c => ({ mid: { h: c.high, l: c.low, c: c.close } }));

    if (closes.length < 50) return null;

    let adxData = null, atrArray = null, rsi = null, macd = null, bb = null, sr = null;
    try { adxData = ADX(candlesForInd, 14); } catch(e) {}
    try { atrArray = ATR(candlesForInd, 14); } catch(e) {}
    try { rsi = RSI(closes, 14); } catch(e) {}
    try { macd = MACD(closes, 12, 26, 9); } catch(e) {}
    try { bb = BollingerBands(closes, 20, 2); } catch(e) {}
    try { sr = findSupportResistance(candlesForInd, 30, 0.001); } catch(e) {}

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

    // ---- Determine regime code ----
    let regimeCode = 'NEUTRAL';
    if (adx > 30) regimeCode = direction === 'bullish' ? 'STRONG_TREND_BULL' : 'STRONG_TREND_BEAR';
    else if (adx > 20) regimeCode = 'WEAK_TREND';
    else if (bbWidth < 0.15 && adx < 20) regimeCode = 'RANGING';
    else if (volRegime === 'high') regimeCode = 'HIGH_VOLATILITY';
    else if (volRegime === 'low') regimeCode = 'LOW_VOLATILITY';

    // ---- Map to allowed summary.regimeSuggestion ----
    let suggestion = 'neutral';
    if (adx > 30) suggestion = 'trending';
    else if (bbWidth < 0.15 && adx < 20) suggestion = 'ranging';
    else if (volRegime === 'high') suggestion = 'volatile';
    else if (volRegime === 'low') suggestion = 'quiet';
    else if ((rsi || 50) > 70 || (rsi || 50) < 30) suggestion = 'reversal';

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
      regimeCode: regimeCode,
      regimeSuggestion: suggestion, // now always one of the allowed values
    };
  } catch (err) {
    logger.error(`computeIndicators error: ${err.message}`);
    return null;
  }
}

run().catch(err => {
  logger.error('❌ Script failed:', err.message);
  process.exit(1);
});
