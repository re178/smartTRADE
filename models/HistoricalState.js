// models/HistoricalState.js
// Append‑only collection for market state snapshots.
// Each record represents a complete view of the market at a point in time.
// Outcomes are filled later via background jobs.

const mongoose = require('mongoose');

const HistoricalStateSchema = new mongoose.Schema(
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
    },

    // ---- Price Data ----
    price: {
      current: { type: Number, required: true },
      open: { type: Number },
      high: { type: Number },
      low: { type: Number },
      close: { type: Number },
    },

    // ---- Trend Features ----
    trend: {
      direction: {
        type: String,
        enum: ['bullish', 'bearish', 'neutral'],
        default: 'neutral',
      },
      strength: { type: Number, min: 0, max: 100, default: 0 },
      adx: { type: Number, min: 0, max: 100, default: 0 },
      plusDI: { type: Number, min: 0, max: 100, default: 0 },
      minusDI: { type: Number, min: 0, max: 100, default: 0 },
      slope: { type: Number, default: 0 },
    },

    // ---- Momentum Features ----
    momentum: {
      rsi: { type: Number, min: 0, max: 100, default: 50 },
      macdLine: { type: Number, default: 0 },
      macdSignal: { type: Number, default: 0 },
      macdHist: { type: Number, default: 0 },
      velocity: { type: Number, default: 0 },
      acceleration: { type: Number, default: 0 },
    },

    // ---- Volatility Features ----
    volatility: {
      atr: { type: Number, default: 0 },
      atrPercent: { type: Number, default: 0 },
      bbWidth: { type: Number, default: 0 },
      regime: {
        type: String,
        enum: ['high', 'medium', 'low', 'normal'],
        default: 'normal',
      },
    },

    // ---- Liquidity & Market Quality ----
    liquidity: {
      score: { type: Number, min: 0, max: 1, default: 0.5 },
      spread: { type: Number, default: 0 },
      tickFrequency: { type: Number, default: 0 },
    },

    // ---- Market Structure ----
    structure: {
      support: { type: Number, default: null },
      resistance: { type: Number, default: null },
      pricePosition: { type: Number, min: 0, max: 1, default: 0.5 },
      isAtSupport: { type: Boolean, default: false },
      isAtResistance: { type: Boolean, default: false },
    },

    // ---- Session Context ----
    session: {
      name: {
        type: String,
        enum: ['Sydney', 'Asia', 'London', 'New York', 'Other'],
        default: 'Other',
      },
      liquidityMultiplier: { type: Number, default: 1.0 },
      isWeekday: { type: Boolean, default: true },
    },

    // ---- Regime Classification ----
    regime: {
      code: {
        type: String,
        enum: [
          'STRONG_TREND_BULL',
          'STRONG_TREND_BEAR',
          'WEAK_TREND',
          'RANGING',
          'BREAKOUT',
          'REVERSAL',
          'HIGH_VOLATILITY',
          'LOW_VOLATILITY',
          'NEUTRAL',
        ],
        default: 'NEUTRAL',
      },
      name: { type: String, default: 'Neutral / Mixed' },
      confidence: { type: Number, min: 0, max: 100, default: 50 },
      description: { type: String, default: '' },
    },

    // ---- Awareness (Tick‑Level) ----
    awareness: {
      unusualEvents: { type: [String], default: [] },
      pressure: { type: String, enum: ['buying', 'selling', 'neutral'], default: 'neutral' },
    },

    // ---- Summary / Derived ----
    summary: {
      marketQuality: { type: Number, min: 0, max: 100, default: 50 },
      noiseLevel: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
      regimeSuggestion: {
        type: String,
        enum: ['trending', 'ranging', 'volatile', 'quiet', 'reversal', 'neutral'],
        default: 'neutral',
      },
      trendConfidence: { type: Number, min: 0, max: 100, default: 50 },
    },

    // ---- Confidence & Edge (computed later) ----
    confidence: { type: Number, min: 0, max: 100, default: 50 },
    reason: { type: String, default: '' },

    // ---- OUTCOMES (filled later by background job) ----
    outcome5: {
      // Return after 5 candles (in price units)
      return: { type: Number, default: null },
      returnR: { type: Number, default: null }, // Return in R multiples
      win: { type: Boolean, default: null },
      maxDrawdown: { type: Number, default: null },
      volatility: { type: Number, default: null },
      filledAt: { type: Date, default: null },
    },
    outcome10: {
      return: { type: Number, default: null },
      returnR: { type: Number, default: null },
      win: { type: Boolean, default: null },
      maxDrawdown: { type: Number, default: null },
      volatility: { type: Number, default: null },
      filledAt: { type: Date, default: null },
    },
    outcome20: {
      return: { type: Number, default: null },
      returnR: { type: Number, default: null },
      win: { type: Boolean, default: null },
      maxDrawdown: { type: Number, default: null },
      volatility: { type: Number, default: null },
      filledAt: { type: Date, default: null },
    },
    outcome40: {
      return: { type: Number, default: null },
      returnR: { type: Number, default: null },
      win: { type: Boolean, default: null },
      maxDrawdown: { type: Number, default: null },
      volatility: { type: Number, default: null },
      filledAt: { type: Date, default: null },
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
  },
  {
    timestamps: true,
    // Optimize for append‑only and query performance
    autoIndex: true,
  }
);

// ---- Indexes ----
// Compound index for fast retrieval by symbol + timeframe + timestamp
HistoricalStateSchema.index({ symbol: 1, timeframe: 1, timestamp: -1 });

// Index for similarity search (features will be queried together)
HistoricalStateSchema.index({
  'symbol': 1,
  'timeframe': 1,
  'trend.adx': 1,
  'momentum.rsi': 1,
  'volatility.atrPercent': 1,
  'liquidity.score': 1,
  'session.name': 1,
  'regime.code': 1,
});

// Index for outcome queries
HistoricalStateSchema.index({
  'outcome5.win': 1,
  'outcome5.returnR': 1,
  'outcome5.filledAt': 1,
});

// Index for confidence calibration
HistoricalStateSchema.index({
  'confidence': 1,
  'outcome5.win': 1,
});

// TTL index: auto‑delete states older than 2 years (configurable)
HistoricalStateSchema.index(
  { timestamp: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 365 * 2 } // 2 years
);

// ---- Methods ----
/**
 * Check if outcomes are filled for all lookaheads.
 */
HistoricalStateSchema.methods.isFullyLabelled = function() {
  return (
    this.outcome5.return !== null &&
    this.outcome10.return !== null &&
    this.outcome20.return !== null &&
    this.outcome40.return !== null
  );
};

/**
 * Get the feature vector as a plain object for similarity search.
 */
HistoricalStateSchema.methods.getFeatureVector = function() {
  return {
    adx: this.trend.adx,
    rsi: this.momentum.rsi,
    atrPercent: this.volatility.atrPercent,
    bbWidth: this.volatility.bbWidth,
    macdHist: this.momentum.macdHist,
    liquidity: this.liquidity.score,
    velocity: this.momentum.velocity,
    acceleration: this.momentum.acceleration,
    pricePosition: this.structure.pricePosition,
    session: this.session.name,
    sessionMultiplier: this.session.liquidityMultiplier,
    trendStrength: this.trend.strength,
    trendDirection: this.trend.direction === 'bullish' ? 1 : (this.trend.direction === 'bearish' ? -1 : 0),
    volatilityRegime: this.volatility.regime,
    regimeCode: this.regime.code,
    marketQuality: this.summary.marketQuality,
    noiseLevel: this.summary.noiseLevel === 'high' ? 1 : (this.summary.noiseLevel === 'medium' ? 0.5 : 0),
  };
};

// ---- Statics ----
/**
 * Find similar states based on feature similarity.
 * @param {Object} queryFeatures - Feature vector to compare.
 * @param {number} k - Number of similar states to return.
 * @param {Object} filter - Additional filter (symbol, timeframe, etc.).
 * @returns {Promise<Array>} Array of similar states with similarity score.
 */
HistoricalStateSchema.statics.findSimilar = async function(queryFeatures, k = 100, filter = {}) {
  // This is a placeholder – actual implementation will use:
  // - MongoDB $vectorSearch (Atlas) if available
  // - Euclidean distance on normalized features (fallback)
  // - FAISS or other vector index for production

  // For now, return an empty array (to be implemented in StateStore)
  return [];
};

/**
 * Get outcome statistics for a set of states.
 */
HistoricalStateSchema.statics.getOutcomeStats = async function(stateIds, lookahead = 'outcome5') {
  const states = await this.find(
    { _id: { $in: stateIds }, [`${lookahead}.return`]: { $ne: null } }
  ).lean();

  if (states.length === 0) {
    return { count: 0, winRate: 0, avgReturn: 0, avgReturnR: 0, maxDrawdown: 0 };
  }

  const wins = states.filter(s => s[lookahead].win === true).length;
  const total = states.length;
  const avgReturn = states.reduce((sum, s) => sum + (s[lookahead].return || 0), 0) / total;
  const avgReturnR = states.reduce((sum, s) => sum + (s[lookahead].returnR || 0), 0) / total;
  const maxDrawdown = Math.min(0, ...states.map(s => s[lookahead].maxDrawdown || 0));

  return {
    count: total,
    winRate: total > 0 ? wins / total : 0,
    avgReturn,
    avgReturnR,
    maxDrawdown,
  };
};

const HistoricalState = mongoose.model('HistoricalState', HistoricalStateSchema);

module.exports = HistoricalState;
