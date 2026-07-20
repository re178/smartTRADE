const mongoose = require('mongoose');

const TradeSchema = new mongoose.Schema(
  {
    pair: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },
    side: {
      type: String,
      enum: ['BUY', 'SELL'],
      required: true,
    },
    entryPrice: {
      type: Number,
      required: true,
    },
    stopLoss: {
      type: Number,
      default: null,
    },
    takeProfit: {
      type: Number,
      default: null,
    },
    lotSize: {
      type: Number,
      required: true,
      min: 0.001,
    },
    status: {
      type: String,
      enum: ['OPEN', 'CLOSED', 'PENDING', 'CANCELLED'],
      default: 'OPEN',
    },
    openTime: {
      type: Date,
      default: Date.now,
    },
    closeTime: {
      type: Date,
      default: null,
    },
    closePrice: {
      type: Number,
      default: null,
    },
    pnl: {
      type: Number,
      default: 0,
    },
    // ---- GENERIC BROKER TRADE ID (used for both MT5 and Deriv) ----
    brokerTradeId: {
      type: String,
      default: null,
    },
    // ---- KEEP for backward compatibility (or remove) ----
    // but we will use brokerTradeId everywhere
    // We'll keep oandaTradeId as an alias for compatibility with existing code
    oandaTradeId: {
      type: String,
      default: null,
    },
    notes: {
      type: String,
      default: '',
    },
    broker: {
      type: String,
      default: 'MT5',
    },
    strategy: {
      type: String,
      default: 'MA_Crossover',
    },
    product: {
      type: String,
      default: 'mt5',
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
TradeSchema.index({ pair: 1, status: 1 });
TradeSchema.index({ brokerTradeId: 1 });
TradeSchema.index({ oandaTradeId: 1 }); // for backward compatibility
TradeSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Trade', TradeSchema);
