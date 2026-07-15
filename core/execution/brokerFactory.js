// core/execution/brokerFactory.js – Returns DerivBroker ONLY

const DerivBroker = require('./broker');
const logger = require('../../infrastructure/logger') || console;

let instance = null;

function getBroker() {
  if (instance) return instance;

  // Read product type from environment
  const productType = process.env.TRADING_PRODUCT || 'multiplier';

  // ALWAYS use DerivBroker – it handles both Multipliers and CFDs
  instance = new DerivBroker({
    productType: productType,
    apiToken: process.env.DERIV_API_TOKEN,
    appId: process.env.DERIV_APP_ID || '1089',
    wsUrl: process.env.DERIV_WS_URL,
    leverage: parseFloat(process.env.DERIV_LEVERAGE) || 100,
    symbolTimeout: parseInt(process.env.DERIV_SYMBOL_TIMEOUT) || 30000,
  });

  logger.info(`[BrokerFactory] Using DerivBroker (product: ${productType})`);
  return instance;
}

module.exports = { getBroker };
