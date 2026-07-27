// core/research/engine.js
// Evidence & Hypothesis Engine – the Research Layer.
// Observes market events, formulates hypotheses, tracks outcomes, builds knowledge.

const EventEmitter = require('events');
const marketStateCache = require('../data/marketStateCache');
const deepRegime = require('../intelligence/deep/regime');
const awarenessEngine = require('../awareness/engine');
const KnowledgeStore = require('./knowledgeStore'); // will be created next
const logger = require('../../infrastructure/logger') || console;

// Hypothesis types
const HYPOTHESIS_TYPES = {
  TREND_CONTINUATION: 'trend_continuation',
  TREND_REVERSAL: 'trend_reversal',
  BREAKOUT: 'breakout',
  FALSE_BREAKOUT: 'false_breakout',
  VOLATILITY_EXPANSION: 'volatility_expansion',
  VOLATILITY_CONTRACTION: 'volatility_contraction',
  LIQUIDITY_SHIFT: 'liquidity_shift',
  MOMENTUM_ACCELERATION: 'momentum_acceleration',
  MOMENTUM_DECELERATION: 'momentum_deceleration',
};

class HypothesisEngine extends EventEmitter {
  constructor() {
    super();
    // Active hypotheses: Map<id, { symbol, type, conditions, expiry, status }>
    this._activeHypotheses = new Map();
    this._hypothesisCounter = 0;

    // Subscribe to market events
    awarenessEngine.on('marketAwareness', (data) => {
      this._onAwareness(data);
    });

    deepRegime.on('regime', (regime) => {
      this._onRegime(regime);
    });

    // Periodic evaluation of active hypotheses
    setInterval(() => this._evaluateHypotheses(), 5000);

    logger.info('[HypothesisEngine] Initialized.');
  }

  /**
   * Called on every market awareness update.
   * Generates new hypotheses based on unusual events.
   */
  _onAwareness(data) {
    const { symbol, unusualEvents, velocity, acceleration, liquidity, spread } = data;
    if (!unusualEvents || unusualEvents.length === 0) return;

    for (const event of unusualEvents) {
      switch (event) {
        case 'velocity_burst':
          this._createHypothesis(symbol, HYPOTHESIS_TYPES.MOMENTUM_ACCELERATION, {
            velocity,
            acceleration,
            timestamp: Date.now(),
          });
          break;
        case 'spread_spike':
          this._createHypothesis(symbol, HYPOTHESIS_TYPES.VOLATILITY_EXPANSION, {
            spread,
            liquidity,
            timestamp: Date.now(),
          });
          break;
        case 'liquidity_drop':
          this._createHypothesis(symbol, HYPOTHESIS_TYPES.LIQUIDITY_SHIFT, {
            liquidity,
            spread,
            timestamp: Date.now(),
          });
          break;
        default:
          break;
      }
    }
  }

  /**
   * Called on every regime update.
   * Generates hypotheses based on regime changes.
   */
  _onRegime(regime) {
    const { symbol, code, confidence, timestamp } = regime;

    // If regime changes to strong trend, hypothesise continuation
    if (code === 'STRONG_TREND_BULL' || code === 'STRONG_TREND_BEAR') {
      this._createHypothesis(symbol, HYPOTHESIS_TYPES.TREND_CONTINUATION, {
        regime: code,
        confidence,
        timestamp,
      });
    }

    // If regime changes to reversal zone, hypothesise reversal
    if (code === 'REVERSAL') {
      this._createHypothesis(symbol, HYPOTHESIS_TYPES.TREND_REVERSAL, {
        regime: code,
        confidence,
        timestamp,
      });
    }

    // If regime changes to breakout, hypothesise breakout (or false)
    if (code === 'BREAKOUT') {
      this._createHypothesis(symbol, HYPOTHESIS_TYPES.BREAKOUT, {
        regime: code,
        confidence,
        timestamp,
      });
    }
  }

  /**
   * Create a new hypothesis.
   */
  _createHypothesis(symbol, type, conditions) {
    const id = ++this._hypothesisCounter;
    const hypothesis = {
      id,
      symbol,
      type,
      conditions,
      status: 'active',
      createdAt: Date.now(),
      expiresAt: Date.now() + this._getExpiry(type),
      evidence: [],
    };
    this._activeHypotheses.set(id, hypothesis);
    logger.info(`[Hypothesis] Created #${id} (${type}) for ${symbol}`);
    this.emit('hypothesisCreated', hypothesis);

    // Schedule auto‑expiry
    setTimeout(() => {
      if (this._activeHypotheses.has(id) && this._activeHypotheses.get(id).status === 'active') {
        this._expireHypothesis(id, 'expired');
      }
    }, this._getExpiry(type));
  }

  /**
   * Get expiry time (in ms) for a hypothesis type.
   */
  _getExpiry(type) {
    const expiryMap = {
      [HYPOTHESIS_TYPES.TREND_CONTINUATION]: 300000, // 5 min
      [HYPOTHESIS_TYPES.TREND_REVERSAL]: 300000,
      [HYPOTHESIS_TYPES.BREAKOUT]: 120000, // 2 min
      [HYPOTHESIS_TYPES.FALSE_BREAKOUT]: 120000,
      [HYPOTHESIS_TYPES.VOLATILITY_EXPANSION]: 180000, // 3 min
      [HYPOTHESIS_TYPES.VOLATILITY_CONTRACTION]: 180000,
      [HYPOTHESIS_TYPES.LIQUIDITY_SHIFT]: 60000, // 1 min
      [HYPOTHESIS_TYPES.MOMENTUM_ACCELERATION]: 120000,
      [HYPOTHESIS_TYPES.MOMENTUM_DECELERATION]: 120000,
    };
    return expiryMap[type] || 180000;
  }

  /**
   * Evaluate active hypotheses against current market state.
   */
  async _evaluateHypotheses() {
    for (const [id, hypothesis] of this._activeHypotheses) {
      if (hypothesis.status !== 'active') continue;

      const symbol = hypothesis.symbol;
      const state = marketStateCache.get(symbol);
      if (!state) continue;

      // Evaluate based on hypothesis type
      let outcome = null;
      switch (hypothesis.type) {
        case HYPOTHESIS_TYPES.TREND_CONTINUATION:
          outcome = this._evaluateTrendContinuation(hypothesis, state);
          break;
        case HYPOTHESIS_TYPES.TREND_REVERSAL:
          outcome = this._evaluateTrendReversal(hypothesis, state);
          break;
        case HYPOTHESIS_TYPES.BREAKOUT:
          outcome = this._evaluateBreakout(hypothesis, state);
          break;
        case HYPOTHESIS_TYPES.MOMENTUM_ACCELERATION:
          outcome = this._evaluateMomentumAcceleration(hypothesis, state);
          break;
        case HYPOTHESIS_TYPES.VOLATILITY_EXPANSION:
          outcome = this._evaluateVolatilityExpansion(hypothesis, state);
          break;
        case HYPOTHESIS_TYPES.LIQUIDITY_SHIFT:
          outcome = this._evaluateLiquidityShift(hypothesis, state);
          break;
        default:
          break;
      }

      if (outcome) {
        // Hypothesis is resolved
        this._resolveHypothesis(id, outcome);
      }
    }
  }

  /**
   * Evaluate trend continuation hypothesis.
   */
  _evaluateTrendContinuation(hypothesis, state) {
    const { velocity, liquidity, lastUpdated } = state;
    // If velocity remains in same direction and liquidity is adequate, continuation likely
    const timeElapsed = Date.now() - hypothesis.createdAt;
    if (timeElapsed > 60000) {
      // After 1 minute, check if price moved in the expected direction
      const initialPrice = hypothesis.conditions.timestamp;
      const currentPrice = state.mid;
      // We need to track price history per hypothesis – simplified.
      // For now, we'll just assess based on velocity and liquidity.
      if (Math.abs(velocity) > 0.0001 && liquidity > 0.3) {
        return { confirmed: true, confidence: 70 + liquidity * 20 };
      } else {
        return { confirmed: false, confidence: 40 };
      }
    }
    return null; // still evaluating
  }

  /**
   * Evaluate trend reversal hypothesis.
   */
  _evaluateTrendReversal(hypothesis, state) {
    const { velocity, acceleration, liquidity } = state;
    // Reversal if velocity reverses and acceleration is negative
    if (Math.sign(velocity) !== Math.sign(hypothesis.conditions.confidence) && acceleration < 0) {
      return { confirmed: true, confidence: 65 };
    }
    return null;
  }

  /**
   * Evaluate breakout hypothesis.
   */
  _evaluateBreakout(hypothesis, state) {
    const { velocity, liquidity, spread } = state;
    // Breakout confirmed if velocity > threshold, liquidity high, spread low
    if (Math.abs(velocity) > 0.0002 && liquidity > 0.5 && spread < 0.0002) {
      return { confirmed: true, confidence: 75 };
    }
    // False breakout if velocity fails and liquidity drops
    if (Math.abs(velocity) < 0.00005 || liquidity < 0.2) {
      return { confirmed: false, confidence: 30, reason: 'breakout failed' };
    }
    return null;
  }

  /**
   * Evaluate momentum acceleration.
   */
  _evaluateMomentumAcceleration(hypothesis, state) {
    const { velocity, acceleration } = state;
    if (Math.abs(acceleration) > 0.0001 && Math.abs(velocity) > 0.0001) {
      return { confirmed: true, confidence: 70 };
    }
    if (Math.abs(velocity) < 0.00005) {
      return { confirmed: false, confidence: 20 };
    }
    return null;
  }

  /**
   * Evaluate volatility expansion.
   */
  _evaluateVolatilityExpansion(hypothesis, state) {
    const { spread, velocity } = state;
    if (spread > 0.0005 && Math.abs(velocity) > 0.0001) {
      return { confirmed: true, confidence: 75 };
    }
    if (spread < 0.0002) {
      return { confirmed: false, confidence: 25 };
    }
    return null;
  }

  /**
   * Evaluate liquidity shift.
   */
  _evaluateLiquidityShift(hypothesis, state) {
    const { liquidity, spread } = state;
    if (liquidity > 0.6 && spread < 0.0003) {
      return { confirmed: true, confidence: 70 };
    }
    if (liquidity < 0.2) {
      return { confirmed: false, confidence: 20 };
    }
    return null;
  }

  /**
   * Resolve a hypothesis with an outcome.
   */
  _resolveHypothesis(id, outcome) {
    const hypothesis = this._activeHypotheses.get(id);
    if (!hypothesis || hypothesis.status !== 'active') return;

    hypothesis.status = outcome.confirmed ? 'confirmed' : 'rejected';
    hypothesis.outcome = outcome;
    hypothesis.resolvedAt = Date.now();

    logger.info(`[Hypothesis] #${id} resolved: ${hypothesis.status} (conf: ${outcome.confidence})`);

    // Emit event for knowledge store / dashboard
    this.emit('hypothesisResolved', hypothesis);

    // Remove from active (or keep for history)
    this._activeHypotheses.delete(id);

    // Store in knowledge base if confidence is high
    if (outcome.confidence > 70) {
      // We'll emit a 'knowledge' event that the KnowledgeStore can listen to
      this.emit('knowledgeCandidate', {
        symbol: hypothesis.symbol,
        type: hypothesis.type,
        conditions: hypothesis.conditions,
        outcome: outcome,
        confidence: outcome.confidence,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Expire a hypothesis (no outcome within timeframe).
   */
  _expireHypothesis(id, reason) {
    const hypothesis = this._activeHypotheses.get(id);
    if (!hypothesis || hypothesis.status !== 'active') return;

    hypothesis.status = 'expired';
    hypothesis.expiryReason = reason;
    hypothesis.resolvedAt = Date.now();

    logger.info(`[Hypothesis] #${id} expired: ${reason}`);
    this.emit('hypothesisResolved', hypothesis);
    this._activeHypotheses.delete(id);
  }

  /**
   * Get active hypotheses for a symbol (for dashboard).
   */
  getActiveHypotheses(symbol) {
    const result = [];
    for (const [id, h] of this._activeHypotheses) {
      if (h.symbol === symbol) {
        result.push({ id, ...h });
      }
    }
    return result;
  }
}

module.exports = new HypothesisEngine();
