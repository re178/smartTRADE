// core/portfolio/intelligence.js
// RTS Portfolio Intelligence Engine
// Purpose: Manage portfolio‑level risk and optimize diversification.
// Answers: "How is my portfolio positioned? Are we over‑exposed? Should we hedge?"

const EventEmitter = require('events');
const marketProvider = require('../market/provider');
const accountService = require('../portfolio/accountService');
const logger = require('../../infrastructure/logger') || console;

// Configuration
const CONFIG = {
  MAX_TOTAL_EXPOSURE_PCT: parseFloat(process.env.MAX_TOTAL_EXPOSURE_PCT) || 20, // % of equity
  MAX_PAIR_EXPOSURE_PCT: parseFloat(process.env.MAX_PAIR_EXPOSURE_PCT) || 10,
  CORRELATION_THRESHOLD: parseFloat(process.env.CORRELATION_THRESHOLD) || 0.7,
  LOOKBACK_CANDLES: 100,
  TIMEFRAME: 'H1',
};

class PortfolioIntelligence extends EventEmitter {
  constructor() {
    super();
    this._positions = [];
    this._portfolioMetrics = null;
    this._lastUpdate = 0;

    // Listen to position updates from the broker (via event bus or periodic refresh)
    // We'll provide a method to refresh manually.

    logger.info('[PortfolioIntelligence] Initialized.');
  }

  /**
   * Update the portfolio with the latest positions.
   * @param {Array} positions - Array of position objects from broker.
   */
  updatePortfolio(positions) {
    this._positions = positions;
    this._portfolioMetrics = this._computeMetrics(positions);
    this._lastUpdate = Date.now();
    this.emit('portfolioUpdated', this._portfolioMetrics);
  }

  /**
   * Assess whether a new trade should be opened based on current portfolio.
   * @param {Object} signal - { symbol, side, entryPrice, stopLoss, takeProfit, recommendedLotSize }
   * @param {number} accountBalance - Current account balance.
   * @param {Array} currentPositions - Optional, if not provided uses internal state.
   * @returns {Object} { approved: boolean, reason: string, adjustedLotSize: number, exposureImpact: number }
   */
  assessNewTrade(signal, accountBalance, currentPositions) {
    try {
      const positions = currentPositions || this._positions;
      const symbol = signal.symbol || signal.pair;
      const proposedLot = signal.recommendedLotSize || 0.01;
      const entryPrice = signal.entryPrice;

      // ---- 1. Calculate current portfolio exposure ----
      const totalExposure = positions.reduce((sum, p) => sum + Math.abs(p.units * p.price), 0);
      const maxExposure = accountBalance * (CONFIG.MAX_TOTAL_EXPOSURE_PCT / 100);
      const proposedExposure = proposedLot * entryPrice;

      if (totalExposure + proposedExposure > maxExposure) {
        // Try to reduce lot size to fit within limit
        const maxAllowedExposure = maxExposure - totalExposure;
        const maxLot = maxAllowedExposure / entryPrice;
        const adjustedLot = Math.min(proposedLot, maxLot);
        if (adjustedLot < 0.01) {
          return {
            approved: false,
            reason: `Exposure limit exceeded. Cannot fit even 0.01 lot.`,
            adjustedLotSize: 0,
            exposureImpact: proposedExposure / maxExposure,
          };
        } else {
          return {
            approved: true,
            reason: `Exposure reduced to fit limit (adjusted lot: ${adjustedLot.toFixed(2)})`,
            adjustedLotSize: Math.round(adjustedLot * 100) / 100,
            exposureImpact: (totalExposure + adjustedLot * entryPrice) / maxExposure,
          };
        }
      }

      // ---- 2. Check pair concentration ----
      const pairExposure = positions
        .filter(p => p.instrument === symbol)
        .reduce((sum, p) => sum + Math.abs(p.units * p.price), 0);
      const maxPairExposure = accountBalance * (CONFIG.MAX_PAIR_EXPOSURE_PCT / 100);
      if (pairExposure + proposedExposure > maxPairExposure) {
        const maxAllowedPair = maxPairExposure - pairExposure;
        const maxLot = maxAllowedPair / entryPrice;
        const adjustedLot = Math.min(proposedLot, maxLot);
        if (adjustedLot < 0.01) {
          return {
            approved: false,
            reason: `Pair exposure limit exceeded for ${symbol}.`,
            adjustedLotSize: 0,
            exposureImpact: 0,
          };
        } else {
          return {
            approved: true,
            reason: `Pair exposure reduced for ${symbol} (adjusted lot: ${adjustedLot.toFixed(2)})`,
            adjustedLotSize: Math.round(adjustedLot * 100) / 100,
            exposureImpact: (pairExposure + adjustedLot * entryPrice) / maxPairExposure,
          };
        }
      }

      // ---- 3. Correlation check (with existing positions) ----
      const correlatedPositions = this._findCorrelatedPositions(symbol, positions);
      if (correlatedPositions.length > 0) {
        // We might still allow, but with a warning and possibly reduce size.
        // For now, we'll allow if the correlation is below the threshold.
        // If any correlation > threshold, we might reject or reduce.
        // We'll use the average correlation.
        const avgCorr = correlatedPositions.reduce((sum, p) => sum + p.correlation, 0) / correlatedPositions.length;
        if (avgCorr > CONFIG.CORRELATION_THRESHOLD) {
          // Option: reduce lot size by correlation factor
          const correlationFactor = 1 - (avgCorr - 0.5);
          const adjustedLot = Math.max(0.01, proposedLot * correlationFactor);
          return {
            approved: true,
            reason: `Correlated positions detected (avg corr: ${avgCorr.toFixed(2)}), adjusted lot down to ${adjustedLot.toFixed(2)}`,
            adjustedLotSize: Math.round(adjustedLot * 100) / 100,
            exposureImpact: (totalExposure + adjustedLot * entryPrice) / maxExposure,
          };
        } else {
          // Accept with reduced size
          const adjustedLot = proposedLot * 0.9;
          return {
            approved: true,
            reason: `Correlated positions detected but correlation below threshold, slight reduction applied.`,
            adjustedLotSize: Math.round(adjustedLot * 100) / 100,
            exposureImpact: (totalExposure + adjustedLot * entryPrice) / maxExposure,
          };
        }
      }

      // ---- 4. Diversification check (number of positions) ----
      if (positions.length >= 5) {
        // If we have many positions, we can still open but suggest a smaller size.
        const adjustedLot = proposedLot * 0.8;
        return {
          approved: true,
          reason: `Many positions open (${positions.length}), reducing size slightly.`,
          adjustedLotSize: Math.round(adjustedLot * 100) / 100,
          exposureImpact: (totalExposure + adjustedLot * entryPrice) / maxExposure,
        };
      }

      // ---- 5. All checks passed ----
      return {
        approved: true,
        reason: 'Portfolio assessment passed.',
        adjustedLotSize: proposedLot,
        exposureImpact: (totalExposure + proposedExposure) / maxExposure,
      };

    } catch (err) {
      logger.error('[PortfolioIntelligence] Assessment error:', err.message);
      return {
        approved: false,
        reason: `Portfolio assessment error: ${err.message}`,
        adjustedLotSize: 0,
        exposureImpact: 0,
      };
    }
  }

  /**
   * Get current portfolio metrics.
   */
  getMetrics() {
    if (this._portfolioMetrics) {
      return this._portfolioMetrics;
    }
    return this._computeMetrics(this._positions);
  }

  /**
   * Compute comprehensive portfolio metrics.
   */
  _computeMetrics(positions) {
    if (!positions || positions.length === 0) {
      return {
        totalPositions: 0,
        totalExposure: 0,
        totalUnrealizedPL: 0,
        exposureByPair: {},
        concentration: 0,
        averageDirection: 0,
        correlations: [],
      };
    }

    let totalExposure = 0;
    let totalPL = 0;
    const exposureByPair = {};
    let maxExposure = 0;

    for (const p of positions) {
      const exposure = Math.abs(p.units * p.price);
      totalExposure += exposure;
      totalPL += p.unrealizedPL || 0;
      exposureByPair[p.instrument] = (exposureByPair[p.instrument] || 0) + exposure;
      if (exposure > maxExposure) maxExposure = exposure;
    }

    // Concentration = largest exposure / total exposure
    const concentration = totalExposure > 0 ? maxExposure / totalExposure : 0;

    // Average direction (1 = all long, -1 = all short)
    let netDirection = 0;
    let totalUnits = 0;
    for (const p of positions) {
      const dir = p.side === 'BUY' ? 1 : -1;
      netDirection += dir * p.units;
      totalUnits += Math.abs(p.units);
    }
    const averageDirection = totalUnits > 0 ? netDirection / totalUnits : 0;

    // We'll also compute correlations between pairs if we have price data.
    // This is expensive, so we'll do it lazily.
    // For now, we'll just return a placeholder.

    return {
      totalPositions: positions.length,
      totalExposure,
      totalUnrealizedPL: totalPL,
      exposureByPair,
      concentration,
      averageDirection,
      correlations: [], // We'll compute on demand
    };
  }

  /**
   * Find positions that are correlated with the given symbol.
   * Uses historical price data to compute correlation.
   */
  async _findCorrelatedPositions(symbol, positions) {
    // If no other positions, return empty.
    if (!positions || positions.length === 0) return [];

    // We'll use the marketProvider to get historical candles for each symbol and compute Pearson correlation.
    // To avoid blocking, we could cache correlation matrix.
    const correlated = [];
    const symbolPrices = await this._getPriceHistory(symbol);

    for (const pos of positions) {
      if (pos.instrument === symbol) continue; // same symbol
      const posPrices = await this._getPriceHistory(pos.instrument);
      if (!symbolPrices || !posPrices || symbolPrices.length < 20 || posPrices.length < 20) continue;
      const corr = this._pearsonCorrelation(symbolPrices, posPrices);
      correlated.push({
        symbol: pos.instrument,
        correlation: corr,
        exposure: Math.abs(pos.units * pos.price),
      });
    }

    // Sort by correlation descending
    correlated.sort((a, b) => b.correlation - a.correlation);
    return correlated;
  }

  /**
   * Fetch price history for a symbol.
   */
  async _getPriceHistory(symbol) {
    try {
      // Use the marketProvider to get candles
      const candles = await marketProvider.getCandles(symbol, CONFIG.LOOKBACK_CANDLES, CONFIG.TIMEFRAME);
      if (!candles || candles.length === 0) return [];
      return candles.map(c => c.mid.c);
    } catch (err) {
      logger.warn(`[PortfolioIntelligence] Failed to get price history for ${symbol}:`, err.message);
      return [];
    }
  }

  /**
   * Compute Pearson correlation between two price arrays.
   */
  _pearsonCorrelation(arr1, arr2) {
    const n = Math.min(arr1.length, arr2.length);
    if (n < 5) return 0;
    const x = arr1.slice(-n);
    const y = arr2.slice(-n);
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((a, b, i) => a + b * y[i], 0);
    const sumX2 = x.reduce((a, b) => a + b * b, 0);
    const sumY2 = y.reduce((a, b) => a + b * b, 0);
    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    return denominator === 0 ? 0 : numerator / denominator;
  }

  /**
   * Refresh portfolio from the broker.
   */
  async refresh(product) {
    try {
      const broker = require('../execution/brokerFactory').getBroker(product || process.env.DEFAULT_TRADING_PRODUCT || 'mt5');
      const positions = await broker.getOpenTrades();
      this.updatePortfolio(positions);
      return positions;
    } catch (err) {
      logger.error('[PortfolioIntelligence] Refresh error:', err.message);
      return null;
    }
  }
}

// Singleton
const portfolioIntelligence = new PortfolioIntelligence();
module.exports = portfolioIntelligence;
