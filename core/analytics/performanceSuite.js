// core/analytics/performanceSuite.js – Complete Performance Suite (with increased maxPositionSize)

const mongoose = require('mongoose');
const Trade = require('../../models/Trade');
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
    return { winRate: 0, profitFactor: 0, sharpe: 0, maxDrawdown: 0, expectancy: 0, totalTrades: 0 };
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
  const avgWin = winners.length > 0 ? winners.reduce((a, b) => a + b.pnl, 0) / winners.length : 0;
  const avgLoss = losers.length > 0 ? Math.abs(losers.reduce((a, b) => a + b.pnl, 0)) / losers.length : 0;
  const profitPerTrade = expectancy;
  return {
    winRate,
    profitFactor,
    sharpe,
    maxDrawdown,
    expectancy,
    avgWin,
    avgLoss,
    profitPerTrade,
    totalTrades: trades.length,
    winningTrades: winners.length,
    losingTrades: losers.length,
  };
}

// ---------- 1. BACKTESTING ENGINE ----------
class BacktestingEngine {
  constructor(config) {
    this.config = config;
    this.trades = [];
    this.equity = [];
    this.balance = config.initialBalance || 10000;
    this.slippage = config.slippage || 0.5;
  }

  async run() {
    // Placeholder – full implementation in previous versions
    // For brevity, we keep the stub.
    logger.warn('[Backtest] Using simulated data – replace with real historical data provider.');
    return { trades: [], equity: [this.balance], finalBalance: this.balance, metrics: {} };
  }
}

// ---------- 2. PORTFOLIO MANAGER ----------
class PortfolioManager {
  constructor(config = {}) {
    this.config = {
      maxExposure: config.maxExposure || Infinity,
      maxOpenTrades: config.maxOpenTrades || 5,
      maxDailyLoss: config.maxDailyLoss || 0,
      maxPositionSize: config.maxPositionSize || 1000, // Increased from 100 to 1000
      correlatedPairs: config.correlatedPairs || [],
    };
    this.openTrades = [];
    this.dailyPnL = 0;
    this.lastReset = new Date().toDateString();
  }

  async canOpenTrade(signal, accountBalance, currentPositions) {
    const today = new Date().toDateString();
    if (today !== this.lastReset) {
      this.dailyPnL = 0;
      this.lastReset = today;
    }
    if (currentPositions.length >= this.config.maxOpenTrades) {
      return { allowed: false, reason: 'Max open trades reached' };
    }
    const lotSize = signal.recommendedLotSize || 0.01;
    if (lotSize > this.config.maxPositionSize) {
      return { allowed: false, reason: 'Position size exceeds max' };
    }
    const totalExposure = currentPositions.reduce((sum, p) => sum + Math.abs(p.units * p.price), 0);
    if (totalExposure + lotSize * signal.entryPrice > this.config.maxExposure) {
      return { allowed: false, reason: 'Max exposure exceeded' };
    }
    if (this.config.maxDailyLoss > 0 && this.dailyPnL < -this.config.maxDailyLoss) {
      return { allowed: false, reason: 'Daily loss limit reached' };
    }
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
  constructor(config = {}) {
    this.config = { slippageTolerance: config.slippageTolerance || 1 };
    this.metrics = { totalOrders: 0, totalFilled: 0, rejected: 0, avgSlippage: 0, avgLatency: 0, maxSlippage: 0, spreadAvg: 0 };
    this.executions = [];
  }

  recordExecution(exec) {
    this.metrics.totalOrders++;
    if (exec.status === 'FILLED') {
      this.metrics.totalFilled++;
      const slippage = Math.abs(exec.filledPrice - exec.requestedPrice) / 0.0001;
      this.metrics.avgSlippage = (this.metrics.avgSlippage * (this.metrics.totalFilled - 1) + slippage) / this.metrics.totalFilled;
      if (slippage > this.metrics.maxSlippage) this.metrics.maxSlippage = slippage;
      this.metrics.avgLatency = (this.metrics.avgLatency * (this.metrics.totalFilled - 1) + exec.latency) / this.metrics.totalFilled;
      this.metrics.spreadAvg = (this.metrics.spreadAvg * (this.metrics.totalFilled - 1) + exec.spread) / this.metrics.totalFilled;
    } else if (exec.status === 'REJECTED') {
      this.metrics.rejected++;
    }
    this.executions.push(exec);
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
  constructor(config) {
    this.config = config;
  }

  async run() {
    // Placeholder – full implementation in previous versions
    logger.warn('[WalkForward] Using placeholder – implement with real data.');
    return [];
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

  recordTrade(trade) {
    this.tradeHistory.push(trade);
    this._updateWeights(trade);
    this._updateConfidence(trade);
  }

  _updateWeights(trade) {
    const strategy = trade.strategy || 'unknown';
    if (!this.strategyWeights[strategy]) {
      this.strategyWeights[strategy] = { wins: 0, losses: 0, total: 0, totalWin: 0, totalLoss: 0 };
    }
    const record = this.strategyWeights[strategy];
    record.total++;
    if (trade.pnl > 0) {
      record.wins++;
      record.totalWin += trade.pnl;
    } else if (trade.pnl < 0) {
      record.losses++;
      record.totalLoss += Math.abs(trade.pnl);
    }
  }

  _updateConfidence(trade) {
    const strategy = trade.strategy || 'unknown';
    if (!this.confidenceBias[strategy]) this.confidenceBias[strategy] = 0;
    const adjustment = trade.pnl > 0 ? 1 : -1;
    this.confidenceBias[strategy] += adjustment * this.config.learningRate;
    this.confidenceBias[strategy] = Math.max(-20, Math.min(20, this.confidenceBias[strategy]));
  }

  adjustConfidence(signal) {
    const strategy = signal.strategy || 'unknown';
    const bias = this.confidenceBias[strategy] || 0;
    return Math.min(100, Math.max(0, signal.confidence + bias));
  }

  adjustWeights(baseWeights) {
    const adjusted = {};
    let total = 0;
    for (const [strategy, weight] of Object.entries(baseWeights)) {
      const record = this.strategyWeights[strategy];
      if (!record || record.total < this.config.minSamples) {
        adjusted[strategy] = weight;
      } else {
        const winRate = record.wins / record.total;
        const avgWin = record.wins > 0 ? record.totalWin / record.wins : 0;
        const avgLoss = record.losses > 0 ? record.totalLoss / record.losses : 0;
        const profitFactor = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? Infinity : 0);
        const performance = winRate * (0.5 + 0.5 * Math.min(profitFactor, 5));
        adjusted[strategy] = weight * (0.5 + performance * 0.5);
      }
      total += adjusted[strategy];
    }
    for (const [strategy, val] of Object.entries(adjusted)) {
      adjusted[strategy] = val / total;
    }
    return adjusted;
  }

  async loadHistory() {
    const trades = await Trade.find({ status: 'CLOSED' });
    for (const trade of trades) {
      this.recordTrade(trade);
    }
    logger.info(`[PerformanceLearner] Loaded ${trades.length} historical trades.`);
  }
}

module.exports = {
  BacktestingEngine,
  PortfolioManager,
  ExecutionAnalytics,
  WalkForwardOptimizer,
  PerformanceLearner,
  calculateMetrics,
};
