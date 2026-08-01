// verifyData.js – RTS Database Verification Script
// Run with: node verifyData.js

require('dotenv').config();
const mongoose = require('mongoose');

// ----- Import your models (using the same paths as your system) -----
const HistoricalState = require('./models/HistoricalState');
const HistoricalOutcome = require('./models/HistoricalOutcome');
const HistoricalDecision = require('./models/HistoricalDecision');
const LearningState = require('./models/LearningState');
const Trade = require('./models/Trade');
const Order = require('./models/Order');
const Mt5Command = require('./models/Mt5Command');
const Mt5Account = require('./models/Mt5Account');
const Mt5Position = require('./models/Mt5Position');
const Mt5Price = require('./models/Mt5Price');
const User = require('./models/User');
const ApiKey = require('./models/ApiKey');

// ----- Connect to MongoDB -----
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/rts';

async function run() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ Connected.\n');

    // ---- 1. HistoricalState ----
    console.log('📊 HISTORICAL STATE');
    const totalStates = await HistoricalState.countDocuments();
    console.log(`   Total states: ${totalStates}`);

    const perSymbol = await HistoricalState.aggregate([
      { $group: { _id: '$symbol', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    console.log('   Per symbol:');
    perSymbol.forEach(s => console.log(`     ${s._id}: ${s.count}`));

    const perTimeframe = await HistoricalState.aggregate([
      { $group: { _id: '$timeframe', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    console.log('   Per timeframe:');
    perTimeframe.forEach(t => console.log(`     ${t._id}: ${t.count}`));

    // Labelled counts (outcome5, outcome10, etc.)
    const labelled5 = await HistoricalState.countDocuments({ 'outcome5.return': { $ne: null } });
    const labelled10 = await HistoricalState.countDocuments({ 'outcome10.return': { $ne: null } });
    const labelled20 = await HistoricalState.countDocuments({ 'outcome20.return': { $ne: null } });
    const labelled40 = await HistoricalState.countDocuments({ 'outcome40.return': { $ne: null } });
    console.log(`   Labelled (outcome5): ${labelled5}`);
    console.log(`   Labelled (outcome10): ${labelled10}`);
    console.log(`   Labelled (outcome20): ${labelled20}`);
    console.log(`   Labelled (outcome40): ${labelled40}`);

    // Fully labelled (all four filled)
    const fullyLabelled = await HistoricalState.countDocuments({
      'outcome5.return': { $ne: null },
      'outcome10.return': { $ne: null },
      'outcome20.return': { $ne: null },
      'outcome40.return': { $ne: null },
    });
    console.log(`   Fully labelled (all 4): ${fullyLabelled}`);

    // ---- 2. HistoricalOutcome ----
    console.log('\n📊 HISTORICAL OUTCOME');
    const totalOutcomes = await HistoricalOutcome.countDocuments();
    console.log(`   Total outcomes: ${totalOutcomes}`);

    const perLookahead = await HistoricalOutcome.aggregate([
      { $group: { _id: '$lookahead', count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);
    console.log('   Per lookahead:');
    perLookahead.forEach(l => console.log(`     ${l._id}: ${l.count}`));

    const outcomeStats = await HistoricalOutcome.aggregate([
      {
        $group: {
          _id: null,
          avgReturnR: { $avg: '$outcome.returnR' },
          medianReturnR: { $percentile: { p: 50, key: '$outcome.returnR' } },
          totalWins: { $sum: { $cond: [{ $eq: ['$outcome.win', true] }, 1, 0] } },
          totalLosses: { $sum: { $cond: [{ $eq: ['$outcome.win', false] }, 1, 0] } },
          grossProfit: { $sum: { $cond: [{ $gt: ['$outcome.returnR', 0] }, '$outcome.returnR', 0] } },
          grossLoss: { $sum: { $cond: [{ $lt: ['$outcome.returnR', 0] }, { $abs: '$outcome.returnR' }, 0] } },
        }
      },
      {
        $project: {
          total: { $add: ['$totalWins', '$totalLosses'] },
          winRate: { $divide: ['$totalWins', { $add: ['$totalWins', '$totalLosses'] }] },
          profitFactor: { $cond: [{ $eq: ['$grossLoss', 0] }, 'Infinity', { $divide: ['$grossProfit', '$grossLoss'] }] },
          avgReturnR: 1,
          medianReturnR: 1,
        }
      }
    ]);
    if (outcomeStats.length > 0) {
      const s = outcomeStats[0];
      console.log(`   Total outcomes in stats: ${s.total}`);
      console.log(`   Win Rate: ${(s.winRate * 100).toFixed(2)}%`);
      console.log(`   Profit Factor: ${s.profitFactor}`);
      console.log(`   Avg Return (R): ${s.avgReturnR.toFixed(4)}`);
      console.log(`   Median Return (R): ${s.medianReturnR.toFixed(4)}`);
    }

    // ---- 3. HistoricalDecision ----
    console.log('\n📊 HISTORICAL DECISION');
    const totalDecisions = await HistoricalDecision.countDocuments();
    console.log(`   Total decisions: ${totalDecisions}`);

    const executed = await HistoricalDecision.countDocuments({ 'outcome.executed': true });
    console.log(`   Executed trades: ${executed}`);

    const decisionOutcomeStats = await HistoricalDecision.aggregate([
      { $match: { 'outcome.executed': true, 'outcome.returnR': { $ne: null } } },
      {
        $group: {
          _id: null,
          totalWins: { $sum: { $cond: [{ $eq: ['$outcome.win', true] }, 1, 0] } },
          totalLosses: { $sum: { $cond: [{ $eq: ['$outcome.win', false] }, 1, 0] } },
          avgReturnR: { $avg: '$outcome.returnR' },
        }
      },
      {
        $project: {
          total: { $add: ['$totalWins', '$totalLosses'] },
          winRate: { $divide: ['$totalWins', { $add: ['$totalWins', '$totalLosses'] }] },
          avgReturnR: 1,
        }
      }
    ]);
    if (decisionOutcomeStats.length > 0) {
      const d = decisionOutcomeStats[0];
      console.log(`   Decisions with outcome: ${d.total}`);
      console.log(`   Win Rate: ${(d.winRate * 100).toFixed(2)}%`);
      console.log(`   Avg Return (R): ${d.avgReturnR.toFixed(4)}`);
    }

    // ---- 4. LearningState ----
    console.log('\n📊 LEARNING STATE');
    const learningCount = await LearningState.countDocuments();
    console.log(`   Total strategies: ${learningCount}`);
    const strategies = await LearningState.find().lean();
    strategies.forEach(s => {
      console.log(`     ${s.strategy}: weight=${s.weight.toFixed(4)}, bias=${s.bias.toFixed(2)}, trades=${s.totalTrades}, winRate=${(s.winRate*100).toFixed(1)}%`);
    });

    // ---- 5. Trades ----
    console.log('\n📊 TRADES');
    const totalTrades = await Trade.countDocuments();
    console.log(`   Total trades: ${totalTrades}`);
    const openTrades = await Trade.countDocuments({ status: 'OPEN' });
    const closedTrades = await Trade.countDocuments({ status: 'CLOSED' });
    console.log(`   Open: ${openTrades}`);
    console.log(`   Closed: ${closedTrades}`);

    // ---- 6. Orders ----
    console.log('\n📊 ORDERS');
    const totalOrders = await Order.countDocuments();
    console.log(`   Total orders: ${totalOrders}`);
    const pendingOrders = await Order.countDocuments({ status: { $in: ['PENDING', 'ACCEPTED', 'EXECUTING'] } });
    console.log(`   Pending: ${pendingOrders}`);

    // ---- 7. MT5 collections ----
    console.log('\n📊 MT5 DATA');
    const mt5Accounts = await Mt5Account.countDocuments();
    console.log(`   Mt5Account: ${mt5Accounts}`);
    const mt5Positions = await Mt5Position.countDocuments();
    console.log(`   Mt5Position: ${mt5Positions}`);
    const mt5Prices = await Mt5Price.countDocuments();
    console.log(`   Mt5Price: ${mt5Prices}`);
    const mt5Commands = await Mt5Command.countDocuments();
    console.log(`   Mt5Command: ${mt5Commands}`);
    const mt5Heartbeats = await Mt5Heartbeat?.countDocuments() || 0;
    console.log(`   Mt5Heartbeat: ${mt5Heartbeats}`);

    // ---- 8. Users & API Keys ----
    console.log('\n📊 USERS & API KEYS');
    const users = await User.countDocuments();
    console.log(`   Users: ${users}`);
    const apiKeys = await ApiKey.countDocuments();
    console.log(`   ApiKey: ${apiKeys}`);

    console.log('\n✅ Verification complete.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

run();
