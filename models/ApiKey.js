const mongoose = require('mongoose');
const { logger } = require('../utils/logger'); // reuse existing RTS logger if available, else console

const apiKeySchema = new mongoose.Schema({
  applicationName: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 100
  },
  apiKey: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  hashedSecret: {
    type: String,
    required: true
  },
  permissions: {
    type: [String],
    default: [],
    enum: [
      'market.read',
      'account.read',
      'positions.read',
      'history.read',
      'signals.write',
      'orders.write'
    ]
  },
  status: {
    type: String,
    enum: ['active', 'disabled'],
    default: 'active'
  },
  description: {
    type: String,
    maxlength: 500,
    default: ''
  },
  owner: {
    type: String,
    maxlength: 100,
    default: 'admin'
  },
  disabled: {
    type: Boolean,
    default: false
  },
  lastUsed: {
    type: Date
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Update `updatedAt` and derive `disabled` from `status` (for compatibility)
apiKeySchema.pre('save', function (next) {
  this.updatedAt = new Date();
  // Keep disabled in sync with status (if you prefer a single flag, but spec asks for both)
  this.disabled = this.status !== 'active';
  next();
});

apiKeySchema.pre('findOneAndUpdate', function (next) {
  this.set({ updatedAt: new Date() });
  // Sync disabled if status is modified
  if (this._update.status) {
    this._update.disabled = this._update.status !== 'active';
  }
  next();
});

// Log model events (optional)
apiKeySchema.post('save', function (doc) {
  logger.info(`ApiKey saved: ${doc.apiKey} (app: ${doc.applicationName})`);
});

apiKeySchema.post('findOneAndDelete', function (doc) {
  if (doc) logger.info(`ApiKey deleted: ${doc.apiKey}`);
});

module.exports = mongoose.model('ApiKey', apiKeySchema);
