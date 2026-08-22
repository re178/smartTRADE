// models/HistoricalState.js – Corrected schema
// Append‑only collection for market state snapshots.
// EXTENDED: futurePrices as horizon‑specific object.

const mongoose = require('mongoose');

const HistoricalStateSchema = new mongoose.Schema(
  {
    // ---- Identifiers ----
    symbol: { type: String, required: true, index: true, trim: true },
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
      // ❌ Removed `index: true` – we use TTL index below
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
      direction: { type: String, enum: ['bullish', 'bearish', 'neutral'], default: 'neutral' },
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
      regime: { type: String, enum: ['high', 'medium', 'low', 'normal'], default: 'normal' },
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
      name: { type: String, enum: ['Sydney', 'Asia', 'London', 'New York', 'Other'], default: 'Other' },
      liquidityMultiplier: { type: Number, default: 1.0 },
      isWeekday: { type: Boolean, default: true },
    },

    // ---- Regime Classification ----
    regime: {
      code: {
        type: String,
        enum: [
          'STRONG_TREND_BULL', 'STRONG_TREND_BEAR', 'WEAK_TREND',
          'RANGING', 'BREAKOUT', 'REVERSAL',
          'HIGH_VOLATILITY', 'LOW_VOLATILITY', 'NEUTRAL',
        ],
        default: 'NEUTRAL',
      },
      name: { type: String, default: 'Neutral / Mixed' },
      confidence: { type: Number, min: 0, max: 100, default: 50 },
      description: { type: String, default: '' },
    },

    // ---- Awareness ----
    awareness: {
      unusualEvents: { type: [String], default: [] },
      pressure: { type: String, enum: ['buying', 'selling', 'neutral'], default: 'neutral' },
    },

    // ---- Summary ----
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

    // ---- Confidence ----
    confidence: { type: Number, min: 0, max: 100, default: 50 },
    reason: { type: String, default: '' },

    // ---- Existing Outcomes (kept) ----
    outcome5: {
      return: { type: Number, default: null },
      returnR: { type: Number, default: null },
      win: { type: Boolean, default: null },
      maxDrawdown: { type: Number, default: null },
      volatility: { type: Number, default: null },
      filledAt: { type: Date, default: null },
    },
    outcome10: { /* same */ },
    outcome20: { /* same */ },
    outcome40: { /* same */ },

    // =============================================================
    //  NEW: Future Path Data (Horizon‑specific)
    // =============================================================
    futurePrices: {
      5: { type: [Number], default: null },
      10: { type: [Number], default: null },
      20: { type: [Number], default: null },
      40: { type: [Number], default: null },
    },

    mfe: { type: Number, default: null },
    mae: { type: Number, default: null },
    timeToMaxFavorable: { type: Number, default: null },
    timeToMaxAdverse: { type: Number, default: null },
    regimeTransitions: { type: [String], default: [] },

    // ---- Metadata ----
    source: { type: String, enum: ['live', 'backfill', 'backtest'], default: 'live' },
    version: { type: String, default: '2.1' },
  },
  { timestamps: true }
);

// ---- Indexes ----
// Compound index for fast retrieval
HistoricalStateSchema.index({ symbol: 1, timeframe: 1, timestamp: -1 });

// Index for similarity search
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

// ---- TTL index (kept, removed duplicate index: true) ----
HistoricalStateSchema.index(
  { timestamp: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 365 * 2 }
);

// ---- Methods ----
HistoricalStateSchema.methods.isFullyLabelled = function() {
  return (
    this.outcome5.return !== null &&
    this.outcome10.return !== null &&
    this.outcome20.return !== null &&
    this.outcome40.return !== null
  );
};

HistoricalStateSchema.methods.hasPathData = function() {
  return (
    this.futurePrices &&
    [5, 10, 20, 40].every(h =>
      Array.isArray(this.futurePrices[h]) && this.futurePrices[h].length > 0
    )
  );
};

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

const HistoricalState = mongoose.model('HistoricalState', HistoricalStateSchema);

module.exports = HistoricalState;
