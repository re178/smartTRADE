// core/decision/engine.js
// Decision Engine – probability/EV based with empirical edge from StateStore.
// Every decision is logged to HistoricalDecision for lineage and calibration.

const EventEmitter = require('events');
const marketStateCache = require('../data/marketStateCache');
const deepRegime = require('../intelligence/deep/regime');
const awarenessEngine = require('../awareness/engine');
const selfLearner = require('../learning/learner');
const stateStore = require('../intelligence/lab/stateStore');
const { dataOrchestrator } = require('../data/dataOrchestrator');
const logger = require('../../infrastructure/logger') || console;

const CONFIG = {
  DECISION_INTERVAL_MS: 30000,
  MIN_CONFIDENCE: 60,
  MIN_EDGE: 0.2,               // Minimum expected value in R multiples
  MIN_PROBABILITY: 0.52,       // Minimum win probability
  DEFAULT_STOP_DISTANCE_ATR: 1.5,
  DEFAULT_TP_DISTANCE_ATR: 3.0,
  EDGE_LOOKAHEAD: 5,           // Number of candles for outcome
  EDGE_K: 100,                 // Number of analogues for edge computation
};

class DecisionEngine extends EventEmitter {
  constructor() {
    super();
    this._lastDecision = {};
    this._timer = null;
    this._isReady = false;

    // ---- DEBUG: log initialization ----
    console.log('🔧 DecisionEngine: constructor – listening to regime events');

    // Listen to regime events
    deepRegime.on('regime', (regime) => {
      console.log(`⚖️ DecisionEngine: received regime event for ${regime.symbol} (${regime.code})`);
      this._onRegime(regime);
    });

    // Also evaluate periodically
    this._timer = setInterval(() => {
      console.log('⏰ DecisionEngine: timer tick – evaluating all symbols');
      this._evaluate();
    }, CONFIG.DECISION_INTERVAL_MS);

    // Initialise StateStore
    stateStore.init().then(() => {
      this._isReady = true;
      console.log('✅ DecisionEngine: StateStore ready for edge computation.');
    }).catch(err => {
      console.warn('⚠️ DecisionEngine: StateStore init failed, using fallback.', err.message);
    });

    logger.info('[DecisionEngine] Initialized with probability/EV framework.');
  }

  // ============================================================
  // EVENT HANDLERS
  // ============================================================

  async _onRegime(regime) {
    console.log(`⚖️ DecisionEngine: processing regime for ${regime.symbol} (${regime.code}, conf: ${regime.confidence})`);
    const decision = await this._evaluateSymbol(regime.symbol);
    if (decision && decision.decision !== 'NO_TRADE') {
      const prev = this._lastDecision[regime.symbol];
      if (!prev || prev.decision !== decision.decision || Math.abs(prev.confidence - decision.confidence) > 5) {
        this._lastDecision[regime.symbol] = decision;
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

  // ============================================================
  // CORE DECISION LOGIC – Probability/EV Based
  // ============================================================

  async _evaluateSymbol(symbol) {
    // 1. Get current state
    const state = marketStateCache.get(symbol);
    if (!state) {
      console.log(`❌ DecisionEngine: no market state for ${symbol}`);
      return null;
    }

    // 2. Get regime (from last regime event)
    const regime = deepRegime.getLatestRegime(symbol) || { code: 'NEUTRAL', confidence: 50 };

    // 3. Extract features for StateStore
    const features = this._extractFeatures(state, regime);

    // 4. Compute edge (probability and expected value) from historical analogues
    let edge = null;
    let similarity = null;
    if (this._isReady) {
      try {
        edge = await stateStore.computeEdge(
          features,
          symbol,
          'M5',
          CONFIG.EDGE_LOOKAHEAD,
          CONFIG.EDGE_K
        );
        // Also get similarity details for logging
        similarity = await stateStore.findSimilar(
          features,
          symbol,
          'M5',
          CONFIG.EDGE_K,
          CONFIG.EDGE_LOOKAHEAD
        );
      } catch (err) {
        console.warn(`⚠️ DecisionEngine: StateStore error for ${symbol}:`, err.message);
        // Fallback to rule-based
        edge = null;
      }
    }

    // 5. Determine decision based on edge (if available) or fallback to rule-based
    let decision, confidence, expectedValue, probability;

    if (edge && edge.sampleSize >= 20) {
      // ---- Use Empirical Edge ----
      const winProb = edge.winRate;
      const avgReturnR = edge.avgReturnR;
      const ev = avgReturnR; // expected value in R multiples

      // Determine side based on expected value
      if (ev > CONFIG.MIN_EDGE && winProb > CONFIG.MIN_PROBABILITY) {
        decision = 'BUY';
        confidence = Math.min(90, 50 + (winProb - 0.5) * 80);
        expectedValue = ev;
        probability = winProb;
      } else if (ev < -CONFIG.MIN_EDGE && (1 - winProb) > CONFIG.MIN_PROBABILITY) {
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
      // ---- Fallback: Rule-Based Scoring (original logic) ----
      console.log(`⚠️ DecisionEngine: ${symbol} using fallback rule-based scoring (sample size ${edge?.sampleSize || 0})`);
      const result = this._fallbackRuleBased(symbol, state, regime);
      decision = result.decision;
      confidence = result.confidence;
      expectedValue = 0;
      probability = confidence / 100;
    }

    // 6. Build decision object
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

    // 7. Build full decision object
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
      // Additional fields for HistoricalDecision logging
      timeframe: 'M5',
      features: features,
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

    // 8. Log decision to HistoricalDecision via selfLearner
    try {
      const decisionId = await selfLearner.recordDecision(decisionObj);
      if (decisionId) {
        decisionObj.decisionId = decisionId;
      }
    } catch (err) {
      console.error(`❌ DecisionEngine: Failed to log decision:`, err.message);
    }

    console.log(`📊 DecisionEngine: ${symbol} decision=${decision}, conf=${confidence.toFixed(1)}%`);

    return decisionObj;
  }

  // ============================================================
  // FALLBACK: Rule-Based Scoring
  // ============================================================

  _fallbackRuleBased(symbol, state, regime) {
    let buyScore = 0, sellScore = 0;

    // Regime bias
    if (regime.code === 'STRONG_TREND_BULL' || regime.code === 'WEAK_TREND') {
      const direction = state.trend || 'neutral';
      if (direction === 'bullish') buyScore += 30 * (regime.confidence / 100);
      else if (direction === 'bearish') sellScore += 30 * (regime.confidence / 100);
    } else if (regime.code === 'STRONG_TREND_BEAR') {
      sellScore += 30 * (regime.confidence / 100);
    } else if (regime.code === 'REVERSAL') {
      const trendDir = state.trend || 'neutral';
      if (trendDir === 'bullish') sellScore += 20;
      else if (trendDir === 'bearish') buyScore += 20;
    } else if (regime.code === 'BREAKOUT') {
      const velocity = state.awareness?.velocity || state.velocity || 0;
      if (velocity > 0.0001) buyScore += 25;
      else if (velocity < -0.0001) sellScore += 25;
    }

    // Velocity
    const velocity = state.awareness?.velocity || state.velocity || 0;
    const absVel = Math.abs(velocity);
    const velScore = Math.min(20, absVel / 0.0001 * 10);
    if (velocity > 0) buyScore += velScore;
    else if (velocity < 0) sellScore += velScore;

    // Liquidity
    const liquidity = state.awareness?.liquidity || state.liquidity || 0.5;
    if (liquidity > 0.6) {
      buyScore += 5;
      sellScore += 5;
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

  // ============================================================
  // HELPER METHODS
  // ============================================================

  _extractFeatures(state, regime) {
    return {
      adx: state.trend?.adx || state.trend?.strength || 25,
      rsi: state.momentum?.rsi || 50,
      atrPercent: state.volatility?.atrPercent || 0.005,
      bbWidth: state.volatility?.bbWidth || 0.15,
      macdHist: state.momentum?.macdHist || 0,
      liquidity: state.liquidity?.score || state.liquidity || 0.5,
      velocity: state.awareness?.velocity || state.velocity || 0,
      acceleration: state.awareness?.acceleration || state.acceleration || 0,
      pricePosition: state.structure?.pricePosition || 0.5,
      marketQuality: state.summary?.marketQuality || 50,
      // Additional features from regime
      trendDirection: state.trend === 'bullish' ? 1 : (state.trend === 'bearish' ? -1 : 0),
      trendStrength: state.trend?.strength || 0,
      volatilityRegime: state.volatility?.regime === 'high' ? 1 : (state.volatility?.regime === 'low' ? -1 : 0),
      session: state.session?.name || 'Other',
      sessionMultiplier: state.session?.liquidityMultiplier || 1,
      regimeCode: regime.code || 'NEUTRAL',
      regimeConfidence: regime.confidence || 50,
    };
  }

  _buildContributions(state, regime, edge) {
    const positive = [];
    const negative = [];

    // Trend contribution
    const trendDir = state.trend === 'bullish' ? 1 : (state.trend === 'bearish' ? -1 : 0);
    if (trendDir > 0) positive.push({ name: 'Trend', score: 24, description: 'Strong bullish trend' });
    else if (trendDir < 0) negative.push({ name: 'Trend', score: 24, description: 'Bearish trend' });
    else positive.push({ name: 'Trend', score: 0, description: 'Neutral trend' });

    // Momentum
    const rsi = state.momentum?.rsi || 50;
    const rsiScore = (rsi - 50) / 50 * 20;
    if (rsiScore > 0) positive.push({ name: 'Momentum', score: rsiScore, description: `RSI ${rsi.toFixed(1)}` });
    else negative.push({ name: 'Momentum', score: Math.abs(rsiScore), description: `RSI ${rsi.toFixed(1)}` });

    // Liquidity
    const liq = state.liquidity?.score || state.liquidity || 0.5;
    if (liq > 0.6) positive.push({ name: 'Liquidity', score: 7, description: 'High liquidity' });
    else negative.push({ name: 'Liquidity', score: 7, description: 'Low liquidity' });

    // Session
    const sessionName = state.session?.name || 'Other';
    if (sessionName === 'London' || sessionName === 'New York') {
      positive.push({ name: 'Session', score: 5, description: `${sessionName} session` });
    } else {
      negative.push({ name: 'Session', score: 5, description: `${sessionName} session` });
    }

    // Regime
    if (regime.code === 'STRONG_TREND_BULL') positive.push({ name: 'Regime', score: 13, description: 'Strong bull trend' });
    else if (regime.code === 'STRONG_TREND_BEAR') negative.push({ name: 'Regime', score: 13, description: 'Strong bear trend' });
    else if (regime.code === 'BREAKOUT') positive.push({ name: 'Regime', score: 10, description: 'Breakout' });
    else if (regime.code === 'REVERSAL') negative.push({ name: 'Regime', score: 10, description: 'Reversal zone' });

    // Edge-based contribution (if available)
    if (edge && edge.sampleSize >= 20) {
      const edgeScore = edge.winRate * 20 - 10;
      if (edgeScore > 0) positive.push({ name: 'Historical Edge', score: edgeScore, description: `${edge.sampleSize} analogues, ${(edge.winRate*100).toFixed(1)}% win` });
      else negative.push({ name: 'Historical Edge', score: Math.abs(edgeScore), description: `${edge.sampleSize} analogues, ${(edge.winRate*100).toFixed(1)}% win` });
    }

    const totalScore = positive.reduce((s, p) => s + p.score, 0) - negative.reduce((s, n) => s + n.score, 0);

    return { positive, negative, totalScore };
  }

  _buildReason(decision, confidence, edge, regime) {
    let parts = [];
    if (regime) parts.push(`Regime: ${regime.name || regime.code} (${regime.confidence}%)`);

    if (decision === 'BUY' || decision === 'SELL') {
      if (edge && edge.sampleSize >= 20) {
        parts.push(`Historical edge: ${(edge.winRate * 100).toFixed(1)}% win rate from ${edge.sampleSize} analogues`);
        parts.push(`Expected value: ${edge.avgReturnR.toFixed(3)}R`);
        if (edge.profitFactor) parts.push(`Profit factor: ${edge.profitFactor.toFixed(2)}`);
      } else {
        parts.push(`Rule-based score: confidence ${confidence}%`);
      }
    } else {
      if (edge && edge.sampleSize >= 20) {
        parts.push(`Insufficient edge: EV=${edge.avgReturnR.toFixed(3)}R, P(win)=${(edge.winRate * 100).toFixed(1)}%`);
      } else {
        parts.push(`Insufficient rule-based score`);
      }
    }

    return parts.join(' | ');
  }

  getLastDecision(symbol) {
    return this._lastDecision[symbol] || null;
  }
}

module.exports = new DecisionEngine();
