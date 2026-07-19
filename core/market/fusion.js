// core/signal/fusion.js
// RTS AI Fusion Engine
// Purpose: Combine multiple independent strategy signals into a single high‑quality decision.
// Answers: "Given all the evidence and the current regime, what should we do and why?"

const EventEmitter = require('events');
const regimeEngine = require('../market/regime');
const { STRATEGIES, generateSignal } = require('../strategy/engine');
const { PerformanceLearner } = require('../analytics/performanceSuite');
const accountService = require('../portfolio/accountService');
const { validateTrade } = require('../risk/manager');
const logger = require('../../infrastructure/logger') || console;

// Configuration – all tunable via environment variables
const CONFIG = {
  MIN_CONFIDENCE: parseInt(process.env.FUSION_MIN_CONFIDENCE) || 60,
  MIN_AGREEMENT: parseFloat(process.env.FUSION_MIN_AGREEMENT) || 0.3, // 30% of weighted votes
  COOLDOWN_MS: parseInt(process.env.FUSION_COOLDOWN) || 30000,
  ENABLE_DISSENT_ANALYSIS: process.env.FUSION_ENABLE_DISSENT !== 'false',
  DEFAULT_WEIGHT: 0.1,
};

/**
 * AI Fusion Engine
 * - Listens to regime changes.
 * - On each new regime, evaluates all strategies.
 * - Computes a weighted vote.
 * - Produces a final signal with explanation.
 * - Emits a `decision` event.
 */
class FusionEngine extends EventEmitter {
  constructor() {
    super();
    this._lastDecision = new Map(); // symbol -> decision
    this._cooldownMap = new Map(); // symbol -> last decision timestamp
    this._performanceLearner = new PerformanceLearner();
    this._strategyWeights = {}; // will be loaded from learner

    // Listen to regime changes
    regimeEngine.on('regime', async (regime) => {
      await this._evaluate(regime);
    });

    logger.info('[FusionEngine] Initialized.');
  }

  /**
   * Load performance history and initialize strategy weights.
   */
  async start() {
    await this._performanceLearner.loadHistory();
    // Initialize weights from the learner or use defaults
    const defaultWeights = {};
    for (const name of Object.keys(STRATEGIES)) {
      defaultWeights[name] = CONFIG.DEFAULT_WEIGHT;
    }
    const learnedWeights = this._performanceLearner.strategyWeights || {};
    // Combine: if a strategy has learned weight, use it; otherwise default
    this._strategyWeights = { ...defaultWeights };
    for (const [name, data] of Object.entries(learnedWeights)) {
      if (this._strategyWeights[name] !== undefined) {
        this._strategyWeights[name] = data.weight || CONFIG.DEFAULT_WEIGHT;
      }
    }
    // Normalize weights
    this._normalizeWeights();
    logger.info('[FusionEngine] Started. Weights:', this._strategyWeights);
  }

  /**
   * Normalize strategy weights so they sum to 1.
   */
  _normalizeWeights() {
    const total = Object.values(this._strategyWeights).reduce((a, b) => a + b, 0);
    if (total === 0) return;
    for (const key of Object.keys(this._strategyWeights)) {
      this._strategyWeights[key] /= total;
    }
  }

  /**
   * Main evaluation method – called on each regime event.
   */
  async _evaluate(regime) {
    try {
      const symbol = regime.symbol;
      const now = Date.now();

      // Cooldown check (don't generate too frequent decisions)
      if (this._cooldownMap.has(symbol)) {
        const last = this._cooldownMap.get(symbol);
        if (now - last < CONFIG.COOLDOWN_MS) {
          return; // still in cooldown
        }
      }

      // Get all strategy signals for this symbol
      const signals = await this._collectSignals(symbol, regime);
      if (!signals || signals.length === 0) {
        logger.debug(`[FusionEngine] No signals from any strategy for ${symbol}`);
        return;
      }

      // Compute weighted vote
      const result = this._computeWeightedVote(signals, regime);

      // If no clear decision, skip
      if (!result || result.decision === 'NO_TRADE') {
        this._cooldownMap.set(symbol, now);
        return;
      }

      // Validate against risk and portfolio
      const valid = await this._validateDecision(result, symbol);
      if (!valid) {
        logger.info(`[FusionEngine] Decision rejected by risk: ${result.decision} ${symbol}`);
        return;
      }

      // Emit final decision
      this._lastDecision.set(symbol, result);
      this._cooldownMap.set(symbol, now);
      this.emit('decision', result);

      logger.info(`[FusionEngine] 🔥 DECISION: ${result.decision} ${symbol} confidence ${result.confidence}%`);

    } catch (err) {
      logger.error('[FusionEngine] Evaluation error:', err.message);
    }
  }

  /**
   * Collect signals from all strategies for the current symbol and regime.
   * Uses the existing generateSignal function but with a timeout.
   */
  async _collectSignals(symbol, regime) {
    const signals = [];
    const timeframe = 'M5'; // could be configurable

    // For each strategy, call generateSignal
    for (const [name, fn] of Object.entries(STRATEGIES)) {
      try {
        // Skip strategies that are not compatible with the current regime
        const compatible = regimeEngine.isStrategyCompatible(symbol, name);
        if (!compatible) {
          logger.debug(`[FusionEngine] Strategy ${name} is incompatible with current regime for ${symbol}`);
          continue;
        }

        // Generate signal (this fetches candles and runs the strategy)
        // We could pass the current candle to avoid re‑fetching, but we keep it simple.
        const signal = await generateSignal(symbol, name, { timeframe });
        if (signal) {
          // Adjust confidence by the performance learner's bias
          const bias = this._performanceLearner.confidenceBias[name] || 0;
          signal.confidence = Math.min(100, Math.max(0, signal.confidence + bias));
          signals.push({
            strategy: name,
            signal,
            // Get weight (already normalized)
            weight: this._strategyWeights[name] || CONFIG.DEFAULT_WEIGHT,
          });
        }
      } catch (err) {
        logger.warn(`[FusionEngine] Strategy ${name} failed:`, err.message);
      }
    }
    return signals;
  }

  /**
   * Compute a weighted vote from all strategy signals.
   * Returns a decision object or null.
   */
  _computeWeightedVote(signals, regime) {
    let buyWeight = 0, sellWeight = 0, totalWeight = 0;
    let avgSL = 0, avgTP = 0, avgConf = 0;
    const contributing = [];
    const dissenting = [];

    for (const item of signals) {
      const { strategy, signal, weight } = item;
      if (!signal) continue;

      totalWeight += weight;
      if (signal.side === 'BUY') {
        buyWeight += weight;
        contributing.push({ strategy, side: 'BUY', confidence: signal.confidence });
      } else if (signal.side === 'SELL') {
        sellWeight += weight;
        contributing.push({ strategy, side: 'SELL', confidence: signal.confidence });
      }

      // Average SL/TP and confidence (weighted)
      if (signal.stopLoss) avgSL += signal.stopLoss * weight;
      if (signal.takeProfit) avgTP += signal.takeProfit * weight;
      avgConf += signal.confidence * weight;
    }

    if (totalWeight === 0) return null;

    // Calculate weighted percentages
    const buyScore = (buyWeight / totalWeight) * 100;
    const sellScore = (sellWeight / totalWeight) * 100;

    // Determine decision side
    let side = null;
    let confidence = 0;

    // Require a minimum agreement (buyWeight or sellWeight > MIN_AGREEMENT of total)
    if (buyScore > CONFIG.MIN_AGREEMENT * 100 && buyScore > sellScore) {
      side = 'BUY';
      confidence = buyScore;
    } else if (sellScore > CONFIG.MIN_AGREEMENT * 100 && sellScore > buyScore) {
      side = 'SELL';
      confidence = sellScore;
    } else {
      // No clear majority
      // But if buyScore and sellScore are both > 40, it's mixed; we might still take a signal if confidence is high.
      if (buyScore > 45 && sellScore > 45) {
        // Conflict – we could decide based on regime preference.
        // For example, in a trending regime, prefer the trend-following votes.
        // We'll use the most popular side among top strategies.
        logger.debug(`[FusionEngine] Conflict: BUY ${buyScore}%, SELL ${sellScore}% for ${regime.symbol}`);
        // Fallback: use the side that has higher total weight from high-confidence strategies.
        // We'll re-evaluate by weighting confidence.
        const weightedBuy = signals
          .filter(s => s.signal?.side === 'BUY')
          .reduce((sum, s) => sum + s.weight * s.signal.confidence, 0);
        const weightedSell = signals
          .filter(s => s.signal?.side === 'SELL')
          .reduce((sum, s) => sum + s.weight * s.signal.confidence, 0);
        if (weightedBuy > weightedSell) side = 'BUY';
        else if (weightedSell > weightedBuy) side = 'SELL';
        else return null;
        confidence = Math.max(weightedBuy, weightedSell) / totalWeight * 100;
      } else {
        return null;
      }
    }

    // Compute final confidence (cap at 100)
    confidence = Math.min(100, confidence + (regime.confidence - 50) * 0.5);
    if (confidence < CONFIG.MIN_CONFIDENCE) return null;

    // Calculate final SL/TP and lot size
    avgSL = avgSL / totalWeight;
    avgTP = avgTP / totalWeight;

    // If SL/TP not set, use ATR-based defaults
    const atr = regime.metadata.atrPercent * 10000; // approx ATR in pips
    const entryPrice = signals.reduce((a, s) => a + s.signal.entryPrice, 0) / signals.length;

    // Build the decision object
    return {
      symbol: regime.symbol,
      decision: side,
      entryPrice: entryPrice,
      stopLoss: avgSL || (side === 'BUY' ? entryPrice - atr * 0.5 : entryPrice + atr * 0.5),
      takeProfit: avgTP || (side === 'BUY' ? entryPrice + atr * 1.5 : entryPrice - atr * 1.5),
      confidence: Math.round(confidence),
      recommendedLotSize: 0, // will be computed in validation
      reason: this._buildReason(contributing, buyScore, sellScore, regime),
      contributingStrategies: contributing,
      dissenters: dissenting,
      regime: regime.regime,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Build a human‑readable reason for the decision.
   */
  _buildReason(contributing, buyScore, sellScore, regime) {
    const direction = buyScore > sellScore ? 'BUY' : 'SELL';
    const majorContributors = contributing
      .filter(c => c.side === direction)
      .slice(0, 3)
      .map(c => c.strategy)
      .join(', ');
    const confidence = Math.max(buyScore, sellScore);
    return `Decision: ${direction} (${confidence.toFixed(0)}% confidence). ` +
           `Major contributors: ${majorContributors || 'none'}. ` +
           `Regime: ${regime.regime} (${regime.confidence}%). ` +
           `Buy support: ${buyScore.toFixed(0)}%, Sell support: ${sellScore.toFixed(0)}%.`;
  }

  /**
   * Validate the decision against risk and portfolio constraints.
   */
  async _validateDecision(decision, symbol) {
    try {
      // Compute lot size using risk manager
      const account = await accountService.getAccount(process.env.DEFAULT_TRADING_PRODUCT || 'mt5');
      const balance = parseFloat(account.balance);
      const riskPct = parseFloat(process.env.RISK_PER_TRADE) || 1;
      const stopDistance = Math.abs(decision.stopLoss - decision.entryPrice);
      if (stopDistance === 0) return false;

      // Estimate lot size – use the existing function
      const { calculatePositionSize } = require('../strategy/engine');
      const lotSize = calculatePositionSize(
        balance,
        riskPct,
        decision.stopLoss,
        decision.entryPrice,
        symbol,
        process.env.DEFAULT_TRADING_PRODUCT || 'mt5'
      );
      decision.recommendedLotSize = lotSize;

      // Validate trade with risk manager
      const validation = await validateTrade(symbol, decision.decision, lotSize);
      if (!validation.approved) {
        logger.debug(`[FusionEngine] Risk validation failed: ${validation.reason}`);
        return false;
      }

      // Additional checks: correlation, max positions, daily loss, etc.
      // Those are already included in validateTrade.

      return true;
    } catch (err) {
      logger.error('[FusionEngine] Validation error:', err.message);
      return false;
    }
  }

  /**
   * Get the last decision for a symbol.
   */
  getLastDecision(symbol) {
    return this._lastDecision.get(symbol) || null;
  }

  /**
   * Update strategy weights based on performance (called by the learner).
   */
  updateWeights(newWeights) {
    for (const [name, weight] of Object.entries(newWeights)) {
      if (this._strategyWeights[name] !== undefined) {
        this._strategyWeights[name] = weight;
      }
    }
    this._normalizeWeights();
    logger.info('[FusionEngine] Weights updated:', this._strategyWeights);
  }
}

// Singleton
const fusionEngine = new FusionEngine();
module.exports = fusionEngine;
