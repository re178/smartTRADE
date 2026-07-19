// core/validation/engine.js
// RTS Continuous Validation Engine
// Purpose: Backtest, validate, and monitor system performance.
// Answers: "Is the system still performing as expected? Should we adapt or pause?"

const EventEmitter = require('events');
const { BacktestingEngine, WalkForwardOptimizer, calculateMetrics } = require('../analytics/performanceSuite');
const { generateSignal } = require('../strategy/engine');
const marketProvider = require('../market/provider');
const Trade = require('../../models/Trade');
const logger = require('../../infrastructure/logger') || console;

// Configuration
const CONFIG = {
  // Backtesting defaults
  DEFAULT_SLIPPAGE: 0.5,
  DEFAULT_SPREAD: 1,
  DEFAULT_COMMISSION: 0,
  // Walk-forward
  WALK_FORWARD_WINDOW: 100,       // Number of candles per training window
  WALK_FORWARD_STEP: 20,          // Step size for rolling windows
  // Performance thresholds (for monitoring)
  MIN_WIN_RATE: 0.45,
  MIN_PROFIT_FACTOR: 1.2,
  MAX_DRAWDOWN: 0.20,
  // Monitoring
  CHECK_INTERVAL_MS: 3600000,     // Check every hour
  TRADES_FOR_CHECK: 20,           // Minimum trades to evaluate
};

class ValidationEngine extends EventEmitter {
  constructor() {
    super();
    this._lastCheck = 0;
    this._intervalId = null;
    this._currentPerformance = null;
    this._historicalPerformance = [];
    this._isRunning = false;

    logger.info('[ValidationEngine] Initialized.');
  }

  /**
   * Start continuous validation and monitoring.
   */
  start() {
    if (this._isRunning) return;
    this._isRunning = true;
    this._intervalId = setInterval(() => {
      this._runMonitoring();
    }, CONFIG.CHECK_INTERVAL_MS);
    logger.info('[ValidationEngine] Started monitoring.');
  }

  /**
   * Stop monitoring.
   */
  stop() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    this._isRunning = false;
    logger.info('[ValidationEngine] Stopped.');
  }

  /**
   * Run a full backtest on historical data.
   * @param {Object} params - { symbol, strategy, timeframe, startDate, endDate, initialBalance, slippage }
   * @returns {Promise<Object>} - Backtest results with metrics.
   */
  async runBacktest(params) {
    const {
      symbol,
      strategy = 'weightedvote',
      timeframe = 'M5',
      startDate,
      endDate,
      initialBalance = 10000,
      slippage = CONFIG.DEFAULT_SLIPPAGE,
      spread = CONFIG.DEFAULT_SPREAD,
      commission = CONFIG.DEFAULT_COMMISSION,
    } = params;

    logger.info(`[ValidationEngine] Starting backtest for ${symbol} (${strategy}) from ${startDate} to ${endDate}`);

    try {
      // Fetch historical candles
      const candles = await marketProvider.getHistoricalCandles(
        symbol,
        new Date(startDate),
        new Date(endDate),
        timeframe,
        5000,
        process.env.DEFAULT_TRADING_PRODUCT || 'mt5'
      );

      if (!candles || candles.length < 100) {
        throw new Error('Insufficient candle data for backtest.');
      }

      // Instantiate backtesting engine
      const engine = new BacktestingEngine({
        initialBalance,
        slippage,
        spread,
        commission,
      });

      // We need to override the engine's run method to use our own strategy logic.
      // Since BacktestingEngine is placeholder, we'll implement a simple backtest here.
      // For production, we would implement a proper backtest engine.
      // But we can reuse the existing BacktestingEngine if it's already implemented.

      // For now, we'll simulate a simple backtest using the strategy generator.
      const trades = [];
      let balance = initialBalance;
      let position = null;

      for (let i = 100; i < candles.length - 1; i++) {
        const currentCandle = candles[i];
        // Simulate signal generation using the strategy
        const signal = await generateSignal(symbol, strategy, {
          timeframe,
          accountBalance: balance,
          accountCurrency: 'USD',
        });

        if (signal && signal.side && position === null) {
          // Enter trade
          const lotSize = signal.recommendedLotSize || 0.01;
          const entryPrice = currentCandle.mid.c;
          const stopLoss = signal.stopLoss || entryPrice * 0.99;
          const takeProfit = signal.takeProfit || entryPrice * 1.01;
          position = {
            side: signal.side,
            entryPrice,
            stopLoss,
            takeProfit,
            lotSize,
            entryIndex: i,
          };
        } else if (position) {
          // Check if exit conditions are met (using the next candle)
          const nextCandle = candles[i + 1];
          const high = nextCandle.mid.h;
          const low = nextCandle.mid.l;
          const close = nextCandle.mid.c;

          let exitPrice = null;
          let exitReason = '';

          if (position.side === 'BUY') {
            if (low <= position.stopLoss) {
              exitPrice = position.stopLoss;
              exitReason = 'SL';
            } else if (high >= position.takeProfit) {
              exitPrice = position.takeProfit;
              exitReason = 'TP';
            } else if (i === candles.length - 2) {
              exitPrice = close;
              exitReason = 'Close';
            }
          } else { // SELL
            if (high >= position.stopLoss) {
              exitPrice = position.stopLoss;
              exitReason = 'SL';
            } else if (low <= position.takeProfit) {
              exitPrice = position.takeProfit;
              exitReason = 'TP';
            } else if (i === candles.length - 2) {
              exitPrice = close;
              exitReason = 'Close';
            }
          }

          if (exitPrice) {
            const pnl = position.side === 'BUY'
              ? (exitPrice - position.entryPrice) * position.lotSize
              : (position.entryPrice - exitPrice) * position.lotSize;
            balance += pnl;
            trades.push({
              entryPrice: position.entryPrice,
              exitPrice,
              pnl,
              side: position.side,
              lotSize: position.lotSize,
              entryTime: new Date(candles[position.entryIndex].time * 1000),
              exitTime: new Date(candles[i + 1].time * 1000),
              exitReason,
              strategy: signal.strategy || strategy,
            });
            position = null;
          }
        }
      }

      const metrics = calculateMetrics(trades, initialBalance);
      metrics.totalTrades = trades.length;
      metrics.trades = trades;

      logger.info(`[ValidationEngine] Backtest complete. Trades: ${trades.length}, Win Rate: ${(metrics.winRate * 100).toFixed(2)}%`);

      return metrics;
    } catch (err) {
      logger.error('[ValidationEngine] Backtest error:', err.message);
      throw err;
    }
  }

  /**
   * Run walk‑forward optimization on a strategy.
   * @param {Object} params - { symbol, strategy, timeframe, startDate, endDate, windowSize, stepSize }
   * @returns {Promise<Object>} - Walk‑forward results.
   */
  async runWalkForward(params) {
    const {
      symbol,
      strategy = 'weightedvote',
      timeframe = 'M5',
      startDate,
      endDate,
      windowSize = CONFIG.WALK_FORWARD_WINDOW,
      stepSize = CONFIG.WALK_FORWARD_STEP,
    } = params;

    logger.info(`[ValidationEngine] Starting walk‑forward for ${symbol} (${strategy})`);

    try {
      // Fetch candles
      const candles = await marketProvider.getHistoricalCandles(
        symbol,
        new Date(startDate),
        new Date(endDate),
        timeframe,
        5000,
        process.env.DEFAULT_TRADING_PRODUCT || 'mt5'
      );

      if (!candles || candles.length < windowSize + stepSize) {
        throw new Error('Insufficient data for walk‑forward.');
      }

      const results = [];
      let totalTrades = 0;

      for (let i = 0; i < candles.length - windowSize - stepSize; i += stepSize) {
        const trainStart = i;
        const trainEnd = i + windowSize;
        const testStart = trainEnd;
        const testEnd = Math.min(testStart + stepSize, candles.length - 1);

        const trainCandles = candles.slice(trainStart, trainEnd);
        const testCandles = candles.slice(testStart, testEnd);

        // For simplicity, we'll run a backtest on the test period using the same strategy.
        // In a real walk‑forward, we would optimize parameters on the training period.
        // We'll assume the strategy parameters are fixed.
        const backtestParams = {
          symbol,
          strategy,
          timeframe,
          startDate: new Date(testCandles[0].time * 1000),
          endDate: new Date(testCandles[testCandles.length - 1].time * 1000),
          initialBalance: 10000,
        };
        const metrics = await this.runBacktest(backtestParams);
        results.push({
          period: { start: testStart, end: testEnd },
          trades: metrics.trades || [],
          winRate: metrics.winRate,
          profitFactor: metrics.profitFactor,
          totalTrades: metrics.totalTrades || 0,
        });
        totalTrades += metrics.totalTrades || 0;
      }

      // Aggregate results
      const aggregated = {
        periods: results.length,
        totalTrades,
        avgWinRate: results.reduce((sum, r) => sum + (r.winRate || 0), 0) / results.length,
        avgProfitFactor: results.reduce((sum, r) => sum + (r.profitFactor || 0), 0) / results.length,
        details: results,
      };

      logger.info(`[ValidationEngine] Walk‑forward complete. Periods: ${aggregated.periods}, Total trades: ${aggregated.totalTrades}`);
      return aggregated;
    } catch (err) {
      logger.error('[ValidationEngine] Walk‑forward error:', err.message);
      throw err;
    }
  }

  /**
   * Validate a strategy on out‑of‑sample data.
   * @param {Object} params - { symbol, strategy, timeframe, trainEndDate, testEndDate }
   * @returns {Promise<Object>} - Validation results.
   */
  async validateOutOfSample(params) {
    const {
      symbol,
      strategy = 'weightedvote',
      timeframe = 'M5',
      trainEndDate,
      testEndDate,
    } = params;

    logger.info(`[ValidationEngine] Starting out‑of‑sample validation for ${symbol} (${strategy})`);

    try {
      // We'll train on the period before trainEndDate and test on the period after.
      // For simplicity, we'll just run a backtest on the test period and compare to expected.
      const testStart = new Date(trainEndDate);
      const testEnd = new Date(testEndDate);

      const backtestParams = {
        symbol,
        strategy,
        timeframe,
        startDate: testStart,
        endDate: testEnd,
        initialBalance: 10000,
      };

      const metrics = await this.runBacktest(backtestParams);

      // Evaluate against thresholds
      const passed = {
        winRate: metrics.winRate >= CONFIG.MIN_WIN_RATE,
        profitFactor: metrics.profitFactor >= CONFIG.MIN_PROFIT_FACTOR,
        maxDrawdown: metrics.maxDrawdown <= CONFIG.MAX_DRAWDOWN,
      };
      const overallPassed = Object.values(passed).every(v => v === true);

      logger.info(`[ValidationEngine] Out‑of‑sample validation complete. Overall: ${overallPassed ? 'PASSED' : 'FAILED'}`);
      return {
        metrics,
        passed,
        overallPassed,
        thresholds: {
          minWinRate: CONFIG.MIN_WIN_RATE,
          minProfitFactor: CONFIG.MIN_PROFIT_FACTOR,
          maxDrawdown: CONFIG.MAX_DRAWDOWN,
        },
      };
    } catch (err) {
      logger.error('[ValidationEngine] Out‑of‑sample validation error:', err.message);
      throw err;
    }
  }

  /**
   * Monitor live performance and alert if degradation is detected.
   */
  async _runMonitoring() {
    try {
      // Fetch recent closed trades
      const trades = await Trade.find({ status: 'CLOSED' })
        .sort({ closeTime: -1 })
        .limit(CONFIG.TRADES_FOR_CHECK)
        .lean();

      if (trades.length < CONFIG.TRADES_FOR_CHECK) {
        logger.debug('[ValidationEngine] Insufficient trades for monitoring.');
        return;
      }

      // Calculate performance metrics
      const metrics = calculateMetrics(trades, 10000); // initial balance not needed for ratios

      const alerts = [];
      if (metrics.winRate < CONFIG.MIN_WIN_RATE) {
        alerts.push(`Win rate below threshold: ${(metrics.winRate * 100).toFixed(2)}% < ${CONFIG.MIN_WIN_RATE * 100}%`);
      }
      if (metrics.profitFactor < CONFIG.MIN_PROFIT_FACTOR) {
        alerts.push(`Profit factor below threshold: ${metrics.profitFactor.toFixed(2)} < ${CONFIG.MIN_PROFIT_FACTOR}`);
      }
      if (metrics.maxDrawdown > CONFIG.MAX_DRAWDOWN) {
        alerts.push(`Drawdown above threshold: ${(metrics.maxDrawdown * 100).toFixed(2)}% > ${CONFIG.MAX_DRAWDOWN * 100}%`);
      }

      // Store current performance
      this._currentPerformance = {
        metrics,
        alerts,
        timestamp: new Date().toISOString(),
      };

      this._historicalPerformance.push(this._currentPerformance);
      if (this._historicalPerformance.length > 100) {
        this._historicalPerformance.shift();
      }

      if (alerts.length > 0) {
        logger.warn(`[ValidationEngine] Performance alerts: ${alerts.join('; ')}`);
        this.emit('degradation', { alerts, metrics });
      } else {
        logger.info('[ValidationEngine] Performance check passed.');
      }

      this.emit('performanceCheck', this._currentPerformance);
    } catch (err) {
      logger.error('[ValidationEngine] Monitoring error:', err.message);
    }
  }

  /**
   * Get the latest performance report.
   */
  getPerformanceReport() {
    return this._currentPerformance || null;
  }

  /**
   * Get historical performance data.
   */
  getPerformanceHistory() {
    return [...this._historicalPerformance];
  }

  /**
   * Run a full validation suite for a strategy.
   * @param {Object} params - { symbol, strategy, timeframe, startDate, endDate, trainEndDate, testEndDate }
   * @returns {Promise<Object>} - Comprehensive validation report.
   */
  async runFullValidation(params) {
    const {
      symbol,
      strategy = 'weightedvote',
      timeframe = 'M5',
      startDate,
      endDate,
      trainEndDate,
      testEndDate,
    } = params;

    logger.info(`[ValidationEngine] Running full validation suite for ${symbol} (${strategy})`);

    const report = {
      symbol,
      strategy,
      timeframe,
      timestamp: new Date().toISOString(),
      backtest: null,
      walkForward: null,
      outOfSample: null,
      summary: {},
    };

    try {
      // 1. Full backtest
      report.backtest = await this.runBacktest({
        symbol,
        strategy,
        timeframe,
        startDate,
        endDate,
      });

      // 2. Walk-forward
      report.walkForward = await this.runWalkForward({
        symbol,
        strategy,
        timeframe,
        startDate,
        endDate,
        windowSize: 100,
        stepSize: 20,
      });

      // 3. Out-of-sample validation
      report.outOfSample = await this.validateOutOfSample({
        symbol,
        strategy,
        timeframe,
        trainEndDate,
        testEndDate,
      });

      // 4. Summary
      const bt = report.backtest;
      const oos = report.outOfSample;
      report.summary = {
        totalTrades: bt.totalTrades || 0,
        winRate: bt.winRate || 0,
        profitFactor: bt.profitFactor || 0,
        maxDrawdown: bt.maxDrawdown || 0,
        oosWinRate: oos.metrics?.winRate || 0,
        oosProfitFactor: oos.metrics?.profitFactor || 0,
        oosPassed: oos.overallPassed || false,
        walkForwardAvgWinRate: report.walkForward?.avgWinRate || 0,
      };

      logger.info(`[ValidationEngine] Full validation suite complete for ${symbol}.`);
      return report;
    } catch (err) {
      logger.error('[ValidationEngine] Full validation error:', err.message);
      report.summary.error = err.message;
      return report;
    }
  }
}

// Singleton
const validationEngine = new ValidationEngine();
module.exports = validationEngine;
