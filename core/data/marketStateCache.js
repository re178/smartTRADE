// core/data/marketStateCache.js
// RAM‑first market state cache, periodically persisted to MongoDB.

const mongoose = require('mongoose');
const logger = require('../../infrastructure/logger') || console;

// Schema for persistent market state
const StateSchema = new mongoose.Schema({
  symbol: { type: String, unique: true, required: true },
  trend: String,
  momentum: Number,
  volatility: Number,
  liquidity: Number,
  spread: Number,
  velocity: Number,
  acceleration: Number,
  regime: String,
  confidence: Number,
  lastUpdated: { type: Date, default: Date.now },
});

const StateModel = mongoose.model('MarketState', StateSchema);

class MarketStateCache {
  constructor() {
    // In‑memory store
    this._cache = new Map(); // symbol -> state object
    this._persistInterval = 250; // ms
    this._dirty = new Set();
    this._timer = null;

    // Load initial states from DB
    this._loadFromDB();

    // Start periodic persistence
    this._startPersistence();
  }

  async _loadFromDB() {
    try {
      const states = await StateModel.find({});
      for (const s of states) {
        const obj = s.toObject();
        this._cache.set(obj.symbol, obj);
      }
      logger.info(`[MarketStateCache] Loaded ${this._cache.size} states from DB.`);
    } catch (err) {
      logger.error('[MarketStateCache] DB load error:', err.message);
    }
  }

  /**
   * Get state for a symbol. If not exists, create a default.
   */
  get(symbol) {
    if (!this._cache.has(symbol)) {
      this._cache.set(symbol, this._defaultState(symbol));
    }
    return this._cache.get(symbol);
  }

  /**
   * Update state for a symbol.
   */
  update(symbol, updates) {
    const state = this.get(symbol);
    Object.assign(state, updates);
    state.lastUpdated = new Date();
    this._dirty.add(symbol);
  }

  /**
   * Periodic persistence to MongoDB.
   */
  _startPersistence() {
    if (this._timer) return;
    this._timer = setInterval(async () => {
      if (this._dirty.size === 0) return;
      const symbols = Array.from(this._dirty);
      this._dirty.clear();
      for (const symbol of symbols) {
        try {
          const state = this._cache.get(symbol);
          if (!state) continue;
          await StateModel.updateOne(
            { symbol },
            { $set: state },
            { upsert: true }
          );
        } catch (err) {
          logger.error(`[MarketStateCache] Persist error for ${symbol}:`, err.message);
          // Re‑add to dirty set for retry
          this._dirty.add(symbol);
        }
      }
    }, this._persistInterval);
  }

  _defaultState(symbol) {
    return {
      symbol,
      trend: 'neutral',
      momentum: 0,
      volatility: 0.5,
      liquidity: 0.5,
      spread: 0,
      velocity: 0,
      acceleration: 0,
      regime: 'unknown',
      confidence: 0,
      lastUpdated: new Date(),
    };
  }

  /**
   * Get all states (for dashboard or other services).
   */
  getAll() {
    const result = {};
    for (const [symbol, state] of this._cache) {
      result[symbol] = state;
    }
    return result;
  }

  /**
   * Clear cache and DB (reset).
   */
  async clear() {
    this._cache.clear();
    this._dirty.clear();
    await StateModel.deleteMany({});
    logger.info('[MarketStateCache] Cleared.');
  }
}

module.exports = new MarketStateCache();
