// core/execution/brokerFactory.js – Broker Factory (Single DerivBroker with product support)

const DerivBroker = require('./broker');
const logger = require('../../infrastructure/logger') || console;

let instance = null;

function getBroker() {
  if (instance) return instance;

  // DerivBroker now handles both Multipliers and CFDs
  instance = new DerivBroker({
    productType: process.env.TRADING_PRODUCT || 'multiplier',
  });
  logger.info(`[BrokerFactory] Using DerivBroker (${instance.productType})`);

  return instance;
}

module.exports = { getBroker };
