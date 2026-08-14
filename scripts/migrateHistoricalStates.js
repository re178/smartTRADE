// scripts/migrateHistoricalStates.js
// Migration script: Backfill future path data for all HistoricalState records.
// Uses the new outcomeLabeler to compute and store MFE, MAE, time‑to‑extremes, etc.

require('dotenv').config();
const mongoose = require('mongoose');
const HistoricalState = require('../models/HistoricalState');
const { labelAllStates } = require('../core/intelligence/lab/outcomeLabeler');
const logger = require('../infrastructure/logger') || console;

// Configuration
const CONFIG = {
  // MongoDB connection URI – uses the same as your app
  MONGO_URI: process.env.MONGO_URI || 'mongodb://localhost:27017/rts',
  // Batch size for processing states
  BATCH_SIZE: 100,
  // Max lookahead (candles) to fetch
  MAX_HORIZON: 40,
  // Sleep between batches (ms)
  BATCH_SLEEP_MS: 500,
};

async function runMigration() {
  try {
    logger.info('========================================');
    logger.info('HistoricalState Migration – Future Path Backfill');
    logger.info('========================================');

    // 1. Connect to MongoDB
    logger.info(`Connecting to MongoDB: ${CONFIG.MONGO_URI}`);
    await mongoose.connect(CONFIG.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    logger.info('✅ Connected to MongoDB');

    // 2. Count unlabelled states
    const totalUnlabelled = await HistoricalState.countDocuments({
      futurePrices: null,
    });
    logger.info(`📊 Total unlabelled states: ${totalUnlabelled}`);

    if (totalUnlabelled === 0) {
      logger.info('✅ All states already have future path data. No migration needed.');
      process.exit(0);
    }

    // 3. Run the labeler
    logger.info(`🚀 Starting migration with batch size: ${CONFIG.BATCH_SIZE}`);
    const startTime = Date.now();

    const result = await labelAllStates(CONFIG.BATCH_SIZE, CONFIG.MAX_HORIZON);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.info(`✅ Migration completed in ${elapsed}s`);
    logger.info(`   Processed: ${result.totalProcessed}`);
    logger.info(`   Success:   ${result.totalSuccess}`);
    logger.info(`   Failed:    ${result.totalFailed}`);

    // 4. Verify remaining
    const remaining = await HistoricalState.countDocuments({
      futurePrices: null,
    });
    if (remaining > 0) {
      logger.warn(`⚠️ ${remaining} states still unlabelled. You may need to run the script again.`);
    } else {
      logger.info('🎉 All states successfully labelled with future path data!');
    }

    process.exit(0);
  } catch (err) {
    logger.error('❌ Migration failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

// Run the migration
runMigration();
