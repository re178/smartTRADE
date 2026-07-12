// src/core/market/provider.js – Market Data Provider

const broker = require('../execution/broker');

/**
 * Get current prices for one or more instruments.
 * @param {string[]} instruments - Array of instrument names (e.g., ['EUR_USD'])
 * @returns {Promise<Object[]>} Array of price objects from broker.
 */
async function getPrices(instruments) {
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
  return broker.getCandles(instrument, count, granularity);
}

/**
 * Get the current mid price for an instrument.
 * @param {string} instrument - Instrument name
 * @returns {Promise<number>} Current mid price.
 */
async function getCurrentPrice(instrument) {
  const prices = await broker.getPrices([instrument]);
  if (!prices || prices.length === 0) {
    throw new Error(`No price data for ${instrument}`);
  }
  const price = prices[0];
  const bid = parseFloat(price.bids[0].price);
  const ask = parseFloat(price.asks[0].price);
  return (bid + ask) / 2;
}

module.exports = {
  getPrices,
  getCandles,
  getCurrentPrice,
};
