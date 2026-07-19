// core/data/candleStore.js
const EventEmitter = require('events');
const priceBuffer = require('./priceBuffer');

// All supported timeframes (in milliseconds)
const TIMEFRAMES = {
  M1: 60 * 1000,
  M5: 5 * 60 * 1000,
  M15: 15 * 60 * 1000,
  M30: 30 * 60 * 1000,
  H1: 60 * 60 * 1000,
  H4: 4 * 60 * 60 * 1000,
  D1: 24 * 60 * 60 * 1000,
};

class CandleStore extends EventEmitter {
  constructor() {
    super();
    // Stores current candles: Map<symbol, Map<timeframe, candle>>
    this._candles = new Map();
    // Stores last closed candle times to avoid duplicate emits
    this._closed = new Map();

    // Listen to priceBuffer ticks
    priceBuffer.on('tick', (tick) => this._onTick(tick));

    // Also force-close candles every second (for timeframes with no ticks)
    setInterval(() => this._closeExpiredCandles(), 1000);
  }

  _onTick(tick) {
    const { symbol, mid, time } = tick;
    for (const [tfName, tfMs] of Object.entries(TIMEFRAMES)) {
      this._updateCandle(symbol, tfName, tfMs, mid, time);
    }
  }

  _updateCandle(symbol, tfName, tfMs, price, time) {
    const startTime = Math.floor(time / tfMs) * tfMs;

    if (!this._candles.has(symbol)) {
      this._candles.set(symbol, new Map());
    }
    const symbolCandles = this._candles.get(symbol);

    let candle = symbolCandles.get(tfName);
    if (!candle || candle.startTime !== startTime) {
      // Close previous candle if it exists
      if (candle) {
        this._closeCandle(symbol, tfName, candle);
      }
      // Start a new candle
      candle = {
        symbol,
        timeframe: tfName,
        startTime,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 0,
        tickCount: 0,
      };
      symbolCandles.set(tfName, candle);
    }

    // Update the candle
    candle.high = Math.max(candle.high, price);
    candle.low = Math.min(candle.low, price);
    candle.close = price;
    candle.volume += 1; // tick volume proxy
    candle.tickCount++;
  }

  _closeCandle(symbol, tfName, candle) {
    const key = `${symbol}:${tfName}:${candle.startTime}`;
    if (this._closed.has(key)) return;
    this._closed.set(key, true);

    // Emit the closed candle
    this.emit('candleClosed', {
      symbol,
      timeframe: tfName,
      time: candle.startTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      tickCount: candle.tickCount,
    });

    // Remove from active candles
    const symbolCandles = this._candles.get(symbol);
    if (symbolCandles) {
      symbolCandles.delete(tfName);
      if (symbolCandles.size === 0) {
        this._candles.delete(symbol);
      }
    }
  }

  _closeExpiredCandles() {
    const now = Date.now();
    for (const [symbol, symbolCandles] of this._candles) {
      for (const [tfName, candle] of symbolCandles) {
        const tfMs = TIMEFRAMES[tfName];
        if (now - candle.startTime >= tfMs) {
          this._closeCandle(symbol, tfName, candle);
        }
      }
    }
  }

  /**
   * Get the current (open) candle for a symbol and timeframe.
   * Returns null if no candle exists.
   */
  getCurrentCandle(symbol, timeframe) {
    const symbolCandles = this._candles.get(symbol);
    if (!symbolCandles) return null;
    return symbolCandles.get(timeframe) || null;
  }

  /**
   * Get the most recently closed candle for a symbol and timeframe.
   * This requires storing closed candles – we can maintain a short history.
   * For now, we'll return null and rely on the event system.
   */
  getLastClosedCandle(symbol, timeframe) {
    // We could store closed candles in a rolling buffer
    // For simplicity, we'll let the engine listen to 'candleClosed' events.
    return null;
  }
}

const candleStore = new CandleStore();
module.exports = candleStore;
