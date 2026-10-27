// core/analytics/dashboard.js
// RTS Live Performance Analytics Dashboard
// Belief/edge computed from current pattern analysis (no stateStore).

'use strict';

const EventEmitter = require('events');
const Trade = require('../../models/Trade');
const { calculateMetrics } = require('./performanceSuite');
const eventBus = require('../../infrastructure/eventBus');
const marketStateCache = require('../data/marketStateCache');
const { dataOrchestrator } = require('../data/dataOrchestrator');
const candlePatterns = require('../intelligence/patterns/candlePatterns');
const candleHistory = require('../data/candleHistory');
const logger = require('../../infrastructure/logger') || console;

const CONFIG = {
  UPDATE_INTERVAL_MS: 30000,
  MAX_HISTORY_TRADES: 500,
  MIN_TRADES_FOR_STATS: 10,
};

class AnalyticsDashboard extends EventEmitter {
  constructor() {
    super();
    this._trades = [];
    this._metrics = {
      winRate: 0, profitFactor: 0, sharpe: 0, maxDrawdown: 0, expectancy: 0,
      totalTrades: 0, winningTrades: 0, losingTrades: 0,
      avgWin: 0, avgLoss: 0, profitPerTrade: 0,
      dailyPnL: 0, dailyTrades: 0, weeklyPnL: 0, monthlyPnL: 0,
      currentDrawdown: 0, peakEquity: 0, currentEquity: 0,
      belief: 'neutral', beliefConfidence: 50, edge: 0, winProbability: 0.5,
      similarityCount: 0, marketQuality: 50,
      timestamp: new Date().toISOString(),
    };
    this._intervalId = null;
    this._initialBalance = 0;
    this._peakEquity = 0;
    this._currentEquity = 0;

    eventBus.on('trade.closed', (data) => {
      if (data.trade) {
        this._addTrade(data.trade);
        this._updateMetrics();
      }
    });

    eventBus.on('account.fetched', (account) => {
      const equity = parseFloat(account.equity);
      if (equity > this._peakEquity) this._peakEquity = equity;
      this._currentEquity = equity;
      this._updateMetrics();
    });

    dataOrchestrator.register('dashboardMetrics', 'recoverable', {
      ttl: 60000,
      snapshotInterval: 30000,
    });

    logger.info('[AnalyticsDashboard] Initialized.');
  }

  start() {
    if (this._intervalId) return;
    this._loadHistoricalTrades();
    this._intervalId = setInterval(() => {
      this._updateMetrics();
      this._emitMetrics();
    }, CONFIG.UPDATE_INTERVAL_MS);
    logger.info('[AnalyticsDashboard] Started.');
  }

  stop() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    logger.info('[AnalyticsDashboard] Stopped.');
  }

  async _loadHistoricalTrades() {
    try {
      const trades = await Trade.find({ status: 'CLOSED' })
        .sort({ closeTime: -1 })
        .limit(CONFIG.MAX_HISTORY_TRADES)
        .lean();
      trades.reverse();
      this._trades = trades;
      logger.info(`[AnalyticsDashboard] Loaded ${this._trades.length} historical trades.`);
      this._updateMetrics();
      this._emitMetrics();
    } catch (err) {
      logger.error('[AnalyticsDashboard] Failed to load historical trades:', err.message);
    }
  }

  _addTrade(trade) {
    this._trades.push(trade);
    if (this._trades.length > CONFIG.MAX_HISTORY_TRADES) this._trades.shift();
    this._updateMetrics();
  }

  async _updateMetrics() {
    const trades = this._trades;
    if (trades.length < CONFIG.MIN_TRADES_FOR_STATS) return;

    const initialBalance = this._initialBalance || 10000;
    const metrics = calculateMetrics(trades, initialBalance);

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
    const monthAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());

    let dailyPnL = 0, dailyTrades = 0, weeklyPnL = 0, monthlyPnL = 0;
    for (const t of trades) {
      const ct = new Date(t.closeTime);
      const pnl = t.pnl || 0;
      if (ct >= today) { dailyPnL += pnl; dailyTrades++; }
      if (ct >= weekAgo) weeklyPnL += pnl;
      if (ct >= monthAgo) monthlyPnL += pnl;
    }

    let drawdown = 0;
    if (this._peakEquity > 0 && this._currentEquity > 0) {
      drawdown = (this._peakEquity - this._currentEquity) / this._peakEquity;
    }

    // Pattern-based belief/edge (no stateStore)
    let belief = 'neutral';
    let beliefConfidence = 50;
    let edge = 0;
    let winProbability = 0.5;
    let similarityCount = 0;
    let marketQuality = 50;

    try {
      const symbol = 'EURUSD';
      const state = marketStateCache.get(symbol);
      if (state) {
        marketQuality = (state.summary && state.summary.marketQuality) || 50;
        const candles = await candleHistory.getHistory(symbol, 'M5', 100);
        if (candles && candles.length >= 20) {
          const pattern = candlePatterns.analyze(candles);
          const momentum = candlePatterns.momentum(candles, 5);
          belief = (pattern.bias || 'neutral').toLowerCase();
          beliefConfidence = pattern.confidence || 50;
          edge = (pattern.confidence / 100) - 0.5;

          const patDir = pattern.bias === 'BULLISH' ? 1 : pattern.bias === 'BEARISH' ? -1 : 0;
          const momDir = momentum.direction === 'UP' ? 1 : momentum.direction === 'DOWN' ? -1 : 0;
          const aligned = patDir !== 0 && patDir === momDir;
          winProbability = aligned
            ? Math.min(0.85, 0.5 + (pattern.confidence / 100 - 0.5))
            : Math.max(0.15, 0.5 - (pattern.confidence / 100 - 0.5) * 0.5);
          similarityCount = candles.length;
        }
      }
    } catch (err) {
      logger.warn('[AnalyticsDashboard] Pattern belief failed:', err.message);
    }

    this._metrics = {
      ...metrics,
      dailyPnL, dailyTrades, weeklyPnL, monthlyPnL,
      currentDrawdown: drawdown,
      peakEquity: this._peakEquity,
      currentEquity: this._currentEquity,
      belief, beliefConfidence: Math.round(beliefConfidence),
      edge, winProbability, similarityCount,
      marketQuality: Math.round(marketQuality),
      timestamp: new Date().toISOString(),
    };
  }

  _emitMetrics() {
    this.emit('metrics', this._metrics);
    dataOrchestrator.publish('dashboardMetrics', this._metrics, { source: 'analyticsDashboard' });
  }

  getMetrics() { return { ...this._metrics }; }

  setInitialBalance(balance) {
    this._initialBalance = balance;
    this._peakEquity = balance;
    this._currentEquity = balance;
  }
}

const analyticsDashboard = new AnalyticsDashboard();
module.exports = analyticsDashboard;
