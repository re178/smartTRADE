// core/execution/brokerFactory.js
const { AsyncLocalStorage } = require('async_hooks');
const logger = require('../../infrastructure/logger') || console;

// ---------- AsyncLocalStorage for per‑request context ----------
const als = new AsyncLocalStorage();

// Cache broker instances by product type (globally shared)
const instances = {};

/**
 * Get the appropriate broker for the current request.
 * If called without arguments, it reads the product from the ALS context
 * (set by middleware) or falls back to environment variable.
 */
function getBroker(product) {
  // Determine product type:
  // 1. Explicit argument (for testing / backward compatibility)
  // 2. From AsyncLocalStorage (set per request)
  // 3. From environment variable
  const selectedProduct = 
    product ||
    (als.getStore()?.product) ||
    process.env.TRADING_PRODUCT ||
    'deriv';

  const key = selectedProduct.toLowerCase();

  if (instances[key]) {
    logger.debug(`[BrokerFactory] Returning cached broker for product: ${key}`);
    return instances[key];
  }

  let broker;
  if (key === 'mt5') {
    logger.info('[BrokerFactory] Creating MT5Broker (CFD bridge mode)');
    const MT5Broker = require('./mt5Broker');
    broker = new MT5Broker();
  } else {
    logger.info('[BrokerFactory] Using DerivBroker (WebSocket mode)');
    // Deriv broker is a singleton already instantiated in broker.js
    broker = require('./broker');
  }

  instances[key] = broker;
  return broker;
}

/**
 * Middleware to set the product for the current request.
 * Call this in your Express (or similar) middleware chain.
 *
 * Example usage:
 *   app.use(brokerFactory.middleware((req) => req.user?.preferredProduct || 'deriv'));
 *
 * @param {Function} productResolver - Function that receives `req` and returns the product string.
 * @returns {Function} Express middleware
 */
function middleware(productResolver) {
  return (req, res, next) => {
    const product = productResolver(req);
    als.run({ product }, () => {
      next();
    });
  };
}

/**
 * Run a function inside a specific product context (useful for non‑HTTP contexts).
 */
function runWithProduct(product, fn) {
  return als.run({ product }, fn);
}

module.exports = {
  getBroker,
  middleware,
  runWithProduct,
};
