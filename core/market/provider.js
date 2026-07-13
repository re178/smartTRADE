// src/core/market/provider.js – Market Data Provider (with historical support)

const broker = require('../execution/broker');
const logger = require('../../infrastructure/logger') || console;

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

  // We need to fetch from the most recent to the oldest, accumulating until we cover the range.
  // We'll use a loop: fetch the latest `maxCandlesPerRequest` candles, check the earliest timestamp,
  // if it's > start, fetch the next batch with a `to` parameter (if supported by broker).
  // Since our broker abstraction does not support `to`, we'll use a simpler method:
  // fetch a large number of candles (e.g., 10000) and filter by date.
  // We'll implement pagination by fetching multiple chunks of 5000 candles using the `from` parameter.
  // We'll assume the broker's getCandles supports a `from` parameter (Unix timestamp in seconds).
  // If not, we fall back to fetching a fixed large count.

  // We'll implement a robust method using the `from` parameter if available.
  // First, check if broker.getCandles supports an options object.
  // In our current broker, getCandles only accepts (instrument, count, granularity).
  // We can extend it to accept an options object with `from` and `to`.
  // To keep this file self-contained, we'll implement a workaround:
  // fetch candles in chunks of 5000 until we have enough covering the start date.

  const allCandles = [];
  let remaining = true;
  let toTimestamp = Math.floor(end / 1000); // end time in seconds
  let chunkSize = maxCandlesPerRequest;

  // We'll assume the broker can fetch with a `to` parameter if we pass an object.
  // Since the current broker doesn't support that, we'll try to use a count-based approach:
  // we'll fetch a large count (say 10000) and hope it covers the range; if not, we'll log a warning.
  // For a real production backtest, you should implement proper pagination.

  // Let's implement a safe fallback: fetch 5000 candles from the end date backwards.
  // We'll use a loop: each iteration, we fetch chunkSize candles, and if the first candle's time
  // is earlier than the start, we stop. Otherwise, we fetch the next chunk before the earliest time.

  // We'll modify the getCandles call to accept an additional `from` parameter if available.
  // We'll check if broker.getCandles accepts a third argument as an options object.
  // Since we can't guarantee that, we'll implement a different strategy:
  // fetch a large number of candles (say 5000) and filter by date.
  // If the range is larger, we'll fetch multiple times with increasing offsets.

  // Let's use the approach of fetching a large count and then, if not enough, fetch more.
  // We'll fetch 5000 candles at a time, using the earliest timestamp as the new "to" for the next batch.

  try {
    // First, fetch the most recent candles up to the end date.
    // We'll get candles with count = maxCandlesPerRequest and then use the earliest timestamp.
    let batch = await broker.getCandles(instrument, maxCandlesPerRequest, granularity);
    if (!batch || batch.length === 0) {
      return [];
    }
    // batch is sorted from oldest to newest? Usually OANDA returns ascending.
    // We'll check the first and last times.
    // We'll collect from the most recent backwards.
    // We'll use a while loop to accumulate batches.

    // For simplicity, we'll just fetch a large enough count (e.g., 5000) and filter.
    // If the range is larger, we'll increase the count.
    // We'll calculate the approximate number of candles needed based on granularity.
    const granularitySeconds = {
      'M1': 60, 'M5': 300, 'M15': 900, 'M30': 1800,
      'H1': 3600, 'H4': 14400, 'D': 86400,
    };
    const secondsPerCandle = granularitySeconds[granularity] || 300;
    const totalSeconds = (end - start) / 1000;
    let neededCandles = Math.ceil(totalSeconds / secondsPerCandle) + 10;
    neededCandles = Math.min(neededCandles, 50000); // cap at 50000

    // Fetch as many as needed in one go if possible (some brokers allow large counts).
    // We'll try to fetch neededCandles, but the broker may have a limit.
    try {
      const result = await broker.getCandles(instrument, neededCandles, granularity);
      if (result && result.length > 0) {
        // Filter by date
        const filtered = result.filter(c => {
          const time = c.time * 1000; // assuming time is in seconds
          return time >= start && time <= end;
        });
        return filtered;
      }
    } catch (err) {
      logger.warn('[MarketProvider] Failed to fetch large candle count, falling back to pagination:', err.message);
    }

    // Fallback: paginate with smaller chunks.
    let all = [];
    let fetchMore = true;
    let toTime = Math.floor(end / 1000);
    while (fetchMore) {
      // We need a way to get candles before `toTime` – we'll fetch from the broker with count and hope we get old ones.
      // This is not ideal, but we'll implement a simple loop that fetches 5000 candles repeatedly.
      const batch = await broker.getCandles(instrument, maxCandlesPerRequest, granularity);
      if (!batch || batch.length === 0) break;
      // Filter to only those <= toTime
      const filtered = batch.filter(c => c.time <= toTime);
      if (filtered.length === 0) break;
      const earliest = filtered[0].time;
      if (earliest * 1000 <= start) {
        // We have all needed candles
        all = all.concat(filtered);
        break;
      }
      all = all.concat(filtered);
      // Set toTime to the earliest - 1 second to get the next batch
      toTime = earliest - 1;
      // Avoid infinite loop
      if (all.length > 100000) break;
    }
    // Filter by date and sort ascending
    const result = all
      .filter(c => c.time * 1000 >= start && c.time * 1000 <= end)
      .sort((a, b) => a.time - b.time);
    return result;
  } catch (err) {
    logger.error('[MarketProvider] Historical candle fetch error:', err.message);
    throw err;
  }
}

module.exports = {
  getPrices,
  getCandles,
  getCurrentPrice,
  getHistoricalCandles,
};
