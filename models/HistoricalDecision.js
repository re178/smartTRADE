// models/HistoricalDecision.js
// Append‑only collection for every trading decision.
// Stores the full context: features, contributions, counter‑arguments, and outcome.
// Used for decision lineage, performance analysis, and confidence calibration.

const mongoose = require('mongoose');

const HistoricalDecisionSchema = new mongoose.Schema(
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
    timestamp: {
      type: Date,
      required: true,
      index: true,
      default: Date.now,
    },

    // ---- Decision ----
    decision: {
      type: String,
      enum: ['BUY', 'SELL', 'NO_TRADE'],
      required: true,
    },
    confidence: {
      type: Number,
      min: 0,
      max: 100,
      default: 50,
    },
    expectedValue: {
      type: Number,
      default: 0,
      comment: 'Expected value in R multiples',
    },
    probability: {
      type: Number,
      min: 0,
      max: 1,
      default: 0.5,
      comment: 'Estimated probability of winning',
    },

    // ---- Trade Parameters (only if decision is BUY/SELL) ----
    entryPrice: {
      type: Number,
      default: null,
    },
    stopLoss: {
      type: Number,
      default: null,
    },
    takeProfit: {
      type: Number,
      default: null,
    },
    recommendedLotSize: {
      type: Number,
      default: null,
    },

    // ---- Feature Snapshot (full MarketState at decision time) ----
    features: {
      // All fields from MarketState, stored as a sub‑document
      price: {
        current: Number,
        open: Number,
        high: Number,
        low: Number,
        close: Number,
      },
      trend: {
        direction: String,
        strength: Number,
        adx: Number,
        plusDI: Number,
        minusDI: Number,
      },
      momentum: {
        rsi: Number,
        macdLine: Number,
        macdSignal: Number,
        macdHist: Number,
        velocity: Number,
        acceleration: Number,
      },
      volatility: {
        atr: Number,
        atrPercent: Number,
        bbWidth: Number,
        regime: String,
      },
      liquidity: {
        score: Number,
        spread: Number,
        tickFrequency: Number,
      },
      structure: {
        support: Number,
        resistance: Number,
        pricePosition: Number,
        isAtSupport: Boolean,
        isAtResistance: Boolean,
      },
      session: {
        name: String,
        liquidityMultiplier: Number,
        isWeekday: Boolean,
      },
      regime: {
        code: String,
        name: String,
        confidence: Number,
        description: String,
      },
      awareness: {
        unusualEvents: [String],
        pressure: String,
      },
      summary: {
        marketQuality: Number,
        noiseLevel: String,
        regimeSuggestion: String,
        trendConfidence: Number,
      },
      confidence: Number,
      reason: String,
    },

    // ---- Decision Contributions (what influenced the decision) ----
    contributions: {
      // Positive contributors (BUY or SELL)
      positive: [
        {
          name: { type: String, required: true },
          score: { type: Number, default: 0 },
          description: { type: String, default: '' },
        },
      ],
      // Negative contributors (counter‑arguments)
      negative: [
        {
          name: { type: String, required: true },
          score: { type: Number, default: 0 },
          description: { type: String, default: '' },
        },
      ],
      // Total score (before threshold)
      totalScore: {
        type: Number,
        default: 0,
      },
    },

    // ---- Decision Lineage ----
    lineage: {
      generatedBy: {
        type: String,
        default: 'DecisionEngine v4',
      },
      inputs: {
        regime: { type: Number, default: 0 },
        momentum: { type: Number, default: 0 },
        liquidity: { type: Number, default: 0 },
        // additional inputs as needed
      },
      historicalAnalogues: {
        type: Number,
        default: 0,
        comment: 'Number of similar historical states used',
      },
      probabilityModel: {
        type: String,
        default: 'v3.8',
      },
      expectedValueModel: {
        type: String,
        default: 'v2.1',
      },
    },

    // ---- Outcome (filled later) ----
    outcome: {
      // Whether the trade was executed
      executed: {
        type: Boolean,
        default: false,
      },
      // Trade ID (if executed)
      tradeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Trade',
        default: null,
      },
      // Actual P&L (in account currency)
      pnl: {
        type: Number,
        default: null,
      },
      // Actual return in R multiples
      returnR: {
        type: Number,
        default: null,
      },
      // Win/Loss
      win: {
        type: Boolean,
        default: null,
      },
      // Exit price
      exitPrice: {
        type: Number,
        default: null,
      },
      // Exit time
      exitTime: {
        type: Date,
        default: null,
      },
      // Max adverse excursion (MAE)
      mae: {
        type: Number,
        default: null,
      },
      // Max favourable excursion (MFE)
      mfe: {
        type: Number,
        default: null,
      },
      // Filled at (when outcome was recorded)
      filledAt: {
        type: Date,
        default: null,
      },
    },

    // ---- Metadata ----
    source: {
      type: String,
      enum: ['live', 'backtest', 'simulated'],
      default: 'live',
    },
    version: {
      type: String,
      default: '2.0',
    },
  },
  {
    timestamps: true,
    autoIndex: true,
  }
);

// ---- Indexes ----
// Compound index for fast retrieval
HistoricalDecisionSchema.index({ symbol: 1, timeframe: 1, timestamp: -1 });

// Index for decisions by outcome
HistoricalDecisionSchema.index({
  'decision': 1,
  'outcome.executed': 1,
  'outcome.win': 1,
});

// Index for confidence calibration
HistoricalDecisionSchema.index({
  'confidence': 1,
  'outcome.win': 1,
});

// Index for decision lineage queries
HistoricalDecisionSchema.index({ 'lineage.generatedBy': 1 });

// TTL: auto‑delete decisions older than 5 years (configurable)
HistoricalDecisionSchema.index(
  { timestamp: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 365 * 5 }
);

// ---- Methods ----
/**
 * Check if the outcome has been filled.
 */
HistoricalDecisionSchema.methods.hasOutcome = function() {
  return this.outcome.pnl !== null || this.outcome.returnR !== null;
};

/**
 * Mark the decision as executed.
 * @param {Object} trade - Trade object.
 */
HistoricalDecisionSchema.methods.markExecuted = function(trade) {
  this.outcome.executed = true;
  this.outcome.tradeId = trade._id || trade.id;
  return this.save();
};

/**
 * Fill the outcome from a trade result.
 * @param {Object} result - { pnl, returnR, win, exitPrice, exitTime, mae, mfe }
 */
HistoricalDecisionSchema.methods.fillOutcome = function(result) {
  this.outcome.pnl = result.pnl !== undefined ? result.pnl : null;
  this.outcome.returnR = result.returnR !== undefined ? result.returnR : null;
  this.outcome.win = result.win !== undefined ? result.win : null;
  this.outcome.exitPrice = result.exitPrice || null;
  this.outcome.exitTime = result.exitTime || new Date();
  this.outcome.mae = result.mae !== undefined ? result.mae : null;
  this.outcome.mfe = result.mfe !== undefined ? result.mfe : null;
  this.outcome.filledAt = new Date();
  return this.save();
};

// ---- Statics ----
/**
 * Get decision performance summary for a symbol / timeframe.
 */
HistoricalDecisionSchema.statics.getPerformance = async function(symbol, timeframe) {
  const filter = { symbol, timeframe };
  const decisions = await this.find({
    ...filter,
    'outcome.executed': true,
    'outcome.returnR': { $ne: null },
  }).lean();

  if (decisions.length === 0) {
    return { count: 0, winRate: 0, avgReturnR: 0, profitFactor: 0 };
  }

  const total = decisions.length;
  const wins = decisions.filter(d => d.outcome.win === true).length;
  const winRate = total > 0 ? wins / total : 0;
  const avgReturnR = decisions.reduce((sum, d) => sum + (d.outcome.returnR || 0), 0) / total;
  const totalWins = decisions.filter(d => d.outcome.returnR > 0).reduce((sum, d) => sum + (d.outcome.returnR || 0), 0);
  const totalLosses = decisions.filter(d => d.outcome.returnR < 0).reduce((sum, d) => sum + Math.abs(d.outcome.returnR || 0), 0);
  const profitFactor = totalLosses > 0 ? totalWins / totalLosses : (totalWins > 0 ? Infinity : 0);

  return {
    count: total,
    winRate,
    avgReturnR,
    profitFactor,
  };
};

/**
 * Get decisions grouped by confidence bucket.
 * Used for confidence calibration.
 */
HistoricalDecisionSchema.statics.getCalibrationData = async function(buckets = 10) {
  const pipeline = [
    { $match: { 'outcome.executed': true, 'outcome.win': { $ne: null } } },
    {
      $bucket: {
        groupBy: '$confidence',
        boundaries: Array.from({ length: buckets + 1 }, (_, i) => i * (100 / buckets)),
        default: 'other',
        output: {
          count: { $sum: 1 },
          wins: { $sum: { $cond: [{ $eq: ['$outcome.win', true] }, 1, 0] } },
          losses: { $sum: { $cond: [{ $eq: ['$outcome.win', false] }, 1, 0] } },
          avgReturnR: { $avg: '$outcome.returnR' },
        },
      },
    },
    { $sort: { _id: 1 } },
  ];

  return this.aggregate(pipeline);
};

const HistoricalDecision = mongoose.model('HistoricalDecision', HistoricalDecisionSchema);

module.exports = HistoricalDecision;
