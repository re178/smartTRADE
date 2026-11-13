// core/bots/registry.js
// 21 bots. Multi-signal, adaptive, risk-enforced.
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
// [FIX-SHADOW-MODES] Three shadow modes per bot:
//     wins=0, obs=false → OFF (fire immediate, no shadow)
//     wins=0, obs=true  → OBSERVATIONAL (shadow + real in parallel)
//     wins>0            → GATED (shadow gates real fires)
//
// [FIX-HIGH-PAYOUT] Four new high-payout bots:
//   • touch_hunter       — Touch/No Touch (200-350% payout on far barriers)
//   • vanilla_trend      — Vanilla Call/Put (uncapped, payout scales with move)
//   • turbo_breakout     — Turbo Long/Short (payout_per_point × distance)
//   • accumulator_scalper — Accumulator (exponential: 3%/tick compounds)
//
// [FIX-ACCU-TUNING] Accumulator Scalper tuned after 0W/5L observation:
//   • growthRatePct 5 → 3 (range ~0.17%, survives ~90s vs 15s)
//   • maxRangePct 0.15 → 0.08 (only fire when truly compressed)
//   • accumulatorTakeProfit null → 2 (auto-close at +$2 = 2× stake)
//
// [FIX-SESSION-STOPS] Session $ stops disabled on touch/vanilla/turbo
//   only. Accumulator keeps its safety net. Rationale: high-variance
//   bots need room to run through losing streaks before the eventual win.
//
// [FIX-COMPOUND-STAKE] Compound stake system added to synthetic_binary
//   bots only. Six config fields (compoundEnabled, compoundMaxStake,
//   compoundStartAfterWins, compoundGrowthRatePct, compoundStopAfterWins,
//   compoundResetAfterWins) appear in the bot form for the 9
//   synthetic_binary bots. Behavior: grows stake on WIN (past start
//   threshold), caps at max, resets after N wins. Cumulative wins
//   counter. No persistence across bot restart.
//
// [FIX-SHADOW-PHASE] **Real-shadow gated mode.**
//
//   Previous gated shadow reconstructed outcomes from tick data — ~5-15%
//   error because Deriv enters at tick N+2 while shadow entered at tick N.
//
//   The fix: shadow-phase trades are now REAL contracts at shadowStake
//   (default $0.35). Every outcome is 100% accurate because it IS a real
//   trade. Gate flow:
//     • Rule fires during shadow phase → place real trade at shadowStake
//     • WIN → shadow consecutive counter++; at gate → real fire at stake
//     • LOSS → shadow counter resets; gate tightens by +1 (cap 10)
//     • Real trade WIN → stay in real mode, normal stake
//     • Real trade LOSS → back to shadow phase, tighten gate
//
//   `shadowStake` config field added to RISK_DEFAULTS below. FX and
//   digit bots see it in the form but never read it (their shadow mode
//   is always off since assetClass !== 'synthetic_binary').
//
//   IMPORTANT — economic viability:
//     Shadow phase costs real money (shadowStake × number of fires
//     before gate opens). Only profitable on bots with payout > 2×:
//       ✅ MATCH/DIFF, OVER/UNDER, TOUCH, VANILLA, TURBO, ACCU
//       ❌ EVEN/ODD, RISE/FALL, VOL_* (0.88× payout — costs exceed wins)
//     Set shadowWinsRequired: 0 on the ❌ bots to disable.
//
// [FIX-PRECISION-DIGIT] Digit bots rewritten for higher hit rate at
//   fair payout tiers. Summary of changes:
//
//   even_odd_trader:
//     • zThreshold 1.5 → 2.0 (fires only on strong parity extreme)
//     • mode: 'fade' (explicit) — fades extremes instead of chasing
//   over_under_trader:
//     • Barrier moved from OVER 8 / UNDER 1 (10% base, 9× payout, huge
//       variance) to OVER 6 / UNDER 3 (30% base, ~2.9× payout).
//       Same or better EV, dramatically lower variance.
//     • zThreshold 1.5 → 2.0
//   matches_differs_trader:
//     • mode: 'diff_hot' default — fires DIGITDIFF when the target digit
//       is statistically HOT (z >= 2.0). ~90% base WR, 1.05× payout.
//       Old default (MATCH on cold digit, 10% WR) produced routine
//       9-loss droughts. Cold-target MATCH path still available via
//       `mode: 'match_cold'`.
//   digit_streak_fade:
//     • minStreak 8 → 6 (fires more often; still above expected max for
//       most regimes)
//   digit_hot_cold:
//     • Barrier moved from OVER 8 / UNDER 1 → OVER 6 / UNDER 3
//     • zThreshold 2.0 → 2.2 (tighter; complements over_under_trader)
//
// [FIX-VOL-SCALPER-PRECISION] vol_scalper redesigned.
//   Old logic: fire 5/5 momentum follow — ~50% WR at 0.88× payout
//   (net loss; no statistical edge).
//   New logic: fade 7+ streaks ONLY when the 30-tick directional bias
//   is <= trendConflictPct (default 65%) — i.e., fade only when the
//   streak is a local anomaly inside a choppy tape, which is where the
//   small mean-reversion bias of Deriv synthetic indices actually shows.
//   New config:
//     minStreak           (default 7)  — trailing streak length required
//     mode                (default 'fade') — 'fade' | 'follow'
//     trendConflictPct    (default 0.65) — reject fires when 30-tick bias
//                                          aligns with streak above this
//     minSamples          (default 30) — minimum direction samples
//   The 'follow' mode reproduces the old behavior for A/B comparison.

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

  // ── Synthetic Digit (5) — [FIX-PRECISION-DIGIT] rewritten ──
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

  // ── Synthetic Binary (5) ──
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
      const finalDir = flip ? (normalDir === 'CALL' ? 'PUT' : 'CALL') : normalDir;
      const reason = flip ? `${normalDir} FLIPPED → ${finalDir}` : `Bias ${((normalDir === 'CALL' ? risePct : fallPct) * 100).toFixed(1)}%`;
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
      const reason = flip ? `${streak}-tick ${lastDir}-streak FLIPPED → ${finalDir}` : `${streak}-tick ${lastDir}-streak → fade to ${finalDir}`;
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
      if (Math.abs(movePct) < config.minMovePct) return wait(`Move ${movePct.toFixed(3)}% too small (Need ${config.minMovePct.toFixed(3)}%)`);
      const normalDir = movePct > 0 ? 'CALL' : 'PUT';
      const flip = shouldFlip(config, stats);
      const finalDir = flip ? (normalDir === 'CALL' ? 'PUT' : 'CALL') : normalDir;
      const reason = flip ? `Move ${movePct.toFixed(3)}% FLIPPED → ${finalDir}` : `Move ${movePct.toFixed(3)}%`;
      return enterBinary(finalDir, config, reason);
    },
  },

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
      const finalDir = flip ? (normalDir === 'CALL' ? 'PUT' : 'CALL') : normalDir;
      const reason = flip ? `${normalDir} FLIPPED → ${finalDir}` : `Direction bias ${(upBias * 100).toFixed(1)}% up → ${normalDir}`;
      return enterBinary(finalDir, config, reason);
    },
  },

  vol_scalper: {
    id: 'vol_scalper', name: 'Volatility Scalper',
    description: 'Synthetic CALL/PUT. Fades extreme streaks (7+) when 30-tick directional bias is only moderate (<= 65%). Trend-conflict filter blocks fading during real momentum runs. Shadow-gated.',
    assetClass: 'synthetic_binary', contractClass: 'binary',
    baseRate: 0.50,
    defaultConfig: {
      symbol: 'R_100', stake: 1, durationTicks: 5,
      minStreak: 7,
      mode: 'fade',
      trendConflictPct: 0.65,
      minSamples: 30,
      shadowWinsRequired: 3,
      flipEnabled: false, flipBelowPct: 48, flipMinTrades: 20, flipStableTrades: 20,
    },
    evaluate(ctx) {
      const dv = sanitizeDigitView(ctx.digitView);
      if (!dv) return wait('Corrupt or missing digit data');
      if ((dv.sampleSize || 0) < ctx.config.minSamples) return wait('Not enough samples');

      const { config, stats } = ctx;
      const dirs = (dv.directions || []).slice(-30);
      if (dirs.length < config.minStreak) return wait(`Not enough ticks (${dirs.length}/${config.minStreak})`);

      // Count the current trailing streak
      let streak = 0, lastDir = null;
      for (let i = dirs.length - 1; i >= 0; i--) {
        if (dirs[i] === 'flat') break;
        if (lastDir === null) { lastDir = dirs[i]; streak = 1; }
        else if (dirs[i] === lastDir) streak++;
        else break;
      }
      if (streak < config.minStreak) return wait(`Streak ${streak}/${config.minStreak} ${lastDir || '-'}`);

      // Trend-conflict filter: bias = share of last 30 ticks in streak direction
      const ups = dirs.filter(d => d === 'up').length;
      const downs = dirs.filter(d => d === 'down').length;
      const total = ups + downs;
      if (total < 10) return wait('Not enough non-flat ticks');
      const bias = lastDir === 'up' ? ups / total : downs / total;

      if (config.mode === 'fade' && bias > config.trendConflictPct) {
        return wait(`Trend conflict: ${lastDir}-bias ${(bias * 100).toFixed(0)}% > ${(config.trendConflictPct * 100)}% — won't fade a strong trend`);
      }
      if (config.mode === 'follow' && bias < config.trendConflictPct) {
        return wait(`Weak trend: ${lastDir}-bias ${(bias * 100).toFixed(0)}% < ${(config.trendConflictPct * 100)}% — follow needs trend confirmation`);
      }

      let normalDir;
      if (config.mode === 'fade') normalDir = lastDir === 'up' ? 'PUT' : 'CALL';
      else                          normalDir = lastDir === 'up' ? 'CALL' : 'PUT';

      const flip = shouldFlip(config, stats);
      const finalDir = flip ? (normalDir === 'CALL' ? 'PUT' : 'CALL') : normalDir;
      const reason = flip
        ? `${streak}-tick ${lastDir} ${config.mode} FLIPPED → ${finalDir} (bias ${(bias * 100).toFixed(0)}%)`
        : `${streak}-tick ${lastDir} ${config.mode} → ${finalDir} (bias ${(bias * 100).toFixed(0)}%)`;
      return enterBinary(finalDir, config, reason);
    },
  },

  // ── High-Payout (4) ──
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
  // [FIX-SHADOW-PHASE] Stake used for shadow-phase validation trades in
  // gated mode. Every rule-fire during shadow phase places a REAL contract
  // at this stake. Outcomes are 100% accurate (it IS the real trade).
  // Default 0.35 — small enough that 3-10 validation fires cost
  // $1.05-$3.50 to open the gate. Change per-bot in the form.
  //
  // Only read by synthetic_binary bots in gated mode. FX and digit bots
  // see the field in their form but never use it.
  shadowStake: 0.35,
};

for (const id in BOTS) {
  BOTS[id].defaultConfig = Object.assign({}, RISK_DEFAULTS, BOTS[id].defaultConfig);
}

// ── [FIX-COMPOUND-STAKE] Compound config — synthetic_binary ONLY ──
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
