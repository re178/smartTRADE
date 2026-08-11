// core/execution/broker.js – Stable Dual‑WebSocket Deriv Broker
// - Public WS: persistent, reconnects only on close/error
// - Auth WS: v3 with `authorize` (legacy, but works; OTP migration planned)
// - Correct contract types: MULTUP / MULTDOWN
// - Account enhancement: tradeMode and server from `_account`
// - Full integration with Account model and priceBuffer
// - Symbol loading with timeout and graceful fallback

const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { sleep } = require('../../shared/helpers');
const logger = require('../../infrastructure/logger') || console;
const Order = require('../../models/Order');

const priceBuffer = require('../../core/data/priceBuffer');
const Price = require('../../models/Price');
const Account = require('../../models/Account');

EventEmitter.defaultMaxListeners = 20;

// ============================================================
// CONSTANTS
// ============================================================
const STATE = {
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  AUTHENTICATING: 'AUTHENTICATING',
  READY: 'READY',
  RECONNECTING: 'RECONNECTING',
  FAILED: 'FAILED',
  FATAL: 'FATAL',
};

const ORDER_STATUS = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  EXECUTING: 'EXECUTING',
  FILLED: 'FILLED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  CLOSED: 'CLOSED',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  MODIFIED: 'MODIFIED',
  EXPIRED: 'EXPIRED',
};

const CB_STATE = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

let _requestCounter = 0;

// ============================================================
// HELPERS
// ============================================================
function generateRequestId() {
  return ++_requestCounter;
}

function generateClientOrderId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `ord_${crypto.randomUUID()}`;
  }
  return `ord_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

function toDerivSymbol(pair, symbolMap) {
  if (!pair) return null;
  const upper = pair.toUpperCase();
  if (symbolMap[upper]) return symbolMap[upper];
  return upper;
}

function fromDerivSymbol(symbol, reverseMap) {
  if (!symbol) return 'UNKNOWN';
  if (reverseMap[symbol]) return reverseMap[symbol];
  const clean = symbol.replace(/^frx/, '');
  if (clean.length === 6) {
    return clean.slice(0, 3) + '_' + clean.slice(3);
  }
  return symbol;
}

// Hardcoded fallback symbols – used only if public discovery fails
const FALLBACK_SYMBOLS = {
  'EUR_USD': 'frxEURUSD',
  'GBP_USD': 'frxGBPUSD',
  'USD_JPY': 'frxUSDJPY',
  'AUD_USD': 'frxAUDUSD',
  'USD_CAD': 'frxUSDCAD',
  'USD_CHF': 'frxUSDCHF',
  'NZD_USD': 'frxNZDUSD',
  'EUR_GBP': 'frxEURGBP',
  'EUR_JPY': 'frxEURJPY',
  'GBP_JPY': 'frxGBPJPY',
};

function redactSensitive(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const copy = JSON.parse(JSON.stringify(obj));
  if (copy.authorize) copy.authorize = '***REDACTED***';
  if (copy.api_token) copy.api_token = '***REDACTED***';
  if (copy.token) copy.token = '***REDACTED***';
  return copy;
}

// ============================================================
// RATE LIMITER
// ============================================================
class RateLimiter {
  constructor(rate, capacity) {
    this.rate = rate;
    this.capacity = capacity;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  async acquire() {
    while (true) {
      const now = Date.now();
      const elapsed = (now - this.lastRefill) / 1000;
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
      this.lastRefill = now;
      if (this.tokens >= 1) {
        this.tokens--;
        return true;
      }
      const waitTime = (1 - this.tokens) / this.rate * 1000;
      await sleep(Math.ceil(waitTime));
    }
  }
}

// ============================================================
// STREAMING MANAGER (public ticks)
// ============================================================
class StreamingManager {
  constructor(broker) {
    this.broker = broker;
    this._subscriptions = new Map();
    this._subscriptionIdMap = new Map();
    this._priceCache = new Map();
  }

  async subscribe(type, symbol, callback) {
    const key = `${type}:${symbol}`;
    if (this._subscriptions.has(key)) {
      const sub = this._subscriptions.get(key);
      if (!sub.callbacks.includes(callback)) {
        sub.callbacks.push(callback);
        logger.info(`[Streaming] Added callback to existing subscription ${key}`);
      }
      return;
    }
    await this.broker._ensurePublicReady();
    const response = await this.broker._sendPublicRequest({ [type]: symbol, subscribe: 1 });
    const subscriptionId = response.subscription?.id;
    if (!subscriptionId) {
      logger.error(`[Streaming] No subscription ID for ${key}`);
      return;
    }
    this._subscriptions.set(key, { type, symbol, subscriptionId, callbacks: [callback] });
    this._subscriptionIdMap.set(subscriptionId, key);
    logger.info(`[Streaming] Subscribed to ${key} (ID: ${subscriptionId})`);
  }

  async unsubscribe(type, symbol, callback = null) {
    const key = `${type}:${symbol}`;
    const sub = this._subscriptions.get(key);
    if (!sub) return;
    if (callback) {
      sub.callbacks = sub.callbacks.filter(cb => cb !== callback);
      if (sub.callbacks.length > 0) return;
    }
    await this.broker._sendPublicRequest({ forget: sub.subscriptionId });
    this._subscriptions.delete(key);
    this._subscriptionIdMap.delete(sub.subscriptionId);
    this._priceCache.delete(symbol);
    logger.info(`[Streaming] Unsubscribed from ${key}`);
  }

  async restoreSubscriptions() {
    if (this._subscriptions.size === 0) return;
    logger.info('[Streaming] Restoring subscriptions...');
    try {
      await this.broker._sendPublicRequest({ forget_all: 'ticks' });
      logger.info('[Streaming] Cleared old subscriptions.');
    } catch (err) {
      logger.warn('[Streaming] Failed to clear old subscriptions:', err.message);
    }
    for (const [key, sub] of this._subscriptions) {
      try {
        const response = await this.broker._sendPublicRequest({ [sub.type]: sub.symbol, subscribe: 1 });
        const newId = response.subscription?.id;
        if (newId) {
          this._subscriptionIdMap.delete(sub.subscriptionId);
          sub.subscriptionId = newId;
          this._subscriptionIdMap.set(newId, key);
          logger.info(`[Streaming] Restored ${key} (new ID: ${newId})`);
        }
      } catch (err) {
        logger.error(`[Streaming] Failed to restore ${key}:`, err.message);
      }
    }
  }

  handleTick(tick) {
    const symbol = tick.symbol;
    const bid = tick.bid ? parseFloat(tick.bid) : null;
    const ask = tick.ask ? parseFloat(tick.ask) : null;
    const mid = tick.quote ? parseFloat(tick.quote) : null;
    const price = mid || (bid && ask ? (bid + ask) / 2 : null);
    if (price) {
      this._priceCache.set(symbol, { bid, ask, mid: price, time: tick.epoch || Date.now() });
    }
    for (const [key, sub] of this._subscriptions) {
      if (sub.symbol === symbol) {
        for (const cb of sub.callbacks) {
          try { cb(tick); } catch (err) { logger.error('[Streaming] Callback error:', err); }
        }
        break;
      }
    }
  }

  getPrice(symbol) { return this._priceCache.get(symbol) || null; }
  getAllPrices() { return Object.fromEntries(this._priceCache); }
}

// ============================================================
// SYMBOL MANAGER
// ============================================================
class SymbolManager {
  constructor() {
    this._symbols = new Map();
    this._leverageMap = {
      'frxEURUSD': 100, 'frxGBPUSD': 100, 'frxUSDJPY': 100,
      'frxAUDUSD': 100, 'frxUSDCAD': 100, 'frxUSDCHF': 100,
      'frxNZDUSD': 100, 'frxEURGBP': 100, 'frxEURJPY': 100,
      'frxGBPJPY': 100,
    };
  }

  setSymbols(symbols) {
    for (const sym of symbols) {
      const key = sym.underlying_symbol ?? sym.symbol;
      if (key) {
        this._symbols.set(key, sym);
        if (sym.leverage) this._leverageMap[key] = sym.leverage;
      }
    }
  }

  getLeverage(derivSymbol) { return this._leverageMap[derivSymbol] || 100; }
  getPip(derivSymbol) { return this._symbols.get(derivSymbol)?.pip || 0.0001; }
  getSymbolInfo(derivSymbol) { return this._symbols.get(derivSymbol) || null; }
}

// ============================================================
// MAIN BROKER CLASS (Stable Dual WebSocket)
// ============================================================
const BROKER_CAPABILITIES = {
  supportsTrailingStop: false,
  supportsHedging: false,
  supportsNetting: true,
  supportsPartialClose: false,
  supportsGuaranteedSL: false,
  supportsOCO: false,
  supportsMarketOrders: true,
  supportsLimitOrders: false,
  supportsStopOrders: false,
  supportsDemo: true,
  supportsLive: true,
  supportedMarkets: ['Forex', 'Indices', 'Commodities', 'Cryptocurrencies'],
};

class DerivBroker extends EventEmitter {
  constructor(config = {}) {
    super();

    const appId = config.appId || process.env.DERIV_APP_ID || '1089';

    this.config = {
      apiToken: config.apiToken || process.env.DERIV_API_TOKEN,
      appId: appId,
      publicWsUrl: config.publicWsUrl || process.env.DERIV_PUBLIC_WS_URL || `wss://api.derivws.com/trading/v1/options/ws/public`,
      authWsUrl: config.authWsUrl || process.env.DERIV_AUTH_WS_URL || `wss://ws.derivws.com/websockets/v3?app_id=${appId}`,
      connectionTimeout: parseInt(config.connectionTimeout || process.env.DERIV_CONNECTION_TIMEOUT || 30000),
      reconnectBaseDelay: parseInt(config.reconnectBaseDelay || process.env.DERIV_RECONNECT_DELAY || 2000),
      maxReconnectDelay: parseInt(config.maxReconnectDelay || process.env.DERIV_MAX_RECONNECT_DELAY || 30000),
      maxRetries: parseInt(config.maxRetries || process.env.DERIV_MAX_RETRIES || 3),
      maxQueueSize: parseInt(config.maxQueueSize || process.env.DERIV_MAX_QUEUE_SIZE || 100),
      circuitBreakerThreshold: parseInt(config.circuitBreakerThreshold || process.env.DERIV_CIRCUIT_BREAKER_THRESHOLD || 20),
      circuitBreakerTimeout: parseInt(config.circuitBreakerTimeout || process.env.DERIV_CIRCUIT_BREAKER_TIMEOUT || 60000),
      minOrderSize: parseFloat(config.minOrderSize || 0.01),
      maxOrderSize: parseFloat(config.maxOrderSize || 100),
      minStopDistance: parseFloat(config.minStopDistance || 0.0001),
      rateLimit: parseFloat(config.rateLimit || 5),
      rateCapacity: parseFloat(config.rateCapacity || 10),
      leverage: parseFloat(config.leverage || 100),
      riskValidator: config.riskValidator || null,
      fatalAfterAuthFailures: parseInt(config.fatalAfterAuthFailures || 3),
      readinessTimeout: parseInt(config.readinessTimeout || process.env.DERIV_READINESS_TIMEOUT || 30000),
      symbolTimeout: parseInt(config.symbolTimeout || process.env.DERIV_SYMBOL_TIMEOUT || 10000), // reduced to 10s
      heartbeatTimeout: parseInt(config.heartbeatTimeout || process.env.DERIV_HEARTBEAT_TIMEOUT || 60000),
    };

    this.productType = 'cfd';

    this.validateConfig();

    // ---------- Public socket (market data) ----------
    this._publicState = STATE.DISCONNECTED;
    this._publicSocket = null;
    this._publicPendingRequests = new Map();
    this._publicMessageQueue = [];
    this._publicHeartbeatInterval = null;
    this._publicHeartbeatTimeout = null;
    this._publicLastPong = Date.now();
    this._publicConnectionPromise = null;
    this._publicReconnectTimer = null;

    // ---------- Auth socket (trading) ----------
    this._authState = STATE.DISCONNECTED;
    this._authSocket = null;
    this._authPendingRequests = new Map();
    this._authMessageQueue = [];
    this._authHeartbeatInterval = null;
    this._authHeartbeatTimeout = null;
    this._authLastPong = Date.now();
    this._authConnectionPromise = null;

    this._rateLimiter = new RateLimiter(this.config.rateLimit, this.config.rateCapacity);

    this.streaming = new StreamingManager(this);
    this.symbolManager = new SymbolManager();

    // ---------- Circuit breaker ----------
    this._cbState = CB_STATE.CLOSED;
    this._cbFailureCount = 0;
    this._cbOpenedAt = null;

    // ---------- Symbol maps ----------
    this.symbolMap = { ...FALLBACK_SYMBOLS };
    this.reverseMap = {};
    for (const [key, val] of Object.entries(FALLBACK_SYMBOLS)) {
      this.reverseMap[val] = key;
    }
    this.spreadMap = {};
    for (const key of Object.keys(FALLBACK_SYMBOLS)) {
      this.spreadMap[FALLBACK_SYMBOLS[key]] = 0.0001;
    }
    this._symbolsDiscovered = false;
    this._symbolsLoaded = false;

    // ---------- Order tracking ----------
    this._orders = new Map();
    this._orderMap = new Map();
    this.accountCurrency = 'USD';

    // ---------- Metrics ----------
    this.metrics = {
      connectedSince: null,
      requestsSent: 0,
      requestsFailed: 0,
      reconnections: 0,
      totalLatency: 0,
      latencyCount: 0,
      heartbeatMisses: 0,
      lastHeartbeat: null,
      ordersPlaced: 0,
      ordersFilled: 0,
      ordersRejected: 0,
      lastPong: Date.now(),
    };

    this.capabilities = { ...BROKER_CAPABILITIES };
    this._authFailCount = 0;
    this._account = null;      // raw authorize response
    this._accountDetails = null; // balance/margin details
    this._portfolioLogged = false;
    this._openPositions = [];

    this._ready = false;

    logger.info('[DerivBroker] Created with stable dual WebSocket architecture.');
    logger.info(`[DerivBroker] Public WS: ${this.config.publicWsUrl}`);
    logger.info(`[DerivBroker] Auth WS: ${this.config.authWsUrl}`);
  }

  validateConfig() {
    if (!this.config.apiToken) throw new Error('DERIV_API_TOKEN is required');
    if (!this.config.appId) throw new Error('DERIV_APP_ID is required');
    if (!this.config.publicWsUrl || !this.config.publicWsUrl.startsWith('ws')) throw new Error('Invalid public WebSocket URL');
    if (!this.config.authWsUrl || !this.config.authWsUrl.startsWith('ws')) throw new Error('Invalid auth WebSocket URL');
    if (this.config.maxQueueSize < 1) throw new Error('maxQueueSize must be at least 1');
    if (isNaN(this.config.leverage) || this.config.leverage <= 0) throw new Error('leverage must be positive');
    logger.info('[DerivBroker] Configuration validated.');
  }

  getLeverage(symbol) {
    return this.symbolManager.getLeverage(symbol) || this.config.leverage || 100;
  }

  // ---------- CONNECTION (overall) ----------
  async connect() {
    await Promise.all([
      this._connectPublic(),
      this._connectAuth()
    ]);
    // Symbol loading with timeout and graceful fallback
    try {
      await this._loadSymbolsWithTimeout();
    } catch (err) {
      logger.warn('[DerivBroker] Symbol discovery failed:', err.message);
    }
    if (!this._symbolsDiscovered) {
      logger.warn('[DerivBroker] Using fallback symbols.');
      this._useFallbackSymbols();
    }
    this._ready = true;
    this.emit('ready');
    this.emit('connected');
    await this._subscribeDefaultSymbols();
    await this._reconcilePositions();
    await this._loadPendingOrders();
  }

  // ---- Public socket: persistent reconnect on close/error ----
  async _connectPublic() {
    if (this._publicState === STATE.READY || this._publicState === STATE.CONNECTED) return;
    if (this._publicConnectionPromise) return this._publicConnectionPromise;
    this._publicConnectionPromise = this._doConnectPublic();
    try {
      await this._publicConnectionPromise;
    } finally {
      this._publicConnectionPromise = null;
    }
  }

  _doConnectPublic() {
    return new Promise((resolve, reject) => {
      if (this._publicReconnectTimer) {
        clearTimeout(this._publicReconnectTimer);
        this._publicReconnectTimer = null;
      }

      if (this._publicState === STATE.FATAL) {
        reject(new Error('Public WS in FATAL state.'));
        return;
      }

      if (this._publicSocket && this._publicSocket.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      this._publicState = STATE.CONNECTING;
      this._closePublicSocket();

      logger.info(`[DerivBroker] Connecting public WS: ${this.config.publicWsUrl}`);

      try {
        this._publicSocket = new WebSocket(this.config.publicWsUrl);
        const socket = this._publicSocket;

        const connectionTimer = setTimeout(() => {
          if (this._publicState !== STATE.CONNECTED) {
            logger.error('[DerivBroker] Public WS connection timeout.');
            socket.terminate();
            this._publicState = STATE.FAILED;
            reject(new Error('Public WS connection timeout'));
          }
        }, this.config.connectionTimeout);

        socket.on('open', () => {
          clearTimeout(connectionTimer);
          logger.info('[DerivBroker] Public WS connected.');
          this._publicState = STATE.CONNECTED;
          this._startPublicHeartbeat();
          this._flushPublicQueue();
          this.emit('publicReady');
          resolve();
        });

        socket.on('message', (data) => this._handlePublicMessage(data));

        socket.on('error', (err) => {
          logger.error('[DerivBroker] Public WS error:', err.message);
        });

        socket.on('close', (code, reason) => {
          clearTimeout(connectionTimer);
          logger.info(`[DerivBroker] Public WS closed. Code: ${code}, Reason: ${reason || 'No reason'}`);
          this._publicState = STATE.DISCONNECTED;
          this._stopPublicHeartbeat();
          if (this._publicReconnectTimer) clearTimeout(this._publicReconnectTimer);
          this._publicReconnectTimer = setTimeout(() => {
            this._connectPublic().catch(err => logger.error('Public reconnect failed:', err));
          }, this._getReconnectDelay(0));
        });

      } catch (err) {
        this._publicState = STATE.FAILED;
        reject(err);
      }
    });
  }

  _startPublicHeartbeat() {
    this._stopPublicHeartbeat();
    this._publicLastPong = Date.now();
    this._publicHeartbeatInterval = setInterval(() => {
      if (this._publicState === STATE.CONNECTED || this._publicState === STATE.READY) {
        this._sendPublicRaw({ ping: 1 });
      }
    }, 30000);
    this._publicHeartbeatTimeout = setInterval(() => {
      if (Date.now() - this._publicLastPong > this.config.heartbeatTimeout) {
        logger.warn('[DerivBroker] Public WS heartbeat timeout, reconnecting.');
        this._closePublicSocket();
        this._connectPublic().catch(err => logger.error('Public reconnect failed:', err));
      }
    }, 10000);
  }

  _stopPublicHeartbeat() {
    if (this._publicHeartbeatInterval) clearInterval(this._publicHeartbeatInterval);
    if (this._publicHeartbeatTimeout) clearInterval(this._publicHeartbeatTimeout);
  }

  _closePublicSocket() {
    this._stopPublicHeartbeat();
    if (this._publicSocket) {
      this._publicSocket.removeAllListeners();
      this._publicSocket.terminate();
      this._publicSocket = null;
    }
    for (const [id, pending] of this._publicPendingRequests) {
      clearTimeout(pending.timeout);
      if (pending.reject) pending.reject(new Error('Public connection closed'));
      this._publicPendingRequests.delete(id);
    }
    if (this._publicState !== STATE.DISCONNECTED && this._publicState !== STATE.FATAL) {
      this._publicState = STATE.DISCONNECTED;
    }
  }

  _sendPublicRaw(payload) {
    if (!this._publicSocket || this._publicSocket.readyState !== WebSocket.OPEN) {
      if (this._publicMessageQueue.length < this.config.maxQueueSize) {
        this._publicMessageQueue.push({ payload, timestamp: Date.now() });
        logger.debug('[DerivBroker] Public message queued (socket not open)');
      } else {
        logger.error('[DerivBroker] Public queue full, dropping message.');
      }
      return;
    }
    try {
      const isImportant = payload.active_symbols || payload.ticks || payload.ohlc;
      if (isImportant) {
        logger.info(`[Out Public] ${payload.req_id || 'no-req-id'} →`, JSON.stringify(redactSensitive(payload), null, 2));
      } else {
        logger.debug(`[Out Public] ${payload.req_id || 'no-req-id'} →`, JSON.stringify(redactSensitive(payload)));
      }
      this._publicSocket.send(JSON.stringify(payload));
    } catch (err) {
      logger.error('[DerivBroker] Public send error:', err.message);
      if (this._publicMessageQueue.length < this.config.maxQueueSize) {
        this._publicMessageQueue.push({ payload, timestamp: Date.now() });
      }
    }
  }

  _flushPublicQueue() {
    while (this._publicMessageQueue.length > 0) {
      const item = this._publicMessageQueue.shift();
      this._sendPublicRaw(item.payload);
    }
  }

  async _sendPublicRequest(payload, timeoutMs = 15000, signal = null) {
    await this._rateLimiter.acquire();
    if (this._publicState !== STATE.CONNECTED && this._publicState !== STATE.READY) {
      await this._connectPublic();
    }
    if (!this._publicSocket || this._publicSocket.readyState !== WebSocket.OPEN) {
      throw new Error('Public WebSocket not open');
    }
    let lastError = null;
    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        if (signal && signal.aborted) throw new Error('Request cancelled');
        const result = await this._sendPublicRawRequest(payload, timeoutMs, signal);
        return result;
      } catch (err) {
        lastError = err;
        logger.warn(`[DerivBroker] Public request failed (attempt ${attempt}):`, err.message);
        if (attempt < this.config.maxRetries) {
          await sleep(this._getReconnectDelay(attempt));
          if (signal && signal.aborted) throw new Error('Request cancelled');
          if (this._publicState !== STATE.CONNECTED) {
            await this._connectPublic();
          }
        }
      }
    }
    throw lastError;
  }

  _sendPublicRawRequest(payload, timeoutMs = 15000, signal = null) {
    return new Promise((resolve, reject) => {
      const reqId = generateRequestId();
      const msg = { ...payload, req_id: reqId };
      const timeout = setTimeout(() => {
        if (this._publicPendingRequests.has(reqId)) {
          this._publicPendingRequests.delete(reqId);
          reject(new Error(`Public request timed out (${timeoutMs}ms)`));
        }
      }, timeoutMs);
      const onCancel = () => {
        clearTimeout(timeout);
        if (this._publicPendingRequests.has(reqId)) {
          this._publicPendingRequests.delete(reqId);
          reject(new Error('Request cancelled'));
        }
      };
      if (signal) signal.addEventListener('abort', onCancel, { once: true });
      this._publicPendingRequests.set(reqId, {
        resolve, reject, timeout, sentAt: Date.now(), cancel: onCancel, signal,
      });
      this._sendPublicRaw(msg);
    });
  }

  _handlePublicMessage(rawData) {
    try {
      const msg = JSON.parse(rawData);
      logger.debug('[In Public]', JSON.stringify(redactSensitive(msg)));

      let handled = false;

      if (msg.pong) {
        this._publicLastPong = Date.now();
        handled = true;
      }

      if (msg.error) {
        logger.error('[In Public] API Error:', JSON.stringify(msg.error, null, 2));
      }

      if (msg.req_id && this._publicPendingRequests.has(msg.req_id)) {
        const pending = this._publicPendingRequests.get(msg.req_id);
        clearTimeout(pending.timeout);
        this._publicPendingRequests.delete(msg.req_id);
        const latency = Date.now() - pending.sentAt;
        this.metrics.totalLatency += latency;
        this.metrics.latencyCount++;
        if (msg.error) {
          this.metrics.requestsFailed++;
          pending.reject(new Error(`Deriv API error: ${msg.error.code} - ${msg.error.message}`));
        } else {
          this.metrics.requestsSent++;
          pending.resolve(msg);
        }
        handled = true;
      }

      if (msg.msg_type === 'tick' && msg.tick) {
        const tick = msg.tick;
        const symbol = tick.symbol;
        const bid = tick.bid ? parseFloat(tick.bid) : null;
        const ask = tick.ask ? parseFloat(tick.ask) : null;
        const time = tick.epoch ? tick.epoch * 1000 : Date.now();

        if (bid !== null && ask !== null) {
          priceBuffer.update(symbol, bid, ask, time);
          Price.upsertPrice(symbol, bid, ask, time, 'deriv')
            .catch(err => logger.error('[DerivBroker] Failed to save price:', err.message));
          this.emit('tick', { symbol, bid, ask, time });
        }

        this.streaming.handleTick(tick);
        handled = true;
      }

      if (msg.active_symbols !== undefined) {
        logger.debug('[In Public] active_symbols response received.');
        handled = true;
      }

      if (!handled) {
        logger.debug('[In Public] Unhandled message type:', JSON.stringify(redactSensitive(msg), null, 2));
      }
    } catch (err) {
      logger.error('[In Public] Parse error:', err.message);
    }
  }

  async _ensurePublicReady() {
    if (this._publicState === STATE.CONNECTED || this._publicState === STATE.READY) return;
    await this._connectPublic();
    await sleep(200);
  }

  // ---- Auth socket (legacy v3 with authorize) ----
  async _connectAuth() {
    if (this._authState === STATE.READY) return;
    if (this._authConnectionPromise) return this._authConnectionPromise;
    this._authConnectionPromise = this._doConnectAuth();
    try {
      await this._authConnectionPromise;
    } finally {
      this._authConnectionPromise = null;
    }
  }

  _doConnectAuth() {
    return new Promise((resolve, reject) => {
      if (this._authState === STATE.FATAL) {
        reject(new Error('Auth WS in FATAL state.'));
        return;
      }

      if (this._authSocket && this._authSocket.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      this._authState = STATE.CONNECTING;
      this._closeAuthSocket();

      logger.info(`[DerivBroker] Connecting auth WS: ${this.config.authWsUrl}`);

      try {
        this._authSocket = new WebSocket(this.config.authWsUrl);
        const socket = this._authSocket;

        const connectionTimer = setTimeout(() => {
          if (this._authState !== STATE.CONNECTED) {
            logger.error('[DerivBroker] Auth WS connection timeout.');
            socket.terminate();
            this._authState = STATE.FAILED;
            reject(new Error('Auth WS connection timeout'));
          }
        }, this.config.connectionTimeout);

        socket.on('open', () => {
          clearTimeout(connectionTimer);
          logger.info('[DerivBroker] Auth WS connected.');
          this._authState = STATE.CONNECTED;
          this._startAuthHeartbeat();
          this._flushAuthQueue();
          this._authorize()
            .then(async (authResponse) => {
              if (authResponse && authResponse.authorize) {
                this._account = authResponse.authorize;
                this.accountCurrency = this._account.currency || 'USD';
                logger.info('[DerivBroker] Account stored from authorize.');

                // Initial account save (basic fields)
                try {
                  await Account.upsertAccount({
                    accountId: 'default',
                    balance: parseFloat(this._account.balance) || 0,
                    equity: parseFloat(this._account.balance) || 0,
                    currency: this.accountCurrency,
                    broker: 'deriv',
                    loginId: this._account.loginid || '',
                    leverage: parseFloat(this._account.leverage) || 100,
                    server: this._account.landing_company_name || '',
                    tradeMode: this._account.is_virtual ? 1 : 0,
                    status: 'online',
                  });
                  logger.info('[DerivBroker] Initial account saved to DB.');
                } catch (err) {
                  logger.error('[DerivBroker] Failed to save account:', err.message);
                }

                // Fetch detailed account (margin, equity)
                try {
                  await this._refreshAccount();
                } catch (err) {
                  logger.warn('[DerivBroker] Failed to refresh account details:', err.message);
                }

                // Emit enhanced account
                const fullAccount = await this.getAccount();
                this.emit('account', fullAccount);
              }
              logger.info('[DerivBroker] Auth authorized.');
              this._authState = STATE.READY;
              this.emit('authReady');
              resolve();
            })
            .catch((err) => {
              logger.error('[DerivBroker] Authorization failed:', err.message);
              this._authFailCount++;
              if (this._authFailCount >= this.config.fatalAfterAuthFailures) {
                this._authState = STATE.FATAL;
                this._closeAuthSocket();
                reject(new Error(`Authorization failed ${this._authFailCount} times.`));
                return;
              }
              this._authState = STATE.FAILED;
              this._closeAuthSocket();
              setTimeout(() => {
                this._connectAuth().catch(err => logger.error('Auth reconnect failed:', err));
              }, this._getReconnectDelay(0));
            });
        });

        socket.on('message', (data) => this._handleAuthMessage(data));
        socket.on('error', (err) => logger.error('[DerivBroker] Auth WS error:', err.message));
        socket.on('close', (code, reason) => {
          clearTimeout(connectionTimer);
          logger.info(`[DerivBroker] Auth WS closed. Code: ${code}`);
          this._authState = STATE.DISCONNECTED;
          this._stopAuthHeartbeat();
          setTimeout(() => {
            this._connectAuth().catch(err => logger.error('Auth reconnect failed:', err));
          }, this._getReconnectDelay(0));
        });

      } catch (err) {
        this._authState = STATE.FAILED;
        reject(err);
      }
    });
  }

  _authorize() {
    return new Promise((resolve, reject) => {
      const reqId = generateRequestId();
      const payload = { authorize: this.config.apiToken, req_id: reqId };
      const timeout = setTimeout(() => {
        if (this._authPendingRequests.has(reqId)) {
          this._authPendingRequests.delete(reqId);
          reject(new Error('Authorize timeout'));
        }
      }, 10000);

      this._authPendingRequests.set(reqId, {
        resolve: (msg) => {
          clearTimeout(timeout);
          const safeMsg = redactSensitive(msg);
          logger.info('[Auth] Authorization response:', JSON.stringify(safeMsg, null, 2));
          resolve(msg);
        },
        reject: (err) => { clearTimeout(timeout); reject(err); },
        timeout,
        sentAt: Date.now(),
        cancel: () => {},
        signal: null,
      });

      this._sendAuthRaw(payload);
    });
  }

  // ---- New: fetch detailed account (balance, margin) ----
  async _refreshAccount() {
    try {
      const response = await this._sendAuthRequest({ balance: 1 });
      const balance = response.balance;
      if (balance) {
        this._accountDetails = balance;
        await Account.upsertAccount({
          accountId: 'default',
          balance: parseFloat(balance.balance) || 0,
          equity: parseFloat(balance.equity) || 0,
          marginUsed: parseFloat(balance.margin_used) || 0,
          marginAvailable: parseFloat(balance.margin_available) || 0,
          marginLevel: parseFloat(balance.margin_level) || 0,
          currency: balance.currency || 'USD',
          broker: 'deriv',
          loginId: balance.loginid || '',
          leverage: parseFloat(balance.leverage) || 100,
          server: balance.server || this._account?.landing_company_name || '',
          accountName: balance.account_name || '',
          status: 'online',
          tradeMode: balance.trade_mode !== undefined ? balance.trade_mode : (this._account?.is_virtual ? 1 : 0),
        });
        logger.info('[DerivBroker] Detailed account saved to DB.');
        // Emit updated account
        const fullAccount = await this.getAccount();
        this.emit('account', fullAccount);
      }
    } catch (err) {
      logger.warn('[DerivBroker] Failed to refresh account details:', err.message);
    }
  }

  _startAuthHeartbeat() {
    this._stopAuthHeartbeat();
    this._authLastPong = Date.now();
    this._authHeartbeatInterval = setInterval(() => {
      if (this._authState === STATE.READY || this._authState === STATE.CONNECTED) {
        this._sendAuthRaw({ ping: 1 });
      }
    }, 30000);
    this._authHeartbeatTimeout = setInterval(() => {
      if (Date.now() - this._authLastPong > this.config.heartbeatTimeout) {
        logger.warn('[DerivBroker] Auth WS heartbeat timeout, reconnecting.');
        this._closeAuthSocket();
        this._connectAuth().catch(err => logger.error('Auth reconnect failed:', err));
      }
    }, 10000);
  }

  _stopAuthHeartbeat() {
    if (this._authHeartbeatInterval) clearInterval(this._authHeartbeatInterval);
    if (this._authHeartbeatTimeout) clearInterval(this._authHeartbeatTimeout);
  }

  _closeAuthSocket() {
    this._stopAuthHeartbeat();
    if (this._authSocket) {
      this._authSocket.removeAllListeners();
      this._authSocket.terminate();
      this._authSocket = null;
    }
    for (const [id, pending] of this._authPendingRequests) {
      clearTimeout(pending.timeout);
      if (pending.reject) pending.reject(new Error('Auth connection closed'));
      this._authPendingRequests.delete(id);
    }
    if (this._authState !== STATE.DISCONNECTED && this._authState !== STATE.FATAL) {
      this._authState = STATE.DISCONNECTED;
    }
  }

  _sendAuthRaw(payload) {
    if (!this._authSocket || this._authSocket.readyState !== WebSocket.OPEN) {
      if (this._authMessageQueue.length < this.config.maxQueueSize) {
        this._authMessageQueue.push({ payload, timestamp: Date.now() });
      } else {
        logger.error('[DerivBroker] Auth queue full, dropping message.');
      }
      return;
    }
    try {
      const isImportant = payload.proposal || payload.buy || payload.sell || payload.portfolio || payload.authorize || payload.balance;
      if (isImportant) {
        logger.info(`[Out Auth] ${payload.req_id || 'no-req-id'} →`, JSON.stringify(redactSensitive(payload), null, 2));
      } else {
        logger.debug(`[Out Auth] ${payload.req_id || 'no-req-id'} →`, JSON.stringify(redactSensitive(payload)));
      }
      this._authSocket.send(JSON.stringify(payload));
    } catch (err) {
      logger.error('[DerivBroker] Auth send error:', err.message);
      if (this._authMessageQueue.length < this.config.maxQueueSize) {
        this._authMessageQueue.push({ payload, timestamp: Date.now() });
      }
    }
  }

  _flushAuthQueue() {
    while (this._authMessageQueue.length > 0) {
      const item = this._authMessageQueue.shift();
      this._sendAuthRaw(item.payload);
    }
  }

  async _sendAuthRequest(payload, timeoutMs = 15000, signal = null) {
    await this._rateLimiter.acquire();
    if (this._authState !== STATE.READY) {
      await this._connectAuth();
    }
    if (!this._authSocket || this._authSocket.readyState !== WebSocket.OPEN) {
      throw new Error('Auth WebSocket not open');
    }
    let lastError = null;
    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        if (signal && signal.aborted) throw new Error('Request cancelled');
        const result = await this._sendAuthRawRequest(payload, timeoutMs, signal);
        return result;
      } catch (err) {
        lastError = err;
        logger.warn(`[DerivBroker] Auth request failed (attempt ${attempt}):`, err.message);
        if (attempt < this.config.maxRetries) {
          await sleep(this._getReconnectDelay(attempt));
          if (signal && signal.aborted) throw new Error('Request cancelled');
          if (this._authState !== STATE.READY) {
            await this._connectAuth();
          }
        }
      }
    }
    throw lastError;
  }

  _sendAuthRawRequest(payload, timeoutMs = 15000, signal = null) {
    return new Promise((resolve, reject) => {
      const reqId = generateRequestId();
      const msg = { ...payload, req_id: reqId };
      const timeout = setTimeout(() => {
        if (this._authPendingRequests.has(reqId)) {
          this._authPendingRequests.delete(reqId);
          reject(new Error(`Auth request timed out (${timeoutMs}ms)`));
        }
      }, timeoutMs);
      const onCancel = () => {
        clearTimeout(timeout);
        if (this._authPendingRequests.has(reqId)) {
          this._authPendingRequests.delete(reqId);
          reject(new Error('Request cancelled'));
        }
      };
      if (signal) signal.addEventListener('abort', onCancel, { once: true });
      this._authPendingRequests.set(reqId, {
        resolve, reject, timeout, sentAt: Date.now(), cancel: onCancel, signal,
      });
      this._sendAuthRaw(msg);
    });
  }

  _handleAuthMessage(rawData) {
    try {
      const msg = JSON.parse(rawData);
      logger.debug('[In Auth]', JSON.stringify(redactSensitive(msg)));

      let handled = false;

      if (msg.pong) {
        this._authLastPong = Date.now();
        handled = true;
      }

      if (msg.error) {
        logger.error('[In Auth] API Error:', JSON.stringify(msg.error, null, 2));
      }

      if (msg.req_id && this._authPendingRequests.has(msg.req_id)) {
        const pending = this._authPendingRequests.get(msg.req_id);
        clearTimeout(pending.timeout);
        this._authPendingRequests.delete(msg.req_id);
        const latency = Date.now() - pending.sentAt;
        this.metrics.totalLatency += latency;
        this.metrics.latencyCount++;
        if (msg.error) {
          this.metrics.requestsFailed++;
          pending.reject(new Error(`Deriv API error: ${msg.error.code} - ${msg.error.message}`));
        } else {
          this.metrics.requestsSent++;
          pending.resolve(msg);
        }
        handled = true;
      }

      if (msg.balance) {
        logger.debug('[In Auth] Balance response received.');
        handled = true;
      }

      if (msg.portfolio) {
        logger.debug('[In Auth] Portfolio response received.');
        const portfolio = msg.portfolio;
        const contracts = portfolio.contracts || [];
        this._openPositions = contracts
          .filter(c => c.status && (c.status.toLowerCase() === 'open' || c.status.toLowerCase() === 'active'))
          .map(c => this._normalizeContract(c));
        this.emit('_portfolioUpdated', this._openPositions);
        handled = true;
      }

      if (msg.buy) {
        logger.info('[In Auth] Buy response received:', JSON.stringify(redactSensitive(msg.buy)));
        handled = true;
      }
      if (msg.sell) {
        logger.info('[In Auth] Sell response received:', JSON.stringify(redactSensitive(msg.sell)));
        handled = true;
      }
      if (msg.proposal) {
        logger.debug('[In Auth] Proposal response received.');
        handled = true;
      }

      if (!handled) {
        logger.debug('[In Auth] Unhandled message type:', JSON.stringify(redactSensitive(msg), null, 2));
      }
    } catch (err) {
      logger.error('[In Auth] Parse error:', err.message);
    }
  }

  async _ensureAuthReady() {
    if (this._authState === STATE.READY) return;
    await this._connectAuth();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Auth ready timeout')), this.config.readinessTimeout);
      this.once('authReady', () => { clearTimeout(timeout); resolve(); });
    });
  }

  // ---------- Symbol loading (public) ----------
  async _loadSymbolsWithTimeout() {
    return Promise.race([
      this._loadSymbolsInternal(),
      sleep(this.config.symbolTimeout).then(() => {
        throw new Error(`Symbol loading timed out after ${this.config.symbolTimeout}ms`);
      })
    ]);
  }

  async _loadSymbolsInternal() {
    logger.info('[DerivBroker] Fetching active symbols from public WS...');
    let symbols = null;

    try {
      logger.info('[DerivBroker] Sending active_symbols: brief...');
      const response = await this._sendPublicRequest({ active_symbols: 'brief' }, 10000);
      logger.info('[DerivBroker] Received active_symbols: brief response.');
      const isArray = Array.isArray(response.active_symbols);
      logger.info(`[DerivBroker] active_symbols isArray: ${isArray}, length: ${isArray ? response.active_symbols.length : 'N/A'}`);
      if (isArray && response.active_symbols.length > 0) {
        symbols = response.active_symbols;
        logger.info(`[Symbols] Loaded ${symbols.length} symbols (brief).`);
        if (symbols[0]) {
          logger.info('[DerivBroker] First symbol (brief):', JSON.stringify(symbols[0], null, 2));
        }
      } else {
        logger.warn('[DerivBroker] Brief symbols empty, trying full...');
        logger.info('[DerivBroker] Sending active_symbols: full...');
        const response2 = await this._sendPublicRequest({ active_symbols: 'full' }, 10000);
        logger.info('[DerivBroker] Received active_symbols: full response.');
        const isArray2 = Array.isArray(response2.active_symbols);
        logger.info(`[DerivBroker] active_symbols (full) isArray: ${isArray2}, length: ${isArray2 ? response2.active_symbols.length : 'N/A'}`);
        if (isArray2 && response2.active_symbols.length > 0) {
          symbols = response2.active_symbols;
          logger.info(`[Symbols] Loaded ${symbols.length} symbols (full).`);
          if (symbols[0]) {
            logger.info('[DerivBroker] First symbol (full):', JSON.stringify(symbols[0], null, 2));
          }
        }
      }
    } catch (err) {
      logger.warn('[DerivBroker] Symbol request failed:', err.message);
      throw err; // rethrow to trigger timeout/fallback
    }

    if (symbols && symbols.length > 0) {
      this._buildSymbolMaps(symbols);
      this._symbolsDiscovered = true;
      this._symbolsLoaded = true;
      logger.info(`[DerivBroker] Symbol discovery completed – ${Object.keys(this.symbolMap).length} forex pairs mapped.`);
      const sample = Object.keys(this.symbolMap).slice(0, 5);
      logger.info(`[Symbols] Sample mappings: ${sample.map(k => `${k} → ${this.symbolMap[k]}`).join(', ')}`);
    } else {
      throw new Error('No symbols received from Deriv.');
    }
  }

  _useFallbackSymbols() {
    logger.warn('[DerivBroker] Using FALLBACK_SYMBOLS.');
    this.symbolMap = { ...FALLBACK_SYMBOLS };
    this.reverseMap = {};
    this.spreadMap = {};
    for (const [key, val] of Object.entries(FALLBACK_SYMBOLS)) {
      this.reverseMap[val] = key;
      this.spreadMap[val] = 0.0001;
    }
    this._symbolsDiscovered = true;
    this._symbolsLoaded = true;
    logger.info(`[DerivBroker] Fallback symbols loaded: ${Object.keys(this.symbolMap).length} pairs.`);
  }

  _buildSymbolMaps(symbols) {
    let count = 0;
    this.symbolMap = {};
    this.reverseMap = {};
    this.spreadMap = {};

    for (const sym of symbols) {
      const derivSymbol = sym.underlying_symbol ?? sym.symbol;
      const display = sym.underlying_symbol_name ?? sym.display_name ?? '';
      const pip = Number(sym.pip_size ?? sym.pip ?? 0.0001);

      if (!derivSymbol) continue;
      const match = display.match(/([A-Z]{3})\/([A-Z]{3})/);
      if (!match) continue;

      const ourPair = match[1] + '_' + match[2];
      this.symbolMap[ourPair] = derivSymbol;
      this.reverseMap[derivSymbol] = ourPair;
      this.spreadMap[derivSymbol] = pip * 0.5;
      count++;
    }

    if (count === 0) {
      logger.warn('[DerivBroker] No forex pairs found in symbol list.');
    } else {
      logger.info(`[DerivBroker] Symbol map built: ${count} forex pairs.`);
    }
    this.symbolManager.setSymbols(symbols);
    return count;
  }

  // ---------- SUBSCRIBE DEFAULT SYMBOLS (watchlist) ----------
  async _subscribeDefaultSymbols() {
    const WATCHLIST = [
      'frxEURUSD',
      'frxGBPUSD',
      'frxUSDJPY',
      'frxAUDUSD'
    ];
    const validSymbols = new Set(Object.values(this.symbolMap));
    const toSubscribe = WATCHLIST.filter(sym => validSymbols.has(sym));

    if (toSubscribe.length === 0) {
      logger.warn('[DerivBroker] None of the watchlist symbols are in the symbol map. Subscribing to fallback symbols...');
      const fallbackSymbols = Object.values(FALLBACK_SYMBOLS).slice(0, 4);
      for (const sym of fallbackSymbols) {
        try {
          await this.streaming.subscribe('ticks', sym, (tick) => {});
          logger.info(`[DerivBroker] Subscribed to fallback symbol: ${sym}`);
        } catch (err) {
          logger.warn(`[DerivBroker] Could not subscribe to ${sym}:`, err.message);
        }
      }
      return;
    }

    logger.info(`[DerivBroker] Subscribing to watchlist symbols: ${toSubscribe.join(', ')}`);
    for (const sym of toSubscribe) {
      try {
        await this.streaming.subscribe('ticks', sym, (tick) => {});
        logger.debug(`[DerivBroker] Subscribed to ticks for ${sym}`);
      } catch (err) {
        logger.warn(`[DerivBroker] Could not subscribe to ${sym}:`, err.message);
      }
    }
  }

  // ---------- ORDER PERSISTENCE ----------
  async _loadPendingOrders() {
    logger.info('[DerivBroker] Loading pending orders from MongoDB...');
    const pendingOrders = await Order.find({ status: { $in: ['PENDING', 'ACCEPTED', 'EXECUTING'] } });
    for (const order of pendingOrders) {
      this._orders.set(order.clientOrderId, order);
      if (order.contractId) this._orderMap.set(order.contractId, order.clientOrderId);
      logger.info(`[DerivBroker] Loaded pending order ${order.clientOrderId} (${order.status})`);
    }
    logger.info(`[DerivBroker] Loaded ${pendingOrders.length} pending orders.`);
  }

  async _updateOrderStatus(clientOrderId, status, contractId = null, txData = null) {
    const update = { status, updatedAt: new Date() };
    if (contractId) update.contractId = contractId;
    if (status === ORDER_STATUS.FILLED) update.filledAt = new Date();
    if (status === ORDER_STATUS.REJECTED) {
      update.rejectedAt = new Date();
      update.rejectReason = txData?.error?.message || 'Unknown';
    }
    await Order.findOneAndUpdate({ clientOrderId }, update, { upsert: true, new: true });
    const order = this._orders.get(clientOrderId);
    if (order) {
      Object.assign(order, update);
      if (contractId) this._orderMap.set(contractId, clientOrderId);
    }
    this.metrics.ordersPlaced++;
    if (status === ORDER_STATUS.FILLED) this.metrics.ordersFilled++;
    if (status === ORDER_STATUS.REJECTED) this.metrics.ordersRejected++;
    logger.info(`[Order] ${clientOrderId} → ${status}`, { clientOrderId, status, contractId });
    this.emit('orderUpdate', { clientOrderId, status, contractId });
  }

  // ---------- POSITION RECONCILIATION (auth) ----------
  async _reconcilePositions() {
    logger.info('[DerivBroker] Reconciling positions from portfolio...');
    try {
      const positions = await this.getOpenTrades();
      logger.info('[Reconcile] Positions from API:', JSON.stringify(positions, null, 2));
      
      const dbOrders = await Order.find({ status: ORDER_STATUS.FILLED });
      const dbMap = new Map();
      for (const ord of dbOrders) {
        if (ord.contractId) dbMap.set(ord.contractId, ord);
      }
      
      for (const pos of positions) {
        const contractId = pos.id;
        if (!dbMap.has(contractId)) {
          const newOrder = new Order({
            clientOrderId: generateClientOrderId(),
            instrument: pos.instrument,
            side: pos.side,
            units: pos.units,
            entryPrice: pos.price,
            status: ORDER_STATUS.FILLED,
            contractId: contractId,
            filledAt: new Date(pos.openTime || Date.now()),
          });
          await newOrder.save();
          this._orders.set(newOrder.clientOrderId, newOrder);
          this._orderMap.set(contractId, newOrder.clientOrderId);
          logger.info(`[Reconcile] Created order for position ${contractId}`);
        }
      }
      
      const openIds = new Set(positions.map(p => p.id));
      for (const [contractId, clientOrderId] of this._orderMap) {
        if (!openIds.has(contractId)) {
          await this._updateOrderStatus(clientOrderId, ORDER_STATUS.CLOSED);
          this._orderMap.delete(contractId);
        }
      }
      
      this.emit('positions', positions);
      logger.info('[Reconcile] Position reconciliation complete.');
    } catch (err) {
      logger.error('[Reconcile] Failed:', err.message);
      throw err;
    }
  }

  // ---------- Normalize contract ----------
  _normalizeContract(contract) {
    return {
      id: contract.contract_id,
      instrument: fromDerivSymbol(contract.underlying_symbol || contract.symbol, this.reverseMap) || 'UNKNOWN',
      side: contract.direction === 'up' ? 'BUY' : (contract.direction === 'down' ? 'SELL' : 'UNKNOWN'),
      price: contract.entry_price || 0,
      units: contract.amount || 0,
      unrealizedPL: contract.profit_loss || 0,
      currentPrice: contract.current_spot || contract.entry_price || 0,
      stopLoss: contract.stop_loss || 0,
      takeProfit: contract.take_profit || 0,
      openTime: contract.start_time ? contract.start_time * 1000 : Date.now(),
      raw: contract,
    };
  }

  // ---------- PUBLIC API ----------

  // ---- Get Account (enhanced) ----
  async getAccount() {
    await this._ensureAuthReady();
    const base = this._account || {};
    const details = this._accountDetails || {};
    return {
      id: base.loginid || details.loginid || 'N/A',
      login: base.loginid || details.loginid || 'N/A',
      balance: details.balance || base.balance || '0',
      currency: details.currency || base.currency || 'USD',
      equity: details.equity || base.balance || '0',
      marginUsed: details.margin_used || '0',
      marginAvailable: details.margin_available || '0',
      marginLevel: details.margin_level || '0',
      leverage: details.leverage || base.leverage || '100',
      server: details.server || base.landing_company_name || '',
      accountName: details.account_name || base.account_name || '',
      tradeMode: details.trade_mode !== undefined ? details.trade_mode : (base.is_virtual ? 1 : 0),
      createdTime: new Date().toISOString(),
    };
  }

  // ---- Get Prices (from public) ----
  async getPrices(instruments) {
    await this._ensurePublicReady();
    const results = [];
    for (const pair of instruments) {
      const symbol = toDerivSymbol(pair, this.symbolMap);
      if (!symbol) {
        logger.warn(`[getPrices] Unknown pair: ${pair}`);
        continue;
      }
      const cached = this.streaming.getPrice(symbol);
      if (cached) {
        results.push({
          instrument: pair,
          bids: [{ price: cached.bid ? cached.bid.toFixed(5) : (cached.mid - 0.00005).toFixed(5) }],
          asks: [{ price: cached.ask ? cached.ask.toFixed(5) : (cached.mid + 0.00005).toFixed(5) }],
          time: cached.time,
        });
        continue;
      }
      const response = await this._sendPublicRequest({ ticks: symbol });
      const tick = response.tick;
      let bid, ask;
      if (tick.bid !== undefined && tick.ask !== undefined) {
        bid = parseFloat(tick.bid);
        ask = parseFloat(tick.ask);
      } else {
        const mid = parseFloat(tick.quote || tick.price);
        const spread = this.spreadMap[symbol] || 0.0001;
        bid = mid - spread / 2;
        ask = mid + spread / 2;
      }
      results.push({
        instrument: pair,
        bids: [{ price: bid.toFixed(5) }],
        asks: [{ price: ask.toFixed(5) }],
        time: tick.epoch || Date.now(),
      });
    }
    return results;
  }

  // ---- Get Candles (from public) ----
  async getCandles(instrument, count = 100, granularity = 'M5') {
    await this._ensurePublicReady();
    const symbol = toDerivSymbol(instrument, this.symbolMap);
    if (!symbol) throw new Error(`Unknown instrument: ${instrument}`);
    const intervalMap = {
      'M1': 60, 'M5': 300, 'M15': 900, 'M30': 1800,
      'H1': 3600, 'H4': 14400, 'D': 86400,
    };
    const seconds = intervalMap[granularity] || 300;
    const end = Math.floor(Date.now() / 1000);
    const start = end - (count * seconds + 10);
    const response = await this._sendPublicRequest({
      ohlc: symbol,
      interval: seconds,
      start: start,
      end: end,
    });
    const candles = response.candles || [];
    const sorted = candles.slice(-count);
    return sorted.map(c => ({
      mid: { o: c.open, h: c.high, l: c.low, c: c.close },
      time: c.epoch,
      complete: true,
    }));
  }

  // ---- Get Open Trades (auth) ----
  async getOpenTrades() {
    await this._ensureAuthReady();
    try {
      const response = await this._sendAuthRequest({ portfolio: 1 });
      const portfolio = response.portfolio || {};
      const contracts = portfolio.contracts || [];
      const openContracts = contracts.filter(c => 
        c.status && (c.status.toLowerCase() === 'open' || c.status.toLowerCase() === 'active')
      );
      return openContracts.map(c => this._normalizeContract(c));
    } catch (err) {
      logger.error('[DerivBroker] Failed to fetch portfolio:', err.message);
      return [];
    }
  }

  async getPositions() { return this.getOpenTrades(); }

  // ---- Place Market Order (auth) – CORRECTED CONTRACT TYPES ----
  async placeMarketOrder(instrument, units, stopLoss = null, takeProfit = null) {
    await this._ensureAuthReady();
    const amount = Math.abs(units);
    if (amount <= 0) throw new Error('Order units must be positive.');
    const direction = units > 0 ? 'MULTUP' : 'MULTDOWN';
    const symbol = toDerivSymbol(instrument, this.symbolMap);
    if (!symbol) throw new Error(`Unknown instrument: ${instrument}`);
    
    const proposalPayload = {
      proposal: 1,
      amount: amount,
      basis: 'stake',
      contract_type: direction,
      currency: this.accountCurrency || 'USD',
      duration: 60,
      duration_unit: 's',
      underlying_symbol: symbol,
      multiplier: this.getLeverage(symbol) || 100,
    };
    if (stopLoss) proposalPayload.stop_loss = stopLoss;
    if (takeProfit) proposalPayload.take_profit = takeProfit;

    const proposalResponse = await this._sendAuthRequest(proposalPayload);
    const proposal = proposalResponse.proposal;
    if (!proposal) {
      throw new Error('Failed to get proposal: ' + JSON.stringify(proposalResponse));
    }
    const proposalId = proposal.id;
    const askPrice = proposal.ask_price;

    const buyPayload = {
      buy: proposalId,
      price: askPrice,
    };
    const buyResponse = await this._sendAuthRequest(buyPayload);
    const buy = buyResponse.buy;
    if (!buy || !buy.contract_id) {
      throw new Error('Buy failed: ' + JSON.stringify(buyResponse));
    }

    const contractId = buy.contract_id;
    const price = buy.price || 0;

    const newOrder = new Order({
      clientOrderId: generateClientOrderId(),
      instrument,
      side: units > 0 ? 'BUY' : 'SELL',
      units: amount,
      entryPrice: price,
      status: ORDER_STATUS.FILLED,
      contractId: contractId,
      filledAt: new Date(),
    });
    await newOrder.save();
    this._orders.set(newOrder.clientOrderId, newOrder);
    this._orderMap.set(contractId, newOrder.clientOrderId);

    this.getOpenTrades()
      .then(positions => this.emit('positions', positions))
      .catch(err => logger.error('[DerivBroker] Failed to emit positions after market order:', err.message));

    return {
      tradeID: String(contractId),
      ticket: String(contractId),
      price: price,
      raw: buyResponse,
    };
  }

  // ---- Close Trade (auth) ----
  async closeTrade(tradeId) {
    await this._ensureAuthReady();
    if (!tradeId) throw new Error('tradeId is required');
    const sellPayload = {
      sell: tradeId,
      price: 0,
    };
    const response = await this._sendAuthRequest(sellPayload);
    const sell = response.sell;
    if (!sell) {
      throw new Error('Close trade failed: ' + JSON.stringify(response));
    }
    const clientOrderId = this._orderMap.get(tradeId);
    if (clientOrderId) {
      await this._updateOrderStatus(clientOrderId, ORDER_STATUS.CLOSED);
      this._orderMap.delete(tradeId);
    }
    this.getOpenTrades()
      .then(positions => this.emit('positions', positions))
      .catch(err => logger.error('[DerivBroker] Failed to emit positions after close:', err.message));
    return response;
  }

  // ---- Modify SL/TP (auth) ----
  async modifySLTP(tradeId, stopLoss, takeProfit) {
    await this._ensureAuthReady();
    if (!tradeId) throw new Error('tradeId is required');
    const positions = await this.getOpenTrades();
    const pos = positions.find(p => p.id === tradeId);
    if (!pos) {
      throw new Error(`Trade ${tradeId} not found or not open`);
    }
    await this.closeTrade(tradeId);
    const side = pos.side === 'BUY' ? 1 : -1;
    const units = pos.units * side;
    const result = await this.placeMarketOrder(pos.instrument, units, stopLoss, takeProfit);
    return {
      message: 'Modified SL/TP by reopening position',
      newTradeId: result.tradeID,
      price: result.price,
    };
  }

  // ---- Partial Close (not supported) ----
  async partialClose(tradeId, units) {
    throw new Error('Partial close is not supported for CFD positions via the public API.');
  }

  // ---- Limit Orders (not implemented) ----
  async placeLimitOrder(instrument, units, price, stopLoss = null, takeProfit = null) {
    logger.warn('[DerivBroker] Limit orders are not supported; falling back to market order.');
    return this.placeMarketOrder(instrument, units, stopLoss, takeProfit);
  }

  // ---- Health ----
  isMarketDataConnected() {
    return this._publicState === STATE.CONNECTED || this._publicState === STATE.READY;
  }

  isTradingReady() {
    return this._authState === STATE.READY;
  }

  isConnected() {
    return this.isMarketDataConnected() && this.isTradingReady();
  }

  isAuthorized() {
    return this.isTradingReady();
  }

  getHealth() {
    return {
      publicState: this._publicState,
      authState: this._authState,
      marketDataConnected: this.isMarketDataConnected(),
      tradingReady: this.isTradingReady(),
      ready: this._ready,
      circuitBreaker: this._cbState,
      reconnectCount: this.metrics.reconnections,
      queueSize: this._publicMessageQueue.length + this._authMessageQueue.length,
      pendingRequests: this._publicPendingRequests.size + this._authPendingRequests.size,
      lastHeartbeat: this.metrics.lastHeartbeat,
      lastPong: this.metrics.lastPong,
      averageLatency: this.metrics.latencyCount > 0 ? this.metrics.totalLatency / this.metrics.latencyCount : 0,
      uptime: this.metrics.connectedSince ? Date.now() - this.metrics.connectedSince : 0,
      orders: {
        placed: this.metrics.ordersPlaced,
        filled: this.metrics.ordersFilled,
        rejected: this.metrics.ordersRejected,
      },
      subscriptions: this.streaming._subscriptions.size,
      openPositions: this._openPositions.length,
    };
  }

  async killSwitch() {
    logger.warn('🚨 EMERGENCY KILL SWITCH ACTIVATED 🚨');
    const positions = await this.getOpenTrades();
    for (const pos of positions) {
      try {
        await this.closeTrade(pos.id);
        logger.info(`[Kill] Closed position ${pos.id}`);
      } catch (err) {
        logger.error(`[Kill] Failed to close ${pos.id}:`, err.message);
      }
    }
    const pending = await Order.find({ status: ORDER_STATUS.PENDING });
    for (const order of pending) {
      await this._updateOrderStatus(order.clientOrderId, ORDER_STATUS.CANCELLED);
      logger.info(`[Kill] Cancelled order ${order.clientOrderId}`);
    }
    await this.disconnect();
    logger.warn('🚨 Kill switch complete.');
  }

  async disconnect() {
    logger.info('[DerivBroker] Disconnecting gracefully...');
    this._closePublicSocket();
    this._closeAuthSocket();
    this._publicState = STATE.DISCONNECTED;
    this._authState = STATE.DISCONNECTED;
    this._ready = false;
    logger.info('[DerivBroker] Disconnected.');
  }

  // ---- Utility ----
  _getReconnectDelay(attempt) {
    const base = this.config.reconnectBaseDelay;
    const max = this.config.maxReconnectDelay;
    const delay = Math.min(base * Math.pow(2, attempt), max);
    const jitter = delay * (0.8 + 0.4 * Math.random());
    return Math.round(jitter);
  }

  // ---- Risk validation ----
  async _validateOrderRisk(instrument, side, units, stopLoss, takeProfit) {
    if (this.config.riskValidator) {
      const result = await this.config.riskValidator({
        instrument,
        side,
        units,
        stopLoss,
        takeProfit,
        account: await this.getAccount(),
      });
      if (!result.approved) throw new Error(`Risk validation failed: ${result.reason}`);
    }
    const account = await this.getAccount();
    const marginAvailable = parseFloat(account.marginAvailable);
    if (marginAvailable <= 0) throw new Error('Insufficient margin');
    const balance = parseFloat(account.balance);
    const exposure = units * 0.01;
    if (exposure > balance * 0.1) throw new Error(`Order size ${units} exceeds 10% of balance`);
  }
}

// ============================================================
// EXPORT – singleton
// ============================================================
const brokerInstance = new DerivBroker({
  apiToken: process.env.DERIV_API_TOKEN,
  appId: process.env.DERIV_APP_ID,
  publicWsUrl: process.env.DERIV_PUBLIC_WS_URL || `wss://api.derivws.com/trading/v1/options/ws/public`,
  authWsUrl: process.env.DERIV_AUTH_WS_URL || `wss://ws.derivws.com/websockets/v3?app_id=${process.env.DERIV_APP_ID || '1089'}`,
  connectionTimeout: parseInt(process.env.DERIV_CONNECTION_TIMEOUT) || 30000,
  reconnectBaseDelay: parseInt(process.env.DERIV_RECONNECT_DELAY) || 2000,
  maxReconnectDelay: parseInt(process.env.DERIV_MAX_RECONNECT_DELAY) || 30000,
  maxRetries: parseInt(process.env.DERIV_MAX_RETRIES) || 3,
  maxQueueSize: parseInt(process.env.DERIV_MAX_QUEUE_SIZE) || 100,
  circuitBreakerThreshold: parseInt(process.env.DERIV_CIRCUIT_BREAKER_THRESHOLD) || 20,
  circuitBreakerTimeout: parseInt(process.env.DERIV_CIRCUIT_BREAKER_TIMEOUT) || 60000,
  minOrderSize: parseFloat(process.env.DERIV_MIN_ORDER_SIZE) || 0.01,
  maxOrderSize: parseFloat(process.env.DERIV_MAX_ORDER_SIZE) || 100,
  minStopDistance: parseFloat(process.env.DERIV_MIN_STOP_DISTANCE) || 0.0001,
  rateLimit: parseFloat(process.env.DERIV_RATE_LIMIT) || 5,
  rateCapacity: parseFloat(process.env.DERIV_RATE_CAPACITY) || 10,
  leverage: parseFloat(process.env.DERIV_LEVERAGE) || 100,
  fatalAfterAuthFailures: parseInt(process.env.DERIV_FATAL_AFTER_AUTH_FAILURES) || 3,
  readinessTimeout: parseInt(process.env.DERIV_READINESS_TIMEOUT) || 30000,
  symbolTimeout: parseInt(process.env.DERIV_SYMBOL_TIMEOUT) || 10000, // 10s
  heartbeatTimeout: parseInt(process.env.DERIV_HEARTBEAT_TIMEOUT) || 60000,
});

module.exports = brokerInstance;
module.exports.DerivBroker = DerivBroker;
