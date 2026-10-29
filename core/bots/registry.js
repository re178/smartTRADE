// core/bots/registry.js
// 17 bots. Optimized for BIG WINS and SMALL LOSSES.
// Includes ADAPTIVE RECOVERY and pip-size validation for Deriv.

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

function wait(reason) {
  return { action: 'WAIT', reasons: Array.isArray(reason) ? reason : [reason] };
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
      duration: overrides.durationSec || config.durationSec,
      durationUnit: 's',
      knockoutLevel: finalKnockout,
      takeProfitLevel: finalTakeProfit,
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

const BOTS = {

  // ============================================================
  // CATEGORY A — FX MULTIPLIER BOTS (7)
  // ============================================================

  trend_rider: {
    id: 'trend_rider', name: 'Trend Rider',
    description: 'FX Multiplier. Tight Stop, Wide Target. (Risk 1 to make 4)',
    assetClass: 'fx', contractClass: 'multiplier',
    defaultConfig: {
      symbol: 'EURUSD', timeframe: 'M5', stake: 10, multiplier: 200,
      durationSec: 1800, minConfidence: 65, stopAfterLosses: 3,
      knockoutLevel: null, takeProfitLevel: null,
    },
    evaluate(ctx) {
      const { state, prediction, consensus, config } = ctx;
      if (!state || !prediction) return wait('No state');
      if (prediction.direction === 'NEUTRAL') return wait('Neutral direction');
      if (prediction.calibratedConfidence < config.minConfidence) {
        return wait(`Conf ${prediction.calibratedConfidence} < ${config.minConfidence}`);
      }
      if (consensus && consensus.consensus && consensus.consensus.action === 'CONFLICT') {
        return wait('Strategy conflict');
      }
      const atr = state.volatility && state.volatility.atr;
      if (!atr || atr <= 0) return wait('No ATR');
      
      const dir = prediction.direction;
      const entry = state.price.current;
      const pip = getPipSize(config.symbol);
      
      // Ensure min 5 pips for SL, 15 pips for TP to satisfy Deriv API
      const koDist = Math.max(atr * 1.0, pip * 5); 
      const tpDist = Math.max(atr * 4.0, pip * 15); 
      
      const ko = dir === 'BUY' ? entry - koDist : entry + koDist;
      const tp = dir === 'BUY' ? entry + tpDist : entry - tpDist;
      
      return enterMultiplier(dir, config,
        { durationSec: config.durationSec, knockoutLevel: ko, takeProfitLevel: tp },
        [`Pattern ${prediction.pattern.bias} (${prediction.pattern.confidence}%)`]);
    },
  },

  range_scalper: {
    id: 'range_scalper', name: 'Range Scalper',
    description: 'FX Multiplier. S/R bounce in RANGING. Tight Stop, Wide Target.',
    assetClass: 'fx', contractClass: 'multiplier',
    defaultConfig: {
      symbol: 'EURUSD', timeframe: 'M5', stake: 5, multiplier: 100, durationSec: 900,
      knockoutLevel: null, takeProfitLevel: null,
    },
    evaluate(ctx) {
      const { state, config } = ctx;
      if (!state) return wait('No state');
      if (state.regime && state.regime.code !== 'RANGING') return wait('Not RANGING');
      const atS = state.structure && state.structure.isAtSupport;
      const atR = state.structure && state.structure.isAtResistance;
      if (!atS && !atR) return wait('Not at S/R');
      
      const dir = atS ? 'BUY' : 'SELL';
      const atr = state.volatility.atr;
      const entry = state.price.current;
      const pip = getPipSize(config.symbol);
      
      const koDist = Math.max(atr * 0.8, pip * 5);
      const tpDist = Math.max(atr * 3.0, pip * 10);
      
      const ko = dir === 'BUY' ? entry - koDist : entry + koDist;
      const tp = dir === 'BUY' ? entry + tpDist : entry - tpDist;
      
      return enterMultiplier(dir, config,
        { durationSec: config.durationSec, knockoutLevel: ko, takeProfitLevel: tp },
        [atS ? 'At support' : 'At resistance']);
    },
  },

  breakout_hunter: {
    id: 'breakout_hunter', name: 'Breakout Hunter',
    description: 'FX Multiplier. 20-candle breakout. Risk 1 to make 4.5.',
    assetClass: 'fx', contractClass: 'multiplier',
    defaultConfig: {
      symbol: 'EURUSD', timeframe: 'M5', stake: 10, multiplier: 200,
      durationSec: 1800, minAtrRatio: 1.2,
      knockoutLevel: null, takeProfitLevel: null,
    },
    evaluate(ctx) {
      const { prediction, state, config } = ctx;
      if (!prediction || !state) return wait('No prediction');
      const patterns = (prediction.pattern && prediction.pattern.patterns) || [];
      const isUp = patterns.indexOf('breakout_up') >= 0;
      const isDown = patterns.indexOf('breakout_down') >= 0;
      if (!isUp && !isDown) return wait('No breakout detected');
      if (state.volatility.ratio < config.minAtrRatio) return wait('ATR too low');
      
      const dir = isUp ? 'BUY' : 'SELL';
      const atr = state.volatility.atr;
      const entry = state.price.current;
      const pip = getPipSize(config.symbol);
      
      const koDist = Math.max(atr * 1.0, pip * 5);
      const tpDist = Math.max(atr * 4.5, pip * 15);
      
      const ko = dir === 'BUY' ? entry - koDist : entry + koDist;
      const tp = dir === 'BUY' ? entry + tpDist : entry - tpDist;
      
      return enterMultiplier(dir, config,
        { durationSec: config.durationSec, knockoutLevel: ko, takeProfitLevel: tp },
        [isUp ? 'Breakout up' : 'Breakout down']);
    },
  },

  momentum_burst: {
    id: 'momentum_burst', name: 'Momentum Burst',
    description: 'FX Multiplier. Velocity scalping. Risk 1 to make 3.',
    assetClass: 'fx', contractClass: 'multiplier',
    defaultConfig: {
      symbol: 'EURUSD', timeframe: 'M1', stake: 5, multiplier: 300,
      durationSec: 300, velocityThreshold: 0.00005,
      knockoutLevel: null, takeProfitLevel: null,
    },
    evaluate(ctx) {
      const { state, config } = ctx;
      if (!state) return wait('No state');
      const v = (state.awareness && state.awareness.velocity) || 0;
      const a = (state.awareness && state.awareness.acceleration) || 0;
      if (Math.abs(v) < config.velocityThreshold) return wait('Velocity too low');
      if (Math.sign(v) !== Math.sign(a) || Math.abs(a) < 0.000001) return wait('No acceleration');
      
      const dir = v > 0 ? 'BUY' : 'SELL';
      const atr = state.volatility.atr;
      const entry = state.price.current;
      const pip = getPipSize(config.symbol);
      
      const koDist = Math.max(atr * 0.8, pip * 4);
      const tpDist = Math.max(atr * 3.0, pip * 12);
      
      const ko = dir === 'BUY' ? entry - koDist : entry + koDist;
      const tp = dir === 'BUY' ? entry + tpDist : entry - tpDist;
      
      return enterMultiplier(dir, config,
        { durationSec: config.durationSec, knockoutLevel: ko, takeProfitLevel: tp },
        [`Velocity ${(v * 1e6).toFixed(1)}e-6`]);
    },
  },

  pattern_reversal: {
    id: 'pattern_reversal', name: 'Pattern Reversal',
    description: 'FX Multiplier. Reversal at S/R. Risk 1 to make 4.',
    assetClass: 'fx', contractClass: 'multiplier',
    defaultConfig: {
      symbol: 'EURUSD', timeframe: 'M5', stake: 8, multiplier: 150, durationSec: 1800,
      knockoutLevel: null, takeProfitLevel: null,
    },
    evaluate(ctx) {
      const { prediction, state, config } = ctx;
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
      
      const atr = state.volatility.atr;
      const entry = state.price.current;
      const pip = getPipSize(config.symbol);
      
      const koDist = Math.max(atr * 1.0, pip * 5);
      const tpDist = Math.max(atr * 4.0, pip * 15);
      
      const ko = dir === 'BUY' ? entry - koDist : entry + koDist;
      const tp = dir === 'BUY' ? entry + tpDist : entry - tpDist;
      
      return enterMultiplier(dir, config,
        { durationSec: config.durationSec, knockoutLevel: ko, takeProfitLevel: tp },
        [`Reversal: ${pats.join(', ')}`]);
    },
  },

  pullback_trader: {
    id: 'pullback_trader', name: 'Pullback Trader',
    description: 'FX Multiplier. EMA20 pullback. Risk 1 to make 4.',
    assetClass: 'fx', contractClass: 'multiplier',
    defaultConfig: {
      symbol: 'EURUSD', timeframe: 'M5', stake: 10, multiplier: 200, durationSec: 1800,
      knockoutLevel: null, takeProfitLevel: null,
    },
    evaluate(ctx) {
      const { state, config, candles } = ctx;
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
      const atr = state.volatility.atr;
      const pip = getPipSize(config.symbol);
      
      const koDist = Math.max(atr * 1.0, pip * 5);
      const tpDist = Math.max(atr * 4.0, pip * 15);
      
      const ko = dir === 'BUY' ? ema - koDist : ema + koDist;
      const tp = dir === 'BUY' ? price + tpDist : price - tpDist;
      
      return enterMultiplier(dir, config,
        { durationSec: config.durationSec, knockoutLevel: ko, takeProfitLevel: tp },
        [`Pullback to EMA20`]);
    },
  },

  squeeze_breaker: {
    id: 'squeeze_breaker', name: 'Squeeze Breaker',
    description: 'FX Multiplier. BB squeeze breakout. Risk 1 to make 4.',
    assetClass: 'fx', contractClass: 'multiplier',
    defaultConfig: {
      symbol: 'EURUSD', timeframe: 'M5', stake: 10, multiplier: 200, durationSec: 1800,
      knockoutLevel: null, takeProfitLevel: null,
    },
    evaluate(ctx) {
      const { state, config, candles } = ctx;
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
      
      const atr = state.volatility.atr;
      const pip = getPipSize(config.symbol);
      
      const koDist = Math.max(atr * 1.0, pip * 5);
      const tpDist = Math.max(atr * 4.0, pip * 15);
      
      const ko = dir === 'BUY' ? price - koDist : price + koDist;
      const tp = dir === 'BUY' ? price + tpDist : price - tpDist;
      
      return enterMultiplier(dir, config,
        { durationSec: config.durationSec, knockoutLevel: ko, takeProfitLevel: tp },
        [`Squeeze breakout`]);
    },
  },

  // ============================================================
  // CATEGORY B — SYNTHETIC DIGIT BOTS (5)
  // ============================================================

  even_odd_trader: {
    id: 'even_odd_trader', name: 'Even/Odd Trader',
    description: 'Synthetic digit. Trades EVEN/ODD on extreme edge.',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    defaultConfig: { symbol: 'R_100', stake: 1, durationTicks: 5, minEdge: 0.12, minSamples: 50 },
    evaluate(ctx) {
      const { digitView, config, stats } = ctx;
      if (!digitView) return wait('No digit data');
      if (digitView.sampleSize < config.minSamples) return wait('Not enough samples');
      
      const losses = stats?.consecutiveLosses || 0;
      let requiredEdge = 62;
      if (losses === 1) requiredEdge = 65;
      if (losses >= 2) requiredEdge = 68;

      const even = digitView.evenPct;
      const odd = digitView.oddPct;
      
      if (even >= requiredEdge) return enterDigit('DIGITEVEN', config, `Even ${even.toFixed(1)}% (Need >=${requiredEdge}%)`);
      if (odd >= requiredEdge) return enterDigit('DIGITODD', config, `Odd ${odd.toFixed(1)}% (Need >=${requiredEdge}%)`);
      
      return wait(`Even ${even.toFixed(1)}% / Odd ${odd.toFixed(1)}% (Need ${requiredEdge}%)`);
    },
  },

  over_under_trader: {
    id: 'over_under_trader', name: 'Over/Under Trader',
    description: 'Synthetic digit. Hunts 10% probability (pays ~9x).',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    defaultConfig: { symbol: 'R_100', stake: 1, durationTicks: 5, threshold: 8, minSamples: 100 },
    evaluate(ctx) {
      const { digitView, config, stats } = ctx;
      if (!digitView) return wait('No digit data');
      if (digitView.sampleSize < config.minSamples) return wait('Not enough samples');
      
      const losses = stats?.consecutiveLosses || 0;
      let requiredPct = 5.0;
      if (losses === 1) requiredPct = 3.5;
      if (losses >= 2) requiredPct = 2.0;

      const freq = digitView.digitFreq;
      const total = digitView.sampleSize;
      const th = config.threshold;
      
      const overCount = freq.slice(th + 1).reduce((a, b) => a + b, 0);
      const overPct = (overCount / total) * 100;
      
      const underCount = freq.slice(0, 1).reduce((a, b) => a + b, 0);
      const underPct = (underCount / total) * 100;
      
      if (overPct <= requiredPct) return enterDigitBarrier('DIGITOVER', th, config, `Over ${th} cold (${overPct.toFixed(1)}%). Need <=${requiredPct}%.`);
      if (underPct <= requiredPct) return enterDigitBarrier('DIGITUNDER', 0, config, `Under 1 cold (${underPct.toFixed(1)}%). Need <=${requiredPct}%.`);
      
      return wait(`Over ${th}: ${overPct.toFixed(1)}% / Under 1: ${underPct.toFixed(1)}% (Need <=${requiredPct}%)`);
    },
  },

  matches_differs_trader: {
    id: 'matches_differs_trader', name: 'Matches/Differs Trader',
    description: 'Synthetic digit. Trades MATCH (pays ~9x) when digit is cold.',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    defaultConfig: { symbol: 'R_100', stake: 1, durationTicks: 5, targetDigit: 5, minSamples: 100 },
    evaluate(ctx) {
      const { digitView, config, stats } = ctx;
      if (!digitView) return wait('No digit data');
      if (digitView.sampleSize < config.minSamples) return wait('Not enough samples');
      
      const losses = stats?.consecutiveLosses || 0;
      let requiredPct = 4.0;
      if (losses === 1) requiredPct = 3.0;
      if (losses >= 2) requiredPct = 2.0;

      const freq = digitView.digitFreq;
      const total = digitView.sampleSize;
      const target = config.targetDigit;
      const targetPct = (freq[target] / total) * 100;
      
      if (targetPct <= requiredPct) {
        return enterDigitBarrier('DIGITMATCH', target, config, `Digit ${target} extremely cold (${targetPct.toFixed(1)}%). Expecting MATCH.`);
      }
      
      return wait(`Digit ${target} at ${targetPct.toFixed(1)}% (Need <=${requiredPct}% to fire)`);
    },
  },

  digit_streak_fade: {
    id: 'digit_streak_fade', name: 'Digit Streak Fade',
    description: 'Synthetic digit. Fades long even/odd streaks.',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    defaultConfig: { symbol: 'R_100', stake: 1, durationTicks: 5, minStreak: 6 },
    evaluate(ctx) {
      const { digitView, config, stats } = ctx;
      if (!digitView) return wait('No digit data');
      
      const losses = stats?.consecutiveLosses || 0;
      let requiredStreak = config.minStreak;
      if (losses === 1) requiredStreak += 1;
      if (losses >= 2) requiredStreak += 2;

      const evenStreak = digitView.evenStreak || 0;
      const oddStreak = digitView.oddStreak || 0;
      
      if (evenStreak >= requiredStreak) return enterDigit('DIGITODD', config, `${evenStreak}-streak even. Fading to ODD.`);
      if (oddStreak >= requiredStreak) return enterDigit('DIGITEVEN', config, `${oddStreak}-streak odd. Fading to EVEN.`);
      
      return wait(`Streak: even=${evenStreak} odd=${oddStreak} (Need ${requiredStreak})`);
    },
  },

  digit_hot_cold: {
    id: 'digit_hot_cold', name: 'Digit Hot/Cold',
    description: 'Synthetic digit. Hunts Extreme OVER/UNDER.',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    defaultConfig: { symbol: 'R_100', stake: 1, durationTicks: 5, minSamples: 100 },
    evaluate(ctx) {
      const { digitView, config, stats } = ctx;
      if (!digitView) return wait('No digit data');
      if (digitView.sampleSize < config.minSamples) return wait('Not enough samples');
      
      const losses = stats?.consecutiveLosses || 0;
      let requiredPct = 4.0;
      if (losses === 1) requiredPct = 2.5;
      if (losses >= 2) requiredPct = 1.0;

      const freq = digitView.digitFreq;
      const total = digitView.sampleSize;
      
      const over8 = (freq.slice(9).reduce((a, b) => a + b, 0) / total) * 100;
      const under1 = (freq.slice(0, 1).reduce((a, b) => a + b, 0) / total) * 100;
      
      if (over8 <= requiredPct) return enterDigitBarrier('DIGITOVER', 8, config, `Over 8 is only ${over8.toFixed(1)}%. (Need <=${requiredPct}%)`);
      if (under1 <= requiredPct) return enterDigitBarrier('DIGITUNDER', 0, config, `Under 1 is only ${under1.toFixed(1)}%. (Need <=${requiredPct}%)`);
      
      return wait(`No extreme edge yet (Need <=${requiredPct}%)`);
    },
  },

  // ============================================================
  // CATEGORY C — SYNTHETIC RISE/FALL BOTS (3)
  // ============================================================

  rise_fall_momentum: {
    id: 'rise_fall_momentum', name: 'Rise/Fall Momentum',
    description: 'Synthetic CALL/PUT based on tick direction bias.',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    defaultConfig: { symbol: 'R_100', stake: 1, durationTicks: 5, minBias: 0.62, minSamples: 100 },
    evaluate(ctx) {
      const { digitView, config, stats } = ctx;
      if (!digitView) return wait('No data');
      if (digitView.sampleSize < config.minSamples) return wait('Not enough samples');
      
      const losses = stats?.consecutiveLosses || 0;
      let requiredBias = config.minBias;
      if (losses === 1) requiredBias += 0.03;
      if (losses >= 2) requiredBias += 0.06;

      const risePct = digitView.risePct / 100;
      const fallPct = digitView.fallPct / 100;
      
      if (risePct >= requiredBias) return enterBinary('CALL', config, `Rise bias ${(risePct * 100).toFixed(1)}%`);
      if (fallPct >= requiredBias) return enterBinary('PUT', config, `Fall bias ${(fallPct * 100).toFixed(1)}%`);
      
      return wait(`Rise ${(risePct * 100).toFixed(1)}% / Fall ${(fallPct * 100).toFixed(1)}% (Need >=${(requiredBias * 100).toFixed(0)}%)`);
    },
  },

  rise_fall_streak: {
    id: 'rise_fall_streak', name: 'Rise/Fall Streak Fade',
    description: 'Synthetic CALL/PUT. Fades N consecutive rises or falls.',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    defaultConfig: { symbol: 'R_100', stake: 1, durationTicks: 5, minStreak: 5 },
    evaluate(ctx) {
      const { digitView, config, stats } = ctx;
      if (!digitView) return wait('No data');
      
      const losses = stats?.consecutiveLosses || 0;
      let requiredStreak = config.minStreak;
      if (losses === 1) requiredStreak += 1;
      if (losses >= 2) requiredStreak += 2;

      const dirs = (digitView.directions || []).slice(-20);
      if (dirs.length < requiredStreak) return wait('Not enough ticks');
      
      let streak = 0, lastDir = null;
      for (let i = dirs.length - 1; i >= 0; i--) {
        if (dirs[i] === 'flat') break;
        if (lastDir === null) { lastDir = dirs[i]; streak = 1; }
        else if (dirs[i] === lastDir) streak++;
        else break;
      }
      
      if (streak >= requiredStreak) {
        const dir = lastDir === 'up' ? 'PUT' : 'CALL';
        return enterBinary(dir, config, `${streak}-tick ${lastDir}-streak → fade to ${dir}`);
      }
      return wait(`Streak: ${streak} ${lastDir || '-'} (Need ${requiredStreak})`);
    },
  },

  rise_fall_breakout: {
    id: 'rise_fall_breakout', name: 'Rise/Fall Breakout',
    description: 'Synthetic CALL/PUT on sharp directional tick burst.',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    defaultConfig: { symbol: 'R_100', stake: 1, durationTicks: 5, lookbackTicks: 10, minMovePct: 0.08 },
    evaluate(ctx) {
      const { digitView, config, stats } = ctx;
      if (!digitView) return wait('No data');
      
      const losses = stats?.consecutiveLosses || 0;
      let requiredMove = config.minMovePct;
      if (losses === 1) requiredMove += 0.02;
      if (losses >= 2) requiredMove += 0.04;

      const prices = (digitView.recentPrices || []).slice(-config.lookbackTicks);
      if (prices.length < 5) return wait('Not enough prices');
      
      const first = prices[0], last = prices[prices.length - 1];
      const movePct = ((last - first) / first) * 100;
      
      if (Math.abs(movePct) < requiredMove) return wait(`Move ${movePct.toFixed(3)}% too small (Need ${requiredMove.toFixed(3)}%)`);
      
      const dir = movePct > 0 ? 'CALL' : 'PUT';
      return enterBinary(dir, config, `Move ${movePct.toFixed(3)}% in ${config.lookbackTicks} ticks`);
    },
  },

  // ============================================================
  // CATEGORY D — SYNTHETIC VOLATILITY BOTS (2)
  // ============================================================

  vol_high_low: {
    id: 'vol_high_low', name: 'Volatility High/Low',
    description: 'Synthetic ONETOUCH/NOTOUCH on momentum bias.',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    defaultConfig: { symbol: 'R_100', stake: 1, durationTicks: 5, barrierPips: 10 },
    evaluate(ctx) {
      const { digitView, config, stats } = ctx;
      if (!digitView) return wait('No data');
      
      const losses = stats?.consecutiveLosses || 0;
      let upperBias = 0.70, lowerBias = 0.50;
      if (losses === 1) { upperBias = 0.75; lowerBias = 0.45; }
      if (losses >= 2) { upperBias = 0.80; lowerBias = 0.40; }

      const dirs = (digitView.directions || []).slice(-20);
      const up = dirs.filter(d => d === 'up').length;
      const down = dirs.filter(d => d === 'down').length;
      const total = up + down;
      if (total === 0) return wait('Not enough direction data');
      
      const bias = Math.max(up, down) / total;
      if (bias > upperBias) return enterBinary('ONETOUCH', config, `Strong directional bias ${(bias * 100).toFixed(1)}%`);
      if (bias < lowerBias) return enterBinary('NOTOUCH', config, `Balanced movement`);
      
      return wait(`Bias ${(bias * 100).toFixed(1)}%`);
    },
  },

  vol_scalper: {
    id: 'vol_scalper', name: 'Volatility Scalper',
    description: 'Synthetic CALL/PUT. Quick 5-tick scalps.',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    defaultConfig: { symbol: 'R_100', stake: 1, durationTicks: 5 },
    evaluate(ctx) {
      const { digitView, config } = ctx;
      if (!digitView) return wait('No data');
      
      const dirs = (digitView.directions || []).slice(-5);
      if (dirs.length < 5) return wait('Not enough ticks');
      
      const ups = dirs.filter(d => d === 'up').length;
      const downs = dirs.filter(d => d === 'down').length;
      
      if (ups === 5) return enterBinary('CALL', config, `5/5 ticks up`);
      if (downs === 5) return enterBinary('PUT', config, `5/5 ticks down`);
      
      return wait(`ups=${ups} downs=${downs}`);
    },
  },
};

function getBot(id) { return BOTS[id] || null; }
function listBots() { return Object.values(BOTS); }

module.exports = { BOTS, getBot, listBots, normalizeSymbol };
