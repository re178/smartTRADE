// core/intelligence/deep/marketState.js
// Deep Market State – computed from historical candles with session context.
// Now extends EventEmitter to emit 'stateDeveloping' events.

const EventEmitter = require('events');
const candleHistory = require('../../data/candleHistory');
const marketStateCache = require('../../data/marketStateCache');
const session = require('../session');
const {
  ADX,
  ATR,
  RSI,
  MACD,
  BollingerBands,
  findSupportResistance,
} = require('../../strategy/engine');
const logger = require('../../../infrastructure/logger') || console;

class DeepMarketState extends EventEmitter {
  constructor() {
    super();
    this.indicators = {
      adxPeriod: 14,
      atrPeriod: 14,
      rsiPeriod: 14,
      macdFast: 12,
      macdSlow: 26,
      macdSignal: 9,
      bbPeriod: 20,
      bbStd: 2,
      supportResistanceLookback: 30,
    };
    // For incremental updates
    this._rollingData = {}; // symbol -> { prices, times, velocity, lastState }
    this._lastState = {};
  }

  // ... (all other methods remain exactly the same: compute, _volatilityRegime, _suggestRegime, _trendConfidence, _calculateConfidence, _buildReason)

  /**
   * Incremental update on every tick – produces a "developing" state.
   * @param {Object} tick - { symbol, bid, ask, mid, time }
   * @returns {Object|null} Developing state.
   */
  updateIncremental(tick) {
    const { symbol, mid, time } = tick;
    if (!this._rollingData[symbol]) {
      this._rollingData[symbol] = {
        prices: [],
        times: [],
        velocity: 0,
        lastState: null,
      };
    }
    const data = this._rollingData[symbol];
    data.prices.push(mid);
    data.times.push(time);
    if (data.prices.length > 200) data.prices.shift();
    if (data.times.length > 200) data.times.shift();

    const len = data.prices.length;
    if (len < 10) return null;

    // Compute velocity (change over last 10 ticks)
    const recent = data.prices.slice(-10);
    const first = recent[0];
    const last = recent[recent.length - 1];
    const velocity = (last - first) / recent.length;
    data.velocity = velocity;

    // Compute acceleration (change in velocity)
    let acceleration = 0;
    if (len > 20) {
      const prevVelocity = data.prices.slice(-20, -10).reduce((a, b) => b - a, 0) / 10;
      acceleration = velocity - prevVelocity;
    }

    const currentSession = session.getSession();
    const state = {
      symbol,
      time: new Date(time),
      price: { current: mid },
      trend: {
        direction: velocity > 0.00005 ? 'bullish' : (velocity < -0.00005 ? 'bearish' : 'neutral'),
        strength: Math.min(100, Math.abs(velocity) * 1000),
      },
      momentum: {
        velocity,
        acceleration,
      },
      volatility: {
        // Estimate from recent price range
        atr: (Math.max(...recent) - Math.min(...recent)) / Math.sqrt(recent.length),
      },
      session: {
        name: currentSession.name,
        liquidityMultiplier: currentSession.liquidityMultiplier,
      },
      confidence: Math.min(100, 50 + Math.abs(velocity) * 2000),
      reason: 'Developing state from live ticks',
      status: 'developing',
      timestamp: new Date().toISOString(),
    };

    this._rollingData[symbol].lastState = state;

    // ---- EMIT the event ----
    this.emit('stateDeveloping', state);

    return state;
  }
}

module.exports = new DeepMarketState();
