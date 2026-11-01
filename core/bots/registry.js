// core/bots/registry.js
// 17 bots. Multi-signal, adaptive, risk-enforced.
//
// [FIX-VOLHL] vol_high_low was emitting ONETOUCH/NOTOUCH without a barrier
//   parameter, which Deriv rejects with `InvalidBarrierSingle`. The bot
//   never placed a single trade. Now uses CALL/PUT based on directional
//   bias (same signal, valid contract type, no barrier needed).
//   The bias thresholds (0.72 / 0.45) are preserved.

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

// ════════════════════════════════════════════════════════════════
// BOTS
// ════════════════════════════════════════════════════════════════
const BOTS = {

  // ============================================================
  // FX MULTIPLIER BOTS (7)
  // ============================================================

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

  // ============================================================
  // SYNTHETIC DIGIT BOTS (5)
  // ============================================================

  even_odd_trader: {
    id: 'even_odd_trader', name: 'Even/Odd Trader',
    description: 'Synthetic digit. EVEN/ODD on extreme edge. Flip NOT recommended (50/50).',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    baseRate: 0.50,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, minSamples: 50,
      flipEnabled: false, flipBelowPct: 48, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      if (dv.sampleSize < ctx.config.minSamples) return wait('Not enough samples');
      const { config, stats } = ctx;
      const even = dv.evenPct;
      const odd = dv.oddPct;
      let normalDir = null;
      if (even >= 62) normalDir = 'DIGITEVEN';
      else if (odd >= 62) normalDir = 'DIGITODD';
      if (!normalDir) return wait(`Even ${even.toFixed(1)}% / Odd ${odd.toFixed(1)}% (Need >=62%)`);
      const flip = shouldFlip(config, stats);
      const finalDir = flip
        ? (normalDir === 'DIGITEVEN' ? 'DIGITODD' : 'DIGITEVEN')
        : normalDir;
      const reason = flip
        ? `${normalDir} FLIPPED → ${finalDir}`
        : `${normalDir.replace('DIGIT','')} ${(normalDir === 'DIGITEVEN' ? even : odd).toFixed(1)}%`;
      return enterDigit(finalDir, config, reason);
    },
  },

  over_under_trader: {
    id: 'over_under_trader', name: 'Over/Under Trader',
    description: 'Synthetic digit. OVER/UNDER on rare digit. Flip changes barrier (review before enabling).',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    baseRate: 0.10,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, threshold: 8, minSamples: 100,
      flipEnabled: false, flipBelowPct: 8, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      if (dv.sampleSize < ctx.config.minSamples) return wait('Not enough samples');
      const { config, stats } = ctx;
      const freq = dv.digitFreq;
      const total = dv.sampleSize;
      const th = config.threshold;
      const overCount = freq.slice(th + 1).reduce((a, b) => a + b, 0);
      const overPct = (overCount / total) * 100;
      const underCount = freq.slice(0, 1).reduce((a, b) => a + b, 0);
      const underPct = (underCount / total) * 100;
      let normalDir = null, barrier = null;
      if (overPct <= 5.0) { normalDir = 'DIGITOVER'; barrier = th; }
      else if (underPct <= 5.0) { normalDir = 'DIGITUNDER'; barrier = 0; }
      if (!normalDir) return wait(`Over ${th}: ${overPct.toFixed(1)}% / Under 1: ${underPct.toFixed(1)}% (Need <=5%)`);
      const flip = shouldFlip(config, stats);
      let finalDir = normalDir;
      if (flip) {
        finalDir = normalDir === 'DIGITOVER' ? 'DIGITUNDER' : 'DIGITOVER';
        barrier = finalDir === 'DIGITOVER' ? th : 0;
      }
      const reason = flip
        ? `${normalDir} FLIPPED → ${finalDir}`
        : `Over ${th} (${overPct.toFixed(1)}%) / Under 1 (${underPct.toFixed(1)}%)`;
      return enterDigitBarrier(finalDir, barrier, config, reason);
    },
  },

  matches_differs_trader: {
    id: 'matches_differs_trader', name: 'Matches/Differs Trader',
    description: 'Synthetic digit. MATCH/DIFF — flip is MATHEMATICALLY VALID (complementary bets).',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    baseRate: 0.10,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, targetDigit: 5, minSamples: 100,
      flipEnabled: true, flipBelowPct: 8, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      if (dv.sampleSize < ctx.config.minSamples) return wait('Not enough samples');
      const { config, stats } = ctx;
      const freq = dv.digitFreq;
      const total = dv.sampleSize;
      const target = config.targetDigit;
      const targetPct = (freq[target] / total) * 100;
      const neighbor = (target + 1) % 10;
      const neighborPct = (freq[neighbor] / total) * 100;
      if (targetPct > 3.0) return wait(`Digit ${target} at ${targetPct.toFixed(1)}% (Need <=3%)`);
      if (neighborPct > 8.0) return wait(`Digit ${target} cold but neighbor ${neighbor} at ${neighborPct.toFixed(1)}%`);
      const flip = shouldFlip(config, stats);
      const finalDir = flip ? 'DIGITDIFF' : 'DIGITMATCH';
      const reason = flip
        ? `Digits ${target}/${neighbor} cold FLIPPED → DIGITDIFF`
        : `Digits ${target}(${targetPct.toFixed(1)}%) & ${neighbor}(${neighborPct.toFixed(1)}%) both cold — MATCH`;
      return enterDigitBarrier(finalDir, target, config, reason);
    },
  },

  digit_streak_fade: {
    id: 'digit_streak_fade', name: 'Digit Streak Fade',
    description: 'Synthetic digit. Fades even/odd streaks. Flip NOT recommended (symmetric).',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    baseRate: 0.50,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, minStreak: 8,
      flipEnabled: false, flipBelowPct: 48, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      const { config, stats } = ctx;
      const evenStreak = dv.evenStreak || 0;
      const oddStreak = dv.oddStreak || 0;
      const required = config.minStreak;
      let normalDir = null;
      if (evenStreak >= required) normalDir = 'DIGITODD';
      else if (oddStreak >= required) normalDir = 'DIGITEVEN';
      if (!normalDir) return wait(`Streak: even=${evenStreak} odd=${oddStreak} (Need ${required})`);
      const flip = shouldFlip(config, stats);
      const finalDir = flip
        ? (normalDir === 'DIGITEVEN' ? 'DIGITODD' : 'DIGITEVEN')
        : normalDir;
      const reason = flip
        ? `${normalDir} fade FLIPPED → ${finalDir}`
        : `${Math.max(evenStreak, oddStreak)}-streak — fade to ${finalDir.replace('DIGIT','')}`;
      return enterDigit(finalDir, config, reason);
    },
  },

  digit_hot_cold: {
    id: 'digit_hot_cold', name: 'Digit Hot/Cold',
    description: 'Synthetic digit. Extreme OVER 8 / UNDER 0. Flip changes barrier (review before enabling).',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    baseRate: 0.10,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, minSamples: 150,
      flipEnabled: false, flipBelowPct: 8, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      if (dv.sampleSize < ctx.config.minSamples) return wait('Not enough samples');
      const { config, stats } = ctx;
      const freq = dv.digitFreq;
      const total = dv.sampleSize;
      const over8 = (freq.slice(9).reduce((a, b) => a + b, 0) / total) * 100;
      const under1 = (freq.slice(0, 1).reduce((a, b) => a + b, 0) / total) * 100;
      let normalDir = null;
      if (over8 <= 3.0) normalDir = 'DIGITOVER';
      else if (under1 <= 3.0) normalDir = 'DIGITUNDER';
      if (!normalDir) return wait(`Over 8: ${over8.toFixed(1)}% / Under 1: ${under1.toFixed(1)}% (Need <=3%)`);
      const flip = shouldFlip(config, stats);
      const finalDir = flip
        ? (normalDir === 'DIGITOVER' ? 'DIGITUNDER' : 'DIGITOVER')
        : normalDir;
      const barrier = finalDir === 'DIGITOVER' ? 8 : 0;
      const reason = flip
        ? `${normalDir} FLIPPED → ${finalDir}`
        : `Over 8=${over8.toFixed(1)}% / Under 1=${under1.toFixed(1)}%`;
      return enterDigitBarrier(finalDir, barrier, config, reason);
    },
  },

  // ============================================================
  // SYNTHETIC BINARY BOTS (3)
  // ============================================================

  rise_fall_momentum: {
    id: 'rise_fall_momentum', name: 'Rise/Fall Momentum',
    description: 'Synthetic CALL/PUT. Flip NOT recommended (50/50).',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    baseRate: 0.50,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, minBias: 0.62, minSamples: 100,
      flipEnabled: false, flipBelowPct: 48, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      if (dv.sampleSize < ctx.config.minSamples) return wait('Not enough samples');
      const { config, stats } = ctx;
      const risePct = dv.risePct / 100;
      const fallPct = dv.fallPct / 100;
      let normalDir = null;
      if (risePct >= config.minBias) normalDir = 'CALL';
      else if (fallPct >= config.minBias) normalDir = 'PUT';
      if (!normalDir) return wait(`Rise ${(risePct*100).toFixed(1)}% / Fall ${(fallPct*100).toFixed(1)}% (Need >=${config.minBias*100}%)`);
      const flip = shouldFlip(config, stats);
      const finalDir = flip
        ? (normalDir === 'CALL' ? 'PUT' : 'CALL')
        : normalDir;
      const reason = flip
        ? `${normalDir} FLIPPED → ${finalDir}`
        : `Bias ${((normalDir === 'CALL' ? risePct : fallPct) * 100).toFixed(1)}%`;
      return enterBinary(finalDir, config, reason);
    },
  },

  rise_fall_streak: {
    id: 'rise_fall_streak', name: 'Rise/Fall Streak Fade',
    description: 'Synthetic CALL/PUT. Flip NOT recommended (50/50).',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    baseRate: 0.50,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, minStreak: 7,
      flipEnabled: false, flipBelowPct: 48, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      const { config, stats } = ctx;
      const dirs = (dv.directions || []).slice(-20);
      if (dirs.length < config.minStreak) return wait('Not enough ticks');
      let streak = 0, lastDir = null;
      for (let i = dirs.length - 1; i >= 0; i--) {
        if (dirs[i] === 'flat') break;
        if (lastDir === null) { lastDir = dirs[i]; streak = 1; }
        else if (dirs[i] === lastDir) streak++;
        else break;
      }
      if (streak < config.minStreak) return wait(`Streak: ${streak} ${lastDir || '-'} (Need ${config.minStreak})`);
      const normalDir = lastDir === 'up' ? 'PUT' : 'CALL';
      const flip = shouldFlip(config, stats);
      const finalDir = flip ? (normalDir === 'CALL' ? 'PUT' : 'CALL') : normalDir;
      const reason = flip
        ? `${streak}-tick ${lastDir}-streak FLIPPED → ${finalDir}`
        : `${streak}-tick ${lastDir}-streak → fade to ${finalDir}`;
      return enterBinary(finalDir, config, reason);
    },
  },

  rise_fall_breakout: {
    id: 'rise_fall_breakout', name: 'Rise/Fall Breakout',
    description: 'Synthetic CALL/PUT. Flip NOT recommended (50/50).',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    baseRate: 0.50,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, lookbackTicks: 10, minMovePct: 0.08,
      flipEnabled: false, flipBelowPct: 48, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      const { config, stats } = ctx;
      const prices = (dv.recentPrices || []).slice(-config.lookbackTicks);
      if (prices.length < 5) return wait('Not enough prices');
      const first = prices[0], last = prices[prices.length - 1];
      const movePct = ((last - first) / first) * 100;
      if (Math.abs(movePct) < config.minMovePct) {
        return wait(`Move ${movePct.toFixed(3)}% too small (Need ${config.minMovePct.toFixed(3)}%)`);
      }
      const normalDir = movePct > 0 ? 'CALL' : 'PUT';
      const flip = shouldFlip(config, stats);
      const finalDir = flip ? (normalDir === 'CALL' ? 'PUT' : 'CALL') : normalDir;
      const reason = flip
        ? `Move ${movePct.toFixed(3)}% FLIPPED → ${finalDir}`
        : `Move ${movePct.toFixed(3)}%`;
      return enterBinary(finalDir, config, reason);
    },
  },

  // ============================================================
  // SYNTHETIC VOLATILITY BOTS (2)
  // ============================================================

  // [FIX-VOLHL] Was emitting ONETOUCH/NOTOUCH with no barrier.
  // Now uses CALL/PUT based on the same directional bias signal.
  // Same thresholds preserved (0.72 strong-up → CALL, 0.45 bias < 0.45 → PUT).
  vol_high_low: {
    id: 'vol_high_low', name: 'Volatility High/Low',
    description: 'Synthetic CALL/PUT on directional bias. Flip review before enabling.',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    baseRate: 0.50,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, barrierPips: 10,
      flipEnabled: false, flipBelowPct: 48, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      const { config, stats } = ctx;
      const dirs = (dv.directions || []).slice(-20);
      const up = dirs.filter(d => d === 'up').length;
      const down = dirs.filter(d => d === 'down').length;
      const total = up + down;
      if (total === 0) return wait('Not enough direction data');
      const upBias = up / total;
      let normalDir = null;
      // Strong upward bias (> 72% up) → CALL
      if (upBias > 0.72) normalDir = 'CALL';
      // Strong downward bias (< 45% up, i.e. > 55% down) → PUT
      else if (upBias < 0.45) normalDir = 'PUT';
      if (!normalDir) return wait(`Up bias ${(upBias * 100).toFixed(1)}% (Need >72% CALL or <45% PUT)`);
      const flip = shouldFlip(config, stats);
      const finalDir = flip
        ? (normalDir === 'CALL' ? 'PUT' : 'CALL')
        : normalDir;
      const reason = flip
        ? `${normalDir} FLIPPED → ${finalDir}`
        : `Direction bias ${(upBias * 100).toFixed(1)}% up → ${normalDir}`;
      return enterBinary(finalDir, config, reason);
    },
  },

  vol_scalper: {
    id: 'vol_scalper', name: 'Volatility Scalper',
    description: 'Synthetic CALL/PUT. Flip NOT recommended (50/50).',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    baseRate: 0.50,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5,
      flipEnabled: false, flipBelowPct: 48, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      const { config, stats } = ctx;
      const dirs = (dv.directions || []).slice(-5);
      if (dirs.length < 5) return wait('Not enough ticks');
      const ups = dirs.filter(d => d === 'up').length;
      const downs = dirs.filter(d => d === 'down').length;
      let normalDir = null;
      if (ups === 5) normalDir = 'CALL';
      else if (downs === 5) normalDir = 'PUT';
      if (!normalDir) return wait(`ups=${ups} downs=${downs}`);
      const flip = shouldFlip(config, stats);
      const finalDir = flip ? (normalDir === 'CALL' ? 'PUT' : 'CALL') : normalDir;
      const reason = flip
        ? `5/5 ticks FLIPPED → ${finalDir}`
        : `5/5 ticks ${normalDir === 'CALL' ? 'up' : 'down'}`;
      return enterBinary(finalDir, config, reason);
    },
  },
};

// ── Session-level risk defaults ─────────────────────────────────
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
};

for (const id in BOTS) {
  BOTS[id].defaultConfig = Object.assign({}, RISK_DEFAULTS, BOTS[id].defaultConfig);
}

function getBot(id) { return BOTS[id] || null; }
function listBots() { return Object.values(BOTS); }
function listEnabledBots() { return Object.values(BOTS); }

module.exports = {
  BOTS,
  RISK_DEFAULTS,
  getBot,
  listBots,
  listEnabledBots,
  normalizeSymbol,
  roundPrice,
  getPricePrecision,
  sanitizeDigitView,
};
