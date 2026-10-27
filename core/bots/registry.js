// core/bots/registry.js
// 17 bots across 4 categories. Each has its own entry rule.
//   FX Multiplier   (7): trend_rider, range_scalper, breakout_hunter,
//                        momentum_burst, pattern_reversal, pullback_trader, squeeze_breaker
//   Synthetic Digit (5): even_odd_trader, over_under_trader,
//                        matches_differs_trader, digit_streak_fade, digit_hot_cold
//   Synthetic Binary(3): rise_fall_momentum, rise_fall_streak, rise_fall_breakout
//   Volatility      (2): vol_high_low, vol_scalper

'use strict';

const { EMA, BollingerBands } = require('../strategy/engine');

function normalizeSymbol(s) {
  return String(s || '').replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
}

// ---------------- Helpers ----------------

function wait(reason) {
  return { action: 'WAIT', reasons: Array.isArray(reason) ? reason : [reason] };
}

function enterMultiplier(direction, config, overrides, reasons) {
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
      knockoutLevel: overrides.knockoutLevel,
      takeProfitLevel: overrides.takeProfitLevel,
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

// ================================================================
//  BOT REGISTRY
// ================================================================

const BOTS = {

  // --------------------------------------------------------------
  // CATEGORY A — FX MULTIPLIER BOTS (7)
  // --------------------------------------------------------------

  trend_rider: {
    id: 'trend_rider', name: 'Trend Rider',
    description: 'FX Multiplier. Enter when pattern, momentum, and strategy consensus all agree.',
    assetClass: 'fx', contractClass: 'multiplier',
    defaultConfig: {
      symbol: 'EURUSD', timeframe: 'M5', stake: 10, multiplier: 200,
      durationSec: 900, minConfidence: 65, stopAfterLosses: 3,
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
      const ko = dir === 'BUY' ? entry - atr * 1.5 : entry + atr * 1.5;
      const tp = dir === 'BUY' ? entry + atr * 3.0 : entry - atr * 3.0;
      return enterMultiplier(dir, config,
        { durationSec: config.durationSec, knockoutLevel: ko, takeProfitLevel: tp },
        [`Pattern ${prediction.pattern.bias} (${prediction.pattern.confidence}%)`,
         `Momentum ${prediction.momentum.direction}`,
         `Conf ${prediction.calibratedConfidence}%`]);
    },
  },

  range_scalper: {
    id: 'range_scalper', name: 'Range Scalper',
    description: 'FX Multiplier. S/R bounce only in RANGING regime. Tight TP.',
    assetClass: 'fx', contractClass: 'multiplier',
    defaultConfig: {
      symbol: 'EURUSD', timeframe: 'M5', stake: 5, multiplier: 100, durationSec: 600,
    },
    evaluate(ctx) {
      const { state, config } = ctx;
      if (!state) return wait('No state');
      if (state.regime && state.regime.code !== 'RANGING') {
        return wait(`Regime ${state.regime.code}, need RANGING`);
      }
      const atS = state.structure && state.structure.isAtSupport;
      const atR = state.structure && state.structure.isAtResistance;
      if (!atS && !atR) return wait('Not at S/R');
      const dir = atS ? 'BUY' : 'SELL';
      const atr = state.volatility.atr;
      const entry = state.price.current;
      const ko = dir === 'BUY' ? entry - atr * 1.0 : entry + atr * 1.0;
      const tp = dir === 'BUY' ? entry + atr * 1.8 : entry - atr * 1.8;
      return enterMultiplier(dir, config,
        { durationSec: config.durationSec, knockoutLevel: ko, takeProfitLevel: tp },
        [atS ? 'At support' : 'At resistance', 'RANGING regime']);
    },
  },

  breakout_hunter: {
    id: 'breakout_hunter', name: 'Breakout Hunter',
    description: 'FX Multiplier. 20-candle range break with volume expansion.',
    assetClass: 'fx', contractClass: 'multiplier',
    defaultConfig: {
      symbol: 'EURUSD', timeframe: 'M5', stake: 10, multiplier: 200,
      durationSec: 900, minAtrRatio: 1.2,
    },
    evaluate(ctx) {
      const { prediction, state, config } = ctx;
      if (!prediction || !state) return wait('No prediction');
      const patterns = (prediction.pattern && prediction.pattern.patterns) || [];
      const isUp = patterns.indexOf('breakout_up') >= 0;
      const isDown = patterns.indexOf('breakout_down') >= 0;
      if (!isUp && !isDown) return wait('No breakout detected');
      if (state.volatility.ratio < config.minAtrRatio) {
        return wait(`ATR ratio ${state.volatility.ratio} < ${config.minAtrRatio}`);
      }
      const dir = isUp ? 'BUY' : 'SELL';
      const atr = state.volatility.atr;
      const entry = state.price.current;
      const ko = dir === 'BUY' ? entry - atr * 1.5 : entry + atr * 1.5;
      const tp = dir === 'BUY' ? entry + atr * 3.5 : entry - atr * 3.5;
      return enterMultiplier(dir, config,
        { durationSec: config.durationSec, knockoutLevel: ko, takeProfitLevel: tp },
        [isUp ? 'Breakout up' : 'Breakout down', `ATR ${state.volatility.ratio}x`]);
    },
  },

  momentum_burst: {
    id: 'momentum_burst', name: 'Momentum Burst',
    description: 'FX Multiplier. Aligned velocity + acceleration. Short duration.',
    assetClass: 'fx', contractClass: 'multiplier',
    defaultConfig: {
      symbol: 'EURUSD', timeframe: 'M1', stake: 5, multiplier: 300,
      durationSec: 300, velocityThreshold: 0.00005,
    },
    evaluate(ctx) {
      const { state, config } = ctx;
      if (!state) return wait('No state');
      const v = (state.awareness && state.awareness.velocity) || 0;
      const a = (state.awareness && state.awareness.acceleration) || 0;
      if (Math.abs(v) < config.velocityThreshold) {
        return wait(`Velocity ${v.toFixed(6)} below threshold`);
      }
      if (Math.sign(v) !== Math.sign(a) || Math.abs(a) < 0.000001) {
        return wait('Acceleration not aligned');
      }
      const dir = v > 0 ? 'BUY' : 'SELL';
      const atr = state.volatility.atr;
      const entry = state.price.current;
      const ko = dir === 'BUY' ? entry - atr * 1.2 : entry + atr * 1.2;
      const tp = dir === 'BUY' ? entry + atr * 2.2 : entry - atr * 2.2;
      return enterMultiplier(dir, config,
        { durationSec: config.durationSec, knockoutLevel: ko, takeProfitLevel: tp },
        [`Velocity ${(v * 1e6).toFixed(1)}e-6, accel aligned`]);
    },
  },

  pattern_reversal: {
    id: 'pattern_reversal', name: 'Pattern Reversal',
    description: 'FX Multiplier. Reversal candle pattern at S/R extremes.',
    assetClass: 'fx', contractClass: 'multiplier',
    defaultConfig: {
      symbol: 'EURUSD', timeframe: 'M5', stake: 8, multiplier: 150, durationSec: 900,
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
      const ko = dir === 'BUY' ? entry - atr * 1.3 : entry + atr * 1.3;
      const tp = dir === 'BUY' ? entry + atr * 2.5 : entry - atr * 2.5;
      return enterMultiplier(dir, config,
        { durationSec: config.durationSec, knockoutLevel: ko, takeProfitLevel: tp },
        [`Reversal: ${pats.join(', ')}`, dir === 'BUY' ? 'At support' : 'At resistance']);
    },
  },

  pullback_trader: {
    id: 'pullback_trader', name: 'Pullback Trader',
    description: 'FX Multiplier. Pullback to EMA20 in a trend, then enter with trend.',
    assetClass: 'fx', contractClass: 'multiplier',
    defaultConfig: {
      symbol: 'EURUSD', timeframe: 'M5', stake: 10, multiplier: 200, durationSec: 900,
    },
    evaluate(ctx) {
      const { state, config, candles } = ctx;
      if (!state) return wait('No state');
      const regime = state.regime && state.regime.code;
      if (['STRONG_TREND_BULL', 'STRONG_TREND_BEAR', 'WEAK_TREND'].indexOf(regime) < 0) {
        return wait('Not in trend regime');
      }
      if (!candles || candles.length < 25) return wait('Not enough candles');
      const closes = candles.map(c => c.close);
      const emaArr = EMA(closes, 20);
      const ema = emaArr[emaArr.length - 1];
      const price = closes[closes.length - 1];
      if (!Number.isFinite(ema)) return wait('EMA unavailable');
      const distPct = Math.abs(price - ema) / price;
      if (distPct > 0.001) return wait(`Price ${(distPct * 100).toFixed(3)}% from EMA, waiting`);
      const dir = state.trend && state.trend.direction === 'bullish' ? 'BUY' : 'SELL';
      const atr = state.volatility.atr;
      const ko = dir === 'BUY' ? ema - atr * 1.5 : ema + atr * 1.5;
      const tp = dir === 'BUY' ? price + atr * 2.5 : price - atr * 2.5;
      return enterMultiplier(dir, config,
        { durationSec: config.durationSec, knockoutLevel: ko, takeProfitLevel: tp },
        [`Pullback to EMA20 in ${state.trend.direction} trend`]);
    },
  },

  squeeze_breaker: {
    id: 'squeeze_breaker', name: 'Squeeze Breaker',
    description: 'FX Multiplier. Bollinger squeeze breakout.',
    assetClass: 'fx', contractClass: 'multiplier',
    defaultConfig: {
      symbol: 'EURUSD', timeframe: 'M5', stake: 10, multiplier: 200, durationSec: 900,
    },
    evaluate(ctx) {
      const { state, config, candles } = ctx;
      if (!state || !candles || candles.length < 25) return wait('Not enough data');
      const closes = candles.map(c => c.close);
      const bb = BollingerBands(closes, 20, 2);
      if (!bb || !bb.bandwidth || bb.bandwidth.length < 20) return wait('BB unavailable');
      const bw = bb.bandwidth[bb.bandwidth.length - 1];
      const avg = bb.bandwidth.slice(-20).reduce((a, b) => a + b, 0) / 20;
      if (bw >= avg * 0.5) return wait(`No squeeze (bw ${bw.toFixed(4)} vs ${avg.toFixed(4)})`);
      const price = closes[closes.length - 1];
      const upper = bb.upper[bb.upper.length - 1];
      const lower = bb.lower[bb.lower.length - 1];
      let dir = 'NEUTRAL';
      if (price > upper) dir = 'BUY';
      else if (price < lower) dir = 'SELL';
      if (dir === 'NEUTRAL') return wait('Squeeze but no breakout yet');
      const atr = state.volatility.atr;
      const ko = dir === 'BUY' ? price - atr * 1.5 : price + atr * 1.5;
      const tp = dir === 'BUY' ? price + atr * 3.0 : price - atr * 3.0;
      return enterMultiplier(dir, config,
        { durationSec: config.durationSec, knockoutLevel: ko, takeProfitLevel: tp },
        [`Squeeze breakout ${dir}`]);
    },
  },

  // --------------------------------------------------------------
  // CATEGORY B — SYNTHETIC DIGIT BOTS (5)
  // --------------------------------------------------------------

  even_odd_trader: {
    id: 'even_odd_trader', name: 'Even/Odd Trader',
    description: 'Synthetic digit. Trades EVEN or ODD when frequency edge ≥ threshold.',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, minEdge: 0.08, minSamples: 50,
    },
    evaluate(ctx) {
      const { digitView, config } = ctx;
      if (!digitView) return wait('No digit data');
      if (digitView.sampleSize < config.minSamples) {
        return wait(`Samples ${digitView.sampleSize} < ${config.minSamples}`);
      }
      const even = digitView.evenPct;
      const odd = digitView.oddPct;
      if (even >= 50 + config.minEdge * 100) {
        return enterDigit('DIGITEVEN', config, `Even ${even.toFixed(1)}%`);
      }
      if (odd >= 50 + config.minEdge * 100) {
        return enterDigit('DIGITODD', config, `Odd ${odd.toFixed(1)}%`);
      }
      return wait(`Even ${even.toFixed(1)}% / Odd ${odd.toFixed(1)}%`);
    },
  },

  over_under_trader: {
    id: 'over_under_trader', name: 'Over/Under Trader',
    description: 'Synthetic digit. Trades OVER or UNDER a digit threshold.',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, threshold: 5, minEdge: 0.10, minSamples: 100,
    },
    evaluate(ctx) {
      const { digitView, config } = ctx;
      if (!digitView) return wait('No digit data');
      if (digitView.sampleSize < config.minSamples) {
        return wait(`Samples ${digitView.sampleSize} < ${config.minSamples}`);
      }
      const freq = digitView.digitFreq;
      const th = config.threshold;
      const overCount = freq.slice(th + 1).reduce((a, b) => a + b, 0);
      const underCount = freq.slice(0, th + 1).reduce((a, b) => a + b, 0);
      const total = digitView.sampleSize;
      const overPct = (overCount / total) * 100;
      const underPct = (underCount / total) * 100;
      if (overPct >= 50 + config.minEdge * 100) {
        return enterDigitBarrier('DIGITOVER', th, config, `Over ${th}: ${overPct.toFixed(1)}%`);
      }
      if (underPct >= 50 + config.minEdge * 100) {
        return enterDigitBarrier('DIGITUNDER', th, config, `Under ${th}: ${underPct.toFixed(1)}%`);
      }
      return wait(`Over ${th}: ${overPct.toFixed(1)}% / Under ${th}: ${underPct.toFixed(1)}%`);
    },
  },

  matches_differs_trader: {
    id: 'matches_differs_trader', name: 'Matches/Differs Trader',
    description: 'Synthetic digit. Trades MATCHES or DIFFERS on a specific digit.',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, targetDigit: 5, minSamples: 100,
    },
    evaluate(ctx) {
      const { digitView, config } = ctx;
      if (!digitView) return wait('No digit data');
      if (digitView.sampleSize < config.minSamples) {
        return wait(`Samples ${digitView.sampleSize} < ${config.minSamples}`);
      }
      const freq = digitView.digitFreq;
      const total = digitView.sampleSize;
      const target = config.targetDigit;
      const targetPct = (freq[target] / total) * 100;
      if (targetPct >= 13) {
        return enterDigitBarrier('DIGITMATCH', target, config, `Digit ${target} hot: ${targetPct.toFixed(1)}%`);
      }
      if (targetPct <= 7) {
        return enterDigitBarrier('DIGITDIFF', target, config, `Digit ${target} cold: ${targetPct.toFixed(1)}%`);
      }
      return wait(`Digit ${target} at ${targetPct.toFixed(1)}% (need <7 or >13)`);
    },
  },

  digit_streak_fade: {
    id: 'digit_streak_fade', name: 'Digit Streak Fade',
    description: 'Synthetic digit. Fades long even/odd streaks (mean reversion).',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, minStreak: 4,
    },
    evaluate(ctx) {
      const { digitView, config } = ctx;
      if (!digitView) return wait('No digit data');
      const evenStreak = digitView.evenStreak || 0;
      const oddStreak = digitView.oddStreak || 0;
      if (evenStreak >= config.minStreak) {
        return enterDigit('DIGITODD', config, `${evenStreak}-streak of even, fading to ODD`);
      }
      if (oddStreak >= config.minStreak) {
        return enterDigit('DIGITEVEN', config, `${oddStreak}-streak of odd, fading to EVEN`);
      }
      return wait(`Streak: even=${evenStreak} odd=${oddStreak}`);
    },
  },

  digit_hot_cold: {
    id: 'digit_hot_cold', name: 'Digit Hot/Cold',
    description: 'Synthetic digit. Trades OVER/UNDER the best-edge threshold.',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, minSamples: 100,
    },
    evaluate(ctx) {
      const { digitView, config } = ctx;
      if (!digitView) return wait('No digit data');
      if (digitView.sampleSize < config.minSamples) {
        return wait(`Samples < ${config.minSamples}`);
      }
      const freq = digitView.digitFreq;
      const total = digitView.sampleSize;
      let bestOver = null, bestUnder = null;
      for (let th = 1; th <= 8; th++) {
        const overPct = (freq.slice(th + 1).reduce((a, b) => a + b, 0) / total) * 100;
        const underPct = (freq.slice(0, th + 1).reduce((a, b) => a + b, 0) / total) * 100;
        if (overPct > 55 && (!bestOver || overPct > bestOver.pct)) bestOver = { th, pct: overPct };
        if (underPct > 55 && (!bestUnder || underPct > bestUnder.pct)) bestUnder = { th, pct: underPct };
      }
      if (bestOver && bestOver.pct >= (bestUnder ? bestUnder.pct : 0)) {
        return enterDigitBarrier('DIGITOVER', bestOver.th, config, `Over ${bestOver.th}: ${bestOver.pct.toFixed(1)}%`);
      }
      if (bestUnder) {
        return enterDigitBarrier('DIGITUNDER', bestUnder.th, config, `Under ${bestUnder.th}: ${bestUnder.pct.toFixed(1)}%`);
      }
      return wait('No strong over/under edge');
    },
  },

  // --------------------------------------------------------------
  // CATEGORY C — SYNTHETIC RISE/FALL BOTS (3)
  // --------------------------------------------------------------

  rise_fall_momentum: {
    id: 'rise_fall_momentum', name: 'Rise/Fall Momentum',
    description: 'Synthetic CALL/PUT based on tick direction bias > threshold.',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, minBias: 0.56, minSamples: 100,
    },
    evaluate(ctx) {
      const { digitView, config } = ctx;
      if (!digitView) return wait('No data');
      if (digitView.sampleSize < config.minSamples) {
        return wait(`Samples < ${config.minSamples}`);
      }
      const risePct = digitView.risePct / 100;
      const fallPct = digitView.fallPct / 100;
      if (risePct >= config.minBias) {
        return enterBinary('CALL', config, `Rise bias ${(risePct * 100).toFixed(1)}%`);
      }
      if (fallPct >= config.minBias) {
        return enterBinary('PUT', config, `Fall bias ${(fallPct * 100).toFixed(1)}%`);
      }
      return wait(`Rise ${(risePct * 100).toFixed(1)}% / Fall ${(fallPct * 100).toFixed(1)}%`);
    },
  },

  rise_fall_streak: {
    id: 'rise_fall_streak', name: 'Rise/Fall Streak Fade',
    description: 'Synthetic CALL/PUT. Fades N consecutive rises or falls.',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, minStreak: 4,
    },
    evaluate(ctx) {
      const { digitView, config } = ctx;
      if (!digitView) return wait('No data');
      const dirs = (digitView.directions || []).slice(-20);
      if (dirs.length < config.minStreak) return wait('Not enough ticks');
      let streak = 0, lastDir = null;
      for (let i = dirs.length - 1; i >= 0; i--) {
        if (dirs[i] === 'flat') break;
        if (lastDir === null) { lastDir = dirs[i]; streak = 1; }
        else if (dirs[i] === lastDir) streak++;
        else break;
      }
      if (streak >= config.minStreak) {
        const dir = lastDir === 'up' ? 'PUT' : 'CALL';
        return enterBinary(dir, config, `${streak}-tick ${lastDir}-streak → fade to ${dir}`);
      }
      return wait(`Streak: ${streak} ${lastDir || '-'}`);
    },
  },

  rise_fall_breakout: {
    id: 'rise_fall_breakout', name: 'Rise/Fall Breakout',
    description: 'Synthetic CALL/PUT on sharp directional tick burst.',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, lookbackTicks: 10, minMovePct: 0.05,
    },
    evaluate(ctx) {
      const { digitView, config } = ctx;
      if (!digitView) return wait('No data');
      const prices = (digitView.recentPrices || []).slice(-config.lookbackTicks);
      if (prices.length < 5) return wait('Not enough prices');
      const first = prices[0], last = prices[prices.length - 1];
      const movePct = ((last - first) / first) * 100;
      if (Math.abs(movePct) < config.minMovePct) {
        return wait(`Move ${movePct.toFixed(3)}% < ${config.minMovePct}%`);
      }
      const dir = movePct > 0 ? 'CALL' : 'PUT';
      return enterBinary(dir, config, `Move ${movePct.toFixed(3)}% in ${config.lookbackTicks} ticks`);
    },
  },

  // --------------------------------------------------------------
  // CATEGORY D — SYNTHETIC VOLATILITY BOTS (2)
  // --------------------------------------------------------------

  vol_high_low: {
    id: 'vol_high_low', name: 'Volatility High/Low',
    description: 'Synthetic ONETOUCH/NOTOUCH on momentum bias.',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, barrierPips: 10,
    },
    evaluate(ctx) {
      const { digitView, config } = ctx;
      if (!digitView) return wait('No data');
      const dirs = (digitView.directions || []).slice(-20);
      const up = dirs.filter(d => d === 'up').length;
      const down = dirs.filter(d => d === 'down').length;
      const total = up + down;
      if (total === 0) return wait('Not enough direction data');
      const bias = Math.max(up, down) / total;
      if (bias > 0.65) {
        return enterBinary('ONETOUCH', config, `Strong directional bias ${(bias * 100).toFixed(1)}%`);
      }
      if (bias < 0.55) {
        return enterBinary('NOTOUCH', config, `Balanced movement, expect no touch`);
      }
      return wait(`Bias ${(bias * 100).toFixed(1)}%`);
    },
  },

  vol_scalper: {
    id: 'vol_scalper', name: 'Volatility Scalper',
    description: 'Synthetic CALL/PUT. Quick 5-tick scalps on strong short-term momentum.',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5,
    },
    evaluate(ctx) {
      const { digitView, config } = ctx;
      if (!digitView) return wait('No data');
      const dirs = (digitView.directions || []).slice(-5);
      if (dirs.length < 5) return wait('Not enough ticks');
      const ups = dirs.filter(d => d === 'up').length;
      const downs = dirs.filter(d => d === 'down').length;
      if (ups >= 4) return enterBinary('CALL', config, `4/5 ticks up`);
      if (downs >= 4) return enterBinary('PUT', config, `4/5 ticks down`);
      return wait(`ups=${ups} downs=${downs}`);
    },
  },
};

function getBot(id) { return BOTS[id] || null; }
function listBots() { return Object.values(BOTS); }

module.exports = { BOTS, getBot, listBots, normalizeSymbol };
