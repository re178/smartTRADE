// core/intelligence/deep/regime.js
// Deep Regime Detection – uses deep market state to classify regimes.
// Listens to candle closes, emits 'regime' events with confidence.

const candleStore = require('../../data/candleStore');
const deepMarketState = require('./marketState');
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

// Ideal strategies per regime
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

class DeepRegimeDetector {
  constructor() {
    // Listen to candle closes from the candle builder/store
    candleStore.on('candleClosed', (candle) => {
      this._onCandleClose(candle);
    });

    logger.info('[DeepRegimeDetector] Initialized, listening to candle closes.');
  }

  async _onCandleClose(candle) {
    const { symbol, timeframe } = candle;

    // Only process primary timeframes (e.g., M5, H1)
    // We could filter, but we'll process all to keep flexibility.
    // However, to avoid duplicate work, we'll only process if it's a timeframe we care about.
    // We'll use a configurable list.
    const supportedTimeframes = ['M5', 'M15', 'H1'];
    if (!supportedTimeframes.includes(timeframe)) return;

    try {
      // Get the deep market state
      const state = await deepMarketState.compute(symbol, timeframe, 200);
      if (!state) {
        logger.warn(`[DeepRegimeDetector] No deep state for ${symbol}:${timeframe}`);
        return;
      }

      // Classify the regime
      const regime = this._classifyRegime(state);

      // Add reasoning and confidence
      regime.confidence = this._calculateConfidence(state, regime);

      // Add awareness context (if available)
      const awareness = state.awareness;
      if (awareness) {
        regime.awareness = {
          liquidity: awareness.liquidity,
          velocity: awareness.velocity,
          acceleration: awareness.acceleration,
          unusualEvents: awareness.unusualEvents || [],
        };
      }

      // Emit regime event
      this.emit('regime', {
        symbol,
        timeframe,
        ...regime,
        timestamp: new Date().toISOString(),
      });

      logger.debug(`[DeepRegimeDetector] ${symbol}:${timeframe} → ${regime.code} (${Math.round(regime.confidence)}%)`);
    } catch (err) {
      logger.error(`[DeepRegimeDetector] Error for ${symbol}:${timeframe}`, err.message);
    }
  }

  /**
   * Classify the regime from the deep state.
   */
  _classifyRegime(state) {
    const { trend, momentum, volatility, structure, summary } = state;

    // Extract key metrics
    const adx = trend.strength;
    const rsi = momentum.rsi;
    const bbWidth = volatility.bbWidth;
    const atrPercent = volatility.atrPercent;
    const isAtSupport = structure.isAtSupport;
    const isAtResistance = structure.isAtResistance;
    const pricePosition = structure.pricePosition;

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
      // If ADX > 30 but direction unclear, fallback to weak trend
    }

    // 2. Breakout
    if ((isAtSupport || isAtResistance) && bbWidth > 0.1) {
      // Check if price just broke a level (we need previous state, but we'll approximate)
      // For simplicity, assume breakout if at extreme and bbWidth expanding
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
    let confidence = 50; // base

    const { trend, momentum, volatility, structure } = state;
    const adx = trend.strength;
    const rsi = momentum.rsi;
    const bbWidth = volatility.bbWidth;
    const atrPercent = volatility.atrPercent;

    // Adjust confidence based on regime type
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
      case 'REVERSAL':
        const rsiExtreme = Math.abs(rsi - 50) / 50; // 0-1
        confidence = 60 + rsiExtreme * 20;
        break;
      case 'WEAK_TREND':
        confidence = 55 + (adx - 20) * 0.5;
        break;
      default:
        confidence = 50;
    }

    // Adjust for awareness (liquidity, velocity)
    if (state.awareness) {
      const { liquidity, velocity } = state.awareness;
      // High liquidity increases confidence in trending regimes
      if (regime.family === 'trend' && liquidity > 0.7) {
        confidence += 10;
      }
      // Low liquidity reduces confidence in breakout regimes
      if (regime.code === 'BREAKOUT' && liquidity < 0.3) {
        confidence -= 10;
      }
      // High velocity confirms momentum
      if (Math.abs(velocity) > 0.0001 && (regime.code === 'STRONG_TREND_BULL' || regime.code === 'STRONG_TREND_BEAR')) {
        confidence += 5;
      }
    }

    // Cap at 100
    return Math.min(100, Math.max(0, confidence));
  }
}

// Add EventEmitter methods
const EventEmitter = require('events');
Object.setPrototypeOf(DeepRegimeDetector.prototype, EventEmitter.prototype);

module.exports = new DeepRegimeDetector();
