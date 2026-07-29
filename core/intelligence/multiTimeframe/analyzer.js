// core/intelligence/multiTimeframe/analyzer.js
// Base class for timeframe analyzers.
// Provides common functionality: history fetching, state caching, and event emission.

const EventEmitter = require('events');
const candleHistory = require('../../data/candleHistory');
const logger = require('../../../infrastructure/logger') || console;

class TimeframeAnalyzer extends EventEmitter {
  /**
   * @param {string} timeframe - e.g., 'M1', 'M5', 'M15', 'H1', 'H4'
   * @param {string} symbol - e.g., 'EUR_USD'
   * @param {number} requiredCandles - Minimum candles needed for analysis (default 50)
   */
  constructor(timeframe, symbol, requiredCandles = 50) {
    super();
    this.timeframe = timeframe;
    this.symbol = symbol;
    this._requiredCandles = requiredCandles;
    this._state = null;
    this._lastCandleTime = 0;
    this._candleCount = 0;
  }

  /**
   * Fetch history for this symbol and timeframe.
   * @param {number} limit - Number of candles to fetch (default 200)
   * @returns {Promise<Array>} Array of candle objects.
   */
  async getHistory(limit = 200) {
    return await candleHistory.getHistory(this.symbol, this.timeframe, limit);
  }

  /**
   * Main analysis method – must be implemented by subclasses.
   * @param {Object} candle - The latest closed candle (optional)
   * @returns {Promise<Object|null>} Analysis result.
   */
  async analyze(candle = null) {
    throw new Error('analyze() must be implemented by subclass');
  }

  /**
   * Get the latest analysis state.
   * @returns {Object|null} The last analysis result.
   */
  getState() {
    return this._state;
  }

  /**
   * Emit an analysis event.
   * @param {Object} analysis - The analysis result.
   */
  _emitAnalysis(analysis) {
    this._state = analysis;
    this.emit('analysis', analysis);
  }

  /**
   * Check if enough candles are available.
   * @param {Array} history - The candle history.
   * @returns {boolean} True if enough candles exist.
   */
  _hasEnoughCandles(history) {
    return history && history.length >= this._requiredCandles;
  }
}

module.exports = TimeframeAnalyzer;
