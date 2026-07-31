// shared/helpers.js – Utility Functions (with fixed pair validation & research helpers)

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
  if (upper.includes('JPY')) return 0.01;
  if (upper.includes('XAU')) return 0.01;
  return 0.0001;
}

/**
 * Validate a trading pair string.
 * @param {string} pair - Pair to validate (e.g., 'EUR_USD')
 * @returns {boolean} True if valid format.
 */
function isValidPair(pair) {
  if (!pair || typeof pair !== 'string') return false;
  return /^[A-Z]{3}_[A-Z]{3}$/.test(pair.toUpperCase().trim());
}

/**
 * Format a symbol to include an underscore (e.g., USDJPY → USD_JPY).
 * @param {string} symbol - Symbol string.
 * @returns {string} Formatted symbol.
 */
function formatSymbol(symbol) {
  if (!symbol || typeof symbol !== 'string') return symbol;
  const upper = symbol.toUpperCase().trim();
  if (upper.length === 6 && /^[A-Z]{6}$/.test(upper)) {
    return upper.slice(0, 3) + '_' + upper.slice(3);
  }
  return upper;
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

/**
 * Check if a string is empty or whitespace.
 * @param {string} str - String to check.
 * @returns {boolean}
 */
function isEmpty(str) {
  return !str || typeof str !== 'string' || str.trim().length === 0;
}

/**
 * Truncate a string to a maximum length.
 * @param {string} str - String to truncate.
 * @param {number} maxLength - Maximum length.
 * @param {string} suffix - Suffix to add (default '...').
 * @returns {string}
 */
function truncate(str, maxLength = 100, suffix = '...') {
  if (!str || typeof str !== 'string') return '';
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - suffix.length) + suffix;
}

/**
 * Convert a date to ISO string or return null.
 * @param {Date|string|number} date - Date input.
 * @returns {string|null} ISO string or null.
 */
function toISOString(date) {
  if (!date) return null;
  const d = new Date(date);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Get the current timestamp in seconds (Unix).
 * @returns {number}
 */
function timestampNow() {
  return Math.floor(Date.now() / 1000);
}

// ============================================================
// RESEARCH / SIMILARITY HELPERS (NEW)
// ============================================================

/**
 * Get the list of feature names used for similarity search.
 * @returns {string[]} Array of feature names.
 */
function getFeatureKeys() {
  return [
    'adx',
    'rsi',
    'atrPercent',
    'bbWidth',
    'macdHist',
    'liquidity',
    'velocity',
    'acceleration',
    'pricePosition',
    'marketQuality',
  ];
}

/**
 * Get a default feature vector with reasonable values.
 * @returns {Object} Default feature vector.
 */
function getDefaultFeatures() {
  return {
    adx: 25,
    rsi: 50,
    atrPercent: 0.005,
    bbWidth: 0.15,
    macdHist: 0,
    liquidity: 0.5,
    velocity: 0,
    acceleration: 0,
    pricePosition: 0.5,
    marketQuality: 50,
  };
}

/**
 * Normalize a feature vector using min-max scaling.
 * @param {Object} features - Feature vector with numeric values.
 * @param {Object} stats - Min/max stats for each feature.
 * @returns {Object} Normalised feature vector (values 0–1).
 */
function normalizeFeatures(features, stats) {
  const result = {};
  const keys = getFeatureKeys();
  for (const key of keys) {
    const val = features[key] !== undefined ? features[key] : 0;
    const stat = stats && stats[key];
    if (stat && stat.max !== undefined && stat.min !== undefined && stat.max !== stat.min) {
      result[key] = (val - stat.min) / (stat.max - stat.min);
    } else {
      // Fallback: default scaling if no stats
      if (key === 'adx') result[key] = val / 100;
      else if (key === 'rsi') result[key] = val / 100;
      else if (key === 'atrPercent') result[key] = Math.min(1, val / 0.05);
      else if (key === 'bbWidth') result[key] = Math.min(1, val / 0.5);
      else if (key === 'macdHist') result[key] = (val + 0.01) / 0.02;
      else if (key === 'liquidity') result[key] = val;
      else if (key === 'velocity') result[key] = (val + 0.001) / 0.002;
      else if (key === 'acceleration') result[key] = (val + 0.0001) / 0.0002;
      else if (key === 'pricePosition') result[key] = val;
      else if (key === 'marketQuality') result[key] = val / 100;
      else result[key] = 0.5;
    }
    // Clamp to [0, 1]
    result[key] = Math.max(0, Math.min(1, result[key]));
  }
  return result;
}

/**
 * Compute Euclidean distance between two feature vectors.
 * @param {Object} a - First feature vector.
 * @param {Object} b - Second feature vector.
 * @param {string[]} keys - Optional subset of keys to use.
 * @returns {number} Euclidean distance.
 */
function euclideanDistance(a, b, keys = null) {
  const featureKeys = keys || getFeatureKeys();
  let sum = 0;
  for (const key of featureKeys) {
    const va = a[key] !== undefined ? a[key] : 0;
    const vb = b[key] !== undefined ? b[key] : 0;
    sum += Math.pow(va - vb, 2);
  }
  return Math.sqrt(sum);
}

/**
 * Compute cosine similarity between two feature vectors.
 * @param {Object} a - First feature vector.
 * @param {Object} b - Second feature vector.
 * @param {string[]} keys - Optional subset of keys to use.
 * @returns {number} Cosine similarity (-1 to 1).
 */
function cosineSimilarity(a, b, keys = null) {
  const featureKeys = keys || getFeatureKeys();
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const key of featureKeys) {
    const va = a[key] !== undefined ? a[key] : 0;
    const vb = b[key] !== undefined ? b[key] : 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Create a deterministic hash from a feature object for caching.
 * @param {Object} features - Feature vector.
 * @param {string} prefix - Optional prefix for the hash.
 * @returns {string} Hash string.
 */
function hashFeatures(features, prefix = '') {
  const keys = getFeatureKeys();
  const sorted = keys
    .filter(k => features[k] !== undefined)
    .sort()
    .map(k => `${k}:${features[k]}`)
    .join('|');
  const hash = require('crypto')
    .createHash('sha256')
    .update(sorted)
    .digest('hex')
    .slice(0, 16);
  return prefix ? `${prefix}:${hash}` : hash;
}

module.exports = {
  // Existing exports
  formatPrice,
  sleep,
  getPipSize,
  isValidPair,
  formatSymbol,
  generateId,
  roundTo,
  envInt,
  envFloat,
  envBool,
  isEmpty,
  truncate,
  toISOString,
  timestampNow,
  // New research helpers
  getFeatureKeys,
  getDefaultFeatures,
  normalizeFeatures,
  euclideanDistance,
  cosineSimilarity,
  hashFeatures,
};
