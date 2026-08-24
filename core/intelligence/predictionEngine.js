// core/intelligence/deep/marketState.js
// Deep Market State – incremental cache, correct mapping for engine indicators.
// Now publishes to DataOrchestrator for persistence and research.
// Fully compatible with stateStore.js – all required fields are computed.
// Handles symbol variants (with/without underscores, with/without frx prefix) via internal normalization.

const EventEmitter = require('events');
const candleStore = require('../data/candleStore');
const candleHistory = require('../data/candleHistory');
const marketStateCache = require('../data/marketStateCache');
const session = require('../session');
const { dataOrchestrator, DATA_CLASSES } = require('../../data/dataOrchestrator');
const {
  ADX,
  ATR,
  RSI,
  MACD,
  BollingerBands,
  findSupportResistance,
} = require('../../strategy/engine');
const logger = require('../../../infrastructure/logger') || console;

// ---- Valid regime codes (for safety) ----
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

class DeepMarketState extends EventEmitter {
  constructor() {
    super();
    this.indicators = {
      adxPeriod: 14,
      atrPeriod: 14,
      rsiPeriod: 14,
      macdFast: 12,
      macdSlow: 26,
      macdSignal: 9,
      bbPeriod: 20,
      bbStd: 2,
      supportResistanceLookback: 30,
    };

    // In‑memory buffers: key = `${normalizedSymbol}:${timeframe}` -> array of candles (oldest first)
    this._buffers = new Map();
    // Last computed state per symbol (uses original symbol as key)
    this._lastState = new Map();

    // Subscribe to new candle closes – update the buffer incrementally
    candleStore.on('candleClosed', (candle) => {
      this._addCandleToBuffer(candle);
    });

    // Register with DataOrchestrator
    dataOrchestrator.register('marketState', DATA_CLASSES.RECOVERABLE, {
      collection: 'marketstate',
      snapshotInterval: 5000,
    });
    dataOrchestrator.register('historicalState', DATA_CLASSES.RESEARCH, {
      collection: 'historicalstates',
      batchSize: 50,
    });
    dataOrchestrator.register('regimeChange', DATA_CLASSES.RESEARCH, {
      collection: 'historicalstates',
    });

    logger.info('[DeepMarketState] Initialized with DataOrchestrator.');
  }

  // ---- Normalize symbol: remove separators and prefix 'frx' ----
  _normalizeSymbol(symbol) {
    if (!symbol) return '';
    return symbol.replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
  }

  _addCandleToBuffer(candle) {
    const normSymbol = this._normalizeSymbol(candle.symbol);
    const key = this._getKey(normSymbol, candle.timeframe);
    if (!this._buffers.has(key)) return;
    const buffer = this._buffers.get(key);
    if (candle && typeof candle.high === 'number' && typeof candle.low === 'number' && typeof candle.close === 'number') {
      buffer.push(candle);
      if (buffer.length > 200) buffer.shift();
    }
  }

  /**
   * Ensure the buffer for a symbol+timeframe is loaded from DB.
   * Returns the buffer (array of candles, oldest first) or null on failure.
   */
  async _ensureBuffer(symbol, timeframe, candleCount = 200) {
    const normSymbol = this._normalizeSymbol(symbol);
    const key = this._getKey(normSymbol, timeframe);
    if (this._buffers.has(key)) {
      return this._buffers.get(key);
    }

    // Try to load from DB with the normalized symbol first; fallback to variants if needed
    let candles = await candleHistory.getHistory(normSymbol, timeframe, candleCount);
    if (!candles || candles.length === 0) {
      // Try with underscore variant (e.g., BTC_USDT) if the normalized doesn't have it
      const variants = this._getSymbolVariants(symbol);
      for (const variant of variants) {
        if (variant === normSymbol) continue;
        candles = await candleHistory.getHistory(variant, timeframe, candleCount);
        if (candles && candles.length > 0) break;
      }
    }

    if (!candles || candles.length < 50) {
      logger.warn(`[DeepMarketState] Insufficient candles for ${symbol}:${timeframe} (got ${candles ? candles.length : 0})`);
      return null;
    }

    // Filter invalid candles (extra safety)
    const valid = candles.filter(c =>
      c && typeof c === 'object' &&
      typeof c.high === 'number' && !isNaN(c.high) &&
      typeof c.low === 'number' && !isNaN(c.low) &&
      typeof c.close === 'number' && !isNaN(c.close)
    );
    if (valid.length < 50) {
      logger.warn(`[DeepMarketState] Not enough valid candles for ${symbol}:${timeframe} (${valid.length})`);
      return null;
    }

    this._buffers.set(key, valid);
    return valid;
  }

  _getKey(normalizedSymbol, timeframe) {
    return `${normalizedSymbol}:${timeframe}`;
  }

  // ---- Generate symbol variants including frx prefix and underscore variants ----
  _getSymbolVariants(symbol) {
    if (!symbol) return [];
    const clean = symbol.replace(/[/\-_]/g, '').toUpperCase();
    const variants = new Set();
    // 1. Canonical (no separators)
    variants.add(clean);
    // 2. With underscore
    if (clean.length === 6) {
      variants.add(clean.slice(0, 3) + '_' + clean.slice(3));
      // 3. With underscore and frx prefix
      variants.add('frx' + clean.slice(0, 3) + '_' + clean.slice(3));
    }
    // 4. With frx prefix (canonical)
    variants.add('frx' + clean);
    // 5. Original symbol as given (may already be frx or with separators)
    variants.add(symbol.toUpperCase());
    // 6. If the original had separators, add without them (already covered)
    // 7. If the original had 'frx', add without (already covered)
    return Array.from(variants);
  }

  /**
   * Compute a full deep market state.
   * Uses the in‑memory buffer; loads from DB only once per symbol+timeframe.
   */
  async compute(symbol, timeframe = 'M5', candleCount = 200) {
    console.log(`🧮 DeepMarketState.compute() called for ${symbol} ${timeframe} (count=${candleCount})`);

    try {
      const candles = await this._ensureBuffer(symbol, timeframe, candleCount);
      if (!candles) {
        console.log(`⚠️ DeepMarketState: no candle data for ${symbol}:${timeframe}`);
        return null;
      }

      // We already filtered invalid candles in _ensureBuffer, but filter again for safety
      const validCandles = candles.filter(c =>
        c && typeof c === 'object' &&
        typeof c.high === 'number' && !isNaN(c.high) &&
        typeof c.low === 'number' && !isNaN(c.low) &&
        typeof c.close === 'number' && !isNaN(c.close)
      );
      if (validCandles.length < 50) {
        console.log(`⚠️ DeepMarketState: not enough valid candles after filtering for ${symbol}:${timeframe}`);
        return null;
      }

      const closes = validCandles.map(c => c.close);
      const highs = validCandles.map(c => c.high);
      const lows = validCandles.map(c => c.low);
      const lastIdx = closes.length - 1;
      const currentPrice = closes[lastIdx];

      // ---- CORRECT MAPPING for engine indicators (expect `mid.h`, `mid.l`, `mid.c`) ----
      const candlesForIndicators = validCandles
        .map(c => ({ mid: { h: c.high, l: c.low, c: c.close } }))
        .filter(item => item && item.mid && typeof item.mid.h === 'number');

      if (candlesForIndicators.length < 50) {
        console.log(`⚠️ DeepMarketState: not enough valid indicator candles for ${symbol}:${timeframe} (${candlesForIndicators.length})`);
        return null;
      }

      // ---- Compute indicators with safe fallbacks ----
      let adxData = null, atrArray = null, rsi = null, macd = null, bb = null, sr = null;

      try { adxData = ADX(candlesForIndicators, this.indicators.adxPeriod); } catch (err) { logger.error(`[DeepMarketState] ADX error for ${symbol}:${timeframe}`, err); adxData = null; }
      try { atrArray = ATR(candlesForIndicators, this.indicators.atrPeriod); } catch (err) { logger.error(`[DeepMarketState] ATR error for ${symbol}:${timeframe}`, err); atrArray = null; }
      try { rsi = RSI(closes, this.indicators.rsiPeriod); } catch (err) { logger.error(`[DeepMarketState] RSI error for ${symbol}:${timeframe}`, err); rsi = null; }
      try { macd = MACD(closes, this.indicators.macdFast, this.indicators.macdSlow, this.indicators.macdSignal); } catch (err) { logger.error(`[DeepMarketState] MACD error for ${symbol}:${timeframe}`, err); macd = null; }
      try { bb = BollingerBands(closes, this.indicators.bbPeriod, this.indicators.bbStd); } catch (err) { logger.error(`[DeepMarketState] BollingerBands error for ${symbol}:${timeframe}`, err); bb = null; }

      // Support/Resistance
      try {
        if (candlesForIndicators.length >= 30) {
          sr = findSupportResistance(candlesForIndicators, this.indicators.supportResistanceLookback, 0.001);
        } else {
          console.log(`⚠️ DeepMarketState: not enough candles for SR (${candlesForIndicators.length})`);
          sr = null;
        }
      } catch (srErr) {
        console.warn(`⚠️ DeepMarketState: Support/Resistance error for ${symbol}:${timeframe}, using previous values`, srErr.message);
        const previous = this._lastState.get(symbol);
        sr = {
          support: previous?.structure?.support ? { price: previous.structure.support } : null,
          resistance: previous?.structure?.resistance ? { price: previous.structure.resistance } : null,
        };
      }

      const atr = atrArray ? atrArray[atrArray.length - 1] : 0;
      const rsiVal = rsi || 50;
      const macdHist = macd ? macd.histogram[macd.histogram.length - 1] : 0;
      const bbWidth = bb ? (bb.upper[bb.upper.length - 1] - bb.lower[bb.lower.length - 1]) / bb.middle[bb.middle.length - 1] : 0;
      const support = sr && sr.support ? sr.support.price : null;
      const resistance = sr && sr.resistance ? sr.resistance.price : null;
      const pricePosition = (support && resistance) ? (currentPrice - support) / (resistance - support) : 0.5;
      const isAtSupport = support ? Math.abs(currentPrice - support) / currentPrice < 0.001 : false;
      const isAtResistance = resistance ? Math.abs(currentPrice - resistance) / currentPrice < 0.001 : false;

      const currentSession = session.getSession();

      const trendLookback = Math.min(50, closes.length - 1);

      const state = {
        symbol,
        timeframe,
        time: new Date().toISOString(),
        price: {
          current: currentPrice,
          open: validCandles[lastIdx].open,
          high: highs[lastIdx],
          low: lows[lastIdx],
          close: closes[lastIdx],
        },
        trend: {
          strength: adxData ? adxData.adx : 0,
          direction: closes[lastIdx] > closes[lastIdx - trendLookback] ? 'bullish' : 'bearish',
          adx: adxData ? adxData.adx : 0,
          plusDI: adxData ? adxData.plusDI : 0,
          minusDI: adxData ? adxData.minusDI : 0,
          slope: (closes[lastIdx] - closes[0]) / (closes[0] || 0.0001),
        },
        momentum: {
          rsi: rsiVal,
          macdHist: macdHist,
          macdLine: macd ? macd.macd[macd.macd.length - 1] : 0,
          macdSignal: macd ? macd.signal[macd.signal.length - 1] : 0,
          velocity: 0,
          acceleration: 0,
        },
        volatility: {
          atr,
          atrPercent: atr / (currentPrice || 0.0001),
          bbWidth,
          regime: this._volatilityRegime(atr, validCandles),
        },
        structure: {
          support,
          resistance,
          pricePosition,
          isAtSupport,
          isAtResistance,
        },
        session: {
          name: currentSession.name,
          liquidityMultiplier: currentSession.liquidityMultiplier,
          isWeekday: session.isWeekday ? session.isWeekday() : true,
        },
        summary: {
          trendConfidence: this._trendConfidence(adxData, rsiVal, macdHist),
          volatilityScore: Math.min(1, atr / (currentPrice * 0.01 || 0.0001)),
          liquidityScore: 0.5,
          regimeSuggestion: this._suggestRegime(adxData, rsiVal, bbWidth, atr),
          marketQuality: 50,
          noiseLevel: 'medium',
        },
        confidence: 0,
        reason: '',
        status: 'confirmed',
        regime: {
          code: 'NEUTRAL',
          name: 'Neutral / Mixed',
          confidence: 50,
          description: '',
        },
        awareness: {
          unusualEvents: [],
          pressure: 'neutral',
        },
      };

      // ---- Incorporate awareness data if available ----
      const awareness = marketStateCache.get(symbol);
      if (awareness) {
        state.awareness = {
          velocity: awareness.velocity || 0,
          acceleration: awareness.acceleration || 0,
          liquidity: awareness.liquidity || 0.5,
          spread: awareness.spread || 0,
          unusualEvents: awareness.unusual || [],
          pressure: awareness.velocity > 0.0001 ? 'buying' : (awareness.velocity < -0.0001 ? 'selling' : 'neutral'),
        };
        state.momentum.velocity = awareness.velocity || 0;
        state.momentum.acceleration = awareness.acceleration || 0;
        state.summary.liquidityScore = awareness.liquidity || 0.5;
        const liq = awareness.liquidity || 0.5;
        const spread = awareness.spread || 0.0002;
        const quality = (liq * 100) - (spread * 1000000);
        state.summary.marketQuality = Math.min(100, Math.max(0, quality + 50));
        state.summary.noiseLevel = state.summary.marketQuality > 70 ? 'low' : (state.summary.marketQuality > 40 ? 'medium' : 'high');
      }

      state.confidence = this._calculateConfidence(state);
      state.reason = this._buildReason(state);

      if (!state.regime || !state.regime.code || !VALID_REGIME_CODES.includes(state.regime.code)) {
        state.regime = {
          code: 'NEUTRAL',
          name: 'Neutral / Mixed',
          confidence: 50,
          description: '',
        };
      }

      // ---- PUBLISH TO DATAORCHESTRATOR ----
      dataOrchestrator.publish('marketState', {
        symbol,
        ...state,
        lastUpdated: new Date(),
      }, { source: 'deepMarketState' });

      dataOrchestrator.publish('historicalState', {
        symbol,
        timeframe,
        timestamp: state.time,
        price: state.price,
        trend: state.trend,
        momentum: state.momentum,
        volatility: state.volatility,
        liquidity: {
          score: state.summary.liquidityScore,
          spread: state.awareness?.spread || 0,
          tickFrequency: 0,
        },
        structure: state.structure,
        session: state.session,
        regime: state.regime,
        awareness: state.awareness,
        summary: state.summary,
        confidence: state.confidence,
        reason: state.reason,
        source: 'live',
        version: '2.0',
      }, {});

      this._lastState.set(symbol, state);

      console.log(`✅ DeepMarketState.compute() succeeded for ${symbol} ${timeframe}, confidence ${state.confidence}`);
      return state;
    } catch (err) {
      console.error(`❌ DeepMarketState.compute() error for ${symbol} ${timeframe}:`, err.message);
      logger.error('[DeepMarketState] Compute error:', err.message);
      return null;
    }
  }

  // ---- Helper methods (unchanged) ----
  updateIncremental(tick) { /* ... */ }

  _volatilityRegime(atr, candles) { /* ... */ }
  _suggestRegime(adxData, rsi, bbWidth, atr) { /* ... */ }
  _trendConfidence(adxData, rsi, macdHist) { /* ... */ }
  _calculateConfidence(state) { /* ... */ }
  _buildReason(state) { /* ... */ }

  getLastState(symbol) {
    return this._lastState.get(symbol) || null;
  }
}

module.exports = new DeepMarketState();
