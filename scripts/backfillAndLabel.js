// scripts/backfillAndLabel.js
// One‑script backfill + outcome labelling (fixed timestamp matching).

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const candleHistory = require('../core/data/candleHistory');
const deepMarketState = require('../core/intelligence/deep/marketState');
const HistoricalState = require('../models/HistoricalState');
const HistoricalOutcome = require('../models/HistoricalOutcome');
const logger = require('../infrastructure/logger') || console;

const SYMBOLS = ['EUR_USD', 'GBP_USD', 'USD_JPY', 'AUD_USD'];
const TIMEFRAMES = ['M5', 'M15', 'H1'];
const CANDLE_COUNT = 500; // increased to ensure enough future candles
const LOOKAHEADS = [5, 10, 20, 40];
const BATCH_SIZE = 10;
const TOLERANCE_MS = 60000; // 1 minute

async function run() {
  try {
    await connectDB();
    logger.info('✅ Connected to MongoDB.');

    const existingCount = await HistoricalState.countDocuments();
    if (existingCount > 100) {
      logger.info(`⏭️ HistoricalState already has ${existingCount} records. Skipping backfill.`);
      logger.info('   To force re‑run, delete the HistoricalState and HistoricalOutcome collections.');
      process.exit(0);
    }

    let totalStates = 0;
    let totalOutcomes = 0;

    for (const symbol of SYMBOLS) {
      for (const tf of TIMEFRAMES) {
        logger.info(`📥 Processing ${symbol} ${tf}...`);
        const candles = await candleHistory.getHistory(symbol, tf, CANDLE_COUNT);
        if (!candles || candles.length < 50) {
          logger.warn(`⚠️ Not enough candles for ${symbol} ${tf}. Skipping.`);
          continue;
        }

        // ---- Phase 1: Create states (skip last 50 candles to ensure outcomes exist) ----
        const maxLookahead = Math.max(...LOOKAHEADS);
        const endIndex = candles.length - maxLookahead - 5; // leave extra buffer
        for (let i = 0; i < endIndex; i += BATCH_SIZE) {
          const batch = candles.slice(i, Math.min(i + BATCH_SIZE, endIndex));
          const promises = batch.map(async () => {
            try {
              await deepMarketState.compute(symbol, tf, CANDLE_COUNT);
            } catch (err) {
              // ignore per‑candle errors
            }
          });
          await Promise.allSettled(promises);
          totalStates += batch.length;
          logger.info(`   ➜ Created ${totalStates} states so far...`);
        }

        // ---- Phase 2: Label outcomes ----
        const states = await HistoricalState.find({ symbol, timeframe: tf, 'outcome5.return': null });
        logger.info(`   📊 Labelling ${states.length} states for ${symbol} ${tf}...`);

        let labelled = 0;
        for (const state of states) {
          const stateTime = new Date(state.timestamp).getTime();

          // Find the closest candle index within tolerance
          let startIdx = -1;
          for (let idx = 0; idx < candles.length; idx++) {
            const candleTime = new Date(candles[idx].time).getTime();
            if (Math.abs(candleTime - stateTime) <= TOLERANCE_MS) {
              startIdx = idx;
              break;
            }
          }

          if (startIdx === -1) {
            // Try to find the first candle AFTER the state time
            for (let idx = 0; idx < candles.length; idx++) {
              if (new Date(candles[idx].time).getTime() >= stateTime) {
                startIdx = idx;
                break;
              }
            }
          }

          if (startIdx === -1 || startIdx + maxLookahead >= candles.length) {
            logger.warn(`   ⚠️ Cannot label state ${state._id}: no future candles.`);
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

            // Create HistoricalOutcome record
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
          if (labelled % 5 === 0) logger.info(`      ➜ Labelled ${labelled} states...`);
        }
        logger.info(`✅ Finished ${symbol} ${tf} – ${labelled} states labelled.`);
      }
    }

    logger.info(`🎉 All done. Created ${totalStates} states and ${totalOutcomes} outcome records.`);
    process.exit(0);
  } catch (err) {
    logger.error('❌ Script failed:', err.message);
    process.exit(1);
  }
}

run();
