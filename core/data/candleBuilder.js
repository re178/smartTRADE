// core/data/candleBuilder.js
// Aggregates ticks into OHLCV candles for multiple timeframes.
// Emits 'candleClosed' when a candle completes.

const EventEmitter = require('events');
const priceBuffer = require('./priceBuffer');
const logger = require('../../infrastructure/logger') || console;

const TIMEFRAMES = {
  M1: 60 * 1000,
  M5: 5 * 60 * 1000,
  M15: 15 * 60 * 1000,
  M30: 30 * 60 * 1000,
  H1: 60 * 60 * 1000,
  H4: 4 * 60 * 60 * 1000,
  D1: 24 * 60 * 60 * 1000,
};

class CandleBuilder extends EventEmitter {
  constructor() {
    super();
    // Active (open) candles: Map<symbol, Map<timeframe, candle>>
    this._candles = new Map();
    // Cache to avoid duplicate emits
    this._closed = new Map();

    priceBuffer.on('tick', (tick) => this._onTick(tick));
    // Force close every second to catch long gaps
    setInterval(() => this._closeExpired(), 1000);

    logger.info('[CandleBuilder] Initialized');
  }

  _onTick(tick) {
    const { symbol, mid, time } = tick;
    for (const [tfName, tfMs] of Object.entries(TIMEFRAMES)) {
      this._updateCandle(symbol, tfName, tfMs, mid, time);
    }
  }

  _updateCandle(symbol, tfName, tfMs, price, time) {
    const startTime = Math.floor(time / tfMs) * tfMs;
    if (!this._candles.has(symbol)) this._candles.set(symbol, new Map());
    const symbolCandles = this._candles.get(symbol);

    let candle = symbolCandles.get(tfName);
    if (!candle || candle.startTime !== startTime) {
      if (candle) {
        this._closeCandle(symbol, tfName, candle);
      }
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
    candle.high = Math.max(candle.high, price);
    candle.low = Math.min(candle.low, price);
    candle.close = price;
    candle.volume += 1;
    candle.tickCount++;
  }

  _closeCandle(symbol, tfName, candle) {
    const key = `${symbol}:${tfName}:${candle.startTime}`;
    if (this._closed.has(key)) return;
    this._closed.set(key, true);

    const closedCandle = {
      symbol,
      timeframe: tfName,
      time: candle.startTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      tickCount: candle.tickCount,
    };

    this.emit('candleClosed', closedCandle);

    // Remove from active candles
    const symbolCandles = this._candles.get(symbol);
    if (symbolCandles) {
      symbolCandles.delete(tfName);
      if (symbolCandles.size === 0) this._candles.delete(symbol);
    }
  }

  _closeExpired() {
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

  getCurrentCandle(symbol, timeframe) {
    const symbolCandles = this._candles.get(symbol);
    if (!symbolCandles) return null;
    return symbolCandles.get(timeframe) || null;
  }
}

module.exports = new CandleBuilder();
