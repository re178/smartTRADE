// src/core/analytics/performanceSuite.js – Complete Performance Suite (Production Ready)

const Trade = require('../../../models/Trade');
const marketProvider = require('../market/provider');
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

// ---------- 1. BACKTESTING ENGINE (REAL DATA) ----------
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
    this.balance = config.initialBalance || 10000;
    this.slippage = config.slippage || 0.5;
  }

  async run() {
    const { instrument, strategy, timeframe, startDate, endDate, params = {} } = this.config;
    // Fetch historical candles
    const candles = await marketProvider.getHistoricalCandles(instrument, startDate, endDate, timeframe);
    if (!candles || candles.length < 50) {
      logger.warn('[Backtest] Not enough candles for backtest.');
      return { trades: [], equity: [this.balance], finalBalance: this.balance, metrics: {} };
    }

    let balance = this.balance;
    let position = null; // { side, entry, stopLoss, takeProfit, units }
    const allTrades = [];
    const equityCurve = [balance];
    const pipSize = getPipSize(instrument);

    // Iterate through candles (skip initial warm-up)
    const warmup = 50;
    for (let i = warmup; i < candles.length; i++) {
      const candle = candles[i];
      const currentPrice = parseFloat(candle.mid.c);
      const high = parseFloat(candle.mid.h);
      const low = parseFloat(candle.mid.l);

      // If we have an open position, check for stop or take profit
      if (position) {
        const slHit = position.side === 'BUY' ? low <= position.stopLoss : high >= position.stopLoss;
        const tpHit = position.side === 'BUY' ? high >= position.takeProfit : low <= position.takeProfit;
        let exitPrice = null;
        if (slHit && tpHit) {
          // Which one hit first? Use the order of prices.
          // For simplicity, we assume the most extreme price is hit first.
          if (position.side === 'BUY') {
            // If low hit SL first, or high hit TP first? We'll compare distances.
            const slDistance = Math.abs(position.entry - position.stopLoss);
            const tpDistance = Math.abs(position.entry - position.takeProfit);
            // If slDistance < tpDistance, SL is closer; but we need to know which price level was reached first.
            // We'll check if low <= stopLoss (SL hit) and high >= takeProfit (TP hit). If both, the one with the closest price level from entry is hit first.
            // We'll determine by checking the order of price movement: if the candle's range includes both levels.
            // For simplicity, we'll assume the one that is crossed first in time is the one whose level is reached first.
            // We'll approximate: if the low was hit before the high (in time), SL hit first.
            // We'll use the open to compare: if (low - entry) < (high - entry) then SL hit first.
            const slHitFirst = (position.entry - low) < (high - position.entry);
            exitPrice = slHitFirst ? position.stopLoss : position.takeProfit;
          } else {
            const slHitFirst = (high - position.entry) < (position.entry - low);
            exitPrice = slHitFirst ? position.stopLoss : position.takeProfit;
          }
        } else if (slHit) {
          exitPrice = position.stopLoss;
        } else if (tpHit) {
          exitPrice = position.takeProfit;
        }
        if (exitPrice !== null) {
          // Close position
          const pnl = (position.side === 'BUY' ? (exitPrice - position.entry) : (position.entry - exitPrice)) * position.units * 100000; // simplified lot value
          allTrades.push({
            entry: position.entry,
            exit: exitPrice,
            pnl,
            side: position.side,
            units: position.units,
            strategy: 'Backtest',
            timestamp: candle.time,
          });
          balance += pnl;
          equityCurve.push(balance);
          position = null;
          continue;
        }
        // If no exit, update equity with floating P&L
        const floatingPL = (position.side === 'BUY' ? (currentPrice - position.entry) : (position.entry - currentPrice)) * position.units * 100000;
        equityCurve.push(balance + floatingPL);
      }

      // Generate signal using the engine
      const signal = await generateSignal(instrument, strategy, { ...params, timeframe });
      if (signal && signal.side && signal.entryPrice && signal.stopLoss && signal.takeProfit) {
        // Enter trade
        const entryPrice = currentPrice + (signal.side === 'BUY' ? this.slippage * pipSize : -this.slippage * pipSize);
        // Adjust SL/TP for slippage
        const stopLoss = signal.stopLoss + (signal.side === 'BUY' ? -this.slippage * pipSize : this.slippage * pipSize);
        const takeProfit = signal.takeProfit + (signal.side === 'BUY' ? -this.slippage * pipSize : this.slippage * pipSize);
        const units = signal.recommendedLotSize || 0.01;
        position = {
          side: signal.side,
          entry: entryPrice,
          stopLoss,
          takeProfit,
          units,
        };
        // Record entry in equity (entry price used)
        // We'll record the equity at entry
        equityCurve.push(balance);
      } else {
        // No trade, equity remains same as previous
        // To avoid duplicate entries, we only push if we haven't pushed on this candle
        // We'll check if the last equity value was already from this candle (but we don't have a way to track).
        // We'll push only if we didn't push in this iteration.
        // We'll track a flag.
        if (equityCurve[equityCurve.length - 1] !== balance) {
          equityCurve.push(balance);
        }
      }
    }

    // If position still open at end, close at last price
    if (position) {
      const lastPrice = parseFloat(candles[candles.length - 1].mid.c);
      const pnl = (position.side === 'BUY' ? (lastPrice - position.entry) : (position.entry - lastPrice)) * position.units * 100000;
      allTrades.push({
        entry: position.entry,
        exit: lastPrice,
        pnl,
        side: position.side,
        units: position.units,
        strategy: 'Backtest',
        timestamp: candles[candles.length - 1].time,
      });
      balance += pnl;
      equityCurve.push(balance);
    }

    this.trades = allTrades;
    this.equity = equityCurve;
    const metrics = calculateMetrics(allTrades, this.config.initialBalance || 10000);
    return {
      trades: allTrades,
      equity: equityCurve,
      finalBalance: balance,
      metrics,
    };
  }
}

// Helper: pip size
function getPipSize(instrument) {
  if (instrument.includes('JPY')) return 0.01;
  return 0.0001;
}

// ---------- 2. PORTFOLIO MANAGER ----------
class PortfolioManager {
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
    const { instrument, strategy, timeframe, startDate, endDate, paramRanges, windowSize, stepSize, initialBalance = 10000 } = this.config;
    let currentStart = new Date(startDate);
    const results = [];
    while (currentStart < endDate) {
      const inSampleEnd = new Date(currentStart.getTime() + windowSize * 24 * 60 * 60 * 1000);
      const outSampleStart = new Date(inSampleEnd.getTime());
      const outSampleEnd = new Date(outSampleStart.getTime() + stepSize * 24 * 60 * 60 * 1000);
      if (outSampleEnd > endDate) break;
      let bestParams = null;
      let bestScore = -Infinity;
      for (const [key, values] of Object.entries(paramRanges)) {
        for (const val of values) {
          const params = { [key]: val };
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
        // Combine win rate and profit factor
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
