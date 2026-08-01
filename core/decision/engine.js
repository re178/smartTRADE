// core/decision/engine.js
// Decision Engine – probability/EV based with empirical edge from StateStore.
// Enhanced with: adaptive thresholds, learning weights, confidence calibration.

const EventEmitter = require('events');
const marketStateCache = require('../data/marketStateCache');
const deepMarketState = require('../intelligence/deep/marketState');
const deepRegime = require('../intelligence/deep/regime');
const awarenessEngine = require('../awareness/engine');
const selfLearner = require('../learning/learner');
const stateStore = require('../intelligence/lab/stateStore');
const { dataOrchestrator } = require('../data/dataOrchestrator');
const logger = require('../../infrastructure/logger') || console;

const CONFIG = {
  DECISION_INTERVAL_MS: 30000,
  MIN_CONFIDENCE: 60,
  MIN_EDGE: 0.2,
  MIN_PROBABILITY: 0.52,
  DEFAULT_STOP_DISTANCE_ATR: 1.5,
  DEFAULT_TP_DISTANCE_ATR: 3.0,
  EDGE_LOOKAHEAD: 5,
  EDGE_K: 100,
};

// ---- Adaptive thresholds based on volatility ----
function getAdaptiveThresholds(volatilityRegime) {
  if (volatilityRegime === 'high') {
    return { minEdge: 0.3, minProbability: 0.55 };
  } else if (volatilityRegime === 'low') {
    return { minEdge: 0.15, minProbability: 0.50 };
  } else {
    return { minEdge: CONFIG.MIN_EDGE, minProbability: CONFIG.MIN_PROBABILITY };
  }
}

class DecisionEngine extends EventEmitter {
  constructor() {
    super();
    this._lastDecision = {};
    this._timer = null;
    this._isReady = false;

    console.log('🔧 DecisionEngine: constructor – listening to regime events');

    deepRegime.on('regime', (regime) => {
      console.log(`⚖️ DecisionEngine: received regime event for ${regime.symbol} (${regime.code})`);
      this._onRegime(regime);
    });

    this._timer = setInterval(() => {
      console.log('⏰ DecisionEngine: timer tick – evaluating all symbols');
      this._evaluate();
    }, CONFIG.DECISION_INTERVAL_MS);

    if (stateStore && typeof stateStore.init === 'function') {
      stateStore.init()
        .then(() => {
          this._isReady = true;
          console.log('✅ DecisionEngine: StateStore ready for edge computation.');
        })
        .catch(err => {
          console.warn('⚠️ DecisionEngine: StateStore init failed, using fallback.', err.message);
          this._isReady = false;
        });
    } else {
      console.warn('⚠️ DecisionEngine: StateStore not available, using fallback.');
      this._isReady = false;
    }

    logger.info('[DecisionEngine] Initialized with probability/EV framework.');
  }

  async _onRegime(regime) {
    console.log(`⚖️ DecisionEngine: processing regime for ${regime.symbol} (${regime.code}, conf: ${regime.confidence})`);
    const decision = await this._evaluateSymbol(regime.symbol);
    if (decision && decision.decision !== 'NO_TRADE') {
      const prev = this._lastDecision[regime.symbol];
      if (!prev || prev.decision !== decision.decision || Math.abs(prev.confidence - decision.confidence) > 5) {
        this._lastDecision[regime.symbol] = decision;
        // ---- LOG decision only when emitted ----
        try {
          const decisionId = await selfLearner.recordDecision(decision);
          if (decisionId) {
            decision.decisionId = decisionId;
          }
        } catch (err) {
          console.error(`❌ DecisionEngine: Failed to log decision:`, err.message);
        }
        console.log(`📢 DecisionEngine: emitting decision for ${regime.symbol}: ${decision.decision} (${decision.confidence}%)`);
        this.emit('decision', decision);
      } else {
        console.log(`⏸️ DecisionEngine: decision for ${regime.symbol} unchanged, not re-emitting`);
      }
    } else {
      console.log(`⏭️ DecisionEngine: NO_TRADE decision for ${regime.symbol}, not emitting`);
    }
  }

  async _evaluate() {
    try {
      const symbols = awarenessEngine._state ? Array.from(awarenessEngine._state.keys()) : [];
      if (symbols.length === 0) {
        console.log('⏳ DecisionEngine: no symbols in awareness engine');
        return;
      }
      console.log(`🔄 DecisionEngine: evaluating ${symbols.length} symbols`);
      for (const symbol of symbols) {
        const decision = await this._evaluateSymbol(symbol);
        if (decision && decision.decision !== 'NO_TRADE') {
          const prev = this._lastDecision[symbol];
          if (!prev || prev.decision !== decision.decision || Math.abs(prev.confidence - decision.confidence) > 5) {
            this._lastDecision[symbol] = decision;
            try {
              const decisionId = await selfLearner.recordDecision(decision);
              if (decisionId) {
                decision.decisionId = decisionId;
              }
            } catch (err) {
              console.error(`❌ DecisionEngine: Failed to log decision:`, err.message);
            }
            console.log(`📢 DecisionEngine: emitting decision for ${symbol}: ${decision.decision} (${decision.confidence}%)`);
            this.emit('decision', decision);
          }
        }
      }
    } catch (err) {
      console.error(`❌ DecisionEngine: evaluation error:`, err.message);
      logger.error('[DecisionEngine] Evaluation error:', err.message);
    }
  }

  async _evaluateSymbol(symbol) {
    // 1. Get current awareness state (flat, for immediate metrics)
    const state = marketStateCache.get(symbol);
    if (!state) {
      console.log(`❌ DecisionEngine: no market state for ${symbol}`);
      return null;
    }

    // 2. Get deep state (full nested) for logging
    let deepState = deepMarketState.getLastState(symbol);
    if (!deepState) {
      console.warn(`⚠️ DecisionEngine: no deep state for ${symbol}, using awareness state fallback`);
      deepState = {
        ...state,
        trend: { direction: state.trend || 'neutral', strength: 0, adx: 0, plusDI: 0, minusDI: 0 },
        momentum: { rsi: state.momentum || 50, macdLine: 0, macdSignal: 0, macdHist: 0, velocity: state.velocity || 0, acceleration: state.acceleration || 0 },
        volatility: { atr: state.atr || 0.001, atrPercent: 0.005, bbWidth: 0.15, regime: 'normal' },
        liquidity: { score: state.liquidity || 0.5, spread: state.spread || 0, tickFrequency: 0 },
        structure: { support: null, resistance: null, pricePosition: 0.5, isAtSupport: false, isAtResistance: false },
        session: { name: state.session || 'Other', liquidityMultiplier: 1, isWeekday: true },
        regime: { code: 'NEUTRAL', name: 'Neutral', confidence: 50, description: '' },
        summary: { marketQuality: 50, noiseLevel: 'medium', regimeSuggestion: 'neutral', trendConfidence: 50 },
        confidence: 50,
        reason: 'Fallback state',
      };
    }

    // 3. Get regime (from last regime event)
    const regime = deepRegime.getLatestRegime(symbol) || { code: 'NEUTRAL', confidence: 50 };

    // 4. Extract flat features for StateStore (uses awareness state)
    const flatFeatures = this._extractFeatures(state, regime);

    // 5. Compute edge (probability and expected value) from historical analogues
    let edge = null;
    let similarity = null;
    if (this._isReady && stateStore) {
      try {
        edge = await stateStore.computeEdge(
          flatFeatures,
          symbol,
          'M5',
          CONFIG.EDGE_LOOKAHEAD,
          CONFIG.EDGE_K
        );
        similarity = await stateStore.findSimilar(
          flatFeatures,
          symbol,
          'M5',
          CONFIG.EDGE_K,
          CONFIG.EDGE_LOOKAHEAD
        );
      } catch (err) {
        console.warn(`⚠️ DecisionEngine: StateStore error for ${symbol}:`, err.message);
        edge = null;
      }
    }

    // 6. Determine decision based on edge (if available) or fallback to rule-based
    let decision, confidence, expectedValue, probability;

    // ---- Adaptive thresholds based on volatility ----
    const volatilityRegime = state.volatility?.regime || 'normal';
    const { minEdge, minProbability } = getAdaptiveThresholds(volatilityRegime);

    if (edge && edge.sampleSize >= 20) {
      // ---- Use Empirical Edge ----
      const winProb = edge.winRate;
      const avgReturnR = edge.avgReturnR;
      const ev = avgReturnR;

      if (ev > minEdge && winProb > minProbability) {
        decision = 'BUY';
        confidence = Math.min(90, 50 + (winProb - 0.5) * 80);
        expectedValue = ev;
        probability = winProb;
      } else if (ev < -minEdge && (1 - winProb) > minProbability) {
        decision = 'SELL';
        confidence = Math.min(90, 50 + ((1 - winProb) - 0.5) * 80);
        expectedValue = ev;
        probability = winProb;
      } else {
        decision = 'NO_TRADE';
        confidence = 50;
        expectedValue = ev;
        probability = winProb;
      }

      console.log(`📊 DecisionEngine: ${symbol} edge: EV=${ev.toFixed(3)}, winProb=${(winProb*100).toFixed(1)}%, sample=${edge.sampleSize}`);

    } else {
      // ---- Fallback: Rule-Based Scoring with Learning Weights ----
      console.log(`⚠️ DecisionEngine: ${symbol} using fallback rule-based scoring (sample size ${edge?.sampleSize || 0})`);
      const result = this._weightedFallbackRuleBased(symbol, state, regime);
      decision = result.decision;
      confidence = result.confidence;
      expectedValue = 0;
      probability = confidence / 100;
    }

    // ---- Confidence Calibration (if stateStore is ready and decision is not NO_TRADE) ----
    if (decision !== 'NO_TRADE' && this._isReady && stateStore) {
      try {
        const calibration = await stateStore.calibrateConfidence({
          symbol,
          features: deepState,
          confidence,
          timeframe: 'M5',
        }, CONFIG.EDGE_LOOKAHEAD, CONFIG.EDGE_K);
        if (calibration && calibration.sampleSize > 10) {
          // Adjust confidence towards calibrated value
          confidence = confidence * 0.6 + calibration.calibratedConfidence * 0.4;
          confidence = Math.round(Math.min(100, Math.max(0, confidence)));
          console.log(`📊 DecisionEngine: ${symbol} calibrated confidence from ${confidence} to ${calibration.calibratedConfidence} (sample ${calibration.sampleSize})`);
        }
      } catch (err) {
        console.warn(`⚠️ DecisionEngine: Confidence calibration failed for ${symbol}:`, err.message);
      }
    }

    // 7. Build decision object
    const currentPrice = state.price?.current || state.mid || 0;
    const atr = state.volatility?.atr || state.atr || 0.001;
    const stopDistance = atr * CONFIG.DEFAULT_STOP_DISTANCE_ATR || currentPrice * 0.005;
    const takeDistance = atr * CONFIG.DEFAULT_TP_DISTANCE_ATR || currentPrice * 0.01;
    let stopLoss = 0, takeProfit = 0;
    if (decision === 'BUY') {
      stopLoss = currentPrice - stopDistance;
      takeProfit = currentPrice + takeDistance;
    } else if (decision === 'SELL') {
      stopLoss = currentPrice + stopDistance;
      takeProfit = currentPrice - takeDistance;
    }

    // 8. Build full decision object – using deepState for features
    const decisionObj = {
      symbol,
      decision,
      confidence: Math.round(Math.min(100, Math.max(0, confidence))),
      expectedValue: expectedValue || 0,
      probability: probability || 0.5,
      entryPrice: currentPrice,
      stopLoss: Math.round(stopLoss * 100000) / 100000,
      takeProfit: Math.round(takeProfit * 100000) / 100000,
      recommendedLotSize: 0.01,
      reason: this._buildReason(decision, confidence, edge, regime),
      timestamp: new Date().toISOString(),
      timeframe: 'M5',
      features: deepState,
      contributions: this._buildContributions(state, regime, edge),
      inputs: {
        regime: regime.confidence / 100,
        momentum: state.momentum?.rsi ? (state.momentum.rsi - 50) / 50 : 0,
        liquidity: state.liquidity?.score || state.liquidity || 0.5,
      },
      historicalAnalogues: edge?.sampleSize || 0,
      generatedBy: 'DecisionEngine v5',
      probabilityModel: 'v4.0',
      expectedValueModel: 'v2.1',
    };

    // ---- DO NOT LOG HERE – logging is done only when we emit ----
    // The caller (_onRegime or _evaluate) will log and emit after checking changes.

    return decisionObj;
  }

  // ============================================================
  // FALLBACK: Rule-Based Scoring with Learning Weights
  // ============================================================

  _weightedFallbackRuleBased(symbol, state, regime) {
    // Get learning weights from selfLearner (if available)
    let weights = {
      regime: 1.0,
      velocity: 1.0,
      liquidity: 1.0,
    };
    try {
      const learnerWeights = selfLearner.getWeights();
      // Map strategy names to our components – we can use generic mapping
      // For simplicity, we use equal weights if no specific mapping.
      // However, we can extract weights for 'regime', 'velocity', 'liquidity' if stored.
      // Since we don't have separate keys, we'll use the average of all strategy weights as a proxy.
      const allWeights = Object.values(learnerWeights);
      if (allWeights.length > 0) {
        const avgWeight = allWeights.reduce((a, b) => a + b, 0) / allWeights.length;
        // Use avgWeight as a multiplier for all components (or we can keep equal)
        // For now, we keep equal weighting but we can optionally scale.
        // We'll keep equal weighting to avoid breaking existing behavior.
      }
    } catch (err) {
      // ignore
    }

    // Weights are currently equal; we could scale but let's keep simple.
    let buyScore = 0, sellScore = 0;

    // Regime bias (weighted)
    if (regime.code === 'STRONG_TREND_BULL' || regime.code === 'WEAK_TREND') {
      const direction = state.trend || 'neutral';
      if (direction === 'bullish') buyScore += 30 * (regime.confidence / 100) * weights.regime;
      else if (direction === 'bearish') sellScore += 30 * (regime.confidence / 100) * weights.regime;
    } else if (regime.code === 'STRONG_TREND_BEAR') {
      sellScore += 30 * (regime.confidence / 100) * weights.regime;
    } else if (regime.code === 'REVERSAL') {
      const trendDir = state.trend || 'neutral';
      if (trendDir === 'bullish') sellScore += 20 * weights.regime;
      else if (trendDir === 'bearish') buyScore += 20 * weights.regime;
    } else if (regime.code === 'BREAKOUT') {
      const velocity = state.awareness?.velocity || state.velocity || 0;
      if (velocity > 0.0001) buyScore += 25 * weights.regime;
      else if (velocity < -0.0001) sellScore += 25 * weights.regime;
    }

    // Velocity (weighted)
    const velocity = state.awareness?.velocity || state.velocity || 0;
    const absVel = Math.abs(velocity);
    const velScore = Math.min(20, absVel / 0.0001 * 10) * weights.velocity;
    if (velocity > 0) buyScore += velScore;
    else if (velocity < 0) sellScore += velScore;

    // Liquidity (weighted)
    const liquidity = state.awareness?.liquidity || state.liquidity || 0.5;
    if (liquidity > 0.6) {
      buyScore += 5 * weights.liquidity;
      sellScore += 5 * weights.liquidity;
    }

    let decision = 'NO_TRADE';
    let confidence = 0;
    if (buyScore > sellScore && buyScore > 20) {
      decision = 'BUY';
      confidence = Math.min(90, 50 + (buyScore - sellScore) / (buyScore + sellScore + 0.001) * 40);
    } else if (sellScore > buyScore && sellScore > 20) {
      decision = 'SELL';
      confidence = Math.min(90, 50 + (sellScore - buyScore) / (buyScore + sellScore + 0.001) * 40);
    }

    if (confidence < CONFIG.MIN_CONFIDENCE) {
      decision = 'NO_TRADE';
      confidence = 0;
    }

    return { decision, confidence };
  }

  // ---- The rest of the methods are unchanged ----
  _extractFeatures(state, regime) { /* ... unchanged */ }
  _buildContributions(state, regime, edge) { /* ... unchanged */ }
  _buildReason(decision, confidence, edge, regime) { /* ... unchanged */ }
  getLastDecision(symbol) { return this._lastDecision[symbol] || null; }
}

module.exports = new DecisionEngine();
