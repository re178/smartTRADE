// core/data/candleBootstrapper.js
// Fetches historical candles from MT5 on startup to populate candleHistory.
// This eliminates the long warm-up period after a restart.

const { getBroker } = require('../execution/brokerFactory');
const candleHistory = require('./candleHistory');
const logger = require('../../infrastructure/logger') || console;

const TIMEFRAMES = ['M1', 'M5', 'M15', 'H1', 'H4'];
const DEFAULT_COUNT = 200;
const DEFAULT_SYMBOLS = ['EUR_USD', 'GBP_USD', 'USD_JPY', 'AUD_USD'];

class CandleBootstrapper {
  /**
   * Bootstrap historical candles for the given symbols and timeframes.
   * @param {Array} symbols - List of symbols (e.g., ['EUR_USD'])
   * @param {string} product - Trading product (e.g., 'mt5')
   * @param {number} count - Number of candles per timeframe per symbol
   */
  async bootstrap(symbols = DEFAULT_SYMBOLS, product = 'mt5', count = DEFAULT_COUNT) {
    try {
      const broker = getBroker(product);
      if (!broker.isConnected()) {
        await broker.connect();
      }

      // Determine which candle retrieval method to use
      const candleMethod = typeof broker.getHistoricalCandles === 'function'
        ? broker.getHistoricalCandles.bind(broker)
        : (typeof broker.getCandles === 'function' ? broker.getCandles.bind(broker) : null);

      if (!candleMethod) {
        logger.warn('[Bootstrapper] Broker does not support candle retrieval. Skipping bootstrap.');
        return;
      }

      let totalLoaded = 0;
      for (const symbol of symbols) {
        for (const tf of TIMEFRAMES) {
          try {
            const candles = await candleMethod(symbol, count, tf);
            if (!candles || !candles.length) continue;

            // Convert to our internal candle format and store
            for (const c of candles) {
              // Convert time to milliseconds if in seconds
              const timeMs = (c.time && c.time < 1e12) ? c.time * 1000 : c.time;
              await candleHistory.store({
                symbol,
                timeframe: tf,
                time: timeMs,
                open: c.open || c.mid?.o,
                high: c.high || c.mid?.h,
                low: c.low || c.mid?.l,
                close: c.close || c.mid?.c,
                volume: c.volume || 0,
                source: 'broker',   // mark as historical from broker
              });
            }
            totalLoaded += candles.length;
            logger.info(`[Bootstrapper] Loaded ${candles.length} candles for ${symbol}:${tf} from broker`);
          } catch (err) {
            logger.warn(`[Bootstrapper] Failed to load ${symbol}:${tf}:`, err.message);
          }
        }
      }

      logger.info(`[Bootstrapper] Bootstrap complete. Loaded ${totalLoaded} historical candles.`);
    } catch (err) {
      logger.error('[Bootstrapper] Bootstrap failed:', err.message);
    }
  }
}

module.exports = new CandleBootstrapper();
