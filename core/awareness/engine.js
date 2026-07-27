// core/awareness/engine.js
// Market Awareness Engine – runs on every tick.
// Observes: spread, velocity, acceleration, liquidity, micro‑structure.
// Updates MarketStateCache (RAM) every tick, persists to MongoDB periodically.

const priceBuffer = require('../data/priceBuffer');
const marketStateCache = require('../data/marketStateCache');
const logger = require('../../infrastructure/logger') || console;

// Configuration
const CONFIG = {
  // Velocity: rolling window (in ticks) for average price change
  VELOCITY_WINDOW: 5,
  // Acceleration: change in velocity over last N ticks
  ACCELERATION_WINDOW: 3,
  // Liquidity proxy: tick frequency (ticks per second)
  LIQUIDITY_WINDOW_MS: 1000,
  // Spread smoothing: exponential moving average factor
  SPREAD_SMA_ALPHA: 0.3,
};

class MarketAwarenessEngine {
  constructor() {
    // Internal state per symbol
    this._state = new Map(); // symbol -> { priceHistory, tickTimes, spreadEMA, velocityHistory }

    // Listen to every tick from the price buffer
    priceBuffer.on('tick', (tick) => {
      this._processTick(tick);
    });

    logger.info('[MarketAwarenessEngine] Initialized, listening to ticks.');
  }

  /**
   * Process a single tick.
   */
  _processTick(tick) {
    const { symbol, bid, ask, mid, time } = tick;
    const spread = ask - bid;

    // 1. Get or create symbol state
    if (!this._state.has(symbol)) {
      this._state.set(symbol, {
        priceHistory: [],
        tickTimes: [],
        spreadEMA: null,
        velocityHistory: [],
        lastTickTime: time,
      });
    }
    const state = this._state.get(symbol);

    // 2. Update price history (for velocity)
    state.priceHistory.push(mid);
    if (state.priceHistory.length > CONFIG.VELOCITY_WINDOW + 5) {
      state.priceHistory.shift();
    }

    // 3. Update tick times (for liquidity)
    state.tickTimes.push(time);
    // Keep only last 2 seconds of ticks for liquidity calculation
    const cutoff = time - CONFIG.LIQUIDITY_WINDOW_MS * 2;
    while (state.tickTimes.length > 0 && state.tickTimes[0] < cutoff) {
      state.tickTimes.shift();
    }

    // 4. Compute spread (exponential moving average)
    if (state.spreadEMA === null) {
      state.spreadEMA = spread;
    } else {
      state.spreadEMA = state.spreadEMA * (1 - CONFIG.SPREAD_SMA_ALPHA) + spread * CONFIG.SPREAD_SMA_ALPHA;
    }

    // 5. Compute velocity (price change per tick, averaged over window)
    let velocity = 0;
    if (state.priceHistory.length >= CONFIG.VELOCITY_WINDOW) {
      const recent = state.priceHistory.slice(-CONFIG.VELOCITY_WINDOW);
      const first = recent[0];
      const last = recent[recent.length - 1];
      velocity = (last - first) / CONFIG.VELOCITY_WINDOW;
    }
    state.velocityHistory.push(velocity);
    if (state.velocityHistory.length > CONFIG.ACCELERATION_WINDOW + 5) {
      state.velocityHistory.shift();
    }

    // 6. Compute acceleration (change in velocity)
    let acceleration = 0;
    if (state.velocityHistory.length >= CONFIG.ACCELERATION_WINDOW) {
      const recentVels = state.velocityHistory.slice(-CONFIG.ACCELERATION_WINDOW);
      const first = recentVels[0];
      const last = recentVels[recentVels.length - 1];
      acceleration = (last - first) / CONFIG.ACCELERATION_WINDOW;
    }

    // 7. Liquidity proxy: tick frequency (ticks per second)
    let liquidity = 0;
    const timeWindow = CONFIG.LIQUIDITY_WINDOW_MS;
    const recentTicks = state.tickTimes.filter(t => t >= time - timeWindow);
    if (recentTicks.length > 1) {
      const duration = (recentTicks[recentTicks.length - 1] - recentTicks[0]) / 1000;
      if (duration > 0) {
        liquidity = (recentTicks.length - 1) / duration;
      }
    }
    // Normalise liquidity to a 0-1 scale (assuming max ~20 ticks/sec for forex)
    liquidity = Math.min(1, liquidity / 20);

    // 8. Update the market state cache
    const stateUpdate = {
      symbol,
      bid,
      ask,
      mid,
      spread: state.spreadEMA,
      velocity,
      acceleration,
      liquidity,
      lastUpdated: new Date(time),
    };

    // Also detect unusual events (spike, velocity burst)
    const isUnusual = this._detectUnusual(stateUpdate, state);
    if (isUnusual) {
      stateUpdate.unusual = isUnusual;
    }

    marketStateCache.update(symbol, stateUpdate);

    // 9. Emit an event for interested subscribers (e.g., dashboard)
    this.emit('marketAwareness', { symbol, ...stateUpdate });

    // Update last tick time
    state.lastTickTime = time;
  }

  /**
   * Detect unusual market events.
   */
  _detectUnusual(update, state) {
    const { velocity, acceleration, spread, liquidity } = update;
    const events = [];

    // Velocity burst: price moving faster than 2x average
    const avgVelocity = state.velocityHistory.reduce((a, b) => a + b, 0) / state.velocityHistory.length || 0;
    if (Math.abs(velocity) > Math.abs(avgVelocity) * 3 && Math.abs(velocity) > 0.0001) {
      events.push('velocity_burst');
    }

    // Spread spike: spread > 2x EMA
    if (spread > (state.spreadEMA || 0) * 2.5 && spread > 0.0002) {
      events.push('spread_spike');
    }

    // Liquidity drop
    if (liquidity < 0.1 && state.liquidityHistory && state.liquidityHistory.length > 10) {
      const avgLiquidity = state.liquidityHistory.reduce((a, b) => a + b, 0) / state.liquidityHistory.length;
      if (avgLiquidity > 0.3 && liquidity < avgLiquidity * 0.3) {
        events.push('liquidity_drop');
      }
    }

    // Store liquidity history for comparison
    if (!state.liquidityHistory) state.liquidityHistory = [];
    state.liquidityHistory.push(liquidity);
    if (state.liquidityHistory.length > 50) state.liquidityHistory.shift();

    return events.length > 0 ? events : null;
  }
}

// Add EventEmitter methods
const EventEmitter = require('events');
Object.setPrototypeOf(MarketAwarenessEngine.prototype, EventEmitter.prototype);

// Singleton
module.exports = new MarketAwarenessEngine();
