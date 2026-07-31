// core/intelligence/deep/regime.js
// Deep Regime Detection – uses deep market state to classify regimes.
// Listens to candle closes, emits 'regime' events with confidence, reason, and session context.
// Publishes regime changes to DataOrchestrator for research/historical logging.

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

class DeepRegimeDetector {
  constructor() {
    // ---- DEBUG: log initialization ----
    console.log('🔧 DeepRegimeDetector: constructor – listening to candleStore');

    // Listen to candle closes from the candle builder/store
    candleStore.on('candleClosed', (candle) => {
      this._onCandleClose(candle);
    });

    // Also listen to developing state from deepMarketState (incremental)
    deepMarketState.on('stateDeveloping', (state) => {
      // We can emit a 'regimeDeveloping' event if needed.
      // For now, we'll just use it internally.
    });

    // Store latest regime per symbol
    this._latestRegime = {};
    this._lastRegimeCode = {}; // For tracking changes

    // ---- Register with DataOrchestrator ----
    dataOrchestrator.register('regimeChange', DATA_CLASSES.RESEARCH, {
      collection: 'historicalstates',
      batchSize: 50,
    });

    logger.info('[DeepRegimeDetector] Initialized, listening to candle closes.');
  }

  async _onCandleClose(candle) {
    const { symbol, timeframe } = candle;

    // ---- DEBUG: log when a candle is received ----
    console.log(`🔔 DeepRegimeDetector: received candle ${symbol} ${timeframe}`);

    // Only process primary timeframes (M5, M15, H1)
    const supportedTimeframes = ['M5', 'M15', 'H1'];
    if (!supportedTimeframes.includes(timeframe)) return;

    try {
      // ---- DEBUG: log before compute ----
      console.log(`🧠 DeepRegimeDetector: calling deepMarketState.compute() for ${symbol} ${timeframe}`);

      // Get the deep market state (full, confirmed)
      const state = await deepMarketState.compute(symbol, timeframe, 200);
      if (!state) {
        console.log(`⚠️ DeepRegimeDetector: deepMarketState.compute() returned null for ${symbol} ${timeframe}`);
        logger.warn(`[DeepRegimeDetector] No deep state for ${symbol}:${timeframe}`);
        return;
      }

      // ---- DEBUG: log compute success ----
      console.log(`✅ DeepRegimeDetector: deepMarketState.compute() succeeded for ${symbol} ${timeframe}, confidence ${state.confidence}`);

      // Classify the regime
      const regime = this._classifyRegime(state);

      // Calculate confidence
      regime.confidence = this._calculateConfidence(state, regime);

      // Add reasoning (human‑readable)
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

      // Store latest
      this._latestRegime[symbol] = regime;

      // ---- DEBUG: log regime emission ----
      console.log(`📢 DeepRegimeDetector: emitting regime ${regime.code} for ${symbol} with confidence ${regime.confidence}%`);

      // Emit regime event
      this.emit('regime', {
        symbol,
        timeframe,
        ...regime,
        timestamp: new Date().toISOString(),
      });

      // ---- PUBLISH TO DATAORCHESTRATOR (if regime changed) ----
      const prevCode = this._lastRegimeCode[symbol] || null;
      if (prevCode !== regime.code) {
        this._lastRegimeCode[symbol] = regime.code;
        dataOrchestrator.publish('regimeChange', {
          symbol,
          timeframe,
          timestamp: new Date().toISOString(),
          regime: {
            code: regime.code,
            name: regime.name,
            confidence: regime.confidence,
            description: regime.description,
            family: regime.family,
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

        logger.debug(`[DeepRegimeDetector] ${symbol} regime change: ${prevCode || 'None'} → ${regime.code}`);
      }

      logger.debug(`[DeepRegimeDetector] ${symbol}:${timeframe} → ${regime.code} (${Math.round(regime.confidence)}%)`);
    } catch (err) {
      console.error(`❌ DeepRegimeDetector: error for ${symbol}:${timeframe}`, err.message);
      logger.error(`[DeepRegimeDetector] Error for ${symbol}:${timeframe}`, err.message);
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
      case 'REVERSAL':
        const rsiExtreme = Math.abs(rsi - 50) / 50;
        confidence = 60 + rsiExtreme * 20;
        break;
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
   * Build a human‑readable reason for the regime classification.
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
   * Get the latest regime for a symbol.
   */
  getLatestRegime(symbol) {
    return this._latestRegime[symbol] || null;
  }
}

// Add EventEmitter methods
const EventEmitter = require('events');
Object.setPrototypeOf(DeepRegimeDetector.prototype, EventEmitter.prototype);

module.exports = new DeepRegimeDetector();
