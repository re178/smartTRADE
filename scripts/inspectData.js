// inspectData.js – Inspect Candles, States, and Outcomes
// Run: node inspectData.js

require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');

// ----- Configuration -----
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/rts';
const OUTPUT_FILE = 'data_inspection.json';

// ----- Helper: print section header -----
function printHeader(title) {
  console.log('\n' + '='.repeat(80));
  console.log(`  ${title}`);
  console.log('='.repeat(80));
}

// ----- Helper: print object with indentation -----
function printObj(obj, label) {
  console.log(`\n${label}:`);
  console.log(JSON.stringify(obj, null, 2));
}

// ----- Main inspection -----
async function inspect() {
  console.log('🔌 Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected.\n');

  // ---- Get models ----
  // HistoricalCandle might be defined in candleHistory.js, but we can also get it from mongoose.
  let CandleModel;
  try {
    CandleModel = mongoose.model('HistoricalCandle');
  } catch (e) {
    // If not defined, define a simple schema (must match candleHistory.js)
    const candleSchema = new mongoose.Schema({
      symbol: String,
      timeframe: String,
      time: Date,
      open: Number,
      high: Number,
      low: Number,
      close: Number,
      volume: Number,
      source: String,
    });
    CandleModel = mongoose.model('HistoricalCandle', candleSchema);
  }

  const StateModel = require('../models/HistoricalState');
  const OutcomeModel = require('../models/HistoricalOutcome');

  // ---- 1. Candles ----
  printHeader('CANDLES (HistoricalCandle)');
  const totalCandles = await CandleModel.countDocuments();
  console.log(`Total candles: ${totalCandles}`);
  if (totalCandles > 0) {
    const sampleCandles = await CandleModel.find().limit(5).lean();
    console.log('\nSample candles (first 5):');
    sampleCandles.forEach((c, i) => {
      console.log(`\nCandle #${i+1}:`);
      console.log(`  Symbol: ${c.symbol}, Timeframe: ${c.timeframe}`);
      console.log(`  Time: ${c.time.toISOString()}`);
      console.log(`  O: ${c.open}, H: ${c.high}, L: ${c.low}, C: ${c.close}`);
      console.log(`  Volume: ${c.volume}, Source: ${c.source}`);
    });
  }

  // ---- 2. States ----
  printHeader('STATES (HistoricalState)');
  const totalStates = await StateModel.countDocuments();
  console.log(`Total states: ${totalStates}`);
  if (totalStates > 0) {
    // Statistics per symbol and timeframe
    const stateStats = await StateModel.aggregate([
      { $group: { _id: { symbol: '$symbol', timeframe: '$timeframe' }, count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    console.log('\nState counts per symbol/timeframe:');
    stateStats.forEach(s => {
      console.log(`  ${s._id.symbol} ${s._id.timeframe}: ${s.count}`);
    });

    // Labelling stats
    const labelled5 = await StateModel.countDocuments({ 'outcome5.return': { $ne: null } });
    const labelled10 = await StateModel.countDocuments({ 'outcome10.return': { $ne: null } });
    const labelled20 = await StateModel.countDocuments({ 'outcome20.return': { $ne: null } });
    const labelled40 = await StateModel.countDocuments({ 'outcome40.return': { $ne: null } });
    const fullyLabelled = await StateModel.countDocuments({
      'outcome5.return': { $ne: null },
      'outcome10.return': { $ne: null },
      'outcome20.return': { $ne: null },
      'outcome40.return': { $ne: null },
    });
    console.log('\nLabelling coverage:');
    console.log(`  outcome5:  ${labelled5}`);
    console.log(`  outcome10: ${labelled10}`);
    console.log(`  outcome20: ${labelled20}`);
    console.log(`  outcome40: ${labelled40}`);
    console.log(`  Fully labelled (all 4): ${fullyLabelled}`);

    // Sample states (first 5)
    const sampleStates = await StateModel.find().limit(5).lean();
    console.log('\nSample states (first 5):');
    sampleStates.forEach((s, i) => {
      console.log(`\nState #${i+1}:`);
      console.log(`  Symbol: ${s.symbol}, Timeframe: ${s.timeframe}, Timestamp: ${s.timestamp.toISOString()}`);
      console.log(`  Price: ${s.price.current}, Trend: ${s.trend.direction} (ADX: ${s.trend.adx})`);
      console.log(`  RSI: ${s.momentum.rsi}, Regime: ${s.regime.code} (${s.regime.confidence}%)`);
      console.log(`  Confidence: ${s.confidence}`);
      console.log(`  Outcome5: ${s.outcome5.return !== null ? `R=${s.outcome5.returnR.toFixed(2)}, win=${s.outcome5.win}` : 'Not labelled'}`);
      console.log(`  Outcome10: ${s.outcome10.return !== null ? `R=${s.outcome10.returnR.toFixed(2)}, win=${s.outcome10.win}` : 'Not labelled'}`);
      console.log(`  Outcome20: ${s.outcome20.return !== null ? `R=${s.outcome20.returnR.toFixed(2)}, win=${s.outcome20.win}` : 'Not labelled'}`);
      console.log(`  Outcome40: ${s.outcome40.return !== null ? `R=${s.outcome40.returnR.toFixed(2)}, win=${s.outcome40.win}` : 'Not labelled'}`);
    });

    // Show one fully labelled state if exists
    const fullState = await StateModel.findOne({
      'outcome5.return': { $ne: null },
      'outcome10.return': { $ne: null },
      'outcome20.return': { $ne: null },
      'outcome40.return': { $ne: null },
    }).lean();
    if (fullState) {
      console.log('\n--- FULLY LABELLED STATE EXAMPLE ---');
      printObj(fullState, 'Full State');
    }
  }

  // ---- 3. Outcomes ----
  printHeader('OUTCOMES (HistoricalOutcome)');
  const totalOutcomes = await OutcomeModel.countDocuments();
  console.log(`Total outcomes: ${totalOutcomes}`);
  if (totalOutcomes > 0) {
    const outcomeStats = await OutcomeModel.aggregate([
      { $group: { _id: '$lookahead', count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);
    console.log('\nOutcome counts per lookahead:');
    outcomeStats.forEach(o => console.log(`  ${o._id}: ${o.count}`));

    // Sample outcomes
    const sampleOutcomes = await OutcomeModel.find().limit(5).lean();
    console.log('\nSample outcomes (first 5):');
    sampleOutcomes.forEach((o, i) => {
      console.log(`\nOutcome #${i+1}:`);
      console.log(`  Symbol: ${o.symbol}, Timeframe: ${o.timeframe}, Lookahead: ${o.lookahead}`);
      console.log(`  Start: ${o.outcome.startPrice}, End: ${o.outcome.endPrice}`);
      console.log(`  Return: ${o.outcome.return}, ReturnR: ${o.outcome.returnR.toFixed(3)}`);
      console.log(`  Win: ${o.outcome.win}, MaxDD: ${o.outcome.maxDrawdown.toFixed(3)}`);
      console.log(`  Source: ${o.source}, FilledAt: ${o.filledAt.toISOString()}`);
    });
  }

  // ---- 4. Save samples to JSON ----
  const report = {
    candles: {
      total: totalCandles,
      sample: await CandleModel.find().limit(5).lean()
    },
    states: {
      total: totalStates,
      sample: await StateModel.find().limit(5).lean(),
      stats: {
        perSymbolTimeframe: stateStats,
        labelled: { outcome5: labelled5, outcome10: labelled10, outcome20: labelled20, outcome40: labelled40, fullyLabelled }
      },
      fullyLabelledExample: fullState || null
    },
    outcomes: {
      total: totalOutcomes,
      sample: await OutcomeModel.find().limit(5).lean(),
      perLookahead: outcomeStats
    }
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2));
  console.log(`\n✅ Full inspection data saved to ${OUTPUT_FILE}`);

  // ---- Summary ----
  printHeader('SUMMARY');
  console.log(`  Candles:       ${totalCandles}`);
  console.log(`  States:        ${totalStates}`);
  console.log(`  Outcomes:      ${totalOutcomes}`);
  console.log(`  Fully labelled states: ${fullyLabelled}`);
  console.log(`  Sample files saved to: ${OUTPUT_FILE}`);

  process.exit(0);
}

inspect().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
