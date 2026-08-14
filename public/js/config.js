// public/js/config.js – Configuration for RTS Dashboard (Multiplier Edition)
// No API key required – WebSocket connects without authentication.

// Set this to your actual WebSocket URL if auto-detection fails.
// For Render, use:  wss://your-app.onrender.com
// For local, use:    ws://localhost:5000
// Leave as null to auto-detect.
const MANUAL_WS_URL = null; // e.g., 'wss://tradermarketopen.onrender.com'

const CONFIG = {
  // API base URL – empty means relative to current origin
  API_BASE: '',

  // WebSocket URL – auto-detected unless MANUAL_WS_URL is set
  WS_URL: MANUAL_WS_URL || null,
};

// Auto-detect WebSocket URL if manual override is not set
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
