// core/signal/fusion.js
// RTS AI Fusion Engine – Full version with market closure handling
// Purpose: Combine multiple independent strategy signals into a single high‑quality decision.
// Answers: "Given all the evidence and the current regime, what should we do and why?"

const EventEmitter = require('events');
const marketClosure = require('../market/closure');
const regimeEngine = require('../market/regime');
const { STRATEGIES, generateSignal } = require('../strategy/engine');
const { PerformanceLearner } = require('../analytics/performanceSuite');
const accountService = require('../portfolio/accountService');
const { validateTrade } = require('../risk/manager');
const logger = require('../../infrastructure/logger') || console;
// Optional modules – use if available, otherwise graceful fallback
let probabilityEngine = null;
let riskIntelligence = null;
let portfolioIntelligence = null;
let explainabilityEngine = null;

try {
  probabilityEngine = require('./probability');
} catch (e) { /* optional */ }
try {
  riskIntelligence = require('../risk/intelligence');
} catch (e) { /* optional */ }
try {
  portfolioIntelligence = require('../portfolio/intelligence');
} catch (e) { /* optional */ }
try {
  explainabilityEngine = require('../explainability/reason');
} catch (e) { /* optional */ }

// Configuration
const CONFIG = {
  MIN_CONFIDENCE: parseInt(process.env.FUSION_MIN_CONFIDENCE) || 60,
  MIN_AGREEMENT: parseFloat(process.env.FUSION_MIN_AGREEMENT) || 0.3,
  COOLDOWN_MS: parseInt(process.env.FUSION_COOLDOWN) || 30000,
  DEFAULT_WEIGHT: 0.1,
};

class FusionEngine extends EventEmitter {
  constructor() {
    super();
    this._lastDecision = new Map();
    this._cooldownMap = new Map();
    this._performanceLearner = new PerformanceLearner();
    this._strategyWeights = {};
    this._initialized = false;

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
    const defaultWeights = {};
    for (const name of Object.keys(STRATEGIES)) {
      defaultWeights[name] = CONFIG.DEFAULT_WEIGHT;
    }
    const learnedWeights = this._performanceLearner.strategyWeights || {};
    this._strategyWeights = { ...defaultWeights };
    for (const [name, data] of Object.entries(learnedWeights)) {
      if (this._strategyWeights[name] !== undefined) {
        this._strategyWeights[name] = data.weight || CONFIG.DEFAULT_WEIGHT;
      }
    }
    this._normalizeWeights();
    this._initialized = true;
    logger.info('[FusionEngine] Started. Weights:', this._strategyWeights);
  }

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

      // ---- MARKET CLOSURE CHECK ----
      const closure = marketClosure.isMarketOpen(symbol);
      if (!closure.isOpen) {
        logger.info(`[FusionEngine] Market closed for ${symbol}: ${closure.reason}`);
        this.emit('marketClosed', { symbol, reason: closure.reason, nextOpen: closure.nextOpen });
        return;
      }

      // Cooldown check
      if (this._cooldownMap.has(symbol)) {
        const last = this._cooldownMap.get(symbol);
        if (now - last < CONFIG.COOLDOWN_MS) {
          return;
        }
      }

      // Get all strategy signals
      const signals = await this._collectSignals(symbol, regime);
      if (!signals || signals.length === 0) {
        logger.debug(`[FusionEngine] No signals from any strategy for ${symbol}`);
        return;
      }

      // Compute weighted vote
      const result = this._computeWeightedVote(signals, regime);
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

      // ---- FINAL DECISION ----
      this._lastDecision.set(symbol, result);
      this._cooldownMap.set(symbol, now);
      this.emit('decision', result);

      // Also emit explanation if explainability module is available
      if (explainabilityEngine) {
        const context = {
          regime,
          probabilities: probabilityEngine ? probabilityEngine.getProbability(symbol) : null,
          contributingStrategies: result.contributingStrategies || [],
          dissentingStrategies: result.dissenters || [],
        };
        const explanation = explainabilityEngine.generateExplanation(result, context);
        this.emit('explanation', explanation);
      }

      logger.info(`[FusionEngine] 🔥 DECISION: ${result.decision} ${symbol} confidence ${result.confidence}%`);

    } catch (err) {
      logger.error('[FusionEngine] Evaluation error:', err.message);
    }
  }

  /**
   * Collect signals from all strategies.
   */
  async _collectSignals(symbol, regime) {
    const signals = [];
    const timeframe = 'M5';

    for (const [name, fn] of Object.entries(STRATEGIES)) {
      try {
        const compatible = regimeEngine.isStrategyCompatible(symbol, name);
        if (!compatible) continue;

        const signal = await generateSignal(symbol, name, { timeframe });
        if (signal) {
          const bias = this._performanceLearner.confidenceBias[name] || 0;
          signal.confidence = Math.min(100, Math.max(0, signal.confidence + bias));
          signals.push({
            strategy: name,
            signal,
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
   * Compute weighted vote and produce decision.
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
      if (signal.stopLoss) avgSL += signal.stopLoss * weight;
      if (signal.takeProfit) avgTP += signal.takeProfit * weight;
      avgConf += signal.confidence * weight;
    }

    if (totalWeight === 0) return null;

    const buyScore = (buyWeight / totalWeight) * 100;
    const sellScore = (sellWeight / totalWeight) * 100;

    let side = null;
    let confidence = 0;

    if (buyScore > CONFIG.MIN_AGREEMENT * 100 && buyScore > sellScore) {
      side = 'BUY';
      confidence = buyScore;
    } else if (sellScore > CONFIG.MIN_AGREEMENT * 100 && sellScore > buyScore) {
      side = 'SELL';
      confidence = sellScore;
    } else {
      // Conflict resolution: use weighted confidence
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
    }

    confidence = Math.min(100, confidence + (regime.confidence - 50) * 0.5);
    if (confidence < CONFIG.MIN_CONFIDENCE) return null;

    avgSL = avgSL / totalWeight;
    avgTP = avgTP / totalWeight;
    const entryPrice = signals.reduce((a, s) => a + s.signal.entryPrice, 0) / signals.length;

    return {
      symbol: regime.symbol,
      decision: side,
      entryPrice: entryPrice,
      stopLoss: avgSL || (side === 'BUY' ? entryPrice - 0.005 : entryPrice + 0.005),
      takeProfit: avgTP || (side === 'BUY' ? entryPrice + 0.01 : entryPrice - 0.01),
      confidence: Math.round(confidence),
      recommendedLotSize: 0,
      reason: this._buildReason(contributing, buyScore, sellScore, regime),
      contributingStrategies: contributing,
      dissenters: dissenting,
      regime: regime.regime,
      timestamp: new Date().toISOString(),
    };
  }

  _buildReason(contributing, buyScore, sellScore, regime) {
    const direction = buyScore > sellScore ? 'BUY' : 'SELL';
    const major = contributing.filter(c => c.side === direction).slice(0, 3).map(c => c.strategy).join(', ');
    return `Decision: ${direction} (${Math.max(buyScore, sellScore).toFixed(0)}%). Contributors: ${major || 'none'}. Regime: ${regime.regime} (${regime.confidence}%).`;
  }

  async _validateDecision(decision, symbol) {
    try {
      const account = await accountService.getAccount(process.env.DEFAULT_TRADING_PRODUCT || 'mt5');
      const balance = parseFloat(account.balance);
      const riskPct = parseFloat(process.env.RISK_PER_TRADE) || 1;
      const stopDistance = Math.abs(decision.stopLoss - decision.entryPrice);
      if (stopDistance === 0) return false;

      const { calculatePositionSize } = require('../strategy/engine');
      const lotSize = calculatePositionSize(
        balance,
        riskPct,
        decision.stopLoss,
        decision.entryPrice,
        decision.symbol,
        process.env.DEFAULT_TRADING_PRODUCT || 'mt5'
      );
      decision.recommendedLotSize = lotSize;

      const validation = await validateTrade(decision.symbol, decision.decision, lotSize);
      if (!validation.approved) {
        logger.debug(`[FusionEngine] Risk validation failed: ${validation.reason}`);
        return false;
      }

      // Optional: use riskIntelligence if available
      if (riskIntelligence) {
        const openPositions = await require('../execution/brokerFactory').getBroker(process.env.DEFAULT_TRADING_PRODUCT || 'mt5').getOpenTrades();
        const riskAssessment = await riskIntelligence.assessTrade(decision, balance, openPositions);
        if (!riskAssessment.allowed) {
          logger.debug(`[FusionEngine] RiskIntelligence rejected: ${riskAssessment.reason}`);
          return false;
        }
        // Optionally adjust lot size from risk intelligence
        if (riskAssessment.adjustedLotSize) {
          decision.recommendedLotSize = riskAssessment.adjustedLotSize;
        }
      }

      // Optional: portfolioIntelligence
      if (portfolioIntelligence) {
        const openPositions = await require('../execution/brokerFactory').getBroker(process.env.DEFAULT_TRADING_PRODUCT || 'mt5').getOpenTrades();
        const portfolioCheck = await portfolioIntelligence.assessNewTrade(decision, balance, openPositions);
        if (!portfolioCheck.approved) {
          logger.debug(`[FusionEngine] PortfolioIntelligence rejected: ${portfolioCheck.reason}`);
          return false;
        }
        if (portfolioCheck.adjustedLotSize) {
          decision.recommendedLotSize = portfolioCheck.adjustedLotSize;
        }
      }

      return true;
    } catch (err) {
      logger.error('[FusionEngine] Validation error:', err.message);
      return false;
    }
  }

  getLastDecision(symbol) {
    return this._lastDecision.get(symbol) || null;
  }

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

module.exports = new FusionEngine();
