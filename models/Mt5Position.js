const mongoose = require('mongoose');

const Mt5PositionSchema = new mongoose.Schema({
  login: {
    type: Number,
    required: true,
    index: true,
  },
  ticket: {
    type: Number,
    required: true,
  },
  symbol: String,
  type: String,         // BUY or SELL
  volume: Number,
  price: Number,
  current_price: Number,
  profit: Number,
  stop_loss: Number,
  take_profit: Number,
  swap: Number,
  commission: Number,
  margin: Number,
  magic: Number,
  comment: String,
  open_time: Number,
  reason: Number,
  identifier: Number,
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Compound unique index to avoid duplicates per login+ticket
Mt5PositionSchema.index({ login: 1, ticket: 1 }, { unique: true });

module.exports = mongoose.model('Mt5Position', Mt5PositionSchema);
