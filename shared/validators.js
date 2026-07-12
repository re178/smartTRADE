// src/shared/validators.js – Input Validation

const { isValidPair } = require('./helpers');

/**
 * Validate the input for placing an order.
 * @param {Object} input
 * @param {string} input.pair - Instrument pair (e.g., 'EUR_USD')
 * @param {string} input.side - 'BUY' or 'SELL'
 * @param {number} input.lotSize - Lot size (units)
 * @param {number|null} input.stopLoss - Stop loss price (optional)
 * @param {number|null} input.takeProfit - Take profit price (optional)
 * @returns {Object} { valid: boolean, message: string }
 */
function validateOrderInput({ pair, side, lotSize, stopLoss = null, takeProfit = null }) {
  // Check pair format
  if (!pair || typeof pair !== 'string') {
    return { valid: false, message: 'Pair must be a string' };
  }
  const cleanPair = pair.toUpperCase().trim();
  if (!isValidPair(cleanPair)) {
    return { valid: false, message: 'Invalid pair format (use e.g., EUR_USD)' };
  }

  // Check side
  if (!side || typeof side !== 'string') {
    return { valid: false, message: 'Side is required (BUY or SELL)' };
  }
  const cleanSide = side.toUpperCase().trim();
  if (!['BUY', 'SELL'].includes(cleanSide)) {
    return { valid: false, message: 'Side must be BUY or SELL' };
  }

  // Check lot size
  if (lotSize === undefined || lotSize === null) {
    return { valid: false, message: 'Lot size is required' };
  }
  const lot = parseFloat(lotSize);
  if (isNaN(lot) || lot <= 0) {
    return { valid: false, message: 'Lot size must be a positive number' };
  }
  if (lot < 0.01) {
    return { valid: false, message: 'Lot size must be at least 0.01' };
  }

  // Optional: check stopLoss and takeProfit if provided
  if (stopLoss !== null && stopLoss !== undefined && typeof stopLoss !== 'number') {
    return { valid: false, message: 'Stop loss must be a number or null' };
  }
  if (takeProfit !== null && takeProfit !== undefined && typeof takeProfit !== 'number') {
    return { valid: false, message: 'Take profit must be a number or null' };
  }

  // If both SL and TP provided, ensure they are logically placed
  if (stopLoss && takeProfit) {
    if (cleanSide === 'BUY' && stopLoss >= takeProfit) {
      return { valid: false, message: 'For BUY, stop loss must be below take profit' };
    }
    if (cleanSide === 'SELL' && stopLoss <= takeProfit) {
      return { valid: false, message: 'For SELL, stop loss must be above take profit' };
    }
  }

  return { valid: true, message: 'Valid order input' };
}

/**
 * Validate pair string.
 * @param {string} pair - Pair (e.g., 'EUR_USD')
 * @returns {boolean}
 */
function validatePair(pair) {
  return isValidPair(pair);
}

/**
 * Validate risk percentage.
 * @param {number} risk - Risk percentage (e.g., 1 for 1%)
 * @returns {Object} { valid: boolean, message: string }
 */
function validateRisk(risk) {
  const r = parseFloat(risk);
  if (isNaN(r) || r <= 0) {
    return { valid: false, message: 'Risk must be a positive number' };
  }
  if (r > 100) {
    return { valid: false, message: 'Risk cannot exceed 100%' };
  }
  return { valid: true, message: 'Valid risk' };
}

module.exports = {
  validateOrderInput,
  validatePair,
  validateRisk,
};
