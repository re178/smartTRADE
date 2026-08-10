// models/Account.js – Broker‑agnostic account snapshot
// Replaces Mt5Account. Stores the latest account status.

const mongoose = require('mongoose');

const AccountSchema = new mongoose.Schema(
  {
    // Unique identifier (login ID or user ID)
    accountId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      default: 'default',
    },
    // Core balance fields
    balance: {
      type: Number,
      default: 0,
      min: 0,
    },
    equity: {
      type: Number,
      default: 0,
      min: 0,
    },
    marginUsed: {
      type: Number,
      default: 0,
      min: 0,
    },
    marginAvailable: {
      type: Number,
      default: 0,
      min: 0,
    },
    marginLevel: {
      type: Number,
      default: 0,
      min: 0,
    },
    currency: {
      type: String,
      default: 'USD',
      uppercase: true,
      trim: true,
    },
    // Broker info
    broker: {
      type: String,
      default: 'deriv',
      enum: ['deriv', 'mt5', 'manual'],
    },
    // Deriv‑specific: loginid, leverage, etc.
    loginId: {
      type: String,
      default: '',
    },
    leverage: {
      type: Number,
      default: 100,
    },
    // Optional: server name or account name
    server: {
      type: String,
      default: '',
    },
    accountName: {
      type: String,
      default: '',
    },
    // Status: online/offline/error
    status: {
      type: String,
      default: 'offline',
      enum: ['online', 'offline', 'error'],
    },
    // Timestamp of this snapshot
    snapshotTime: {
      type: Number, // milliseconds
      default: () => Date.now(),
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Ensure only one active account document (we upsert by accountId)
AccountSchema.index({ accountId: 1, snapshotTime: -1 });

// Static method to get the latest account snapshot
AccountSchema.statics.getLatest = async function (accountId = 'default') {
  const doc = await this.findOne({ accountId }).sort({ snapshotTime: -1 }).lean();
  if (!doc) {
    // Return a default offline account if none exists
    return {
      accountId,
      balance: 0,
      equity: 0,
      marginUsed: 0,
      marginAvailable: 0,
      marginLevel: 0,
      currency: 'USD',
      broker: 'deriv',
      status: 'offline',
      snapshotTime: Date.now(),
    };
  }
  return doc;
};

// Static method to update or insert account snapshot
AccountSchema.statics.upsertAccount = async function (data) {
  const {
    accountId = 'default',
    balance = 0,
    equity = 0,
    marginUsed = 0,
    marginAvailable = 0,
    marginLevel = 0,
    currency = 'USD',
    broker = 'deriv',
    loginId = '',
    leverage = 100,
    server = '',
    accountName = '',
    status = 'online',
    snapshotTime = Date.now(),
  } = data;

  return this.findOneAndUpdate(
    { accountId },
    {
      accountId,
      balance,
      equity,
      marginUsed,
      marginAvailable,
      marginLevel,
      currency: currency.toUpperCase(),
      broker,
      loginId,
      leverage,
      server,
      accountName,
      status,
      snapshotTime,
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    }
  );
};

module.exports = mongoose.model('Account', AccountSchema);
