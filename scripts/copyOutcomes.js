// scripts/copyOutcomes.js
// Copy outcomes from HistoricalOutcome to HistoricalState.outcome5/10/20/40

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const HistoricalState = require('../models/HistoricalState');
const HistoricalOutcome = require('../models/HistoricalOutcome');
const logger = require('../infrastructure/logger') || console;

async function copyOutcomes() {
  try {
    await connectDB();
    logger.info('✅ Connected to MongoDB.');

    // Get all HistoricalOutcome records grouped by stateId
    const outcomes = await HistoricalOutcome.find({}).lean();
    logger.info(`📊 Found ${outcomes.length} outcome records.`);

    // Group by stateId and lookahead
    const grouped = {};
    for (const o of outcomes) {
      const key = o.stateId.toString();
      if (!grouped[key]) grouped[key] = {};
      grouped[key][o.lookahead] = o.outcome;
    }

    let updated = 0;
    const stateIds = Object.keys(grouped);
    logger.info(`📊 Updating ${stateIds.length} states.`);

    for (const stateId of stateIds) {
      const state = await HistoricalState.findById(stateId);
      if (!state) continue;

      const outcomesMap = grouped[stateId];
      for (const [lookahead, outcome] of Object.entries(outcomesMap)) {
        const outcomeKey = `outcome${lookahead}`;
        state[outcomeKey] = {
          return: outcome.return || null,
          returnR: outcome.returnR || null,
          win: outcome.win || null,
          maxDrawdown: outcome.maxDrawdown || null,
          volatility: outcome.volatility || null,
          filledAt: outcome.filledAt || new Date(),
        };
      }
      await state.save();
      updated++;
      if (updated % 50 === 0) logger.info(`   ➜ Updated ${updated} states...`);
    }

    logger.info(`✅ Updated ${updated} states with outcomes.`);
    process.exit(0);
  } catch (err) {
    logger.error('❌ Script failed:', err.message);
    process.exit(1);
  }
}

copyOutcomes();
