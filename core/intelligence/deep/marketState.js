// core/intelligence/deep/marketState.js
// Deep Market State – computed from historical candles with session context.
// Supports incremental updates on every tick.
// Added debug logs and validation to filter incomplete candles.

const EventEmitter = require('events');
const candleHistory = require('../../data/candleHistory');
const marketStateCache = require('../../data/marketStateCache');
const session = require('../session');
const {
  ADX,
  ATR,
  RSI,
  MACD,
  BollingerBands,
  findSupportResistance,
} = require('../../strategy/engine');
const logger = require('../../../infrastructure/logger') || console;

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
    this._rollingData = {};
    this._lastState = {};
  }

  /**
   * Compute a full deep market state from historical candles.
   * @param {string} symbol - e.g., 'EUR_USD'
   * @param {string} timeframe - e.g., 'M5'
   * @param {number} candleCount - number of candles to fetch
   * @returns {Promise<Object|null>} Deep market state object.
   */
  async compute(symbol, timeframe = 'M5', candleCount = 200) {
    console.log(`🧮 DeepMarketState.compute() called for ${symbol} ${timeframe} (count=${candleCount})`);

    try {
      const candles = await candleHistory.getHistory(symbol, timeframe, candleCount);
      console.log(`📦 DeepMarketState: got ${candles ? candles.length : 0} candles from history for ${symbol} ${timeframe}`);

      if (!candles || candles.length < 50) {
        console.log(`⚠️ DeepMarketState: insufficient candles for ${symbol}:${timeframe} (need 50, got ${candles ? candles.length : 0})`);
        logger.warn(`[DeepMarketState] Insufficient candles for ${symbol}:${timeframe}`);
        return null;
      }

      // ---- FILTER: remove incomplete candles ----
      const validCandles = candles.filter(c =>
        c && typeof c === 'object' &&
        c.high !== undefined && c.low !== undefined && c.close !== undefined &&
        !isNaN(c.high) && !isNaN(c.low) && !isNaN(c.close)
      );

      if (validCandles.length < 50) {
        console.log(`⚠️ DeepMarketState: not enough valid candles for ${symbol}:${timeframe} (valid ${validCandles.length})`);
        logger.warn(`[DeepMarketState] Not enough valid candles for ${symbol}:${timeframe}`);
        return null;
      }

      if (validCandles.length < candles.length) {
        console.log(`⚠️ DeepMarketState: filtered out ${candles.length - validCandles.length} incomplete candles for ${symbol}:${timeframe}`);
      }

      const closes = validCandles.map(c => c.close);
      const highs = validCandles.map(c => c.high);
      const lows = validCandles.map(c => c.low);
      const lastIdx = closes.length - 1;
      const currentPrice = closes[lastIdx];

      // ---- FIX: indicator functions expect direct h/l/c, and we filter out any undefined ----
      const candlesForIndicators = validCandles
        .map(c => ({ h: c.high, l: c.low, c: c.close }))
        .filter(item => item && typeof item.h === 'number' && typeof item.l === 'number' && typeof item.c === 'number');

      if (candlesForIndicators.length < 50) {
        console.log(`⚠️ DeepMarketState: not enough valid indicator candles for ${symbol}:${timeframe} (${candlesForIndicators.length})`);
        return null;
      }

      // ---- Compute indicators with safe fallbacks ----
      let adxData = null, atrArray = null, rsi = null, macd = null, bb = null, sr = null;
      try {
        adxData = ADX(candlesForIndicators, this.indicators.adxPeriod);
        atrArray = ATR(candlesForIndicators, this.indicators.atrPeriod);
        rsi = RSI(closes, this.indicators.rsiPeriod);
        macd = MACD(closes, this.indicators.macdFast, this.indicators.macdSlow, this.indicators.macdSignal);
        bb = BollingerBands(closes, this.indicators.bbPeriod, this.indicators.bbStd);
        sr = findSupportResistance(validCandles, this.indicators.supportResistanceLookback, 0.001);
      } catch (indicatorErr) {
        console.error(`❌ DeepMarketState: indicator error for ${symbol}:${timeframe}`, indicatorErr.message);
        logger.error(`[DeepMarketState] Indicator error for ${symbol}:${timeframe}`, indicatorErr);
        return null;
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

      // Build the deep state object
      const state = {
        symbol,
        timeframe,
        time: new Date().toISOString(),
        price: {
          current: currentPrice,
          high: highs[lastIdx],
          low: lows[lastIdx],
          open: closes[0],
          close: closes[lastIdx],
        },
        trend: {
          strength: adxData ? adxData.adx : 0,
          direction: closes[lastIdx] > closes[lastIdx - 50] ? 'bullish' : 'bearish',
          adx: adxData ? adxData.adx : 0,
          plusDI: adxData ? adxData.plusDI : 0,
          minusDI: adxData ? adxData.minusDI : 0,
        },
        momentum: {
          rsi: rsiVal,
          macdHist: macdHist,
          macdLine: macd ? macd.macd[macd.macd.length - 1] : 0,
          macdSignal: macd ? macd.signal[macd.signal.length - 1] : 0,
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
        },
        summary: {
          trendConfidence: this._trendConfidence(adxData, rsiVal, macdHist),
          volatilityScore: Math.min(1, atr / (currentPrice * 0.01 || 0.0001)),
          liquidityScore: 0.5,
          regimeSuggestion: this._suggestRegime(adxData, rsiVal, bbWidth, atr),
        },
        confidence: 0,
        reason: '',
        status: 'confirmed',
      };

      // Incorporate awareness data if available
      const awareness = marketStateCache.get(symbol);
      if (awareness) {
        state.awareness = {
          velocity: awareness.velocity || 0,
          acceleration: awareness.acceleration || 0,
          liquidity: awareness.liquidity || 0.5,
          spread: awareness.spread || 0,
          unusualEvents: awareness.unusual || [],
        };
        state.summary.liquidityScore = awareness.liquidity || 0.5;
      }

      state.confidence = this._calculateConfidence(state);
      state.reason = this._buildReason(state);

      this._lastState[symbol] = state;

      console.log(`✅ DeepMarketState.compute() succeeded for ${symbol} ${timeframe}, confidence ${state.confidence}`);
      return state;
    } catch (err) {
      console.error(`❌ DeepMarketState.compute() error for ${symbol} ${timeframe}:`, err.message);
      logger.error('[DeepMarketState] Compute error:', err.message);
      return null;
    }
  }

  /**
   * Incremental update on every tick – produces a "developing" state.
   * @param {Object} tick - { symbol, bid, ask, mid, time }
   * @returns {Object|null} Developing state.
   */
  updateIncremental(tick) {
    // ... (same as before, unchanged)
  }

  // ---- Helper methods ----
  _volatilityRegime(atr, candles) { /* unchanged */ }
  _suggestRegime(adxData, rsi, bbWidth, atr) { /* unchanged */ }
  _trendConfidence(adxData, rsi, macdHist) { /* unchanged */ }
  _calculateConfidence(state) { /* unchanged */ }
  _buildReason(state) { /* unchanged */ }
}

module.exports = new DeepMarketState();
