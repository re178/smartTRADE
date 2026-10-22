// core/data/dataOrchestrator.js
// Centralised persistence with class-based data lifecycle policies.
//
// [FILE-8A] _getCollectionForKey gains 'marketState' and 'regimeChange'.
//   Without these, marketStateCache snapshots and regime.js regime changes
//   were silently dropped at flush time.
// [FILE-8B] _resolveModel helper tries the switch first, then policy.collection
//   by name (case + plural tolerant). Handles 'marketstate' vs 'MarketState'
//   vs 'marketstates' inconsistencies across callers.
// [FILE-8C] _resolveModelByName inspects mongoose.models at call time so
//   models loaded after this file still resolve.
// [FILE-8D] Cache key aliasing: learningState ↔ learningWeights. learner.js
//   writes 'learningState' but reads 'learningWeights'.
// [FILE-8E] publish() logs unregistered keys (once per key) instead of
//   silently dropping.
// [FILE-8F] Every save failure logs with the key. Was '// ignore' before,
//   which masked every persistence failure in the pipeline.
// [FILE-8G] _persistImmediately uses upsert so the _id-present branch works
//   even when the doc doesn't exist yet.
// [FILE-8H] Writes bypass Mongoose strict mode via model.collection.* —
//   required because regimeChange and marketState publish nested shapes
//   that the target schemas don't fully declare.
// [FILE-8I] insertMany({ ordered: false }) — one bad doc no longer aborts
//   the whole batch.
// [FILE-8J] _sanitizeHistoricalState logs regime-code coercion.
// [FILE-8K] _loadKnowledgeState writes under both learningState and
//   learningWeights.
// [FILE-8L] recover() logs failures instead of swallowing.
// [FILE-8M] get() honours aliases.

const mongoose = require('mongoose');

const DATA_CLASSES = {
  EPHEMERAL: 'ephemeral',
  RECOVERABLE: 'recoverable',
  RESEARCH: 'research',
  BUSINESS: 'business',
  KNOWLEDGE: 'knowledge',
};

const VALID_REGIME_CODES = [
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
const VALID_SOURCE_VALUES = ['live', 'backfill', 'backtest'];

// [FILE-8D] Cache key aliases
const CACHE_KEY_ALIASES = {
  learningState: ['learningWeights'],
  learningWeights: ['learningState'],
};

class DataOrchestrator {
  constructor() {
    this._cache = new Map();
    this._snapshotQueue = [];
    this._appendQueue = [];
    this._policies = new Map();
    this._snapshotTimer = null;
    this._appendTimer = null;
    this._recovered = false;
    this._warnedKeys = new Set();

    this._flushSnapshots = this._flushSnapshots.bind(this);
    this._flushAppends = this._flushAppends.bind(this);
  }

  _warnOnce(key, message) {
    if (this._warnedKeys.has(key)) return;
    this._warnedKeys.add(key);
    console.warn(message);
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
      // [FILE-8E] Log once per unregistered key
      this._warnOnce(
        `no-policy-${key}`,
        `[Orchestrator] publish('${key}') called but key is not registered — data dropped. ` +
        `Add dataOrchestrator.register('${key}', ...) at module load time.`
      );
      return;
    }

    const timestamp = Date.now();
    const entry = { data, metadata, timestamp };

    // [FILE-8D] Aliasing — write to all alias keys too
    const aliases = CACHE_KEY_ALIASES[key];
    if (aliases) {
      for (const alias of aliases) {
        this._cache.set(alias, entry);
      }
    }

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
        break;
    }
  }

  _handleEphemeral(key, entry, policy) {
    this._cache.set(key, { ...entry, policy });
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
  // MODEL RESOLUTION
  // ============================================================
  // [FILE-8B] Resolve model: deterministic switch first, then by name.
  _resolveModel(key, policy) {
    const byKey = this._getCollectionForKey(key);
    if (byKey) return byKey;

    if (policy?.collection) {
      const byName = this._resolveModelByName(policy.collection);
      if (byName) return byName;
    }
    return null;
  }

  // [FILE-8C] Case + plural tolerant name lookup, done at call time.
  _resolveModelByName(name) {
    if (!name) return null;

    // Try direct model-name matches with various casings
    const candidates = new Set([
      name,
      name.charAt(0).toUpperCase() + name.slice(1),
      name.toLowerCase(),
    ]);
    for (const candidate of candidates) {
      if (mongoose.models[candidate]) return mongoose.models[candidate];
    }

    // Try collection-name match — case-insensitive, singular/plural tolerant
    const lowerName = name.toLowerCase();
    const stemName = lowerName.replace(/s$/, '');
    for (const model of Object.values(mongoose.models)) {
      try {
        const coll = (model.collection?.collectionName || '').toLowerCase();
        if (coll === lowerName) return model;
        if (coll.replace(/s$/, '') === stemName) return model;
      } catch (_) {
        // ignore — some models may not have a collection yet
      }
    }

    return null;
  }

  // ============================================================
  // FLUSH
  // ============================================================
  async _flushSnapshots() {
    this._snapshotTimer = null;
    if (this._snapshotQueue.length === 0) return;

    const batch = this._snapshotQueue.splice(0, this._snapshotQueue.length);
    const grouped = this._groupByKey(batch);

    for (const [key, items] of grouped) {
      const policy = this._policies.get(key);
      if (!policy) continue;

      const model = this._resolveModel(key, policy);
      if (!model) {
        // [FILE-8F] Log instead of silently skipping
        this._warnOnce(
          `no-model-snapshot-${key}`,
          `[Orchestrator] Snapshot flush skipped for '${key}' — no model resolved ` +
          `(policy.collection='${policy.collection}')`
        );
        continue;
      }

      try {
        const latest = items[items.length - 1];
        const doc = { ...latest.metadata, ...latest.data };
        const query = { symbol: doc.symbol || 'global' };

        // [FILE-8H] Bypass strict mode so nested fields persist
        await model.collection.findOneAndUpdate(
          query,
          { $set: doc },
          { upsert: true }
        );
      } catch (err) {
        // [FILE-8F] Log with key
        console.warn(`[Orchestrator] Snapshot save failed for '${key}': ${err.message}`);
      }
    }
  }

  async _flushAppends() {
    this._appendTimer = null;
    if (this._appendQueue.length === 0) return;

    const batch = this._appendQueue.splice(0, this._appendQueue.length);
    const grouped = this._groupByKey(batch);

    for (const [key, items] of grouped) {
      const policy = this._policies.get(key);
      if (!policy) continue;

      const model = this._resolveModel(key, policy);
      if (!model) {
        this._warnOnce(
          `no-model-append-${key}`,
          `[Orchestrator] Append flush skipped for '${key}' — no model resolved`
        );
        continue;
      }

      try {
        const docs = items.map(item => {
          let doc = { ...item.metadata, ...item.data };
          if (key === 'historicalState') {
            doc = this._sanitizeHistoricalState(doc);
          }
          if (key === 'historicalDecision') {
            doc = this._sanitizeHistoricalDecision(doc);
          }
          return doc;
        });

        if (docs.length > 0) {
          // [FILE-8H/I] Collection insert bypasses schema strict, ordered:false
          await model.collection.insertMany(docs, { ordered: false });
        }
      } catch (err) {
        // [FILE-8F] Log with key
        console.warn(`[Orchestrator] Append save failed for '${key}': ${err.message}`);
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
    if (!doc.source || !VALID_SOURCE_VALUES.includes(doc.source)) {
      doc.source = 'live';
    }
    if (doc.regime && doc.regime.code) {
      if (!VALID_REGIME_CODES.includes(doc.regime.code)) {
        // [FILE-8J] Log which code was coerced
        console.warn(
          `[Orchestrator] Coerced unknown regime code '${doc.regime.code}' → 'NEUTRAL' ` +
          `(symbol=${doc.symbol}, timeframe=${doc.timeframe})`
        );
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
    return doc;
  }

  // ============================================================
  // IMMEDIATE PERSISTENCE
  // ============================================================
  async _persistImmediately(key, data, metadata, policy) {
    try {
      const model = this._resolveModel(key, policy);
      if (!model) {
        this._warnOnce(
          `no-model-immediate-${key}`,
          `[Orchestrator] Immediate save skipped for '${key}' — no model resolved`
        );
        return;
      }

      const doc = { ...metadata, ...data };

      if (doc._id) {
        // [FILE-8G] Add upsert — was silently no-op'ing on missing docs
        // [FILE-8H] Collection method bypasses strict mode
        await model.collection.updateOne(
          { _id: doc._id },
          { $set: doc },
          { upsert: true }
        );
      } else {
        // [FILE-8H] insertOne bypasses strict mode
        await model.collection.insertOne(doc);
      }
    } catch (err) {
      // [FILE-8F] Log with key
      console.warn(`[Orchestrator] Immediate save failed for '${key}': ${err.message}`);
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
      case 'marketState':
        // [FILE-8A] marketState is registered by both marketStateCache
        // (collection: 'MarketState') and deep/marketState (collection:
        // 'marketstate'). Resolve the MarketState model — it's defined
        // inline in marketStateCache.js, so it should be in mongoose.models.
        if (mongoose.models.MarketState) return mongoose.models.MarketState;
        try {
          return require('../../models/MarketState');
        } catch (_) {
          return null;
        }
      case 'regimeChange':
        // [FILE-8A] Regime changes are historical-state-shaped docs.
        return require('../../models/HistoricalState');
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
      // [FILE-8L] Log so failures are visible
      console.warn(`[Orchestrator] recover() failed: ${err.message}`);
    }
  }

  async _loadRecoverableState() {
    // No DB loading for marketState — consumers load their own state
    // (marketStateCache reads StateModel directly at boot; deep/marketState
    // rebuilds buffers from candles on first compute).
  }

  async _loadBusinessState() {
    // Placeholder
  }

  async _loadKnowledgeState() {
    try {
      const LearningState = require('../../models/LearningState');
      const weights = await LearningState.find({});
      if (weights.length > 0) {
        const entry = {
          data: weights,
          metadata: { restored: true },
          timestamp: Date.now(),
          policy: this._policies.get('learningState'),
        };
        // [FILE-8K] Write under both names
        this._cache.set('learningState', entry);
        this._cache.set('learningWeights', entry);
      }
    } catch (err) {
      // [FILE-8L] Log
      console.warn(`[Orchestrator] _loadKnowledgeState failed: ${err.message}`);
    }
  }

  // ============================================================
  // CACHE ACCESS
  // ============================================================
  get(key) {
    let entry = this._cache.get(key);

    // [FILE-8M] Alias fallback
    if (!entry) {
      const aliases = CACHE_KEY_ALIASES[key];
      if (aliases) {
        for (const alias of aliases) {
          const aliased = this._cache.get(alias);
          if (aliased) { entry = aliased; break; }
        }
      }
    }

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
