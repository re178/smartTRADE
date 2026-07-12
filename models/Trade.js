// models/Trade.js – Mongoose Schema for Trade Records

const mongoose = require('mongoose');

const TradeSchema = new mongoose.Schema(
  {
    // Instrument traded (e.g., "EUR_USD")
    pair: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },

    // Trade direction: BUY or SELL
    side: {
      type: String,
      enum: ['BUY', 'SELL'],
      required: true,
    },

    // Entry price (executed price)
    entryPrice: {
      type: Number,
      required: true,
    },

    // Stop Loss level (optional)
    stopLoss: {
      type: Number,
      default: null,
    },

    // Take Profit level (optional)
    takeProfit: {
      type: Number,
      default: null,
    },

    // Lot size (units)
    lotSize: {
      type: Number,
      required: true,
      min: 0.001,
    },

    // Trade status: OPEN, CLOSED, PENDING, CANCELLED
    status: {
      type: String,
      enum: ['OPEN', 'CLOSED', 'PENDING', 'CANCELLED'],
      default: 'OPEN',
    },

    // When the trade was opened
    openTime: {
      type: Date,
      default: Date.now,
    },

    // When the trade was closed (if closed)
    closeTime: {
      type: Date,
      default: null,
    },

    // Price at which the trade was closed
    closePrice: {
      type: Number,
      default: null,
    },

    // Profit / Loss in account currency
    pnl: {
      type: Number,
      default: 0,
    },

    // OANDA trade ID (for reference)
    oandaTradeId: {
      type: String,
      default: null,
    },

    // OANDA order ID (for reference)
    oandaOrderId: {
      type: String,
      default: null,
    },

    // Additional notes (e.g., "Auto-trade from strategy")
    notes: {
      type: String,
      default: '',
    },

    // Broker name (for multi-broker support)
    broker: {
      type: String,
      default: 'OANDA',
    },

    // Strategy that generated this trade (for analytics later)
    strategy: {
      type: String,
      default: 'MA_Crossover',
    },
  },
  {
    timestamps: true, // Automatically adds createdAt and updatedAt
  }
);

// Index for faster queries
TradeSchema.index({ pair: 1, status: 1 });
TradeSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Trade', TradeSchema);
