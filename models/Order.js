// models/Order.js – Order Schema (for persistence)
// EXTENDED: Added Multiplier fields and proposal tracking.
//
// [CHANGE-4-1] contractId is a String — already matched Trade.js.
// [CHANGE-4-2] Added purchasePrice (canonical) and filledPrice (compat
//   alias used by orderService's orderData.filledPrice).
// [CHANGE-4-3] contractId now has a PARTIAL UNIQUE index that applies
//   only when it is a non-null string.
//
// [FIX-DIGIT-PERSIST] contractService.placeDigitOrBinary was failing to save
//   Order documents for every digit/binary contract. Two root causes:
//     1. side was sent as 'CALL'/'DIGITEVEN'/etc. — not in the enum.
//        contractService now normalizes side to 'BUY'/'SELL' and stores the
//        specific contract in contractType (added below).
//     2. barrier, durationUnit, product, contractType were being silently
//        dropped by strict mode. Now explicit fields.
//   Also kept units + clientOrderId required (contractService now populates
//   both in File 4).

const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema(
  {
    // ---- Core identifiers ----
    clientOrderId: { type: String, required: true, unique: true },
    instrument: { type: String, required: true },
    side: { type: String, enum: ['BUY', 'SELL'], required: true },

    // ---- Legacy fields (kept) ----
    units: { type: Number, required: true },
    entryPrice: {
      type: Number,
      default: null,
      description: 'Underlying market entry price (not the contract purchase cost)',
    },
    stopLoss: { type: Number, default: null },
    takeProfit: { type: Number, default: null },

    // ---- Status ----
    status: {
      type: String,
      enum: ['PENDING', 'ACCEPTED', 'EXECUTING', 'FILLED', 'REJECTED', 'CANCELLED', 'CLOSED'],
      default: 'PENDING',
    },
    contractId: {
      type: String,
      default: null,
      description: 'Deriv contract ID (opaque identifier)',
    },
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
    //  MULTIPLIER TRADING FIELDS
    // =============================================================
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
      description: 'Trade duration (value in units of durationUnit)',
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

    // ---- Contract purchase cost ----
    purchasePrice: {
      type: Number,
      default: null,
      min: 0,
      description: 'Amount paid to purchase the Deriv contract',
    },
    filledPrice: {
      type: Number,
      default: null,
      min: 0,
      description: 'Alias for purchasePrice (amount filled at); kept in sync by pre-save hook',
    },

    // =============================================================
    //  DIGIT / BINARY TRADING FIELDS  [FIX-DIGIT-PERSIST]
    // =============================================================
    contractType: {
      type: String,
      default: null,
      index: true,
      description: 'MULTUP / MULTDOWN / CALL / PUT / DIGITEVEN / DIGITODD / DIGITOVER / DIGITUNDER / DIGITMATCH / DIGITDIFF / ONETOUCH / NOTOUCH',
    },
    barrier: {
      type: String,
      default: null,
      description: 'Barrier used for digit/touch contracts (0-9 for digits)',
    },
    durationUnit: {
      type: String,
      default: null,
      description: "Duration unit: 's' (seconds) or 't' (ticks)",
    },
    product: {
      type: String,
      default: null,
      index: true,
      description: 'Deriv product: deriv_multiplier / deriv_digital',
    },
    // [FIX-DIGIT-PERSIST] Carry the entryThesis snapshot on Order as well
    // so the audit trail is complete even if the Trade record is delayed.
    entryThesis: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    // ---- Proposal tracking (proposal-first execution) ----
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

// Keep filledPrice and purchasePrice in lockstep.
OrderSchema.pre('save', function (next) {
  if (this.filledPrice != null && this.purchasePrice == null) {
    this.purchasePrice = this.filledPrice;
  } else if (this.purchasePrice != null && this.filledPrice == null) {
    this.filledPrice = this.purchasePrice;
  } else if (this.filledPrice != null && this.purchasePrice != null
             && this.filledPrice !== this.purchasePrice) {
    try {
      const logger = require('../infrastructure/logger') || console;
      logger.warn(
        `[OrderSchema] filledPrice (${this.filledPrice}) !== purchasePrice (${this.purchasePrice}) ` +
        `for clientOrderId=${this.clientOrderId} / contractId=${this.contractId}; ` +
        `keeping purchasePrice`
      );
    } catch (_) { /* logging must never break a save */ }
    this.filledPrice = this.purchasePrice;
  }
  next();
});

// ---- Indexes ----
OrderSchema.index({ clientOrderId: 1 });
OrderSchema.index({ status: 1 });
OrderSchema.index(
  { contractId: 1 },
  {
    unique: true,
    partialFilterExpression: { contractId: { $type: 'string' } },
    name: 'contractId_unique_when_set',
  }
);
OrderSchema.index({ proposalId: 1 });
OrderSchema.index({ stake: 1, multiplier: 1 });
OrderSchema.index({ duration: 1 });
OrderSchema.index({ knockoutLevel: 1, takeProfitLevel: 1 });
// [FIX-DIGIT-PERSIST] New index for per-product/per-contract-type analytics.
OrderSchema.index({ product: 1, status: 1 });
OrderSchema.index({ contractType: 1, status: 1 });

module.exports = mongoose.model('Order', OrderSchema);
