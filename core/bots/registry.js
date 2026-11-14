// core/bots/registry.js
// (all header comments preserved from original)
'use strict';

const { EMA, BollingerBands } = require('../strategy/engine');

function normalizeSymbol(s) {
  return String(s || '').replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
}

function getPipSize(symbol) {
  const clean = normalizeSymbol(symbol);
  const map = {
    EURUSD: 0.0001, GBPUSD: 0.0001, AUDUSD: 0.0001, NZDUSD: 0.0001, USDCHF: 0.0001, USDCAD: 0.0001,
    USDJPY: 0.01, EURJPY: 0.01, GBPJPY: 0.01, AUDJPY: 0.01,
    XAUUSD: 0.01, XAGUSD: 0.001, BTCUSD: 0.1, ETHUSD: 0.01,
  };
  return map[clean] || 0.0001;
}

function getPricePrecision(symbol) {
  const clean = normalizeSymbol(symbol);
  const map = {
    EURUSD: 5, GBPUSD: 5, AUDUSD: 5, NZDUSD: 5, USDCHF: 5, USDCAD: 5,
    USDJPY: 3, EURJPY: 3, GBPJPY: 3, AUDJPY: 3,
    XAUUSD: 2, XAGUSD: 3, BTCUSD: 2, ETHUSD: 2,
  };
  return map[clean] != null ? map[clean] : 5;
}

function getBarrierPrecision(symbol) {
  const clean = normalizeSymbol(symbol);
  if (/^(R_|1HZ|JD|STPRNG)/i.test(clean)) return 2;
  return getPricePrecision(symbol);
}

function roundPrice(symbol, price) {
  if (price == null || !Number.isFinite(Number(price))) return null;
  const p = getPricePrecision(symbol);
  const f = Math.pow(10, p);
  return Math.round(Number(price) * f) / f;
}

function wait(reason) {
  return { action: 'WAIT', reasons: Array.isArray(reason) ? reason : [reason] };
}

function sanitizeDigitView(dv) {
  if (!dv) return null;
  const hasDirections = Array.isArray(dv.directions) && dv.directions.length >= 5;
  const freq = dv.digitFreq;
  const total = Number(dv.sampleSize) || 0;
  const hasFreq = Array.isArray(freq) && freq.length === 10 && total > 0;

  if (!hasDirections && !hasFreq) return null;

  if (hasFreq) {
    const freqSum = freq.reduce((a, b) => a + (Number(b) || 0), 0);
    if (Math.abs(freqSum - total) > total * 0.05) return null;
    const evenCount = (freq[0] || 0) + (freq[2] || 0) + (freq[4] || 0) + (freq[6] || 0) + (freq[8] || 0);
    const oddCount = (freq[1] || 0) + (freq[3] || 0) + (freq[5] || 0) + (freq[7] || 0) + (freq[9] || 0);
    const evenPct = (evenCount / total) * 100;
    const oddPct = (oddCount / total) * 100;
    if (Math.abs(evenPct + oddPct - 100) > 2) return null;
    return Object.assign({}, dv, { evenPct, oddPct });
  }

  if (Number(dv.evenStreak) > 200 || Number(dv.oddStreak) > 200) return null;
  return dv;
}

function shouldFlip(config, stats) {
  if (!config || !config.flipEnabled) return false;
  return !!(stats && stats.flipped);
}

function consensusAgrees(consensus, direction) {
  if (!consensus || !consensus.consensus) return false;
  const c = consensus.consensus;
  return c.action === 'SIGNAL' && c.direction === direction;
}

function enterMultiplier(direction, config, overrides, reasons) {
  const finalKnockout = (config.knockoutLevel != null && config.knockoutLevel !== '')
    ? Number(config.knockoutLevel)
    : (overrides.knockoutLevel != null ? Number(overrides.knockoutLevel) : null);
  const finalTakeProfit = (config.takeProfitLevel != null && config.takeProfitLevel !== '')
    ? Number(config.takeProfitLevel)
    : (overrides.takeProfitLevel != null ? Number(overrides.takeProfitLevel) : null);

  return {
    action: 'ENTER',
    direction,
    reasons,
    tradeParams: {
      symbol: config.symbol,
      direction,
      stake: config.stake,
      multiplier: config.multiplier,
      duration: null,
      durationUnit: null,
      knockoutLevel: roundPrice(config.symbol, finalKnockout),
      takeProfitLevel: roundPrice(config.symbol, finalTakeProfit),
      contractClass: 'multiplier',
    },
  };
}

function enterDigit(contractType, config, reason) {
  return {
    action: 'ENTER',
    direction: contractType,
    reasons: [reason],
    tradeParams: {
      symbol: config.symbol,
      contractType,
      stake: config.stake,
      duration: config.durationTicks,
      durationUnit: 't',
      contractClass: 'digit',
    },
  };
}

function enterDigitBarrier(contractType, barrier, config, reason) {
  return {
    action: 'ENTER',
    direction: contractType,
    reasons: [reason],
    tradeParams: {
      symbol: config.symbol,
      contractType,
      barrier,
      stake: config.stake,
      duration: config.durationTicks,
      durationUnit: 't',
      contractClass: 'digit',
    },
  };
}

function enterBinary(contractType, config, reason) {
  return {
    action: 'ENTER',
    direction: contractType,
    reasons: [reason],
    tradeParams: {
      symbol: config.symbol,
      contractType,
      stake: config.stake,
      duration: config.durationTicks,
      durationUnit: 't',
      contractClass: 'binary',
    },
  };
}

function enterTouch(touchDirection, barrier, config, reason) {
  const contractType = touchDirection === 'TOUCH' ? 'ONETOUCH' : 'NOTOUCH';
  return {
    action: 'ENTER',
    direction: contractType,
    reasons: [reason],
    tradeParams: {
      symbol: config.symbol,
      contractClass: 'touch',
      contractType,
      touchDirection,
      barrier: String(barrier),
      stake: config.stake,
      duration: config.durationMinutes != null ? Number(config.durationMinutes) : 10,
      durationUnit: 'm',
    },
  };
}

function enterVanilla(direction, barrier, config, reason) {
  const contractType = direction === 'BUY' ? 'VANILLALONGCALL' : 'VANILLALONGPUT';
  return {
    action: 'ENTER',
    direction,
    reasons: [reason],
    tradeParams: {
      symbol: config.symbol,
      contractClass: 'vanilla',
      contractType,
      direction,
      barrier: String(barrier),
      stake: config.stake,
      duration: config.durationMinutes != null ? Number(config.durationMinutes) : 60,
      durationUnit: 'm',
    },
  };
}

function enterTurbo(direction, barrier, config, reason) {
  const contractType = direction === 'BUY' ? 'TURBOSLONG' : 'TURBOSSHORT';
  const takeProfit = config.turboTakeProfit != null && Number(config.turboTakeProfit) > 0
    ? Number(config.turboTakeProfit)
    : null;
  return {
    action: 'ENTER',
    direction,
    reasons: [reason],
    tradeParams: {
      symbol: config.symbol,
      contractClass: 'turbo',
      contractType,
      direction,
      barrier: String(barrier),
      stake: config.stake,
      duration: config.durationMinutes != null ? Number(config.durationMinutes) : 15,
      durationUnit: 'm',
      takeProfit,
    },
  };
}

function enterAccumulator(growthRate, config, reason) {
  const takeProfit = config.accumulatorTakeProfit != null && Number(config.accumulatorTakeProfit) > 0
    ? Number(config.accumulatorTakeProfit)
    : null;
  return {
    action: 'ENTER',
    direction: 'ACCU',
    reasons: [reason],
    tradeParams: {
      symbol: config.symbol,
      contractClass: 'accumulator',
      contractType: 'ACCU',
      growthRate: Number(growthRate),
      stake: config.stake,
      duration: config.durationTicks != null ? Number(config.durationTicks) : 30,
      durationUnit: 't',
      takeProfit,
    },
  };
}

// ════════════════════════════════════════════════════════════════
// BOTS
// ════════════════════════════════════════════════════════════════
const BOTS = {

  // ── FX Multiplier (7) — UNCHANGED ──
  trend_rider: {
    id: 'trend_rider', name: 'Trend Rider',
    description: 'FX Multiplier. Tight Stop, Wide Target. Requires strategy consensus.',
    assetClass: 'fx', contractClass: 'multiplier',
    baseRate: 0.20,
    defaultConfig: {
      symbol: 'EURUSD', timeframe: 'M5', stake: 10, multiplier: 200,
      durationSec: 1800, minConfidence: 70, stopAfterLosses: 3,
      minRiskReward: 2.0, requireConsensus: true,
      knockoutLevel: null, takeProfitLevel: null,
    },
    evaluate(ctx) {
      const { state, prediction, consensus, config } = ctx;
      if (!state || !prediction) return wait('No state');
      if (prediction.direction === 'NEUTRAL') return wait('Neutral direction');
      if (prediction.calibratedConfidence < config.minConfidence) {
        return wait(`Conf ${prediction.calibratedConfidence} < ${config.minConfidence}`);
      }
      if (config.requireConsensus && !consensusAgrees(consensus, prediction.direction)) {
        return wait('Strategy consensus does not agree');
      }
      const atr = state.volatility && state.volatility.atr;
      if (!atr || atr <= 0) return wait('No ATR');
      const dir = prediction.direction;
      const entry = state.price.current;
      const pip = getPipSize(config.symbol);
      const koDist = Math.max(atr * 1.0, pip * 5);
      const tpDist = Math.max(atr * 4.0, pip * 15);
      const ko = dir === 'BUY' ? entry - koDist : entry + koDist;
      const tp = dir === 'BUY' ? entry + tpDist : entry - tpDist;
      return enterMultiplier(dir, config,
        { knockoutLevel: ko, takeProfitLevel: tp },
        [`Pattern ${prediction.pattern.bias} (${prediction.pattern.confidence}%)`]);
    },
  },

  range_scalper: {
    id: 'range_scalper', name: 'Range Scalper',
    description: 'FX Multiplier. S/R bounce in RANGING. Requires strategy consensus.',
    assetClass: 'fx', contractClass: 'multiplier',
    baseRate: 0.21,
    defaultConfig: {
      symbol: 'EURUSD', timeframe: 'M5', stake: 5, multiplier: 200,
      durationSec: 900, minRiskReward: 2.0, requireConsensus: true,
      knockoutLevel: null, takeProfitLevel: null,
    },
    evaluate(ctx) {
      const { state, config, consensus } = ctx;
      if (!state) return wait('No state');
      if (state.regime && state.regime.code !== 'RANGING') return wait('Not RANGING');
      const atS = state.structure && state.structure.isAtSupport;
      const atR = state.structure && state.structure.isAtResistance;
      if (!atS && !atR) return wait('Not at S/R');
      const dir = atS ? 'BUY' : 'SELL';
      if (config.requireConsensus && !consensusAgrees(consensus, dir)) {
        return wait('Strategy consensus does not agree');
      }
      const atr = state.volatility.atr;
      const entry = state.price.current;
      const pip = getPipSize(config.symbol);
      const koDist = Math.max(atr * 0.8, pip * 5);
      const tpDist = Math.max(atr * 3.0, pip * 10);
      const ko = dir === 'BUY' ? entry - koDist : entry + koDist;
      const tp = dir === 'BUY' ? entry + tpDist : entry - tpDist;
      return enterMultiplier(dir, config,
        { knockoutLevel: ko, takeProfitLevel: tp },
        [atS ? 'At support' : 'At resistance']);
    },
  },

  breakout_hunter: {
    id: 'breakout_hunter', name: 'Breakout Hunter',
    description: 'FX Multiplier. 20-candle breakout. Requires consensus.',
    assetClass: 'fx', contractClass: 'multiplier',
    baseRate: 0.18,
    defaultConfig: {
      symbol: 'EURUSD', timeframe: 'M5', stake: 10, multiplier: 200,
      durationSec: 1800, minAtrRatio: 1.2,
      minRiskReward: 2.0, requireConsensus: true,
      knockoutLevel: null, takeProfitLevel: null,
    },
    evaluate(ctx) {
      const { prediction, state, config, consensus } = ctx;
      if (!prediction || !state) return wait('No prediction');
      const patterns = (prediction.pattern && prediction.pattern.patterns) || [];
      const isUp = patterns.indexOf('breakout_up') >= 0;
      const isDown = patterns.indexOf('breakout_down') >= 0;
      if (!isUp && !isDown) return wait('No breakout detected');
      if (state.volatility.ratio < config.minAtrRatio) return wait('ATR too low');
      const dir = isUp ? 'BUY' : 'SELL';
      if (config.requireConsensus && !consensusAgrees(consensus, dir)) {
        return wait('Strategy consensus does not agree');
      }
      const atr = state.volatility.atr;
      const entry = state.price.current;
      const pip = getPipSize(config.symbol);
      const koDist = Math.max(atr * 1.0, pip * 5);
      const tpDist = Math.max(atr * 4.5, pip * 15);
      const ko = dir === 'BUY' ? entry - koDist : entry + koDist;
      const tp = dir === 'BUY' ? entry + tpDist : entry - tpDist;
      return enterMultiplier(dir, config,
        { knockoutLevel: ko, takeProfitLevel: tp },
        [isUp ? 'Breakout up' : 'Breakout down']);
    },
  },

  momentum_burst: {
    id: 'momentum_burst', name: 'Momentum Burst',
    description: 'FX Multiplier. Velocity scalping. Requires consensus.',
    assetClass: 'fx', contractClass: 'multiplier',
    baseRate: 0.25,
    defaultConfig: {
      symbol: 'EURUSD', timeframe: 'M1', stake: 5, multiplier: 400,
      durationSec: 300, velocityThreshold: 0.00005,
      minRiskReward: 2.0, requireConsensus: true,
      knockoutLevel: null, takeProfitLevel: null,
    },
    evaluate(ctx) {
      const { state, config, consensus } = ctx;
      if (!state) return wait('No state');
      const v = (state.awareness && state.awareness.velocity) || 0;
      const a = (state.awareness && state.awareness.acceleration) || 0;
      if (Math.abs(v) < config.velocityThreshold) return wait('Velocity too low');
      if (Math.sign(v) !== Math.sign(a) || Math.abs(a) < 0.000001) return wait('No acceleration');
      const dir = v > 0 ? 'BUY' : 'SELL';
      if (config.requireConsensus && !consensusAgrees(consensus, dir)) {
        return wait('Strategy consensus does not agree');
      }
      const atr = state.volatility.atr;
      const entry = state.price.current;
      const pip = getPipSize(config.symbol);
      const koDist = Math.max(atr * 0.8, pip * 4);
      const tpDist = Math.max(atr * 3.0, pip * 12);
      const ko = dir === 'BUY' ? entry - koDist : entry + koDist;
      const tp = dir === 'BUY' ? entry + tpDist : entry - tpDist;
      return enterMultiplier(dir, config,
        { knockoutLevel: ko, takeProfitLevel: tp },
        [`Velocity ${(v * 1e6).toFixed(1)}e-6`]);
    },
  },

  pattern_reversal: {
    id: 'pattern_reversal', name: 'Pattern Reversal',
    description: 'FX Multiplier. Reversal at S/R. Requires consensus.',
    assetClass: 'fx', contractClass: 'multiplier',
    baseRate: 0.20,
    defaultConfig: {
      symbol: 'EURUSD', timeframe: 'M5', stake: 8, multiplier: 200,
      durationSec: 1800, minRiskReward: 2.0, requireConsensus: true,
      knockoutLevel: null, takeProfitLevel: null,
    },
    evaluate(ctx) {
      const { prediction, state, config, consensus } = ctx;
      if (!prediction || !state) return wait('No state');
      const pats = (prediction.pattern && prediction.pattern.patterns) || [];
      const bullReversals = ['hammer', 'bullish_engulfing', 'morning_star', 'dragonfly_doji'];
      const bearReversals = ['shooting_star', 'bearish_engulfing', 'evening_star', 'gravestone_doji'];
      const hasBull = bullReversals.some(p => pats.indexOf(p) >= 0);
      const hasBear = bearReversals.some(p => pats.indexOf(p) >= 0);
      if (!hasBull && !hasBear) return wait('No reversal pattern');
      const atS = state.structure && state.structure.isAtSupport;
      const atR = state.structure && state.structure.isAtResistance;
      let dir = 'NEUTRAL';
      if (hasBull && atS) dir = 'BUY';
      else if (hasBear && atR) dir = 'SELL';
      if (dir === 'NEUTRAL') return wait('Pattern/level mismatch');
      if (config.requireConsensus && !consensusAgrees(consensus, dir)) {
        return wait('Strategy consensus does not agree');
      }
      const atr = state.volatility.atr;
      const entry = state.price.current;
      const pip = getPipSize(config.symbol);
      const koDist = Math.max(atr * 1.0, pip * 5);
      const tpDist = Math.max(atr * 4.0, pip * 15);
      const ko = dir === 'BUY' ? entry - koDist : entry + koDist;
      const tp = dir === 'BUY' ? entry + tpDist : entry - tpDist;
      return enterMultiplier(dir, config,
        { knockoutLevel: ko, takeProfitLevel: tp },
        [`Reversal: ${pats.join(', ')}`]);
    },
  },

  pullback_trader: {
    id: 'pullback_trader', name: 'Pullback Trader',
    description: 'FX Multiplier. EMA20 pullback. Requires consensus.',
    assetClass: 'fx', contractClass: 'multiplier',
    baseRate: 0.20,
    defaultConfig: {
      symbol: 'EURUSD', timeframe: 'M5', stake: 10, multiplier: 200,
      durationSec: 1800, minRiskReward: 2.0, requireConsensus: true,
      knockoutLevel: null, takeProfitLevel: null,
    },
    evaluate(ctx) {
      const { state, config, candles, consensus } = ctx;
      if (!state) return wait('No state');
      const regime = state.regime && state.regime.code;
      if (['STRONG_TREND_BULL', 'STRONG_TREND_BEAR', 'WEAK_TREND'].indexOf(regime) < 0) return wait('No trend');
      if (!candles || candles.length < 25) return wait('Not enough candles');
      const closes = candles.map(c => c.close);
      const emaArr = EMA(closes, 20);
      const ema = emaArr[emaArr.length - 1];
      const price = closes[closes.length - 1];
      if (!Number.isFinite(ema)) return wait('No EMA');
      const distPct = Math.abs(price - ema) / price;
      if (distPct > 0.001) return wait('Waiting for pullback');
      const dir = state.trend && state.trend.direction === 'bullish' ? 'BUY' : 'SELL';
      if (config.requireConsensus && !consensusAgrees(consensus, dir)) {
        return wait('Strategy consensus does not agree');
      }
      const atr = state.volatility.atr;
      const pip = getPipSize(config.symbol);
      const koDist = Math.max(atr * 1.0, pip * 5);
      const tpDist = Math.max(atr * 4.0, pip * 15);
      const ko = dir === 'BUY' ? ema - koDist : ema + koDist;
      const tp = dir === 'BUY' ? price + tpDist : price - tpDist;
      return enterMultiplier(dir, config,
        { knockoutLevel: ko, takeProfitLevel: tp },
        [`Pullback to EMA20`]);
    },
  },

  squeeze_breaker: {
    id: 'squeeze_breaker', name: 'Squeeze Breaker',
    description: 'FX Multiplier. BB squeeze breakout. Requires consensus.',
    assetClass: 'fx', contractClass: 'multiplier',
    baseRate: 0.20,
    defaultConfig: {
      symbol: 'EURUSD', timeframe: 'M5', stake: 10, multiplier: 200,
      durationSec: 1800, minRiskReward: 2.0, requireConsensus: true,
      knockoutLevel: null, takeProfitLevel: null,
    },
    evaluate(ctx) {
      const { state, config, candles, consensus } = ctx;
      if (!state || !candles || candles.length < 25) return wait('Not enough data');
      const closes = candles.map(c => c.close);
      const bb = BollingerBands(closes, 20, 2);
      if (!bb || !bb.bandwidth || bb.bandwidth.length < 20) return wait('No BB');
      const bw = bb.bandwidth[bb.bandwidth.length - 1];
      const avg = bb.bandwidth.slice(-20).reduce((a, b) => a + b, 0) / 20;
      if (bw >= avg * 0.5) return wait('No squeeze');
      const price = closes[closes.length - 1];
      const upper = bb.upper[bb.upper.length - 1];
      const lower = bb.lower[bb.lower.length - 1];
      let dir = 'NEUTRAL';
      if (price > upper) dir = 'BUY';
      else if (price < lower) dir = 'SELL';
      if (dir === 'NEUTRAL') return wait('No breakout');
      if (config.requireConsensus && !consensusAgrees(consensus, dir)) {
        return wait('Strategy consensus does not agree');
      }
      const atr = state.volatility.atr;
      const pip = getPipSize(config.symbol);
      const koDist = Math.max(atr * 1.0, pip * 5);
      const tpDist = Math.max(atr * 4.0, pip * 15);
      const ko = dir === 'BUY' ? price - koDist : price + koDist;
      const tp = dir === 'BUY' ? price + tpDist : price - tpDist;
      return enterMultiplier(dir, config,
        { knockoutLevel: ko, takeProfitLevel: tp },
        [`Squeeze breakout`]);
    },
  },

  // ── Synthetic Digit (5) — UNCHANGED ──
  even_odd_trader: {
    id: 'even_odd_trader', name: 'Even/Odd Trader',
    description: 'Synthetic digit. Fades extreme parity (|z| >= 2.0). Set mode="follow" to chase extremes instead. Flip NOT recommended (50/50).',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    baseRate: 0.50,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, minSamples: 100,
      zThreshold: 2.0,
      mode: 'fade',
      flipEnabled: false, flipBelowPct: 48, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      if (dv.sampleSize < ctx.config.minSamples) return wait('Not enough samples');
      const zs = dv.zStats;
      if (!zs) return wait(`Not enough data for z-scores (${dv.sampleSize} ticks, need 30+)`);
      const zThreshold = Number(ctx.config.zThreshold) || 2.0;
      const mode = ctx.config.mode || 'fade';
      const { config, stats } = ctx;
      let normalDir = null, zUsed = 0;
      if (zs.evenZ >= zThreshold) {
        normalDir = mode === 'fade' ? 'DIGITODD' : 'DIGITEVEN';
        zUsed = zs.evenZ;
      } else if (zs.evenZ <= -zThreshold) {
        normalDir = mode === 'fade' ? 'DIGITEVEN' : 'DIGITODD';
        zUsed = -zs.evenZ;
      }
      if (!normalDir) return wait(`evenZ=${zs.evenZ.toFixed(2)} (need |z| >= ${zThreshold}, N=${zs.windowSize})`);
      const flip = shouldFlip(config, stats);
      const finalDir = flip ? (normalDir === 'DIGITEVEN' ? 'DIGITODD' : 'DIGITEVEN') : normalDir;
      const reason = flip
        ? `${normalDir} FLIPPED → ${finalDir} (z=${zUsed.toFixed(2)})`
        : `${normalDir.replace('DIGIT','')} (${mode}) z=${zUsed.toFixed(2)} N=${zs.windowSize}`;
      return enterDigit(finalDir, config, reason);
    },
  },

  over_under_trader: {
    id: 'over_under_trader', name: 'Over/Under Trader',
    description: 'Synthetic digit. Fades z-extreme at OVER 6 / UNDER 3 (30% base WR, ~2.9x payout). Much lower variance than OVER 8 / UNDER 1.',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    baseRate: 0.30,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5,
      overThreshold: 6, underThreshold: 3,
      minSamples: 100, zThreshold: 2.0,
      flipEnabled: false, flipBelowPct: 30, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      if (dv.sampleSize < ctx.config.minSamples) return wait('Not enough samples');
      const zs = dv.zStats;
      if (!zs) return wait(`Not enough data for z-scores (${dv.sampleSize} ticks, need 30+)`);
      const zThreshold = Number(ctx.config.zThreshold) || 2.0;
      const overTh = Number(ctx.config.overThreshold) || 6;
      const underTh = Number(ctx.config.underThreshold) || 3;
      const overZ = zs.overZ[overTh];
      const underZ = zs.underZ[underTh];
      let normalDir = null, barrier = null, zUsed = 0;
      if (overZ <= -zThreshold)       { normalDir = 'DIGITOVER';  barrier = overTh;  zUsed = overZ; }
      else if (underZ <= -zThreshold) { normalDir = 'DIGITUNDER'; barrier = underTh; zUsed = underZ; }
      if (!normalDir) return wait(`overZ[${overTh}]=${overZ.toFixed(2)} underZ[${underTh}]=${underZ.toFixed(2)} (need <= -${zThreshold}, N=${zs.windowSize})`);
      const flip = shouldFlip(ctx.config, ctx.stats);
      let finalDir = normalDir;
      if (flip) {
        finalDir = normalDir === 'DIGITOVER' ? 'DIGITUNDER' : 'DIGITOVER';
        barrier = finalDir === 'DIGITOVER' ? overTh : underTh;
      }
      const reason = flip
        ? `${normalDir} FLIPPED → ${finalDir} barrier=${barrier} (z=${zUsed.toFixed(2)})`
        : `${normalDir} barrier=${barrier} z=${zUsed.toFixed(2)} N=${zs.windowSize}`;
      return enterDigitBarrier(finalDir, barrier, ctx.config, reason);
    },
  },

  matches_differs_trader: {
    id: 'matches_differs_trader', name: 'Matches/Differs Trader',
    description: 'Synthetic digit. Fires DIGITDIFF when target digit is statistically HOT (z >= 2.0). ~90% base WR. Set mode="match_cold" for the high-payout MATCH path. Flip is MATHEMATICALLY VALID.',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    baseRate: 0.10,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, targetDigit: 5,
      minSamples: 150, zThreshold: 2.0,
      mode: 'diff_hot',
      flipEnabled: true, flipBelowPct: 80, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      if (dv.sampleSize < ctx.config.minSamples) return wait('Not enough samples');
      const zs = dv.zStats;
      if (!zs) return wait(`Not enough data for z-scores (${dv.sampleSize} ticks, need 30+)`);
      const zThreshold = Number(ctx.config.zThreshold) || 2.0;
      const target = Number(ctx.config.targetDigit) || 5;
      const mode = ctx.config.mode || 'diff_hot';
      const targetZ = zs.digitZ[target];

      let normalDir, reason;
      if (mode === 'diff_hot') {
        if (targetZ < zThreshold) return wait(`digit ${target} z=${targetZ.toFixed(2)} (need >= +${zThreshold} for DIFF_HOT, N=${zs.windowSize})`);
        normalDir = 'DIGITDIFF';
        reason = `digit ${target} HOT z=${targetZ.toFixed(2)} → DIGITDIFF`;
      } else {
        if (targetZ > -zThreshold) return wait(`digit ${target} z=${targetZ.toFixed(2)} (need <= -${zThreshold} for MATCH_COLD, N=${zs.windowSize})`);
        normalDir = 'DIGITMATCH';
        reason = `digit ${target} COLD z=${targetZ.toFixed(2)} → DIGITMATCH`;
      }

      const flip = shouldFlip(ctx.config, ctx.stats);
      const finalDir = flip ? (normalDir === 'DIGITMATCH' ? 'DIGITDIFF' : 'DIGITMATCH') : normalDir;
      if (flip) reason += ` FLIPPED → ${finalDir}`;
      return enterDigitBarrier(finalDir, target, ctx.config, reason);
    },
  },

  digit_streak_fade: {
    id: 'digit_streak_fade', name: 'Digit Streak Fade',
    description: 'Synthetic digit. Fades even/odd streaks (6+) or beyond the statistical expected max. Flip NOT recommended (symmetric).',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    baseRate: 0.50,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5,
      minStreak: 6, streakExtra: 0,
      flipEnabled: false, flipBelowPct: 48, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      const zs = dv.zStats;
      const evenStreak = dv.evenStreak || 0;
      const oddStreak = dv.oddStreak || 0;
      let required = Number(ctx.config.minStreak) || 6;
      let expectedMax = null;
      if (zs && Number.isFinite(zs.expectedMaxStreak)) {
        expectedMax = zs.expectedMaxStreak;
        required = Math.ceil(expectedMax) + (Number(ctx.config.streakExtra) || 0);
      }
      let normalDir = null;
      if (evenStreak >= required) normalDir = 'DIGITODD';
      else if (oddStreak >= required) normalDir = 'DIGITEVEN';
      if (!normalDir) return wait(`Streak: even=${evenStreak} odd=${oddStreak} (need ${required}${expectedMax != null ? `, expectedMax=${expectedMax.toFixed(1)}` : ''})`);
      const flip = shouldFlip(ctx.config, ctx.stats);
      const finalDir = flip ? (normalDir === 'DIGITEVEN' ? 'DIGITODD' : 'DIGITEVEN') : normalDir;
      const reason = flip
        ? `${normalDir} fade FLIPPED → ${finalDir}`
        : `${Math.max(evenStreak, oddStreak)}-streak — fade to ${finalDir.replace('DIGIT','')}`;
      return enterDigit(finalDir, ctx.config, reason);
    },
  },

  digit_hot_cold: {
    id: 'digit_hot_cold', name: 'Digit Hot/Cold',
    description: 'Synthetic digit. Fades z-extreme at OVER 6 / UNDER 3 with a tight z gate (2.2). Fewer fires, higher per-fire confidence.',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    baseRate: 0.30,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5,
      overThreshold: 6, underThreshold: 3,
      minSamples: 150, zThreshold: 2.2,
      flipEnabled: false, flipBelowPct: 30, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      if (dv.sampleSize < ctx.config.minSamples) return wait('Not enough samples');
      const zs = dv.zStats;
      if (!zs) return wait(`Not enough data for z-scores (${dv.sampleSize} ticks, need 30+)`);
      const zThreshold = Number(ctx.config.zThreshold) || 2.2;
      const overTh = Number(ctx.config.overThreshold) || 6;
      const underTh = Number(ctx.config.underThreshold) || 3;
      const overZ = zs.overZ[overTh];
      const underZ = zs.underZ[underTh];
      let normalDir = null, barrier = null, zUsed = 0;
      if (overZ <= -zThreshold)       { normalDir = 'DIGITOVER';  barrier = overTh;  zUsed = overZ; }
      else if (underZ <= -zThreshold) { normalDir = 'DIGITUNDER'; barrier = underTh; zUsed = underZ; }
      if (!normalDir) return wait(`over${overTh}Z=${overZ.toFixed(2)} under${underTh}Z=${underZ.toFixed(2)} (need <= -${zThreshold}, N=${zs.windowSize})`);
      const flip = shouldFlip(ctx.config, ctx.stats);
      let finalDir = normalDir;
      if (flip) {
        finalDir = normalDir === 'DIGITOVER' ? 'DIGITUNDER' : 'DIGITOVER';
        barrier = finalDir === 'DIGITOVER' ? overTh : underTh;
      }
      const reason = flip
        ? `${normalDir} FLIPPED → ${finalDir} barrier=${barrier} (z=${zUsed.toFixed(2)})`
        : `${normalDir} barrier=${barrier} z=${zUsed.toFixed(2)} N=${zs.windowSize}`;
      return enterDigitBarrier(finalDir, barrier, ctx.config, reason);
    },
  },

  // ── Synthetic Binary (5) — [IMPROVED MATHEMATICS] ──

  rise_fall_momentum: {
    id: 'rise_fall_momentum', name: 'Rise/Fall Momentum',
    description: 'Synthetic CALL/PUT. Directional bias (non-flat denominator) + momentum confirmation. Rejects sharply weakened momentum. Shadow = observational (no real-money gate).',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    baseRate: 0.50,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5,
      minBias: 0.62,
      minSamples: 100,
      weakeningThreshold: 0.5,
      shadowWinsRequired: 0,
      shadowObservational: true,
      flipEnabled: false, flipBelowPct: 48, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      if (dv.sampleSize < ctx.config.minSamples) return wait('Not enough samples');
      const { config, stats } = ctx;

      // risePct / fallPct now use a non-flat directional denominator.
      const risePct = dv.risePct / 100;
      const fallPct = dv.fallPct / 100;

      let normalDir = null, biasUsed = 0;
      if (risePct >= config.minBias) { normalDir = 'CALL'; biasUsed = risePct; }
      else if (fallPct >= config.minBias) { normalDir = 'PUT'; biasUsed = fallPct; }
      if (!normalDir) {
        return wait(`Rise ${(risePct * 100).toFixed(1)}% / Fall ${(fallPct * 100).toFixed(1)}% (Need >=${(config.minBias * 100).toFixed(0)}%)`);
      }

      const mv = dv.movement;
      if (!mv) return wait('No movement data');

      const expectedDirection = normalDir === 'CALL' ? 'up' : 'down';
      const latestAgrees = (expectedDirection === 'up' && mv.lastMove > 0) ||
                           (expectedDirection === 'down' && mv.lastMove < 0);

      // Reject if the streak has sharply weakened (last move < prev * weakeningThreshold)
      const wThresh = Number(config.weakeningThreshold) || 0.5;
      if (mv.sameDir && mv.prevAbs > 0 && mv.lastAbs < mv.prevAbs * wThresh) {
        return wait(`Momentum weakening (last=${mv.lastAbs.toFixed(5)} < ${mv.prevAbs.toFixed(5)}×${wThresh})`);
      }
      // Reject if the latest move is against bias AND larger than the prior move
      if (!latestAgrees && mv.prevAbs > 0 && mv.lastAbs > mv.prevAbs * 1.5) {
        return wait('Recent adverse move exceeds prior (momentum reversed)');
      }

      const flip = shouldFlip(config, stats);
      const finalDir = flip ? (normalDir === 'CALL' ? 'PUT' : 'CALL') : normalDir;
      const reason = flip
        ? `${normalDir} (${(biasUsed * 100).toFixed(1)}%) FLIPPED → ${finalDir}`
        : `Bias ${(biasUsed * 100).toFixed(1)}% + momentum confirmed`;
      return enterBinary(finalDir, config, reason);
    },
  },

  rise_fall_streak: {
    id: 'rise_fall_streak', name: 'Rise/Fall Streak Fade',
    description: 'Synthetic CALL/PUT. Fades directional streaks ONLY when per-move size is weakening (exhaustion). Shadow = observational (no real-money gate).',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    baseRate: 0.50,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5,
      minStreak: 7,
      weakenRatio: 0.7,
      shadowWinsRequired: 0,
      shadowObservational: true,
      flipEnabled: false, flipBelowPct: 48, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      const { config, stats } = ctx;

      const ds = dv.directionalStreak;
      if (!ds || ds.length < config.minStreak) {
        return wait(`Directional streak ${ds ? ds.length : 0}/${config.minStreak}`);
      }
      const mv = dv.movement;
      if (!mv) return wait('No movement data');

      // Fade only when the streak is losing strength — require lastAbs < prevAbs * weakenRatio
      const wRatio = Number(config.weakenRatio) || 0.7;
      if (!mv.weakening || mv.prevAbs <= 0 || mv.lastAbs > mv.prevAbs * wRatio) {
        return wait(`Streak not weakening (last=${mv.lastAbs.toFixed(5)} prev=${mv.prevAbs.toFixed(5)}, need < ${wRatio}×)`);
      }

      const normalDir = ds.side === 'up' ? 'PUT' : 'CALL';
      const flip = shouldFlip(config, stats);
      const finalDir = flip ? (normalDir === 'CALL' ? 'PUT' : 'CALL') : normalDir;
      const reason = flip
        ? `${ds.length}-tick ${ds.side}-streak weakening FLIPPED → ${finalDir}`
        : `${ds.length}-tick ${ds.side}-streak weakening → fade to ${finalDir}`;
      return enterBinary(finalDir, config, reason);
    },
  },

  rise_fall_breakout: {
    id: 'rise_fall_breakout', name: 'Rise/Fall Breakout',
    description: 'Synthetic CALL/PUT. Net move relative to real price range; latest price must be extending; already-reversed breakouts rejected. Shadow = observational (no real-money gate).',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    baseRate: 0.50,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5,
      lookbackTicks: 10, minMovePct: 0.08,
      minNetToRange: 0.4,
      shadowWinsRequired: 0,
      shadowObservational: true,
      flipEnabled: false, flipBelowPct: 48, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      const { config, stats } = ctx;

      const prices = (dv.recentPrices || []).slice(-config.lookbackTicks);
      if (prices.length < 5) return wait('Not enough prices');

      const first = prices[0];
      const last = prices[prices.length - 1];
      const movePct = ((last - first) / first) * 100;
      if (Math.abs(movePct) < config.minMovePct) {
        return wait(`Move ${movePct.toFixed(3)}% too small (Need ${config.minMovePct.toFixed(3)}%)`);
      }

      const mv = dv.movement;
      if (!mv) return wait('No movement data');

      // Net movement should be substantial relative to the price range —
      // filters out choppy stretches that merely happen to have a net drift.
      const minNR = Number(config.minNetToRange) || 0.4;
      if (mv.netToRange < minNR) {
        return wait(`Choppy: net/range ${mv.netToRange.toFixed(2)} < ${minNR}`);
      }

      const normalDir = movePct > 0 ? 'CALL' : 'PUT';

      // Reject breakouts that have already reversed
      if (normalDir === 'CALL' && !mv.latestExtendsUp) {
        return wait('Breakout already reversing (latest price not extending up)');
      }
      if (normalDir === 'PUT' && !mv.latestExtendsDown) {
        return wait('Breakdown already reversing (latest price not extending down)');
      }

      const flip = shouldFlip(config, stats);
      const finalDir = flip ? (normalDir === 'CALL' ? 'PUT' : 'CALL') : normalDir;
      const reason = flip
        ? `Move ${movePct.toFixed(3)}% (ext) FLIPPED → ${finalDir}`
        : `Breakout ${movePct.toFixed(3)}% (net/range ${mv.netToRange.toFixed(2)})`;
      return enterBinary(finalDir, config, reason);
    },
  },

  vol_high_low: {
    id: 'vol_high_low', name: 'Volatility High/Low',
    description: 'Synthetic CALL/PUT on persistent directional pressure: short+long windows agree, latest move confirms, outsized single-move bias rejected. Shadow = observational (no real-money gate).',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    baseRate: 0.50,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5,
      barrierPips: 10,
      upThreshold: 0.65,
      downThreshold: 0.35,
      minDirectionalSamples: 30,
      shadowWinsRequired: 0,
      shadowObservational: true,
      flipEnabled: false, flipBelowPct: 48, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      const { config, stats } = ctx;

      const win = dv.windows;
      if (!win || !win.short || !win.long) return wait('No window data');
      const short = win.short;
      const long  = win.long;
      if (short.sampleSize < config.minDirectionalSamples) {
        return wait(`Not enough short-window samples (${short.sampleSize})`);
      }
      if (long.sampleSize < config.minDirectionalSamples) {
        return wait(`Not enough long-window samples (${long.sampleSize})`);
      }

      const upShort = short.risePct;
      const upLong  = long.risePct;

      let normalDir = null, biasUsed = 0;
      if (upShort >= config.upThreshold * 100 && upLong > 50) {
        normalDir = 'CALL'; biasUsed = upShort;
      } else if (upShort <= config.downThreshold * 100 && upLong < 50) {
        normalDir = 'PUT'; biasUsed = 100 - upShort;
      }
      if (!normalDir) {
        return wait(`Short up=${upShort.toFixed(0)}% long up=${upLong.toFixed(0)}% (need consistent >=${(config.upThreshold * 100).toFixed(0)}% or <=${(config.downThreshold * 100).toFixed(0)}%)`);
      }

      const mv = dv.movement;
      if (!mv) return wait('No movement data');

      // Latest move must agree with the bias
      if (normalDir === 'CALL' && mv.lastMove <= 0) return wait('Latest move disagrees with CALL bias');
      if (normalDir === 'PUT'  && mv.lastMove >= 0) return wait('Latest move disagrees with PUT bias');

      // Reject if a single outsized move dominates — avoid "one spike ≠ trend"
      if (mv.sameDir && mv.prevAbs > 0 && mv.lastAbs > mv.prevAbs * 3) {
        return wait(`Outsized move (${mv.lastAbs.toFixed(5)} > 3× ${mv.prevAbs.toFixed(5)})`);
      }

      const flip = shouldFlip(config, stats);
      const finalDir = flip ? (normalDir === 'CALL' ? 'PUT' : 'CALL') : normalDir;
      const reason = flip
        ? `${normalDir} bias FLIPPED → ${finalDir} (short=${upShort.toFixed(0)}% long=${upLong.toFixed(0)}%)`
        : `Persistent ${normalDir} (short ${upShort.toFixed(0)}% long ${upLong.toFixed(0)}%)`;
      return enterBinary(finalDir, config, reason);
    },
  },

  vol_scalper: {
    id: 'vol_scalper', name: 'Volatility Scalper',
    description: 'Synthetic CALL/PUT. fade mode requires directional streak + weakening per-move size; follow mode requires expanding per-move size. Trend-conflict filter preserved. Shadow = observational (no real-money gate).',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    baseRate: 0.50,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5,
      minStreak: 7,
      mode: 'fade',
      trendConflictPct: 0.65,
      weakeningRatio: 0.8,
      expandingRatio: 1.1,
      minSamples: 30,
      shadowWinsRequired: 0,
      shadowObservational: true,
      flipEnabled: false, flipBelowPct: 48, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      if ((dv.sampleSize || 0) < ctx.config.minSamples) return wait('Not enough samples');
      const { config, stats } = ctx;

      const ds = dv.directionalStreak;
      if (!ds || ds.length < config.minStreak) {
        return wait(`Directional streak ${ds ? ds.length : 0}/${config.minStreak} ${ds ? ds.side : '-'}`);
      }
      const mv = dv.movement;
      if (!mv) return wait('No movement data');

      // Trend-conflict filter — uses short-window non-flat bias
      const shortWin = dv.windows && dv.windows.short;
      let bias = 0.5;
      if (shortWin) {
        bias = ds.side === 'up' ? shortWin.risePct / 100 : shortWin.fallPct / 100;
      }
      if (config.mode === 'fade' && bias > config.trendConflictPct) {
        return wait(`Trend conflict: ${ds.side}-bias ${(bias * 100).toFixed(0)}% > ${(config.trendConflictPct * 100).toFixed(0)}% — won't fade a strong trend`);
      }
      if (config.mode === 'follow' && bias < config.trendConflictPct) {
        return wait(`Weak trend: ${ds.side}-bias ${(bias * 100).toFixed(0)}% < ${(config.trendConflictPct * 100).toFixed(0)}% — follow needs trend confirmation`);
      }

      // Mode-specific movement requirement
      if (config.mode === 'fade') {
        const wRatio = Number(config.weakeningRatio) || 0.8;
        if (!mv.weakening || mv.prevAbs <= 0 || mv.lastAbs > mv.prevAbs * wRatio) {
          return wait(`Fade needs weakening (last=${mv.lastAbs.toFixed(5)} prev=${mv.prevAbs.toFixed(5)})`);
        }
      } else if (config.mode === 'follow') {
        const eRatio = Number(config.expandingRatio) || 1.1;
        if (!mv.expanding || mv.prevAbs <= 0 || mv.lastAbs < mv.prevAbs * eRatio) {
          return wait(`Follow needs expanding (last=${mv.lastAbs.toFixed(5)} prev=${mv.prevAbs.toFixed(5)})`);
        }
      }

      let normalDir;
      if (config.mode === 'fade') normalDir = ds.side === 'up' ? 'PUT' : 'CALL';
      else                        normalDir = ds.side === 'up' ? 'CALL' : 'PUT';

      const flip = shouldFlip(config, stats);
      const finalDir = flip ? (normalDir === 'CALL' ? 'PUT' : 'CALL') : normalDir;
      const reason = flip
        ? `${ds.length}-tick ${ds.side} ${config.mode} FLIPPED → ${finalDir} (bias ${(bias * 100).toFixed(0)}%)`
        : `${ds.length}-tick ${ds.side} ${config.mode} → ${finalDir} (bias ${(bias * 100).toFixed(0)}%)`;
      return enterBinary(finalDir, config, reason);
    },
  },

  // ── High-Payout (4) — UNCHANGED ──
  touch_hunter: {
    id: 'touch_hunter', name: 'Touch Hunter',
    description: 'Touch/No Touch on far barriers after consolidation. High payout (200-350%) on far touches. Low win rate — designed for big wins.',
    assetClass: 'synthetic_binary', contractClass: 'touch',
    baseRate: 0.25,
    defaultConfig: {
      symbol: 'R_100', stake: 1, barrierAtr: 2.0, durationMinutes: 10,
      touchDirection: 'TOUCH', requireConsensus: true, minSqueezeRatio: 0.8,
      shadowWinsRequired: 0,
      flipEnabled: false, flipBelowPct: 48, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const { state, consensus, config } = ctx;
      if (!state) return wait('No market state');
      const regime = state.regime && state.regime.code;
      const volRatio = state.volatility && state.volatility.ratio;
      const isConsolidating = regime === 'RANGING' || (Number.isFinite(volRatio) && volRatio < config.minSqueezeRatio);
      if (!isConsolidating) return wait(`Not consolidating: regime=${regime || '?'}, volRatio=${Number(volRatio).toFixed(2)} (need RANGING or volRatio < ${config.minSqueezeRatio})`);
      const atr = state.volatility && state.volatility.atr;
      if (!atr || atr <= 0) return wait('No ATR available');
      let direction = null;
      if (consensus && consensus.consensus && consensus.consensus.action === 'SIGNAL') direction = consensus.consensus.direction;
      else if (config.requireConsensus) return wait('No consensus direction — need BUY or SELL bias');
      else direction = (state.trend && state.trend.direction === 'bullish') ? 'BUY' : 'SELL';
      const entry = state.price && state.price.current;
      if (!entry || entry <= 0) return wait('No entry price');
      const distance = atr * config.barrierAtr;
      const precision = getBarrierPrecision(config.symbol);
      const signedDistance = (direction === 'BUY' ? '+' : '-') + distance.toFixed(precision);
      const payout = config.touchDirection === 'TOUCH' ? '200-350%' : '~40-80%';
      const reason = `${config.touchDirection} ${direction} ${config.barrierAtr}ATR (barrier=${signedDistance}, payout≈${payout})`;
      return enterTouch(config.touchDirection, signedDistance, config, reason);
    },
  },

  vanilla_trend: {
    id: 'vanilla_trend', name: 'Vanilla Trend Rider',
    description: 'Vanilla Call/Put in strong trends. Uncapped payout. Trailing exit locks in gains.',
    assetClass: 'synthetic_binary', contractClass: 'vanilla',
    baseRate: 0.35,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationMinutes: 60,
      requireStrongTrend: true, minAtrRatio: 1.2, minConsensusAgreeing: 2,
      barrier: '+0.00',
      trailingEnabled: true, trailingActivateAfterUSD: 5.0, trailingRetracePct: 40,
      shadowWinsRequired: 0,
      flipEnabled: false, flipBelowPct: 48, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const { state, consensus, config } = ctx;
      if (!state) return wait('No market state');
      const regime = state.regime && state.regime.code;
      const isStrongTrend = regime === 'STRONG_TREND_BULL' || regime === 'STRONG_TREND_BEAR';
      if (config.requireStrongTrend && !isStrongTrend) return wait(`Not strong trend: regime=${regime || '?'}`);
      const volRatio = state.volatility && state.volatility.ratio;
      if (Number.isFinite(volRatio) && volRatio < config.minAtrRatio) return wait(`ATR ratio ${volRatio.toFixed(2)} < ${config.minAtrRatio} (not expanding)`);
      const c = consensus && consensus.consensus;
      if (!c || c.action !== 'SIGNAL' || !c.direction) return wait('No consensus signal');
      const agreeing = (consensus && consensus.agreeing && consensus.agreeing.length) || 0;
      if (agreeing < config.minConsensusAgreeing) return wait(`Only ${agreeing} strategies agree (need ${config.minConsensusAgreeing})`);
      const direction = c.direction;
      const entry = state.price && state.price.current;
      if (!entry || entry <= 0) return wait('No entry price');
      const reason = `Vanilla ${direction} ATM strike=${config.barrier} (regime=${regime}, ${agreeing} agree, ATR=${Number(state.volatility?.atr || 0).toFixed(4)})`;
      return enterVanilla(direction, config.barrier, config, reason);
    },
  },

  turbo_breakout: {
    id: 'turbo_breakout', name: 'Turbo Breakout',
    description: 'Turbo Long/Short on confirmed breakouts. Uncapped payout. Trailing exit locks in gains.',
    assetClass: 'synthetic_binary', contractClass: 'turbo',
    baseRate: 0.30,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationMinutes: 15,
      barrierAtrOffset: 0.5, requireBreakoutPattern: true, minAtrRatio: 1.3,
      trailingEnabled: true, trailingActivateAfterUSD: 2.0, trailingRetracePct: 25,
      turboTakeProfit: null,
      shadowWinsRequired: 0,
      flipEnabled: false, flipBelowPct: 48, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const { state, prediction, config } = ctx;
      if (!state || !prediction) return wait('No state/prediction');
      if (config.requireBreakoutPattern) {
        const patterns = (prediction.pattern && prediction.pattern.patterns) || [];
        const isUp = patterns.indexOf('breakout_up') >= 0;
        const isDown = patterns.indexOf('breakout_down') >= 0;
        if (!isUp && !isDown) return wait('No breakout pattern detected');
      }
      const volRatio = state.volatility && state.volatility.ratio;
      if (Number.isFinite(volRatio) && volRatio < config.minAtrRatio) return wait(`ATR ratio ${volRatio.toFixed(2)} < ${config.minAtrRatio} (no expansion)`);
      const atr = state.volatility && state.volatility.atr;
      if (!atr || atr <= 0) return wait('No ATR available');
      const entry = state.price && state.price.current;
      if (!entry || entry <= 0) return wait('No entry price');
      const direction = prediction.direction;
      if (direction !== 'BUY' && direction !== 'SELL') return wait(`Prediction direction=${direction} (need BUY or SELL)`);
      const cushion = atr * config.barrierAtrOffset;
      const precision = getBarrierPrecision(config.symbol);
      const signedBarrier = (direction === 'BUY' ? '-' : '+') + cushion.toFixed(precision);
      const reason = `Turbo ${direction} barrier=${signedBarrier} (ATR=${atr.toFixed(precision)}, breakout confirmed)`;
      return enterTurbo(direction, signedBarrier, config, reason);
    },
  },

  accumulator_scalper: {
    id: 'accumulator_scalper', name: 'Accumulator Scalper',
    description: 'Accumulator on tight ranges. 3%/tick compounding, take-profit at 2x stake. One breakout knocks out the position.',
    assetClass: 'synthetic_binary', contractClass: 'accumulator',
    baseRate: 0.30,
    defaultConfig: {
      symbol: 'R_100', stake: 1,
      growthRatePct: 3, durationTicks: 30,
      accumulatorTakeProfit: 2,
      maxRangePct: 0.08, rangeLookbackTicks: 20,
      shadowWinsRequired: 0,
      flipEnabled: false, flipBelowPct: 48, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const { state, digitView, config } = ctx;
      if (!state && !digitView) return wait('No market state');
      const prices = digitView && Array.isArray(digitView.recentPrices) ? digitView.recentPrices.slice(-config.rangeLookbackTicks) : null;
      if (!prices || prices.length < 10) return wait(`Not enough recent prices for range check (${prices ? prices.length : 0})`);
      const highs = Math.max(...prices);
      const lows = Math.min(...prices);
      const mids = (highs + lows) / 2;
      if (!Number.isFinite(mids) || mids <= 0) return wait('Invalid price data');
      const rangePct = ((highs - lows) / mids) * 100;
      if (rangePct > config.maxRangePct) return wait(`Range ${rangePct.toFixed(3)}% > ${config.maxRangePct}% (high=${highs.toFixed(2)}, low=${lows.toFixed(2)})`);
      const regime = state && state.regime && state.regime.code;
      if (regime && regime !== 'RANGING' && regime !== 'WEAK_TREND') return wait(`Regime ${regime} (need RANGING or low-vol)`);
      const growthRate = (Number(config.growthRatePct) || 3) / 100;
      const ticks = Number(config.durationTicks) || 30;
      const maxMultiplier = Math.pow(1 + growthRate, ticks);
      const tp = config.accumulatorTakeProfit != null ? `$${config.accumulatorTakeProfit}` : 'none';
      const reason = `ACCU ${(growthRate * 100).toFixed(1)}%/tick × ${ticks}t TP=${tp} (range=${rangePct.toFixed(3)}%, max ${maxMultiplier.toFixed(1)}× stake)`;
      return enterAccumulator(growthRate, config, reason);
    },
  },
};

// ── Session-level risk defaults (applied to ALL bots) ──
const RISK_DEFAULTS = {
  botTakeProfit: 20,
  botStopLoss: 10,
  trailingDrawdownPct: 25,
  stopAfterLosses: 3,
  maxStake: 50,
  minRiskReward: 0,
  requireConsensus: false,
  allowedRegimes: [],
  allowedSessions: [],
  flipEnabled: false,
  flipBelowPct: 10,
  flipMinTrades: 20,
  flipStableTrades: 20,
  shadowWinsRequired: 0,
  shadowObservational: false,
  shadowStake: 0.35,
};

for (const id in BOTS) {
  BOTS[id].defaultConfig = Object.assign({}, RISK_DEFAULTS, BOTS[id].defaultConfig);
}

const COMPOUND_DEFAULTS = {
  compoundEnabled: false,
  compoundMaxStake: 10,
  compoundStartAfterWins: 0,
  compoundGrowthRatePct: 25,
  compoundStopAfterWins: 0,
  compoundResetAfterWins: 0,
};

for (const id in BOTS) {
  if (BOTS[id].assetClass === 'synthetic_binary') {
    BOTS[id].defaultConfig = Object.assign({}, COMPOUND_DEFAULTS, BOTS[id].defaultConfig);
  }
}

// ── High-variance overrides ──
BOTS.touch_hunter.defaultConfig.stopAfterLosses = 0;
BOTS.touch_hunter.defaultConfig.botTakeProfit = 0;
BOTS.touch_hunter.defaultConfig.botStopLoss = 0;

BOTS.vanilla_trend.defaultConfig.stopAfterLosses = 0;
BOTS.vanilla_trend.defaultConfig.botTakeProfit = 0;
BOTS.vanilla_trend.defaultConfig.botStopLoss = 0;

BOTS.turbo_breakout.defaultConfig.stopAfterLosses = 0;
BOTS.turbo_breakout.defaultConfig.botTakeProfit = 0;
BOTS.turbo_breakout.defaultConfig.botStopLoss = 0;

BOTS.accumulator_scalper.defaultConfig.stopAfterLosses = 5;

function getBot(id) { return BOTS[id] || null; }
function listBots() { return Object.values(BOTS); }
function listEnabledBots() { return Object.values(BOTS); }

module.exports = {
  BOTS,
  RISK_DEFAULTS,
  COMPOUND_DEFAULTS,
  getBot,
  listBots,
  listEnabledBots,
  normalizeSymbol,
  roundPrice,
  getPricePrecision,
  getBarrierPrecision,
  sanitizeDigitView,
};
