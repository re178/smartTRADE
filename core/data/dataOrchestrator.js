// core/data/dataOrchestrator.js
// Centralised persistence with class‑based data lifecycle policies.
// Five data classes:
//   EPHEMERAL  – never persist (recomputed on restart)
//   RECOVERABLE – cached + periodic snapshots (survives restart)
//   RESEARCH   – append‑only (never overwritten)
//   BUSINESS   – transactional (immediate persistence)
//   KNOWLEDGE  – learned behaviour (persisted on change)

const mongoose = require('mongoose');
const logger = require('../../infrastructure/logger') || console;

// ---- Data Class Constants ----
const DATA_CLASSES = {
  EPHEMERAL: 'ephemeral',      // never persist
  RECOVERABLE: 'recoverable',  // cache + snapshots
  RESEARCH: 'research',        // append‑only
  BUSINESS: 'business',        // transactional
  KNOWLEDGE: 'knowledge',      // learned behaviour
};

// ---- Default Policies ----
const DEFAULT_POLICIES = {
  // Key: { class, ttl (ms), snapshotInterval (ms), batchSize, collection }
  // These will be registered by modules that use the orchestrator.
};

class DataOrchestrator {
  constructor() {
    // In‑memory cache for ephemeral and recoverable data
    this._cache = new Map(); // key → { data, metadata, timestamp, policy }

    // Queues for batched writes
    this._snapshotQueue = [];    // recoverable data (upsert)
    this._appendQueue = [];      // research data (insert)

    // Policies registry
    this._policies = new Map();  // key → policy

    // Scheduling timers
    this._snapshotTimer = null;
    this._appendTimer = null;

    // Recovery state
    this._recovered = false;

    // Bind methods
    this._flushSnapshots = this._flushSnapshots.bind(this);
    this._flushAppends = this._flushAppends.bind(this);

    // Start flush timers
    this._startFlushTimers();

    logger.info('[DataOrchestrator] Initialized.');
  }

  // ============================================================
  // REGISTRATION
  // ============================================================

  /**
   * Register a data stream with its lifecycle policy.
   * @param {string} key - Unique identifier (e.g., 'marketState', 'historicalState')
   * @param {string} dataClass - One of DATA_CLASSES values
   * @param {Object} options - Additional options
   * @param {number} options.ttl - Time‑to‑live in cache (ms)
   * @param {number} options.snapshotInterval - How often to snapshot (ms)
   * @param {number} options.batchSize - Max items per batch write
   * @param {string} options.collection - MongoDB collection name (if applicable)
   * @param {Function} options.transform - Optional transform function before storage
   */
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
    logger.debug(`[DataOrchestrator] Registered key: ${key} (${dataClass})`);
  }

  _defaultTTL(dataClass) {
    switch (dataClass) {
      case DATA_CLASSES.EPHEMERAL: return 60000;     // 1 minute
      case DATA_CLASSES.RECOVERABLE: return 3600000; // 1 hour
      case DATA_CLASSES.RESEARCH: return Infinity;
      case DATA_CLASSES.BUSINESS: return Infinity;
      case DATA_CLASSES.KNOWLEDGE: return Infinity;
      default: return 60000;
    }
  }

  _defaultSnapshotInterval(dataClass) {
    switch (dataClass) {
      case DATA_CLASSES.RECOVERABLE: return 5000;   // 5 seconds
      default: return 30000;                        // 30 seconds
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

  /**
   * Publish a state update.
   * @param {string} key - Registered key
   * @param {*} data - The data to store
   * @param {Object} metadata - Additional metadata (timestamp, source, etc.)
   */
  publish(key, data, metadata = {}) {
    const policy = this._policies.get(key);
    if (!policy) {
      logger.warn(`[DataOrchestrator] No policy registered for key: ${key}`);
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
        logger.warn(`[DataOrchestrator] Unknown class for key ${key}`);
    }
  }

  // ---- Handlers ----
  _handleEphemeral(key, entry, policy) {
    // Store in cache with TTL
    this._cache.set(key, { ...entry, policy });
    // No persistence
  }

  _handleRecoverable(key, entry, policy) {
    // Store in cache
    this._cache.set(key, { ...entry, policy });
    // Queue for snapshot
    this._snapshotQueue.push({ key, data: entry.data, metadata: entry.metadata });
    // Schedule flush if not already scheduled
    if (!this._snapshotTimer) {
      this._snapshotTimer = setTimeout(this._flushSnapshots, policy.snapshotInterval);
    }
  }

  _handleResearch(key, entry, policy) {
    // Append to queue
    this._appendQueue.push({ key, data: entry.data, metadata: entry.metadata });
    // Schedule flush
    if (!this._appendTimer) {
      this._appendTimer = setTimeout(this._flushAppends, 2000); // flush every 2 seconds for research data
    }
  }

  _handleBusiness(key, entry, policy) {
    // Immediate persistence
    this._persistImmediately(key, entry.data, entry.metadata, policy);
  }

  _handleKnowledge(key, entry, policy) {
    // Similar to business – immediate persistence (or upsert)
    this._persistImmediately(key, entry.data, entry.metadata, policy);
  }

  // ============================================================
  // FLUSH METHODS (Batched Writes)
  // ============================================================

  async _flushSnapshots() {
    this._snapshotTimer = null;
    if (this._snapshotQueue.length === 0) return;

    const batch = this._snapshotQueue.splice(0, this._snapshotQueue.length);
    const grouped = this._groupByKey(batch);

    for (const [key, items] of grouped) {
      try {
        const policy = this._policies.get(key);
        if (!policy) continue;

        // We need to know which collection to write to.
        // For recoverable data, we use the model mapped by key.
        // We'll use a switch based on key for now, but this should be configurable.
        const collection = this._getCollectionForKey(key);
        if (!collection) {
          logger.warn(`[DataOrchestrator] No collection for recoverable key: ${key}`);
          continue;
        }

        // Use the latest item (most recent) – recoverable data is a snapshot.
        const latest = items[items.length - 1];
        const query = { symbol: latest.data.symbol || 'global' };
        const update = { $set: latest.data };
        await collection.findOneAndUpdate(query, update, { upsert: true });

        logger.debug(`[DataOrchestrator] Snapshot flushed for ${key}`);
      } catch (err) {
        logger.error(`[DataOrchestrator] Error flushing snapshot for ${key}:`, err.message);
        // Re‑queue if failed? For now, just log.
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
          logger.warn(`[DataOrchestrator] No collection for research key: ${key}`);
          continue;
        }

        // Insert all items
        const docs = items.map(item => ({
          ...item.data,
          ...item.metadata,
        }));
        await collection.insertMany(docs);

        logger.debug(`[DataOrchestrator] Appended ${docs.length} items for ${key}`);
      } catch (err) {
        logger.error(`[DataOrchestrator] Error flushing append for ${key}:`, err.message);
        // Re‑queue? For now, just log.
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
  // IMMEDIATE PERSISTENCE
  // ============================================================

  async _persistImmediately(key, data, metadata, policy) {
    try {
      const collection = this._getCollectionForKey(key);
      if (!collection) {
        logger.warn(`[DataOrchestrator] No collection for business/key: ${key}`);
        return;
      }

      // For business data, we assume data is ready to be saved.
      // If it's an update, we need to know the query.
      // We'll use a generic approach: if data has _id, update; else insert.
      if (data._id) {
        await collection.updateOne({ _id: data._id }, { $set: data });
      } else {
        await collection.create(data);
      }
      logger.debug(`[DataOrchestrator] Persisted immediately for ${key}`);
    } catch (err) {
      logger.error(`[DataOrchestrator] Error persisting ${key}:`, err.message);
    }
  }

  // ============================================================
  // COLLECTION MAPPING
  // ============================================================

  /**
   * Get the Mongoose model for a given key.
   * This is a simple mapping – can be extended.
   */
  _getCollectionForKey(key) {
    // Import models lazily to avoid circular dependencies
    switch (key) {
      case 'marketState':
        return require('../../models/MarketState')?.default || require('../../models/MarketState');
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

  /**
   * Recover state on startup.
   * @returns {Promise<void>}
   */
  async recover() {
    if (this._recovered) return;

    logger.info('[DataOrchestrator] Starting recovery...');

    try {
      // 1. Load recoverable state from snapshots (latest per key)
      // We'll load marketState, etc.
      await this._loadRecoverableState();

      // 2. Load business data (trades, orders, etc.)
      await this._loadBusinessState();

      // 3. Load knowledge (learning weights)
      await this._loadKnowledgeState();

      this._recovered = true;
      logger.info('[DataOrchestrator] Recovery complete.');
    } catch (err) {
      logger.error('[DataOrchestrator] Recovery error:', err.message);
      // Continue anyway – system will rebuild from fresh data.
    }
  }

  async _loadRecoverableState() {
    // Load marketState from MarketState model
    try {
      const MarketState = require('../../models/MarketState');
      const states = await MarketState.find({});
      for (const state of states) {
        this._cache.set(`marketState:${state.symbol}`, {
          data: state.toObject(),
          metadata: { restored: true },
          timestamp: Date.now(),
          policy: this._policies.get('marketState'),
        });
      }
      logger.info(`[DataOrchestrator] Loaded ${states.length} market states from DB.`);
    } catch (err) {
      // If model doesn't exist yet, skip.
      logger.debug('[DataOrchestrator] MarketState model not ready.');
    }
  }

  async _loadBusinessState() {
    // Load trades, orders if needed – not required for basic recovery.
    // This can be extended.
  }

  async _loadKnowledgeState() {
    // Load learning weights
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
        logger.info(`[DataOrchestrator] Loaded ${weights.length} learning weights.`);
      }
    } catch (err) {
      // Ignore if model not ready
    }
  }

  // ============================================================
  // CACHE ACCESS
  // ============================================================

  /**
   * Get data from cache.
   * @param {string} key - Cache key
   * @returns {*} Data or null
   */
  get(key) {
    const entry = this._cache.get(key);
    if (!entry) return null;
    // Check TTL
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

  /**
   * Get all cached keys for debugging.
   */
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
  // FLUSH TIMERS
  // ============================================================

  _startFlushTimers() {
    // We use setInterval to flush snapshots periodically, but we already use setTimeout per batch.
    // We'll just rely on the per‑batch timers.
  }

  // ============================================================
  // SHUTDOWN / CLEANUP
  // ============================================================

  /**
   * Graceful shutdown – flush remaining queues.
   */
  async shutdown() {
    logger.info('[DataOrchestrator] Shutting down...');
    if (this._snapshotTimer) {
      clearTimeout(this._snapshotTimer);
      await this._flushSnapshots();
    }
    if (this._appendTimer) {
      clearTimeout(this._appendTimer);
      await this._flushAppends();
    }
    logger.info('[DataOrchestrator] Shutdown complete.');
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
