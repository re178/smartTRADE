// scripts/finalLabel.js
// Robust one‑time outcome labelling for ALL existing HistoricalState records.
// Handles any symbol format (with or without underscore).

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const candleHistory = require('../core/data/candleHistory');
const HistoricalState = require('../models/HistoricalState');
const HistoricalOutcome = require('../models/HistoricalOutcome');
const logger = require('../infrastructure/logger') || console;

const LOOKAHEADS = [5, 10, 20, 40];
const CANDLE_COUNT = 500;
const TOLERANCE_MS = 60000; // 1 minute

// Helper: try to fetch candles with a given symbol, fallback to underscore/no-underscore
async function getCandles(symbol, timeframe) {
  let candles = await candleHistory.getHistory(symbol, timeframe, CANDLE_COUNT);
  if (candles && candles.length > 0) return candles;

  // Try with underscore if not present
  if (!symbol.includes('_')) {
    const withUnderscore = symbol.slice(0, 3) + '_' + symbol.slice(3);
    candles = await candleHistory.getHistory(withUnderscore, timeframe, CANDLE_COUNT);
    if (candles && candles.length > 0) return candles;
  } else {
    // Try without underscore
    const withoutUnderscore = symbol.replace('_', '');
    candles = await candleHistory.getHistory(withoutUnderscore, timeframe, CANDLE_COUNT);
    if (candles && candles.length > 0) return candles;
  }
  return null;
}

async function run() {
  try {
    await connectDB();
    logger.info('✅ Connected to MongoDB.');

    // Get all unlabelled states
    const states = await HistoricalState.find({ 'outcome5.return': null });
    if (states.length === 0) {
      logger.info('🎉 No unlabelled states found. All done!');
      process.exit(0);
    }

    logger.info(`📊 Found ${states.length} unlabelled states.`);

    let labelled = 0;
    let totalOutcomes = 0;

    for (const state of states) {
      const symbol = state.symbol;
      const timeframe = state.timeframe;

      // ---- Get candles for this symbol/timeframe ----
      let candles = await getCandles(symbol, timeframe);
      if (!candles || candles.length < 50) {
        logger.warn(`⚠️ No candles for ${symbol} ${timeframe}. Skipping state ${state._id}`);
        continue;
      }

      const stateTime = new Date(state.timestamp).getTime();

      // ---- Find the closest matching candle ----
      let startIdx = -1;
      for (let idx = 0; idx < candles.length; idx++) {
        const candleTime = new Date(candles[idx].time).getTime();
        if (Math.abs(candleTime - stateTime) <= TOLERANCE_MS) {
          startIdx = idx;
          break;
        }
      }
      if (startIdx === -1) {
        // Fallback: find first candle after state time
        for (let idx = 0; idx < candles.length; idx++) {
          if (new Date(candles[idx].time).getTime() >= stateTime) {
            startIdx = idx;
            break;
          }
        }
      }

      const maxLookahead = Math.max(...LOOKAHEADS);
      if (startIdx === -1 || startIdx + maxLookahead >= candles.length) {
        logger.warn(`⚠️ Cannot label state ${state._id}: no future candles. Skipping.`);
        continue;
      }

      const startPrice = candles[startIdx].close;
      const atr = state.volatility?.atr || 0.001;

      // ---- Compute outcomes for each lookahead ----
      for (const lookahead of LOOKAHEADS) {
        const endIdx = startIdx + lookahead;
        if (endIdx >= candles.length) continue;

        const endPrice = candles[endIdx].close;
        const returnVal = endPrice - startPrice;
        const returnR = returnVal / atr;
        const win = returnVal > 0;

        // Max drawdown
        let maxDrawdown = 0;
        for (let k = startIdx; k <= endIdx; k++) {
          const drawdown = (candles[k].low - startPrice) / startPrice;
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

        // Also create a separate HistoricalOutcome record (for training)
        await HistoricalOutcome.create({
          stateId: state._id,
          symbol: state.symbol,
          timeframe: state.timeframe,
          lookahead: lookahead,
          outcome: {
            return: returnVal,
            returnR: returnR,
            win: win,
            maxDrawdown: maxDrawdown,
            volatility: atr,
            startPrice: startPrice,
            endPrice: endPrice,
          },
          featuresSnapshot: state.getFeatureVector ? state.getFeatureVector() : {},
          source: 'backfill',
          filledAt: new Date(),
        });
      }

      await state.save();
      labelled++;
      totalOutcomes += LOOKAHEADS.length;
      if (labelled % 5 === 0) logger.info(`   ➜ Labelled ${labelled} states...`);
    }

    logger.info(`🎉 All done. Labelled ${labelled} states, created ${totalOutcomes} outcome records.`);
    process.exit(0);
  } catch (err) {
    logger.error('❌ Script failed:', err.message);
    process.exit(1);
  }
}

run();
