const mongoose = require('mongoose');

const Mt5CommandResultSchema = new mongoose.Schema({
  commandId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  success: Boolean,
  ticket: Number,
  deal: Number,
  price: Number,
  volume: Number,
  symbol: String,
  side: String,
  retcode: Number,
  retcodeDescription: String,
  error: String,
  time: Number,                   // timestamp from EA

  receivedAt: {
    type: Date,
    default: Date.now,
    expires: 3600,               // auto-delete after 1 hour
  },
});

module.exports = mongoose.model('Mt5CommandResult', Mt5CommandResultSchema);
