// core/performance/performanceMonitor.js
// Self‑contained Performance Monitor – listens to trade.closed, updates OTIE config.
// Just require this file once (e.g., in server.js) and it runs automatically.

const Trade = require('../../models/Trade');
const eventBus = require('../../infrastructure/eventBus');
const logger = require('../../infrastructure/logger') || console;
const EventEmitter = require('events');

// Configuration (can be overridden via env)
const CONFIG = {
  TARGET_RR_RATIO: parseFloat(process.env.TARGET_RR_RATIO) || 3.0,
  WINDOW_SIZE: parseInt(process.env.PERFORMANCE_WINDOW) || 100,
  MIN_TRADES_FOR_ADJUSTMENT: parseInt(process.env.MIN_TRADES_FOR_ADJUST) || 20,
  ADJUSTMENT_STEP: 0.05,
};

class PerformanceMonitor extends EventEmitter {
  constructor() {
    super();
    this.trades = [];
    this.windowSize = CONFIG.WINDOW_SIZE;
    this.minTrades = CONFIG.MIN_TRADES_FOR_ADJUSTMENT;
    this.targetRR = CONFIG.TARGET_RR_RATIO;
    this.step = CONFIG.ADJUSTMENT_STEP;

    // Current thresholds (these will be adjusted)
    this.thresholds = {
      breakevenProfitR: 0.5,
      progressiveSLSteps: [
        { profitR: 0.5, slR: -0.2 },
        { profitR: 1.0, slR: 0.0 },
        { profitR: 2.0, slR: 0.5 },
        { profitR: 3.0, slR: 1.0 },
        { profitR: 5.0, slR: 2.0 },
        { profitR: 8.0, slR: 4.0 },
      ],
      partialFractionMin: 0.1,
      partialFractionMax: 0.5,
      expectedRemainingThreshold: 0.5,
    };

    // Hook into trade.closed event
    eventBus.on('trade.closed', this._onTradeClosed.bind(this));

    logger.info('[PerformanceMonitor] Initialized. Target R/R =', this.targetRR);
  }

  async _onTradeClosed(data) {
    try {
      const trade = await Trade.findOne({ contractId: data.contractId });
      if (!trade) return;
      this.recordTrade(trade);
    } catch (err) {
      logger.error('[PerformanceMonitor] Error recording trade:', err.message);
    }
  }

  recordTrade(trade) {
    const profitR = trade.pnl / (trade.riskAmount || 1);
    this.trades.push(profitR);
    if (this.trades.length > this.windowSize) this.trades.shift();

    if (this.trades.length >= this.minTrades) {
      this._updateThresholds();
    }
  }

  _updateThresholds() {
    const wins = this.trades.filter(r => r > 0);
    const losses = this.trades.filter(r => r < 0);
    if (wins.length === 0 || losses.length === 0) return;

    const avgWin = wins.reduce((a, b) => a + b, 0) / wins.length;
    const avgLoss = Math.abs(losses.reduce((a, b) => a + b, 0)) / losses.length;
    const currentRR = avgWin / avgLoss;

    logger.debug(`[PerformanceMonitor] Current R/R = ${currentRR.toFixed(2)} (target ${this.targetRR})`);

    const diff = (this.targetRR - currentRR) / this.targetRR;
    const adjustment = diff * this.step;

    // Update thresholds
    this.thresholds.breakevenProfitR = Math.max(0.2, Math.min(1.5, this.thresholds.breakevenProfitR + adjustment));
    this.thresholds.partialFractionMin = Math.max(0.05, Math.min(0.3, this.thresholds.partialFractionMin + adjustment * 0.2));
    this.thresholds.partialFractionMax = Math.max(0.3, Math.min(0.7, this.thresholds.partialFractionMax + adjustment * 0.2));
    this.thresholds.expectedRemainingThreshold = Math.max(0.2, Math.min(1.0, this.thresholds.expectedRemainingThreshold + adjustment * 0.5));

    // Adjust progressive SL steps
    const stepAdjust = adjustment * 0.3;
    this.thresholds.progressiveSLSteps = this.thresholds.progressiveSLSteps.map(step => ({
      profitR: Math.max(0.2, Math.min(10, step.profitR + stepAdjust)),
      slR: step.slR,
    }));

    // Update OTIE V5 config directly
    try {
      const otie = require('../intelligence/openTradeIntelligenceV5');
      if (otie && typeof otie.updateConfig === 'function') {
        otie.updateConfig(this.thresholds);
      }
    } catch (err) {
      // If OTIE hasn't loaded yet, ignore
    }

    this.emit('thresholdsUpdated', this.thresholds);
  }

  getStats() {
    if (this.trades.length === 0) return null;
    const wins = this.trades.filter(r => r > 0);
    const losses = this.trades.filter(r => r < 0);
    return {
      totalTrades: this.trades.length,
      wins: wins.length,
      losses: losses.length,
      avgWin: wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0,
      avgLoss: losses.length ? Math.abs(losses.reduce((a, b) => a + b, 0)) / losses.length : 0,
      rrRatio: (wins.length && losses.length) ? (wins.reduce((a, b) => a + b, 0) / wins.length) / (Math.abs(losses.reduce((a, b) => a + b, 0)) / losses.length) : 0,
    };
  }
}

// Singleton – require this file once and it's active.
module.exports = new PerformanceMonitor();
