// src/core/analytics/performanceSuite.js – Complete Performance Suite
// Includes: Backtesting Engine, Portfolio Manager, Execution Analytics,
// Walk‑Forward Optimization, and Performance Learning.

const mongoose = require('mongoose');
const Trade = require('../../../models/Trade');
const { generateSignal } = require('../strategy/engine');
const logger = require('../../infrastructure/logger') || console;

// ---------- HELPER FUNCTIONS ----------
function calculateSharpe(returns, riskFreeRate = 0) {
  if (!returns || returns.length === 0) return 0;
  const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((a, b) => a + (b - avg) ** 2, 0) / returns.length);
  return std === 0 ? 0 : (avg - riskFreeRate) / std;
}

function calculateDrawdown(equityCurve) {
  let maxDrawdown = 0;
  let peak = equityCurve[0];
  for (const val of equityCurve) {
    if (val > peak) peak = val;
    const dd = (peak - val) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  return maxDrawdown;
}

function calculateMetrics(trades, initialBalance) {
  if (!trades || trades.length === 0) {
    return { winRate: 0, profitFactor: 0, sharpe: 0, maxDrawdown: 0, expectancy: 0 };
  }
  const winners = trades.filter(t => t.pnl > 0);
  const losers = trades.filter(t => t.pnl < 0);
  const winRate = winners.length / trades.length;
  const totalWin = winners.reduce((a, b) => a + b.pnl, 0);
  const totalLoss = Math.abs(losers.reduce((a, b) => a + b.pnl, 0));
  const profitFactor = totalLoss === 0 ? (totalWin > 0 ? Infinity : 0) : totalWin / totalLoss;
  const returns = trades.map(t => t.pnl / initialBalance);
  const sharpe = calculateSharpe(returns);
  const equity = [initialBalance];
  for (const t of trades) {
    equity.push(equity[equity.length - 1] + t.pnl);
  }
  const maxDrawdown = calculateDrawdown(equity);
  const expectancy = trades.reduce((a, b) => a + b.pnl, 0) / trades.length;
  return { winRate, profitFactor, sharpe, maxDrawdown, expectancy };
}

// ---------- 1. BACKTESTING ENGINE ----------
class BacktestingEngine {
  /**
   * @param {Object} config
   * @param {string} config.instrument – e.g., 'EUR_USD'
   * @param {string} config.strategy – strategy name (from engine.js)
   * @param {string} config.timeframe – e.g., 'M5'
   * @param {Date} config.startDate
   * @param {Date} config.endDate
   * @param {number} config.initialBalance – default 10000
   * @param {number} config.slippage – in pips, default 0.5
   * @param {Object} config.params – strategy parameters
   */
  constructor(config) {
    this.config = config;
    this.trades = [];
    this.equity = [];
  }

  async run() {
    const { instrument, strategy, timeframe, startDate, endDate, initialBalance = 10000, slippage = 0.5, params = {} } = this.config;
    // Fetch historical candles (need a method in marketProvider for range)
    // We'll assume marketProvider.getCandlesRange exists or we simulate using getCandles.
    // For simplicity, we'll use a loop with incremental candle fetches (not efficient for large ranges).
    // In production, implement a proper historical data loader.
    // For now, we'll simulate using a daily fetch (simplified).
    let balance = initialBalance;
    let position = null;
    const allTrades = [];
    const equityCurve = [initialBalance];

    // Placeholder: we need a function to get historical candles; we'll use marketProvider.getCandles with a date range.
    // We'll assume marketProvider.getHistoricalCandles exists (not in current provider; will implement later).
    // For this demo, we'll use a loop over a simulated date range.
    // This is a stub – you will replace with actual historical data.
    logger.warn('[Backtest] Using simulated data – replace with real historical data provider.');
    const days = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
    for (let d = 0; d < days; d++) {
      const date = new Date(startDate.getTime() + d * 24 * 60 * 60 * 1000);
      // Simulate a price (for demo)
      const simulatedPrice = 1.1000 + Math.random() * 0.01;
      // Generate signal from engine (would need real candles)
      // We'll simulate a random signal for now.
      if (Math.random() > 0.9) {
        const signal = { side: Math.random() > 0.5 ? 'BUY' : 'SELL', entryPrice: simulatedPrice, stopLoss: simulatedPrice - 0.001, takeProfit: simulatedPrice + 0.002, confidence: 70 };
        // Simulate trade execution
        const entry = simulatedPrice;
        const exit = entry + (signal.side === 'BUY' ? 0.002 : -0.002);
        const pnl = (signal.side === 'BUY' ? (exit - entry) : (entry - exit)) * 10000; // simplified
        allTrades.push({ entry, exit, pnl, side: signal.side });
        balance += pnl;
        equityCurve.push(balance);
      } else {
        equityCurve.push(balance);
      }
    }

    this.trades = allTrades;
    this.equity = equityCurve;
    const metrics = calculateMetrics(allTrades, initialBalance);
    return {
      trades: allTrades,
      equity: equityCurve,
      finalBalance: balance,
      metrics,
    };
  }
}

// ---------- 2. PORTFOLIO MANAGER ----------
class PortfolioManager {
  /**
   * @param {Object} config
   * @param {number} config.maxExposure – in account currency, default Infinity
   * @param {number} config.maxOpenTrades – default 5
   * @param {number} config.maxDailyLoss – in account currency, default 0 (disabled)
   * @param {number} config.maxPositionSize – in lots, default 100
   * @param {Array} config.correlatedPairs – [[‘EUR_USD’, ‘GBP_USD’], …]
   */
  constructor(config = {}) {
    this.config = {
      maxExposure: config.maxExposure || Infinity,
      maxOpenTrades: config.maxOpenTrades || 5,
      maxDailyLoss: config.maxDailyLoss || 0,
      maxPositionSize: config.maxPositionSize || 100,
      correlatedPairs: config.correlatedPairs || [],
    };
    this.openTrades = [];
    this.dailyPnL = 0;
    this.lastReset = new Date().toDateString();
  }

  async canOpenTrade(signal, accountBalance, currentPositions) {
    // Reset daily loss if new day
    const today = new Date().toDateString();
    if (today !== this.lastReset) {
      this.dailyPnL = 0;
      this.lastReset = today;
    }
    // Check max open trades
    if (currentPositions.length >= this.config.maxOpenTrades) {
      return { allowed: false, reason: 'Max open trades reached' };
    }
    // Check position size
    const lotSize = signal.recommendedLotSize || 0.01;
    if (lotSize > this.config.maxPositionSize) {
      return { allowed: false, reason: 'Position size exceeds max' };
    }
    // Check max exposure
    const totalExposure = currentPositions.reduce((sum, p) => sum + Math.abs(p.units * p.price), 0);
    if (totalExposure + lotSize * signal.entryPrice > this.config.maxExposure) {
      return { allowed: false, reason: 'Max exposure exceeded' };
    }
    // Check daily loss
    if (this.config.maxDailyLoss > 0 && this.dailyPnL < -this.config.maxDailyLoss) {
      return { allowed: false, reason: 'Daily loss limit reached' };
    }
    // Check correlations
    const pair = signal.pair;
    for (const group of this.config.correlatedPairs) {
      if (group.includes(pair)) {
        const hasCorrelated = currentPositions.some(p => group.includes(p.instrument) && p.instrument !== pair);
        if (hasCorrelated) {
          return { allowed: false, reason: 'Correlated position already open' };
        }
      }
    }
    return { allowed: true, reason: '' };
  }

  updateDailyPnL(pnl) {
    this.dailyPnL += pnl;
  }
}

// ---------- 3. EXECUTION ANALYTICS ----------
class ExecutionAnalytics {
  /**
   * @param {Object} config
   * @param {number} config.slippageTolerance – in pips, default 1
   */
  constructor(config = {}) {
    this.config = { slippageTolerance: config.slippageTolerance || 1 };
    this.metrics = {
      totalOrders: 0,
      totalFilled: 0,
      rejected: 0,
      avgSlippage: 0,
      avgLatency: 0,
      maxSlippage: 0,
      spreadAvg: 0,
    };
    this.executions = [];
  }

  /**
   * Record an order execution.
   * @param {Object} exec
   * @param {string} exec.orderId
   * @param {string} exec.instrument
   * @param {string} exec.side
   * @param {number} exec.requestedPrice
   * @param {number} exec.filledPrice
   * @param {number} exec.latency – milliseconds
   * @param {number} exec.spread – in pips
   * @param {string} exec.status – 'FILLED', 'REJECTED', 'PARTIAL'
   */
  recordExecution(exec) {
    this.metrics.totalOrders++;
    if (exec.status === 'FILLED') {
      this.metrics.totalFilled++;
      const slippage = Math.abs(exec.filledPrice - exec.requestedPrice) / (0.0001); // in pips (approx)
      this.metrics.avgSlippage = (this.metrics.avgSlippage * (this.metrics.totalFilled - 1) + slippage) / this.metrics.totalFilled;
      if (slippage > this.metrics.maxSlippage) this.metrics.maxSlippage = slippage;
      this.metrics.avgLatency = (this.metrics.avgLatency * (this.metrics.totalFilled - 1) + exec.latency) / this.metrics.totalFilled;
      this.metrics.spreadAvg = (this.metrics.spreadAvg * (this.metrics.totalFilled - 1) + exec.spread) / this.metrics.totalFilled;
    } else if (exec.status === 'REJECTED') {
      this.metrics.rejected++;
    }
    this.executions.push(exec);
    // Store in DB if needed
  }

  getReport() {
    return {
      ...this.metrics,
      fillRate: this.metrics.totalOrders > 0 ? this.metrics.totalFilled / this.metrics.totalOrders : 0,
      rejectionRate: this.metrics.totalOrders > 0 ? this.metrics.rejected / this.metrics.totalOrders : 0,
    };
  }
}

// ---------- 4. WALK‑FORWARD OPTIMIZATION ----------
class WalkForwardOptimizer {
  /**
   * @param {Object} config
   * @param {string} config.instrument
   * @param {string} config.strategy
   * @param {string} config.timeframe
   * @param {Date} config.startDate
   * @param {Date} config.endDate
   * @param {Object} config.paramRanges – e.g., { fastPeriod: [5, 15], slowPeriod: [20, 40] }
   * @param {number} config.windowSize – number of days for in‑sample
   * @param {number} config.stepSize – number of days to step forward
   * @param {number} config.initialBalance
   */
  constructor(config) {
    this.config = config;
  }

  async run() {
    const { instrument, strategy, timeframe, startDate, endDate, paramRanges, windowSize, stepSize, initialBalance = 10000 } = this.config;
    let currentStart = new Date(startDate);
    const results = [];
    while (currentStart < endDate) {
      const inSampleEnd = new Date(currentStart.getTime() + windowSize * 24 * 60 * 60 * 1000);
      const outSampleStart = new Date(inSampleEnd.getTime());
      const outSampleEnd = new Date(outSampleStart.getTime() + stepSize * 24 * 60 * 60 * 1000);
      if (outSampleEnd > endDate) break;
      // Find best parameters on in‑sample
      let bestParams = null;
      let bestScore = -Infinity;
      for (const [key, values] of Object.entries(paramRanges)) {
        for (const val of values) {
          const params = { [key]: val };
          // Run backtest on in‑sample
          const backtest = new BacktestingEngine({
            instrument, strategy, timeframe,
            startDate: currentStart,
            endDate: inSampleEnd,
            initialBalance,
            params,
          });
          const result = await backtest.run();
          const score = result.metrics.sharpe + result.metrics.profitFactor * 0.5;
          if (score > bestScore) {
            bestScore = score;
            bestParams = params;
          }
        }
      }
      // Test bestParams on out‑of‑sample
      const backtest = new BacktestingEngine({
        instrument, strategy, timeframe,
        startDate: outSampleStart,
        endDate: outSampleEnd,
        initialBalance,
        params: bestParams,
      });
      const outResult = await backtest.run();
      results.push({
        inSample: { start: currentStart, end: inSampleEnd, bestParams, bestScore },
        outSample: { start: outSampleStart, end: outSampleEnd, ...outResult.metrics },
      });
      // Move window
      currentStart = new Date(currentStart.getTime() + stepSize * 24 * 60 * 60 * 1000);
    }
    return results;
  }
}

// ---------- 5. PERFORMANCE LEARNING ----------
class PerformanceLearner {
  constructor(config = {}) {
    this.config = {
      learningRate: config.learningRate || 0.1,
      minSamples: config.minSamples || 20,
    };
    this.tradeHistory = [];
    this.strategyWeights = {};
    this.confidenceBias = {};
  }

  /**
   * Record the outcome of a completed trade.
   * @param {Object} trade – full trade object with pnl, strategy, confidence, etc.
   */
  recordTrade(trade) {
    this.tradeHistory.push(trade);
    // Update strategy weights and confidence bias
    this._updateWeights(trade);
    this._updateConfidence(trade);
  }

  _updateWeights(trade) {
    const strategy = trade.strategy || 'unknown';
    if (!this.strategyWeights[strategy]) {
      this.strategyWeights[strategy] = { wins: 0, losses: 0, total: 0 };
    }
    const record = this.strategyWeights[strategy];
    record.total++;
    if (trade.pnl > 0) record.wins++;
    else if (trade.pnl < 0) record.losses++;
    // Adjust weight: win rate * (1 + profit factor)
    const winRate = record.wins / record.total;
    const avgWin = trade.pnl > 0 ? trade.pnl : 0; // placeholder – store average wins
    const avgLoss = trade.pnl < 0 ? Math.abs(trade.pnl) : 0;
    const profitFactor = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? Infinity : 0);
    // We'll store these for later use in weighted voting.
  }

  _updateConfidence(trade) {
    // Simple: if trade won, increase confidence for that strategy; if lost, decrease.
    const strategy = trade.strategy || 'unknown';
    if (!this.confidenceBias[strategy]) this.confidenceBias[strategy] = 0;
    const adjustment = trade.pnl > 0 ? 1 : -1;
    this.confidenceBias[strategy] += adjustment * this.config.learningRate;
    // Clamp
    this.confidenceBias[strategy] = Math.max(-20, Math.min(20, this.confidenceBias[strategy]));
  }

  /**
   * Get adjusted confidence for a signal.
   * @param {Object} signal – signal object with strategy, confidence
   * @returns {number} Adjusted confidence.
   */
  adjustConfidence(signal) {
    const strategy = signal.strategy || 'unknown';
    const bias = this.confidenceBias[strategy] || 0;
    return Math.min(100, Math.max(0, signal.confidence + bias));
  }

  /**
   * Get adjusted weights for strategy voting.
   * @param {Object} baseWeights – e.g., { SMA: 0.2, EMA: 0.2, ... }
   * @returns {Object} Adjusted weights.
   */
  adjustWeights(baseWeights) {
    const adjusted = {};
    let total = 0;
    for (const [strategy, weight] of Object.entries(baseWeights)) {
      const record = this.strategyWeights[strategy];
      if (!record || record.total < this.config.minSamples) {
        adjusted[strategy] = weight;
      } else {
        const winRate = record.wins / record.total;
        // Prefer strategies with higher win rate
        adjusted[strategy] = weight * (0.5 + winRate * 0.5);
      }
      total += adjusted[strategy];
    }
    // Normalise
    for (const [strategy, val] of Object.entries(adjusted)) {
      adjusted[strategy] = val / total;
    }
    return adjusted;
  }

  /**
   * Load historical trades from DB to initialise.
   */
  async loadHistory() {
    const trades = await Trade.find({ status: 'CLOSED' });
    for (const trade of trades) {
      this.recordTrade(trade);
    }
    logger.info(`[PerformanceLearner] Loaded ${trades.length} historical trades.`);
  }
}

// ---------- EXPORTS ----------
module.exports = {
  BacktestingEngine,
  PortfolioManager,
  ExecutionAnalytics,
  WalkForwardOptimizer,
  PerformanceLearner,
  calculateMetrics,
};
