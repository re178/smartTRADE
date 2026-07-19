// core/market/regime.js
// RTS Market Regime Detection Engine
// Purpose: Classify the current market environment into actionable regimes.
// Answers: "What type of market are we in, and how confident are we?"

const EventEmitter = require('events');
const marketIntelligence = require('./intelligence');
const logger = require('../../infrastructure/logger') || console;

// Regime definitions with their ideal strategy families and risk multipliers
const REGIME_DEFINITIONS = {
  STRONG_TREND_BULL: {
    name: 'Strong Bullish Trend',
    code: 'STRONG_TREND_BULL',
    family: 'trend',
    idealStrategies: ['SMA', 'EMA', 'SuperTrend', 'Ichimoku'],
    riskMultiplier: 0.9,
    maxPositions: 3,
    description: 'ADX > 30, EMA slopes aligned upward, price above key moving averages.',
  },
  STRONG_TREND_BEAR: {
    name: 'Strong Bearish Trend',
    code: 'STRONG_TREND_BEAR',
    family: 'trend',
    idealStrategies: ['SMA', 'EMA', 'SuperTrend', 'Ichimoku'],
    riskMultiplier: 0.9,
    maxPositions: 3,
    description: 'ADX > 30, EMA slopes aligned downward, price below key moving averages.',
  },
  WEAK_TREND: {
    name: 'Weak Trend',
    code: 'WEAK_TREND',
    family: 'trend',
    idealStrategies: ['MACD', 'ATRBreakout'],
    riskMultiplier: 0.8,
    maxPositions: 2,
    description: 'ADX 20–30, price making higher highs/lows but with pullbacks.',
  },
  RANGING: {
    name: 'Ranging Market',
    code: 'RANGING',
    family: 'range',
    idealStrategies: ['Bollinger', 'RSI', 'SupportResistance'],
    riskMultiplier: 0.7,
    maxPositions: 2,
    description: 'ADX < 20, price oscillating between support and resistance, Choppiness > 60.',
  },
  HIGH_VOLATILITY: {
    name: 'High Volatility',
    code: 'HIGH_VOLATILITY',
    family: 'volatile',
    idealStrategies: ['ATRBreakout', 'SuperTrend'],
    riskMultiplier: 0.6,
    maxPositions: 1,
    description: 'ATR > 1.5x average, spread widening, aggressive moves.',
  },
  LOW_VOLATILITY: {
    name: 'Low Volatility',
    code: 'LOW_VOLATILITY',
    family: 'quiet',
    idealStrategies: ['Bollinger', 'RSI'],
    riskMultiplier: 0.5,
    maxPositions: 1,
    description: 'ATR < 0.5x average, price compressed, low volume.',
  },
  BREAKOUT: {
    name: 'Breakout',
    code: 'BREAKOUT',
    family: 'breakout',
    idealStrategies: ['ATRBreakout', 'SupportResistance'],
    riskMultiplier: 1.0,
    maxPositions: 2,
    description: 'Price breaks a key S/R level with increased volume and volatility.',
  },
  REVERSAL: {
    name: 'Reversal Zone',
    code: 'REVERSAL',
    family: 'reversal',
    idealStrategies: ['RSI', 'MACD', 'SupportResistance'],
    riskMultiplier: 0.7,
    maxPositions: 2,
    description: 'RSI divergence, price at extreme, signs of exhaustion.',
  },
  NEUTRAL: {
    name: 'Neutral / Mixed Signals',
    code: 'NEUTRAL',
    family: 'mixed',
    idealStrategies: ['WeightedVote', 'AI'],
    riskMultiplier: 0.5,
    maxPositions: 1,
    description: 'No clear edge; conflicting indicators.',
  },
};

// Session multipliers for liquidity adjustments
const SESSION_MULTIPLIERS = {
  London: 1.5,
  'New York': 1.5,
  Asia: 0.8,
  Sydney: 0.7,
  Other: 0.6,
};

class RegimeEngine extends EventEmitter {
  constructor() {
    super();
    this._lastRegime = new Map(); // symbol -> current regime
    this._regimeHistory = new Map(); // symbol -> array of recent regimes
    this._config = {
      historyLength: 50,
      // Thresholds (can be tuned from env)
      trendADX: 30,
      weakTrendADX: 20,
      rangeADX: 20,
      highVolATRMult: 1.5,
      lowVolATRMult: 0.5,
      highChoppiness: 60,
      lowChoppiness: 40,
    };

    // Listen to market state updates from the intelligence engine
    marketIntelligence.on('marketState', (state) => {
      this._classify(state);
    });

    logger.info('[RegimeEngine] Initialized.');
  }

  /**
   * Core classification method – runs on every market state update.
   */
  _classify(state) {
    try {
      const { symbol, trend, momentum, volatility, structure, session } = state;
      const { adx } = trend;
      const { rsi, macdHist } = momentum;
      const { atrPercent, bbWidth, regime: volRegime } = volatility;
      const { isAtSupport, isAtResistance } = structure;

      // ---- STEP 1: Primary regime detection ----

      let regimeCode = 'NEUTRAL';
      let confidence = 50;

      // Check for STRONG TREND
      if (adx > this._config.trendADX) {
        if (trend.direction === 'bullish') {
          regimeCode = 'STRONG_TREND_BULL';
          confidence = 80 + (adx - 30) * 0.5;
        } else if (trend.direction === 'bearish') {
          regimeCode = 'STRONG_TREND_BEAR';
          confidence = 80 + (adx - 30) * 0.5;
        } else {
          // ADX high but no clear direction – could be an emerging trend
          regimeCode = 'WEAK_TREND';
          confidence = 60;
        }
      }
      // Check for BREAKOUT
      else if (isAtSupport || isAtResistance) {
        // Breakout if price breaks a key level with volume
        // We need historical context; we can use previous state.
        const prevState = this._lastRegime.get(symbol);
        const prevPricePosition = prevState?.structure?.pricePosition || 0.5;
        const currentPricePosition = structure.pricePosition;
        if (currentPricePosition > 0.95 && prevPricePosition < 0.8) {
          // Breakout above resistance
          regimeCode = 'BREAKOUT';
          confidence = 70;
        } else if (currentPricePosition < 0.05 && prevPricePosition > 0.2) {
          // Breakdown below support
          regimeCode = 'BREAKOUT';
          confidence = 70;
        }
      }
      // Check for RANGING
      else if (adx < this._config.rangeADX && bbWidth < 0.15) {
        regimeCode = 'RANGING';
        confidence = 70;
      }
      // Check for HIGH VOLATILITY
      else if (volRegime === 'high') {
        regimeCode = 'HIGH_VOLATILITY';
        confidence = 75;
      }
      // Check for LOW VOLATILITY
      else if (volRegime === 'low') {
        regimeCode = 'LOW_VOLATILITY';
        confidence = 65;
      }
      // Check for REVERSAL ZONE
      else if ((rsi > 70 || rsi < 30) && (isAtSupport || isAtResistance)) {
        regimeCode = 'REVERSAL';
        confidence = 65 + (Math.abs(rsi - 50) / 20) * 10;
      }
      // If none matched, but adx is between 20-30, it's a weak trend
      else if (adx > this._config.weakTrendADX && adx < this._config.trendADX) {
        regimeCode = 'WEAK_TREND';
        confidence = 55;
      }

      // ---- STEP 2: Adjust confidence with session multiplier ----
      const sessionMult = SESSION_MULTIPLIERS[session.name] || 1.0;
      confidence = Math.min(100, confidence * sessionMult);

      // ---- STEP 3: Build the Regime object ----
      const definition = REGIME_DEFINITIONS[regimeCode];
      const regime = {
        symbol,
        regime: regimeCode,
        name: definition.name,
        family: definition.family,
        idealStrategies: definition.idealStrategies,
        riskMultiplier: definition.riskMultiplier,
        maxPositions: definition.maxPositions,
        confidence: Math.round(confidence),
        description: definition.description,
        timestamp: new Date(state.time).toISOString(),
        metadata: {
          adx,
          rsi,
          atrPercent,
          bbWidth,
          session: session.name,
          isAtSupport,
          isAtResistance,
        },
        // Recommendations
        recommendations: {
          riskAdjustment: definition.riskMultiplier,
          maxPositions: definition.maxPositions,
          preferredStrategies: definition.idealStrategies,
        },
      };

      // Store history
      if (!this._regimeHistory.has(symbol)) {
        this._regimeHistory.set(symbol, []);
      }
      const history = this._regimeHistory.get(symbol);
      history.push(regime);
      if (history.length > this._config.historyLength) {
        history.shift();
      }

      // Store last regime
      this._lastRegime.set(symbol, regime);

      // Emit the event
      this.emit('regime', regime);

    } catch (err) {
      logger.error('[RegimeEngine] Classification error:', err.message);
    }
  }

  /**
   * Get the current regime for a symbol.
   */
  getRegime(symbol) {
    return this._lastRegime.get(symbol) || null;
  }

  /**
   * Get regime history for a symbol.
   */
  getRegimeHistory(symbol, limit = 20) {
    const history = this._regimeHistory.get(symbol) || [];
    return history.slice(-limit);
  }

  /**
   * Check if a given strategy is compatible with the current regime.
   */
  isStrategyCompatible(symbol, strategyName) {
    const regime = this.getRegime(symbol);
    if (!regime) return true; // assume compatible if no regime
    if (regime.confidence < 40) return true; // low confidence, don't filter
    return regime.idealStrategies.includes(strategyName) || regime.family === 'mixed';
  }

  /**
   * Suggest a strategy weight adjustment based on regime.
   */
  getStrategyWeightModifier(symbol, strategyName) {
    const regime = this.getRegime(symbol);
    if (!regime) return 1.0;
    if (regime.idealStrategies.includes(strategyName)) {
      return 1.2 + (regime.confidence - 50) / 100;
    }
    if (regime.family === 'mixed') return 0.8;
    return 0.5 + (regime.confidence - 50) / 200;
  }
}

// Singleton
const regimeEngine = new RegimeEngine();
module.exports = regimeEngine;
