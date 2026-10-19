// core/data/dataOrchestrator.js
// Centralised persistence with class‑based data lifecycle policies.

const mongoose = require('mongoose');

// ---- Data Class Constants ----
const DATA_CLASSES = {
  EPHEMERAL: 'ephemeral',      // never persist
  RECOVERABLE: 'recoverable',  // cache + snapshots
  RESEARCH: 'research',        // append‑only
  BUSINESS: 'business',        // transactional
  KNOWLEDGE: 'knowledge',      // learned behaviour
};

// Valid enum values for HistoricalState
const VALID_REGIME_CODES = [
  'STRONG_TREND_BULL',
  'STRONG_TREND_BEAR',
  'WEAK_TREND',
  'RANGING',
  'BREAKOUT',
  'REVERSAL',
  'HIGH_VOLATILITY',
  'LOW_VOLATILITY',
  'NEUTRAL'
];
const VALID_SOURCE_VALUES = ['live', 'backfill', 'backtest'];

class DataOrchestrator {
  constructor() {
    this._cache = new Map();
    this._snapshotQueue = [];
    this._appendQueue = [];
    this._policies = new Map();
    this._snapshotTimer = null;
    this._appendTimer = null;
    this._recovered = false;

    this._flushSnapshots = this._flushSnapshots.bind(this);
    this._flushAppends = this._flushAppends.bind(this);

    // No need for _startFlushTimers – we use per‑batch timers.
  }

  // ============================================================
  // REGISTRATION
  // ============================================================

  register(key, dataClass, options = {}) {
    if (!Object.values(DATA_CLASSES).includes(dataClass)) {
      throw new Error(`Invalid data class: ${dataClass}`);
    }

    const policy = {
      class: dataClass,
      ttl: options.ttl || this._defaultTTL(dataClass),
      snapshotInterval: options.snapshotInterval || this._defaultSnapshotInterval(dataClass),
      batchSize: options.batchSize || this._defaultBatchSize(dataClass),
      collection: options.collection || null,
      transform: options.transform || null,
    };

    this._policies.set(key, policy);
  }

  _defaultTTL(dataClass) {
    switch (dataClass) {
      case DATA_CLASSES.EPHEMERAL: return 60000;
      case DATA_CLASSES.RECOVERABLE: return 3600000;
      default: return Infinity;
    }
  }

  _defaultSnapshotInterval(dataClass) {
    switch (dataClass) {
      case DATA_CLASSES.RECOVERABLE: return 5000;
      default: return 30000;
    }
  }

  _defaultBatchSize(dataClass) {
    switch (dataClass) {
      case DATA_CLASSES.RESEARCH: return 100;
      default: return 50;
    }
  }

  // ============================================================
  // PUBLISH
  // ============================================================

  publish(key, data, metadata = {}) {
    const policy = this._policies.get(key);
    if (!policy) {
      return;
    }

    const timestamp = Date.now();
    const entry = { data, metadata, timestamp };

    switch (policy.class) {
      case DATA_CLASSES.EPHEMERAL:
        this._handleEphemeral(key, entry, policy);
        break;
      case DATA_CLASSES.RECOVERABLE:
        this._handleRecoverable(key, entry, policy);
        break;
      case DATA_CLASSES.RESEARCH:
        this._handleResearch(key, entry, policy);
        break;
      case DATA_CLASSES.BUSINESS:
        this._handleBusiness(key, entry, policy);
        break;
      case DATA_CLASSES.KNOWLEDGE:
        this._handleKnowledge(key, entry, policy);
        break;
      default:
        // Unknown class – no-op
        break;
    }
  }

  _handleEphemeral(key, entry, policy) {
    this._cache.set(key, { ...entry, policy });
    // No persistence
  }

  _handleRecoverable(key, entry, policy) {
    this._cache.set(key, { ...entry, policy });
    if (policy.collection) {
      this._snapshotQueue.push({ key, data: entry.data, metadata: entry.metadata });
      if (!this._snapshotTimer) {
        this._snapshotTimer = setTimeout(this._flushSnapshots, policy.snapshotInterval);
      }
    }
  }

  _handleResearch(key, entry, policy) {
    this._appendQueue.push({ key, data: entry.data, metadata: entry.metadata });
    if (!this._appendTimer) {
      this._appendTimer = setTimeout(this._flushAppends, 2000);
    }
  }

  _handleBusiness(key, entry, policy) {
    this._persistImmediately(key, entry.data, entry.metadata, policy);
  }

  _handleKnowledge(key, entry, policy) {
    this._persistImmediately(key, entry.data, entry.metadata, policy);
  }

  // ============================================================
  // FLUSH METHODS
  // ============================================================

  async _flushSnapshots() {
    this._snapshotTimer = null;
    if (this._snapshotQueue.length === 0) return;

    const batch = this._snapshotQueue.splice(0, this._snapshotQueue.length);
    const grouped = this._groupByKey(batch);

    for (const [key, items] of grouped) {
      try {
        const policy = this._policies.get(key);
        if (!policy || !policy.collection) continue;

        const collection = this._getCollectionForKey(key);
        if (!collection) {
          continue;
        }

        const latest = items[items.length - 1];
        // For snapshots, data overrides metadata
        const doc = { ...latest.metadata, ...latest.data };
        const query = { symbol: doc.symbol || 'global' };
        await collection.findOneAndUpdate(query, { $set: doc }, { upsert: true });
      } catch (err) {
        // ignore
      }
    }
  }

  async _flushAppends() {
    this._appendTimer = null;
    if (this._appendQueue.length === 0) return;

    const batch = this._appendQueue.splice(0, this._appendQueue.length);
    const grouped = this._groupByKey(batch);

    for (const [key, items] of grouped) {
      try {
        const policy = this._policies.get(key);
        if (!policy) continue;

        const collection = this._getCollectionForKey(key);
        if (!collection) {
          continue;
        }

        // Build documents: data overrides metadata
        const docs = items.map(item => {
          let doc = { ...item.metadata, ...item.data };
          // ---- Sanitize for HistoricalState ----
          if (key === 'historicalState') {
            doc = this._sanitizeHistoricalState(doc);
          }
          // ---- Sanitize for HistoricalDecision ----
          if (key === 'historicalDecision') {
            doc = this._sanitizeHistoricalDecision(doc);
          }
          return doc;
        });

        if (docs.length > 0) {
          await collection.insertMany(docs);
        }
      } catch (err) {
        // ignore
      }
    }
  }

  _groupByKey(items) {
    const groups = new Map();
    for (const item of items) {
      if (!groups.has(item.key)) groups.set(item.key, []);
      groups.get(item.key).push(item);
    }
    return groups;
  }

  // ============================================================
  // SANITIZATION
  // ============================================================

  _sanitizeHistoricalState(doc) {
    // Ensure source is valid
    if (!doc.source || !VALID_SOURCE_VALUES.includes(doc.source)) {
      doc.source = 'live';
    }
    // Ensure regime.code is valid
    if (doc.regime && doc.regime.code) {
      if (!VALID_REGIME_CODES.includes(doc.regime.code)) {
        doc.regime.code = 'NEUTRAL';
        doc.regime.name = 'Neutral / Mixed';
      }
    } else {
      doc.regime = {
        code: 'NEUTRAL',
        name: 'Neutral / Mixed',
        confidence: 50,
        description: '',
      };
    }
    return doc;
  }

  _sanitizeHistoricalDecision(doc) {
    // Ensure any nested objects are not flat values
    // This is a safety net – decisionEngine now passes full nested state
    return doc;
  }

  // ============================================================
  // IMMEDIATE PERSISTENCE
  // ============================================================

  async _persistImmediately(key, data, metadata, policy) {
    try {
      const collection = this._getCollectionForKey(key);
      if (!collection) {
        return;
      }

      // data overrides metadata
      const doc = { ...metadata, ...data };

      if (doc._id) {
        await collection.updateOne({ _id: doc._id }, { $set: doc });
      } else {
        await collection.create(doc);
      }
    } catch (err) {
      // ignore
    }
  }

  // ============================================================
  // COLLECTION MAPPING
  // ============================================================

  _getCollectionForKey(key) {
    switch (key) {
      case 'historicalState':
        return require('../../models/HistoricalState');
      case 'historicalDecision':
        return require('../../models/HistoricalDecision');
      case 'historicalOutcome':
        return require('../../models/HistoricalOutcome');
      case 'learningState':
        return require('../../models/LearningState');
      case 'trade':
        return require('../../models/Trade');
      case 'order':
        return require('../../models/Order');
      case 'user':
        return require('../../models/User');
      case 'apiKey':
        return require('../../models/ApiKey');
      default:
        return null;
    }
  }

  // ============================================================
  // RECOVERY
  // ============================================================

  async recover() {
    if (this._recovered) return;

    try {
      await this._loadRecoverableState();
      await this._loadBusinessState();
      await this._loadKnowledgeState();

      this._recovered = true;
    } catch (err) {
      // ignore
    }
  }

  async _loadRecoverableState() {
    // No DB loading for marketState – rebuilt from candles/awareness
  }

  async _loadBusinessState() {
    // Placeholder
  }

  async _loadKnowledgeState() {
    try {
      const LearningState = require('../../models/LearningState');
      const weights = await LearningState.find({});
      if (weights.length > 0) {
        this._cache.set('learningWeights', {
          data: weights,
          metadata: { restored: true },
          timestamp: Date.now(),
          policy: this._policies.get('learningState'),
        });
      }
    } catch (err) {
      // ignore
    }
  }

  // ============================================================
  // CACHE ACCESS
  // ============================================================

  get(key) {
    const entry = this._cache.get(key);
    if (!entry) return null;
    const policy = this._policies.get(key);
    if (policy && policy.ttl < Infinity) {
      const age = Date.now() - entry.timestamp;
      if (age > policy.ttl) {
        this._cache.delete(key);
        return null;
      }
    }
    return entry.data;
  }

  getCacheStats() {
    const stats = {};
    for (const [key, entry] of this._cache) {
      stats[key] = {
        age: Date.now() - entry.timestamp,
        hasPolicy: this._policies.has(key),
      };
    }
    return stats;
  }

  // ============================================================
  // SHUTDOWN
  // ============================================================

  async shutdown() {
    if (this._snapshotTimer) {
      clearTimeout(this._snapshotTimer);
      await this._flushSnapshots();
    }
    if (this._appendTimer) {
      clearTimeout(this._appendTimer);
      await this._flushAppends();
    }
  }
}

// ---- Singleton ----
const dataOrchestrator = new DataOrchestrator();

// ---- Export ----
module.exports = {
  DataOrchestrator,
  dataOrchestrator,
  DATA_CLASSES,
};
