// models/Order.js – Order Schema (for persistence)
// EXTENDED: Added Multiplier fields and proposal tracking.

const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema(
  {
    // ---- Core identifiers ----
    clientOrderId: { type: String, required: true, unique: true },
    instrument: { type: String, required: true },
    side: { type: String, enum: ['BUY', 'SELL'], required: true },

    // ---- Legacy fields (kept) ----
    units: { type: Number, required: true },
    entryPrice: { type: Number, default: null },
    stopLoss: { type: Number, default: null },
    takeProfit: { type: Number, default: null },

    // ---- Status ----
    status: {
      type: String,
      enum: ['PENDING', 'ACCEPTED', 'EXECUTING', 'FILLED', 'REJECTED', 'CANCELLED', 'CLOSED'],
      default: 'PENDING',
    },
    contractId: { type: String, default: null },
    broker: { type: String, default: 'deriv' },

    // ---- Timestamps ----
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    filledAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    rejectReason: { type: String, default: null },

    // ---- Metadata ----
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

    // =============================================================
    //  NEW FIELDS FOR MULTIPLIER TRADING
    // =============================================================
    // ---- Multiplier parameters ----
    stake: {
      type: Number,
      default: null,
      description: 'Amount risked (stake) in account currency',
    },
    multiplier: {
      type: Number,
      default: null,
      description: 'Multiplier (leverage) applied to the trade',
    },
    duration: {
      type: Number,
      default: null,
      description: 'Trade duration in seconds',
    },

    // ---- Price levels ----
    knockoutLevel: {
      type: Number,
      default: null,
      description: 'Knockout/stop-loss price level',
    },
    takeProfitLevel: {
      type: Number,
      default: null,
      description: 'Take-profit price level',
    },

    // ---- Proposal tracking (for proposal‑first execution) ----
    proposalId: {
      type: String,
      default: null,
      description: 'Deriv proposal ID from the proposal request',
    },
    proposalPrice: {
      type: Number,
      default: null,
      description: 'Price returned in the proposal',
    },
    proposalDetails: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      description: 'Full proposal response (for audit/debugging)',
    },
  },
  { timestamps: true }
);

// ---- Indexes ----
OrderSchema.index({ clientOrderId: 1 });
OrderSchema.index({ status: 1 });
OrderSchema.index({ contractId: 1 });
OrderSchema.index({ proposalId: 1 });
OrderSchema.index({ stake: 1, multiplier: 1 });
OrderSchema.index({ duration: 1 });
OrderSchema.index({ knockoutLevel: 1, takeProfitLevel: 1 });

module.exports = mongoose.model('Order', OrderSchema);
