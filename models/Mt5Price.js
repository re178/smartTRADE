const mongoose = require('mongoose');

const Mt5PriceSchema = new mongoose.Schema({
  symbol: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  bid: Number,
  ask: Number,
  spread: Number,
  digits: Number,
  point: Number,
  tick_size: Number,
  tick_value: Number,
  time: Number,
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('Mt5Price', Mt5PriceSchema);
