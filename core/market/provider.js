// core/market/provider.js – Market Data Provider (uses brokerFactory with product support)
//
// [FIX-PROVIDER-1] getBrokerForProduct previously called getBroker(product)
//   with product potentially undefined. brokerFactory.getBroker() explicitly
//   throws "Product must be specified" when product is falsy. Every strategy
//   call into engine.getCandlesOnce() → provider.getCandles() → this path
//   was dying with that error, which meant:
//     • Every strategy returned null on every cycle
//     • ranker.rank() got no signals → consensus.action never = 'SIGNAL'
//     • All FX bots stuck on "Strategy consensus does not agree" forever
//   Defaulting to 'deriv_cfd' — the only supported product in this build —
//   unblocks every strategy in the engine. Callers that pass a product
//   explicitly still get that product.

const { getBroker } = require('../execution/brokerFactory');
const logger = require('../../infrastructure/logger') || console;

const DEFAULT_PRODUCT = 'deriv_cfd';

function getBrokerForProduct(product) {
  return getBroker(product || DEFAULT_PRODUCT);
}

async function getPrices(instruments, product) {
  const broker = getBrokerForProduct(product);
  if (!broker.isConnected()) {
    await broker.connect();
  }
  return broker.getPrices(instruments);
}

async function getCandles(instrument, count = 100, granularity = 'M5', product) {
  const broker = getBrokerForProduct(product);
  if (!broker.isConnected()) {
    await broker.connect();
  }
  return broker.getCandles(instrument, count, granularity);
}

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
