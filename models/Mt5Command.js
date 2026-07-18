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
  tradeId: String,         // for close/modify/cancel
  orderType: String,       // for pending orders
  price: Number,           // for pending orders
  stopLimitPrice: Number,  // for stop-limit
  volume: Number,          // for partial close
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 3600,         // auto-delete after 1 hour (optional TTL)
  },
});

module.exports = mongoose.model('Mt5Command', Mt5CommandSchema);
