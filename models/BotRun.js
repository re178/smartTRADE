// models/BotRun.js
// Every bot entry produces one BotRun doc. It is the receipt for that run.
// Tracked fields: entry, exit, pnl, result, reasons, timestamps.
// Edge-test fields: isEdgeTest, regimeCode, session, entryThesis —
// populated by runner.js when config._edgeTest === true, consumed by
// edgeTest.js for statistical edge validation and CSV export.
//
// [FIX-SHADOW-AUDIT] Shadow-trading audit fields added:
//   • shadowEnabled       — true when shadow gate was applied to this fire
//   • shadowSequence      — last ≤20 shadow outcomes ('W'/'L') at entry
//   • shadowStats         — { wins, losses, total, winRate } at entry
//   • gateAtEntry         — currentGate value when trade fired (3, 4, 5...)
//   • originalGate        — config.shadowWinsRequired at bot start
//   • gateTightenCount    — number of losses that tightened the gate
//   • shadowSummaryFor()  — aggregate shadow-win analysis per bot
//
// [FIX-HIGH-PAYOUT] New-contract-type metadata added:
//   • payoutPerPoint      — Turbo: $ per point of distance from barrier
//   • growthRate          — Accumulator: % growth per tick (1–5)
//   • strikePrice         — Vanilla/Turbo: the strike at entry
//   • touchBarrier        — Touch/No Touch: the barrier price at entry
//   • touchDirection      — Touch/No Touch: 'TOUCH' or 'NO_TOUCH'
//   • highPayoutSummaryFor() — aggregate stats across the 4 new bot types
//
//   These fields are null for the 17 existing bot types. The 4 new bots
//   (touch_hunter, vanilla_trend, turbo_breakout, accumulator_scalper)
//   populate them so post-hoc analysis can compare:
//     • "which barrier distance produced the best ROI?"
//     • "at what growth_rate did accumulators survive the longest?"
//     • "did strike placement matter for vanilla/turbo outcomes?"

'use strict';

const mongoose = require('mongoose');

const BotRunSchema = new mongoose.Schema({
  botId: { type: String, required: true, index: true },
  instanceId: { type: String, required: true, index: true },
  contractId: { type: String, required: true, index: true, unique: true },
  symbol: { type: String, required: true, index: true },
  side: { type: String, required: true },              // BUY/SELL/EVEN/ODD/CALL/PUT/DIGITOVER...
  contractType: { type: String, default: null },        // MULTUP / DIGITEVEN / CALL / ONETOUCH / VANILLALONGCALL / TURBOSLONG / ACCU
  stake: { type: Number, required: true },
  multiplier: { type: Number, default: null },
  duration: { type: Number, default: null },
  durationUnit: { type: String, default: null },        // 't' ticks, 's' seconds, 'm' minutes, 'h' hours
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

  // ── Edge-test metadata ─────────────────────────────────────────
  // Populated when bot was started via edgeTest.start() (config._edgeTest = true)
  isEdgeTest: { type: Boolean, default: false, index: true },
  regimeCode: { type: String, default: null, index: true },
  session:    { type: String, default: null, index: true },
  // Full prediction / digitView snapshot at entry — populated for
  // every trade (edge test or normal), so post-hoc analysis can
  // correlate conditions with outcome.
  entryThesis: { type: mongoose.Schema.Types.Mixed, default: null },

  // ── [FIX-SHADOW-AUDIT] Shadow-trading metadata ─────────────────
  // Applied only to Rise/Fall and Volatility bots when
  // config.shadowWinsRequired > 0. Digit and FX bots always have
  // shadowEnabled=false and all other shadow fields null/empty.
  shadowEnabled: { type: Boolean, default: false, index: true },
  shadowSequence: [{ type: String }],
  shadowStats: { type: mongoose.Schema.Types.Mixed, default: null },
  gateAtEntry: { type: Number, default: null },
  originalGate: { type: Number, default: null },
  gateTightenCount: { type: Number, default: 0 },

  // ── [FIX-HIGH-PAYOUT] High-payout contract metadata ────────────
  // Populated only by the 4 new bots. Null for all 17 existing bots.

  // Turbo contracts: payout per point of distance from barrier.
  // e.g. 0.5 = $0.50 profit per point above strike (for TURBOSLONG).
  payoutPerPoint: { type: Number, default: null },

  // Accumulator contracts: % growth per tick (1–5).
  // e.g. 5 = 5% stake growth per tick that stays in range.
  growthRate: { type: Number, default: null },

  // Vanilla/Turbo: strike price at entry. Stored as number so we can
  // compute "distance from strike" post-hoc.
  strikePrice: { type: Number, default: null },

  // Touch/No Touch: the barrier price at entry. Different from
  // `strikePrice` because touch contracts use a specific barrier value,
  // not a strike. Stored separately for clarity.
  touchBarrier: { type: Number, default: null },

  // Touch/No Touch: which side of the bet it was.
  // 'TOUCH'    — predict price WILL touch the barrier
  // 'NO_TOUCH' — predict price will NOT touch the barrier
  touchDirection: { type: String, enum: ['TOUCH', 'NO_TOUCH', null], default: null },
}, { timestamps: true });

BotRunSchema.index({ botId: 1, openedAt: -1 });
BotRunSchema.index({ instanceId: 1, openedAt: -1 });
BotRunSchema.index({ status: 1, openedAt: -1 });
// Compound index — every edge query hits this triple
BotRunSchema.index({ isEdgeTest: 1, botId: 1, status: 1 });
BotRunSchema.index({ isEdgeTest: 1, status: 1, openedAt: 1 });
// [FIX-SHADOW-AUDIT] Shadow-specific queries — filter by bot + shadow + time
BotRunSchema.index({ botId: 1, shadowEnabled: 1, openedAt: -1 });
// [FIX-HIGH-PAYOUT] High-payout bot queries — filter by contract type + time
BotRunSchema.index({ contractType: 1, openedAt: -1 });

/**
 * Aggregate stats for one bot (optionally since a date).
 * Returns: { trades, wins, losses, totalPnL, avgPnL, winRate, profitFactor }
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
 * [FIX-SHADOW-AUDIT] Aggregate shadow-trading performance for one bot.
 *
 * Only counts trades where shadowEnabled=true (Rise/Fall + Volatility
 * bots with shadowWinsRequired > 0). Digit and FX bots are excluded.
 *
 * Returns:
 *   {
 *     trades, wins, losses, winRate,       — real-trade outcomes
 *     avgGateAtEntry,                      — average gate value when firing
 *     minGateAtEntry, maxGateAtEntry,      — gate range this session span
 *     shadowWins, shadowLosses, shadowWinRate,  — total shadows observed
 *     totalTightens,                       — total loss-tightens applied
 *     totalTradesEverShadowed,             — same as `trades`, for clarity
 *   }
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
 * [FIX-HIGH-PAYOUT] Aggregate performance for the 4 high-payout bots.
 *
 * Filters by contractType ∈ {ONETOUCH, NOTOUCH, VANILLALONGCALL,
 * VANILLALONGPUT, TURBOSLONG, TURBOSSHORT, ACCU}.
 *
 * Returns:
 *   {
 *     trades, wins, losses, winRate,
 *     totalPnL, avgPnL, profitFactor,
 *     avgStake, avgBarrierDistancePct,      — how far was the barrier?
 *     avgPayoutPerPoint,                    — Turbo only
 *     avgGrowthRate,                        — Accumulator only
 *     touchWinRate, touchTrades,            — Touch/No Touch subset
 *     vanillaWinRate, vanillaTrades,        — Vanilla subset
 *     turboWinRate, turboTrades,            — Turbo subset
 *     accumulatorWinRate, accumulatorTrades — Accumulator subset
 *   }
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

        // Touch/No Touch subset
        touchTrades: {
          $sum: { $cond: [{ $in: ['$contractType', ['ONETOUCH', 'NOTOUCH']] }, 1, 0] },
        },
        touchWins: {
          $sum: {
            $cond: [
              { $and: [
                { $in: ['$contractType', ['ONETOUCH', 'NOTOUCH']] },
                { $eq: ['$result', 'WIN'] },
              ] },
              1, 0,
            ],
          },
        },

        // Vanilla subset
        vanillaTrades: {
          $sum: { $cond: [{ $in: ['$contractType', ['VANILLALONGCALL', 'VANILLALONGPUT']] }, 1, 0] },
        },
        vanillaWins: {
          $sum: {
            $cond: [
              { $and: [
                { $in: ['$contractType', ['VANILLALONGCALL', 'VANILLALONGPUT']] },
                { $eq: ['$result', 'WIN'] },
              ] },
              1, 0,
            ],
          },
        },

        // Turbo subset
        turboTrades: {
          $sum: { $cond: [{ $in: ['$contractType', ['TURBOSLONG', 'TURBOSSHORT']] }, 1, 0] },
        },
        turboWins: {
          $sum: {
            $cond: [
              { $and: [
                { $in: ['$contractType', ['TURBOSLONG', 'TURBOSSHORT']] },
                { $eq: ['$result', 'WIN'] },
              ] },
              1, 0,
            ],
          },
        },

        // Accumulator subset
        accumulatorTrades: {
          $sum: { $cond: [{ $eq: ['$contractType', 'ACCU'] }, 1, 0] },
        },
        accumulatorWins: {
          $sum: {
            $cond: [
              { $and: [
                { $eq: ['$contractType', 'ACCU'] },
                { $eq: ['$result', 'WIN'] },
              ] },
              1, 0,
            ],
          },
        },
      },
    },
  ]);

  const r = result[0] || {};

  const safeRate = (wins, trades) =>
    trades > 0 ? Number(((wins || 0) / trades).toFixed(3)) : 0;

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
