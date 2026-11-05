// core/intelligence/digit/analyzer.js
// Tracks the last digit of every tick. Computes:
//   • Digit frequency (0-9)
//   • Even/Odd percentages and streaks
//   • Rise/Fall percentages (higher/lower than previous tick)
//   • Current digit + arrow direction
//   • Over/Under edge
//   • [FIX-3] Z-scores for every statistic (statistical significance layer)
// Emits 'digitUpdate' per tick, 'digitSignal' when edge exceeds threshold.
// Also tracks recentPrices and directions for breakout bots.
//
// [FIX-1] Digit extraction was hardcoded to .toFixed(5). For 2-decimal
//         instruments (R_10/R_25/R_50/R_75/R_100 and other synthetics),
//         toFixed(5) pads with trailing zeros — the "last digit" was
//         ALWAYS 0. This corrupted every digit reading: evenPct=100,
//         oddPct=0, digit 5 at 0%, etc. Betting MATCH on the "cold"
//         digit lost 100% of the time; betting DIFF won 100% of the
//         time. Both were artifacts of the bug, not real edge.
//         Now uses per-symbol precision (getDigitPrecision).
//
// [FIX-2] Added degenerate-distribution detection. If a 100+ sample
//         window has <3 unique digits, log a warning. This would have
//         caught the above bug in production.
//
// [FIX-3] **Statistical significance layer.**
//         The digit bots used fixed percentage thresholds (e.g., "even
//         >= 62%", "digit 5 <= 3%", "over 8 <= 5%"). On a fair RNG
//         these require 5–7σ events — essentially unreachable. Result:
//         every digit bot fired 0 trades over 87+ cycles.
//
//         This file now computes Z-scores for every statistic the bots
//         already use:
//             z = (observed - expected) / σ
//         where σ depends on the sample size n and the Bernoulli
//         probability of the event.
//
//         Bots can compare against a configurable zThreshold (default
//         1.5 → ~7% fire rate) instead of an arbitrary percentage.
//         At N=200 with zThreshold=1.5:
//             • even/odd fires when even% ≥ 55.3%
//             • target digit fires when digit% ≤ 6.8% (cold) or ≥ 13.2% (hot)
//             • over/under fires when threshold% ≤ 6.8% or ≥ 13.2%
//         These are statistically meaningful AND reachable in practice.
//
//         Also adds streak metrics derived from log2(n) so the streak-
//         fade bot can adapt its threshold to the window size instead
//         of using a fixed `minStreak: 8`.
//
//         Z-scores are computed at every tick from the last
//         `DEFAULT_Z_WINDOW` (200) ticks. Bots can call
//         `getZView(symbol, customWindow)` for a different window.
//         Full-history percentages (`evenPct`, `digitFreqPct`, etc.)
//         are still exposed unchanged for the UI.

'use strict';

const EventEmitter = require('events');
const priceBuffer = require('../../data/priceBuffer');
const logger = require('../../../infrastructure/logger') || console;

const MAX_HISTORY = 1000;
const SIGNAL_MIN_SAMPLES = 50;
const SIGNAL_MIN_EDGE = 0.08;
const DEGENERATE_CHECK_SAMPLES = 100;
const DEGENERATE_MIN_UNIQUE = 3;

// [FIX-3] Default window for z-score computation. Bots get this via
// view.zStats; a different window requires `getZView(symbol, N)`.
const DEFAULT_Z_WINDOW = 200;
// [FIX-3] Minimum samples below which z-scores are meaningless.
const Z_MIN_SAMPLES = 30;

function normalizeSymbol(sym) {
  return String(sym || '').replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
}

/**
 * How many decimals to round the price to BEFORE extracting the last digit.
 * Must match the actual quote precision of each instrument — otherwise
 * toFixed() pads with trailing zeros and every tick yields digit 0.
 *
 * Deriv volatility indices (R_10, R_25, R_50, R_75, R_100) are quoted at
 * 2 decimals. 1HZ* synthetics also 2 decimals. FX pairs are 5 (JPY: 3).
 * Metals/crypto vary.
 */
function getDigitPrecision(symbol) {
  const clean = normalizeSymbol(symbol);
  const map = {
    // FX majors — 5 decimals
    EURUSD: 5, GBPUSD: 5, AUDUSD: 5, NZDUSD: 5, USDCHF: 5, USDCAD: 5,
    EURGBP: 5, EURAUD: 5, EURNZD: 5, GBPAUD: 5, GBPNZD: 5, AUDNZD: 5,
    AUDCAD: 5, AUDCHF: 5, NZDCAD: 5, NZDCHF: 5, CADCHF: 5,
    // JPY pairs — 3 decimals
    USDJPY: 3, EURJPY: 3, GBPJPY: 3, AUDJPY: 3, NZDJPY: 3, CADJPY: 3, CHFJPY: 3,
    // Metals — varies
    XAUUSD: 2, XAGUSD: 3,
    // Crypto — varies
    BTCUSD: 2, ETHUSD: 2,
    // Volatility indices — 2 decimals (this was the bug)
    R_10: 2, R_25: 2, R_50: 2, R_75: 2, R_100: 2,
    '1HZ10V': 2, '1HZ25V': 2, '1HZ50V': 2, '1HZ75V': 2, '1HZ100V': 2,
    '1HZ150V': 2, '1HZ250V': 2,
    // Jump / step indices — 2 decimals
    JD10: 2, JD25: 2, JD50: 2, JD75: 2, JD100: 2,
    STPRNG: 2, 'STPRNG100': 2,
  };
  // Default to 2 — safest for synthetics, which is where digit trading runs.
  // If a new symbol is added that needs >2, add it to the map.
  return map[clean] != null ? map[clean] : 2;
}

// ============================================================
// [FIX-3] Z-score computation
// ============================================================
/**
 * Compute statistical z-scores for a sliding window of digit data.
 *
 * All z-scores follow the form: (observed - expected) / stdDev
 *
 * Sign convention:
 *   evenZ > 0  → more EVEN than expected
 *   oddZ  > 0  → more ODD than expected (oddZ = -evenZ)
 *   digitZ[i] > 0 → digit i appears MORE often than expected (hot)
 *   digitZ[i] < 0 → digit i appears LESS often than expected (cold)
 *   overZ[th]  > 0 → more digits > th than expected
 *   underZ[th] > 0 → more digits < th than expected
 *   riseZ > 0  → more UP ticks than expected
 *   fallZ > 0  → more DOWN ticks than expected (fallZ = -riseZ)
 *
 * Returns null if windowSize < Z_MIN_SAMPLES.
 */
function computeZStats(digits, directions, windowSize) {
  if (!Array.isArray(digits) || digits.length < Z_MIN_SAMPLES) return null;

  const n = Math.min(windowSize || DEFAULT_Z_WINDOW, digits.length);
  const arr = digits.slice(-n);
  const dirArr = Array.isArray(directions) ? directions.slice(-n) : [];

  // ---------- Digit frequencies ----------
  const freq = new Array(10).fill(0);
  for (const d of arr) {
    if (d >= 0 && d <= 9) freq[d]++;
  }

  // ---------- Per-digit z-scores ----------
  // Expected count per digit: n * 0.1; std: sqrt(n * 0.1 * 0.9)
  const expDigit = n * 0.1;
  const stdDigit = Math.sqrt(n * 0.1 * 0.9);
  const digitZ = freq.map(f => stdDigit > 0 ? (f - expDigit) / stdDigit : 0);

  // ---------- Even/Odd z-score ----------
  const evenCount = freq[0] + freq[2] + freq[4] + freq[6] + freq[8];
  const oddCount = freq[1] + freq[3] + freq[5] + freq[7] + freq[9];
  const expEven = n * 0.5;
  const stdEven = Math.sqrt(n * 0.25);
  const evenZ = stdEven > 0 ? (evenCount - expEven) / stdEven : 0;

  // ---------- Over/Under z-scores (thresholds 1..8) ----------
  // OVER th  = digits > th (count in th+1..9); p = (9-th)/10
  // UNDER th = digits < th (count in 0..th-1);  p = th/10
  const overZ = {};
  const underZ = {};
  for (let th = 1; th <= 8; th++) {
    const cntOver = freq.slice(th + 1).reduce((a, b) => a + b, 0);
    const pOver = (9 - th) / 10;
    const expOver = n * pOver;
    const stdOver = Math.sqrt(n * pOver * (1 - pOver));
    overZ[th] = stdOver > 0 ? (cntOver - expOver) / stdOver : 0;

    const cntUnder = freq.slice(0, th).reduce((a, b) => a + b, 0);
    const pUnder = th / 10;
    const expUnder = n * pUnder;
    const stdUnder = Math.sqrt(n * pUnder * (1 - pUnder));
    underZ[th] = stdUnder > 0 ? (cntUnder - expUnder) / stdUnder : 0;
  }

  // ---------- Rise/Fall z-score (excluding flat) ----------
  let riseCount = 0;
  let fallCount = 0;
  for (const d of dirArr) {
    if (d === 'up') riseCount++;
    else if (d === 'down') fallCount++;
  }
  const dirTotal = riseCount + fallCount;
  const expRise = dirTotal * 0.5;
  const stdRise = Math.sqrt(dirTotal * 0.25);
  const riseZ = stdRise > 0 ? (riseCount - expRise) / stdRise : 0;

  // ---------- Streaks ----------
  // currentStreak — length of the TRAILING same-parity run
  let currentStreak = 0;
  let currentStreakParity = null;
  for (let i = arr.length - 1; i >= 0; i--) {
    const p = arr[i] % 2 === 0 ? 'even' : 'odd';
    if (currentStreakParity === null) currentStreakParity = p;
    if (p !== currentStreakParity) break;
    currentStreak++;
  }

  // maxRecentStreak — longest same-parity run ANYWHERE in window
  let maxRecentStreak = 0;
  let runLen = 0;
  let runParity = null;
  for (const d of arr) {
    const p = d % 2 === 0 ? 'even' : 'odd';
    if (p === runParity) runLen++;
    else { runLen = 1; runParity = p; }
    if (runLen > maxRecentStreak) maxRecentStreak = runLen;
  }

  // expectedMaxStreak — expected longest run of heads/tails in n flips
  // Empirically ~log2(n) + 0.33. For n=200 → 7.9; n=500 → 9.3; n=1000 → 10.3.
  const expectedMaxStreak = Math.log2(n) + 0.33;

  return {
    windowSize: n,
    // Per-feature z-scores
    digitZ,
    evenZ,
    oddZ: -evenZ,
    overZ,
    underZ,
    riseZ,
    fallZ: -riseZ,
    // Streak metrics
    currentStreak,
    currentStreakParity,
    maxRecentStreak,
    expectedMaxStreak,
    // Raw counts for reference (bot can double-check)
    evenCount,
    oddCount,
    riseCount,
    fallCount,
    dirTotal,
  };
}

class DigitAnalyzer extends EventEmitter {
  constructor() {
    super();
    this._state = new Map();
    this._lastSignal = new Map();
    this._lastWarnedPrecision = new Map();   // per-symbol, throttle precision log
    this._lastWarnedDegenerate = new Map();  // per-symbol, throttle corrupt-data log
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

    // [FIX-1] Use per-symbol precision instead of hardcoded 5.
    const precision = getDigitPrecision(symbol);
    const formatted = mid.toFixed(precision);
    const digit = parseInt(formatted[formatted.length - 1], 10);
    if (!Number.isFinite(digit)) return;

    // Log precision per symbol once (first tick only, per process).
    if (!this._lastWarnedPrecision.has(symbol)) {
      this._lastWarnedPrecision.set(symbol, true);
      logger.info(`[DigitAnalyzer] ${symbol} → precision=${precision} (mid=${mid} → digit=${digit})`);
    }

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

    // [FIX-2] Degenerate detection — throttle to once per 60s per symbol
    if (s.digits.length >= DEGENERATE_CHECK_SAMPLES) {
      const last = s.digits.slice(-DEGENERATE_CHECK_SAMPLES);
      const unique = new Set(last).size;
      if (unique < DEGENERATE_MIN_UNIQUE) {
        const lastWarn = this._lastWarnedDegenerate.get(symbol) || 0;
        if (Date.now() - lastWarn > 60000) {
          this._lastWarnedDegenerate.set(symbol, Date.now());
          logger.warn(
            `[DigitAnalyzer] ${symbol} DEGENERATE — only ${unique} unique digit(s) ` +
            `in last ${DEGENERATE_CHECK_SAMPLES} ticks (${JSON.stringify(Array.from(new Set(last)))}). ` +
            `Check precision or broker feed. Digit trading signals unreliable.`
          );
        }
      }
    }

    const view = this._computeView(s, symbol, mid, precision);
    this.emit('digitUpdate', view);

    const sig = this._detectSignal(symbol, view);
    if (sig) {
      this.emit('digitSignal', sig);
      this._lastSignal.set(symbol, sig);
    }
  }

  _computeView(s, symbol, currentPrice, precision) {
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
      precision,                       // expose so consumers can verify
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

      // [FIX-3] Z-scores computed from last DEFAULT_Z_WINDOW ticks.
      // null if fewer than Z_MIN_SAMPLES accumulated.
      zStats: computeZStats(digits, directions, DEFAULT_Z_WINDOW),

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
    const clean = normalizeSymbol(symbol);
    const s = this._state.get(clean);
    if (!s || !s.digits.length) return null;
    const precision = getDigitPrecision(clean);
    return this._computeView(s, symbol, s.lastPrice, precision);
  }

  // [FIX-3] Z-score view from a custom window size. Returns null if
  // fewer than Z_MIN_SAMPLES ticks are available.
  getZView(symbol, windowSize = DEFAULT_Z_WINDOW) {
    const clean = normalizeSymbol(symbol);
    const s = this._state.get(clean);
    if (!s || s.digits.length < Z_MIN_SAMPLES) return null;
    return computeZStats(s.digits, s.directions, windowSize);
  }

  getAllViews() {
    const out = {};
    for (const [symbol, s] of this._state) {
      if (s.digits.length > 0) {
        const precision = getDigitPrecision(symbol);
        out[symbol] = this._computeView(s, symbol, s.lastPrice, precision);
      }
    }
    return out;
  }

  getLastSignal(symbol) {
    return this._lastSignal.get(normalizeSymbol(symbol)) || null;
  }
}

const instance = new DigitAnalyzer();
module.exports = instance;
module.exports.getDigitPrecision = getDigitPrecision;
module.exports.computeZStats = computeZStats;    // [FIX-3] exposed for tests
module.exports.DEFAULT_Z_WINDOW = DEFAULT_Z_WINDOW;
module.exports.Z_MIN_SAMPLES = Z_MIN_SAMPLES;
