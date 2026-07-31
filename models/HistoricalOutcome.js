// models/HistoricalOutcome.js
// Outcome labels for states and decisions.
// Used for training probability models, expected value estimation, and performance analysis.

const mongoose = require('mongoose');

const HistoricalOutcomeSchema = new mongoose.Schema(
  {
    // ---- Identifiers ----
    symbol: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    timeframe: {
      type: String,
      required: true,
      index: true,
      enum: ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'],
      default: 'M5',
    },

    // ---- References ----
    stateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'HistoricalState',
      default: null,
      index: true,
    },
    decisionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'HistoricalDecision',
      default: null,
      index: true,
    },

    // ---- Lookahead ----
    lookahead: {
      type: Number,
      required: true,
      enum: [5, 10, 20, 40],
      comment: 'Number of candles forward to measure outcome',
    },

    // ---- Outcome Data ----
    outcome: {
      // Price change (in price units)
      return: {
        type: Number,
        required: true,
      },
      // Return in R multiples (normalised by ATR or volatility)
      returnR: {
        type: Number,
        required: true,
      },
      // Win/Loss (true if return > 0)
      win: {
        type: Boolean,
        required: true,
      },
      // Maximum drawdown during the lookahead period
      maxDrawdown: {
        type: Number,
        default: 0,
      },
      // Maximum favourable excursion
      maxFavourable: {
        type: Number,
        default: 0,
      },
      // Volatility during the lookahead period
      volatility: {
        type: Number,
        default: 0,
      },
      // End price
      endPrice: {
        type: Number,
        required: true,
      },
      // Start price (entry)
      startPrice: {
        type: Number,
        required: true,
      },
    },

    // ---- Additional Context (for training) ----
    featuresSnapshot: {
      // A snapshot of features at the time of the state/decision
      // (denormalised for faster training)
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    // ---- Quality Flags ----
    quality: {
      type: String,
      enum: ['high', 'medium', 'low'],
      default: 'medium',
      comment: 'Quality of the outcome data (e.g., liquidity, spread, etc.)',
    },
    isValid: {
      type: Boolean,
      default: true,
      comment: 'Whether this outcome is valid for training (e.g., not during news, etc.)',
    },

    // ---- Metadata ----
    source: {
      type: String,
      enum: ['live', 'backfill', 'backtest'],
      default: 'live',
    },
    version: {
      type: String,
      default: '2.0',
    },
    filledAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    autoIndex: true,
  }
);

// ---- Indexes ----
// Compound index for fast lookups
HistoricalOutcomeSchema.index({ symbol: 1, timeframe: 1, lookahead: 1 });

// Index for training queries
HistoricalOutcomeSchema.index({
  'outcome.win': 1,
  'outcome.returnR': 1,
  lookahead: 1,
  isValid: 1,
});

// Index for reference lookups
HistoricalOutcomeSchema.index({ stateId: 1 });
HistoricalOutcomeSchema.index({ decisionId: 1 });

// TTL: auto‑delete outcomes older than 5 years (configurable)
HistoricalOutcomeSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 365 * 5 }
);

// ---- Methods ----
/**
 * Check if two outcomes are similar (for similarity search).
 */
HistoricalOutcomeSchema.methods.isSimilarTo = function(other, tolerance = 0.02) {
  return Math.abs(this.outcome.returnR - other.outcome.returnR) < tolerance;
};

// ---- Statics ----
/**
 * Get aggregated outcome statistics for a set of states/decisions.
 * @param {Array} ids - Array of stateIds or decisionIds.
 * @param {string} type - 'state' or 'decision'.
 * @param {number} lookahead - 5, 10, 20, 40.
 * @returns {Object} { count, winRate, avgReturnR, avgReturn, maxDrawdown, profitFactor }
 */
HistoricalOutcomeSchema.statics.getAggregatedStats = async function(ids, type = 'state', lookahead = 5) {
  const filter = { lookahead, isValid: true };
  if (type === 'state') {
    filter.stateId = { $in: ids };
  } else {
    filter.decisionId = { $in: ids };
  }

  const outcomes = await this.find(filter).lean();
  if (outcomes.length === 0) {
    return {
      count: 0,
      winRate: 0,
      avgReturnR: 0,
      avgReturn: 0,
      maxDrawdown: 0,
      profitFactor: 0,
    };
  }

  const total = outcomes.length;
  const wins = outcomes.filter(o => o.outcome.win === true).length;
  const winRate = total > 0 ? wins / total : 0;
  const avgReturnR = outcomes.reduce((sum, o) => sum + o.outcome.returnR, 0) / total;
  const avgReturn = outcomes.reduce((sum, o) => sum + o.outcome.return, 0) / total;
  const maxDrawdown = Math.min(0, ...outcomes.map(o => o.outcome.maxDrawdown || 0));
  const totalWins = outcomes.filter(o => o.outcome.returnR > 0).reduce((sum, o) => sum + o.outcome.returnR, 0);
  const totalLosses = outcomes.filter(o => o.outcome.returnR < 0).reduce((sum, o) => sum + Math.abs(o.outcome.returnR), 0);
  const profitFactor = totalLosses > 0 ? totalWins / totalLosses : (totalWins > 0 ? Infinity : 0);

  return {
    count: total,
    winRate,
    avgReturnR,
    avgReturn,
    maxDrawdown,
    profitFactor,
  };
};

/**
 * Get calibration data: predicted confidence vs actual win rate.
 * @param {Array} decisionIds - Array of decisionIds (must have confidence and outcome filled).
 * @param {number} buckets - Number of confidence buckets.
 * @returns {Object} { buckets: [{ lower, upper, count, winRate, avgReturnR }], calibrationError }
 */
HistoricalOutcomeSchema.statics.getCalibrationData = async function(decisionIds, buckets = 10) {
  // We need to join with HistoricalDecision to get confidence.
  // Since we can't do a direct aggregation with mongoose references, we'll use a pipeline.

  const pipeline = [
    { $match: { decisionId: { $in: decisionIds }, isValid: true } },
    {
      $lookup: {
        from: 'historicaldecisions',
        localField: 'decisionId',
        foreignField: '_id',
        as: 'decision',
      },
    },
    { $unwind: '$decision' },
    { $match: { 'decision.outcome.executed': true, 'decision.outcome.win': { $ne: null } } },
    {
      $bucket: {
        groupBy: '$decision.confidence',
        boundaries: Array.from({ length: buckets + 1 }, (_, i) => i * (100 / buckets)),
        default: 'other',
        output: {
          count: { $sum: 1 },
          wins: { $sum: { $cond: [{ $eq: ['$decision.outcome.win', true] }, 1, 0] } },
          avgReturnR: { $avg: '$decision.outcome.returnR' },
        },
      },
    },
    { $sort: { _id: 1 } },
  ];

  const result = await this.aggregate(pipeline);
  // Process result into a nice format
  const processed = result.map(bucket => ({
    lower: bucket._id,
    upper: bucket._id + (100 / buckets),
    count: bucket.count,
    winRate: bucket.count > 0 ? bucket.wins / bucket.count : 0,
    avgReturnR: bucket.avgReturnR || 0,
  }));

  // Calculate calibration error (mean squared error between predicted confidence and actual win rate)
  const calibrationError = processed.reduce((sum, b) => {
    const midConfidence = (b.lower + b.upper) / 2 / 100;
    return sum + Math.pow(midConfidence - b.winRate, 2) * b.count;
  }, 0) / processed.reduce((sum, b) => sum + b.count, 0);

  return { buckets: processed, calibrationError: Math.sqrt(calibrationError) };
};

/**
 * Export outcomes to CSV format for external analysis.
 */
HistoricalOutcomeSchema.statics.exportToCSV = async function(filter = {}, fields = []) {
  const outcomes = await this.find(filter).lean();
  if (outcomes.length === 0) return '';

  const headers = fields.length > 0 ? fields : Object.keys(outcomes[0].outcome);
  let csv = headers.join(',') + '\n';

  for (const o of outcomes) {
    const row = headers.map(h => {
      const val = o.outcome[h] !== undefined ? o.outcome[h] : '';
      return typeof val === 'string' ? `"${val}"` : val;
    });
    csv += row.join(',') + '\n';
  }

  return csv;
};

const HistoricalOutcome = mongoose.model('HistoricalOutcome', HistoricalOutcomeSchema);

module.exports = HistoricalOutcome;
