const crypto = require('crypto');
const bcrypt = require('bcryptjs'); // Use existing bcrypt if already in project, otherwise install bcryptjs
const logger = require('../core/portfolio/logger');

const API_KEY_PREFIX = 'rts_pk_';
const API_SECRET_PREFIX = 'rts_sk_';
const KEY_BYTES = 24;       // 48 hex chars after prefix
const SECRET_BYTES = 32;    // 64 hex chars after prefix
const BCRYPT_ROUNDS = 12;   // Secure cost factor

/**
 * Generate a cryptographically secure random hex string with a given prefix.
 * @param {string} prefix
 * @param {number} byteLength
 * @returns {string}
 */
function generateRandomString(prefix, byteLength) {
  return prefix + crypto.randomBytes(byteLength).toString('hex');
}

/**
 * Generate an API Key: rts_pk_ + 48 random hex chars
 * @returns {string}
 */
function generateApiKey() {
  return generateRandomString(API_KEY_PREFIX, KEY_BYTES);
}

/**
 * Generate an API Secret: rts_sk_ + 64 random hex chars
 * @returns {string}
 */
function generateApiSecret() {
  return generateRandomString(API_SECRET_PREFIX, SECRET_BYTES);
}

/**
 * Hash a secret using bcrypt.
 * @param {string} secret - Plain text secret
 * @returns {Promise<string>} bcrypt hash
 */
async function hashSecret(secret) {
  const hash = await bcrypt.hash(secret, BCRYPT_ROUNDS);
  return hash;
}

/**
 * Compare a plain text secret with a bcrypt hash.
 * @param {string} secret - Plain text secret
 * @param {string} hash - Hashed secret from database
 * @returns {Promise<boolean>}
 */
async function compareSecret(secret, hash) {
  return bcrypt.compare(secret, hash);
}

/**
 * Generate a full credential pair (plain key, plain secret, hashed secret).
 * Note: The plain secret is returned ONLY at creation time and must not be stored.
 * @returns {Promise<{apiKey: string, apiSecret: string, hashedSecret: string}>}
 */
async function generateCredentialPair() {
  const apiKey = generateApiKey();
  const apiSecret = generateApiSecret();
  const hashedSecret = await hashSecret(apiSecret);
  logger.info('Generated new API credential pair (key prefix hidden)');
  return { apiKey, apiSecret, hashedSecret };
}

module.exports = {
  generateApiKey,
  generateApiSecret,
  hashSecret,
  compareSecret,
  generateCredentialPair
};
