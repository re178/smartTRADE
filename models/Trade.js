const mongoose = require('mongoose');

const TradeSchema = new mongoose.Schema(
  {
    // ---- MT5 core fields ----
    contractId: {
      type: Number,
      required: true,
      unique: true,
      index: true,
      description: 'MT5 ticket number (unique per trade)',
    },
    instrument: {
      type: String,
      required: true,
      index: true,
      description: 'Symbol, e.g., EURUSD',
    },
    side: {
      type: String,
      enum: ['buy', 'sell'],
      required: true,
      description: 'Trade direction',
    },
    lotSize: {
      type: Number,
      required: true,
      min: 0,
      description: 'Trade volume in lots',
    },
    openPrice: {
      type: Number,
      required: true,
      description: 'Price at which the trade was opened',
    },
    closePrice: {
      type: Number,
      default: null,
      description: 'Price at which the trade was closed (null if still open)',
    },
    status: {
      type: String,
      enum: ['OPEN', 'CLOSED', 'PENDING', 'CANCELLED'],
      default: 'OPEN',
      required: true,
      index: true,
      description: 'Current trade status',
    },
    openTime: {
      type: Date,
      required: true,
      description: 'Timestamp when the trade was opened',
    },
    closeTime: {
      type: Date,
      default: null,
      description: 'Timestamp when the trade was closed (null if still open)',
    },

    // ---- P&L ----
    floatingProfit: {
      type: Number,
      default: 0,
      description: 'Current unrealised profit/loss',
    },
    realizedProfit: {
      type: Number,
      default: 0,
      description: 'Final realised profit/loss after close',
    },
    pnl: {
      type: Number,
      default: 0,
      description: 'Alias for realised profit (used by orderService)',
    },

    // ---- MT5 extra fields ----
    stopLoss: {
      type: Number,
      default: 0,
    },
    takeProfit: {
      type: Number,
      default: 0,
    },
    swap: {
      type: Number,
      default: 0,
    },
    commission: {
      type: Number,
      default: 0,
    },
    margin: {
      type: Number,
      default: 0,
    },
    magic: {
      type: Number,
      default: 0,
    },
    comment: {
      type: String,
      default: '',
    },
    dealId: {
      type: Number,
      default: null,
      description: 'MT5 deal ID for the closing transaction',
    },

    // ---- Strategy & decision lineage ----
    decisionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'HistoricalDecision',
      default: null,
      index: true,
      description: 'Reference to the decision that generated this trade',
    },
    strategy: {
      type: String,
      default: null,
      description: 'Strategy name (if any)',
    },
    product: {
      type: String,
      default: 'FX',
      description: 'Product type (e.g., FX, CFD)',
    },

    // ---- Internal sync state ----
    pendingClose: {
      type: Boolean,
      default: false,
      index: true,
      description: 'True if the trade is no longer reported by MT5 but not yet closed in DB',
    },

    // ---- Account linkage ----
    login: {
      type: Number,
      index: true,
      description: 'MT5 login number for filtering',
    },

    // ---- Current price (convenience) ----
    currentPrice: {
      type: Number,
      default: null,
      description: 'Last known current price from MT5',
    },

    // ---- MAE/MFE (optional, for analytics) ----
    mae: {
      type: Number,
      default: 0,
    },
    mfe: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

// ---- Indexes for fast lookups ----
TradeSchema.index({ login: 1, status: 1 });
TradeSchema.index({ contractId: 1, status: 1 });
TradeSchema.index({ decisionId: 1 });
TradeSchema.index({ openTime: -1 });
TradeSchema.index({ closeTime: -1 });

module.exports = mongoose.model('Trade', TradeSchema);
