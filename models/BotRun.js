// models/BotRun.js
// Every bot entry produces one BotRun doc. It is the receipt for that run.
// Tracked fields: entry, exit, pnl, result, reasons, timestamps.

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
}, { timestamps: true });

BotRunSchema.index({ botId: 1, openedAt: -1 });
BotRunSchema.index({ instanceId: 1, openedAt: -1 });
BotRunSchema.index({ status: 1, openedAt: -1 });

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

module.exports = mongoose.model('BotRun', BotRunSchema);
