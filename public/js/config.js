// public/js/config.js
'use strict';

window.CONFIG = {
  API_BASE: window.location.origin,
  WS_URL: (window.location.protocol === 'https:' ? 'wss://' : 'ws://')
        + window.location.host,
};

window.WATCHED_SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'];
