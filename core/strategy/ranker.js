// core/strategy/ranker.js
// StrategyRanker — runs every registered strategy, ranks them by historical
// edge from StrategyPerformance, and produces a weighted consensus the
// pipeline can consume.
//
// WHAT IT DOES
//   1. Runs every strategy in strategyEngine.STRATEGIES for a symbol
//   2. Loads StrategyPerformance records for that symbol
//   3. Computes a weight per strategy from win rate, regime fit, recency
//   4. Aggregates weighted signals into a consensus decision:
//        • AGREE  — multiple strategies fire same direction → high confidence
//        • SILENT — one strategy with low weight → no trade
//        • CONFLICT — strategies disagree → no trade
//        • NEUTRAL — no strategy fired → no trade
//   5. Caches the consensus for ~55s to prevent redundant runs
//   6. Returns a structured object the pipeline AND dashboard both consume
//
// DESIGN PRINCIPLES
//   • Untested strategies start with a small weight (0.15) — they don't
//     dominate but they still participate
//   • Strategies flagged as underperforming (recentWinRate < 40%) are
//     nearly excluded (weight 0.05)
//   • Signal quality (indicator confidence) modulates contribution —
//     a weak signal from a strong strategy still counts less
//   • Regime-specific win rate blends with overall win rate so
//     strategies that work in trends but fail in ranges are
//     appropriately down-weighted during ranging markets
//   • Deterministic — same inputs always produce same output (no randomness)
//   • Idempotent — safe to call repeatedly; cache handles repeats
//
// [FIX-RN1] Consensus confidence now blends the anchor's actual signal
//           strength (60-90 from the indicator) with its historical edge
//           (0.5 baseline for untested, measured win rate for tested).
//           The blend is weighted by history depth so fresh strategies are
//           judged primarily on their current signal, and seasoned strategies
//           primarily on their track record. This is what fixes the "every
//           signal is conf=55%" pattern in logs: the old formula was
//           `(effectiveWinRate × 100) + 5×(agreeing-1)`, which with all-untested
//           strategies (winRate=0.5) and exactly 2 agreers produced exactly 55
//           every time — discarding the strategy's own confidence entirely.
// [FIX-RN2] Flagged strategies no longer leak into the `agreeing` and
//           `conflicting` arrays. Previously a flagged strategy with a
//           fired signal still counted as "agreeing" for the confidence
//           boost, even though its weight was excluded from buyWeight/
//           sellWeight. Now `signalSide` is nulled for flagged rows so
//           they behave like SILENT for all consensus aggregation.
// [FIX-RN3] Richer log line for SIGNAL actions shows the confidence
//           breakdown (sig=, hist=, n=, +agree) so the "why 73%" question
//           is answerable from the log alone.
// [FIX-RN4] Cache returns deep-cloned consensus so downstream mutation
//           cannot corrupt the cache entry.
// [FIX-RN5] Exposes `confidenceBreakdown` on the consensus object so
//           downstream consumers (dashboard, debug endpoints) can inspect
//           exactly how the confidence number was derived.

'use strict';

const strategyEngine = require('./engine');
const StrategyPerformance = require('../../models/StrategyPerformance');
const logger = require('../../infrastructure/logger') || console;

// ========================================================================
// CONFIGURATION
// ========================================================================
const CONFIG = {
  CACHE_TTL_MS: 55 * 1000,                  // ~one candle cycle
  UNTESTED_WEIGHT: 0.15,                    // for strategies with 0 trades
  FLAGGED_WEIGHT: 0.05,                     // for underperforming strategies
  MIN_CONSENSUS_WEIGHT: 0.20,               // below this, direction is silent
  CONFLICT_MIN_WEIGHT: 0.20,                // both sides above this = conflict
  SINGLE_STRATEGY_STRONG_WEIGHT: 0.60,      // one strategy can carry consensus alone
  MIN_REGIME_SAMPLES: 5,                    // regime needs this many trades to use
  WEIGHT_BLEND_OVERALL_VS_REGIME: 0.6,      // 60% overall + 40% regime
  WEIGHT_BLEND_OVERALL_VS_RECENT: 0.7,      // 70% overall + 30% recent
  WEIGHT_FLOOR: 0.05,
  WEIGHT_CEILING: 1.0,
  WEIGHT_BASE_OFFSET: 0.45,                 // win rate minus this, times 2.5, gives weight
  WEIGHT_SCALE: 2.5,
  CONFIDENCE_BOOST_PER_AGREE: 5,
  MAX_CONFIDENCE: 90,
  MIN_CONFIDENCE: 0,

  // [FIX-RN1] Confidence blend parameters. For untested strategies the
  // signal confidence dominates (because historical edge is just a 0.5
  // prior). As trade count grows, historical edge takes over.
  CONF_HIST_WEIGHT_FLOOR: 0.20,     // trades=0   → 80% signal, 20% history
  CONF_HIST_WEIGHT_CEIL: 0.70,      // trades>=40→ 30% signal, 70% history
  CONF_HIST_WEIGHT_RAMP_TRADES: 40, // trades at which hist weight hits ceiling
  CONF_MAX_AGREEMENT_BONUS_FRESH: 10, // cap when anchor has 0 trades
  CONF_MAX_AGREEMENT_BONUS_SEASONED: 20, // cap when anchor has many trades
  CONF_AGREEMENT_BONUS_RAMP_TRADES: 20, // trades at which seasoned cap applies

  // Meta-strategies that combine others — skip to avoid double-counting.
  SKIP_STRATEGIES: ['weightedvote'],
};

// ========================================================================
// HELPERS
// ========================================================================

/**
 * Effective win rate — blends measured with 0.5 baseline.
 * Mirrors the logic in StrategyPerformance.effectiveWinRate() but works
 * on lean documents (which don't have the method).
 */
function effectiveWinRate(perf) {
  if (!perf || !perf.trades) return 0.5;
  const n = (perf.wins || 0) + (perf.losses || 0);
  if (n === 0) return 0.5;
  if (n >= 10) return perf.winRate;
  return (perf.winRate * n + 0.5 * (10 - n)) / 10;
}

/**
 * Effective average R — same baseline blending.
 */
function effectiveAvgR(perf) {
  if (!perf || !perf.trades) return 0;
  if (perf.trades >= 10) return perf.avgR || 0;
  return ((perf.avgR || 0) * perf.trades) / 10;
}

/**
 * Compute a weight in [0.05, 1.0] for a strategy's current-cycle signal.
 */
function computeWeight(perf, regimeCode) {
  if (!perf || !perf.trades) {
    return CONFIG.UNTESTED_WEIGHT;
  }

  if (perf.flagged) {
    return CONFIG.FLAGGED_WEIGHT;
  }

  let wr = effectiveWinRate(perf);

  const regimePerf = regimeCode ? perf.byRegime?.[regimeCode] : null;
  if (regimePerf && regimePerf.trades >= CONFIG.MIN_REGIME_SAMPLES) {
    wr = (wr * CONFIG.WEIGHT_BLEND_OVERALL_VS_REGIME)
       + (regimePerf.winRate * (1 - CONFIG.WEIGHT_BLEND_OVERALL_VS_REGIME));
  }

  const recent = (typeof perf.recentWinRate === 'number') ? perf.recentWinRate : wr;
  wr = (wr * CONFIG.WEIGHT_BLEND_OVERALL_VS_RECENT)
     + (recent * (1 - CONFIG.WEIGHT_BLEND_OVERALL_VS_RECENT));

  const raw = (wr - CONFIG.WEIGHT_BASE_OFFSET) * CONFIG.WEIGHT_SCALE;

  return Math.max(CONFIG.WEIGHT_FLOOR, Math.min(CONFIG.WEIGHT_CEILING, raw));
}

/**
 * Signal quality factor — how much to trust THIS specific signal from
 * this strategy this cycle.
 */
function signalConfidenceFactor(signal) {
  if (!signal || typeof signal.confidence !== 'number') return 0.5;
  return Math.max(0.30, Math.min(1.0, signal.confidence / 75));
}

/**
 * Normalize signal to a consistent internal shape.
 */
function normalizeSignal(raw, strategyName) {
  if (!raw) return null;
  const side = String(raw.side || '').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') return null;
  return {
    setupName: strategyName,
    side,
    entry: Number(raw.entryPrice) || null,
    stop: Number(raw.stopLoss) || null,
    target: Number(raw.takeProfit) || null,
    confidence: Number(raw.confidence) || 50,
    reason: raw.reason || '',
  };
}

/**
 * [FIX-RN1] Compute consensus confidence by blending the anchor's
 * current signal strength with its historical edge, weighted by how
 * much history the anchor actually has.
 *
 * Examples (with 2 agreeing strategies → +5 bonus):
 *   Untested anchor, signal conf=73 → 0.80×0.73 + 0.20×0.50 + 0.05 = 73%
 *   Untested anchor, signal conf=67 → 0.80×0.67 + 0.20×0.50 + 0.05 = 69%
 *   Tested anchor (10 trades, 65%), signal conf=70 → 0.25×0.70 + 0.75×0.65 + 0.05 ≈ 71%
 *   Tested anchor (40 trades, 70%), signal conf=55 → 0.70×0.70 + 0.30×0.55 + 0.05 ≈ 71%
 *
 * @returns {{confidence:number, breakdown:object}}
 */
function computeConsensusConfidence(anchorRow, agreeingRows) {
  if (!anchorRow) return { confidence: 0, breakdown: null };

  const trades = anchorRow.trades || 0;
  const signalConf = (anchorRow.signal?.confidence ?? 60) / 100;   // typically 0.60-0.90
  const historyConf = anchorRow.effectiveWinRate ?? 0.5;           // 0.5 for untested

  // Blend weight ramps from floor (untested) to ceiling (seasoned) over
  // CONF_HIST_WEIGHT_RAMP_TRADES trades.
  const ramp = Math.min(1, trades / CONFIG.CONF_HIST_WEIGHT_RAMP_TRADES);
  const histWeight = CONFIG.CONF_HIST_WEIGHT_FLOOR
    + ramp * (CONFIG.CONF_HIST_WEIGHT_CEIL - CONFIG.CONF_HIST_WEIGHT_FLOOR);
  const sigWeight = 1 - histWeight;

  const baseConf = sigWeight * signalConf + histWeight * historyConf;

  // Agreement bonus — capped tighter for fresh strategies so an untested
  // strategy can't accidentally report 90% just because many others align.
  const agreeBonusRamp = Math.min(1, trades / CONFIG.CONF_AGREEMENT_BONUS_RAMP_TRADES);
  const maxAgreementBonus = CONFIG.CONF_MAX_AGREEMENT_BONUS_FRESH
    + agreeBonusRamp * (CONFIG.CONF_MAX_AGREEMENT_BONUS_SEASONED - CONFIG.CONF_MAX_AGREEMENT_BONUS_FRESH);
  const rawAgreementBonus = Math.max(0, (agreeingRows.length - 1)) * CONFIG.CONFIDENCE_BOOST_PER_AGREE;
  const agreementBonus = Math.min(maxAgreementBonus, rawAgreementBonus) / 100;

  const raw = (baseConf + agreementBonus) * 100;
  const confidence = Math.round(Math.max(CONFIG.MIN_CONFIDENCE, Math.min(CONFIG.MAX_CONFIDENCE, raw)));

  return {
    confidence,
    breakdown: {
      signalConfidence: Math.round(signalConf * 100),
      historicalEdge: Math.round(historyConf * 100),
      historyTrades: trades,
      signalWeight: Number(sigWeight.toFixed(2)),
      historyWeight: Number(histWeight.toFixed(2)),
      baseConfidence: Math.round(baseConf * 100),
      agreementBonus: Math.round(agreementBonus * 100),
      agreeingCount: agreeingRows.length,
      maxAgreementBonus: Math.round(maxAgreementBonus),
      finalConfidence: confidence,
    },
  };
}

// ========================================================================
// StrategyRanker
// ========================================================================
class StrategyRanker {
  constructor(options = {}) {
    this._cache = new Map();
    this._cacheTTL = options.cacheTTL || CONFIG.CACHE_TTL_MS;
    this._strategyNames = options.strategies || null;
  }

  async rank(state, symbol, options = {}) {
    const timeframe = options.timeframe || 'M5';
    const product = options.product || 'deriv_cfd';
    const forceRefresh = !!options.forceRefresh;
    const cacheKey = `${symbol}::${timeframe}`;

    // ---- Cache check ----
    if (!forceRefresh) {
      const cached = this._cache.get(cacheKey);
      if (cached && (Date.now() - cached.at) < this._cacheTTL) {
        // [FIX-RN4] Deep clone so downstream mutation cannot corrupt cache.
        return { ...JSON.parse(JSON.stringify(cached.consensus)), cached: true };
      }
    }

    const t0 = Date.now();
    const regimeCode = state?.regime?.code || 'NEUTRAL';

    let performanceMap;
    try {
      performanceMap = await StrategyPerformance.loadForSymbol(symbol);
    } catch (err) {
      logger.warn(`[StrategyRanker] Load performance failed for ${symbol}: ${err.message}`);
      performanceMap = new Map();
    }

    const allStrategyNames = Object.keys(strategyEngine.STRATEGIES || {});
    const namesToRun = (this._strategyNames || allStrategyNames)
      .filter(n => !CONFIG.SKIP_STRATEGIES.includes(n));

    const rawSignals = await Promise.all(
      namesToRun.map(async (name) => {
        try {
          const raw = await strategyEngine.generateSignal(symbol, name, { timeframe, product });
          return { name, raw };
        } catch (err) {
          logger.warn(`[StrategyRanker] Strategy '${name}' threw for ${symbol}: ${err.message}`);
          return { name, raw: null, error: err.message };
        }
      })
    );

    const rows = [];
    let buyWeight = 0, sellWeight = 0;
    let buyCount = 0, sellCount = 0;
    let activeCount = 0;
    let silentCount = 0;
    let flaggedCount = 0;

    for (const { name, raw } of rawSignals) {
      const perf = performanceMap.get(name);
      const weight = computeWeight(perf, regimeCode);
      const effWR = effectiveWinRate(perf);
      const effR = effectiveAvgR(perf);
      const regimePerf = regimeCode ? perf?.byRegime?.[regimeCode] : null;
      const regimeWR = (regimePerf && regimePerf.trades >= CONFIG.MIN_REGIME_SAMPLES)
        ? regimePerf.winRate : null;

      const signal = normalizeSignal(raw, name);

      const row = {
        name,
        signal,
        signalSide: signal ? signal.side : null,
        weight,
        effectiveWinRate: effWR,
        regimeWinRate: regimeWR,
        trades: perf?.trades || 0,
        winRate: perf?.winRate ?? 0.5,
        recentWinRate: perf?.recentWinRate ?? 0.5,
        avgR: effR,
        flagged: !!perf?.flagged,
        status: 'SILENT',
      };

      if (perf?.flagged) {
        flaggedCount++;
        row.status = 'FLAGGED';
        silentCount++;
        // [FIX-RN2] Exclude flagged strategies from all consensus aggregation.
        // Previously the row still carried signalSide, which leaked it into
        // the `agreeing` array even though its weight was excluded from
        // buyWeight/sellWeight. Nulling here makes it behave like SILENT for
        // all downstream filters (agreeing/conflicting/status updates).
        row.signalSide = null;
      } else if (!signal) {
        silentCount++;
        row.status = 'SILENT';
      } else {
        activeCount++;
        const contribWeight = weight * signalConfidenceFactor(signal);
        row.contributionWeight = contribWeight;
        if (signal.side === 'BUY') {
          buyWeight += contribWeight;
          buyCount++;
        } else {
          sellWeight += contribWeight;
          sellCount++;
        }
      }

      rows.push(row);
    }

    // ---- Determine consensus direction ----
    const bothAboveConflict = buyWeight >= CONFIG.CONFLICT_MIN_WEIGHT
                            && sellWeight >= CONFIG.CONFLICT_MIN_WEIGHT;

    let action = 'NEUTRAL';
    let direction = null;
    let anchorRow = null;
    let agreeing = [];
    let conflicting = [];

    if (bothAboveConflict) {
      action = 'CONFLICT';
      direction = null;
      for (const row of rows) {
        if (row.signalSide) row.status = 'CONFLICT';
      }
      conflicting = rows.filter(r => r.signalSide).map(r => r.name);
    } else if (buyWeight >= CONFIG.MIN_CONSENSUS_WEIGHT && buyWeight > sellWeight) {
      action = 'SIGNAL';
      direction = 'BUY';
      const buyRows = rows.filter(r => r.signalSide === 'BUY')
                          .sort((a, b) => (b.contributionWeight || 0) - (a.contributionWeight || 0));
      anchorRow = buyRows[0];
      agreeing = buyRows.map(r => r.name);
      conflicting = rows.filter(r => r.signalSide === 'SELL').map(r => r.name);
      for (const row of rows) {
        if (row.signalSide === 'BUY') row.status = 'AGREE';
        else if (row.signalSide === 'SELL') row.status = 'CONFLICT';
      }
    } else if (sellWeight >= CONFIG.MIN_CONSENSUS_WEIGHT && sellWeight > buyWeight) {
      action = 'SIGNAL';
      direction = 'SELL';
      const sellRows = rows.filter(r => r.signalSide === 'SELL')
                           .sort((a, b) => (b.contributionWeight || 0) - (a.contributionWeight || 0));
      anchorRow = sellRows[0];
      agreeing = sellRows.map(r => r.name);
      conflicting = rows.filter(r => r.signalSide === 'BUY').map(r => r.name);
      for (const row of rows) {
        if (row.signalSide === 'SELL') row.status = 'AGREE';
        else if (row.signalSide === 'BUY') row.status = 'CONFLICT';
      }
    } else {
      action = 'NEUTRAL';
      direction = null;
      for (const row of rows) {
        if (row.signalSide) row.status = 'BELOW_THRESHOLD';
      }
    }

    // ---- Require either 2+ agreeing OR one very strong ----
    if (action === 'SIGNAL') {
      const totalDirWeight = direction === 'BUY' ? buyWeight : sellWeight;
      const count = direction === 'BUY' ? buyCount : sellCount;
      const passes = count >= 2 || totalDirWeight >= CONFIG.SINGLE_STRATEGY_STRONG_WEIGHT;
      if (!passes) {
        action = 'NEUTRAL';
        direction = null;
        anchorRow = null;
        for (const row of rows) {
          if (row.status === 'AGREE' || row.status === 'CONFLICT') row.status = 'BELOW_THRESHOLD';
        }
        agreeing = [];
        conflicting = [];
      }
    }

    // ---- [FIX-RN1] Compute final confidence ----
    let confidence = 0;
    let confidenceBreakdown = null;
    let anchorSignal = null;
    let anchorStrategy = null;
    if (action === 'SIGNAL' && anchorRow) {
      const agreeingRows = rows.filter(r => r.signalSide === direction);
      const result = computeConsensusConfidence(anchorRow, agreeingRows);
      confidence = result.confidence;
      confidenceBreakdown = result.breakdown;
      anchorSignal = anchorRow.signal;
      anchorStrategy = anchorRow.name;
    }

    // ---- Reason strings ----
    const reasons = [];
    if (action === 'SIGNAL') {
      reasons.push(`${agreeing.length} strateg${agreeing.length === 1 ? 'y' : 'ies'} agree on ${direction}: ${agreeing.join(', ')}`);
      if (conflicting.length > 0) reasons.push(`Ignoring opposing: ${conflicting.join(', ')}`);
      if (flaggedCount > 0) reasons.push(`${flaggedCount} strategy(ies) excluded (underperforming)`);
      reasons.push(
        `Anchor: ${anchorStrategy} (signal ${anchorRow.signal.confidence}%, ` +
        `${(anchorRow.effectiveWinRate * 100).toFixed(0)}% historical win rate, ` +
        `${anchorRow.trades} trades)`
      );
    } else if (action === 'CONFLICT') {
      reasons.push(`Conflict: BUY from [${rows.filter(r => r.signalSide === 'BUY').map(r => r.name).join(', ')}] vs SELL from [${rows.filter(r => r.signalSide === 'SELL').map(r => r.name).join(', ')}]`);
    } else {
      reasons.push(`No consensus: ${activeCount} strategy(ies) fired but total weight ${(direction === 'BUY' ? buyWeight : sellWeight).toFixed(2)} is below threshold`);
    }

    // ---- Sort rows for dashboard ----
    const statusOrder = { AGREE: 0, CONFLICT: 1, BELOW_THRESHOLD: 2, SILENT: 3, FLAGGED: 4 };
    const sortedRows = [...rows].sort((a, b) => {
      const so = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
      if (so !== 0) return so;
      return (b.contributionWeight || b.weight || 0) - (a.contributionWeight || a.weight || 0);
    });

    // ---- [FIX-RN5] Consensus object with breakdown ----
    const consensus = {
      symbol,
      timeframe,
      regime: regimeCode,
      evaluatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
      cached: false,
      strategies: sortedRows,
      consensus: {
        action,
        direction,
        confidence,
        confidenceBreakdown,
        buyWeight: Number(buyWeight.toFixed(3)),
        sellWeight: Number(sellWeight.toFixed(3)),
        buyCount,
        sellCount,
        activeCount,
        silentCount,
        flaggedCount,
        totalStrategies: rows.length,
        anchorStrategy,
        anchorSignal,
        agreeing,
        conflicting,
        reasons,
      },
    };

    // ---- Cache ----
    this._cache.set(cacheKey, { consensus, at: Date.now() });

    // ---- [FIX-RN3] Richer log ----
    if (action === 'SIGNAL') {
      const b = confidenceBreakdown;
      logger.info(
        `[StrategyRanker] ${symbol} ${timeframe}: ${direction} ` +
        `conf=${confidence}% ` +
        `[sig=${b.signalConfidence} hist=${b.historicalEdge} n=${b.historyTrades} ` +
        `+${b.agreementBonus}agree] ` +
        `anchor=${anchorStrategy} ` +
        `agree=[${agreeing.join(',')}] ` +
        `(buyW=${buyWeight.toFixed(2)} sellW=${sellWeight.toFixed(2)}) ` +
        `elapsed=${consensus.elapsedMs}ms`
      );
    } else if (action === 'CONFLICT') {
      logger.info(
        `[StrategyRanker] ${symbol} ${timeframe}: CONFLICT ` +
        `(buyW=${buyWeight.toFixed(2)} sellW=${sellWeight.toFixed(2)}) ` +
        `elapsed=${consensus.elapsedMs}ms`
      );
    } else {
      logger.debug(
        `[StrategyRanker] ${symbol} ${timeframe}: NEUTRAL ` +
        `(active=${activeCount} buyW=${buyWeight.toFixed(2)} sellW=${sellWeight.toFixed(2)}) ` +
        `elapsed=${consensus.elapsedMs}ms`
      );
    }

    return consensus;
  }

  getLastConsensus(symbol, timeframe = 'M5') {
    const cached = this._cache.get(`${symbol}::${timeframe}`);
    return cached ? JSON.parse(JSON.stringify(cached.consensus)) : null;
  }

  getAllCachedConsensus() {
    const out = {};
    for (const [key, entry] of this._cache) {
      const c = entry.consensus;
      out[key] = {
        ...c.consensus,
        symbol: c.symbol,
        timeframe: c.timeframe,
        regime: c.regime,
        evaluatedAt: c.evaluatedAt,
        ageMs: Date.now() - entry.at,
      };
    }
    return out;
  }

  clearCache() {
    this._cache.clear();
  }
}

// ========================================================================
// Singleton export
// ========================================================================
const ranker = new StrategyRanker();
module.exports = ranker;
module.exports.StrategyRanker = StrategyRanker;
module.exports.CONFIG = CONFIG;
module.exports._internal = {
  effectiveWinRate,
  effectiveAvgR,
  computeWeight,
  signalConfidenceFactor,
  normalizeSignal,
  computeConsensusConfidence, // [FIX-RN1] exposed for testing
};
