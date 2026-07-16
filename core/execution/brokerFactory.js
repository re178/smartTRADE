// core/execution/brokerFactory.js – Returns the appropriate broker instance

const logger = require('../../infrastructure/logger') || console;

let brokerInstance = null;

function getBroker() {
  if (brokerInstance) {
    logger.info(`[BrokerFactory] Returning cached broker (type: ${brokerInstance.constructor.name})`);
    return brokerInstance;
  }

  // Check environment variable
  const brokerType = process.env.BROKER_TYPE || 'deriv';

  if (brokerType === 'mt5') {
    logger.info('[BrokerFactory] Creating MT5Broker (bridge mode)');
    const MT5Broker = require('./mt5Broker');
    brokerInstance = new MT5Broker();
  } else {
    logger.info('[BrokerFactory] Creating DerivBroker (WebSocket mode)');
    const DerivBroker = require('./broker');
    brokerInstance = DerivBroker; // The existing singleton is already exported as an instance
    // If broker.js exports a singleton instance, we just return it.
    // But we need to handle that it might be a constructor or instance.
    // In your broker.js, you export `brokerInstance` (singleton). So we can just use that.
    // To be safe, we can re-require and use the singleton.
    // Actually, your broker.js exports a pre-created instance.
    // So we can assign directly:
    // brokerInstance = require('./broker');
    // Let's do that:
    const DerivBrokerInstance = require('./broker');
    brokerInstance = DerivBrokerInstance;
  }

  logger.info(`[BrokerFactory] Broker initialized: ${brokerInstance.constructor.name}`);
  return brokerInstance;
}

module.exports = { getBroker };
