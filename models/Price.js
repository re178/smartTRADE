// models/Price.js – Broker‑agnostic latest price storage
// Replaces Mt5Price. Stores the most recent bid/ask per symbol.

const mongoose = require('mongoose');

const PriceSchema = new mongoose.Schema(
  {
    symbol: {
      type: String,
      required: true,
      index: true,
      uppercase: true,
      trim: true,
    },
    bid: {
      type: Number,
      required: true,
      min: 0,
    },
    ask: {
      type: Number,
      required: true,
      min: 0,
    },
    spread: {
      type: Number,
      default: 0,
      min: 0,
    },
    time: {
      type: Number, // Unix timestamp in milliseconds
      required: true,
      index: true,
    },
    // Optional: broker source (deriv, mt5, etc.) – useful for debugging
    source: {
      type: String,
      default: 'deriv',
      enum: ['deriv', 'mt5', 'manual'],
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for fast lookups + sorting by time
PriceSchema.index({ symbol: 1, time: -1 });

// Ensure only one price per symbol (the latest) – upsert handles this
// But we keep historical prices in case we want to track changes.
// To get the latest, we can use .findOne({ symbol }).sort({ time: -1 })

// Static method to get the latest price for a symbol
PriceSchema.statics.getLatest = async function (symbol) {
  const doc = await this.findOne({ symbol }).sort({ time: -1 }).lean();
  if (!doc) return null;
  return {
    symbol: doc.symbol,
    bid: doc.bid,
    ask: doc.ask,
    spread: doc.spread,
    time: doc.time,
  };
};

// Static method to update or insert the latest price
PriceSchema.statics.upsertPrice = async function (symbol, bid, ask, time, source = 'deriv') {
  const spread = ask - bid;
  const timeMs = time && time < 1e12 ? time * 1000 : time; // handle seconds vs ms
  return this.findOneAndUpdate(
    { symbol: symbol.toUpperCase() },
    {
      symbol: symbol.toUpperCase(),
      bid,
      ask,
      spread,
      time: timeMs || Date.now(),
      source,
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    }
  );
};

module.exports = mongoose.model('Price', PriceSchema);
