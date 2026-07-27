// core/data/candleStore.js
// Thin wrapper that combines CandleBuilder and CandleHistory for backward compatibility.

const candleBuilder = require('./candleBuilder');
const candleHistory = require('./candleHistory');
const EventEmitter = require('events');

class CandleStore extends EventEmitter {
  constructor() {
    super();
    // Forward events from builder
    candleBuilder.on('candleClosed', (candle) => {
      this.emit('candleClosed', candle);
      // Store in history
      candleHistory.store(candle);
    });
  }

  // Delegate methods
  getHistory(symbol, timeframe, limit) {
    return candleHistory.getHistory(symbol, timeframe, limit);
  }

  getCurrentCandle(symbol, timeframe) {
    return candleBuilder.getCurrentCandle(symbol, timeframe);
  }

  clear() {
    candleHistory.clear();
  }
}

module.exports = new CandleStore();
