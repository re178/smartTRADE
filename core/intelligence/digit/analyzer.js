// core/intelligence/digit/analyzer.js
// Tracks the last digit of every tick. Computes:
//   • Digit frequency (0-9) over full history and over short/long windows
//   • Even/Odd percentages and streaks
//   • Rise/Fall percentages (higher/lower than previous tick) — DIRECTIONAL ONLY
//     (flats excluded from the denominator; flatPct reported separately)
//   • Current digit + arrow direction (ARROW IS NOW PRICE-BASED, NOT DIGIT-BASED)
//   • Over/Under edge (aligned to Deriv contract semantics: OVER N = digit > N;
//     UNDER N = digit < N)
//   • Z-scores for every statistic (statistical significance layer, unchanged)
//   • Directional (price) streak — tracked separately from parity streaks
//   • Movement metrics — net move, last vs. prev move, expanding/weakening,
//     breakout extension, range and net-to-range ratio
//
// Emits 'digitUpdate' per tick, 'digitSignal' when edge exceeds threshold.

'use strict';

const EventEmitter = require('events');
const priceBuffer = require('../../data/priceBuffer');
const logger = require('../../../infrastructure/logger') || console;

const MAX_HISTORY = 1000;
const SIGNAL_MIN_SAMPLES = 50;
const SIGNAL_MIN_EDGE = 0.08;
const DEGENERATE_CHECK_SAMPLES = 100;
const DEGENERATE_MIN_UNIQUE = 3;

const DEFAULT_Z_WINDOW = 200;
const Z_MIN_SAMPLES = 30;

// Window sizes for short/long measurement views.
const SHORT_WINDOW = 30;
const LONG_WINDOW = 100;

function normalizeSymbol(sym) {
  return String(sym || '').replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
}

function getDigitPrecision(symbol) {
  const clean = normalizeSymbol(symbol);
  const map = {
    EURUSD: 5, GBPUSD: 5, AUDUSD: 5, NZDUSD: 5, USDCHF: 5, USDCAD: 5,
    EURGBP: 5, EURAUD: 5, EURNZD: 5, GBPAUD: 5, GBPNZD: 5, AUDNZD: 5,
    AUDCAD: 5, AUDCHF: 5, NZDCAD: 5, NZDCHF: 5, CADCHF: 5,
    USDJPY: 3, EURJPY: 3, GBPJPY: 3, AUDJPY: 3, NZDJPY: 3, CADJPY: 3, CHFJPY: 3,
    XAUUSD: 2, XAGUSD: 3,
    BTCUSD: 2, ETHUSD: 2,
    R_10: 2, R_25: 2, R_50: 2, R_75: 2, R_100: 2,
    '1HZ10V': 2, '1HZ25V': 2, '1HZ50V': 2, '1HZ75V': 2, '1HZ100V': 2,
    '1HZ150V': 2, '1HZ250V': 2,
    JD10: 2, JD25: 2, JD50: 2, JD75: 2, JD100: 2,
    STPRNG: 2, 'STPRNG100': 2,
  };
  return map[clean] != null ? map[clean] : 2;
}

// ============================================================
//  Statistical layer — unchanged (already correct)
// ============================================================
function computeZStats(digits, directions, windowSize) {
  if (!Array.isArray(digits) || digits.length < Z_MIN_SAMPLES) return null;

  const n = Math.min(windowSize || DEFAULT_Z_WINDOW, digits.length);
  const arr = digits.slice(-n);
  const dirArr = Array.isArray(directions) ? directions.slice(-n) : [];

  const freq = new Array(10).fill(0);
  for (const d of arr) if (d >= 0 && d <= 9) freq[d]++;

  const expDigit = n * 0.1;
  const stdDigit = Math.sqrt(n * 0.1 * 0.9);
  const digitZ = freq.map(f => stdDigit > 0 ? (f - expDigit) / stdDigit : 0);

  const evenCount = freq[0] + freq[2] + freq[4] + freq[6] + freq[8];
  const oddCount  = freq[1] + freq[3] + freq[5] + freq[7] + freq[9];
  const expEven = n * 0.5;
  const stdEven = Math.sqrt(n * 0.25);
  const evenZ = stdEven > 0 ? (evenCount - expEven) / stdEven : 0;

  const overZ = {};
  const underZ = {};
  for (let th = 1; th <= 8; th++) {
    const cntOver = freq.slice(th + 1).reduce((a, b) => a + b, 0);   // digit > th
    const pOver = (9 - th) / 10;
    const expOver = n * pOver;
    const stdOver = Math.sqrt(n * pOver * (1 - pOver));
    overZ[th] = stdOver > 0 ? (cntOver - expOver) / stdOver : 0;

    const cntUnder = freq.slice(0, th).reduce((a, b) => a + b, 0);    // digit < th
    const pUnder = th / 10;
    const expUnder = n * pUnder;
    const stdUnder = Math.sqrt(n * pUnder * (1 - pUnder));
    underZ[th] = stdUnder > 0 ? (cntUnder - expUnder) / stdUnder : 0;
  }

  let riseCount = 0, fallCount = 0;
  for (const d of dirArr) {
    if (d === 'up') riseCount++;
    else if (d === 'down') fallCount++;
  }
  const dirTotal = riseCount + fallCount;
  const expRise = dirTotal * 0.5;
  const stdRise = Math.sqrt(dirTotal * 0.25);
  const riseZ = stdRise > 0 ? (riseCount - expRise) / stdRise : 0;

  let currentStreak = 0;
  let currentStreakParity = null;
  for (let i = arr.length - 1; i >= 0; i--) {
    const p = arr[i] % 2 === 0 ? 'even' : 'odd';
    if (currentStreakParity === null) currentStreakParity = p;
    if (p !== currentStreakParity) break;
    currentStreak++;
  }

  let maxRecentStreak = 0;
  let runLen = 0;
  let runParity = null;
  for (const d of arr) {
    const p = d % 2 === 0 ? 'even' : 'odd';
    if (p === runParity) runLen++;
    else { runLen = 1; runParity = p; }
    if (runLen > maxRecentStreak) maxRecentStreak = runLen;
  }
  const expectedMaxStreak = Math.log2(n) + 0.33;

  return {
    windowSize: n,
    digitZ, evenZ, oddZ: -evenZ, overZ, underZ,
    riseZ, fallZ: -riseZ,
    currentStreak, currentStreakParity, maxRecentStreak, expectedMaxStreak,
    evenCount, oddCount, riseCount, fallCount, dirTotal,
  };
}

// ============================================================
//  Window metrics — short/long directional + parity + digit freq
//  Rise/Fall percentages use a NON-FLAT denominator.
// ============================================================
function computeWindowMetrics(digits, directions, n) {
  const dSlice = digits.slice(-n);
  const dirSlice = directions.slice(-n);
  const total = dSlice.length || 1;

  const freq = new Array(10).fill(0);
  for (const x of dSlice) if (x >= 0 && x <= 9) freq[x]++;

  let up = 0, down = 0;
  for (const x of dirSlice) {
    if (x === 'up') up++;
    else if (x === 'down') down++;
  }
  const dirTotal = up + down;
  const even = freq[0] + freq[2] + freq[4] + freq[6] + freq[8];
  const odd  = freq[1] + freq[3] + freq[5] + freq[7] + freq[9];

  return {
    sampleSize: total,
    digitFreqPct: freq.map(f => Number(((f / total) * 100).toFixed(2))),
    // Directional (non-flat denominator)
    risePct: dirTotal > 0 ? Number(((up / dirTotal) * 100).toFixed(2)) : 0,
    fallPct: dirTotal > 0 ? Number(((down / dirTotal) * 100).toFixed(2)) : 0,
    // Parity (full window denominator — every tick has a digit)
    evenPct: Number(((even / total) * 100).toFixed(2)),
    oddPct:  Number(((odd  / total) * 100).toFixed(2)),
    riseCount: up,
    fallCount: down,
    flatCount: total - dirTotal,
  };
}

// ============================================================
//  Directional (price) streak — SEPARATE from parity streaks
// ============================================================
function computeDirectionalStreak(directions) {
  if (!Array.isArray(directions) || directions.length === 0) {
    return { side: null, length: 0 };
  }
  let side = null;
  let length = 0;
  for (let i = directions.length - 1; i >= 0; i--) {
    const d = directions[i];
    if (d === 'flat') break;
    if (side === null) side = d;
    if (d === side) length++;
    else break;
  }
  return { side, length };
}

// ============================================================
//  Movement strength — from prices, not digits
// ============================================================
function computeMovement(prices, window = LONG_WINDOW) {
  if (!Array.isArray(prices) || prices.length < 3) return null;

  const last  = prices[prices.length - 1];
  const prev  = prices[prices.length - 2];
  const prev2 = prices[prices.length - 3];

  const lastMove = last - prev;
  const prevMove = prev - prev2;
  const lastAbs  = Math.abs(lastMove);
  const prevAbs  = Math.abs(prevMove);
  const sameDir  = (lastMove > 0 && prevMove > 0) || (lastMove < 0 && prevMove < 0);
  const expanding = sameDir && prevAbs > 0 && lastAbs > prevAbs;
  const weakening = sameDir && lastAbs < prevAbs;

  const win = prices.slice(-window);
  const hi  = Math.max(...win);
  const lo  = Math.min(...win);
  const mid = (hi + lo) / 2;
  const netMove = last - win[0];
  const rangePct = mid > 0 ? ((hi - lo) / mid) * 100 : 0;
  const range = hi - lo;
  const netToRange = range > 0 ? Math.abs(netMove) / range : 0;

  // "latestExtends" = the latest move is directional AND at the window extreme
  const eps = 1e-12;
  const latestExtendsUp   = lastMove > 0 && last >= hi - eps;
  const latestExtendsDown = lastMove < 0 && last <= lo + eps;

  return {
    lastMove, prevMove, lastAbs, prevAbs,
    sameDir, expanding, weakening,
    netMove, rangePct, netToRange,
    latestExtendsUp, latestExtendsDown,
    windowSize: win.length,
    high: hi, low: lo, mid,
  };
}

class DigitAnalyzer extends EventEmitter {
  constructor() {
    super();
    this._state = new Map();
    this._lastSignal = new Map();
    this._lastWarnedPrecision = new Map();
    this._lastWarnedDegenerate = new Map();
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

    const precision = getDigitPrecision(symbol);
    const formatted = mid.toFixed(precision);
    const digit = parseInt(formatted[formatted.length - 1], 10);
    if (!Number.isFinite(digit)) return;

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
    // Non-flat directional denominator (fixes the flat-tick bias)
    const dirTotal = riseCount + fallCount;

    // ── FIX: arrow compares PRICES, not digits ──
    let arrow = 'flat';
    if (s.prices.length >= 2) {
      const prevP = s.prices[s.prices.length - 2];
      const curP  = s.prices[s.prices.length - 1];
      if (curP > prevP) arrow = 'up';
      else if (curP < prevP) arrow = 'down';
    }

    // Parity streak (unchanged semantics)
    let evenStreak = 0, oddStreak = 0, currentParity = null;
    for (let i = digits.length - 1; i >= 0; i--) {
      const p = digits[i] % 2 === 0 ? 'even' : 'odd';
      if (currentParity === null) currentParity = p;
      if (p !== currentParity) break;
      if (p === 'even') evenStreak++; else oddStreak++;
    }

    return {
      symbol,
      currentDigit: digits[digits.length - 1],
      previousDigit: digits.length >= 2 ? digits[digits.length - 2] : null,
      arrow,                          // NOW from prices
      price: currentPrice,
      precision,
      sampleSize: total,

      digitFreq: freq,
      digitFreqPct: freq.map(f => Number(((f / total) * 100).toFixed(2))),

      evenPct: Number(((evenCount / total) * 100).toFixed(2)),
      oddPct: Number(((oddCount  / total) * 100).toFixed(2)),

      // Directional (non-flat). flatPct kept on the FULL denominator.
      risePct: dirTotal > 0 ? Number(((riseCount / dirTotal) * 100).toFixed(2)) : 0,
      fallPct: dirTotal > 0 ? Number(((fallCount / dirTotal) * 100).toFixed(2)) : 0,
      flatPct: Number(((flatCount / total) * 100).toFixed(2)),

      currentParity,
      evenStreak,
      oddStreak,

      // Directional streak — price-based, separate from parity
      directionalStreak: computeDirectionalStreak(directions),

      // Movement strength — from prices
      movement: computeMovement(s.prices, LONG_WINDOW),

      // Short and long window aggregates
      windows: {
        short: computeWindowMetrics(digits, directions, SHORT_WINDOW),
        long:  computeWindowMetrics(digits, directions, LONG_WINDOW),
      },

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

    // Directional — uses the non-flat view.risePct / view.fallPct directly.
    let riseFall = null;
    if (view.risePct >= 50 + SIGNAL_MIN_EDGE * 100) {
      riseFall = { side: 'RISE', probability: view.risePct / 100, edge: view.risePct - 50 };
    } else if (view.fallPct >= 50 + SIGNAL_MIN_EDGE * 100) {
      riseFall = { side: 'FALL', probability: view.fallPct / 100, edge: view.fallPct - 50 };
    }

    // Over/Under — Deriv contract semantics:
    //   OVER  N wins on digit > N  → freq.slice(N + 1)
    //   UNDER N wins on digit < N  → freq.slice(0, N)
    let overUnder = null;
    let bestEdge = 0;
    for (let threshold = 1; threshold <= 8; threshold++) {
      const overCount  = view.digitFreq.slice(threshold + 1).reduce((a, b) => a + b, 0);
      const underCount = view.digitFreq.slice(0, threshold).reduce((a, b) => a + b, 0);
      const overPct  = (overCount  / view.sampleSize) * 100;
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
      evenOdd, riseFall, overUnder,
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
module.exports.computeZStats = computeZStats;
module.exports.computeWindowMetrics = computeWindowMetrics;
module.exports.computeDirectionalStreak = computeDirectionalStreak;
module.exports.computeMovement = computeMovement;
module.exports.DEFAULT_Z_WINDOW = DEFAULT_Z_WINDOW;
module.exports.Z_MIN_SAMPLES = Z_MIN_SAMPLES;
module.exports.SHORT_WINDOW = SHORT_WINDOW;
module.exports.LONG_WINDOW = LONG_WINDOW;
