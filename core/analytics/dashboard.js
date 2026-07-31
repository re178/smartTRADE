// core/analytics/dashboard.js
// RTS Live Performance Analytics Dashboard – now with belief, similarity, and edge.

const EventEmitter = require('events');
const Trade = require('../../models/Trade');
const { calculateMetrics } = require('./performanceSuite');
const eventBus = require('../../infrastructure/eventBus');
const marketStateCache = require('../data/marketStateCache');
const stateStore = require('../intelligence/lab/stateStore');
const { dataOrchestrator } = require('../data/dataOrchestrator');
const logger = require('../../infrastructure/logger') || console;

// Configuration
const CONFIG = {
  UPDATE_INTERVAL_MS: 30000,        // Emit metrics every 30 seconds
  MAX_HISTORY_TRADES: 500,          // Trades to keep in memory for calculations
  MIN_TRADES_FOR_STATS: 10,         // Minimum trades to compute reliable stats
  EDGE_LOOKAHEAD: 5,                // Lookahead for edge calculation
  EDGE_K: 50,                       // Number of analogues
};

class AnalyticsDashboard extends EventEmitter {
  constructor() {
    super();
    this._trades = [];
    this._metrics = {
      winRate: 0,
      profitFactor: 0,
      sharpe: 0,
      maxDrawdown: 0,
      expectancy: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      avgWin: 0,
      avgLoss: 0,
      profitPerTrade: 0,
      dailyPnL: 0,
      dailyTrades: 0,
      weeklyPnL: 0,
      monthlyPnL: 0,
      currentDrawdown: 0,
      peakEquity: 0,
      currentEquity: 0,
      // NEW enhanced fields
      belief: 'neutral',
      beliefConfidence: 50,
      edge: 0,
      winProbability: 0.5,
      similarityCount: 0,
      marketQuality: 50,
      timestamp: new Date().toISOString(),
    };
    this._intervalId = null;
    this._initialBalance = 0;
    this._peakEquity = 0;
    this._currentEquity = 0;

    // Listen to trade closure events
    eventBus.on('trade.closed', (data) => {
      if (data.trade) {
        this._addTrade(data.trade);
        this._updateMetrics();
      }
    });

    // Also listen to account updates to track equity
    eventBus.on('account.fetched', (account) => {
      const equity = parseFloat(account.equity);
      if (equity > this._peakEquity) this._peakEquity = equity;
      this._currentEquity = equity;
      this._updateMetrics();
    });

    // Register with data orchestrator for cache
    dataOrchestrator.register('dashboardMetrics', 'recoverable', {
      ttl: 60000,
      snapshotInterval: 30000,
    });

    logger.info('[AnalyticsDashboard] Initialized with enhanced metrics.');
  }

  /**
   * Start periodic emission of metrics.
   */
  start() {
    if (this._intervalId) return;
    this._loadHistoricalTrades();
    this._intervalId = setInterval(() => {
      this._updateMetrics();
      this._emitMetrics();
    }, CONFIG.UPDATE_INTERVAL_MS);
    logger.info('[AnalyticsDashboard] Started.');
  }

  /**
   * Stop periodic emission.
   */
  stop() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    logger.info('[AnalyticsDashboard] Stopped.');
  }

  /**
   * Load historical trades from the database (last N closed trades).
   */
  async _loadHistoricalTrades() {
    try {
      const trades = await Trade.find({ status: 'CLOSED' })
        .sort({ closeTime: -1 })
        .limit(CONFIG.MAX_HISTORY_TRADES)
        .lean();
      // Sort ascending for proper calculation
      trades.reverse();
      this._trades = trades;
      logger.info(`[AnalyticsDashboard] Loaded ${this._trades.length} historical trades.`);
      this._updateMetrics();
      this._emitMetrics();
    } catch (err) {
      logger.error('[AnalyticsDashboard] Failed to load historical trades:', err.message);
    }
  }

  /**
   * Add a new trade to the in‑memory list.
   */
  _addTrade(trade) {
    this._trades.push(trade);
    if (this._trades.length > CONFIG.MAX_HISTORY_TRADES) {
      this._trades.shift();
    }
    this._updateMetrics();
  }

  /**
   * Recalculate all metrics based on current trades and account equity.
   * Enhanced with belief, edge, and similarity from StateStore.
   */
  async _updateMetrics() {
    const trades = this._trades;
    if (trades.length < CONFIG.MIN_TRADES_FOR_STATS) {
      // Not enough data – keep default metrics
      return;
    }

    // Calculate basic metrics using the performanceSuite helper
    const initialBalance = this._initialBalance || 10000;
    const metrics = calculateMetrics(trades, initialBalance);

    // Add additional daily/weekly/monthly P&L
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
    const monthAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());

    let dailyPnL = 0, dailyTrades = 0;
    let weeklyPnL = 0, monthlyPnL = 0;

    for (const t of trades) {
      const closeTime = new Date(t.closeTime);
      const pnl = t.pnl || 0;
      if (closeTime >= today) {
        dailyPnL += pnl;
        dailyTrades++;
      }
      if (closeTime >= weekAgo) weeklyPnL += pnl;
      if (closeTime >= monthAgo) monthlyPnL += pnl;
    }

    // Drawdown
    let drawdown = 0;
    if (this._peakEquity > 0 && this._currentEquity > 0) {
      drawdown = (this._peakEquity - this._currentEquity) / this._peakEquity;
    }

    // ---- ENHANCED: Fetch belief, edge, similarity ----
    let belief = 'neutral';
    let beliefConfidence = 50;
    let edge = 0;
    let winProbability = 0.5;
    let similarityCount = 0;
    let marketQuality = 50;

    try {
      // Get latest market state for a representative symbol (e.g., EURUSD)
      const symbol = 'EUR_USD';
      const state = marketStateCache.get(symbol);
      if (state) {
        // Extract belief from trend and momentum
        const trend = state.trend || 'neutral';
        const momentum = state.momentum?.rsi || 50;
        if (trend === 'bullish' && momentum > 55) {
          belief = 'bullish';
          beliefConfidence = Math.min(90, 50 + (momentum - 50) * 2);
        } else if (trend === 'bearish' && momentum < 45) {
          belief = 'bearish';
          beliefConfidence = Math.min(90, 50 + (50 - momentum) * 2);
        } else {
          belief = 'neutral';
          beliefConfidence = 50 + Math.abs(momentum - 50) * 0.5;
        }
        // Market quality from summary
        marketQuality = state.summary?.marketQuality || 50;

        // Compute edge from StateStore
        const features = {
          adx: state.trend?.adx || 25,
          rsi: state.momentum?.rsi || 50,
          atrPercent: state.volatility?.atrPercent || 0.005,
          bbWidth: state.volatility?.bbWidth || 0.15,
          macdHist: state.momentum?.macdHist || 0,
          liquidity: state.liquidity?.score || 0.5,
          velocity: state.awareness?.velocity || 0,
          acceleration: state.awareness?.acceleration || 0,
          pricePosition: state.structure?.pricePosition || 0.5,
          marketQuality: state.summary?.marketQuality || 50,
        };
        try {
          const edgeResult = await stateStore.computeEdge(
            features,
            symbol,
            'M5',
            CONFIG.EDGE_LOOKAHEAD,
            CONFIG.EDGE_K
          );
          edge = edgeResult.avgReturnR || 0;
          winProbability = edgeResult.winRate || 0.5;
          similarityCount = edgeResult.sampleSize || 0;
        } catch (err) {
          logger.debug('[AnalyticsDashboard] Edge computation skipped:', err.message);
        }
      }
    } catch (err) {
      logger.warn('[AnalyticsDashboard] Failed to fetch belief/edge:', err.message);
    }

    // Update metrics object
    this._metrics = {
      ...metrics,
      dailyPnL,
      dailyTrades,
      weeklyPnL,
      monthlyPnL,
      currentDrawdown: drawdown,
      peakEquity: this._peakEquity,
      currentEquity: this._currentEquity,
      // Enhanced fields
      belief,
      beliefConfidence: Math.round(beliefConfidence),
      edge,
      winProbability,
      similarityCount,
      marketQuality: Math.round(marketQuality),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Emit the current metrics to the dashboard.
   */
  _emitMetrics() {
    this.emit('metrics', this._metrics);
    // Also publish to orchestrator for recovery
    dataOrchestrator.publish('dashboardMetrics', this._metrics, {
      source: 'analyticsDashboard',
    });
  }

  /**
   * Get the current metrics without emitting.
   */
  getMetrics() {
    return { ...this._metrics };
  }

  /**
   * Set the initial account balance for historical calculations.
   */
  setInitialBalance(balance) {
    this._initialBalance = balance;
    this._peakEquity = balance;
    this._currentEquity = balance;
  }
}

// Singleton
const analyticsDashboard = new AnalyticsDashboard();
module.exports = analyticsDashboard;
