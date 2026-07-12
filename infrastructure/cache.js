// src/infrastructure/cache.js – Caching Layer (In-Memory)

/**
 * Simple in-memory cache using Map.
 * Can later be replaced with Redis or another distributed cache.
 */
class Cache {
  constructor() {
    this.store = new Map();
    this.ttlStore = new Map(); // stores expiry timestamps
  }

  /**
   * Set a value in the cache.
   * @param {string} key - Cache key.
   * @param {any} value - Value to store.
   * @param {number} ttl - Time to live in seconds (optional, default 300s).
   */
  set(key, value, ttl = 300) {
    this.store.set(key, value);
    if (ttl > 0) {
      const expiry = Date.now() + ttl * 1000;
      this.ttlStore.set(key, expiry);
    } else {
      // No TTL
      this.ttlStore.delete(key);
    }
  }

  /**
   * Get a value from the cache.
   * @param {string} key - Cache key.
   * @returns {any|null} Cached value or null if not found or expired.
   */
  get(key) {
    // Check TTL
    const expiry = this.ttlStore.get(key);
    if (expiry && Date.now() > expiry) {
      // Expired
      this.delete(key);
      return null;
    }
    return this.store.get(key) || null;
  }

  /**
   * Delete a key from the cache.
   * @param {string} key - Cache key.
   */
  delete(key) {
    this.store.delete(key);
    this.ttlStore.delete(key);
  }

  /**
   * Clear the entire cache.
   */
  clear() {
    this.store.clear();
    this.ttlStore.clear();
  }

  /**
   * Check if a key exists and is not expired.
   * @param {string} key - Cache key.
   * @returns {boolean}
   */
  has(key) {
    return this.get(key) !== null;
  }

  /**
   * Get all keys (for debugging).
   * @returns {string[]} Array of keys.
   */
  keys() {
    return Array.from(this.store.keys());
  }

  /**
   * Get cache stats (size).
   * @returns {Object} { size, keys }
   */
  stats() {
    return {
      size: this.store.size,
      keys: this.keys(),
    };
  }
}

// Export a singleton instance
module.exports = new Cache();
