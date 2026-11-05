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
//   The shadow RUNNING STATE (currentGate, consecutiveShadowWins,
//   shadowSequence accumulator) lives in runner.js instance memory and
//   is discarded on bot stop — no persistence across restarts, per spec.
//   These schema fields only capture the SNAPSHOT at the moment of a
//   real fire, enabling post-hoc analysis of "which gate values won".

'use strict';

const mongoose = require('mongoose');

const BotRunSchema = new mongoose.Schema({
  botId: { type: String, required: true, index: true },
  instanceId: { type: String, required: true, index: true },
  contractId: { type: String, required: true, index: true, unique: true },
  symbol: { type: String, required: true, index: true },
  side: { type: String, required: true },              // BUY/SELL/EVEN/ODD/CALL/PUT/DIGITOVER...
  contractType: { type: String, default: null },        // MULTUP / DIGITEVEN / CALL ...
  stake: { type: Number, required: true },
  multiplier: { type: Number, default: null },
  duration: { type: Number, default: null },
  durationUnit: { type: String, default: null },        // 't' ticks, 's' seconds
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
  //
  // IMPORTANT: the running state (currentGate, consecutive counter,
  // live sequence) lives in-memory in the runner instance and is
  // discarded on bot stop — these schema fields are a POINT-IN-TIME
  // SNAPSHOT captured when the real trade fired, not the live state.

  // True when this fire passed through the shadow gate
  // (i.e., config.shadowWinsRequired > 0 at fire time).
  shadowEnabled: { type: Boolean, default: false, index: true },

  // Last ≤20 shadow outcomes observed before this fire.
  // Values: 'W' or 'L'. Capped at 20 in runner.js — the schema itself
  // doesn't enforce a length cap, so a longer array is still valid if
  // a caller ever needs to write one.
  shadowSequence: [{ type: String }],

  // Session-aggregate shadow stats snapshot at fire time:
  //   { wins: Number, losses: Number, total: Number, winRate: Number }
  // Populated only when shadowEnabled is true. Null otherwise.
  shadowStats: { type: mongoose.Schema.Types.Mixed, default: null },

  // What currentGate was when this trade fired (3, 4, 5, ...).
  // Should equal config.shadowWinsRequired + number of prior losses
  // in this session (capped at 10).
  gateAtEntry: { type: Number, default: null },

  // What config.shadowWinsRequired was at bot start.
  // Compare gateAtEntry vs originalGate to see tightening history.
  originalGate: { type: Number, default: null },

  // How many times this session's gate has been tightened via losses.
  // Starts at 0, increments by 1 per real-trade loss. Never decrements.
  gateTightenCount: { type: Number, default: 0 },
}, { timestamps: true });

BotRunSchema.index({ botId: 1, openedAt: -1 });
BotRunSchema.index({ instanceId: 1, openedAt: -1 });
BotRunSchema.index({ status: 1, openedAt: -1 });
// Compound index — every edge query hits this triple
BotRunSchema.index({ isEdgeTest: 1, botId: 1, status: 1 });
BotRunSchema.index({ isEdgeTest: 1, status: 1, openedAt: 1 });
// [FIX-SHADOW-AUDIT] Shadow-specific queries — filter by bot + shadow + time
BotRunSchema.index({ botId: 1, shadowEnabled: 1, openedAt: -1 });

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
 *
 * Useful for: "did tightening actually improve win rate?", "which gate
 * value has the best real-trade win rate?", "how selective did this bot
 * become over time?"
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
        // Aggregate shadowStats across all shadow-gated trades:
        // $ifNull guards against null (non-shadow trades shouldn't match
        // the initial $match, but defensive).
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

module.exports = mongoose.model('BotRun', BotRunSchema);
