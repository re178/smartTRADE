// scripts/labelOnly.js
// Labels outcomes for existing HistoricalState records.
// Run with: node scripts/labelOnly.js

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const candleHistory = require('../core/data/candleHistory');
const HistoricalState = require('../models/HistoricalState');
const HistoricalOutcome = require('../models/HistoricalOutcome');
const logger = require('../infrastructure/logger') || console;

const SYMBOLS = ['EUR_USD', 'GBP_USD', 'USD_JPY', 'AUD_USD'];
const TIMEFRAMES = ['M5', 'M15', 'H1'];
const LOOKAHEADS = [5, 10, 20, 40];
const CANDLE_COUNT = 500;
const TOLERANCE_MS = 60000; // 1 minute

async function run() {
  try {
    await connectDB();
    logger.info('✅ Connected to MongoDB.');

    let totalOutcomes = 0;

    for (const symbol of SYMBOLS) {
      for (const tf of TIMEFRAMES) {
        logger.info(`📥 Processing ${symbol} ${tf}...`);

        // Get states that still need labelling
        const states = await HistoricalState.find({
          symbol,
          timeframe: tf,
          'outcome5.return': null
        });

        if (states.length === 0) {
          logger.info(`   ⏭️ No unlabelled states for ${symbol} ${tf}.`);
          continue;
        }

        logger.info(`   📊 Found ${states.length} unlabelled states.`);

        // Fetch candles for this symbol/timeframe
        const candles = await candleHistory.getHistory(symbol, tf, CANDLE_COUNT);
        if (!candles || candles.length < 50) {
          logger.warn(`   ⚠️ Not enough candles for ${symbol} ${tf}. Skipping.`);
          continue;
        }

        let labelled = 0;

        for (const state of states) {
          const stateTime = new Date(state.timestamp).getTime();

          // Find the closest matching candle
          let startIdx = -1;
          for (let idx = 0; idx < candles.length; idx++) {
            const candleTime = new Date(candles[idx].time).getTime();
            if (Math.abs(candleTime - stateTime) <= TOLERANCE_MS) {
              startIdx = idx;
              break;
            }
          }

          if (startIdx === -1) {
            // Fallback: find first candle AFTER state time
            for (let idx = 0; idx < candles.length; idx++) {
              if (new Date(candles[idx].time).getTime() >= stateTime) {
                startIdx = idx;
                break;
              }
            }
          }

          const maxLookahead = Math.max(...LOOKAHEADS);
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

    logger.info(`🎉 All done. Created ${totalOutcomes} outcome records.`);
    process.exit(0);
  } catch (err) {
    logger.error('❌ Script failed:', err.message);
    process.exit(1);
  }
}

run();
