// models/User.js – Single admin user model (for product preference)

const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema(
  {
    // Fixed ID for the admin user
    userId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      default: 'admin', // only one user for now
    },
    tradingProduct: {
      type: String,
      enum: ['mt5', 'deriv_cfd', 'deriv_multiplier', 'deriv_basic'],
      default: process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd',
    },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

UserSchema.index({ userId: 1 });

module.exports = mongoose.model('User', UserSchema);
