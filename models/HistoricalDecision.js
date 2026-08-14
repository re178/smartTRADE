// models/HistoricalDecision.js
// Append‑only collection for every trading decision.
// Stores the full context: features, contributions, counter‑arguments, and outcome.
// Used for decision lineage, performance analysis, and confidence calibration.
// EXTENDED: Added prediction fields for Multiplier decision system.

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

    // ---- Decision (legacy) ----
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
      comment: 'Expected value in R multiples (legacy)',
    },
    probability: {
      type: Number,
      min: 0,
      max: 1,
      default: 0.5,
      comment: 'Estimated probability of winning (legacy)',
    },

    // ---- Trade Parameters (if decision is BUY/SELL) ----
    entryPrice: { type: Number, default: null },
    stopLoss: { type: Number, default: null },
    takeProfit: { type: Number, default: null },
    recommendedLotSize: { type: Number, default: null },

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

    // =============================================================
    //  NEW FIELDS FOR MULTIPLIER PREDICTION
    // =============================================================
    // ---- Prediction Distribution ----
    prediction: {
      // Probability distribution
      up: { type: Number, min: 0, max: 1, default: 0.33 },
      down: { type: Number, min: 0, max: 1, default: 0.33 },
      neutral: { type: Number, min: 0, max: 1, default: 0.34 },
      // Expected moves
      expectedMove: { type: Number, default: 0 },
      expectedAdverse: { type: Number, default: 0 },
      expectedFavorable: { type: Number, default: 0 },
      // Path statistics
      mfe: { type: Number, default: null },
      mae: { type: Number, default: null },
      timeToMaxFavorable: { type: Number, default: null },
      timeToMaxAdverse: { type: Number, default: null },
      // Horizon (in candles)
      horizon: { type: Number, default: 5 },
      // Sample details
      sampleSize: { type: Number, default: 0 },
      averageSimilarity: { type: Number, default: 0 },
      // Regime at prediction time
      regimeCode: { type: String, default: 'NEUTRAL' },
    },

    // ---- Calibrated Confidence ----
    calibratedConfidence: {
      type: Number,
      min: 0,
      max: 100,
      default: 50,
      comment: 'Probability calibrated against historical calibration curve',
    },

    // ---- Trade Economics (Multiplier specific) ----
    tradeEconomics: {
      // Probability of reaching TP
      probabilityOfProfit: { type: Number, min: 0, max: 1, default: 0 },
      // Probability of hitting SL/knockout
      probabilityOfLoss: { type: Number, min: 0, max: 1, default: 0 },
      // Probability of other outcomes (expiry, etc.)
      probabilityOfOther: { type: Number, min: 0, max: 1, default: 0 },
      // Expected value in absolute currency
      expectedValue: { type: Number, default: 0 },
      // Expected value / stake (percentage)
      evOverStake: { type: Number, default: 0 },
      // Recommended stake
      recommendedStake: { type: Number, default: 0 },
      // Recommended multiplier
      recommendedMultiplier: { type: Number, default: 0 },
      // Recommended duration (seconds)
      recommendedDuration: { type: Number, default: 0 },
      // Knockout and take-profit levels
      knockoutLevel: { type: Number, default: null },
      takeProfitLevel: { type: Number, default: null },
    },

    // ---- NO TRADE Reason Taxonomy ----
    noTradeReason: {
      type: String,
      enum: [
        'NONE',
        'LOW_PROBABILITY',
        'NEGATIVE_EV',
        'HIGH_MAE',
        'LOW_SAMPLE',
        'POOR_SIMILARITY',
        'HIGH_SPREAD',
        'HIGH_VOLATILITY',
        'REGIME_UNSTABLE',
        'DURATION_UNFAVORABLE',
        'RISK_LIMIT',
        'CORRELATED_EXPOSURE',
        'BROKER_UNAVAILABLE',
        'STALE_DATA',
        'PROPOSAL_REJECTED',
        'MODEL_UNCERTAINTY',
      ],
      default: 'NONE',
    },

    // ---- Decision Chain (for traceability) ----
    decisionChain: {
      type: String,
      default: '',
      comment: 'Comma-separated list of decision modules that contributed (e.g., "prediction,opportunity,risk,gate")',
    },

    // ---- Outcome (legacy, kept) ----
    outcome: {
      executed: { type: Boolean, default: false },
      tradeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trade', default: null },
      pnl: { type: Number, default: null },
      returnR: { type: Number, default: null },
      win: { type: Boolean, default: null },
      exitPrice: { type: Number, default: null },
      exitTime: { type: Date, default: null },
      mae: { type: Number, default: null },
      mfe: { type: Number, default: null },
      filledAt: { type: Date, default: null },
    },

    // ---- Metadata ----
    source: {
      type: String,
      enum: ['live', 'backtest', 'simulated'],
      default: 'live',
    },
    version: {
      type: String,
      default: '3.0', // Updated to reflect Multiplier prediction
    },
  },
  {
    timestamps: true,
    autoIndex: true,
  }
);

// ---- Indexes (existing, plus new ones) ----
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

// ---- NEW INDEXES for prediction queries ----
HistoricalDecisionSchema.index({ 'prediction.up': 1, 'prediction.down': 1 });
HistoricalDecisionSchema.index({ 'calibratedConfidence': 1 });
HistoricalDecisionSchema.index({ 'tradeEconomics.expectedValue': 1 });
HistoricalDecisionSchema.index({ 'noTradeReason': 1 });

// TTL: auto‑delete decisions older than 5 years
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
 */
HistoricalDecisionSchema.methods.markExecuted = function(trade) {
  this.outcome.executed = true;
  this.outcome.tradeId = trade._id || trade.id;
  return this.save();
};

/**
 * Fill the outcome from a trade result.
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
 * Get decisions grouped by confidence bucket (for calibration).
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
