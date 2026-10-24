// core/intelligence/patterns/candlePatterns.js
// Pure candle-pattern detection. No DB, no history, no state store.
// Consumes the last N candles for a symbol/timeframe and returns
// a structured pattern report. Every prediction uses this.

'use strict';

const PATTERNS = {
  BULLISH_ENGULFING: 'bullish_engulfing',
  BEARISH_ENGULFING: 'bearish_engulfing',
  HAMMER: 'hammer',
  SHOOTING_STAR: 'shooting_star',
  DOJI: 'doji',
  DRAGONFLY_DOJI: 'dragonfly_doji',
  GRAVESTONE_DOJI: 'gravestone_doji',
  MARUBOZU_BULL: 'marubozu_bull',
  MARUBOZU_BEAR: 'marubozu_bear',
  THREE_WHITE_SOLDIERS: 'three_white_soldiers',
  THREE_BLACK_CROWS: 'three_black_crows',
  MORNING_STAR: 'morning_star',
  EVENING_STAR: 'evening_star',
  INSIDE_BAR: 'inside_bar',
  OUTSIDE_BAR: 'outside_bar',
  HIGHER_HIGHS: 'higher_highs',
  LOWER_LOWS: 'lower_lows',
  BREAKOUT_UP: 'breakout_up',
  BREAKOUT_DOWN: 'breakout_down',
};

function _body(c) { return Math.abs(c.close - c.open); }
function _range(c) { return c.high - c.low; }
function _upperWick(c) { return c.high - Math.max(c.open, c.close); }
function _lowerWick(c) { return Math.min(c.open, c.close) - c.low; }
function _isBull(c) { return c.close > c.open; }
function _isBear(c) { return c.close < c.open; }

/**
 * Analyze the last N candles.
 * @param {Array<{time,open,high,low,close,volume}>} candles — oldest first
 * @returns {Object} pattern report
 */
function analyze(candles) {
  if (!Array.isArray(candles) || candles.length < 5) {
    return { patterns: [], bias: 'NEUTRAL', confidence: 0, bodyRatio: 0,
      upperWickPct: 0, lowerWickPct: 0, hhCount: 0, llCount: 0, candleCount: 0 };
  }

  const patterns = [];
  const n = candles.length;
  const last = candles[n - 1];
  const prev = candles[n - 2];
  const prev2 = candles[n - 3];

  const lastBody = _body(last);
  const lastRange = _range(last);
  const lastUpper = _upperWick(last);
  const lastLower = _lowerWick(last);
  const bodyRatio = lastRange > 0 ? lastBody / lastRange : 0;

  // ---- Single-candle patterns ----
  if (bodyRatio < 0.1 && lastRange > 0) {
    if (lastLower > lastRange * 0.6) patterns.push(PATTERNS.DRAGONFLY_DOJI);
    else if (lastUpper > lastRange * 0.6) patterns.push(PATTERNS.GRAVESTONE_DOJI);
    else patterns.push(PATTERNS.DOJI);
  }

  if (bodyRatio > 0.85 && _isBull(last)) patterns.push(PATTERNS.MARUBOZU_BULL);
  if (bodyRatio > 0.85 && _isBear(last)) patterns.push(PATTERNS.MARUBOZU_BEAR);

  if (_isBull(last) && lastLower > lastBody * 2 && lastUpper < lastBody * 0.5) {
    patterns.push(PATTERNS.HAMMER);
  }
  if (_isBear(last) && lastUpper > lastBody * 2 && lastLower < lastBody * 0.5) {
    patterns.push(PATTERNS.SHOOTING_STAR);
  }

  // ---- Two-candle patterns ----
  if (_isBull(last) && _isBear(prev)
      && last.open <= prev.close && last.close >= prev.open
      && _body(last) > _body(prev)) {
    patterns.push(PATTERNS.BULLISH_ENGULFING);
  }
  if (_isBear(last) && _isBull(prev)
      && last.open >= prev.close && last.close <= prev.open
      && _body(last) > _body(prev)) {
    patterns.push(PATTERNS.BEARISH_ENGULFING);
  }

  if (last.high <= prev.high && last.low >= prev.low) patterns.push(PATTERNS.INSIDE_BAR);
  if (last.high > prev.high && last.low < prev.low) patterns.push(PATTERNS.OUTSIDE_BAR);

  // ---- Three-candle patterns ----
  if (n >= 3) {
    if (_isBull(last) && _isBull(prev) && _isBull(prev2)
        && last.close > prev.close && prev.close > prev2.close
        && last.open > prev.open && prev.open > prev2.open) {
      patterns.push(PATTERNS.THREE_WHITE_SOLDIERS);
    }
    if (_isBear(last) && _isBear(prev) && _isBear(prev2)
        && last.close < prev.close && prev.close < prev2.close
        && last.open < prev.open && prev.open < prev2.open) {
      patterns.push(PATTERNS.THREE_BLACK_CROWS);
    }
    if (_isBear(prev2) && _body(prev) / (_range(prev) || 1) < 0.3
        && _isBull(last) && last.close > (prev2.open + prev2.close) / 2) {
      patterns.push(PATTERNS.MORNING_STAR);
    }
    if (_isBull(prev2) && _body(prev) / (_range(prev) || 1) < 0.3
        && _isBear(last) && last.close < (prev2.open + prev2.close) / 2) {
      patterns.push(PATTERNS.EVENING_STAR);
    }
  }

  // ---- Structure ----
  const lookback = Math.min(10, n);
  const recent = candles.slice(-lookback);
  let hhCount = 0, llCount = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].high > recent[i - 1].high) hhCount++;
    if (recent[i].low < recent[i - 1].low) llCount++;
  }
  if (hhCount >= lookback - 2) patterns.push(PATTERNS.HIGHER_HIGHS);
  if (llCount >= lookback - 2) patterns.push(PATTERNS.LOWER_LOWS);

  // ---- Breakout ----
  if (n >= 20) {
    const twentyHigh = Math.max(...candles.slice(-20, -1).map(c => c.high));
    const twentyLow = Math.min(...candles.slice(-20, -1).map(c => c.low));
    if (last.close > twentyHigh) patterns.push(PATTERNS.BREAKOUT_UP);
    if (last.close < twentyLow) patterns.push(PATTERNS.BREAKOUT_DOWN);
  }

  // ---- Overall bias ----
  const bullish = [
    PATTERNS.BULLISH_ENGULFING, PATTERNS.HAMMER, PATTERNS.MARUBOZU_BULL,
    PATTERNS.THREE_WHITE_SOLDIERS, PATTERNS.MORNING_STAR,
    PATTERNS.HIGHER_HIGHS, PATTERNS.BREAKOUT_UP, PATTERNS.DRAGONFLY_DOJI,
  ];
  const bearish = [
    PATTERNS.BEARISH_ENGULFING, PATTERNS.SHOOTING_STAR, PATTERNS.MARUBOZU_BEAR,
    PATTERNS.THREE_BLACK_CROWS, PATTERNS.EVENING_STAR,
    PATTERNS.LOWER_LOWS, PATTERNS.BREAKOUT_DOWN, PATTERNS.GRAVESTONE_DOJI,
  ];

  let bullScore = 0, bearScore = 0;
  for (const p of patterns) {
    if (bullish.includes(p)) bullScore++;
    if (bearish.includes(p)) bearScore++;
  }

  let bias = 'NEUTRAL';
  let confidence = 0;
  if (bullScore > bearScore) {
    bias = 'BULLISH';
    confidence = Math.min(100, 40 + bullScore * 12);
  } else if (bearScore > bullScore) {
    bias = 'BEARISH';
    confidence = Math.min(100, 40 + bearScore * 12);
  }

  return {
    patterns,
    bias,
    confidence,
    bodyRatio: Number(bodyRatio.toFixed(3)),
    upperWickPct: lastRange > 0 ? Number((lastUpper / lastRange).toFixed(3)) : 0,
    lowerWickPct: lastRange > 0 ? Number((lastLower / lastRange).toFixed(3)) : 0,
    hhCount,
    llCount,
    candleCount: n,
  };
}

/**
 * Momentum: rate of change + candle count in direction.
 */
function momentum(candles, lookback = 5) {
  if (!candles || candles.length < lookback + 1) {
    return { roc: 0, consecutive: 0, direction: 'NEUTRAL' };
  }
  const last = candles[candles.length - 1].close;
  const base = candles[candles.length - 1 - lookback].close;
  const roc = (last - base) / base;

  let consecutive = 0;
  let dir = 0;
  for (let i = candles.length - 1; i > 0; i--) {
    const sign = Math.sign(candles[i].close - candles[i - 1].close);
    if (i === candles.length - 1) { dir = sign; consecutive = 1; }
    else if (sign === dir && sign !== 0) consecutive++;
    else break;
  }

  return {
    roc: Number(roc.toFixed(6)),
    consecutive,
    direction: dir > 0 ? 'UP' : dir < 0 ? 'DOWN' : 'NEUTRAL',
  };
}

/**
 * Volatility state: is current ATR expanding or contracting?
 */
function volatility(candles, atrPeriod = 14) {
  if (!candles || candles.length < atrPeriod * 2) {
    return { currentATR: 0, avgATR: 0, ratio: 1, regime: 'normal' };
  }
  const ranges = candles.slice(-atrPeriod * 2).map((c, i, arr) => {
    if (i === 0) return c.high - c.low;
    const prevClose = arr[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
  const currentATR = ranges.slice(-atrPeriod).reduce((a, b) => a + b, 0) / atrPeriod;
  const avgATR = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const ratio = avgATR > 0 ? currentATR / avgATR : 1;

  let regime = 'normal';
  if (ratio > 1.5) regime = 'high';
  else if (ratio < 0.7) regime = 'low';

  return {
    currentATR: Number(currentATR.toFixed(8)),
    avgATR: Number(avgATR.toFixed(8)),
    ratio: Number(ratio.toFixed(3)),
    regime,
  };
}

module.exports = {
  PATTERNS,
  analyze,
  momentum,
  volatility,
};
