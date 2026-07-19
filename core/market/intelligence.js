// core/market/intelligence.js
// RTS Market Intelligence Engine
// Purpose: Continuously analyze market conditions across multiple dimensions.
// Answers: "What is the market doing right now, and why?"

const EventEmitter = require('events');
const candleStore = require('../data/candleStore');
const {
  ADX,
  ATR,
  RSI,
  MACD,
  BollingerBands,
  findSupportResistance,
  detectRegime,
  getSession,
} = require('../strategy/engine');
const logger = require('../../infrastructure/logger') || console;

/**
 * Market Intelligence Engine
 * - Listens to real-time candle closes.
 * - Computes Trend, Momentum, Volatility, Liquidity, Structure, and Session.
 * - Emits a `marketState` event containing the unified analysis.
 */
class MarketIntelligence extends EventEmitter {
  constructor() {
    super();
    this._lastState = new Map(); // symbol -> MarketState
    this._config = {
      // Rolling windows for analysis
      trendPeriod: 50,
      volatilityPeriod: 14,
      momentumPeriod: 14,
      correlationWindow: 50,
    };

    // Listen to candle closes from the real-time store
    candleStore.on('candleClosed', (candle) => {
      // Only process watched symbols & main timeframes (e.g., M5, H1)
      // We can filter later, but for now we compute on all.
      this._analyze(candle);
    });

    logger.info('[MarketIntelligence] Initialized.');
  }

  /**
   * Core analysis method – runs on every candle close.
   * Computes all market dimensions and emits the state.
   */
  _analyze(candle) {
    try {
      const { symbol, timeframe, time, open, high, low, close, volume } = candle;

      // We need a history of candles for accurate indicators.
      // We can fetch from the candle store (which holds closed candles).
      // For simplicity, we'll assume we have a method to get history.
      // In production, we would maintain a rolling buffer in candleStore.
      // For now, we'll use a fallback: fetch from the database (slower but works).
      // TODO: Replace with in-memory history from candleStore.
      const history = this._getHistory(symbol, timeframe);
      if (!history || history.length < 100) return;

      // ---- 1. TREND ANALYSIS ----
      const closes = history.map(c => c.close);
      const highs = history.map(c => c.high);
      const lows = history.map(c => c.low);
      const candles = history.map(c => ({ mid: { h: c.high, l: c.low, c: c.close } }));

      // ADX (Trend Strength)
      const adxData = ADX(candles, 14);
      const adx = adxData ? adxData.adx : 0;
      const plusDI = adxData ? adxData.plusDI : 0;
      const minusDI = adxData ? adxData.minusDI : 0;

      // EMA Slopes (Direction)
      const ema50 = this._calculateEMA(closes, 50);
      const ema200 = this._calculateEMA(closes, 200);
      const lastEma50 = ema50[ema50.length - 1];
      const prevEma50 = ema50[ema50.length - 2];
      const lastEma200 = ema200[ema200.length - 1];
      const prevEma200 = ema200[ema200.length - 2];
      const ema50Slope = lastEma50 - prevEma50;
      const ema200Slope = lastEma200 - prevEma200;

      // ---- 2. MOMENTUM ANALYSIS ----
      const rsi = RSI(closes, 14);
      const macd = MACD(closes, 12, 26, 9);
      const macdHist = macd ? macd.histogram[macd.histogram.length - 1] : 0;

      // ---- 3. VOLATILITY ANALYSIS ----
      const atrArray = ATR(candles, 14);
      const atr = atrArray ? atrArray[atrArray.length - 1] : 0;
      const bb = BollingerBands(closes, 20, 2);
      const bbWidth = bb ? (bb.upper[bb.upper.length - 1] - bb.lower[bb.lower.length - 1]) / bb.middle[bb.middle.length - 1] : 0;

      // ---- 4. LIQUIDITY ANALYSIS ----
      // We can use spread and tick frequency.
      // For now, we'll use a proxy: ATR / price (relative volatility) and tick volume.
      const liquidity = this._estimateLiquidity(candle, atr);

      // ---- 5. MARKET STRUCTURE ----
      const sr = findSupportResistance(candles, 30, 0.001);
      const currentPrice = close;
      const nearestSupport = sr.support ? sr.support.price : null;
      const nearestResistance = sr.resistance ? sr.resistance.price : null;
      const pricePosition = nearestSupport && nearestResistance ?
        (currentPrice - nearestSupport) / (nearestResistance - nearestSupport) : 0.5;

      // ---- 6. SESSION ANALYSIS ----
      const session = getSession();

      // ---- 7. CORRELATION (simplified) ----
      const correlation = this._calculateCorrelation(symbol, closes);

      // ---- 8. BUILD THE MARKET STATE ----
      const marketState = {
        symbol,
        timeframe,
        time,
        timestamp: new Date(time).toISOString(),

        // Trend
        trend: {
          strength: Math.min(100, adx), // ADX 0-100
          direction: ema50Slope > 0 && ema200Slope > 0 ? 'bullish' :
                     ema50Slope < 0 && ema200Slope < 0 ? 'bearish' : 'neutral',
          ema50: lastEma50,
          ema200: lastEma200,
          adx,
          plusDI,
          minusDI,
        },

        // Momentum
        momentum: {
          rsi: rsi || 50,
          macdHist: macdHist,
          strength: macdHist > 0 ? Math.min(1, macdHist / 0.001) : Math.max(-1, macdHist / 0.001),
        },

        // Volatility
        volatility: {
          atr,
          atrPercent: atr / currentPrice,
          bbWidth,
          regime: atr > 0 ? (atr / this._getAvgATR(history) > 1.5 ? 'high' :
                            atr / this._getAvgATR(history) < 0.7 ? 'low' : 'normal') : 'normal',
        },

        // Liquidity
        liquidity: {
          spread: liquidity.spread,
          quality: liquidity.quality,
          tickFrequency: liquidity.tickFrequency,
        },

        // Structure
        structure: {
          support: nearestSupport,
          resistance: nearestResistance,
          pricePosition, // 0 = at support, 1 = at resistance
          isAtSupport: Math.abs(currentPrice - nearestSupport) / currentPrice < 0.001,
          isAtResistance: Math.abs(currentPrice - nearestResistance) / currentPrice < 0.001,
        },

        // Session
        session: {
          name: session,
          liquidityMultiplier: session === 'London' || session === 'New York' ? 1.5 : 1.0,
        },

        // Correlation (simplified)
        correlation: correlation,

        // Summary (for quick decision making)
        summary: {
          regimeSuggestion: this._suggestRegime(adx, rsi, bbWidth, atr),
          confidence: this._calculateRegimeConfidence(adx, rsi, bbWidth, atr),
        },

        // Metadata
        _raw: {
          adx,
          rsi,
          atr,
          bbWidth,
          macdHist,
        },
      };

      // Store and emit
      this._lastState.set(symbol, marketState);
      this.emit('marketState', marketState);

    } catch (err) {
      logger.error('[MarketIntelligence] Analysis error:', err.message);
    }
  }

  /**
   * Get the latest MarketState for a symbol.
   */
  getState(symbol) {
    return this._lastState.get(symbol) || null;
  }

  /**
   * Get history of candles for a symbol (placeholder – use real data).
   * In production, this should pull from a rolling in‑memory buffer.
   */
  _getHistory(symbol, timeframe) {
    // TODO: Implement using a circular buffer in candleStore.
    // For now, we'll return a dummy history to avoid breaking.
    // In production, we would query the database.
    try {
      const { getCandles } = require('../market/provider');
      return getCandles(symbol, 200, timeframe, process.env.DEFAULT_TRADING_PRODUCT || 'mt5');
    } catch (err) {
      logger.warn('[MarketIntelligence] History fetch fallback:', err.message);
      return [];
    }
  }

  /**
   * Calculate EMA (re‑implemented here to avoid circular dependency).
   */
  _calculateEMA(prices, period) {
    if (prices.length < period) return [];
    const result = [];
    const multiplier = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 0; i < prices.length; i++) {
      if (i === 0) ema = prices[0];
      else ema = (prices[i] - ema) * multiplier + ema;
      result.push(ema);
    }
    return result;
  }

  /**
   * Estimate liquidity from spread and tick volume.
   */
  _estimateLiquidity(candle, atr) {
    // Proxy: if ATR is low and volume is high => high liquidity.
    const avgVolume = 100; // placeholder
    const volumeRatio = candle.volume / avgVolume;
    const spread = 0.0002; // placeholder – we need to get this from the broker.
    const quality = volumeRatio > 1.2 && spread < 0.0005 ? 'high' :
                    volumeRatio < 0.5 || spread > 0.001 ? 'low' : 'medium';
    return {
      spread,
      quality,
      tickFrequency: volumeRatio,
    };
  }

  /**
   * Get average ATR over the last 20 candles.
   */
  _getAvgATR(history) {
    if (!history || history.length < 20) return 0.001;
    const atrArray = ATR(history.map(c => ({ mid: { h: c.high, l: c.low, c: c.close } })), 14);
    if (!atrArray || atrArray.length < 20) return 0.001;
    const recent = atrArray.slice(-20);
    return recent.reduce((a, b) => a + b, 0) / recent.length;
  }

  /**
   * Simple correlation calculation (for reference).
   */
  _calculateCorrelation(symbol, closes) {
    // In production, fetch price data for correlated pairs (e.g., EURUSD vs GBPUSD).
    // For now, return a neutral value.
    return { peers: [], beta: 1.0 };
  }

  /**
   * Suggest a market regime based on current metrics.
   * This is used by the Regime Engine.
   */
  _suggestRegime(adx, rsi, bbWidth, atr) {
    if (adx > 30) return 'trending';
    if (bbWidth < 0.1 && adx < 20) return 'ranging';
    if (atr > 0.005) return 'high_volatility';
    if (atr < 0.001) return 'low_volatility';
    if (rsi > 70 || rsi < 30) return 'reversal_zone';
    return 'neutral';
  }

  /**
   * Calculate confidence in the regime suggestion.
   */
  _calculateRegimeConfidence(adx, rsi, bbWidth, atr) {
    let conf = 50;
    if (adx > 30) conf += 20;
    else if (adx > 20) conf += 10;
    if (Math.abs(rsi - 50) > 20) conf += 10;
    if (bbWidth < 0.1) conf += 10;
    if (atr > 0.005) conf += 10;
    return Math.min(100, conf);
  }
}

// Singleton
const marketIntelligence = new MarketIntelligence();
module.exports = marketIntelligence;
