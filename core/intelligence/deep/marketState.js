// core/intelligence/deep/marketState.js
// Deep Market State – computed from historical candles with session context.
// Supports incremental updates on every tick.
// Added debug logs to trace compute() flow.

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
    // For incremental updates
    this._rollingData = {}; // symbol -> { prices, times, velocity, lastState }
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
    // ---- DEBUG: log entry ----
    console.log(`🧮 DeepMarketState.compute() called for ${symbol} ${timeframe} (count=${candleCount})`);

    try {
      const candles = await candleHistory.getHistory(symbol, timeframe, candleCount);
      // ---- DEBUG: log candle count ----
      console.log(`📦 DeepMarketState: got ${candles ? candles.length : 0} candles from history for ${symbol} ${timeframe}`);

      if (!candles || candles.length < 50) {
        console.log(`⚠️ DeepMarketState: insufficient candles for ${symbol}:${timeframe} (need 50, got ${candles ? candles.length : 0})`);
        logger.warn(`[DeepMarketState] Insufficient candles for ${symbol}:${timeframe}`);
        return null;
      }

      // Filter out any undefined entries
      const validCandles = candles.filter(c => c && c.open !== undefined);
      if (validCandles.length < 50) {
        console.log(`⚠️ DeepMarketState: not enough valid candles for ${symbol}:${timeframe}`);
        logger.warn(`[DeepMarketState] Not enough valid candles for ${symbol}:${timeframe}`);
        return null;
      }

      const closes = validCandles.map(c => c.close);
      const highs = validCandles.map(c => c.high);
      const lows = validCandles.map(c => c.low);
      const lastIdx = closes.length - 1;
      const currentPrice = closes[lastIdx];

      const candlesForIndicators = validCandles.map(c => ({ mid: { h: c.high, l: c.low, c: c.close } }));

      const adxData = ADX(candlesForIndicators, this.indicators.adxPeriod);
      const atrArray = ATR(candlesForIndicators, this.indicators.atrPeriod);
      const rsi = RSI(closes, this.indicators.rsiPeriod);
      const macd = MACD(closes, this.indicators.macdFast, this.indicators.macdSlow, this.indicators.macdSignal);
      const bb = BollingerBands(closes, this.indicators.bbPeriod, this.indicators.bbStd);
      const sr = findSupportResistance(validCandles, this.indicators.supportResistanceLookback, 0.001);

      const atr = atrArray ? atrArray[atrArray.length - 1] : 0;
      const rsiVal = rsi || 50;
      const macdHist = macd ? macd.histogram[macd.histogram.length - 1] : 0;
      const bbWidth = bb ? (bb.upper[bb.upper.length - 1] - bb.lower[bb.lower.length - 1]) / bb.middle[bb.middle.length - 1] : 0;
      const support = sr.support ? sr.support.price : null;
      const resistance = sr.resistance ? sr.resistance.price : null;
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
          atrPercent: atr / currentPrice,
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
          volatilityScore: Math.min(1, atr / (currentPrice * 0.01)),
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

      // ---- DEBUG: log success ----
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

  // ---- Helper methods ----
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
}

module.exports = new DeepMarketState();
