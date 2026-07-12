const mongoose = require('mongoose');

const TradeSchema = new mongoose.Schema(
  {
    pair: { type: String, required: true },
    side: { type: String, enum: ['BUY', 'SELL'], required: true },
    entryPrice: { type: Number, required: true },
    stopLoss: { type: Number },
    takeProfit: { type: Number },
    lotSize: { type: Number, required: true },
    status: { type: String, enum: ['OPEN', 'CLOSED', 'PENDING'], default: 'OPEN' },
    openTime: { type: Date, default: Date.now },
    closeTime: { type: Date },
    closePrice: { type: Number },
    pnl: { type: Number, default: 0 },
    oandaTradeId: { type: String },
    oandaOrderId: { type: String },
    notes: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Trade', TradeSchema);
