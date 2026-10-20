// models/Order.js – Order Schema (for persistence)
// EXTENDED: Added Multiplier fields and proposal tracking.
//
// [CHANGE-4-1] contractId is already a String — verified against
//   models/Trade.js (also String). No type change required; kept as-is so
//   cross-model queries and the broker's closeTrade fallback agree.
//
// [CHANGE-4-2] Added purchasePrice (canonical, amount paid for the Deriv
//   contract) and filledPrice (compat alias used by orderService's
//   orderData.filledPrice per File 2B). A pre('save') hook keeps the two
//   in sync. entryPrice remains the underlying market entry price — the
//   two values are now clearly distinct, matching the openPrice vs
//   purchasePrice split in Trade.js.
//
// [CHANGE-4-3] contractId now has a PARTIAL UNIQUE index that applies
//   only when it is a non-null string. Pending orders (contractId: null)
//   are unconstrained; confirmed contracts cannot be duplicated by any
//   code path (orderService's normal insert, or the broker's repair path
//   in _reconcilePositions). The old non-unique contractId_1 index is
//   replaced.
//
// NOTE: The broker no longer creates Order documents inside
//   placeMarketOrder (see File 1C). The only insert paths are
//   orderService's new Order().save() and the broker's
//   _reconcilePositions() repair path, which is guarded by a prior
//   existence check and backed by the partial unique index.

const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema(
  {
    // ---- Core identifiers ----
    clientOrderId: { type: String, required: true, unique: true },
    instrument: { type: String, required: true },
    side: { type: String, enum: ['BUY', 'SELL'], required: true },

    // ---- Legacy fields (kept) ----
    units: { type: Number, required: true },
    // [CHANGE-4-2] Underlying market entry price. Distinct from
    // purchasePrice / filledPrice (amount paid for the contract).
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
    // [CHANGE-4-1] String — matches Trade.contractId.
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

    // ---- [CHANGE-4-2] Contract purchase cost ----
    // Canonical name (per File 4). Amount paid to Deriv for the contract.
    // For multipliers this is the Deriv-confirmed purchase price; for CFDs
    // this stays null (a CFD has no purchase cost in this sense).
    purchasePrice: {
      type: Number,
      default: null,
      min: 0,
      description: 'Amount paid to purchase the Deriv contract',
    },
    // Compatibility alias used by orderService's orderData
    // (see File 2B: filledPrice: purchasePrice). Kept in sync with
    // purchasePrice by the pre('save') hook below.
    filledPrice: {
      type: Number,
      default: null,
      min: 0,
      description: 'Alias for purchasePrice (amount filled at); kept in sync by pre-save hook',
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

// [CHANGE-4-2] Keep filledPrice and purchasePrice in lockstep.
// orderService writes `filledPrice: purchasePrice` (File 2B) and the broker
// repair path writes `purchasePrice` (File 1C/5). Whichever side sets one,
// the other is populated on save. This hook does NOT fire for
// findOneAndUpdate — callers using that operator must set both explicitly.
OrderSchema.pre('save', function (next) {
  if (this.filledPrice != null && this.purchasePrice == null) {
    this.purchasePrice = this.filledPrice;
  } else if (this.purchasePrice != null && this.filledPrice == null) {
    this.filledPrice = this.purchasePrice;
  } else if (this.filledPrice != null && this.purchasePrice != null
             && this.filledPrice !== this.purchasePrice) {
    // Prefer the canonical purchasePrice; log divergence for investigation.
    // Use the model's own logger so it stays consistent with the rest of
    // the schema-level code.
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
// [CHANGE-4-3] Enforce one confirmed Order per contract. Partial filter
// scopes the uniqueness to non-null string contractIds, so PENDING orders
// without a contract yet can coexist freely.
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

module.exports = mongoose.model('Order', OrderSchema);
