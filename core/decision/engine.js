// core/decision/engine.js
// Decision Engine – aggregates evidence, retrieves knowledge, produces trading decisions.

const EventEmitter = require('events');
const marketStateCache = require('../data/marketStateCache');
const deepRegime = require('../intelligence/deep/regime');
const awarenessEngine = require('../awareness/engine');
const hypothesisEngine = require('../research/engine');
const knowledgeStore = require('../research/knowledgeStore');
const logger = require('../../infrastructure/logger') || console;

// Configuration
const CONFIG = {
  MIN_CONFIDENCE: 65,
  DECISION_COOLDOWN: 60000, // 1 minute
  MAX_POSITIONS: 3,
};

class DecisionEngine extends EventEmitter {
  constructor() {
    super();
    this._lastDecision = new Map(); // symbol -> { decision, timestamp }
    this._activeHypotheses = new Map(); // symbol -> active hypothesis IDs (for weighting)

    // Listen to regime updates
    deepRegime.on('regime', (regime) => {
      this._evaluate(regime);
    });

    // Listen to hypothesis outcomes (they can influence confidence)
    hypothesisEngine.on('hypothesisResolved', (hypothesis) => {
      // If the hypothesis is resolved, it may affect future decisions
      // We could trigger a re-evaluation, but we'll rely on the next regime update.
      logger.debug(`[DecisionEngine] Hypothesis ${hypothesis.id} resolved, will affect next decision.`);
    });

    // Listen to knowledge updates (for future decisions)
    knowledgeStore.on('knowledgeUpdated', (knowledge) => {
      // Optionally trigger re-evaluation if it's relevant
      // We'll keep it passive for now.
    });

    logger.info('[DecisionEngine] Initialized.');
  }

  /**
   * Evaluate the current evidence and produce a decision.
   * Called on every regime update.
   */
  async _evaluate(regime) {
    const { symbol, code, confidence: regimeConfidence, timestamp } = regime;

    // Check cooldown
    const last = this._lastDecision.get(symbol);
    if (last && Date.now() - last.timestamp < CONFIG.DECISION_COOLDOWN) {
      return; // still in cooldown
    }

    try {
      // 1. Get current market state (awareness)
      const state = marketStateCache.get(symbol);
      if (!state) {
        logger.warn(`[DecisionEngine] No market state for ${symbol}`);
        return;
      }

      // 2. Get active hypotheses for this symbol
      const activeHypotheses = hypothesisEngine.getActiveHypotheses(symbol);

      // 3. Gather evidence
      const evidence = {
        regime: {
          code,
          confidence: regimeConfidence,
          family: regime.family || 'unknown',
        },
        awareness: {
          velocity: state.velocity || 0,
          acceleration: state.acceleration || 0,
          liquidity: state.liquidity || 0.5,
          spread: state.spread || 0,
          unusualEvents: state.unusual || [],
        },
        activeHypotheses: activeHypotheses,
        // We could also add recent price action if needed
      };

      // 4. Query knowledge store for probabilities
      const knowledgeProbabilities = await this._getKnowledgeProbabilities(symbol, regime);

      // 5. Combine all evidence into a decision
      const decision = await this._combineEvidence(symbol, evidence, knowledgeProbabilities);

      // 6. If decision is not HOLD and confidence >= threshold, emit
      if (decision.decision !== 'HOLD' && decision.confidence >= CONFIG.MIN_CONFIDENCE) {
        // Validate against portfolio risk (could integrate with existing PortfolioManager)
        // For now, we'll just emit the decision.
        this._lastDecision.set(symbol, { decision: decision.decision, timestamp: Date.now() });
        this.emit('decision', {
          symbol,
          ...decision,
          timestamp: new Date().toISOString(),
        });
        logger.info(`[DecisionEngine] ${symbol} → ${decision.decision} (${decision.confidence}%)`);
      } else {
        // Emit a HOLD decision with low confidence for the dashboard
        this.emit('decision', {
          symbol,
          decision: 'HOLD',
          confidence: 0,
          reason: 'Insufficient confidence or no clear edge.',
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      logger.error(`[DecisionEngine] Error for ${symbol}:`, err.message);
    }
  }

  /**
   * Query knowledge store for probabilities based on current state.
   */
  async _getKnowledgeProbabilities(symbol, regime) {
    const { code, family } = regime;
    // We'll get probabilities for key indicators
    const state = marketStateCache.get(symbol);
    if (!state) return {};

    const probs = {
      continuation: 0.5,
      reversal: 0.5,
      breakout: 0.5,
      failure: 0.5,
    };

    // For each indicator, get confidence from knowledge store
    const indicators = ['rsi', 'velocity', 'liquidity', 'spread'];
    for (const indicator of indicators) {
      let value = null;
      if (indicator === 'rsi') {
        // We need RSI from deep state – but we don't have it here.
        // We'll skip or fetch from deep state if available.
        // For now, we'll use a placeholder.
        const deepState = await require('../intelligence/deep/marketState').compute(symbol, 'M5', 50);
        if (deepState) {
          value = deepState.momentum.rsi;
        }
      } else if (indicator === 'velocity') {
        value = state.velocity || 0;
      } else if (indicator === 'liquidity') {
        value = state.liquidity || 0.5;
      } else if (indicator === 'spread') {
        value = state.spread || 0;
      }
      if (value !== null) {
        const knowledge = await knowledgeStore.getKnowledge(symbol, code, indicator, value);
        if (knowledge) {
          // Map knowledge outcome to our probability categories
          if (knowledge.outcome === 'continuation') {
            probs.continuation = knowledge.confidence;
          } else if (knowledge.outcome === 'reversal') {
            probs.reversal = knowledge.confidence;
          } else if (knowledge.outcome === 'breakout') {
            probs.breakout = knowledge.confidence;
          } else if (knowledge.outcome === 'failure') {
            probs.failure = knowledge.confidence;
          }
        }
      }
    }
    return probs;
  }

  /**
   * Combine all evidence into a final decision.
   */
  async _combineEvidence(symbol, evidence, probabilities) {
    const { regime, awareness, activeHypotheses } = evidence;
    const { code, family, confidence: regimeConf } = regime;

    // 1. Base decision from regime
    let side = 'HOLD';
    let baseConf = 0;

    // Trending regimes -> BUY/SELL
    if (family === 'trend') {
      if (code === 'STRONG_TREND_BULL') {
        side = 'BUY';
        baseConf = 60 + regimeConf * 0.3;
      } else if (code === 'STRONG_TREND_BEAR') {
        side = 'SELL';
        baseConf = 60 + regimeConf * 0.3;
      } else if (code === 'WEAK_TREND') {
        // Weak trend – need more confirmation
        side = 'HOLD';
        baseConf = 50;
      }
    } else if (family === 'breakout') {
      // Breakout – check if momentum agrees
      if (Math.abs(awareness.velocity) > 0.0001 && awareness.liquidity > 0.5) {
        side = awareness.velocity > 0 ? 'BUY' : 'SELL';
        baseConf = 60 + (Math.abs(awareness.velocity) * 100);
      } else {
        side = 'HOLD';
        baseConf = 40;
      }
    } else if (family === 'reversal') {
      // Reversal – check RSI extreme and velocity reversal
      // We'll need RSI from deep state, but we don't have it.
      // We'll rely on knowledge store probabilities.
      if (probabilities.reversal > 0.7) {
        side = awareness.velocity > 0 ? 'SELL' : 'BUY';
        baseConf = probabilities.reversal * 100;
      } else {
        side = 'HOLD';
        baseConf = 50;
      }
    } else if (family === 'range' || family === 'quiet') {
      // In range, we might use mean reversion
      // But we'll be cautious.
      side = 'HOLD';
      baseConf = 40;
    } else if (family === 'volatile') {
      // High volatility – avoid unless clear momentum
      if (Math.abs(awareness.velocity) > 0.0002 && awareness.liquidity > 0.3) {
        side = awareness.velocity > 0 ? 'BUY' : 'SELL';
        baseConf = 50;
      } else {
        side = 'HOLD';
        baseConf = 30;
      }
    } else {
      // Neutral – default to HOLD
      side = 'HOLD';
      baseConf = 50;
    }

    // 2. Adjust confidence using active hypotheses
    let hypothesisAdjustment = 0;
    if (activeHypotheses.length > 0) {
      // If there is an active hypothesis that matches the side, increase confidence
      for (const h of activeHypotheses) {
        const expectedOutcome = (side === 'BUY') ? 'trend_continuation' : 'trend_reversal';
        if (h.type === expectedOutcome) {
          hypothesisAdjustment += 5;
        }
        // If hypothesis is contrary, decrease confidence
        if (h.type === 'trend_reversal' && side === 'BUY') {
          hypothesisAdjustment -= 10;
        }
      }
    }

    // 3. Use knowledge probabilities
    let knowledgeAdjustment = 0;
    if (side === 'BUY' && probabilities.continuation > 0.6) {
      knowledgeAdjustment += (probabilities.continuation - 0.5) * 50;
    } else if (side === 'SELL' && probabilities.reversal > 0.6) {
      knowledgeAdjustment += (probabilities.reversal - 0.5) * 50;
    }

    // 4. Final confidence
    let finalConfidence = baseConf + hypothesisAdjustment + knowledgeAdjustment;
    finalConfidence = Math.min(100, Math.max(0, finalConfidence));

    // 5. If confidence < threshold, return HOLD
    if (finalConfidence < CONFIG.MIN_CONFIDENCE) {
      side = 'HOLD';
    }

    // 6. Build reasoning
    const reasoning = this._buildReasoning(side, evidence, probabilities, finalConfidence);

    return {
      decision: side,
      confidence: Math.round(finalConfidence),
      reasoning,
      entryPrice: awareness.mid || 0,
    };
  }

  /**
   * Build a human‑readable reasoning string.
   */
  _buildReasoning(decision, evidence, probabilities, confidence) {
    const parts = [];
    if (decision !== 'HOLD') {
      parts.push(`Decision: ${decision} with ${Math.round(confidence)}% confidence.`);
    } else {
      parts.push(`Hold: Insufficient evidence.`);
    }
    parts.push(`Regime: ${evidence.regime.code} (${Math.round(evidence.regime.confidence)}%).`);
    if (evidence.awareness.unusualEvents && evidence.awareness.unusualEvents.length > 0) {
      parts.push(`Unusual events: ${evidence.awareness.unusualEvents.join(', ')}.`);
    }
    if (probabilities.continuation > 0.6) {
      parts.push(`Continuation probability: ${Math.round(probabilities.continuation * 100)}%.`);
    }
    if (probabilities.reversal > 0.6) {
      parts.push(`Reversal probability: ${Math.round(probabilities.reversal * 100)}%.`);
    }
    return parts.join(' ');
  }
}

module.exports = new DecisionEngine();
