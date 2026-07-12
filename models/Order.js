// models/Order.js – Order Schema (for persistence)

const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema(
  {
    clientOrderId: { type: String, required: true, unique: true },
    instrument: { type: String, required: true },
    side: { type: String, enum: ['BUY', 'SELL'], required: true },
    units: { type: Number, required: true },
    entryPrice: { type: Number, default: null },
    stopLoss: { type: Number, default: null },
    takeProfit: { type: Number, default: null },
    status: {
      type: String,
      enum: ['PENDING', 'ACCEPTED', 'EXECUTING', 'FILLED', 'REJECTED', 'CANCELLED', 'CLOSED'],
      default: 'PENDING',
    },
    contractId: { type: String, default: null },
    broker: { type: String, default: 'deriv' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    filledAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    rejectReason: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

OrderSchema.index({ clientOrderId: 1 });
OrderSchema.index({ status: 1 });
OrderSchema.index({ contractId: 1 });

module.exports = mongoose.model('Order', OrderSchema);
