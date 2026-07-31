// scripts/deleteCollections.js
// Drop HistoricalState and HistoricalOutcome collections.

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const logger = require('../infrastructure/logger') || console;

async function deleteCollections() {
  try {
    await connectDB();
    logger.info('✅ Connected to MongoDB.');

    const HistoricalState = require('../models/HistoricalState');
    const HistoricalOutcome = require('../models/HistoricalOutcome');

    await HistoricalState.deleteMany({});
    await HistoricalOutcome.deleteMany({});

    logger.info('🧹 Dropped HistoricalState and HistoricalOutcome collections.');
    process.exit(0);
  } catch (err) {
    logger.error('❌ Failed to delete collections:', err.message);
    process.exit(1);
  }
}

deleteCollections();
