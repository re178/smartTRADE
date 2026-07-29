// core/intelligence/multiTimeframe/h1.js
// H1 Timeframe Analyzer – computes market state for 1‑hour candles.

const TimeframeAnalyzer = require('./analyzer');
const {
  ADX,
  ATR,
  RSI,
  MACD,
  BollingerBands,
} = require('../../strategy/engine');
const session = require('../session');
const logger = require('../../../infrastructure/logger') || console;

class H1Analyzer extends TimeframeAnalyzer {
  constructor(symbol) {
    super('H1', symbol, 50);
    this.indicators = {
      adxPeriod: 14,
      atrPeriod: 14,
      rsiPeriod: 14,
      macdFast: 12,
      macdSlow: 26,
      macdSignal: 9,
      bbPeriod: 20,
      bbStd: 2,
    };
  }

  async analyze(candle = null) {
    const history = await this.getHistory(200);
    if (!this._hasEnoughCandles(history)) {
      return null;
    }

    const closes = history.map(c => c.close);
    const highs = history.map(c => c.high);
    const lows = history.map(c => c.low);
    const lastIdx = closes.length - 1;
    const currentPrice = closes[lastIdx];

    const candles = history.map(c => ({ mid: { h: c.high, l: c.low, c: c.close } }));

    const adxData = ADX(candles, this.indicators.adxPeriod);
    const atrArray = ATR(candles, this.indicators.atrPeriod);
    const rsi = RSI(closes, this.indicators.rsiPeriod);
    const macd = MACD(closes, this.indicators.macdFast, this.indicators.macdSlow, this.indicators.macdSignal);
    const bb = BollingerBands(closes, this.indicators.bbPeriod, this.indicators.bbStd);

    const atr = atrArray ? atrArray[atrArray.length - 1] : 0;
    const rsiVal = rsi || 50;
    const macdHist = macd ? macd.histogram[macd.histogram.length - 1] : 0;
    const bbWidth = bb ? (bb.upper[bb.upper.length - 1] - bb.lower[bb.lower.length - 1]) / bb.middle[bb.middle.length - 1] : 0;

    const currentSession = session.getSession();

    const state = {
      timeframe: this.timeframe,
      symbol: this.symbol,
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
        regime: this._volatilityRegime(atr, history),
      },
      session: {
        name: currentSession.name,
        liquidityMultiplier: currentSession.liquidityMultiplier,
      },
      confidence: this._calculateConfidence(adxData, rsiVal, macdHist, bbWidth, currentSession),
      reason: this._buildReason(adxData, rsiVal, macdHist, bbWidth, currentSession),
      status: 'confirmed',
    };

    this._emitAnalysis(state);
    return state;
  }

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

  _calculateConfidence(adxData, rsi, macdHist, bbWidth, session) {
    let conf = 50;
    const adx = adxData ? adxData.adx : 0;
    if (adx > 30) conf += 20;
    else if (adx > 20) conf += 10;
    if (Math.abs(rsi - 50) > 20) conf += 10;
    if (Math.abs(macdHist) > 0.0005) conf += 10;
    if (bbWidth < 0.1) conf += 5;
    if (session.liquidityMultiplier > 1.2) conf += 5;
    return Math.min(100, Math.max(0, conf));
  }

  _buildReason(adxData, rsi, macdHist, bbWidth, session) {
    const parts = [];
    const adx = adxData ? adxData.adx : 0;
    if (adx > 30) parts.push(`ADX strong (${adx.toFixed(1)})`);
    else if (adx > 20) parts.push(`ADX moderate (${adx.toFixed(1)})`);
    else parts.push(`ADX weak (${adx.toFixed(1)})`);
    parts.push(`RSI ${rsi.toFixed(1)}`);
    if (Math.abs(macdHist) > 0.0005) parts.push(`MACD hist ${macdHist.toFixed(4)}`);
    if (bbWidth < 0.1) parts.push('BB squeeze');
    parts.push(`Session: ${session.name}`);
    return parts.join(' | ');
  }
}

module.exports = H1Analyzer;
