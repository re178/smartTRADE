// models/Trade.js
// Trade schema for tracking open and closed trades.
// EXTENDED: Added Multiplier-specific fields.

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

    // ---- NEW fields required by OTIE V5 (kept) ----
    atrAtEntry: {
      type: Number,
      default: null,
      description: 'ATR value at the time the trade was opened (used for R calculation)',
    },
    riskAmount: {
      type: Number,
      default: null,
      description: 'Risk amount in account currency (used for R calculation)',
    },
    maxFloatingProfit: {
      type: Number,
      default: 0,
      description: 'Maximum unrealized profit reached (in account currency)',
    },

    // =============================================================
    //  NEW FIELDS FOR MULTIPLIER TRADING
    // =============================================================
    // ---- Stake (amount risked) ----
    stake: {
      type: Number,
      default: null,
      description: 'Stake amount in account currency (for Multiplier trades)',
    },

    // ---- Multiplier (leverage) ----
    multiplier: {
      type: Number,
      default: null,
      description: 'Multiplier applied to the stake (for Multiplier trades)',
    },

    // ---- Duration (in seconds) ----
    duration: {
      type: Number,
      default: null,
      description: 'Duration of the Multiplier contract in seconds',
    },

    // ---- Knockout level (stop-loss price) ----
    knockoutLevel: {
      type: Number,
      default: null,
      description: 'Knockout price level (for Multiplier trades)',
    },

    // ---- Take-profit level ----
    takeProfitLevel: {
      type: Number,
      default: null,
      description: 'Take-profit price level (for Multiplier trades)',
    },

    // ---- Entry Thesis (prediction snapshot) ----
    entryThesis: {
      // Store the prediction that triggered the trade
      direction: { type: String, enum: ['up', 'down', 'neutral'], default: null },
      probability: { type: Number, default: null },
      expectedMove: { type: Number, default: null },
      expectedAdverse: { type: Number, default: null },
      regime: { type: String, default: null },
      sampleSize: { type: Number, default: null },
      timestamp: { type: Date, default: null },
    },

    // ---- Trade Economics (snapshot at entry) ----
    tradeEconomicsAtEntry: {
      expectedValue: { type: Number, default: null },
      evOverStake: { type: Number, default: null },
      probabilityOfProfit: { type: Number, default: null },
      probabilityOfLoss: { type: Number, default: null },
    },

    // ---- Thesis Monitor State ----
    thesisMonitorState: {
      // Latest evaluation from thesis monitor
      lastEvaluation: { type: Date, default: null },
      thesisValid: { type: Boolean, default: true },
      reason: { type: String, default: '' },
    },
  },
  {
    timestamps: true,
  }
);

// ---- Indexes ----
TradeSchema.index({ login: 1, status: 1 });
TradeSchema.index({ contractId: 1, status: 1 });
TradeSchema.index({ decisionId: 1 });
TradeSchema.index({ openTime: -1 });
TradeSchema.index({ closeTime: -1 });

// ---- NEW INDEXES for Multiplier fields ----
TradeSchema.index({ stake: 1, multiplier: 1 });
TradeSchema.index({ knockoutLevel: 1 });
TradeSchema.index({ 'thesisMonitorState.thesisValid': 1 });

module.exports = mongoose.model('Trade', TradeSchema);
