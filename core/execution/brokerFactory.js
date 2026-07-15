// core/execution/brokerFactory.js – Broker Factory (Multipliers or CFDs)

const DerivBroker = require('./broker');   // Multipliers (legacy WS)
const MT5Broker = require('./mt5Broker'); // CFDs (MT5 WS)
const logger = require('../../infrastructure/logger') || console;

let instance = null;

function getBroker() {
  if (instance) return instance;

  const product = process.env.TRADING_PRODUCT || 'multiplier';

  if (product === 'cfd') {
    instance = new MT5Broker();
    logger.info('[BrokerFactory] Using MT5Broker (CFDs)');
  } else {
    instance = new DerivBroker();
    logger.info('[BrokerFactory] Using DerivBroker (Multipliers)');
  }

  // The caller should connect explicitly.
  return instance;
}

module.exports = { getBroker };
