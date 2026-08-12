// public/js/config.js – Minimal configuration for RTS Dashboard
// No API key required – WebSocket connects without authentication.

const CONFIG = {
  // API base URL – empty means relative to current origin
  API_BASE: '',

  // WebSocket URL – uses current origin with ws/wss protocol
  // No query parameters – the server no longer requires an API key.
  // If you need to override, set WS_URL in your environment or here.
  WS_URL: null, // null means auto-detect from window.location
};

// Auto-detect WebSocket URL if not set
if (!CONFIG.WS_URL) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  CONFIG.WS_URL = `${protocol}//${window.location.host}`;
}

console.log('[Config] API_BASE:', CONFIG.API_BASE);
console.log('[Config] WS_URL:', CONFIG.WS_URL);

// Export for use in other scripts (if using modules)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CONFIG;
}
