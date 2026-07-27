// core/intelligence/deep/marketState.js
// Deep Market State – computed from historical candles.
// Uses candleHistory for data, integrates with marketStateCache for awareness.

const candleHistory = require('../../data/candleHistory');
const marketStateCache = require('../../data/marketStateCache');
const {
  ADX,
  ATR,
  RSI,
  MACD,
  BollingerBands,
  detectRegime,
  findSupportResistance,
} = require('../../strategy/engine');
const logger = require('../../../infrastructure/logger') || console;

class DeepMarketState {
  constructor() {
    // Configuration
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
  }

  /**
   * Compute deep market state for a given symbol and timeframe.
   * Returns an object with all derived metrics.
   */
  async compute(symbol, timeframe = 'M5', candleCount = 200) {
    try {
      // 1. Get candles from history
      const candles = await candleHistory.getHistory(symbol, timeframe, candleCount);
      if (!candles || candles.length < 50) {
        logger.warn(`[DeepMarketState] Insufficient candles for ${symbol}:${timeframe}`);
        return null;
      }

      // 2. Prepare price arrays
      const closes = candles.map(c => c.close);
      const highs = candles.map(c => c.high);
      const lows = candles.map(c => c.low);
      const lastIdx = closes.length - 1;
      const currentPrice = closes[lastIdx];

      // 3. Compute all indicators
      const adxData = ADX(
        candles.map(c => ({ mid: { h: c.high, l: c.low, c: c.close } })),
        this.indicators.adxPeriod
      );
      const atrArray = ATR(
        candles.map(c => ({ mid: { h: c.high, l: c.low, c: c.close } })),
        this.indicators.atrPeriod
      );
      const rsi = RSI(closes, this.indicators.rsiPeriod);
      const macd = MACD(closes, this.indicators.macdFast, this.indicators.macdSlow, this.indicators.macdSignal);
      const bb = BollingerBands(closes, this.indicators.bbPeriod, this.indicators.bbStd);
      const sr = findSupportResistance(candles, this.indicators.supportResistanceLookback, 0.001);

      // 4. Extract current values
      const atr = atrArray ? atrArray[atrArray.length - 1] : 0;
      const rsiVal = rsi || 50;
      const macdHist = macd ? macd.histogram[macd.histogram.length - 1] : 0;
      const bbWidth = bb ? (bb.upper[bb.upper.length - 1] - bb.lower[bb.lower.length - 1]) / bb.middle[bb.middle.length - 1] : 0;
      const support = sr.support ? sr.support.price : null;
      const resistance = sr.resistance ? sr.resistance.price : null;
      const pricePosition = (support && resistance) ? (currentPrice - support) / (resistance - support) : 0.5;
      const isAtSupport = support ? Math.abs(currentPrice - support) / currentPrice < 0.001 : false;
      const isAtResistance = resistance ? Math.abs(currentPrice - resistance) / currentPrice < 0.001 : false;

      // 5. Get real‑time awareness (if available)
      const awareness = marketStateCache.get(symbol);
      const awarenessData = awareness ? {
        velocity: awareness.velocity || 0,
        acceleration: awareness.acceleration || 0,
        liquidity: awareness.liquidity || 0.5,
        spread: awareness.spread || 0,
        unusualEvents: awareness.unusual || [],
        lastUpdated: awareness.lastUpdated,
      } : null;

      // 6. Build the deep state object
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
          direction: closes[lastIdx] > closes[lastIdx - 50] ? 'bullish' : 'bearish', // simplified
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
          regime: this._volatilityRegime(atr, candles),
        },
        structure: {
          support,
          resistance,
          pricePosition,
          isAtSupport,
          isAtResistance,
        },
        awareness: awarenessData,
        // Computed properties
        summary: {
          trendConfidence: this._trendConfidence(adxData, rsiVal, macdHist),
          volatilityScore: Math.min(1, atr / (currentPrice * 0.01)),
          liquidityScore: awarenessData ? awarenessData.liquidity : 0.5,
          regimeSuggestion: this._suggestRegime(adxData, rsiVal, bbWidth, atr),
        },
      };

      return state;
    } catch (err) {
      logger.error('[DeepMarketState] Compute error:', err.message);
      return null;
    }
  }

  /**
   * Determine volatility regime.
   */
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

  /**
   * Suggest a market regime based on ADX, RSI, BB width, ATR.
   */
  _suggestRegime(adxData, rsi, bbWidth, atr) {
    const adx = adxData ? adxData.adx : 0;
    if (adx > 30) return 'trending';
    if (bbWidth < 0.1 && adx < 20) return 'ranging';
    if (atr > 0.005) return 'high_volatility';
    if (atr < 0.001) return 'low_volatility';
    if (rsi > 70 || rsi < 30) return 'reversal_zone';
    return 'neutral';
  }

  /**
   * Compute a confidence score for the trend detection.
   */
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
}

module.exports = new DeepMarketState();
