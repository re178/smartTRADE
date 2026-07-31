// scripts/backfillCandles.js
// Fetch historical candles from MT5 and store them.
// Run once to get a large batch of candles.

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const marketProvider = require('../core/market/provider');
const candleHistory = require('../core/data/candleHistory');
const logger = require('../infrastructure/logger') || console;

const SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'];
const TIMEFRAMES = ['M5', 'M15', 'H1'];
const CANDLE_COUNT = 1000; // fetch up to 1000 candles per timeframe

async function backfillCandles() {
  try {
    await connectDB();
    logger.info('✅ Connected to MongoDB.');

    for (const symbol of SYMBOLS) {
      for (const tf of TIMEFRAMES) {
        logger.info(`📥 Fetching ${symbol} ${tf}...`);

        // Fetch candles from broker (MT5)
        const candles = await marketProvider.getCandles(symbol, CANDLE_COUNT, tf, 'mt5');
        if (!candles || candles.length === 0) {
          logger.warn(`⚠️ No candles returned for ${symbol} ${tf}.`);
          continue;
        }

        logger.info(`   ➜ Received ${candles.length} candles. Storing...`);

        let stored = 0;
        for (const c of candles) {
          // Convert time (assumes c.time is Unix seconds)
          const timeMs = c.time * 1000;
          await candleHistory.store({
            symbol,
            timeframe: tf,
            time: timeMs,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume || 0,
            source: 'broker',
          });
          stored++;
        }

        logger.info(`✅ Stored ${stored} candles for ${symbol} ${tf}.`);
      }
    }

    logger.info('🎉 Backfill complete. You can now run the labelling script again.');
    process.exit(0);
  } catch (err) {
    logger.error('❌ Backfill failed:', err.message);
    process.exit(1);
  }
}

backfillCandles();
