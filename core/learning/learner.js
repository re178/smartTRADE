// core/learning/learner.js
// RTS Self‑Learning Engine
// Purpose: Continuously improve the system based on actual trading results.
// Answers: "What worked, what didn't, and how should we adapt?"

const Trade = require('../../models/Trade');
const { EventEmitter } = require('events');
const logger = require('../../infrastructure/logger') || console;

// Configuration
const CONFIG = {
  EVALUATION_INTERVAL_TRADES: 20,      // Re-evaluate weights every N trades
  LEARNING_RATE: 0.05,                 // Step size for weight updates
  MIN_SAMPLES: 10,                     // Minimum trades before adjusting
  MAX_WEIGHT: 0.4,                     // Cap per strategy weight
  MIN_WEIGHT: 0.02,                    // Minimum per strategy weight
  CONFIDENCE_ADJUSTMENT_FACTOR: 0.1,   // How much to shift confidence bias per trade
};

class SelfLearner extends EventEmitter {
  constructor() {
    super();
    this._tradeHistory = [];
    this._strategyStats = {};  // strategy name -> { wins, losses, totalPnL, trades, winRate }
    this._strategyWeights = {};
    this._confidenceBiases = {};
    this._initialized = false;
    this._pendingUpdates = false;

    // Listen to trade closure events (from orderService or elsewhere)
    // We'll set up the listener externally.

    logger.info('[SelfLearner] Initialized.');
  }

  /**
   * Load historical trades from the database.
   */
  async loadHistory() {
    try {
      const closedTrades = await Trade.find({ status: 'CLOSED' }).sort({ closeTime: -1 }).limit(1000);
      logger.info(`[SelfLearner] Loaded ${closedTrades.length} historical trades.`);
      for (const trade of closedTrades) {
        this._recordTrade(trade);
      }
      this._initialized = true;
      this._updateWeights();
      this._emitStats();
      logger.info('[SelfLearner] History loaded and weights updated.');
    } catch (err) {
      logger.error('[SelfLearner] Failed to load history:', err.message);
    }
  }

  /**
   * Record a new trade outcome.
   * @param {Object} trade - The trade object (must have strategy, pnl, side, entryPrice, exitPrice, etc.)
   */
  recordTrade(trade) {
    if (!trade || !trade.strategy) {
      logger.warn('[SelfLearner] Trade missing strategy, skipping.');
      return;
    }
    this._recordTrade(trade);
    this._tradeHistory.push(trade);

    // If we have enough new trades, re-evaluate
    if (this._tradeHistory.length % CONFIG.EVALUATION_INTERVAL_TRADES === 0) {
      this._updateWeights();
      this._emitStats();
    }
  }

  /**
   * Internal recording method (also used by loadHistory).
   */
  _recordTrade(trade) {
    const strategy = trade.strategy || 'unknown';
    if (!this._strategyStats[strategy]) {
      this._strategyStats[strategy] = {
        wins: 0,
        losses: 0,
        totalPnL: 0,
        trades: [],
        winRate: 0,
      };
    }
    const stats = this._strategyStats[strategy];
    const pnl = trade.pnl || 0;
    stats.totalPnL += pnl;
    stats.trades.push(trade);
    if (pnl > 0) stats.wins++;
    else if (pnl < 0) stats.losses++;
    // Update win rate
    const total = stats.wins + stats.losses;
    stats.winRate = total > 0 ? stats.wins / total : 0;

    // Update confidence bias (positive trade => increase bias, negative => decrease)
    if (!this._confidenceBiases[strategy]) this._confidenceBiases[strategy] = 0;
    const adjustment = (pnl > 0 ? 1 : -1) * CONFIG.CONFIDENCE_ADJUSTMENT_FACTOR;
    this._confidenceBiases[strategy] += adjustment;
    // Clamp bias between -20 and +20
    this._confidenceBiases[strategy] = Math.max(-20, Math.min(20, this._confidenceBiases[strategy]));
  }

  /**
   * Update strategy weights based on recent performance.
   * Uses the Kelly-like adjustment: newWeight = oldWeight * (1 + (winRate - 0.5) * learningRate)
   * Then normalizes to sum to 1.
   */
  _updateWeights() {
    const adjustedWeights = {};
    let total = 0;

    // First pass: compute adjusted weights
    for (const [strategy, stats] of Object.entries(this._strategyStats)) {
      const totalTrades = stats.wins + stats.losses;
      if (totalTrades < CONFIG.MIN_SAMPLES) {
        // Not enough data: keep existing or use default
        adjustedWeights[strategy] = this._strategyWeights[strategy] || 0.1;
      } else {
        // Adjust based on win rate relative to 0.5
        const edge = stats.winRate - 0.5;
        const currentWeight = this._strategyWeights[strategy] || 0.1;
        const newWeight = currentWeight * (1 + edge * CONFIG.LEARNING_RATE);
        adjustedWeights[strategy] = Math.max(CONFIG.MIN_WEIGHT, Math.min(CONFIG.MAX_WEIGHT, newWeight));
      }
      total += adjustedWeights[strategy];
    }

    // Normalize to sum to 1
    if (total === 0) {
      // If total is zero (should not happen), distribute equally
      const keys = Object.keys(adjustedWeights);
      const equal = 1 / keys.length;
      for (const key of keys) adjustedWeights[key] = equal;
    } else {
      for (const key of Object.keys(adjustedWeights)) {
        adjustedWeights[key] /= total;
      }
    }

    this._strategyWeights = adjustedWeights;
    this._pendingUpdates = true;
    this.emit('weightsUpdated', this._strategyWeights);
  }

  /**
   * Get the current strategy weights.
   */
  getWeights() {
    return { ...this._strategyWeights };
  }

  /**
   * Get confidence biases for strategies.
   */
  getBiases() {
    return { ...this._confidenceBiases };
  }

  /**
   * Adjust a strategy's weight manually (e.g., from an external override).
   */
  setWeight(strategy, weight) {
    if (this._strategyWeights[strategy] !== undefined) {
      this._strategyWeights[strategy] = Math.max(CONFIG.MIN_WEIGHT, Math.min(CONFIG.MAX_WEIGHT, weight));
      this._normalizeWeights();
      this.emit('weightsUpdated', this._strategyWeights);
    }
  }

  /**
   * Normalize weights (private, used after manual adjustments).
   */
  _normalizeWeights() {
    const total = Object.values(this._strategyWeights).reduce((a, b) => a + b, 0);
    if (total === 0) return;
    for (const key of Object.keys(this._strategyWeights)) {
      this._strategyWeights[key] /= total;
    }
  }

  /**
   * Get performance statistics for all strategies.
   */
  getStats() {
    const result = {};
    for (const [strategy, stats] of Object.entries(this._strategyStats)) {
      const total = stats.wins + stats.losses;
      result[strategy] = {
        winRate: stats.winRate,
        totalTrades: total,
        wins: stats.wins,
        losses: stats.losses,
        totalPnL: stats.totalPnL,
        averagePnL: total > 0 ? stats.totalPnL / total : 0,
        weight: this._strategyWeights[strategy] || 0,
        bias: this._confidenceBiases[strategy] || 0,
      };
    }
    return result;
  }

  /**
   * Emit performance stats to the dashboard or log.
   */
  _emitStats() {
    const stats = this.getStats();
    logger.info('[SelfLearner] Strategy Stats (win rate, weight, bias):', stats);
    this.emit('stats', stats);
  }

  /**
   * Reset learning (e.g., for a fresh start).
   */
  reset() {
    this._tradeHistory = [];
    this._strategyStats = {};
    this._strategyWeights = {};
    this._confidenceBiases = {};
    this._pendingUpdates = false;
    this.emit('reset');
    logger.info('[SelfLearner] Reset complete.');
  }
}

// Singleton
const selfLearner = new SelfLearner();
module.exports = selfLearner;
