// scripts/labelExisting.js
// Labels states that have enough future candles.

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const candleHistory = require('../core/data/candleHistory');
const HistoricalState = require('../models/HistoricalState');
const HistoricalOutcome = require('../models/HistoricalOutcome');
const logger = require('../infrastructure/logger') || console;

const LOOKAHEADS = [5, 10, 20, 40];
const MAX_LOOKAHEAD = Math.max(...LOOKAHEADS);
const CANDLE_COUNT = 300;
const TOLERANCE_MS = 60000;

async function run() {
  try {
    await connectDB();
    logger.info('✅ Connected to MongoDB.');

    // Get all unlabelled states
    const states = await HistoricalState.find({ 'outcome5.return': null });
    if (states.length === 0) {
      logger.info('🎉 No unlabelled states.');
      process.exit(0);
    }

    logger.info(`📊 Found ${states.length} unlabelled states.`);

    let labelled = 0;
    let skipped = 0;
    let totalOutcomes = 0;

    // Group states by symbol/timeframe to fetch candles once per group
    const groups = {};
    for (const state of states) {
      const key = `${state.symbol}:${state.timeframe}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(state);
    }

    for (const [key, group] of Object.entries(groups)) {
      const [symbol, timeframe] = key.split(':');
      logger.info(`📥 Processing ${symbol} ${timeframe} (${group.length} states)`);

      // Fetch candles for this group
      const candles = await candleHistory.getHistory(symbol, timeframe, CANDLE_COUNT);
      if (!candles || candles.length < MAX_LOOKAHEAD + 10) {
        logger.warn(`   ⚠️ Not enough candles for ${symbol} ${timeframe}. Skipping all.`);
        skipped += group.length;
        continue;
      }

      for (const state of group) {
        const stateTime = new Date(state.timestamp).getTime();

        // Find matching candle
        let startIdx = -1;
        for (let idx = 0; idx < candles.length; idx++) {
          const candleTime = new Date(candles[idx].time).getTime();
          if (Math.abs(candleTime - stateTime) <= TOLERANCE_MS) {
            startIdx = idx;
            break;
          }
        }
        if (startIdx === -1) {
          // fallback: first after
          for (let idx = 0; idx < candles.length; idx++) {
            if (new Date(candles[idx].time).getTime() >= stateTime) {
              startIdx = idx;
              break;
            }
          }
        }

        if (startIdx === -1 || startIdx + MAX_LOOKAHEAD >= candles.length) {
          skipped++;
          continue;
        }

        const startPrice = candles[startIdx].close;
        const atr = state.volatility?.atr || 0.001;

        for (const lookahead of LOOKAHEADS) {
          const endIdx = startIdx + lookahead;
          if (endIdx >= candles.length) continue;

          const endPrice = candles[endIdx].close;
          const returnVal = endPrice - startPrice;
          const returnR = returnVal / atr;
          const win = returnVal > 0;

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
      logger.info(`✅ Labelled ${group.length - skipped} states for ${symbol} ${timeframe}`);
    }

    logger.info(`🎉 Done. Labelled ${labelled} states, skipped ${skipped} (not enough future candles).`);
    logger.info(`   Total outcomes created: ${totalOutcomes}`);
    logger.info(`   Run this script again later to label more as candles accumulate.`);
    process.exit(0);
  } catch (err) {
    logger.error('❌ Script failed:', err.message);
    process.exit(1);
  }
}

run();
