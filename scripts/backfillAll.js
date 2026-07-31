// scripts/backfillAll.js
// Proper backfill: for each historical candle, compute features from previous 200 candles,
// store state with future outcomes.

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const candleHistory = require('../core/data/candleHistory');
const HistoricalState = require('../models/HistoricalState');
const HistoricalOutcome = require('../models/HistoricalOutcome');
const { ADX, ATR, RSI, MACD, BollingerBands, findSupportResistance } = require('../core/strategy/engine');
const logger = require('../infrastructure/logger') || console;

const SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'];
const TIMEFRAMES = ['M5', 'M15', 'H1'];
const LOOKAHEADS = [5, 10, 20, 40];
const MAX_CANDLES = 5000;      // how many candles to process per symbol/timeframe
const BATCH_SIZE = 20;         // states per batch
const INDICATOR_LOOKBACK = 200; // candles needed for indicators

// Helper to map symbol format (underscore vs none)
function normalizeSymbol(sym) {
   // If it contains underscore, keep as is; else add underscore
   if (sym.includes('_')) return sym;
   return sym.slice(0, 3) + '_' + sym.slice(3);
}

async function run() {
   await connectDB();
   logger.info('✅ Connected to MongoDB.');

   // Drop existing collections (to start fresh)
   await HistoricalState.deleteMany({});
   await HistoricalOutcome.deleteMany({});
   logger.info('🧹 Cleared existing HistoricalState and HistoricalOutcome.');

   let totalStates = 0;
   let totalOutcomes = 0;

   for (const rawSymbol of SYMBOLS) {
      // Use the symbol as stored in HistoricalCandles (may have underscore)
      const symbol = normalizeSymbol(rawSymbol);
      for (const tf of TIMEFRAMES) {
         logger.info(`📥 Processing ${symbol} ${tf}...`);

         const candles = await candleHistory.getHistory(symbol, tf, MAX_CANDLES);
         if (!candles || candles.length < INDICATOR_LOOKBACK + 50) {
            logger.warn(`⚠️ Not enough candles for ${symbol} ${tf} (need ${INDICATOR_LOOKBACK + 50})`);
            continue;
         }

         const totalCandles = candles.length;
         // We can only label states that have enough future candles for max lookahead
         const maxLookahead = Math.max(...LOOKAHEADS);
         const usableCandles = totalCandles - maxLookahead - 5; // leave some buffer

         if (usableCandles < 10) {
            logger.warn(`⚠️ Not enough usable candles for ${symbol} ${tf}`);
            continue;
         }

         // Process in batches
         for (let i = INDICATOR_LOOKBACK; i < usableCandles; i += BATCH_SIZE) {
            const end = Math.min(i + BATCH_SIZE, usableCandles);
            const batchPromises = [];

            for (let idx = i; idx < end; idx++) {
               batchPromises.push(processCandle(candles, idx, symbol, tf));
            }

            const results = await Promise.allSettled(batchPromises);
            for (const r of results) {
               if (r.status === 'fulfilled' && r.value) {
                  totalStates++;
                  totalOutcomes += r.value.outcomesCreated || 0;
               }
            }

            logger.info(`   ➜ Processed up to candle ${end}/${usableCandles} (${totalStates} states so far)`);
         }
         logger.info(`✅ Finished ${symbol} ${tf} – ${totalStates} states created so far.`);
      }
   }

   logger.info(`🎉 All done. Created ${totalStates} states and ${totalOutcomes} outcome records.`);
   process.exit(0);
}

async function processCandle(candles, idx, symbol, timeframe) {
   // Get the slice of candles needed for indicators (previous 200 + current)
   const start = Math.max(0, idx - INDICATOR_LOOKBACK + 1);
   const slice = candles.slice(start, idx + 1);
   if (slice.length < 50) return null;

   const currentCandle = candles[idx];
   const currentPrice = currentCandle.close;
   const atr = calculateATR(slice);
   if (!atr) return null;

   // Compute indicators using the slice
   const features = computeFeatures(slice);
   if (!features) return null;

   // Build state document
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
         direction: features.trendDirection,
         strength: features.trendStrength,
         adx: features.adx,
         plusDI: features.plusDI,
         minusDI: features.minusDI,
         slope: features.slope,
      },
      momentum: {
         rsi: features.rsi,
         macdLine: features.macdLine,
         macdSignal: features.macdSignal,
         macdHist: features.macdHist,
         velocity: 0,
         acceleration: 0,
      },
      volatility: {
         atr: atr,
         atrPercent: atr / currentPrice,
         bbWidth: features.bbWidth,
         regime: features.volatilityRegime,
      },
      liquidity: {
         score: 0.5,
         spread: 0,
         tickFrequency: 0,
      },
      structure: {
         support: features.support,
         resistance: features.resistance,
         pricePosition: features.pricePosition,
         isAtSupport: features.isAtSupport,
         isAtResistance: features.isAtResistance,
      },
      session: {
         name: getSessionName(currentCandle.time),
         liquidityMultiplier: 1,
         isWeekday: true,
      },
      regime: {
         code: features.regimeCode || 'NEUTRAL',
         name: 'Neutral',
         confidence: 50,
         description: '',
      },
      summary: {
         marketQuality: 50,
         noiseLevel: 'medium',
         regimeSuggestion: features.regimeSuggestion || 'neutral',
         trendConfidence: features.trendConfidence || 50,
      },
      confidence: 50,
      reason: 'Backfilled',
      source: 'backfill',
      version: '2.0',
   });

   // Now compute outcomes for each lookahead
   let outcomesCreated = 0;
   for (const lookahead of LOOKAHEADS) {
      const endIdx = idx + lookahead;
      if (endIdx >= candles.length) continue;
      const endPrice = candles[endIdx].close;
      const returnVal = endPrice - currentPrice;
      const returnR = returnVal / atr;
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
         volatility: atr,
         filledAt: new Date(),
      };

      // Also create HistoricalOutcome record for training
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
            volatility: atr,
            startPrice: currentPrice,
            endPrice: endPrice,
         },
         featuresSnapshot: features,
         source: 'backfill',
         filledAt: new Date(),
      });
      outcomesCreated++;
   }

   await state.save();
   return { outcomesCreated };
}

// ---- Indicator computation helpers ----
function calculateATR(candles) {
   const atrArray = ATR(candles.map(c => ({ mid: { h: c.high, l: c.low, c: c.close } })), 14);
   return atrArray ? atrArray[atrArray.length - 1] : null;
}

function computeFeatures(candles) {
   try {
      const closes = candles.map(c => c.close);
      const highs = candles.map(c => c.high);
      const lows = candles.map(c => c.low);
      const candlesForInd = candles.map(c => ({ mid: { h: c.high, l: c.low, c: c.close } }));

      const adxData = ADX(candlesForInd, 14);
      const rsi = RSI(closes, 14);
      const macd = MACD(closes, 12, 26, 9);
      const bb = BollingerBands(closes, 20, 2);
      const sr = findSupportResistance(candlesForInd, 30, 0.001);

      const adx = adxData ? adxData.adx : 0;
      const plusDI = adxData ? adxData.plusDI : 0;
      const minusDI = adxData ? adxData.minusDI : 0;
      const atr = calculateATR(candles) || 0.001;
      const lastIdx = closes.length - 1;
      const currentPrice = closes[lastIdx];

      // Trend direction based on price vs 50-period lookback
      const trendLookback = Math.min(50, closes.length - 1);
      const direction = closes[lastIdx] > closes[lastIdx - trendLookback] ? 'bullish' : 'bearish';

      // Support/resistance
      const support = sr && sr.support ? sr.support.price : null;
      const resistance = sr && sr.resistance ? sr.resistance.price : null;
      const pricePosition = (support && resistance) ? (currentPrice - support) / (resistance - support) : 0.5;
      const isAtSupport = support ? Math.abs(currentPrice - support) / currentPrice < 0.001 : false;
      const isAtResistance = resistance ? Math.abs(currentPrice - resistance) / currentPrice < 0.001 : false;

      // Volatility regime
      const bbWidth = bb ? (bb.upper[bb.upper.length - 1] - bb.lower[bb.lower.length - 1]) / bb.middle[bb.middle.length - 1] : 0;
      const atrPercent = atr / currentPrice;
      let volRegime = 'normal';
      if (atrPercent > 0.015) volRegime = 'high';
      else if (atrPercent < 0.005) volRegime = 'low';

      // Regime suggestion
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
         trendStrength: adx,
         slope: (closes[lastIdx] - closes[0]) / (closes[0] || 0.0001),
         volatilityRegime: volRegime,
         regimeCode,
         regimeSuggestion: regimeCode,
         trendConfidence: adx,
      };
   } catch (err) {
      return null;
   }
}

function getSessionName(timestamp) {
   const hour = new Date(timestamp).getUTCHours();
   if (hour >= 22 || hour < 6) return 'Sydney';
   if (hour >= 0 && hour < 8) return 'Asia';
   if (hour >= 7 && hour < 15) return 'London';
   if (hour >= 12 && hour < 20) return 'New York';
   return 'Other';
}

run().catch(err => {
   logger.error('❌ Script failed:', err.message);
   process.exit(1);
});
