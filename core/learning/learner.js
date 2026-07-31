// core/learning/learner.js
// RTS Self‑Learning Engine – with decision logging and persistent weights.
// Tracks strategy performance, updates weights, logs decisions to HistoricalDecision.

const Trade = require('../../models/Trade');
const HistoricalDecision = require('../../models/HistoricalDecision');
const LearningState = require('../../models/LearningState');
const { dataOrchestrator, DATA_CLASSES } = require('../data/dataOrchestrator');
const { EventEmitter } = require('events');
const logger = require('../../infrastructure/logger') || console;

// Configuration
const CONFIG = {
  EVALUATION_INTERVAL_TRADES: 20,
  LEARNING_RATE: 0.05,
  MIN_SAMPLES: 10,
  MAX_WEIGHT: 0.4,
  MIN_WEIGHT: 0.02,
  CONFIDENCE_ADJUSTMENT_FACTOR: 0.1,
};

class SelfLearner extends EventEmitter {
  constructor() {
    super();
    this._tradeHistory = [];
    this._strategyStats = {};
    this._strategyWeights = {};
    this._confidenceBiases = {};
    this._initialized = false;
    this._pendingUpdates = false;

    // ---- Register with DataOrchestrator ----
    dataOrchestrator.register('learningState', DATA_CLASSES.KNOWLEDGE, {
      collection: 'learningstates',
      ttl: Infinity,
    });
    dataOrchestrator.register('historicalDecision', DATA_CLASSES.RESEARCH, {
      collection: 'historicaldecisions',
      batchSize: 50,
    });

    // Load weights from orchestrator cache (or DB)
    this._loadWeights().then(() => {
      this._initialized = true;
      logger.info('[SelfLearner] Weights loaded.');
    }).catch(err => {
      logger.error('[SelfLearner] Failed to load weights:', err.message);
      this._initialized = true;
    });

    logger.info('[SelfLearner] Initialized with DataOrchestrator.');
  }

  // ============================================================
  // WEIGHT PERSISTENCE
  // ============================================================

  async _loadWeights() {
    // Try to get from orchestrator cache first
    const cached = dataOrchestrator.get('learningWeights');
    if (cached) {
      this._strategyWeights = cached.weights || {};
      this._confidenceBiases = cached.biases || {};
      logger.info('[SelfLearner] Weights loaded from orchestrator cache.');
      return;
    }

    // Fallback to direct DB query
    const docs = await LearningState.find({});
    if (docs.length === 0) {
      logger.info('[SelfLearner] No persisted weights found, using defaults.');
      return;
    }
    for (const doc of docs) {
      this._strategyWeights[doc.strategy] = doc.weight;
      this._confidenceBiases[doc.strategy] = doc.bias || 0;
      // Also store winRate/totalTrades for stats if available
      if (!this._strategyStats[doc.strategy]) {
        this._strategyStats[doc.strategy] = {
          wins: 0,
          losses: 0,
          totalPnL: 0,
          trades: [],
          winRate: doc.winRate || 0,
        };
      }
      this._strategyStats[doc.strategy].winRate = doc.winRate || 0;
      this._strategyStats[doc.strategy].totalTrades = doc.totalTrades || 0;
    }
    logger.info(`[SelfLearner] Loaded ${docs.length} strategy weights from DB.`);
  }

  async _saveWeights() {
    const weights = this._strategyWeights;
    const biases = this._confidenceBiases;
    // Publish to orchestrator as knowledge (upsert)
    dataOrchestrator.publish('learningState', {
      weights,
      biases,
      updatedAt: new Date(),
    }, { source: 'learner' });

    // Also update individual LearningState documents (for direct queries)
    const operations = [];
    for (const [strategy, weight] of Object.entries(weights)) {
      const bias = biases[strategy] || 0;
      const stats = this._strategyStats[strategy] || {};
      const winRate = stats.winRate || 0;
      const totalTrades = (stats.wins || 0) + (stats.losses || 0);
      operations.push({
        updateOne: {
          filter: { strategy },
          update: {
            $set: {
              weight,
              bias,
              winRate,
              totalTrades,
              updatedAt: new Date(),
            },
          },
          upsert: true,
        },
      });
    }
    if (operations.length > 0) {
      try {
        await LearningState.bulkWrite(operations);
        logger.debug(`[SelfLearner] Saved ${operations.length} strategy weights.`);
      } catch (err) {
        logger.error('[SelfLearner] Error saving weights:', err.message);
      }
    }
  }

  // ============================================================
  // DECISION LOGGING
  // ============================================================

  /**
   * Record a decision (BUY/SELL/NO_TRADE) to HistoricalDecision.
   * Called by the Decision Engine before execution.
   * @param {Object} decisionData - Full decision object from decision engine.
   * @returns {Promise<String>} The ID of the created HistoricalDecision document.
   */
  async recordDecision(decisionData) {
    try {
      const doc = new HistoricalDecision({
        symbol: decisionData.symbol,
        timeframe: decisionData.timeframe || 'M5',
        timestamp: decisionData.timestamp || new Date(),
        decision: decisionData.decision,
        confidence: decisionData.confidence || 50,
        expectedValue: decisionData.expectedValue || 0,
        probability: decisionData.probability || 0.5,
        entryPrice: decisionData.entryPrice || null,
        stopLoss: decisionData.stopLoss || null,
        takeProfit: decisionData.takeProfit || null,
        recommendedLotSize: decisionData.recommendedLotSize || null,
        features: decisionData.features || {},
        contributions: decisionData.contributions || { positive: [], negative: [], totalScore: 0 },
        lineage: {
          generatedBy: decisionData.generatedBy || 'DecisionEngine v4',
          inputs: decisionData.inputs || {},
          historicalAnalogues: decisionData.historicalAnalogues || 0,
          probabilityModel: decisionData.probabilityModel || 'v3.8',
          expectedValueModel: decisionData.expectedValueModel || 'v2.1',
        },
        outcome: {
          executed: false,
        },
        source: 'live',
        version: '2.0',
      });

      const saved = await doc.save();

      // Publish to orchestrator for research indexing
      dataOrchestrator.publish('historicalDecision', saved.toObject(), {
        source: 'learner',
        decisionId: saved._id,
      });

      logger.debug(`[SelfLearner] Decision logged: ${saved._id} (${decisionData.decision})`);
      return saved._id;
    } catch (err) {
      logger.error('[SelfLearner] Error logging decision:', err.message);
      return null;
    }
  }

  /**
   * Update a decision's outcome with trade result.
   * Called when a trade is closed.
   * @param {String} decisionId - The ID of the HistoricalDecision document.
   * @param {Object} trade - The closed trade object.
   */
  async updateDecisionOutcome(decisionId, trade) {
    if (!decisionId) return;
    try {
      const decision = await HistoricalDecision.findById(decisionId);
      if (!decision) {
        logger.warn(`[SelfLearner] Decision ${decisionId} not found for outcome update.`);
        return;
      }
      decision.outcome.executed = true;
      decision.outcome.tradeId = trade._id || trade.id;
      decision.outcome.pnl = trade.pnl || 0;
      decision.outcome.returnR = trade.returnR || 0;
      decision.outcome.win = (trade.pnl || 0) > 0;
      decision.outcome.exitPrice = trade.closePrice || null;
      decision.outcome.exitTime = trade.closeTime || new Date();
      // MAE/MFE can be computed if tracked; placeholder
      decision.outcome.mae = trade.mae || null;
      decision.outcome.mfe = trade.mfe || null;
      decision.outcome.filledAt = new Date();

      await decision.save();
      logger.debug(`[SelfLearner] Decision outcome updated: ${decisionId}`);
    } catch (err) {
      logger.error('[SelfLearner] Error updating decision outcome:', err.message);
    }
  }

  // ============================================================
  // TRADE RECORDING & LEARNING
  // ============================================================

  /**
   * Record a trade outcome (for learning weights).
   * This is called when a trade is closed.
   * @param {Object} trade - Trade object (must have strategy, pnl, side, etc.)
   */
  async recordTrade(trade) {
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

    // Also update decision outcome if decisionId is stored in trade
    if (trade.decisionId) {
      await this.updateDecisionOutcome(trade.decisionId, trade);
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
    const total = stats.wins + stats.losses;
    stats.winRate = total > 0 ? stats.wins / total : 0;

    // Update confidence bias
    if (!this._confidenceBiases[strategy]) this._confidenceBiases[strategy] = 0;
    const adjustment = (pnl > 0 ? 1 : -1) * CONFIG.CONFIDENCE_ADJUSTMENT_FACTOR;
    this._confidenceBiases[strategy] += adjustment;
    this._confidenceBiases[strategy] = Math.max(-20, Math.min(20, this._confidenceBiases[strategy]));
  }

  /**
   * Update strategy weights based on recent performance.
   */
  _updateWeights() {
    const adjustedWeights = {};
    let total = 0;

    for (const [strategy, stats] of Object.entries(this._strategyStats)) {
      const totalTrades = stats.wins + stats.losses;
      if (totalTrades < CONFIG.MIN_SAMPLES) {
        adjustedWeights[strategy] = this._strategyWeights[strategy] || 0.1;
      } else {
        const edge = stats.winRate - 0.5;
        const currentWeight = this._strategyWeights[strategy] || 0.1;
        const newWeight = currentWeight * (1 + edge * CONFIG.LEARNING_RATE);
        adjustedWeights[strategy] = Math.max(CONFIG.MIN_WEIGHT, Math.min(CONFIG.MAX_WEIGHT, newWeight));
      }
      total += adjustedWeights[strategy];
    }

    if (total === 0) {
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

    // Persist via orchestrator
    this._saveWeights().catch(err => {
      logger.error('[SelfLearner] Failed to save weights:', err.message);
    });
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
   * Adjust a strategy's weight manually.
   */
  setWeight(strategy, weight) {
    if (this._strategyWeights[strategy] !== undefined) {
      this._strategyWeights[strategy] = Math.max(CONFIG.MIN_WEIGHT, Math.min(CONFIG.MAX_WEIGHT, weight));
      this._normalizeWeights();
      this.emit('weightsUpdated', this._strategyWeights);
      this._saveWeights().catch(err => {
        logger.error('[SelfLearner] Failed to save weights:', err.message);
      });
    }
  }

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

  _emitStats() {
    const stats = this.getStats();
    logger.info('[SelfLearner] Strategy Stats:', stats);
    this.emit('stats', stats);
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
      this._updateWeights();
      this._emitStats();
      logger.info('[SelfLearner] History loaded and weights updated.');
    } catch (err) {
      logger.error('[SelfLearner] Failed to load history:', err.message);
    }
  }

  /**
   * Reset learning (clear all data).
   */
  async reset() {
    this._tradeHistory = [];
    this._strategyStats = {};
    this._strategyWeights = {};
    this._confidenceBiases = {};
    this._pendingUpdates = false;
    try {
      await LearningState.deleteMany({});
      await HistoricalDecision.deleteMany({});
      logger.info('[SelfLearner] Reset complete, DB cleared.');
    } catch (err) {
      logger.error('[SelfLearner] Error clearing DB on reset:', err.message);
    }
    this.emit('reset');
  }
}

// Singleton
const selfLearner = new SelfLearner();
module.exports = selfLearner;
