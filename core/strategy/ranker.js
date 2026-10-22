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
  // Meta-strategies that combine others — skip to avoid double-counting.
  // If you want to test weightedvote as a standalone strategy, remove it
  // from this list. It's skipped by default.
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
 *
 * Weight reflects historical edge. Higher weight = stronger signal.
 *
 * @param {Object} perf        — StrategyPerformance doc (or undefined)
 * @param {string} regimeCode  — current regime
 * @returns {number}           — weight 0.05 to 1.0
 */
function computeWeight(perf, regimeCode) {
  // Untested — baseline small weight
  if (!perf || !perf.trades) {
    return CONFIG.UNTESTED_WEIGHT;
  }

  // Underperforming — near-excluded
  if (perf.flagged) {
    return CONFIG.FLAGGED_WEIGHT;
  }

  // Start from effective win rate
  let wr = effectiveWinRate(perf);

  // Regime-specific adjustment
  const regimePerf = regimeCode ? perf.byRegime?.[regimeCode] : null;
  if (regimePerf && regimePerf.trades >= CONFIG.MIN_REGIME_SAMPLES) {
    wr = (wr * CONFIG.WEIGHT_BLEND_OVERALL_VS_REGIME)
       + (regimePerf.winRate * (1 - CONFIG.WEIGHT_BLEND_OVERALL_VS_REGIME));
  }

  // Recent-performance blend — catches degradation faster than cumulative
  const recent = (typeof perf.recentWinRate === 'number') ? perf.recentWinRate : wr;
  wr = (wr * CONFIG.WEIGHT_BLEND_OVERALL_VS_RECENT)
     + (recent * (1 - CONFIG.WEIGHT_BLEND_OVERALL_VS_RECENT));

  // Transform win rate into weight.
  // 0.45 → floor, 0.55 → ~0.25, 0.65 → ~0.50, 0.75 → ~0.75, 0.85 → ceiling
  const raw = (wr - CONFIG.WEIGHT_BASE_OFFSET) * CONFIG.WEIGHT_SCALE;

  return Math.max(CONFIG.WEIGHT_FLOOR, Math.min(CONFIG.WEIGHT_CEILING, raw));
}

/**
 * Signal quality factor — how much to trust THIS specific signal from
 * this strategy this cycle. A strong strategy with a marginal signal
 * contributes less than the same strategy with a clean signal.
 *
 * @param {Object} signal — strategy output { side, confidence, ... }
 * @returns {number}      — 0.3 to 1.0 multiplier
 */
function signalConfidenceFactor(signal) {
  if (!signal || typeof signal.confidence !== 'number') return 0.5;
  // Signal confidence is typically 60-90. 75 is "solid".
  // Below 50 → 0.5x, above 85 → 1.0x
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

// ========================================================================
// StrategyRanker
// ========================================================================
class StrategyRanker {
  constructor(options = {}) {
    // symbol::timeframe -> { consensus, at }
    this._cache = new Map();
    this._cacheTTL = options.cacheTTL || CONFIG.CACHE_TTL_MS;
    // Override the strategy list (for testing or selective disabling)
    this._strategyNames = options.strategies || null;
  }

  /**
   * Run every strategy for the symbol, rank by historical edge, produce
   * weighted consensus.
   *
   * @param {Object} state    — market state from deepMarketState.compute()
   * @param {string} symbol   — canonical symbol 'EURUSD'
   * @param {Object} options  — { timeframe, product, forceRefresh }
   * @returns {Promise<Object>} — consensus object (see structure below)
   */
  async rank(state, symbol, options = {}) {
    const timeframe = options.timeframe || 'M5';
    const product = options.product || 'deriv_cfd';
    const forceRefresh = !!options.forceRefresh;
    const cacheKey = `${symbol}::${timeframe}`;

    // ---- Cache check ----
    if (!forceRefresh) {
      const cached = this._cache.get(cacheKey);
      if (cached && (Date.now() - cached.at) < this._cacheTTL) {
        return { ...cached.consensus, cached: true };
      }
    }

    const t0 = Date.now();
    const regimeCode = state?.regime?.code || 'NEUTRAL';

    // ---- Load performance for this symbol ----
    let performanceMap;
    try {
      performanceMap = await StrategyPerformance.loadForSymbol(symbol);
    } catch (err) {
      logger.warn(`[StrategyRanker] Load performance failed for ${symbol}: ${err.message}`);
      performanceMap = new Map();
    }

    // ---- Determine which strategies to run ----
    const allStrategyNames = Object.keys(strategyEngine.STRATEGIES || {});
    const namesToRun = (this._strategyNames || allStrategyNames)
      .filter(n => !CONFIG.SKIP_STRATEGIES.includes(n));

    // ---- Run all strategies in parallel ----
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

    // ---- Build per-strategy rows ----
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
        status: 'SILENT',  // updated below
      };

      if (perf?.flagged) {
        flaggedCount++;
        row.status = 'FLAGGED';
        silentCount++;
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
      // Mark rows in both directions as conflicting
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
      // Below threshold on both sides — no trade
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

    // ---- Compute final confidence ----
    let confidence = 0;
    let anchorSignal = null;
    let anchorStrategy = null;
    if (action === 'SIGNAL' && anchorRow) {
      const baseConf = (anchorRow.effectiveWinRate || 0.5) * 100;
      const boost = Math.max(0, agreeing.length - 1) * CONFIG.CONFIDENCE_BOOST_PER_AGREE;
      confidence = Math.max(CONFIG.MIN_CONFIDENCE, Math.min(CONFIG.MAX_CONFIDENCE, baseConf + boost));
      confidence = Math.round(confidence);
      anchorSignal = anchorRow.signal;
      anchorStrategy = anchorRow.name;
    }

    // ---- Build reason strings for dashboard ----
    const reasons = [];
    if (action === 'SIGNAL') {
      reasons.push(`${agreeing.length} strateg${agreeing.length === 1 ? 'y' : 'ies'} agree on ${direction}: ${agreeing.join(', ')}`);
      if (conflicting.length > 0) reasons.push(`Ignoring opposing: ${conflicting.join(', ')}`);
      if (flaggedCount > 0) reasons.push(`${flaggedCount} strategy(ies) excluded (underperforming)`);
      reasons.push(`Anchor: ${anchorStrategy} (${(anchorRow.effectiveWinRate * 100).toFixed(0)}% historical win rate, ${anchorRow.trades} trades)`);
    } else if (action === 'CONFLICT') {
      reasons.push(`Conflict: BUY from [${rows.filter(r => r.signalSide === 'BUY').map(r => r.name).join(', ')}] vs SELL from [${rows.filter(r => r.signalSide === 'SELL').map(r => r.name).join(', ')}]`);
    } else {
      reasons.push(`No consensus: ${activeCount} strategy(ies) fired but total weight ${(direction === 'BUY' ? buyWeight : sellWeight).toFixed(2)} is below threshold`);
    }

    // ---- Sort rows for dashboard: AGREE, CONFLICT, BELOW_THRESHOLD, SILENT, FLAGGED ----
    const statusOrder = { AGREE: 0, CONFLICT: 1, BELOW_THRESHOLD: 2, SILENT: 3, FLAGGED: 4 };
    const sortedRows = [...rows].sort((a, b) => {
      const so = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
      if (so !== 0) return so;
      // Within same status, sort by weight desc
      return (b.contributionWeight || b.weight || 0) - (a.contributionWeight || a.weight || 0);
    });

    // ---- Assemble consensus object ----
    const consensus = {
      symbol,
      timeframe,
      regime: regimeCode,
      evaluatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
      cached: false,
      strategies: sortedRows,
      consensus: {
        action,                 // 'SIGNAL' | 'NEUTRAL' | 'CONFLICT'
        direction,              // 'BUY' | 'SELL' | null
        confidence,             // 0-100
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

    if (action === 'SIGNAL') {
      logger.info(
        `[StrategyRanker] ${symbol} ${timeframe}: ${direction} ` +
        `conf=${confidence}% anchor=${anchorStrategy} ` +
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

  /**
   * Get the most recent cached consensus for a symbol without running
   * strategies. Returns null if no cache.
   */
  getLastConsensus(symbol, timeframe = 'M5') {
    const cached = this._cache.get(`${symbol}::${timeframe}`);
    return cached ? cached.consensus : null;
  }

  /**
   * Return all cached consensus objects — for /debug/strategies.
   */
  getAllCachedConsensus() {
    const out = {};
    for (const [key, entry] of this._cache) {
      out[key] = {
        ...entry.consensus.consensus,
        symbol: entry.consensus.symbol,
        timeframe: entry.consensus.timeframe,
        regime: entry.consensus.regime,
        evaluatedAt: entry.consensus.evaluatedAt,
        ageMs: Date.now() - entry.at,
      };
    }
    return out;
  }

  /**
   * Clear cache — for testing or after config changes.
   */
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
};
