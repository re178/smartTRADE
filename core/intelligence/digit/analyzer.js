// core/intelligence/digit/analyzer.js
// Tracks the last digit of every tick. Computes:
//   • Digit frequency (0-9)
//   • Even/Odd percentages and streaks
//   • Rise/Fall percentages (higher/lower than previous tick)
//   • Current digit + arrow direction
//   • Over/Under edge
// Emits 'digitUpdate' per tick, 'digitSignal' when edge exceeds threshold.
// Also tracks recentPrices and directions for breakout bots.

'use strict';

const EventEmitter = require('events');
const priceBuffer = require('../../data/priceBuffer');
const logger = require('../../../infrastructure/logger') || console;

const MAX_HISTORY = 1000;
const SIGNAL_MIN_SAMPLES = 50;
const SIGNAL_MIN_EDGE = 0.08;

function normalizeSymbol(sym) {
  return String(sym || '').replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
}

class DigitAnalyzer extends EventEmitter {
  constructor() {
    super();
    this._state = new Map();
    this._lastSignal = new Map();
    this._listening = false;
  }

  start() {
    if (this._listening) return;
    priceBuffer.on('tick', (tick) => this._onTick(tick));
    this._listening = true;
    logger.info('[DigitAnalyzer] Started.');
  }

  _onTick(tick) {
    const symbol = normalizeSymbol(tick.symbol);
    if (!symbol) return;

    const mid = Number(tick.mid ?? (tick.bid + tick.ask) / 2);
    if (!Number.isFinite(mid) || mid <= 0) return;

    // Extract last digit from 5-decimal formatted price
    const formatted = mid.toFixed(5);
    const digit = parseInt(formatted[formatted.length - 1], 10);
    if (!Number.isFinite(digit)) return;

    let s = this._state.get(symbol);
    if (!s) {
      s = { digits: [], directions: [], prices: [], lastDigit: null, lastPrice: null, lastUpdate: 0 };
      this._state.set(symbol, s);
    }

    let direction = 'flat';
    if (s.lastPrice != null) {
      if (mid > s.lastPrice) direction = 'up';
      else if (mid < s.lastPrice) direction = 'down';
    }

    s.digits.push(digit);
    s.directions.push(direction);
    s.prices.push(mid);
    if (s.digits.length > MAX_HISTORY) s.digits.shift();
    if (s.directions.length > MAX_HISTORY) s.directions.shift();
    if (s.prices.length > MAX_HISTORY) s.prices.shift();

    s.lastDigit = digit;
    s.lastPrice = mid;
    s.lastUpdate = Date.now();

    const view = this._computeView(s, symbol, mid);
    this.emit('digitUpdate', view);

    const sig = this._detectSignal(symbol, view);
    if (sig) {
      this.emit('digitSignal', sig);
      this._lastSignal.set(symbol, sig);
    }
  }

  _computeView(s, symbol, currentPrice) {
    const digits = s.digits;
    const directions = s.directions;

    const freq = new Array(10).fill(0);
    for (const d of digits) freq[d]++;
    const total = digits.length || 1;

    let evenCount = 0, oddCount = 0;
    for (const d of digits) {
      if (d % 2 === 0) evenCount++; else oddCount++;
    }

    let riseCount = 0, fallCount = 0, flatCount = 0;
    for (const d of directions) {
      if (d === 'up') riseCount++;
      else if (d === 'down') fallCount++;
      else flatCount++;
    }

    let arrow = 'flat';
    if (digits.length >= 2) {
      const prev = digits[digits.length - 2];
      const cur = digits[digits.length - 1];
      if (cur > prev) arrow = 'up';
      else if (cur < prev) arrow = 'down';
    }

    let evenStreak = 0, oddStreak = 0, currentParity = null;
    for (let i = digits.length - 1; i >= 0; i--) {
      const p = digits[i] % 2 === 0 ? 'even' : 'odd';
      if (currentParity === null) { currentParity = p; }
      if (p !== currentParity) break;
      if (p === 'even') evenStreak++; else oddStreak++;
    }

    return {
      symbol,
      currentDigit: digits[digits.length - 1],
      previousDigit: digits.length >= 2 ? digits[digits.length - 2] : null,
      arrow,
      price: currentPrice,
      sampleSize: total,

      digitFreq: freq,
      digitFreqPct: freq.map(f => Number(((f / total) * 100).toFixed(2))),

      evenPct: Number(((evenCount / total) * 100).toFixed(2)),
      oddPct: Number(((oddCount / total) * 100).toFixed(2)),

      risePct: Number(((riseCount / total) * 100).toFixed(2)),
      fallPct: Number(((fallCount / total) * 100).toFixed(2)),
      flatPct: Number(((flatCount / total) * 100).toFixed(2)),

      currentParity,
      evenStreak,
      oddStreak,

      recentDigits: digits.slice(-30),
      directions: directions.slice(-30),
      recentPrices: s.prices.slice(-30),
      timestamp: new Date().toISOString(),
    };
  }

  _detectSignal(symbol, view) {
    if (view.sampleSize < SIGNAL_MIN_SAMPLES) return null;

    let evenOdd = null;
    if (view.evenPct >= 50 + SIGNAL_MIN_EDGE * 100) {
      evenOdd = { side: 'EVEN', probability: view.evenPct / 100, edge: view.evenPct - 50 };
    } else if (view.oddPct >= 50 + SIGNAL_MIN_EDGE * 100) {
      evenOdd = { side: 'ODD', probability: view.oddPct / 100, edge: view.oddPct - 50 };
    }

    let riseFall = null;
    if (view.risePct >= 50 + SIGNAL_MIN_EDGE * 100) {
      riseFall = { side: 'RISE', probability: view.risePct / 100, edge: view.risePct - 50 };
    } else if (view.fallPct >= 50 + SIGNAL_MIN_EDGE * 100) {
      riseFall = { side: 'FALL', probability: view.fallPct / 100, edge: view.fallPct - 50 };
    }

    let overUnder = null;
    let bestEdge = 0;
    for (let threshold = 1; threshold <= 8; threshold++) {
      const overCount = view.digitFreq.slice(threshold + 1).reduce((a, b) => a + b, 0);
      const underCount = view.digitFreq.slice(0, threshold + 1).reduce((a, b) => a + b, 0);
      const overPct = (overCount / view.sampleSize) * 100;
      const underPct = (underCount / view.sampleSize) * 100;

      if (overPct > 50 + SIGNAL_MIN_EDGE * 100 && overPct - 50 > bestEdge) {
        bestEdge = overPct - 50;
        overUnder = { side: 'OVER', threshold, probability: overPct / 100, edge: overPct - 50 };
      }
      if (underPct > 50 + SIGNAL_MIN_EDGE * 100 && underPct - 50 > bestEdge) {
        bestEdge = underPct - 50;
        overUnder = { side: 'UNDER', threshold, probability: underPct / 100, edge: underPct - 50 };
      }
    }

    if (!evenOdd && !riseFall && !overUnder) return null;

    return {
      symbol,
      timestamp: new Date().toISOString(),
      evenOdd,
      riseFall,
      overUnder,
      sampleSize: view.sampleSize,
    };
  }

  getView(symbol) {
    const s = this._state.get(normalizeSymbol(symbol));
    if (!s || !s.digits.length) return null;
    return this._computeView(s, symbol, s.lastPrice);
  }

  getAllViews() {
    const out = {};
    for (const [symbol, s] of this._state) {
      if (s.digits.length > 0) {
        out[symbol] = this._computeView(s, symbol, s.lastPrice);
      }
    }
    return out;
  }

  getLastSignal(symbol) {
    return this._lastSignal.get(normalizeSymbol(symbol)) || null;
  }
}

module.exports = new DigitAnalyzer();
