// Public/JS config – change this if your backend is on a different URL
const CONFIG = {
  // If dashboard is served from the same origin as the API, use relative path.
  // Otherwise set full URL (e.g., 'https://your-backend.onrender.com')
  API_BASE: window.location.origin,
  // Pairs to display prices
  PRICE_PAIRS: ['EUR_USD', 'GBP_USD', 'USD_JPY', 'AUD_USD'],
  // Auto-refresh interval (ms)
  PRICE_REFRESH_INTERVAL: 10000
};
