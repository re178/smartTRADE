// models/BotRun.js
// Every bot entry produces one BotRun doc. It is the receipt for that run.
// Tracked fields: entry, exit, pnl, result, reasons, timestamps.
// Edge-test fields: isEdgeTest, regimeCode, session, entryThesis —
// populated by runner.js when config._edgeTest === true, consumed by
// edgeTest.js for statistical edge validation and CSV export.
//
// [FIX-SHADOW-AUDIT] Shadow-trading audit fields:
//   • shadowEnabled       — true when bot instance is in shadow mode
//   • shadowSequence      — last ≤20 shadow-phase outcomes ('W'/'L')
//   • shadowStats         — { wins, losses, total, winRate } at entry
//   • gateAtEntry         — currentGate value at fire time
//   • originalGate        — config.shadowWinsRequired at bot start
//   • gateTightenCount    — number of real losses that tightened the gate
//   • shadowSummaryFor()  — aggregate shadow-win analysis per bot
//
// [FIX-HIGH-PAYOUT] High-payout contract metadata:
//   • payoutPerPoint, growthRate, strikePrice, touchBarrier, touchDirection
//   • highPayoutSummaryFor() — aggregate stats across the 4 new bots
//
// [FIX-SHADOW-PHASE] **Real-shadow gated mode.**
//
//   Previously gated shadow mode reconstructed the shadow outcome from tick
//   data (entry price at tick N, exit at tick N+duration). Reconstruction
//   had 5-15% error because:
//     • Shadow entry was recorded at tick N (bot's decision tick)
//     • Real Deriv trade entered at tick N+2 (network + acceptance lag)
//     • Different windows → different outcomes in fast markets
//     • Digit contracts especially: outcome depends on the digit AT the
//       exit tick, not on prices — different exit ticks = different digits
//
//   The fix: shadow-phase trades are now REAL contracts at shadowStake
//   (default $0.35). Each is a genuine Deriv trade with a genuine
//   settlement. Outcome is 100% accurate because it IS the real trade.
//
//   This field (`shadowPhase`) tags each BotRun so downstream analysis can
//   distinguish:
//     • shadowPhase=true  → validation trade at shadowStake
//     • shadowPhase=false → real signal execution at normal stake
//
//   Behaviour:
//     • Both types count in stats.pnl (real money spent)
//     • Only shadowPhase=true advances the shadow gate counter
//     • Only shadowPhase=false advances compound stake
//     • Both types visible in Recent Runs (tagged for filtering)

'use strict';

const mongoose = require('mongoose');

const BotRunSchema = new mongoose.Schema({
  botId: { type: String, required: true, index: true },
  instanceId: { type: String, required: true, index: true },
  contractId: { type: String, required: true, index: true, unique: true },
  symbol: { type: String, required: true, index: true },
  side: { type: String, required: true },
  contractType: { type: String, default: null },
  stake: { type: Number, required: true },
  multiplier: { type: Number, default: null },
  duration: { type: Number, default: null },
  durationUnit: { type: String, default: null },
  barrier: { type: String, default: null },
  entryPrice: { type: Number, default: null },
  closePrice: { type: Number, default: null },
  takeProfitLevel: { type: Number, default: null },
  knockoutLevel: { type: Number, default: null },
  reasons: [{ type: String }],
  openedAt: { type: Date, default: Date.now, index: true },
  closedAt: { type: Date, default: null, index: true },
  pnl: { type: Number, default: 0 },
  realizedProfit: { type: Number, default: 0 },
  result: { type: String, enum: ['WIN', 'LOSS', 'BREAKEVEN', null], default: null },
  status: { type: String, enum: ['OPEN', 'CLOSED'], default: 'OPEN', index: true },

  // ── Edge-test metadata ──
  isEdgeTest: { type: Boolean, default: false, index: true },
  regimeCode: { type: String, default: null, index: true },
  session:    { type: String, default: null, index: true },
  entryThesis: { type: mongoose.Schema.Types.Mixed, default: null },

  // ── Shadow metadata ──
  shadowEnabled: { type: Boolean, default: false, index: true },
  shadowSequence: [{ type: String }],
  shadowStats: { type: mongoose.Schema.Types.Mixed, default: null },
  gateAtEntry: { type: Number, default: null },
  originalGate: { type: Number, default: null },
  gateTightenCount: { type: Number, default: 0 },

  // [FIX-SHADOW-PHASE] Tags this specific trade as a shadow-phase
  // validation trade (true) or a real signal execution (false).
  // Only true when shadow mode is 'gated' AND gate not yet met at fire
  // time. In observational mode this is always false (shadow stats are
  // derived from real trade result — no separate shadow trades placed).
  shadowPhase: { type: Boolean, default: false, index: true },

  // ── High-payout metadata ──
  payoutPerPoint: { type: Number, default: null },
  growthRate: { type: Number, default: null },
  strikePrice: { type: Number, default: null },
  touchBarrier: { type: Number, default: null },
  touchDirection: { type: String, enum: ['TOUCH', 'NO_TOUCH', null], default: null },
}, { timestamps: true });

BotRunSchema.index({ botId: 1, openedAt: -1 });
BotRunSchema.index({ instanceId: 1, openedAt: -1 });
BotRunSchema.index({ status: 1, openedAt: -1 });
BotRunSchema.index({ isEdgeTest: 1, botId: 1, status: 1 });
BotRunSchema.index({ isEdgeTest: 1, status: 1, openedAt: 1 });
BotRunSchema.index({ botId: 1, shadowEnabled: 1, openedAt: -1 });
BotRunSchema.index({ contractType: 1, openedAt: -1 });
// [FIX-SHADOW-PHASE] Filter shadow-phase vs real trades per bot
BotRunSchema.index({ botId: 1, shadowPhase: 1, openedAt: -1 });

/**
 * Aggregate stats for one bot (optionally since a date).
 * Returns: { trades, wins, losses, totalPnL, avgPnL, winRate, profitFactor }
 *
 * NOTE: This counts ALL trades (shadow-phase + real). For shadow-specific
 * or real-specific breakdowns, use shadowSummaryFor or realTradesFor.
 */
BotRunSchema.statics.statsFor = async function (botId, since = null) {
  const match = { botId };
  if (since) match.openedAt = { $gte: since };

  const result = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        trades: { $sum: 1 },
        wins: { $sum: { $cond: [{ $eq: ['$result', 'WIN'] }, 1, 0] } },
        losses: { $sum: { $cond: [{ $eq: ['$result', 'LOSS'] }, 1, 0] } },
        totalPnL: { $sum: '$pnl' },
        grossWin: { $sum: { $cond: [{ $gt: ['$pnl', 0] }, '$pnl', 0] } },
        grossLoss: { $sum: { $cond: [{ $lt: ['$pnl', 0] }, { $abs: '$pnl' }, 0] } },
      },
    },
  ]);

  const r = result[0] || { trades: 0, wins: 0, losses: 0, totalPnL: 0, grossWin: 0, grossLoss: 0 };
  return {
    trades: r.trades,
    wins: r.wins,
    losses: r.losses,
    totalPnL: Number(r.totalPnL.toFixed(2)),
    avgPnL: r.trades > 0 ? Number((r.totalPnL / r.trades).toFixed(2)) : 0,
    winRate: r.trades > 0 ? Number((r.wins / r.trades).toFixed(3)) : 0,
    profitFactor: r.grossLoss > 0
      ? Number((r.grossWin / r.grossLoss).toFixed(2))
      : (r.grossWin > 0 ? Infinity : 0),
  };
};

/**
 * Shadow-trading performance for one bot. Counts only shadow-phase trades.
 * Returns: { trades, wins, losses, winRate, avgGateAtEntry, totalTightens,
 *            totalShadowWins, totalShadowLosses, shadowWinRate }
 */
BotRunSchema.statics.shadowSummaryFor = async function (botId, since = null) {
  const match = { botId, shadowEnabled: true };
  if (since) match.openedAt = { $gte: since };

  const result = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        trades: { $sum: 1 },
        wins: { $sum: { $cond: [{ $eq: ['$result', 'WIN'] }, 1, 0] } },
        losses: { $sum: { $cond: [{ $eq: ['$result', 'LOSS'] }, 1, 0] } },
        avgGateAtEntry: { $avg: '$gateAtEntry' },
        minGateAtEntry: { $min: '$gateAtEntry' },
        maxGateAtEntry: { $max: '$gateAtEntry' },
        totalShadowWins:   { $sum: { $ifNull: ['$shadowStats.wins', 0] } },
        totalShadowLosses: { $sum: { $ifNull: ['$shadowStats.losses', 0] } },
        totalTightens:     { $sum: { $ifNull: ['$gateTightenCount', 0] } },
      },
    },
  ]);

  const r = result[0] || {
    trades: 0, wins: 0, losses: 0,
    avgGateAtEntry: null, minGateAtEntry: null, maxGateAtEntry: null,
    totalShadowWins: 0, totalShadowLosses: 0, totalTightens: 0,
  };

  const shadowTotal = (r.totalShadowWins || 0) + (r.totalShadowLosses || 0);

  return {
    trades: r.trades,
    wins: r.wins,
    losses: r.losses,
    winRate: r.trades > 0 ? Number((r.wins / r.trades).toFixed(3)) : 0,
    avgGateAtEntry: r.avgGateAtEntry != null ? Number(Number(r.avgGateAtEntry).toFixed(2)) : null,
    minGateAtEntry: r.minGateAtEntry != null ? Number(r.minGateAtEntry) : null,
    maxGateAtEntry: r.maxGateAtEntry != null ? Number(r.maxGateAtEntry) : null,
    shadowWins: r.totalShadowWins || 0,
    shadowLosses: r.totalShadowLosses || 0,
    shadowWinRate: shadowTotal > 0
      ? Number(((r.totalShadowWins || 0) / shadowTotal).toFixed(3))
      : 0,
    totalTightens: r.totalTightens || 0,
    totalTradesEverShadowed: r.trades,
  };
};

/**
 * [FIX-SHADOW-PHASE] Real (non-shadow-phase) trade performance for one bot.
 * Returns: { trades, wins, losses, winRate, totalPnL, avgPnL,
 *            shadowPhaseTrades, shadowPhasePnL }
 *
 * The `shadowPhaseTrades` and `shadowPhasePnL` fields are informational —
 * they show how many validation trades happened and how much they cost.
 */
BotRunSchema.statics.realTradesFor = async function (botId, since = null) {
  const match = { botId };
  if (since) match.openedAt = { $gte: since };

  const result = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$shadowPhase',
        trades: { $sum: 1 },
        wins: { $sum: { $cond: [{ $eq: ['$result', 'WIN'] }, 1, 0] } },
        losses: { $sum: { $cond: [{ $eq: ['$result', 'LOSS'] }, 1, 0] } },
        totalPnL: { $sum: '$pnl' },
      },
    },
  ]);

  const realBucket = result.find(r => r._id === false) || { trades: 0, wins: 0, losses: 0, totalPnL: 0 };
  const shadowBucket = result.find(r => r._id === true) || { trades: 0, wins: 0, losses: 0, totalPnL: 0 };

  return {
    trades: realBucket.trades,
    wins: realBucket.wins,
    losses: realBucket.losses,
    winRate: realBucket.trades > 0 ? Number((realBucket.wins / realBucket.trades).toFixed(3)) : 0,
    totalPnL: Number((realBucket.totalPnL || 0).toFixed(2)),
    avgPnL: realBucket.trades > 0 ? Number(((realBucket.totalPnL || 0) / realBucket.trades).toFixed(2)) : 0,
    shadowPhaseTrades: shadowBucket.trades,
    shadowPhaseWins: shadowBucket.wins,
    shadowPhaseLosses: shadowBucket.losses,
    shadowPhasePnL: Number((shadowBucket.totalPnL || 0).toFixed(2)),
  };
};

/**
 * High-payout bot performance. Filters by contractType.
 */
BotRunSchema.statics.highPayoutSummaryFor = async function (botId, since = null) {
  const HIGH_PAYOUT_TYPES = [
    'ONETOUCH', 'NOTOUCH',
    'VANILLALONGCALL', 'VANILLALONGPUT',
    'TURBOSLONG', 'TURBOSSHORT',
    'ACCU',
  ];
  const match = { contractType: { $in: HIGH_PAYOUT_TYPES } };
  if (botId) match.botId = botId;
  if (since) match.openedAt = { $gte: since };

  const result = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        trades: { $sum: 1 },
        wins: { $sum: { $cond: [{ $eq: ['$result', 'WIN'] }, 1, 0] } },
        losses: { $sum: { $cond: [{ $eq: ['$result', 'LOSS'] }, 1, 0] } },
        totalPnL: { $sum: '$pnl' },
        grossWin: { $sum: { $cond: [{ $gt: ['$pnl', 0] }, '$pnl', 0] } },
        grossLoss: { $sum: { $cond: [{ $lt: ['$pnl', 0] }, { $abs: '$pnl' }, 0] } },
        avgStake: { $avg: '$stake' },
        avgPayoutPerPoint: { $avg: '$payoutPerPoint' },
        avgGrowthRate: { $avg: '$growthRate' },

        touchTrades: { $sum: { $cond: [{ $in: ['$contractType', ['ONETOUCH', 'NOTOUCH']] }, 1, 0] } },
        touchWins: { $sum: { $cond: [{ $and: [
          { $in: ['$contractType', ['ONETOUCH', 'NOTOUCH']] },
          { $eq: ['$result', 'WIN'] },
        ] }, 1, 0] } },

        vanillaTrades: { $sum: { $cond: [{ $in: ['$contractType', ['VANILLALONGCALL', 'VANILLALONGPUT']] }, 1, 0] } },
        vanillaWins: { $sum: { $cond: [{ $and: [
          { $in: ['$contractType', ['VANILLALONGCALL', 'VANILLALONGPUT']] },
          { $eq: ['$result', 'WIN'] },
        ] }, 1, 0] } },

        turboTrades: { $sum: { $cond: [{ $in: ['$contractType', ['TURBOSLONG', 'TURBOSSHORT']] }, 1, 0] } },
        turboWins: { $sum: { $cond: [{ $and: [
          { $in: ['$contractType', ['TURBOSLONG', 'TURBOSSHORT']] },
          { $eq: ['$result', 'WIN'] },
        ] }, 1, 0] } },

        accumulatorTrades: { $sum: { $cond: [{ $eq: ['$contractType', 'ACCU'] }, 1, 0] } },
        accumulatorWins: { $sum: { $cond: [{ $and: [
          { $eq: ['$contractType', 'ACCU'] },
          { $eq: ['$result', 'WIN'] },
        ] }, 1, 0] } },
      },
    },
  ]);

  const r = result[0] || {};
  const safeRate = (wins, trades) => trades > 0 ? Number(((wins || 0) / trades).toFixed(3)) : 0;

  return {
    trades: r.trades || 0,
    wins: r.wins || 0,
    losses: r.losses || 0,
    winRate: safeRate(r.wins, r.trades),
    totalPnL: Number((r.totalPnL || 0).toFixed(2)),
    avgPnL: r.trades > 0 ? Number(((r.totalPnL || 0) / r.trades).toFixed(2)) : 0,
    profitFactor: r.grossLoss > 0
      ? Number(((r.grossWin || 0) / r.grossLoss).toFixed(2))
      : ((r.grossWin || 0) > 0 ? Infinity : 0),
    avgStake: r.avgStake != null ? Number(Number(r.avgStake).toFixed(2)) : 0,
    avgPayoutPerPoint: r.avgPayoutPerPoint != null ? Number(Number(r.avgPayoutPerPoint).toFixed(4)) : null,
    avgGrowthRate: r.avgGrowthRate != null ? Number(Number(r.avgGrowthRate).toFixed(2)) : null,

    touchTrades: r.touchTrades || 0,
    touchWins: r.touchWins || 0,
    touchWinRate: safeRate(r.touchWins, r.touchTrades),

    vanillaTrades: r.vanillaTrades || 0,
    vanillaWins: r.vanillaWins || 0,
    vanillaWinRate: safeRate(r.vanillaWins, r.vanillaTrades),

    turboTrades: r.turboTrades || 0,
    turboWins: r.turboWins || 0,
    turboWinRate: safeRate(r.turboWins, r.turboTrades),

    accumulatorTrades: r.accumulatorTrades || 0,
    accumulatorWins: r.accumulatorWins || 0,
    accumulatorWinRate: safeRate(r.accumulatorWins, r.accumulatorTrades),
  };
};

module.exports = mongoose.model('BotRun', BotRunSchema);
