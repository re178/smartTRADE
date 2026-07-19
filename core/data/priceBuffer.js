// core/data/priceBuffer.js
// RTS Real‑Time Price Buffer
// Purpose: Store latest bid/ask for all symbols and maintain a rolling tick history.
// Answers: "What is the current price of EURUSD right now?"

const EventEmitter = require('events');

class PriceBuffer extends EventEmitter {
  constructor() {
    super();
    // Latest tick per symbol: { symbol, bid, ask, mid, time }
    this.latest = new Map();
    // Rolling tick history per symbol (max 1000 ticks)
    this.ticks = new Map();
    this.maxTicks = 1000;
  }

  /**
   * Update price for a symbol with a new tick.
   * @param {string} symbol - MT5 symbol name (e.g., 'EURUSD')
   * @param {number} bid
   * @param {number} ask
   * @param {number} time - Unix timestamp (ms or seconds)
   */
  update(symbol, bid, ask, time) {
    const mid = (bid + ask) / 2;
    const tick = { symbol, bid, ask, mid, time: time || Date.now() };
    this.latest.set(symbol, tick);

    // Store in rolling history
    if (!this.ticks.has(symbol)) {
      this.ticks.set(symbol, []);
    }
    const history = this.ticks.get(symbol);
    history.push(tick);
    if (history.length > this.maxTicks) {
      history.shift();
    }

    // Emit tick event (candleStore listens to this)
    this.emit('tick', tick);
  }

  /**
   * Get the latest tick for a symbol.
   */
  get(symbol) {
    return this.latest.get(symbol) || null;
  }

  /**
   * Get tick history for a symbol (up to maxTicks).
   */
  getHistory(symbol) {
    return this.ticks.get(symbol) || [];
  }

  /**
   * Clear all data (useful for reset).
   */
  clear() {
    this.latest.clear();
    this.ticks.clear();
  }
}

// Singleton instance
const priceBuffer = new PriceBuffer();
module.exports = priceBuffer;
