// core/data/candleHistory.js
// Manages historical candles with TTL, count-based pruning, and source tracking.
// [FILE-4.2] Symbol normalization: candles are stored and queried using the
// canonical symbol format (EURUSD, GBPUSD, etc.) regardless of what the caller
// passed. Old records stored as EUR_USD or frxEURUSD are still readable via
// variant queries. This fixes the "no deep state" bug where candleBootstrapper
// stored EUR_USD but deepMarketState queried EURUSD and got 0 rows.

'use strict';

const mongoose = require('mongoose');
const logger = require('../../infrastructure/logger') || console;

// ---- [FILE-4.2] Canonical symbol normalizer ----
function normalizeSymbol(sym) {
  if (!sym) return '';
  return String(sym).replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
}

// Build all plausible variant forms for a symbol so queries match
// whatever bootstrapper, candleBuilder, or legacy code wrote.
function symbolVariants(sym) {
  const canonical = normalizeSymbol(sym);
  if (!canonical) return [];
  const variants = new Set([canonical]);
  // FX pair forms
  if (canonical.length === 6 && /^[A-Z]{6}$/.test(canonical)) {
    variants.add(canonical.slice(0, 3) + '_' + canonical.slice(3));  // EUR_USD
    variants.add('frx' + canonical);                                  // frxEURUSD
    variants.add('frx' + canonical.slice(0, 3) + '_' + canonical.slice(3)); // frxEUR_USD
  }
  // Synthetics pass through unchanged (R_100, 1HZ100V)
  variants.add(String(sym).toUpperCase());
  return Array.from(variants);
}

// ----- Schema -----
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
    source: { type: String, enum: ['broker', 'live'], default: 'live' },
  },
  { timeseries: { timeField: 'time', metaField: 'symbol', granularity: 'minutes' } }
);

CandleSchema.index({ symbol: 1, timeframe: 1, time: -1 });
CandleSchema.index({ time: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 });

const CandleModel = mongoose.model('HistoricalCandle', CandleSchema);

const MAX_CANDLES_PER_COMBO = 10000;

class CandleHistory {
  constructor() {
    this._cache = new Map();
    this._cacheSize = 1000;
  }

  /**
   * Store a closed candle.
   * [FILE-4.2] Writes under CANONICAL symbol (EURUSD) so
   * deepMarketState._ensureBuffer('EURUSD') finds it directly.
   */
  async store(candle) {
    try {
      const canonical = normalizeSymbol(candle.symbol);
      if (!canonical) {
        logger.warn('[CandleHistory] store: empty symbol, skipping');
        return;
      }
      const doc = {
        symbol: canonical,
        timeframe: candle.timeframe,
        time: new Date(candle.time),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume || 0,
        source: candle.source || 'live',
      };
      await CandleModel.create(doc);
      this._addToCache({ ...candle, symbol: canonical });
      await this._prune(canonical, candle.timeframe);
    } catch (err) {
      logger.error('[CandleHistory] Store error:', err.message);
    }
  }

  /**
   * Retrieve history for a symbol/timeframe.
   * [FILE-4.2] Queries all symbol variants so old EUR_USD records and
   * new EURUSD records both return. Returns oldest first.
   */
  async getHistory(symbol, timeframe, limit = 500) {
    const canonical = normalizeSymbol(symbol);
    const cacheKey = `${canonical}:${timeframe}`;
    const cached = this._cache.get(cacheKey);
    if (cached && cached.length >= limit) {
      return cached.slice(-limit);
    }

    const variants = symbolVariants(symbol);
    if (variants.length === 0) return [];

    const docs = await CandleModel.find({
      symbol: { $in: variants },
      timeframe,
    })
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
      this._cache.set(cacheKey, candles.slice().reverse());  // cached oldest-first
      return candles.reverse();  // oldest first
    }
    return [];
  }

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

  _addToCache(candle) {
    const canonical = normalizeSymbol(candle.symbol);
    const key = `${canonical}:${candle.timeframe}`;
    if (!this._cache.has(key)) this._cache.set(key, []);
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

  async clear() {
    await CandleModel.deleteMany({});
    this._cache.clear();
    logger.info('[CandleHistory] Cleared all data.');
  }
}

module.exports = new CandleHistory();
module.exports._normalizeSymbol = normalizeSymbol;
