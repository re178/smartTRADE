// core/market/provider.js – Market Data Provider (uses brokerFactory with product support)

const { getBroker } = require('../execution/brokerFactory');
const logger = require('../../infrastructure/logger') || console;

/**
 * Get the broker instance for the given product (or default if omitted).
 * @param {string} [product] - e.g., 'mt5', 'deriv_cfd', etc.
 * @returns {object} broker instance
 */
function getBrokerForProduct(product) {
  return getBroker(product); // factory handles default internally
}

/**
 * Get current prices for one or more instruments.
 * @param {string[]} instruments - Array of instrument names (e.g., ['EUR_USD'])
 * @param {string} [product] - Trading product (optional)
 * @returns {Promise<Object[]>} Array of price objects from broker.
 */
async function getPrices(instruments, product) {
  const broker = getBrokerForProduct(product);
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
 * @param {string} [product] - Trading product (optional)
 * @returns {Promise<Object[]>} Array of candle objects.
 */
async function getCandles(instrument, count = 100, granularity = 'M5', product) {
  const broker = getBrokerForProduct(product);
  if (!broker.isConnected()) {
    await broker.connect();
  }
  return broker.getCandles(instrument, count, granularity);
}

/**
 * Get the current mid price for an instrument.
 * @param {string} instrument - Instrument name
 * @param {string} [product] - Trading product (optional)
 * @returns {Promise<number>} Current mid price.
 */
async function getCurrentPrice(instrument, product) {
  const prices = await getPrices([instrument], product);
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
 * @param {string} instrument - Instrument name.
 * @param {Date} startDate - Start date.
 * @param {Date} endDate - End date.
 * @param {string} granularity - Granularity (e.g., 'M5', 'H1').
 * @param {number} maxCandlesPerRequest - Max candles per request (default 5000).
 * @param {string} [product] - Trading product (optional)
 * @returns {Promise<Object[]>} Array of candle objects sorted by time (ascending).
 */
async function getHistoricalCandles(instrument, startDate, endDate, granularity = 'M5', maxCandlesPerRequest = 5000, product) {
  const broker = getBrokerForProduct(product);
  if (!broker.isConnected()) {
    await broker.connect();
  }

  const start = startDate.getTime();
  const end = endDate.getTime();
  if (start >= end) {
    throw new Error('Start date must be before end date');
  }

  const granularitySeconds = {
    'M1': 60, 'M5': 300, 'M15': 900, 'M30': 1800,
    'H1': 3600, 'H4': 14400, 'D': 86400,
  };
  const secondsPerCandle = granularitySeconds[granularity] || 300;
  const totalSeconds = (end - start) / 1000;
  let neededCandles = Math.ceil(totalSeconds / secondsPerCandle) + 10;
  neededCandles = Math.min(neededCandles, 50000);

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
