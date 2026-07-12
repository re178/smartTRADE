// public/js/config.js – Frontend Configuration

const CONFIG = {
  // API base URL – uses current origin by default (works when served from same server)
  // If frontend is served separately, change this to your backend URL.
  API_BASE: window.location.origin,

  // Currency pairs to display live prices for
  PRICE_PAIRS: ['EUR_USD', 'GBP_USD', 'USD_JPY', 'AUD_USD'],

  // How often to refresh prices (milliseconds)
  PRICE_REFRESH_INTERVAL: 10000,

  // Default pair for signal and trade forms
  DEFAULT_PAIR: 'EUR_USD',

  // Default risk percentage for auto-trade
  DEFAULT_RISK: 1,

  // Default lot size for manual trades
  DEFAULT_LOT: 0.01,
};
