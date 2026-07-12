// src/shared/helpers.js – Utility Functions

/**
 * Format a number as a price with fixed decimals.
 * @param {number|string} price - The price value.
 * @param {number} decimals - Number of decimal places (default 5).
 * @returns {string} Formatted price string.
 */
function formatPrice(price, decimals = 5) {
  const num = parseFloat(price);
  if (isNaN(num)) return 'N/A';
  return num.toFixed(decimals);
}

/**
 * Sleep for a given number of milliseconds.
 * @param {number} ms - Milliseconds to sleep.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get the pip size for a given instrument.
 * @param {string} instrument - e.g., 'EUR_USD'
 * @returns {number} Pip value in price units.
 */
function getPipSize(instrument) {
  if (!instrument) return 0.0001;
  const upper = instrument.toUpperCase();
  // JPY pairs have pip at 0.01
  if (upper.includes('JPY')) return 0.01;
  // XAU (gold) has pip at 0.1?
  if (upper.includes('XAU')) return 0.01;
  // Default for most pairs
  return 0.0001;
}

/**
 * Validate a trading pair string.
 * @param {string} pair - Pair to validate (e.g., 'EUR_USD')
 * @returns {boolean} True if valid format.
 */
function isValidPair(pair) {
  if (!pair || typeof pair !== 'string') return false;
  // Must contain an underscore and be at least 7 characters (e.g., EUR_USD)
  return /^[A-Z]{6}$/.test(pair) && pair.includes('_');
}

/**
 * Generate a unique ID (simple timestamp-based).
 * @returns {string} Unique ID string.
 */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

/**
 * Round a number to a specific number of decimal places.
 * @param {number} value - Number to round.
 * @param {number} decimals - Decimal places (default 5).
 * @returns {number} Rounded number.
 */
function roundTo(value, decimals = 5) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * Parse an environment variable as an integer with a default.
 * @param {string} key - Environment variable key.
 * @param {number} defaultValue - Default value if not set or invalid.
 * @returns {number}
 */
function envInt(key, defaultValue) {
  const val = parseInt(process.env[key]);
  return isNaN(val) ? defaultValue : val;
}

/**
 * Parse an environment variable as a float with a default.
 * @param {string} key - Environment variable key.
 * @param {number} defaultValue - Default value if not set or invalid.
 * @returns {number}
 */
function envFloat(key, defaultValue) {
  const val = parseFloat(process.env[key]);
  return isNaN(val) ? defaultValue : val;
}

/**
 * Parse an environment variable as a boolean.
 * @param {string} key - Environment variable key.
 * @param {boolean} defaultValue - Default if not set.
 * @returns {boolean}
 */
function envBool(key, defaultValue = false) {
  const val = process.env[key];
  if (val === undefined || val === null) return defaultValue;
  return val.toLowerCase() === 'true' || val === '1';
}

module.exports = {
  formatPrice,
  sleep,
  getPipSize,
  isValidPair,
  generateId,
  roundTo,
  envInt,
  envFloat,
  envBool,
};
