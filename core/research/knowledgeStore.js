// core/research/knowledgeStore.js
// Knowledge Store – manages validated observations and knowledge.
// Distinguishes between evidence (current) and knowledge (validated over time).

const mongoose = require('mongoose');
const logger = require('../../infrastructure/logger') || console;

// ----- Knowledge Schema -----
const KnowledgeSchema = new mongoose.Schema({
  // What was observed
  symbol: { type: String, required: true, index: true },
  regime: { type: String, required: true }, // e.g., 'STRONG_TREND_BULL'
  indicator: { type: String, required: true }, // e.g., 'rsi', 'velocity'
  valueRange: { type: String, required: true }, // e.g., '30-40', '>0.0001'
  
  // What happened
  outcome: { type: String, required: true }, // 'continuation', 'reversal', 'breakout', 'failure'
  
  // Statistics
  observedCount: { type: Number, default: 0 },
  successCount: { type: Number, default: 0 },
  successRate: { type: Number, default: 0 }, // 0-1
  confidence: { type: Number, default: 0.5 },
  
  // Context
  session: { type: String, default: 'all' }, // London, New York, Asia, all
  volatilityRegime: { type: String, default: 'all' }, // high, low, normal, all
  
  // Timestamps
  firstObserved: { type: Date, default: Date.now },
  lastUpdated: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: null }, // optional expiration for temporary knowledge
});

// Compound index for fast lookups
KnowledgeSchema.index({ symbol: 1, regime: 1, indicator: 1, outcome: 1 });
KnowledgeSchema.index({ confidence: -1 });

const KnowledgeModel = mongoose.model('Knowledge', KnowledgeSchema);

// ----- Evidence Schema (temporary) -----
const EvidenceSchema = new mongoose.Schema({
  symbol: { type: String, required: true, index: true },
  indicator: { type: String, required: true },
  value: { type: Number, required: true },
  timestamp: { type: Date, default: Date.now, expires: 3600 }, // auto-delete after 1 hour
  source: { type: String, default: 'awareness' },
});

const EvidenceModel = mongoose.model('Evidence', EvidenceSchema);

// ----- KnowledgeStore Class -----
class KnowledgeStore {
  constructor() {
    // In‑memory cache for frequently accessed knowledge
    this._cache = new Map(); // key -> knowledge object
    this._cacheTTL = 60000; // 1 minute
    this._lastCacheRefresh = Date.now();
  }

  /**
   * Record a new piece of knowledge (validated hypothesis).
   */
  async recordKnowledge(knowledge) {
    try {
      const { symbol, regime, indicator, valueRange, outcome, confidence, session, volatilityRegime } = knowledge;

      // Check if we already have this knowledge
      const existing = await KnowledgeModel.findOne({
        symbol,
        regime,
        indicator,
        valueRange,
        outcome,
      });

      if (existing) {
        // Update statistics
        existing.observedCount += 1;
        existing.successCount += (confidence > 0.6 ? 1 : 0);
        existing.successRate = existing.successCount / existing.observedCount;
        existing.confidence = (existing.confidence * 0.9) + (confidence * 0.1); // weighted average
        existing.lastUpdated = new Date();
        await existing.save();
        logger.debug(`[KnowledgeStore] Updated knowledge: ${symbol} ${indicator} ${valueRange} → ${outcome} (${existing.confidence})`);
        return existing;
      } else {
        // Create new knowledge
        const newKnowledge = new KnowledgeModel({
          symbol,
          regime,
          indicator,
          valueRange,
          outcome,
          observedCount: 1,
          successCount: confidence > 0.6 ? 1 : 0,
          successRate: confidence > 0.6 ? 1 : 0,
          confidence: confidence,
          session: session || 'all',
          volatilityRegime: volatilityRegime || 'all',
          firstObserved: new Date(),
          lastUpdated: new Date(),
        });
        await newKnowledge.save();
        logger.info(`[KnowledgeStore] New knowledge: ${symbol} ${indicator} ${valueRange} → ${outcome} (${confidence})`);
        return newKnowledge;
      }
    } catch (err) {
      logger.error('[KnowledgeStore] recordKnowledge error:', err.message);
    }
  }

  /**
   * Query knowledge base for a given symbol, regime, indicator, and outcome.
   * Returns the best‑matching knowledge with confidence.
   */
  async getKnowledge(symbol, regime, indicator, value) {
    try {
      // Normalize value into a range string
      const valueRange = this._getValueRange(indicator, value);

      // Query for exact match
      const exact = await KnowledgeModel.findOne({
        symbol,
        regime,
        indicator,
        valueRange,
      }).sort({ confidence: -1 });

      if (exact) {
        return exact;
      }

      // If no exact match, try to find a broader match (without valueRange)
      const broad = await KnowledgeModel.findOne({
        symbol,
        regime,
        indicator,
        // valueRange: { $ne: null } // any value range
      }).sort({ confidence: -1 });

      if (broad) {
        return broad;
      }

      return null;
    } catch (err) {
      logger.error('[KnowledgeStore] getKnowledge error:', err.message);
      return null;
    }
  }

  /**
   * Get all knowledge for a symbol (for dashboard/research).
   */
  async getSymbolKnowledge(symbol, limit = 50) {
    try {
      return await KnowledgeModel.find({ symbol }).sort({ confidence: -1 }).limit(limit);
    } catch (err) {
      logger.error('[KnowledgeStore] getSymbolKnowledge error:', err.message);
      return [];
    }
  }

  /**
   * Store temporary evidence (for real‑time calibration).
   */
  async storeEvidence(evidence) {
    try {
      const ev = new EvidenceModel(evidence);
      await ev.save();
    } catch (err) {
      logger.error('[KnowledgeStore] storeEvidence error:', err.message);
    }
  }

  /**
   * Get recent evidence for a symbol (for research/learning).
   */
  async getRecentEvidence(symbol, limit = 50) {
    try {
      return await EvidenceModel.find({ symbol }).sort({ timestamp: -1 }).limit(limit);
    } catch (err) {
      logger.error('[KnowledgeStore] getRecentEvidence error:', err.message);
      return [];
    }
  }

  /**
   * Calculate a confidence score for a given indicator value, based on historical knowledge.
   */
  async getConfidence(symbol, regime, indicator, value) {
    try {
      const knowledge = await this.getKnowledge(symbol, regime, indicator, value);
      if (knowledge) {
        return knowledge.confidence;
      }
      // If no knowledge, use a default based on indicator type
      return this._defaultConfidence(indicator, value);
    } catch (err) {
      return 0.5;
    }
  }

  /**
   * Helper: convert a numeric value to a range string.
   */
  _getValueRange(indicator, value) {
    if (value === undefined || value === null) return 'unknown';
    // For RSI (0-100)
    if (indicator === 'rsi') {
      if (value < 30) return 'below30';
      if (value < 40) return '30-40';
      if (value < 60) return '40-60';
      if (value < 70) return '60-70';
      return 'above70';
    }
    // For velocity (price change per tick)
    if (indicator === 'velocity') {
      const absVal = Math.abs(value);
      if (absVal < 0.00005) return 'low';
      if (absVal < 0.0001) return 'medium';
      if (absVal < 0.0002) return 'high';
      return 'very_high';
    }
    // For liquidity (0-1)
    if (indicator === 'liquidity') {
      if (value < 0.2) return 'low';
      if (value < 0.5) return 'medium';
      return 'high';
    }
    // For spread
    if (indicator === 'spread') {
      if (value < 0.0002) return 'low';
      if (value < 0.0005) return 'medium';
      return 'high';
    }
    // Default
    return 'any';
  }

  /**
   * Default confidence if no historical knowledge exists.
   */
  _defaultConfidence(indicator, value) {
    // For RSI extremes: higher confidence
    if (indicator === 'rsi') {
      if (value < 30 || value > 70) return 0.65;
      if (value < 40 || value > 60) return 0.55;
      return 0.5;
    }
    // For velocity bursts: higher confidence if large
    if (indicator === 'velocity') {
      if (Math.abs(value) > 0.0002) return 0.6;
      return 0.5;
    }
    // For liquidity: if low, increases uncertainty
    if (indicator === 'liquidity') {
      if (value < 0.2) return 0.45;
      if (value > 0.7) return 0.55;
      return 0.5;
    }
    return 0.5;
  }

  /**
   * Clear all knowledge (for reset/testing).
   */
  async clearAll() {
    await KnowledgeModel.deleteMany({});
    await EvidenceModel.deleteMany({});
    this._cache.clear();
    logger.info('[KnowledgeStore] Cleared all knowledge and evidence.');
  }
}

module.exports = new KnowledgeStore();
