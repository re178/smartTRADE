// src/core/execution/orderService.js – Order Management Service

const broker = require('./broker');
const eventBus = require('../../infrastructure/eventBus');
const { validateOrderInput } = require('../../shared/validators');
const { formatPrice } = require('../../shared/helpers');

/**
 * Place a market order (BUY/SELL).
 * @param {string} instrument - e.g., 'EUR_USD'
 * @param {string} side - 'BUY' or 'SELL'
 * @param {number} lotSize - Number of units (positive)
 * @param {number|null} stopLoss - Stop loss price (optional)
 * @param {number|null} takeProfit - Take profit price (optional)
 * @returns {Promise<Object>} { tradeId, orderId, price, ... }
 */
async function placeMarketOrder(instrument, side, lotSize, stopLoss = null, takeProfit = null) {
  // Validate input
  const validation = validateOrderInput({ pair: instrument, side, lotSize, stopLoss, takeProfit });
  if (!validation.valid) {
    throw new Error(validation.message);
  }

  // Convert side to units: positive for BUY, negative for SELL
  const units = side.toUpperCase() === 'BUY' ? lotSize : -lotSize;

  // Call broker
  const result = await broker.placeMarketOrder(instrument, units, stopLoss, takeProfit);

  // Extract relevant fields from broker response
  const tradeId = result.tradeID || result.id || null;
  const orderId = result.id || null;
  const price = result.price || result.averagePrice || null;

  // Emit event
  eventBus.emit('order.placed', {
    instrument,
    side,
    lotSize,
    stopLoss,
    takeProfit,
    tradeId,
    orderId,
    price,
    timestamp: new Date().toISOString(),
  });

  return {
    tradeId,
    orderId,
    price,
    raw: result,
  };
}

/**
 * Close an open trade by its ID.
 * @param {string} tradeId - OANDA trade ID
 * @returns {Promise<Object>} Result from broker.
 */
async function closeTrade(tradeId) {
  if (!tradeId) throw new Error('tradeId is required');

  const result = await broker.closeTrade(tradeId);

  eventBus.emit('trade.closed', {
    tradeId,
    result,
    timestamp: new Date().toISOString(),
  });

  return result;
}

/**
 * Get all open trades from the broker.
 * @returns {Promise<Array>} List of open trade objects.
 */
async function getOpenTrades() {
  return broker.getOpenTrades();
}

/**
 * Get all positions from the broker.
 * @returns {Promise<Array>} List of position objects.
 */
async function getPositions() {
  return broker.getPositions();
}

module.exports = {
  placeMarketOrder,
  closeTrade,
  getOpenTrades,
  getPositions,
};
