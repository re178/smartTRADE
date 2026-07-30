// core/decision/engine.js
// Decision Engine – synthesizes CTOS evidence into a final trading signal.
// Added debug logs to trace regime receipt and decision generation.

const EventEmitter = require('events');
const marketStateCache = require('../data/marketStateCache');
const deepRegime = require('../intelligence/deep/regime');
const awarenessEngine = require('../awareness/engine');
const knowledgeStore = require('../research/knowledgeStore');
const logger = require('../../infrastructure/logger') || console;

const CONFIG = {
  DECISION_INTERVAL_MS: 30000, // re-evaluate every 30 seconds
  MIN_CONFIDENCE: 60,
  DEFAULT_STOP_DISTANCE_ATR: 1.5,
  DEFAULT_TP_DISTANCE_ATR: 3.0,
};

class DecisionEngine extends EventEmitter {
  constructor() {
    super();
    this._lastDecision = {};
    this._timer = null;

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

    logger.info('[DecisionEngine] Initialized.');
  }

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

  async _evaluateSymbol(symbol) {
    // 1. Get current state
    const state = marketStateCache.get(symbol);
    if (!state) {
      console.log(`❌ DecisionEngine: no market state for ${symbol}`);
      return null;
    }

    // 2. Get regime (from last regime event)
    const regime = deepRegime.getLatestRegime(symbol) || { code: 'NEUTRAL', confidence: 50 };

    // 3. Compute BUY and SELL scores
    let buyScore = 0, sellScore = 0;

    // 3a. Regime bias
    if (regime.code === 'STRONG_TREND_BULL' || regime.code === 'WEAK_TREND') {
      const direction = state.trend || 'neutral';
      if (direction === 'bullish') buyScore += 30 * (regime.confidence / 100);
      else if (direction === 'bearish') sellScore += 30 * (regime.confidence / 100);
    } else if (regime.code === 'STRONG_TREND_BEAR') {
      sellScore += 30 * (regime.confidence / 100);
    } else if (regime.code === 'REVERSAL') {
      // FIX: state.trend is a string, not an object with .direction
      const trendDir = state.trend || 'neutral';
      if (trendDir === 'bullish') sellScore += 20;
      else if (trendDir === 'bearish') buyScore += 20;
    } else if (regime.code === 'BREAKOUT') {
      if (state.velocity > 0.0001) buyScore += 25;
      else if (state.velocity < -0.0001) sellScore += 25;
    }

    // 3b. Awareness signals
    const absVel = Math.abs(state.velocity || 0);
    const velScore = Math.min(20, absVel / 0.0001 * 10);
    if (state.velocity > 0) buyScore += velScore;
    else if (state.velocity < 0) sellScore += velScore;

    // 3c. Liquidity
    const liq = state.liquidity || 0.5;
    if (liq > 0.6) {
      buyScore += 5;
      sellScore += 5;
    }

    // 4. Determine decision
    let decision = 'NO_TRADE';
    let confidence = 0;
    const totalScore = Math.abs(buyScore - sellScore);
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

    // 5. Build decision object
    const currentPrice = state.mid || 0;
    const atr = state.atr || 0.001;
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

    console.log(`📊 DecisionEngine: ${symbol} scores: BUY=${buyScore.toFixed(1)}, SELL=${sellScore.toFixed(1)}, decision=${decision}, conf=${confidence.toFixed(1)}`);

    return {
      symbol,
      decision,
      confidence: Math.round(confidence),
      entryPrice: currentPrice,
      stopLoss: Math.round(stopLoss * 100000) / 100000,
      takeProfit: Math.round(takeProfit * 100000) / 100000,
      recommendedLotSize: 0.01,
      reason: this._buildReason(decision, buyScore, sellScore, regime),
      timestamp: new Date().toISOString(),
      scores: { buyScore, sellScore },
    };
  }

  _buildReason(decision, buyScore, sellScore, regime) {
    let parts = [];
    if (regime) parts.push(`Regime: ${regime.name} (${regime.confidence}%)`);
    if (decision === 'BUY') parts.push(`BUY score: ${Math.round(buyScore)} vs SELL: ${Math.round(sellScore)}`);
    else if (decision === 'SELL') parts.push(`SELL score: ${Math.round(sellScore)} vs BUY: ${Math.round(buyScore)}`);
    else parts.push(`Scores: BUY ${Math.round(buyScore)} / SELL ${Math.round(sellScore)} – insufficient edge`);
    return parts.join(' | ');
  }

  getLastDecision(symbol) {
    return this._lastDecision[symbol] || null;
  }
}

module.exports = new DecisionEngine();
