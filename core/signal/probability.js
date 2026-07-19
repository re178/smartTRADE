// core/signal/probability.js
// RTS Probability Engine
// Purpose: Estimate probabilities of price directions, expected moves, and risk of ruin.
// Answers: "What is the likelihood of each outcome, and what is the expected range?"

const EventEmitter = require('events');
const logger = require('../../infrastructure/logger') || console;

// Configuration
const CONFIG = {
  // Lookback periods for historical volatility and correlation
  VOLATILITY_LOOKBACK: 20,
  CORRELATION_LOOKBACK: 50,
  // Confidence adjustment factors
  REGIME_CONFIDENCE_FACTOR: 0.2,
  VOLATILITY_ADJUSTMENT: 0.1,
  // Default values when insufficient data
  DEFAULT_PROB_UP: 0.5,
  DEFAULT_EXPECTED_MOVE: 0.002,
  DEFAULT_RISK_OF_RUIN: 0.1,
};

class ProbabilityEngine extends EventEmitter {
  constructor() {
    super();
    this._historicalData = {}; // symbol -> { prices: [], returns: [], volatility: [] }
    this._correlationMatrix = {}; // symbol -> { peerSymbol: correlation }
  }

  /**
   * Update historical data with a new price/close.
   * Called by the Market Intelligence or data ingestion.
   * @param {string} symbol
   * @param {number} price - current price
   * @param {number} time - timestamp
   */
  updatePrice(symbol, price, time) {
    if (!this._historicalData[symbol]) {
      this._historicalData[symbol] = { prices: [], returns: [], volatility: [] };
    }
    const data = this._historicalData[symbol];
    // Add price, compute return if we have previous price
    if (data.prices.length > 0) {
      const lastPrice = data.prices[data.prices.length - 1];
      const ret = (price - lastPrice) / lastPrice;
      data.returns.push(ret);
      // Keep only last N returns for volatility
      if (data.returns.length > CONFIG.VOLATILITY_LOOKBACK * 2) {
        data.returns.shift();
      }
    }
    data.prices.push(price);
    // Keep only last N prices
    if (data.prices.length > CONFIG.VOLATILITY_LOOKBACK * 3) {
      data.prices.shift();
    }
    // Compute rolling volatility (standard deviation of returns)
    if (data.returns.length >= CONFIG.VOLATILITY_LOOKBACK) {
      const slice = data.returns.slice(-CONFIG.VOLATILITY_LOOKBACK);
      const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
      const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
      const vol = Math.sqrt(variance);
      data.volatility.push(vol);
      if (data.volatility.length > CONFIG.VOLATILITY_LOOKBACK * 2) {
        data.volatility.shift();
      }
    }
  }

  /**
   * Estimate directional probabilities, expected move, and risk of ruin.
   * @param {Object} decision - The decision from the fusion engine.
   * @param {Object} regime - The current market regime.
   * @param {Object} marketState - The market state from intelligence.
   * @param {Array} strategySignals - The raw signals from strategies (optional).
   * @returns {Object} probability estimates.
   */
  estimate(decision, regime, marketState, strategySignals = []) {
    const symbol = decision.symbol;
    const side = decision.decision;
    const confidence = decision.confidence / 100; // 0-1

    // Default probabilities
    let pUp = CONFIG.DEFAULT_PROB_UP;
    let pDown = 1 - pUp;
    let expectedMove = CONFIG.DEFAULT_EXPECTED_MOVE;
    let riskOfRuin = CONFIG.DEFAULT_RISK_OF_RUIN;

    try {
      // 1. Base probability from confidence (fusion confidence is already evidence-based)
      let baseProb = (confidence + 0.5) / 1.5; // Map confidence 0-100 to probability 0.33-0.83
      if (side === 'BUY') {
        pUp = Math.min(0.9, baseProb);
        pDown = 1 - pUp;
      } else if (side === 'SELL') {
        pDown = Math.min(0.9, baseProb);
        pUp = 1 - pDown;
      } else {
        return { pUp: 0.5, pDown: 0.5, expectedMove: 0, riskOfRuin: 0.5, direction: 'NEUTRAL' };
      }

      // 2. Adjust using market regime
      if (regime) {
        const regimeConf = regime.confidence / 100;
        if (regime.regime === 'STRONG_TREND_BULL' && side === 'BUY') {
          pUp += (1 - pUp) * 0.2 * regimeConf;
        } else if (regime.regime === 'STRONG_TREND_BEAR' && side === 'SELL') {
          pDown += (1 - pDown) * 0.2 * regimeConf;
        } else if (regime.regime === 'RANGING' && (side === 'BUY' || side === 'SELL')) {
          // In ranging markets, mean reversion has higher probability
          if (marketState && marketState.structure) {
            const atSupport = marketState.structure.isAtSupport;
            const atResistance = marketState.structure.isAtResistance;
            if (side === 'BUY' && atSupport) {
              pUp += (1 - pUp) * 0.15;
            } else if (side === 'SELL' && atResistance) {
              pDown += (1 - pDown) * 0.15;
            } else {
              // Not at key levels – lower confidence
              pUp *= 0.9;
              pDown *= 0.9;
            }
          }
        } else if (regime.regime === 'HIGH_VOLATILITY') {
          // In high volatility, spreads widen, slippage increases
          pUp *= 0.9;
          pDown *= 0.9;
        }
      }

      // Normalize pUp and pDown to sum to 1
      const total = pUp + pDown;
      pUp = pUp / total;
      pDown = pDown / total;

      // 3. Compute expected move (using ATR from marketState)
      if (marketState && marketState.volatility && marketState.volatility.atr) {
        expectedMove = marketState.volatility.atr * 1.5; // ~1.5x ATR expected move
      } else {
        // Fallback: use historical volatility
        const data = this._historicalData[symbol];
        if (data && data.volatility.length > 0) {
          const lastVol = data.volatility[data.volatility.length - 1];
          expectedMove = lastVol * 2; // 2 standard deviations
        }
      }

      // 4. Compute risk of ruin (probability of hitting stop-loss before take-profit)
      // Simplified: based on stop distance relative to expected move
      if (decision.stopLoss && decision.entryPrice && decision.takeProfit) {
        const slDist = Math.abs(decision.stopLoss - decision.entryPrice);
        const tpDist = Math.abs(decision.takeProfit - decision.entryPrice);
        if (slDist > 0 && tpDist > 0) {
          // Risk of ruin is roughly proportional to stop distance / (stop + take profit)
          riskOfRuin = slDist / (slDist + tpDist);
          // Adjust for volatility: if volatility is high, risk of ruin increases
          if (marketState && marketState.volatility && marketState.volatility.atr) {
            const atr = marketState.volatility.atr;
            const volFactor = Math.min(2, atr / (slDist * 0.5)); // if atr > 2*slDist, risk high
            riskOfRuin = Math.min(0.9, riskOfRuin * (1 + 0.5 * (volFactor - 1)));
          }
        }
      }

      // 5. Cap probabilities
      pUp = Math.min(0.95, Math.max(0.05, pUp));
      pDown = 1 - pUp;
      riskOfRuin = Math.min(0.9, Math.max(0.05, riskOfRuin));

    } catch (err) {
      logger.error('[ProbabilityEngine] Estimation error:', err.message);
      // Fallback to defaults
      if (side === 'BUY') { pUp = 0.6; pDown = 0.4; }
      else if (side === 'SELL') { pUp = 0.4; pDown = 0.6; }
      expectedMove = CONFIG.DEFAULT_EXPECTED_MOVE;
      riskOfRuin = CONFIG.DEFAULT_RISK_OF_RUIN;
    }

    return {
      symbol,
      direction: side,
      pUp: Math.round(pUp * 1000) / 1000,
      pDown: Math.round(pDown * 1000) / 1000,
      expectedMove: Math.round(expectedMove * 100000) / 100000,
      riskOfRuin: Math.round(riskOfRuin * 1000) / 1000,
      confidence: decision.confidence,
      // Additional derived metrics
      expectedPnl: (pUp - pDown) * expectedMove * 10000, // in pips
      riskRewardRatio: decision.takeProfit && decision.stopLoss ?
        Math.abs(decision.takeProfit - decision.entryPrice) / Math.abs(decision.stopLoss - decision.entryPrice) : 0,
    };
  }

  /**
   * Get historical volatility for a symbol (annualized or per candle).
   */
  getVolatility(symbol, period = CONFIG.VOLATILITY_LOOKBACK) {
    const data = this._historicalData[symbol];
    if (!data || data.returns.length < period) return null;
    const slice = data.returns.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
    return Math.sqrt(variance);
  }

  /**
   * Update correlation matrix (simplified – for demonstration).
   * In production, use rolling correlation across symbols.
   */
  updateCorrelation(symbol, peerSymbol, correlation) {
    if (!this._correlationMatrix[symbol]) {
      this._correlationMatrix[symbol] = {};
    }
    this._correlationMatrix[symbol][peerSymbol] = correlation;
  }

  /**
   * Get correlation between two symbols.
   */
  getCorrelation(symbol1, symbol2) {
    if (this._correlationMatrix[symbol1] && this._correlationMatrix[symbol1][symbol2] !== undefined) {
      return this._correlationMatrix[symbol1][symbol2];
    }
    return 0; // neutral
  }
}

// Singleton
const probabilityEngine = new ProbabilityEngine();
module.exports = probabilityEngine;
