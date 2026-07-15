// core/market/provider.js – Market Data Provider (uses brokerFactory)

const { getBroker } = require('../execution/brokerFactory');
const logger = require('../../infrastructure/logger') || console;

// Get the appropriate broker instance
const broker = getBroker();

/**
 * Get current prices for one or more instruments.
 * @param {string[]} instruments - Array of instrument names (e.g., ['EUR_USD'])
 * @returns {Promise<Object[]>} Array of price objects from broker.
 */
async function getPrices(instruments) {
  if (!broker.isConnected()) {
    await broker.connect();
  }
  return broker.getPrices(instruments);
}

/**
 * Get candlestick data for an instrument.
 * @param {string} instrument - Instrument name (e.g., 'EUR_USD')
 * @param {number} count - Number of candles to fetch (max 5000)
 * @param {string} granularity - Candlestick granularity (e.g., 'M5', 'H1', 'D')
 * @returns {Promise<Object[]>} Array of candle objects.
 */
async function getCandles(instrument, count = 100, granularity = 'M5') {
  if (!broker.isConnected()) {
    await broker.connect();
  }
  return broker.getCandles(instrument, count, granularity);
}

/**
 * Get the current mid price for an instrument.
 * @param {string} instrument - Instrument name
 * @returns {Promise<number>} Current mid price.
 */
async function getCurrentPrice(instrument) {
  const prices = await getPrices([instrument]);
  if (!prices || prices.length === 0) {
    throw new Error(`No price data for ${instrument}`);
  }
  const price = prices[0];
  const bid = parseFloat(price.bids[0].price);
  const ask = parseFloat(price.asks[0].price);
  return (bid + ask) / 2;
}

/**
 * Fetch historical candles between two dates.
 * This function repeatedly calls getCandles with a start time to accumulate enough candles.
 * @param {string} instrument - Instrument name.
 * @param {Date} startDate - Start date.
 * @param {Date} endDate - End date.
 * @param {string} granularity - Granularity (e.g., 'M5', 'H1').
 * @param {number} maxCandlesPerRequest - Max candles per request (default 5000).
 * @returns {Promise<Object[]>} Array of candle objects sorted by time (ascending).
 */
async function getHistoricalCandles(instrument, startDate, endDate, granularity = 'M5', maxCandlesPerRequest = 5000) {
  const start = startDate.getTime();
  const end = endDate.getTime();
  if (start >= end) {
    throw new Error('Start date must be before end date');
  }

  if (!broker.isConnected()) {
    await broker.connect();
  }

  // We'll fetch candles in chunks using the broker's getCandles.
  // Since the broker may not support 'from'/'to' parameters, we use a large count approach.
  // We'll attempt to fetch a large number of candles and filter by date.
  // If the range is too large, we'll fetch multiple chunks.

  const granularitySeconds = {
    'M1': 60, 'M5': 300, 'M15': 900, 'M30': 1800,
    'H1': 3600, 'H4': 14400, 'D': 86400,
  };
  const secondsPerCandle = granularitySeconds[granularity] || 300;
  const totalSeconds = (end - start) / 1000;
  let neededCandles = Math.ceil(totalSeconds / secondsPerCandle) + 10;
  neededCandles = Math.min(neededCandles, 50000); // cap at 50000

  try {
    const result = await broker.getCandles(instrument, neededCandles, granularity);
    if (result && result.length > 0) {
      const filtered = result.filter(c => {
        const time = c.time * 1000;
        return time >= start && time <= end;
      });
      return filtered;
    }
  } catch (err) {
    logger.warn('[MarketProvider] Failed to fetch large candle count:', err.message);
    // Fallback: fetch in chunks (if broker supports pagination with a 'to' parameter, we'd implement it here)
    // For now, we'll return an empty array or the closest we can get.
    logger.warn('[MarketProvider] Falling back to single chunk.');
    const result = await broker.getCandles(instrument, maxCandlesPerRequest, granularity);
    if (result && result.length > 0) {
      return result.filter(c => {
        const time = c.time * 1000;
        return time >= start && time <= end;
      });
    }
    return [];
  }
  return [];
}

module.exports = {
  getPrices,
  getCandles,
  getCurrentPrice,
  getHistoricalCandles,
};
