// core/data/marketStateCache.js
// RAM‑first market state cache, with persistence via Data Orchestrator.
// Previously wrote directly to MongoDB; now delegates to the orchestrator
// for both recoverable state (snapshots) and research data (append‑only).

const mongoose = require('mongoose');
const { dataOrchestrator, DATA_CLASSES } = require('./dataOrchestrator');
const logger = require('../../infrastructure/logger') || console;

// Schema for persistent market state (kept for backward compatibility)
// But we no longer write to it directly – orchestrator handles it.
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
    this._dirty = new Set();
    this._timer = null;

    // ---- Register with Data Orchestrator ----
    // Recoverable state: marketState (snapshots)
    dataOrchestrator.register('marketState', DATA_CLASSES.RECOVERABLE, {
      snapshotInterval: 5000, // 5 seconds
      collection: 'MarketState',
    });

    // ---- Load initial states from DB ----
    this._loadFromDB();

    // We no longer need the periodic timer – orchestrator handles flushing.
    // We keep the timer for backward compatibility but it's a no‑op.
    this._startPersistence();
  }

  async _loadFromDB() {
    try {
      // Try to load from orchestrator first (it may have recovered from DB)
      const recovered = dataOrchestrator.get('marketState');
      if (recovered) {
        // If orchestrator has cached data, use it
        if (Array.isArray(recovered)) {
          for (const state of recovered) {
            this._cache.set(state.symbol, state);
          }
          logger.info(`[MarketStateCache] Loaded ${this._cache.size} states from orchestrator.`);
          return;
        }
      }

      // Fallback: load directly from DB (for backward compatibility)
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
   * Publishes to Data Orchestrator for both recoverable and research storage.
   */
  update(symbol, updates) {
    const state = this.get(symbol);
    Object.assign(state, updates);
    state.lastUpdated = new Date();
    this._dirty.add(symbol);

    // ---- Publish to Data Orchestrator ----
    // 1. Recoverable state (snapshot)
    dataOrchestrator.publish('marketState', {
      symbol: state.symbol,
      trend: state.trend,
      momentum: state.momentum,
      volatility: state.volatility,
      liquidity: state.liquidity,
      spread: state.spread,
      velocity: state.velocity,
      acceleration: state.acceleration,
      regime: state.regime,
      confidence: state.confidence,
      lastUpdated: state.lastUpdated,
    }, {
      source: 'marketStateCache',
      timestamp: Date.now(),
    });

    // 2. Research data (append‑only) – if we have deep features
    // This ensures every state update is preserved for research.
    // We check if we have enough data to be useful for research.
    if (state.trend || state.volatility || state.liquidity) {
      dataOrchestrator.publish('historicalState', {
        symbol: state.symbol,
        timeframe: 'M5', // default – will be refined by deepMarketState
        timestamp: state.lastUpdated || new Date(),
        price: { current: state.mid || 0 },
        trend: {
          direction: state.trend || 'neutral',
          strength: typeof state.momentum === 'number' ? state.momentum : 0,
          adx: 0, // will be filled by deepMarketState
        },
        momentum: {
          rsi: typeof state.momentum === 'number' ? state.momentum : 50,
          velocity: state.velocity || 0,
          acceleration: state.acceleration || 0,
        },
        volatility: {
          atr: 0, // will be filled by deepMarketState
          atrPercent: 0,
          bbWidth: 0,
          regime: state.volatility ? (state.volatility > 0.7 ? 'high' : 'low') : 'normal',
        },
        liquidity: {
          score: state.liquidity || 0.5,
          spread: state.spread || 0,
        },
        structure: {
          support: null,
          resistance: null,
          pricePosition: 0.5,
        },
        session: {
          name: 'Other', // will be refined by deepMarketState
          liquidityMultiplier: 1.0,
        },
        regime: {
          code: state.regime || 'NEUTRAL',
          name: state.regime || 'Neutral',
          confidence: state.confidence || 50,
        },
        confidence: state.confidence || 50,
        reason: state.reason || '',
        summary: {
          marketQuality: state.liquidity ? state.liquidity * 100 : 50,
          noiseLevel: 'medium',
          regimeSuggestion: 'neutral',
          trendConfidence: state.confidence || 50,
        },
        source: 'live',
        version: '2.0',
      }, {
        source: 'marketStateCache',
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Periodic persistence – now a no‑op because orchestrator handles it.
   * Kept for backward compatibility.
   */
  _startPersistence() {
    if (this._timer) return;
    this._timer = setInterval(async () => {
      // Orchestrator handles flushing – nothing to do here.
      // We keep this to satisfy the existing code flow.
    }, 250);
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
   * This is a destructive operation – use with caution.
   */
  async clear() {
    this._cache.clear();
    this._dirty.clear();
    // Also clear from orchestrator? For now, just clear the cache.
    // The orchestrator will eventually flush, but we mark as dirty to avoid stale data.
    // We'll also remove from DB directly for safety.
    try {
      await StateModel.deleteMany({});
      logger.info('[MarketStateCache] Cleared DB.');
    } catch (err) {
      logger.error('[MarketStateCache] DB clear error:', err.message);
    }
    logger.info('[MarketStateCache] Cleared.');
  }
}

// Singleton
module.exports = new MarketStateCache();
