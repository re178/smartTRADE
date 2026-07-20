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
  tradeId: Number,          // Changed from String to Number
  orderType: String,
  price: Number,
  stopLimitPrice: Number,
  volume: Number,
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
  error: String,
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 300,
  },
});

module.exports = mongoose.model('Mt5Command', Mt5CommandSchema);
