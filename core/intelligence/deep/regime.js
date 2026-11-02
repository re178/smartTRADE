// core/intelligence/deep/regime.js
// Deep Regime Detection – uses deep market state to classify regimes.
// Listens to candle closes, emits 'regime' events with confidence, reason, and session context.
// Publishes regime changes to DataOrchestrator for research/historical logging.
//
// [FIX-RG1] Proper EventEmitter inheritance. The original code did
//           `Object.setPrototypeOf(DeepRegimeDetector.prototype, EventEmitter.prototype)`
//           without calling `super()` — meaning `_events`, `_eventsCount`, and
//           `_maxListeners` were never initialized on the instance. `.on()` and
//           `.emit()` worked by accident in most Node versions (lazy init of
//           `_events`), but broke edge cases: `.once()`, `.rawListeners()`,
//           `removeAllListeners()`, error event handling, and any code path
//           that inspects `_eventsCount` before the first `.on()` call. Now
//           uses `class ... extends EventEmitter` + `super()`.
// [FIX-RG2] Symbol keys are canonicalized (uppercase, no separators, no
//           'frx' prefix) before storing in `_latestRegime` / `_lastRegimeCode`.
//           `getLatestRegime()` normalizes the lookup key too. Fixes a latent
//           miss when callers mixed 'EURUSD' with 'EUR_USD'.
// [FIX-RG3] `_onCandleClose` now logs failures (throttled per symbol to once
//           per 5 min) instead of swallowing them silently. Previously any
//           exception inside regime classification made regime detection
//           stop for that symbol without a trace.
// [FIX-RG4] regimeChange publishes are rate-limited to once per 30s per
//           symbol. Prevents oscillation spam when a symbol flips between
//           NEUTRAL and WEAK_TREND every candle.
// [FIX-RG5] Defensive canonicalization of the regime code before publish.
//           `_classifyRegime` always returns a valid code, but this guards
//           against future modifications accidentally introducing an
//           out-of-list value.
// [FIX-RG6] Guards against malformed candle input — `candle.symbol` and
//           `candle.timeframe` are now validated before processing.
// [FIX-RG7] The dead `deepMarketState.on('stateDeveloping', ...)` listener
//           is removed. `deepMarketState` never emits that event — this was
//           placeholder code that never fired.
// [FIX-RG8] The regimeChange publish now includes `riskMultiplier`,
//           `maxPositions`, and `idealStrategies` (they were computed in
//           `_classifyRegime` but not propagated). Downstream consumers can
//           now read them without a separate `getLatestRegime()` call.

const EventEmitter = require('events');
const candleStore = require('../../data/candleStore');
const deepMarketState = require('./marketState');
const session = require('../session');
const { dataOrchestrator, DATA_CLASSES } = require('../../data/dataOrchestrator');
const logger = require('../../../infrastructure/logger') || console;

// Regime definitions (matching the master prompt)
const REGIME_TYPES = {
  STRONG_TREND_BULL: 'Strong Bullish Trend',
  STRONG_TREND_BEAR: 'Strong Bearish Trend',
  WEAK_TREND: 'Weak Trend',
  RANGING: 'Ranging Market',
  HIGH_VOLATILITY: 'High Volatility',
  LOW_VOLATILITY: 'Low Volatility',
  BREAKOUT: 'Breakout',
  REVERSAL: 'Reversal Zone',
  NEUTRAL: 'Neutral / Mixed',
};

const IDEAL_STRATEGIES = {
  STRONG_TREND_BULL: ['SMA', 'EMA', 'SuperTrend', 'Ichimoku'],
  STRONG_TREND_BEAR: ['SMA', 'EMA', 'SuperTrend', 'Ichimoku'],
  WEAK_TREND: ['MACD', 'ATRBreakout'],
  RANGING: ['Bollinger', 'RSI', 'SupportResistance'],
  HIGH_VOLATILITY: ['ATRBreakout', 'SuperTrend'],
  LOW_VOLATILITY: ['Bollinger', 'RSI'],
  BREAKOUT: ['ATRBreakout', 'SupportResistance'],
  REVERSAL: ['RSI', 'MACD', 'SupportResistance'],
  NEUTRAL: ['WeightedVote', 'AI'],
};

// [FIX-RG3] Throttle window for per-symbol error logs.
const ERROR_LOG_THROTTLE_MS = 5 * 60 * 1000;

// [FIX-RG4] Minimum time between regimeChange publishes for the same symbol.
const REGIME_CHANGE_MIN_INTERVAL_MS = 30 * 1000;

// [FIX-RG1] Proper inheritance.
class DeepRegimeDetector extends EventEmitter {
  constructor() {
    // [FIX-RG1] super() MUST be first — initializes _events, _eventsCount,
    // _maxListeners on the instance before any other code runs.
    super();

    // Listen to candle closes from the candle builder/store
    candleStore.on('candleClosed', (candle) => {
      this._onCandleClose(candle);
    });

    // [FIX-RG7] Removed dead listener: deepMarketState never emits
    // 'stateDeveloping' (see marketState.js — the only emit is 'candleClosed'
    // from candleStore, and no 'stateDeveloping' emit exists). If that
    // event is added later, re-add this listener then.

    // Store latest regime per symbol (canonical keys — [FIX-RG2])
    this._latestRegime = {};
    this._lastRegimeCode = {}; // For tracking changes
    // [FIX-RG3] Per-symbol throttle for error logs.
    this._errorLoggedAt = {};
    // [FIX-RG4] Per-symbol last-publish timestamps for regimeChange.
    this._lastRegimeChangeAt = {};

    // ---- Register with DataOrchestrator ----
    dataOrchestrator.register('regimeChange', DATA_CLASSES.RESEARCH, {
      collection: 'historicalstates',
      batchSize: 50,
    });
  }

  // [FIX-RG2] Canonical symbol normalization — matches what
  // deepMarketState._normalizeSymbol produces.
  _normalizeSymbol(symbol) {
    if (!symbol) return '';
    return String(symbol).replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
  }

  // [FIX-RG3] Throttled error logging.
  _logErrorOnce(symbol, message) {
    const key = symbol || '?';
    const now = Date.now();
    const last = this._errorLoggedAt[key] || 0;
    if (now - last < ERROR_LOG_THROTTLE_MS) return;
    this._errorLoggedAt[key] = now;
    logger.warn(`[DeepRegime] ${key}: ${message} (throttled ${ERROR_LOG_THROTTLE_MS / 1000}s)`);
  }

  async _onCandleClose(candle) {
    // [FIX-RG6] Guard against malformed candle input.
    if (!candle || !candle.symbol || !candle.timeframe) return;
    const { symbol, timeframe } = candle;

    // Only process primary timeframes (M5, M15, H1)
    const supportedTimeframes = ['M5', 'M15', 'H1'];
    if (!supportedTimeframes.includes(timeframe)) return;

    try {
      // Get the deep market state (full, confirmed)
      const state = await deepMarketState.compute(symbol, timeframe, 200);
      if (!state) {
        return;
      }

      // Classify the regime
      const regime = this._classifyRegime(state);

      // Calculate confidence
      regime.confidence = this._calculateConfidence(state, regime);

      // Add reasoning (human-readable)
      regime.reason = this._buildReason(state, regime);

      // Add session context
      regime.session = state.session || { name: 'unknown', liquidityMultiplier: 1 };

      // Add awareness context (if available)
      if (state.awareness) {
        regime.awareness = {
          liquidity: state.awareness.liquidity,
          velocity: state.awareness.velocity,
          acceleration: state.awareness.acceleration,
          unusualEvents: state.awareness.unusualEvents || [],
        };
      }

      // [FIX-RG2] Canonical symbol for internal maps.
      const canonical = this._normalizeSymbol(symbol);

      // Store latest (canonical key)
      this._latestRegime[canonical] = regime;

      // Emit regime event
      this.emit('regime', {
        symbol,
        timeframe,
        ...regime,
        timestamp: new Date().toISOString(),
      });

      // ---- PUBLISH TO DATAORCHESTRATOR (if regime changed) ----
      const prevCode = this._lastRegimeCode[canonical] || null;

      // [FIX-RG4] Rate limit — skip if same code, OR if we published very
      // recently for this symbol (guards against oscillation).
      if (prevCode === regime.code) {
        return;
      }
      const lastPublishAt = this._lastRegimeChangeAt[canonical] || 0;
      if (Date.now() - lastPublishAt < REGIME_CHANGE_MIN_INTERVAL_MS) {
        // Code differs but we published too recently — update the tracked
        // code so we don't re-trigger on the next candle, but skip the publish.
        this._lastRegimeCode[canonical] = regime.code;
        return;
      }

      this._lastRegimeCode[canonical] = regime.code;
      this._lastRegimeChangeAt[canonical] = Date.now();

      // [FIX-RG5] Defensive canonicalization — regime.code always comes from
      // _classifyRegime which only returns valid codes, but this guard
      // prevents future changes from silently publishing an invalid value.
      const publishCode = Object.prototype.hasOwnProperty.call(REGIME_TYPES, regime.code)
        ? regime.code
        : 'NEUTRAL';

      dataOrchestrator.publish('regimeChange', {
        symbol: canonical,
        timeframe,
        timestamp: new Date().toISOString(),
        regime: {
          code: publishCode,
          name: regime.name,
          confidence: regime.confidence,
          description: regime.description,
          family: regime.family,
          // [FIX-RG8] Include the fields computed in _classifyRegime that
          // downstream consumers may need.
          riskMultiplier: regime.riskMultiplier,
          maxPositions: regime.maxPositions,
          idealStrategies: regime.idealStrategies,
        },
        previousRegime: prevCode,
        state: {
          price: state.price,
          trend: state.trend,
          momentum: state.momentum,
          volatility: state.volatility,
          structure: state.structure,
          session: state.session,
          summary: state.summary,
          awareness: state.awareness || {},
        },
        reason: regime.reason,
        source: 'deepRegimeDetector',
      }, { source: 'regimeChange' });
    } catch (err) {
      // [FIX-RG3] Log instead of silent drop.
      this._logErrorOnce(symbol, `_onCandleClose error: ${err.message}`);
    }
  }

  /**
   * Classify the regime from the deep state.
   */
  _classifyRegime(state) {
    const { trend, momentum, volatility, structure } = state;

    const adx = trend.strength;
    const rsi = momentum.rsi;
    const bbWidth = volatility.bbWidth;
    const atrPercent = volatility.atrPercent;
    const isAtSupport = structure.isAtSupport;
    const isAtResistance = structure.isAtResistance;

    // 1. Strong Trend (Bullish / Bearish)
    if (adx > 30) {
      if (trend.direction === 'bullish') {
        return {
          code: 'STRONG_TREND_BULL',
          name: REGIME_TYPES.STRONG_TREND_BULL,
          family: 'trend',
          idealStrategies: IDEAL_STRATEGIES.STRONG_TREND_BULL,
          riskMultiplier: 0.9,
          maxPositions: 3,
          description: 'Strong bullish trend with high ADX.',
        };
      } else if (trend.direction === 'bearish') {
        return {
          code: 'STRONG_TREND_BEAR',
          name: REGIME_TYPES.STRONG_TREND_BEAR,
          family: 'trend',
          idealStrategies: IDEAL_STRATEGIES.STRONG_TREND_BEAR,
          riskMultiplier: 0.9,
          maxPositions: 3,
          description: 'Strong bearish trend with high ADX.',
        };
      }
    }

    // 2. Breakout
    if ((isAtSupport || isAtResistance) && bbWidth > 0.1) {
      return {
        code: 'BREAKOUT',
        name: REGIME_TYPES.BREAKOUT,
        family: 'breakout',
        idealStrategies: IDEAL_STRATEGIES.BREAKOUT,
        riskMultiplier: 1.0,
        maxPositions: 2,
        description: 'Price approaching or breaking key support/resistance with expanding volatility.',
      };
    }

    // 3. High Volatility
    if (volatility.regime === 'high' && atrPercent > 0.005) {
      return {
        code: 'HIGH_VOLATILITY',
        name: REGIME_TYPES.HIGH_VOLATILITY,
        family: 'volatile',
        idealStrategies: IDEAL_STRATEGIES.HIGH_VOLATILITY,
        riskMultiplier: 0.6,
        maxPositions: 1,
        description: 'Elevated volatility with large price swings.',
      };
    }

    // 4. Low Volatility
    if (volatility.regime === 'low' && atrPercent < 0.001) {
      return {
        code: 'LOW_VOLATILITY',
        name: REGIME_TYPES.LOW_VOLATILITY,
        family: 'quiet',
        idealStrategies: IDEAL_STRATEGIES.LOW_VOLATILITY,
        riskMultiplier: 0.5,
        maxPositions: 1,
        description: 'Compressed volatility, tight price action.',
      };
    }

    // 5. Ranging
    if (adx < 20 && bbWidth < 0.15) {
      return {
        code: 'RANGING',
        name: REGIME_TYPES.RANGING,
        family: 'range',
        idealStrategies: IDEAL_STRATEGIES.RANGING,
        riskMultiplier: 0.7,
        maxPositions: 2,
        description: 'Sideways market with low ADX and narrow Bollinger bands.',
      };
    }

    // 6. Reversal Zone
    if ((rsi > 70 || rsi < 30) && (isAtSupport || isAtResistance)) {
      return {
        code: 'REVERSAL',
        name: REGIME_TYPES.REVERSAL,
        family: 'reversal',
        idealStrategies: IDEAL_STRATEGIES.REVERSAL,
        riskMultiplier: 0.7,
        maxPositions: 2,
        description: 'Overbought/oversold RSI at support/resistance, potential reversal.',
      };
    }

    // 7. Weak Trend
    if (adx >= 20 && adx < 30) {
      return {
        code: 'WEAK_TREND',
        name: REGIME_TYPES.WEAK_TREND,
        family: 'trend',
        idealStrategies: IDEAL_STRATEGIES.WEAK_TREND,
        riskMultiplier: 0.8,
        maxPositions: 2,
        description: 'Moderate trend strength, choppy price action.',
      };
    }

    // 8. Neutral (default)
    return {
      code: 'NEUTRAL',
      name: REGIME_TYPES.NEUTRAL,
      family: 'mixed',
      idealStrategies: IDEAL_STRATEGIES.NEUTRAL,
      riskMultiplier: 0.5,
      maxPositions: 1,
      description: 'Mixed signals, no clear regime.',
    };
  }

  /**
   * Calculate confidence for the regime classification.
   */
  _calculateConfidence(state, regime) {
    let confidence = 50;

    const { trend, momentum, volatility, session } = state;
    const adx = trend.strength;
    const rsi = momentum.rsi;
    const bbWidth = volatility.bbWidth;
    const atrPercent = volatility.atrPercent;

    switch (regime.code) {
      case 'STRONG_TREND_BULL':
      case 'STRONG_TREND_BEAR':
        confidence = 70 + Math.min(30, adx - 30) * 0.5;
        break;
      case 'RANGING':
        confidence = 60 + (100 - adx) * 0.3;
        break;
      case 'HIGH_VOLATILITY':
        confidence = 65 + (atrPercent * 10);
        break;
      case 'LOW_VOLATILITY':
        confidence = 60 + (1 - atrPercent * 10);
        break;
      case 'BREAKOUT':
        confidence = 65 + (bbWidth * 10);
        break;
      case 'REVERSAL': {
        const rsiExtreme = Math.abs(rsi - 50) / 50;
        confidence = 60 + rsiExtreme * 20;
        break;
      }
      case 'WEAK_TREND':
        confidence = 55 + (adx - 20) * 0.5;
        break;
      default:
        confidence = 50;
    }

    if (session && session.liquidityMultiplier) {
      const liqMult = session.liquidityMultiplier;
      if (liqMult > 1.2) confidence += 5;
      else if (liqMult < 0.8) confidence -= 5;
    }

    if (state.awareness) {
      const { liquidity, velocity } = state.awareness;
      if (regime.family === 'trend' && liquidity > 0.7) {
        confidence += 10;
      }
      if (regime.code === 'BREAKOUT' && liquidity < 0.3) {
        confidence -= 10;
      }
      if (Math.abs(velocity) > 0.0001 && (regime.code === 'STRONG_TREND_BULL' || regime.code === 'STRONG_TREND_BEAR')) {
        confidence += 5;
      }
    }

    return Math.min(100, Math.max(0, confidence));
  }

  /**
   * Build a human-readable reason for the regime classification.
   */
  _buildReason(state, regime) {
    const parts = [];
    const { trend, momentum, volatility, structure, session } = state;

    parts.push(`ADX: ${trend.strength.toFixed(1)} (${trend.direction})`);
    if (momentum.rsi) parts.push(`RSI: ${momentum.rsi.toFixed(1)}`);
    if (momentum.macdHist !== undefined) parts.push(`MACD: ${momentum.macdHist.toFixed(4)}`);
    if (volatility.regime) parts.push(`Vol: ${volatility.regime}`);
    if (structure.isAtSupport) parts.push('At support');
    if (structure.isAtResistance) parts.push('At resistance');
    if (session && session.name) parts.push(`Session: ${session.name}`);
    parts.push(`=> ${regime.name}`);

    return parts.join(' | ');
  }

  /**
   * [FIX-RG2] Get the latest regime for a symbol.
   * Canonicalizes the lookup key so 'EURUSD' and 'EUR_USD' both work.
   */
  getLatestRegime(symbol) {
    const canonical = this._normalizeSymbol(symbol);
    return this._latestRegime[canonical]
        || this._latestRegime[symbol]
        || null;
  }
}

module.exports = new DeepRegimeDetector();
