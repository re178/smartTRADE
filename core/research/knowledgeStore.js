// core/research/knowledgeStore.js
// Knowledge Store – manages validated observations and knowledge.
// Extends EventEmitter to broadcast updates.

const mongoose = require('mongoose');
const EventEmitter = require('events');
const logger = require('../../infrastructure/logger') || console;

// ----- Knowledge Schema -----
const KnowledgeSchema = new mongoose.Schema({
  symbol: { type: String, required: true, index: true },
  regime: { type: String, required: true },
  indicator: { type: String, required: true },
  valueRange: { type: String, required: true },
  outcome: { type: String, required: true },
  observedCount: { type: Number, default: 0 },
  successCount: { type: Number, default: 0 },
  successRate: { type: Number, default: 0 },
  confidence: { type: Number, default: 0.5 },
  session: { type: String, default: 'all' },
  volatilityRegime: { type: String, default: 'all' },
  firstObserved: { type: Date, default: Date.now },
  lastUpdated: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: null },
});

KnowledgeSchema.index({ symbol: 1, regime: 1, indicator: 1, outcome: 1 });
KnowledgeSchema.index({ confidence: -1 });

const KnowledgeModel = mongoose.model('Knowledge', KnowledgeSchema);

// ----- Evidence Schema (temporary) -----
const EvidenceSchema = new mongoose.Schema({
  symbol: { type: String, required: true, index: true },
  indicator: { type: String, required: true },
  value: { type: Number, required: true },
  timestamp: { type: Date, default: Date.now, expires: 3600 },
  source: { type: String, default: 'awareness' },
});

const EvidenceModel = mongoose.model('Evidence', EvidenceSchema);

// ----- KnowledgeStore Class (extends EventEmitter) -----
class KnowledgeStore extends EventEmitter {
  constructor() {
    super();
    this._cache = new Map();
    this._cacheTTL = 60000;
    this._lastCacheRefresh = Date.now();
  }

  async recordKnowledge(knowledge) {
    try {
      const { symbol, regime, indicator, valueRange, outcome, confidence, session, volatilityRegime } = knowledge;

      const existing = await KnowledgeModel.findOne({
        symbol,
        regime,
        indicator,
        valueRange,
        outcome,
      });

      if (existing) {
        existing.observedCount += 1;
        existing.successCount += (confidence > 0.6 ? 1 : 0);
        existing.successRate = existing.successCount / existing.observedCount;
        existing.confidence = (existing.confidence * 0.9) + (confidence * 0.1);
        existing.lastUpdated = new Date();
        await existing.save();
        logger.debug(`[KnowledgeStore] Updated knowledge: ${symbol} ${indicator} ${valueRange} → ${outcome} (${existing.confidence})`);
        this.emit('knowledgeUpdated', existing);
        return existing;
      } else {
        const newKnowledge = new KnowledgeModel({
          symbol,
          regime,
          indicator,
          valueRange,
          outcome,
          observedCount: 1,
          successCount: confidence > 0.6 ? 1 : 0,
          successRate: confidence > 0.6 ? 1 : 0,
          confidence,
          session: session || 'all',
          volatilityRegime: volatilityRegime || 'all',
          firstObserved: new Date(),
          lastUpdated: new Date(),
        });
        await newKnowledge.save();
        logger.info(`[KnowledgeStore] New knowledge: ${symbol} ${indicator} ${valueRange} → ${outcome} (${confidence})`);
        this.emit('knowledgeUpdated', newKnowledge);
        return newKnowledge;
      }
    } catch (err) {
      logger.error('[KnowledgeStore] recordKnowledge error:', err.message);
    }
  }

  async getKnowledge(symbol, regime, indicator, value) {
    try {
      const valueRange = this._getValueRange(indicator, value);
      const exact = await KnowledgeModel.findOne({
        symbol,
        regime,
        indicator,
        valueRange,
      }).sort({ confidence: -1 });
      if (exact) return exact;
      const broad = await KnowledgeModel.findOne({
        symbol,
        regime,
        indicator,
      }).sort({ confidence: -1 });
      if (broad) return broad;
      return null;
    } catch (err) {
      logger.error('[KnowledgeStore] getKnowledge error:', err.message);
      return null;
    }
  }

  async getSymbolKnowledge(symbol, limit = 50) {
    try {
      return await KnowledgeModel.find({ symbol }).sort({ confidence: -1 }).limit(limit);
    } catch (err) {
      logger.error('[KnowledgeStore] getSymbolKnowledge error:', err.message);
      return [];
    }
  }

  async storeEvidence(evidence) {
    try {
      const ev = new EvidenceModel(evidence);
      await ev.save();
    } catch (err) {
      logger.error('[KnowledgeStore] storeEvidence error:', err.message);
    }
  }

  async getRecentEvidence(symbol, limit = 50) {
    try {
      return await EvidenceModel.find({ symbol }).sort({ timestamp: -1 }).limit(limit);
    } catch (err) {
      logger.error('[KnowledgeStore] getRecentEvidence error:', err.message);
      return [];
    }
  }

  async getConfidence(symbol, regime, indicator, value) {
    try {
      const knowledge = await this.getKnowledge(symbol, regime, indicator, value);
      if (knowledge) return knowledge.confidence;
      return this._defaultConfidence(indicator, value);
    } catch (err) {
      return 0.5;
    }
  }

  _getValueRange(indicator, value) {
    if (value === undefined || value === null) return 'unknown';
    if (indicator === 'rsi') {
      if (value < 30) return 'below30';
      if (value < 40) return '30-40';
      if (value < 60) return '40-60';
      if (value < 70) return '60-70';
      return 'above70';
    }
    if (indicator === 'velocity') {
      const absVal = Math.abs(value);
      if (absVal < 0.00005) return 'low';
      if (absVal < 0.0001) return 'medium';
      if (absVal < 0.0002) return 'high';
      return 'very_high';
    }
    if (indicator === 'liquidity') {
      if (value < 0.2) return 'low';
      if (value < 0.5) return 'medium';
      return 'high';
    }
    if (indicator === 'spread') {
      if (value < 0.0002) return 'low';
      if (value < 0.0005) return 'medium';
      return 'high';
    }
    return 'any';
  }

  _defaultConfidence(indicator, value) {
    if (indicator === 'rsi') {
      if (value < 30 || value > 70) return 0.65;
      if (value < 40 || value > 60) return 0.55;
      return 0.5;
    }
    if (indicator === 'velocity') {
      if (Math.abs(value) > 0.0002) return 0.6;
      return 0.5;
    }
    if (indicator === 'liquidity') {
      if (value < 0.2) return 0.45;
      if (value > 0.7) return 0.55;
      return 0.5;
    }
    return 0.5;
  }

  async clearAll() {
    await KnowledgeModel.deleteMany({});
    await EvidenceModel.deleteMany({});
    this._cache.clear();
    logger.info('[KnowledgeStore] Cleared all knowledge and evidence.');
  }
}

// Export a singleton instance
module.exports = new KnowledgeStore();
