// models/StrategyPerformance.js
// Per-strategy performance record — the source of truth for StrategyRanker.
//
// One document per (strategy, symbol) pair. Records:
//   • cumulative wins, losses, total trades
//   • win rate
//   • average R-multiple per trade
//   • recent 20 R-multiples (for detecting degradation)
//   • per-regime breakdown (STRONG_TREND_BULL, RANGING, etc.)
//
// The ranker reads this to weight each strategy's live signal. When a
// trade closes, orderService/runner updates the record via recordOutcome().
//
// A strategy with fewer than MIN_SAMPLES_FOR_CONFIDENCE trades uses the
// baseline win rate (0.5) rather than its noisy measured rate — this
// prevents 2-trade strategies from dominating ranking.

'use strict';

const mongoose = require('mongoose');

const REGIME_CODES = [
  'STRONG_TREND_BULL',
  'STRONG_TREND_BEAR',
  'WEAK_TREND',
  'RANGING',
  'BREAKOUT',
  'REVERSAL',
  'HIGH_VOLATILITY',
  'LOW_VOLATILITY',
  'NEUTRAL',
];

const StrategyPerformanceSchema = new mongoose.Schema(
  {
    // Composite key
    strategy: {
      type: String,
      required: true,
      index: true,
      description: 'Strategy name from STRATEGIES registry',
    },
    symbol: {
      type: String,
      required: true,
      index: true,
      description: 'Canonical symbol, e.g. EURUSD',
    },

    // ---- Cumulative stats ----
    trades: {
      type: Number,
      default: 0,
      description: 'Total closed trades attributed to this strategy/symbol',
    },
    wins: {
      type: Number,
      default: 0,
      description: 'Trades with realizedProfit > 0',
    },
    losses: {
      type: Number,
      default: 0,
      description: 'Trades with realizedProfit < 0',
    },
    breakeven: {
      type: Number,
      default: 0,
      description: 'Trades with realizedProfit == 0',
    },

    // ---- Return stats ----
    totalR: {
      type: Number,
      default: 0,
      description: 'Sum of R-multiples across all trades',
    },
    avgR: {
      type: Number,
      default: 0,
      description: 'Mean R-multiple per trade',
    },
    bestR: {
      type: Number,
      default: 0,
    },
    worstR: {
      type: Number,
      default: 0,
    },

    // ---- Win rate ----
    winRate: {
      type: Number,
      default: 0.5,
      description: 'Cumulative wins / (wins + losses). 0.5 baseline.',
    },

    // ---- Recent performance (last 20 R-multiples, newest first) ----
    recentR: {
      type: [Number],
      default: [],
      description: 'Last 20 R-multiples for detecting degradation',
    },
    recentWinRate: {
      type: Number,
      default: 0.5,
      description: 'Win rate across recentR array',
    },

    // ---- Per-regime breakdown ----
    // Keyed by regime code. Each entry has { trades, wins, totalR, avgR, winRate }
    byRegime: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      description: 'Performance breakdown by regime code',
    },

    // ---- Underperformance flag ----
    // Set by the ranker when recentWinRate drops below 0.40 over
    // MIN_RECENT_SAMPLES trades. Cleared when it recovers above 0.48.
    flagged: {
      type: Boolean,
      default: false,
      description: 'True if strategy is underperforming and should be down-weighted',
    },
    flaggedAt: {
      type: Date,
      default: null,
    },

    // ---- Metadata ----
    firstTradeAt: {
      type: Date,
      default: null,
    },
    lastTradeAt: {
      type: Date,
      default: null,
      index: true,
    },
    lastUpdated: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// ---- Indexes ----
// Compound unique: one record per (strategy, symbol)
StrategyPerformanceSchema.index(
  { strategy: 1, symbol: 1 },
  { unique: true, name: 'strategy_symbol_unique' }
);

// For "top strategies" queries
StrategyPerformanceSchema.index({ winRate: -1, trades: -1 });

// For "flagged strategies" queries
StrategyPerformanceSchema.index({ flagged: 1, lastTradeAt: -1 });

// ========================================================================
// Statics — helpers used by StrategyRanker
// ========================================================================

const MIN_SAMPLES_FOR_CONFIDENCE = 10;
const MIN_RECENT_SAMPLES = 10;
const UNDERPERFORM_THRESHOLD = 0.40;
const RECOVER_THRESHOLD = 0.48;
const RECENT_WINDOW = 20;

/**
 * Compute the "effective win rate" used by the ranker.
 *
 * If the strategy has fewer than MIN_SAMPLES_FOR_CONFIDENCE trades,
 * we blend the measured win rate with the 0.5 baseline proportionally:
 *   effective = (measured × n + 0.5 × (MIN - n)) / MIN
 *
 * This means a 3-trade strategy with 100% win rate shows as 0.65, not 1.0.
 * It prevents noise from dominating ranking.
 */
StrategyPerformanceSchema.methods.effectiveWinRate = function () {
  const n = this.wins + this.losses;
  if (n === 0) return 0.5;
  if (n >= MIN_SAMPLES_FOR_CONFIDENCE) return this.winRate;
  const blended = (this.winRate * n + 0.5 * (MIN_SAMPLES_FOR_CONFIDENCE - n)) / MIN_SAMPLES_FOR_CONFIDENCE;
  return blended;
};

/**
 * Effective average R, blended with 0 baseline using the same logic.
 */
StrategyPerformanceSchema.methods.effectiveAvgR = function () {
  const n = this.trades;
  if (n === 0) return 0;
  if (n >= MIN_SAMPLES_FOR_CONFIDENCE) return this.avgR;
  return (this.avgR * n) / MIN_SAMPLES_FOR_CONFIDENCE;
};

/**
 * Regime-specific win rate. Returns null if insufficient data in that regime,
 * meaning the ranker should fall back to the overall win rate.
 */
StrategyPerformanceSchema.methods.regimeWinRate = function (regimeCode) {
  if (!regimeCode) return null;
  const entry = this.byRegime?.[regimeCode];
  if (!entry || entry.trades < 5) return null;
  return entry.winRate;
};

/**
 * Static — update the record when a trade closes.
 *
 * Called from server.js's trade.closed handler (or from the runner).
 *
 * @param {string} strategy  — strategy name
 * @param {string} symbol    — canonical symbol
 * @param {number} realizedProfit — from Trade.realizedProfit
 * @param {number} riskAmount — from Trade.riskAmount (or fall back to stake)
 * @param {string} regimeCode — regime at time of trade open (from Trade metadata or best guess)
 * @returns {Promise<Object>} — the updated document
 */
StrategyPerformanceSchema.statics.recordOutcome = async function (
  strategy,
  symbol,
  realizedProfit,
  riskAmount,
  regimeCode
) {
  if (!strategy || !symbol) {
    throw new Error('recordOutcome requires strategy and symbol');
  }

  const profit = Number(realizedProfit) || 0;
  const risk = Number(riskAmount) > 0 ? Number(riskAmount) : 1;
  const rMultiple = profit / risk;

  const win = profit > 0;
  const loss = profit < 0;
  const even = profit === 0;

  // Fetch or create
  let doc = await this.findOne({ strategy, symbol });
  if (!doc) {
    doc = new this({
      strategy,
      symbol,
      firstTradeAt: new Date(),
    });
  }

  // ---- Update cumulative ----
  doc.trades += 1;
  if (win) doc.wins += 1;
  else if (loss) doc.losses += 1;
  else doc.breakeven += 1;

  doc.totalR += rMultiple;
  doc.avgR = doc.totalR / doc.trades;
  doc.bestR = Math.max(doc.bestR, rMultiple);
  doc.worstR = Math.min(doc.worstR, rMultiple);

  const decided = doc.wins + doc.losses;
  doc.winRate = decided > 0 ? doc.wins / decided : 0.5;

  // ---- Update recent window ----
  doc.recentR = [rMultiple, ...doc.recentR].slice(0, RECENT_WINDOW);
  if (doc.recentR.length > 0) {
    const recentWins = doc.recentR.filter(r => r > 0).length;
    doc.recentWinRate = recentWins / doc.recentR.length;
  }

  // ---- Update per-regime breakdown ----
  if (regimeCode && REGIME_CODES.includes(regimeCode)) {
    const byRegime = doc.byRegime || {};
    const bucket = byRegime[regimeCode] || { trades: 0, wins: 0, totalR: 0, avgR: 0, winRate: 0.5 };
    bucket.trades += 1;
    if (win) bucket.wins += 1;
    bucket.totalR += rMultiple;
    bucket.avgR = bucket.totalR / bucket.trades;
    bucket.winRate = bucket.trades > 0 ? bucket.wins / bucket.trades : 0.5;
    byRegime[regimeCode] = bucket;
    doc.byRegime = byRegime;
  }

  // ---- Flagging logic ----
  if (doc.recentR.length >= MIN_RECENT_SAMPLES) {
    if (!doc.flagged && doc.recentWinRate < UNDERPERFORM_THRESHOLD) {
      doc.flagged = true;
      doc.flaggedAt = new Date();
    } else if (doc.flagged && doc.recentWinRate > RECOVER_THRESHOLD) {
      doc.flagged = false;
      doc.flaggedAt = null;
    }
  }

  // ---- Timestamps ----
  doc.lastTradeAt = new Date();
  doc.lastUpdated = new Date();

  await doc.save();
  return doc;
};

/**
 * Static — fetch all performance records for a symbol.
 * Returns a Map keyed by strategy name for O(1) lookup by the ranker.
 */
StrategyPerformanceSchema.statics.loadForSymbol = async function (symbol) {
  const docs = await this.find({ symbol }).lean();
  const map = new Map();
  for (const d of docs) {
    map.set(d.strategy, d);
  }
  return map;
};

/**
 * Static — return top N strategies across all symbols by effective win rate.
 * Used by /debug/strategies and by the dashboard ranking panel.
 */
StrategyPerformanceSchema.statics.topStrategies = async function (limit = 10) {
  return this.find({ trades: { $gte: 3 } })
    .sort({ winRate: -1, trades: -1 })
    .limit(limit)
    .lean();
};

// Export constants for use by the ranker
const CONSTANTS = {
  MIN_SAMPLES_FOR_CONFIDENCE,
  MIN_RECENT_SAMPLES,
  UNDERPERFORM_THRESHOLD,
  RECOVER_THRESHOLD,
  RECENT_WINDOW,
  REGIME_CODES,
};

const StrategyPerformance = mongoose.model('StrategyPerformance', StrategyPerformanceSchema);
StrategyPerformance.CONSTANTS = CONSTANTS;

module.exports = StrategyPerformance;
