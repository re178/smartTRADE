// core/execution/brokerFactory.js – Returns the singleton broker instance

const broker = require('./broker');
const logger = require('../../infrastructure/logger') || console;

function getBroker() {
  logger.info(`[BrokerFactory] Returning DerivBroker (product: ${broker.productType || 'unknown'})`);
  return broker;
}

module.exports = { getBroker };
