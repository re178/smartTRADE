// core/execution/brokerFactory.js
const logger = require('../../infrastructure/logger') || console;
const { DerivBroker } = require('./broker'); // Import the class (not the singleton)

// Cache for broker instances (keyed by product string)
const instances = {};

/**
 * Build the default config for a DerivBroker instance.
 * All values come from environment variables (global settings).
 * @param {string} productType - 'cfd', 'multiplier', or 'basic'
 * @returns {object} config object
 */
function getDerivConfig(productType) {
  return {
    apiToken: process.env.DERIV_API_TOKEN,
    appId: process.env.DERIV_APP_ID,
    wsUrl: process.env.DERIV_WS_URL,
    connectionTimeout: parseInt(process.env.DERIV_CONNECTION_TIMEOUT) || 30000,
    reconnectBaseDelay: parseInt(process.env.DERIV_RECONNECT_DELAY) || 2000,
    maxReconnectDelay: parseInt(process.env.DERIV_MAX_RECONNECT_DELAY) || 30000,
    maxRetries: parseInt(process.env.DERIV_MAX_RETRIES) || 3,
    maxQueueSize: parseInt(process.env.DERIV_MAX_QUEUE_SIZE) || 100,
    circuitBreakerThreshold: parseInt(process.env.DERIV_CIRCUIT_BREAKER_THRESHOLD) || 20,
    circuitBreakerTimeout: parseInt(process.env.DERIV_CIRCUIT_BREAKER_TIMEOUT) || 60000,
    minOrderSize: parseFloat(process.env.DERIV_MIN_ORDER_SIZE) || 0.01,
    maxOrderSize: parseFloat(process.env.DERIV_MAX_ORDER_SIZE) || 100,
    minStopDistance: parseFloat(process.env.DERIV_MIN_STOP_DISTANCE) || 0.0001,
    rateLimit: parseFloat(process.env.DERIV_RATE_LIMIT) || 5,
    rateCapacity: parseFloat(process.env.DERIV_RATE_CAPACITY) || 10,
    leverage: parseFloat(process.env.DERIV_LEVERAGE) || 100,
    duration: process.env.DERIV_DURATION ? parseInt(process.env.DERIV_DURATION) : 60,
    fatalAfterAuthFailures: parseInt(process.env.DERIV_FATAL_AFTER_AUTH_FAILURES) || 3,
    readinessTimeout: parseInt(process.env.DERIV_READINESS_TIMEOUT) || 30000,
    symbolTimeout: parseInt(process.env.DERIV_SYMBOL_TIMEOUT) || 30000,
    heartbeatTimeout: parseInt(process.env.DERIV_HEARTBEAT_TIMEOUT) || 60000,
    productType: productType, // <-- key: pass the internal type
  };
}

/**
 * Get the broker instance for the given product string.
 * @param {string} product - One of: 'mt5', 'deriv_cfd', 'deriv_multiplier', 'deriv_basic'
 * @returns {object} broker instance (MT5Broker or DerivBroker)
 */
function getBroker(product) {
  if (!product) {
    throw new Error('Product must be specified (e.g., "mt5" or "deriv_cfd")');
  }

  const key = product.toLowerCase();

  if (instances[key]) {
    logger.debug(`[BrokerFactory] Returning cached broker for product: ${key}`);
    return instances[key];
  }

  let broker;

  if (key === 'mt5') {
    logger.info('[BrokerFactory] Creating MT5Broker');
    const MT5Broker = require('./mt5Broker');
    broker = new MT5Broker();
  } 
  else if (key.startsWith('deriv_')) {
    const internalType = key.replace('deriv_', '');
    if (!['cfd', 'multiplier', 'basic'].includes(internalType)) {
      throw new Error(`Invalid Deriv product type: ${internalType}`);
    }
    logger.info(`[BrokerFactory] Creating DerivBroker with productType: ${internalType}`);
    const config = getDerivConfig(internalType);
    broker = new DerivBroker(config);
  } 
  else {
    throw new Error(`Unsupported product: ${product}`);
  }

  instances[key] = broker;
  return broker;
}

module.exports = { getBroker };
