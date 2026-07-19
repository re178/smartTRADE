// core/risk/intelligence.js
// RTS Multi‑Level Risk Intelligence Engine
// Purpose: Manage risk at trade, portfolio, and systemic levels.
// Answers: "Is this trade safe to take? How much should we risk? Should we pause trading?"

const EventEmitter = require('events');
const marketIntelligence = require('../market/intelligence');
const regimeEngine = require('../market/regime');
const accountService = require('../portfolio/accountService');
const orderService = require('../execution/orderService');
const { getBroker } = require('../execution/brokerFactory');
const { getPipSize } = require('../../shared/helpers');
const logger = require('../../infrastructure/logger') || console;

// Configuration (all tunable via environment)
const CONFIG = {
  // Trade-level
  MAX_RISK_PER_TRADE_PCT: parseFloat(process.env.MAX_RISK_PER_TRADE_PCT) || 2,
  MIN_RISK_PER_TRADE_PCT: parseFloat(process.env.MIN_RISK_PER_TRADE_PCT) || 0.5,
  DEFAULT_RISK_PER_TRADE_PCT: parseFloat(process.env.RISK_PER_TRADE) || 1,
  MIN_RR_RATIO: parseFloat(process.env.MIN_RR_RATIO) || 1.5,
  MAX_SLIPPAGE_PCT: parseFloat(process.env.MAX_SLIPPAGE_PCT) || 0.5,

  // Portfolio-level
  MAX_OPEN_TRADES: parseInt(process.env.MAX_OPEN_TRADES) || 5,
  MAX_EXPOSURE_PCT: parseFloat(process.env.MAX_EXPOSURE_PCT) || 20,
  MAX_DAILY_LOSS_PCT: parseFloat(process.env.MAX_DAILY_LOSS_PCT) || 5,
  MAX_DRAWDOWN_PCT: parseFloat(process.env.MAX_DRAWDOWN_PCT) || 15,
  DRAWDOWN_REDUCTION_FACTOR: parseFloat(process.env.DRAWDOWN_REDUCTION_FACTOR) || 0.5,

  // Systemic
  CIRCUIT_BREAKER_CONSECUTIVE_LOSSES: parseInt(process.env.CIRCUIT_BREAKER_LOSSES) || 5,
  CIRCUIT_BREAKER_TIMEOUT_MS: parseInt(process.env.CIRCUIT_BREAKER_TIMEOUT) || 3600000, // 1 hour
  MIN_SPREAD_PIPS: parseFloat(process.env.MIN_SPREAD_PIPS) || 2,
  MAX_SPREAD_PIPS: parseFloat(process.env.MAX_SPREAD_PIPS) || 10,

  // Correlation
  CORRELATION_THRESHOLD: parseFloat(process.env.CORRELATION_THRESHOLD) || 0.7,
};

class RiskIntelligence extends EventEmitter {
  constructor() {
    super();
    this._dailyPnL = 0;
    this._dailyTrades = 0;
    this._lastReset = new Date().toDateString();
    this._consecutiveLosses = 0;
    this._circuitBreakerActive = false;
    this._circuitBreakerExpiry = 0;
    this._peakEquity = 0;
    this._currentDrawdown = 0;

    // Correlation matrix (cached)
    this._correlationCache = new Map();
    this._lastCorrelationUpdate = 0;

    // Listen to market state for volatility adjustments
    marketIntelligence.on('marketState', (state) => {
      this._updateVolatilityAdjustment(state);
    });

    // Listen to regime changes for risk adjustments
    regimeEngine.on('regime', (regime) => {
      this._updateRegimeRisk(regime);
    });

    logger.info('[RiskIntelligence] Initialized.');
  }

  /**
   * Main risk assessment method – called before every potential trade.
   * Returns { allowed: boolean, reason: string, adjustedLotSize: number, confidenceMultiplier: number }
   */
  async assessTrade(signal, accountBalance, openPositions, product) {
    try {
      const symbol = signal.symbol || signal.pair;
      const side = signal.side || signal.decision;
      const entryPrice = signal.entryPrice;
      const stopLoss = signal.stopLoss;
      const takeProfit = signal.takeProfit;

      // ---- 1. Circuit breaker check ----
      if (this._circuitBreakerActive) {
        if (Date.now() > this._circuitBreakerExpiry) {
          this._circuitBreakerActive = false;
          logger.info('[RiskIntelligence] Circuit breaker expired.');
        } else {
          return {
            allowed: false,
            reason: 'Circuit breaker active (too many consecutive losses)',
            adjustedLotSize: 0,
            confidenceMultiplier: 0,
          };
        }
      }

      // ---- 2. Daily loss limit ----
      const today = new Date().toDateString();
      if (today !== this._lastReset) {
        this._dailyPnL = 0;
        this._dailyTrades = 0;
        this._lastReset = today;
      }

      const accountBalanceNum = parseFloat(accountBalance);
      const dailyLossLimit = accountBalanceNum * (CONFIG.MAX_DAILY_LOSS_PCT / 100);
      if (this._dailyPnL < -dailyLossLimit) {
        return {
          allowed: false,
          reason: `Daily loss limit reached (${this._dailyPnL.toFixed(2)} < -${dailyLossLimit.toFixed(2)})`,
          adjustedLotSize: 0,
          confidenceMultiplier: 0,
        };
      }

      // ---- 3. Drawdown protection ----
      if (this._peakEquity === 0) this._peakEquity = accountBalanceNum;
      const currentEquity = accountBalanceNum + this._dailyPnL; // approximate
      if (currentEquity > this._peakEquity) this._peakEquity = currentEquity;
      const drawdown = (this._peakEquity - currentEquity) / this._peakEquity;
      this._currentDrawdown = drawdown;

      if (drawdown > CONFIG.MAX_DRAWDOWN_PCT / 100) {
        return {
          allowed: false,
          reason: `Drawdown limit exceeded (${(drawdown * 100).toFixed(2)}% > ${CONFIG.MAX_DRAWDOWN_PCT}%)`,
          adjustedLotSize: 0,
          confidenceMultiplier: 0,
        };
      }

      // ---- 4. Max open trades ----
      if (openPositions.length >= CONFIG.MAX_OPEN_TRADES) {
        return {
          allowed: false,
          reason: `Max open trades (${CONFIG.MAX_OPEN_TRADES}) reached`,
          adjustedLotSize: 0,
          confidenceMultiplier: 0,
        };
      }

      // ---- 5. Exposure limit ----
      const totalExposure = openPositions.reduce((sum, p) => sum + Math.abs(p.units * p.price), 0);
      const maxExposure = accountBalanceNum * (CONFIG.MAX_EXPOSURE_PCT / 100);
      const proposedExposure = signal.recommendedLotSize * entryPrice;
      if (totalExposure + proposedExposure > maxExposure) {
        return {
          allowed: false,
          reason: `Exposure limit exceeded (${(totalExposure + proposedExposure).toFixed(2)} > ${maxExposure.toFixed(2)})`,
          adjustedLotSize: 0,
          confidenceMultiplier: 0,
        };
      }

      // ---- 6. Correlation check ----
      const isCorrelated = await this._checkCorrelation(symbol, openPositions);
      if (isCorrelated) {
        return {
          allowed: false,
          reason: `Position correlated with existing open position`,
          adjustedLotSize: 0,
          confidenceMultiplier: 0,
        };
      }

      // ---- 7. Minimum risk-reward ratio ----
      const stopDistance = Math.abs(entryPrice - stopLoss);
      const takeDistance = Math.abs(takeProfit - entryPrice);
      if (takeDistance / stopDistance < CONFIG.MIN_RR_RATIO) {
        return {
          allowed: false,
          reason: `Risk-reward ratio too low (${(takeDistance / stopDistance).toFixed(2)} < ${CONFIG.MIN_RR_RATIO})`,
          adjustedLotSize: 0,
          confidenceMultiplier: 0,
        };
      }

      // ---- 8. Spread check ----
      const spread = await this._getSpread(symbol, product);
      const pipSize = getPipSize(symbol);
      const spreadPips = spread / pipSize;
      if (spreadPips > CONFIG.MAX_SPREAD_PIPS) {
        return {
          allowed: false,
          reason: `Spread too wide (${spreadPips.toFixed(2)} pips > ${CONFIG.MAX_SPREAD_PIPS})`,
          adjustedLotSize: 0,
          confidenceMultiplier: 0,
        };
      }

      // ---- 9. Dynamic position sizing ----
      const baseRiskPct = this._getDynamicRiskPct(signal, drawdown);
      const adjustedLotSize = await this._calculatePositionSize(
        accountBalanceNum,
        baseRiskPct,
        stopLoss,
        entryPrice,
        symbol,
        product
      );

      // ---- 10. Confidence multiplier (reduce size when risk is high) ----
      const confidenceMultiplier = this._getConfidenceMultiplier(signal, drawdown, spreadPips);

      // ---- 11. Final approval ----
      return {
        allowed: true,
        reason: 'Risk assessment passed',
        adjustedLotSize: Math.min(adjustedLotSize, CONFIG.MAX_RISK_PER_TRADE_PCT * accountBalanceNum / 0.01), // cap
        confidenceMultiplier,
      };

    } catch (err) {
      logger.error('[RiskIntelligence] Assessment error:', err.message);
      return {
        allowed: false,
        reason: `Risk assessment error: ${err.message}`,
        adjustedLotSize: 0,
        confidenceMultiplier: 0,
      };
    }
  }

  /**
   * Record trade outcome (for daily P&L, consecutive losses, etc.)
   */
  recordTradeOutcome(pnl, side) {
    this._dailyPnL += pnl;
    this._dailyTrades++;

    if (pnl < 0) {
      this._consecutiveLosses++;
      if (this._consecutiveLosses >= CONFIG.CIRCUIT_BREAKER_CONSECUTIVE_LOSSES) {
        this._circuitBreakerActive = true;
        this._circuitBreakerExpiry = Date.now() + CONFIG.CIRCUIT_BREAKER_TIMEOUT_MS;
        logger.warn(`[RiskIntelligence] Circuit breaker activated after ${this._consecutiveLosses} consecutive losses.`);
        this.emit('circuitBreaker', true);
      }
    } else {
      this._consecutiveLosses = 0;
    }

    // Update drawdown
    const account = await accountService.getAccount(process.env.DEFAULT_TRADING_PRODUCT || 'mt5');
    const equity = parseFloat(account.equity);
    if (equity > this._peakEquity) this._peakEquity = equity;
    const drawdown = (this._peakEquity - equity) / this._peakEquity;
    this._currentDrawdown = drawdown;

    this.emit('tradeRecorded', { pnl, dailyPnL: this._dailyPnL, consecutiveLosses: this._consecutiveLosses });
  }

  /**
   * Get current risk metrics (for dashboard)
   */
  getMetrics() {
    return {
      dailyPnL: this._dailyPnL,
      dailyTrades: this._dailyTrades,
      consecutiveLosses: this._consecutiveLosses,
      circuitBreakerActive: this._circuitBreakerActive,
      currentDrawdown: this._currentDrawdown,
      peakEquity: this._peakEquity,
    };
  }

  /**
   * Reset the circuit breaker manually.
   */
  resetCircuitBreaker() {
    this._circuitBreakerActive = false;
    this._consecutiveLosses = 0;
    logger.info('[RiskIntelligence] Circuit breaker manually reset.');
    this.emit('circuitBreaker', false);
  }

  // ---- Private helper methods ----

  _getDynamicRiskPct(signal, drawdown) {
    // Base risk from config
    let riskPct = CONFIG.DEFAULT_RISK_PER_TRADE_PCT;

    // Adjust for volatility
    const state = marketIntelligence.getState(signal.symbol || signal.pair);
    if (state) {
      const vol = state.volatility.regime;
      if (vol === 'high') riskPct *= 0.7;
      else if (vol === 'low') riskPct *= 1.2;
    }

    // Adjust for drawdown
    if (drawdown > 0.05) {
      const factor = 1 - drawdown * 2;
      riskPct *= Math.max(0.5, factor);
    }

    // Adjust for regime
    const regime = regimeEngine.getRegime(signal.symbol || signal.pair);
    if (regime) {
      const mult = regime.riskMultiplier || 1;
      riskPct *= mult;
    }

    // Clamp
    return Math.max(CONFIG.MIN_RISK_PER_TRADE_PCT, Math.min(CONFIG.MAX_RISK_PER_TRADE_PCT, riskPct));
  }

  _getConfidenceMultiplier(signal, drawdown, spreadPips) {
    let mult = 1.0;
    // Reduce size when drawdown is high
    if (drawdown > 0.05) mult *= (1 - drawdown);
    // Reduce size when spread is wide
    if (spreadPips > 3) mult *= 0.8;
    // Reduce size in high volatility
    const state = marketIntelligence.getState(signal.symbol || signal.pair);
    if (state && state.volatility.regime === 'high') mult *= 0.7;
    // Increase size when confidence is high? Not here – fusion handles confidence.
    return Math.max(0.3, Math.min(1.2, mult));
  }

  async _calculatePositionSize(balance, riskPct, stopLoss, entryPrice, symbol, product) {
    const riskAmount = balance * (riskPct / 100);
    const stopDistance = Math.abs(entryPrice - stopLoss);
    if (stopDistance === 0) return 0.01;
    // Use the existing lot size calculator
    const { calculateLotSize } = require('./manager');
    const lotSize = await calculateLotSize(symbol, entryPrice, stopLoss, riskPct, 1000, product);
    return lotSize;
  }

  async _checkCorrelation(symbol, positions) {
    // Fetch correlations from a precomputed map or calculate on the fly.
    // For simplicity, we'll use a static map for major pairs.
    const CORRELATION_MAP = {
      'EUR_USD': ['GBP_USD', 'USD_CHF'],
      'GBP_USD': ['EUR_USD', 'USD_CHF'],
      'USD_JPY': ['USD_CHF'],
      'AUD_USD': ['NZD_USD'],
      'NZD_USD': ['AUD_USD'],
      'USD_CAD': [],
      'USD_CHF': ['EUR_USD', 'GBP_USD'],
    };
    const correlated = CORRELATION_MAP[symbol] || [];
    for (const pos of positions) {
      if (correlated.includes(pos.instrument)) {
        return true;
      }
    }
    // Also check if any position has the same direction and is highly correlated.
    // This is a simplified version; in production, use real-time correlation calculation.
    return false;
  }

  async _getSpread(symbol, product) {
    try {
      const broker = getBroker(product || process.env.DEFAULT_TRADING_PRODUCT || 'mt5');
      const prices = await broker.getPrices([symbol]);
      if (prices && prices.length > 0) {
        const bid = parseFloat(prices[0].bids[0].price);
        const ask = parseFloat(prices[0].asks[0].price);
        return Math.abs(ask - bid);
      }
    } catch (err) {
      logger.warn('[RiskIntelligence] Spread fetch error:', err.message);
    }
    return 0.0002; // fallback
  }

  _updateVolatilityAdjustment(state) {
    // We don't need to store anything here; we just use it dynamically in _getDynamicRiskPct.
    // This is just a placeholder for potential future adjustments.
  }

  _updateRegimeRisk(regime) {
    // Similarly, we use regime risk multiplier directly.
    // Could emit an event to indicate risk adjustment.
  }
}

// Singleton
const riskIntelligence = new RiskIntelligence();
module.exports = riskIntelligence;
