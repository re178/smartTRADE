// src/shared/validators.js – Input Validation (with SL/TP price checks)

const { isValidPair, getPipSize } = require('./helpers');

/**
 * Validate the input for placing an order.
 * @param {Object} input
 * @param {string} input.pair - Instrument pair (e.g., 'EUR_USD')
 * @param {string} input.side - 'BUY' or 'SELL'
 * @param {number} input.lotSize - Lot size (units)
 * @param {number|null} input.stopLoss - Stop loss price (optional)
 * @param {number|null} input.takeProfit - Take profit price (optional)
 * @param {number|null} input.currentPrice - Current market price (optional, but recommended for SL/TP validation)
 * @returns {Object} { valid: boolean, message: string }
 */
function validateOrderInput({ pair, side, lotSize, stopLoss = null, takeProfit = null, currentPrice = null }) {
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

  // ============================================================
  // NEW: Validate SL/TP against current price (if provided)
  // ============================================================
  if (currentPrice !== null && typeof currentPrice === 'number' && !isNaN(currentPrice) && currentPrice > 0) {
    const pipSize = getPipSize(cleanPair);
    const minDistance = pipSize * 5; // Minimum 5 pips

    if (cleanSide === 'BUY') {
      // For BUY: SL must be BELOW entry, TP must be ABOVE entry
      if (stopLoss !== null) {
        if (stopLoss >= currentPrice) {
          return { valid: false, message: 'For BUY, stop loss must be below entry price' };
        }
        if (Math.abs(currentPrice - stopLoss) < minDistance) {
          return { valid: false, message: `Stop loss too close to entry (min ${minDistance.toFixed(5)})` };
        }
      }
      if (takeProfit !== null) {
        if (takeProfit <= currentPrice) {
          return { valid: false, message: 'For BUY, take profit must be above entry price' };
        }
        if (Math.abs(currentPrice - takeProfit) < minDistance) {
          return { valid: false, message: `Take profit too close to entry (min ${minDistance.toFixed(5)})` };
        }
      }
    } else if (cleanSide === 'SELL') {
      // For SELL: SL must be ABOVE entry, TP must be BELOW entry
      if (stopLoss !== null) {
        if (stopLoss <= currentPrice) {
          return { valid: false, message: 'For SELL, stop loss must be above entry price' };
        }
        if (Math.abs(currentPrice - stopLoss) < minDistance) {
          return { valid: false, message: `Stop loss too close to entry (min ${minDistance.toFixed(5)})` };
        }
      }
      if (takeProfit !== null) {
        if (takeProfit >= currentPrice) {
          return { valid: false, message: 'For SELL, take profit must be below entry price' };
        }
        if (Math.abs(currentPrice - takeProfit) < minDistance) {
          return { valid: false, message: `Take profit too close to entry (min ${minDistance.toFixed(5)})` };
        }
      }
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
