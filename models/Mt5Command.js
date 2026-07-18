const mongoose = require('mongoose');

const Mt5CommandSchema = new mongoose.Schema({
  commandId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  action: {
    type: String,
    required: true,
    enum: ['OPEN', 'CLOSE', 'MODIFY', 'CANCEL'],
  },
  instrument: String,
  side: String,
  units: Number,
  stopLoss: Number,
  takeProfit: Number,
  tradeId: String,           // for close/modify/cancel
  orderType: String,         // for pending orders
  price: Number,             // for pending orders
  stopLimitPrice: Number,    // for stop-limit
  volume: Number,            // for partial close

  // ---------- New state fields ----------
  state: {
    type: String,
    enum: ['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'],
    default: 'QUEUED',
    index: true,
  },
  processingStartedAt: Date,
  attempts: {
    type: Number,
    default: 0,
  },
  lastAttemptAt: Date,
  error: String,             // last error message if FAILED

  createdAt: {
    type: Date,
    default: Date.now,
    expires: 300,            // auto-delete after 5 minutes (stale commands)
  },
});

module.exports = mongoose.model('Mt5Command', Mt5CommandSchema);
