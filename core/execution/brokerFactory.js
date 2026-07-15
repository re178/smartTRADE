// core/execution/brokerFactory.js – Broker Factory (DerivBroker for all products)

const DerivBroker = require('./broker');
const logger = require('../../infrastructure/logger') || console;

let instance = null;

/**
 * Get the appropriate broker instance.
 * Always returns DerivBroker – it handles both Multipliers and CFDs.
 */
function getBroker() {
  if (instance) return instance;

  // Read product type from environment (default: 'multiplier')
  const productType = process.env.TRADING_PRODUCT || 'multiplier';

  // Always use DerivBroker – it supports both products via the proposal builder
  instance = new DerivBroker({
    productType: productType,
    // Also pass through any other config from environment
    apiToken: process.env.DERIV_API_TOKEN,
    appId: process.env.DERIV_APP_ID || '1089',
    wsUrl: process.env.DERIV_WS_URL,
    leverage: parseFloat(process.env.DERIV_LEVERAGE) || 100,
    symbolTimeout: parseInt(process.env.DERIV_SYMBOL_TIMEOUT) || 30000, // increased to 30s
  });

  logger.info(`[BrokerFactory] Using DerivBroker (product: ${productType})`);
  return instance;
}

module.exports = { getBroker };
