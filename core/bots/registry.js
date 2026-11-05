// core/bots/registry.js
// 17 bots. Multi-signal, adaptive, risk-enforced.
//
// [FIX-VOLHL] vol_high_low was emitting ONETOUCH/NOTOUCH without a barrier
//   parameter, which Deriv rejects with `InvalidBarrierSingle`. The bot
//   never placed a single trade. Now uses CALL/PUT based on directional
//   bias (same signal, valid contract type, no barrier needed).
//   The bias thresholds (0.72 / 0.45) are preserved.
//
// [FIX-DIGIT-DYN] Digit bots use statistical significance (z-scores)
//   instead of fixed percentage thresholds.
//
// [FIX-UNDER-BARRIER] DIGITUNDER contracts now correctly send barrier=1
//   (was 0 — impossible to win).
//
// [FIX-SHADOW-CFG] shadowWinsRequired on the five synthetic binary bots.
//
// [FIX-HIGH-PAYOUT] Four new high-payout bots added:
//   • touch_hunter       — Touch/No Touch (200–350% payout on far barriers)
//   • vanilla_trend      — Vanilla Call/Put (uncapped, payout scales with move)
//   • turbo_breakout     — Turbo Long/Short (payout_per_point × distance)
//   • accumulator_scalper — Accumulator (exponential: 3%/tick compounds)
//
// [FIX-ACCU-TUNING] **Accumulator Scalper tuned after 0W/5L observation.**
//   Original config (5%/tick, 0.15% max range) was too aggressive:
//     • At 5% growth, R_100's implied ACCU range is ~0.1% wide
//     • R_100 volatility ≈ 0.5–1.0 points/minute at ~523 price level
//     • So the range was breached within 15–30s on almost every trade
//     • Knockout happens before compounding can accumulate meaningful profit
//     • Result: 0W/5L with every trade hitting knockout
//   Fix:
//     • growthRatePct 5 → 3 (range ~0.17% wide, survives ~90s)
//     • maxRangePct 0.15 → 0.08 (only fire when truly compressed)
//     • accumulatorTakeProfit null → 2 (auto-close at +$2 profit = 2× stake)
//   At 3% growth × 30 ticks, max theoretical payout is 1.03^30 = 2.43× stake.
//   TP of $2 locks in 200% before the contract can reverse into a knockout.
//
// [FIX-SESSION-STOPS] Session $ stops overridden to 0 (disabled) on the
//   three truly high-variance bots — touch_hunter, vanilla_trend,
//   turbo_breakout. Rationale: 20–30% win rate with 2–3.5× payoff means
//   the session can rack up 5–8 consecutive losses ($5–$8 with default $1
//   stake) before hitting the eventual win that pays 2–3.5× stake. A $10
//   stop loss would end the session before that win arrives.
//
//   **Accumulator keeps session stops (TP+$20/SL-$10)** because its loss
//   profile is different: capped at 100% of stake per trade, not a
//   tail-risk knockout that eats 8× stake. With the ACCU tuning above
//   (30–40% win rate, 2× payoff), the safety net helps more than hurts.
//
//   Users who want to disable stops on ACCU can set them to 0 in the form.
//   Users who want to enable stops on the other three can set them manually.

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

  // ============================================================
  // FX MULTIPLIER BOTS (7) — UNCHANGED
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
  // SYNTHETIC DIGIT BOTS (5) — UNCHANGED
  // ============================================================

  even_odd_trader: {
    id: 'even_odd_trader', name: 'Even/Odd Trader',
    description: 'Synthetic digit. EVEN/ODD on statistical extreme (|z| >= threshold). Flip NOT recommended (50/50).',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    baseRate: 0.50,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, minSamples: 50,
      zThreshold: 1.5,
      flipEnabled: false, flipBelowPct: 48, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      if (dv.sampleSize < ctx.config.minSamples) return wait('Not enough samples');
      const zs = dv.zStats;
      if (!zs) return wait(`Not enough data for z-scores (${dv.sampleSize} ticks, need 30+)`);

      const zThreshold = Number(ctx.config.zThreshold) || 1.5;
      const { config, stats } = ctx;

      let normalDir = null, zUsed = 0;
      if (zs.evenZ >= zThreshold) { normalDir = 'DIGITEVEN'; zUsed = zs.evenZ; }
      else if (zs.evenZ <= -zThreshold) { normalDir = 'DIGITODD'; zUsed = -zs.evenZ; }

      if (!normalDir) {
        return wait(`evenZ=${zs.evenZ.toFixed(2)} (need |z| >= ${zThreshold}, N=${zs.windowSize})`);
      }

      const flip = shouldFlip(config, stats);
      const finalDir = flip
        ? (normalDir === 'DIGITEVEN' ? 'DIGITODD' : 'DIGITEVEN')
        : normalDir;
      const reason = flip
        ? `${normalDir} FLIPPED → ${finalDir} (z=${zUsed.toFixed(2)})`
        : `${normalDir.replace('DIGIT','')} z=${zUsed.toFixed(2)} N=${zs.windowSize}`;
      return enterDigit(finalDir, config, reason);
    },
  },

  over_under_trader: {
    id: 'over_under_trader', name: 'Over/Under Trader',
    description: 'Synthetic digit. OVER/UNDER on statistical extreme (z-score). Flip changes barrier.',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    baseRate: 0.10,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, threshold: 8, minSamples: 100,
      zThreshold: 1.5,
      flipEnabled: false, flipBelowPct: 8, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      if (dv.sampleSize < ctx.config.minSamples) return wait('Not enough samples');
      const zs = dv.zStats;
      if (!zs) return wait(`Not enough data for z-scores (${dv.sampleSize} ticks, need 30+)`);

      const zThreshold = Number(ctx.config.zThreshold) || 1.5;
      const th = Number(ctx.config.threshold) || 8;

      const overZ = zs.overZ[th];
      const underZ = zs.underZ[1];

      let normalDir = null, barrier = null, zUsed = 0;
      if (overZ <= -zThreshold) { normalDir = 'DIGITOVER'; barrier = th; zUsed = overZ; }
      else if (underZ <= -zThreshold) { normalDir = 'DIGITUNDER'; barrier = 1; zUsed = underZ; }

      if (!normalDir) {
        return wait(
          `overZ[${th}]=${overZ.toFixed(2)} underZ[1]=${underZ.toFixed(2)} ` +
          `(need <= -${zThreshold}, N=${zs.windowSize})`
        );
      }

      const flip = shouldFlip(ctx.config, ctx.stats);
      let finalDir = normalDir;
      if (flip) {
        finalDir = normalDir === 'DIGITOVER' ? 'DIGITUNDER' : 'DIGITOVER';
        barrier = finalDir === 'DIGITOVER' ? th : 1;
      }
      const reason = flip
        ? `${normalDir} FLIPPED → ${finalDir} (z=${zUsed.toFixed(2)})`
        : `${normalDir} barrier=${barrier} z=${zUsed.toFixed(2)} N=${zs.windowSize}`;
      return enterDigitBarrier(finalDir, barrier, ctx.config, reason);
    },
  },

  matches_differs_trader: {
    id: 'matches_differs_trader', name: 'Matches/Differs Trader',
    description: 'Synthetic digit. MATCH/DIFF on cold target digit (z-score). Flip is MATHEMATICALLY VALID (complementary bets).',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    baseRate: 0.10,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, targetDigit: 5, minSamples: 100,
      zThreshold: 1.5,
      flipEnabled: true, flipBelowPct: 8, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      if (dv.sampleSize < ctx.config.minSamples) return wait('Not enough samples');
      const zs = dv.zStats;
      if (!zs) return wait(`Not enough data for z-scores (${dv.sampleSize} ticks, need 30+)`);

      const zThreshold = Number(ctx.config.zThreshold) || 1.5;
      const target = Number(ctx.config.targetDigit) || 5;
      const targetZ = zs.digitZ[target];

      if (targetZ > -zThreshold) {
        return wait(`digit ${target} z=${targetZ.toFixed(2)} (need <= -${zThreshold}, N=${zs.windowSize})`);
      }

      const flip = shouldFlip(ctx.config, ctx.stats);
      const finalDir = flip ? 'DIGITDIFF' : 'DIGITMATCH';
      const reason = flip
        ? `digit ${target} cold z=${targetZ.toFixed(2)} FLIPPED → DIGITDIFF`
        : `digit ${target} cold z=${targetZ.toFixed(2)} N=${zs.windowSize} → MATCH`;
      return enterDigitBarrier(finalDir, target, ctx.config, reason);
    },
  },

  digit_streak_fade: {
    id: 'digit_streak_fade', name: 'Digit Streak Fade',
    description: 'Synthetic digit. Fades even/odd streaks beyond expected maximum. Flip NOT recommended (symmetric).',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    baseRate: 0.50,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5,
      minStreak: 8,
      streakExtra: 0,
      flipEnabled: false, flipBelowPct: 48, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');

      const zs = dv.zStats;
      const evenStreak = dv.evenStreak || 0;
      const oddStreak = dv.oddStreak || 0;

      let required = Number(ctx.config.minStreak) || 8;
      let expectedMax = null;
      if (zs && Number.isFinite(zs.expectedMaxStreak)) {
        expectedMax = zs.expectedMaxStreak;
        required = Math.ceil(expectedMax) + (Number(ctx.config.streakExtra) || 0);
      }

      let normalDir = null;
      if (evenStreak >= required) normalDir = 'DIGITODD';
      else if (oddStreak >= required) normalDir = 'DIGITEVEN';

      if (!normalDir) {
        return wait(
          `Streak: even=${evenStreak} odd=${oddStreak} ` +
          `(need ${required}${expectedMax != null ? `, expectedMax=${expectedMax.toFixed(1)}` : ''})`
        );
      }

      const flip = shouldFlip(ctx.config, ctx.stats);
      const finalDir = flip
        ? (normalDir === 'DIGITEVEN' ? 'DIGITODD' : 'DIGITEVEN')
        : normalDir;
      const reason = flip
        ? `${normalDir} fade FLIPPED → ${finalDir}`
        : `${Math.max(evenStreak, oddStreak)}-streak — fade to ${finalDir.replace('DIGIT','')}`;
      return enterDigit(finalDir, ctx.config, reason);
    },
  },

  digit_hot_cold: {
    id: 'digit_hot_cold', name: 'Digit Hot/Cold',
    description: 'Synthetic digit. OVER 8 / UNDER 1 on extreme z-score (more selective than Over/Under Trader). Flip changes barrier.',
    assetClass: 'synthetic_digit', contractClass: 'digit',
    baseRate: 0.10,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, minSamples: 150,
      zThreshold: 2.0,
      flipEnabled: false, flipBelowPct: 8, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      if (dv.sampleSize < ctx.config.minSamples) return wait('Not enough samples');
      const zs = dv.zStats;
      if (!zs) return wait(`Not enough data for z-scores (${dv.sampleSize} ticks, need 30+)`);

      const zThreshold = Number(ctx.config.zThreshold) || 2.0;
      const over8Z = zs.overZ[8];
      const under1Z = zs.underZ[1];

      let normalDir = null, barrier = null, zUsed = 0;
      if (over8Z <= -zThreshold) { normalDir = 'DIGITOVER'; barrier = 8; zUsed = over8Z; }
      else if (under1Z <= -zThreshold) { normalDir = 'DIGITUNDER'; barrier = 1; zUsed = under1Z; }

      if (!normalDir) {
        return wait(
          `over8Z=${over8Z.toFixed(2)} under1Z=${under1Z.toFixed(2)} ` +
          `(need <= -${zThreshold}, N=${zs.windowSize})`
        );
      }

      const flip = shouldFlip(ctx.config, ctx.stats);
      let finalDir = normalDir;
      if (flip) {
        finalDir = normalDir === 'DIGITOVER' ? 'DIGITUNDER' : 'DIGITOVER';
        barrier = finalDir === 'DIGITOVER' ? 8 : 1;
      }
      const reason = flip
        ? `${normalDir} FLIPPED → ${finalDir} (z=${zUsed.toFixed(2)})`
        : `${normalDir} barrier=${barrier} z=${zUsed.toFixed(2)} N=${zs.windowSize}`;
      return enterDigitBarrier(finalDir, barrier, ctx.config, reason);
    },
  },

  // ============================================================
  // SYNTHETIC BINARY BOTS (3) — UNCHANGED
  // ============================================================

  rise_fall_momentum: {
    id: 'rise_fall_momentum', name: 'Rise/Fall Momentum',
    description: 'Synthetic CALL/PUT. Flip NOT recommended (50/50). Shadow-gated.',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    baseRate: 0.50,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, minBias: 0.62, minSamples: 100,
      shadowWinsRequired: 3,
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
    description: 'Synthetic CALL/PUT. Flip NOT recommended (50/50). Shadow-gated.',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    baseRate: 0.50,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, minStreak: 7,
      shadowWinsRequired: 3,
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
    description: 'Synthetic CALL/PUT. Flip NOT recommended (50/50). Shadow-gated.',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    baseRate: 0.50,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, lookbackTicks: 10, minMovePct: 0.08,
      shadowWinsRequired: 3,
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
  // SYNTHETIC VOLATILITY BOTS (2) — UNCHANGED
  // ============================================================

  vol_high_low: {
    id: 'vol_high_low', name: 'Volatility High/Low',
    description: 'Synthetic CALL/PUT on directional bias. Flip review before enabling. Shadow-gated.',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    baseRate: 0.50,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5, barrierPips: 10,
      shadowWinsRequired: 3,
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
      if (upBias > 0.72) normalDir = 'CALL';
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
    description: 'Synthetic CALL/PUT. Flip NOT recommended (50/50). Shadow-gated.',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    baseRate: 0.50,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5,
      shadowWinsRequired: 3,
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

  // ============================================================
  // HIGH-PAYOUT BOTS (4)
  // ============================================================

  // ─────────────────────────────────────────────────────────────
  // Bot 1 — Touch Hunter
  // ─────────────────────────────────────────────────────────────
  touch_hunter: {
    id: 'touch_hunter', name: 'Touch Hunter',
    description: 'Touch/No Touch on far barriers after consolidation. High payout (200-350%) on far touches. Low win rate — designed for big wins.',
    assetClass: 'synthetic_binary', contractClass: 'touch',
    baseRate: 0.25,
    defaultConfig: {
      symbol: 'R_100',
      stake: 1,
      barrierAtr: 2.0,
      durationMinutes: 10,
      touchDirection: 'TOUCH',
      requireConsensus: true,
      minSqueezeRatio: 0.8,
      shadowWinsRequired: 0,
      flipEnabled: false, flipBelowPct: 48, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const { state, consensus, config } = ctx;
      if (!state) return wait('No market state');

      const regime = state.regime && state.regime.code;
      const volRatio = state.volatility && state.volatility.ratio;
      const isConsolidating =
        regime === 'RANGING' ||
        (Number.isFinite(volRatio) && volRatio < config.minSqueezeRatio);

      if (!isConsolidating) {
        return wait(
          `Not consolidating: regime=${regime || '?'}, volRatio=${Number(volRatio).toFixed(2)} ` +
          `(need RANGING or volRatio < ${config.minSqueezeRatio})`
        );
      }

      const atr = state.volatility && state.volatility.atr;
      if (!atr || atr <= 0) return wait('No ATR available');

      let direction = null;
      if (consensus && consensus.consensus && consensus.consensus.action === 'SIGNAL') {
        direction = consensus.consensus.direction;
      } else if (config.requireConsensus) {
        return wait('No consensus direction — need BUY or SELL bias');
      } else {
        direction = (state.trend && state.trend.direction === 'bullish') ? 'BUY' : 'SELL';
      }

      const entry = state.price && state.price.current;
      if (!entry || entry <= 0) return wait('No entry price');

      const distance = atr * config.barrierAtr;
      const precision = getBarrierPrecision(config.symbol);
      const signedDistance = (direction === 'BUY' ? '+' : '-') + distance.toFixed(precision);

      const payout = config.touchDirection === 'TOUCH' ? '200-350%' : '~40-80%';
      const reason =
        `${config.touchDirection} ${direction} ${config.barrierAtr}ATR ` +
        `(barrier=${signedDistance}, payout≈${payout})`;

      return enterTouch(config.touchDirection, signedDistance, config, reason);
    },
  },

  // ─────────────────────────────────────────────────────────────
  // Bot 2 — Vanilla Trend Rider
  // ─────────────────────────────────────────────────────────────
  vanilla_trend: {
    id: 'vanilla_trend', name: 'Vanilla Trend Rider',
    description: 'Vanilla Call/Put in strong trends. Uncapped payout — payout grows with trend distance. Trailing exit locks in gains.',
    assetClass: 'synthetic_binary', contractClass: 'vanilla',
    baseRate: 0.35,
    defaultConfig: {
      symbol: 'R_100',
      stake: 1,
      durationMinutes: 60,
      requireStrongTrend: true,
      minAtrRatio: 1.2,
      minConsensusAgreeing: 2,
      barrier: '+0.00',
      trailingEnabled: true,
      trailingActivateAfterUSD: 5.0,
      trailingRetracePct: 40,
      shadowWinsRequired: 0,
      flipEnabled: false, flipBelowPct: 48, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const { state, consensus, config } = ctx;
      if (!state) return wait('No market state');

      const regime = state.regime && state.regime.code;
      const isStrongTrend = regime === 'STRONG_TREND_BULL' || regime === 'STRONG_TREND_BEAR';
      if (config.requireStrongTrend && !isStrongTrend) {
        return wait(`Not strong trend: regime=${regime || '?'}`);
      }

      const volRatio = state.volatility && state.volatility.ratio;
      if (Number.isFinite(volRatio) && volRatio < config.minAtrRatio) {
        return wait(`ATR ratio ${volRatio.toFixed(2)} < ${config.minAtrRatio} (not expanding)`);
      }

      const c = consensus && consensus.consensus;
      if (!c || c.action !== 'SIGNAL' || !c.direction) {
        return wait('No consensus signal');
      }
      const agreeing = (consensus && consensus.agreeing && consensus.agreeing.length) || 0;
      if (agreeing < config.minConsensusAgreeing) {
        return wait(`Only ${agreeing} strategies agree (need ${config.minConsensusAgreeing})`);
      }

      const direction = c.direction;
      const entry = state.price && state.price.current;
      if (!entry || entry <= 0) return wait('No entry price');

      const reason =
        `Vanilla ${direction} ATM strike=${config.barrier} ` +
        `(regime=${regime}, ${agreeing} agree, ATR=${Number(state.volatility?.atr || 0).toFixed(4)})`;

      return enterVanilla(direction, config.barrier, config, reason);
    },
  },

  // ─────────────────────────────────────────────────────────────
  // Bot 3 — Turbo Breakout
  // ─────────────────────────────────────────────────────────────
  turbo_breakout: {
    id: 'turbo_breakout', name: 'Turbo Breakout',
    description: 'Turbo Long/Short on confirmed breakouts. Uncapped payout (payout_per_point × distance). Trailing exit locks in gains.',
    assetClass: 'synthetic_binary', contractClass: 'turbo',
    baseRate: 0.30,
    defaultConfig: {
      symbol: 'R_100',
      stake: 1,
      durationMinutes: 15,
      barrierAtrOffset: 0.5,
      requireBreakoutPattern: true,
      minAtrRatio: 1.3,
      trailingEnabled: true,
      trailingActivateAfterUSD: 2.0,
      trailingRetracePct: 25,
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
      if (Number.isFinite(volRatio) && volRatio < config.minAtrRatio) {
        return wait(`ATR ratio ${volRatio.toFixed(2)} < ${config.minAtrRatio} (no expansion)`);
      }

      const atr = state.volatility && state.volatility.atr;
      if (!atr || atr <= 0) return wait('No ATR available');

      const entry = state.price && state.price.current;
      if (!entry || entry <= 0) return wait('No entry price');

      const direction = prediction.direction;
      if (direction !== 'BUY' && direction !== 'SELL') {
        return wait(`Prediction direction=${direction} (need BUY or SELL)`);
      }

      const cushion = atr * config.barrierAtrOffset;
      const precision = getBarrierPrecision(config.symbol);
      const signedBarrier =
        (direction === 'BUY' ? '-' : '+') + cushion.toFixed(precision);

      const reason =
        `Turbo ${direction} barrier=${signedBarrier} ` +
        `(ATR=${atr.toFixed(precision)}, breakout confirmed)`;

      return enterTurbo(direction, signedBarrier, config, reason);
    },
  },

  // ─────────────────────────────────────────────────────────────
  // Bot 4 — Accumulator Scalper  [FIX-ACCU-TUNING]
  // ─────────────────────────────────────────────────────────────
  // **Tuned after 0W/5L on the initial 5%/0.15% config.**
  //
  // At 5% growth, R_100's implied ACCU range was ~0.1% wide. Given
  // R_100's typical ~0.5-1.0 point/minute volatility at ~$523, that
  // range was breached within 15-30s on nearly every trade — knockout
  // before compounding could accumulate. Result: 0W/5L.
  //
  // Tuning:
  //   • growthRatePct 5 → 3 (range ~0.17%, survives ~90s)
  //   • maxRangePct 0.15 → 0.08 (only fire when truly compressed)
  //   • accumulatorTakeProfit null → 2 (auto-close at +$2 = 2× stake)
  //
  // At 3% growth × 30 ticks, max theoretical payout is 1.03^30 = 2.43×
  // stake. TP of $2 locks in 200% before the contract can reverse into
  // a knockout. With TP=2 and expected 35-40% win rate post-fix:
  //   EV = 0.375 × $2 - 0.625 × $1 = +$0.125 per trade → profitable.
  accumulator_scalper: {
    id: 'accumulator_scalper', name: 'Accumulator Scalper',
    description: 'Accumulator on tight ranges. 3%/tick compounding, take-profit at 2× stake. One breakout knocks out the position.',
    assetClass: 'synthetic_binary', contractClass: 'accumulator',
    baseRate: 0.30,
    defaultConfig: {
      symbol: 'R_100',
      stake: 1,
      // [FIX-ACCU-TUNING] 3%/tick (was 5%) — wider range, longer survival
      growthRatePct: 3,
      // Duration is moot when TP fires first; kept for audit / fallback
      durationTicks: 30,
      // [FIX-ACCU-TUNING] Auto-close at +$2 profit (2× stake) — was null
      accumulatorTakeProfit: 2,
      // [FIX-ACCU-TUNING] Only fire when range is TRULY tight — was 0.15%
      maxRangePct: 0.08,
      rangeLookbackTicks: 20,
      shadowWinsRequired: 0,
      flipEnabled: false, flipBelowPct: 48, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const { state, digitView, config } = ctx;
      if (!state && !digitView) return wait('No market state');

      const prices = digitView && Array.isArray(digitView.recentPrices)
        ? digitView.recentPrices.slice(-config.rangeLookbackTicks)
        : null;

      if (!prices || prices.length < 10) {
        return wait(`Not enough recent prices for range check (${prices ? prices.length : 0})`);
      }

      const highs = Math.max(...prices);
      const lows = Math.min(...prices);
      const mids = (highs + lows) / 2;
      if (!Number.isFinite(mids) || mids <= 0) return wait('Invalid price data');

      const rangePct = ((highs - lows) / mids) * 100;
      if (rangePct > config.maxRangePct) {
        return wait(
          `Range ${rangePct.toFixed(3)}% > ${config.maxRangePct}% ` +
          `(high=${highs.toFixed(2)}, low=${lows.toFixed(2)})`
        );
      }

      const regime = state && state.regime && state.regime.code;
      if (regime && regime !== 'RANGING' && regime !== 'WEAK_TREND') {
        return wait(`Regime ${regime} (need RANGING or low-vol)`);
      }

      const growthRate = (Number(config.growthRatePct) || 3) / 100;
      const ticks = Number(config.durationTicks) || 30;
      const maxMultiplier = Math.pow(1 + growthRate, ticks);
      const tp = config.accumulatorTakeProfit != null ? `$${config.accumulatorTakeProfit}` : 'none';
      const reason =
        `ACCU ${(growthRate * 100).toFixed(1)}%/tick × ${ticks}t TP=${tp} ` +
        `(range=${rangePct.toFixed(3)}%, max ${maxMultiplier.toFixed(1)}× stake)`;

      return enterAccumulator(growthRate, config, reason);
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
  shadowWinsRequired: 0,
};

for (const id in BOTS) {
  BOTS[id].defaultConfig = Object.assign({}, RISK_DEFAULTS, BOTS[id].defaultConfig);
}

// ── [FIX-HIGH-PAYOUT] High-variance bot overrides (post-merge) ──
// Truly high-variance strategies (touch/vanilla/turbo) need room to run
// through losing streaks. A $10 stop loss would end the session before
// the eventual 2-3.5× win arrives.
BOTS.touch_hunter.defaultConfig.stopAfterLosses = 0;
BOTS.touch_hunter.defaultConfig.botTakeProfit = 0;
BOTS.touch_hunter.defaultConfig.botStopLoss = 0;

BOTS.vanilla_trend.defaultConfig.stopAfterLosses = 0;
BOTS.vanilla_trend.defaultConfig.botTakeProfit = 0;
BOTS.vanilla_trend.defaultConfig.botStopLoss = 0;

BOTS.turbo_breakout.defaultConfig.stopAfterLosses = 0;
BOTS.turbo_breakout.defaultConfig.botTakeProfit = 0;
BOTS.turbo_breakout.defaultConfig.botStopLoss = 0;

// **Accumulator intentionally KEEPS its session stops (TP+$20/SL-$10).**
// Its loss is capped at 100% of stake per trade (not a tail-risk knockout
// that eats 8× stake), and the tuning above (3%/tick, TP=2) should get it
// to a viable win rate without needing unlimited runway.
// [FIX-ACCU-TUNING] Only stopAfterLosses is relaxed, not $ stops.
BOTS.accumulator_scalper.defaultConfig.stopAfterLosses = 5;

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
  getBarrierPrecision,
  sanitizeDigitView,
};
