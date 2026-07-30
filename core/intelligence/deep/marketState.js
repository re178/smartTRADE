// core/intelligence/deep/marketState.js
// Deep Market State – incremental cache, correct mapping for engine indicators.

const EventEmitter = require('events');
const candleStore = require('../../data/candleStore');
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

    // In‑memory buffers: key = `${symbol}:${timeframe}` -> array of candles (oldest first)
    this._buffers = new Map();
    // Last computed state per symbol (for quick access)
    this._lastState = new Map();

    // Subscribe to new candle closes – update the buffer incrementally
    candleStore.on('candleClosed', (candle) => {
      this._addCandleToBuffer(candle);
    });

    logger.info('[DeepMarketState] Initialized with incremental candle cache.');
  }

  /**
   * Add a new candle to the in‑memory buffer for its symbol+timeframe.
   * Keeps only the last 200 candles.
   */
  _addCandleToBuffer(candle) {
    const key = this._getKey(candle.symbol, candle.timeframe);
    if (!this._buffers.has(key)) return; // buffer not yet loaded – ignore

    const buffer = this._buffers.get(key);
    // Ensure the candle is valid
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
    const key = this._getKey(symbol, timeframe);
    if (this._buffers.has(key)) {
      return this._buffers.get(key);
    }

    const candles = await candleHistory.getHistory(symbol, timeframe, candleCount);
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

  _getKey(symbol, timeframe) {
    return `${symbol}:${timeframe}`;
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

      this._lastState.set(symbol, state);

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
   */
  updateIncremental(tick) {
    const { symbol, mid, time } = tick;
    if (!this._rollingData) this._rollingData = {};
    if (!this._rollingData[symbol]) {
      this._rollingData[symbol] = {
        prices: [],
        times: [],
        velocity: 0,
        lastState: null,
      };
    }
    const data = this._rollingData[symbol];
    data.prices.push(mid);
    data.times.push(time);
    if (data.prices.length > 200) data.prices.shift();
    if (data.times.length > 200) data.times.shift();

    const len = data.prices.length;
    if (len < 10) return null;

    const recent = data.prices.slice(-10);
    const first = recent[0];
    const last = recent[recent.length - 1];
    const velocity = (last - first) / recent.length;
    data.velocity = velocity;

    let acceleration = 0;
    if (len > 20) {
      const prevVelocity = data.prices.slice(-20, -10).reduce((a, b) => b - a, 0) / 10;
      acceleration = velocity - prevVelocity;
    }

    const currentSession = session.getSession();
    const state = {
      symbol,
      time: new Date(time),
      price: { current: mid },
      trend: {
        direction: velocity > 0.00005 ? 'bullish' : (velocity < -0.00005 ? 'bearish' : 'neutral'),
        strength: Math.min(100, Math.abs(velocity) * 1000),
      },
      momentum: {
        velocity,
        acceleration,
      },
      volatility: {
        atr: (Math.max(...recent) - Math.min(...recent)) / Math.sqrt(recent.length),
      },
      session: {
        name: currentSession.name,
        liquidityMultiplier: currentSession.liquidityMultiplier,
      },
      confidence: Math.min(100, 50 + Math.abs(velocity) * 2000),
      reason: 'Developing state from live ticks',
      status: 'developing',
      timestamp: new Date().toISOString(),
    };

    this._rollingData[symbol].lastState = state;
    this.emit('stateDeveloping', state);
    return state;
  }

  // ---- Helper methods (unchanged from original) ----
  _volatilityRegime(atr, candles) {
    if (candles.length < 20) return 'normal';
    const atrValues = [];
    for (let i = candles.length - 20; i < candles.length; i++) {
      const c = candles[i];
      const tr = Math.max(
        c.high - c.low,
        Math.abs(c.high - (candles[i-1]?.close || c.close)),
        Math.abs(c.low - (candles[i-1]?.close || c.close))
      );
      atrValues.push(tr);
    }
    const avgAtr = atrValues.reduce((a, b) => a + b, 0) / atrValues.length;
    if (avgAtr === 0) return 'normal';
    const ratio = atr / avgAtr;
    if (ratio > 1.5) return 'high';
    if (ratio < 0.7) return 'low';
    return 'normal';
  }

  _suggestRegime(adxData, rsi, bbWidth, atr) {
    const adx = adxData ? adxData.adx : 0;
    if (adx > 30) return 'trending';
    if (bbWidth < 0.1 && adx < 20) return 'ranging';
    if (atr > 0.005) return 'high_volatility';
    if (atr < 0.001) return 'low_volatility';
    if (rsi > 70 || rsi < 30) return 'reversal_zone';
    return 'neutral';
  }

  _trendConfidence(adxData, rsi, macdHist) {
    let score = 0;
    if (adxData) {
      if (adxData.adx > 30) score += 40;
      else if (adxData.adx > 20) score += 20;
    }
    if (Math.abs(rsi - 50) > 20) score += 20;
    if (Math.abs(macdHist) > 0.0005) score += 20;
    return Math.min(100, score);
  }

  _calculateConfidence(state) {
    let conf = 50;
    const { trend, momentum, volatility, structure, session } = state;
    const adx = trend.strength || 0;
    const rsi = momentum.rsi || 50;
    const bbWidth = volatility.bbWidth || 0.1;
    const atr = volatility.atr || 0;
    const pricePosition = structure.pricePosition || 0.5;

    if (adx > 30) conf += 20;
    else if (adx > 20) conf += 10;
    if (Math.abs(rsi - 50) > 20) conf += 10;
    if (atr > 0 && atr < 0.005) conf += 5;
    if (Math.abs(pricePosition - 0.5) < 0.1) conf += 5;
    const liqMult = session.liquidityMultiplier || 1;
    if (liqMult > 1.2) conf += 5;
    if (state.awareness) {
      const { liquidity, unusualEvents } = state.awareness;
      if (liquidity > 0.6) conf += 5;
      if (unusualEvents && unusualEvents.length > 0) conf -= 5;
    }
    return Math.min(100, Math.max(0, conf));
  }

  _buildReason(state) {
    const parts = [];
    if (state.trend.direction) parts.push(`Trend: ${state.trend.direction} (strength ${state.trend.strength})`);
    if (state.momentum.rsi) parts.push(`RSI: ${state.momentum.rsi.toFixed(1)}`);
    if (state.volatility.regime) parts.push(`Volatility: ${state.volatility.regime}`);
    if (state.session.name) parts.push(`Session: ${state.session.name}`);
    if (state.awareness && state.awareness.liquidity !== undefined) {
      parts.push(`Liquidity: ${(state.awareness.liquidity * 100).toFixed(0)}%`);
    }
    return parts.join(' | ');
  }

  getLastState(symbol) {
    return this._lastState.get(symbol) || null;
  }
}

module.exports = new DeepMarketState();
