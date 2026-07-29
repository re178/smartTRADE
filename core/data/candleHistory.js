// core/data/candleHistory.js
// Manages historical candles with TTL, count‑based pruning, and source tracking.

const mongoose = require('mongoose');
const logger = require('../../infrastructure/logger') || console;

// ----- Schema with source field -----
const CandleSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, index: true },
    timeframe: { type: String, required: true, index: true },
    time: { type: Date, required: true, index: true },
    open: Number,
    high: Number,
    low: Number,
    close: Number,
    volume: Number,
    source: { type: String, enum: ['broker', 'live'], default: 'live' }, // NEW: data origin
  },
  { timeseries: { timeField: 'time', metaField: 'symbol', granularity: 'minutes' } }
);

// Compound index for fast queries and count pruning
CandleSchema.index({ symbol: 1, timeframe: 1, time: -1 });

// TTL index – auto‑delete after 60 days (configurable)
CandleSchema.index({ time: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 });

const CandleModel = mongoose.model('HistoricalCandle', CandleSchema);

// Max candles per symbol/timeframe
const MAX_CANDLES_PER_COMBO = 10000;

class CandleHistory {
  constructor() {
    this._cache = new Map(); // in‑memory LRU cache for recent candles
    this._cacheSize = 1000; // per symbol/timeframe
  }

  /**
   * Store a closed candle (called by CandleBuilder on close or by bootstrapper).
   * @param {Object} candle - { symbol, timeframe, time, open, high, low, close, volume, source }
   */
  async store(candle) {
    try {
      const doc = {
        symbol: candle.symbol,
        timeframe: candle.timeframe,
        time: new Date(candle.time),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume || 0,
        source: candle.source || 'live', // 'broker' or 'live'
      };
      await CandleModel.create(doc);
      this._addToCache(candle);
      await this._prune(candle.symbol, candle.timeframe);
    } catch (err) {
      logger.error('[CandleHistory] Store error:', err.message);
    }
  }

  /**
   * Retrieve history for a symbol/timeframe.
   * Returns array of candles (oldest first), up to `limit`.
   */
  async getHistory(symbol, timeframe, limit = 500) {
    const cacheKey = `${symbol}:${timeframe}`;
    const cached = this._cache.get(cacheKey);
    if (cached && cached.length >= limit) {
      return cached.slice(-limit);
    }

    const docs = await CandleModel.find({ symbol, timeframe })
      .sort({ time: -1 })
      .limit(limit)
      .lean();

    if (docs && docs.length > 0) {
      const candles = docs.map(d => ({
        time: d.time.getTime(),
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
        volume: d.volume,
        source: d.source || 'live',
      }));
      this._cache.set(cacheKey, candles);
      return candles.reverse(); // oldest first
    }
    return [];
  }

  /**
   * Prune excess candles (count‑based).
   */
  async _prune(symbol, timeframe) {
    const count = await CandleModel.countDocuments({ symbol, timeframe });
    if (count > MAX_CANDLES_PER_COMBO) {
      const excess = count - MAX_CANDLES_PER_COMBO;
      const oldest = await CandleModel.find({ symbol, timeframe })
        .sort({ time: 1 })
        .limit(excess)
        .select('_id');
      const ids = oldest.map(d => d._id);
      await CandleModel.deleteMany({ _id: { $in: ids } });
      logger.debug(`[CandleHistory] Pruned ${excess} candles for ${symbol}:${timeframe}`);
    }
  }

  /**
   * In‑memory cache management.
   */
  _addToCache(candle) {
    const key = `${candle.symbol}:${candle.timeframe}`;
    if (!this._cache.has(key)) {
      this._cache.set(key, []);
    }
    const arr = this._cache.get(key);
    arr.push({
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      source: candle.source || 'live',
    });
    if (arr.length > this._cacheSize) arr.shift();
  }

  /**
   * Clear all data (for reset/testing).
   */
  async clear() {
    await CandleModel.deleteMany({});
    this._cache.clear();
    logger.info('[CandleHistory] Cleared all data.');
  }
}

module.exports = new CandleHistory();
