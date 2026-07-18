const mongoose = require('mongoose');

const Mt5AccountSchema = new mongoose.Schema({
  login: {
    type: Number,
    required: true,
    unique: true,
  },
  balance: Number,
  equity: Number,
  margin: Number,
  free_margin: Number,
  profit: Number,
  server: String,
  currency: String,
  leverage: Number,
  marginLevel: Number,
  tradeMode: Number,
  company: String,
  accountName: String,
  timestamp: Number,
  status: String,
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('Mt5Account', Mt5AccountSchema);
