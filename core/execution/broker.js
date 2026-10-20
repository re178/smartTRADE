// core/execution/broker.js – Stable Dual‑WebSocket Deriv Broker
// Current Options API:
//   PUBLIC WS : wss://api.derivws.com/trading/v1/options/ws/public
//   AUTH      : GET /trading/v1/options/accounts
//                 → POST /trading/v1/options/accounts/{account_id}/otp
//                 → connect to returned WS URL (already authenticated)
//
// [FIX 1..8]   Pre-existing fixes (single-flight connect, safe subscribe,
//              account-type selection, balance, multiplier workflow, spread).
// [CHANGE-1A/1B/1C] Explicit purchase-vs-entry extraction, new return shape,
//              broker no longer creates Order records (orderService owns).
// [CHANGE-5]   _normalizeContract exposes id / purchasePrice / entryPrice /
//              status: 'OPEN' / isValidToSell.
// [CHANGE-8]   placeMarketOrder accepts 5th arg options { multiplier } and
//              validates it before any proposal is sent.
// [LIVE-1..7]  proposal_open_contract subscription after buy, per-tick
//              handling, throttled Trade persistence, startup + reconnect
//              resume, closeTrade final-state write.

const WebSocket = require('ws');
const axios = require('axios');
const { EventEmitter } = require('events');
const { sleep } = require('../../shared/helpers');
const logger = require('../../infrastructure/logger') || console;
const Order = require('../../models/Order');
// [LIVE-1] Broker updates Trade for live state. orderService remains the
// single owner of record CREATION; broker is the writer for state updates.
const Trade = require('../../models/Trade');

const priceBuffer = require('../../core/data/priceBuffer');
const Price = require('../../models/Price');
const Account = require('../../models/Account');

EventEmitter.defaultMaxListeners = 20;

// ============================================================
// WATCHLIST
// ============================================================
const WATCHLIST = ['frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxAUDUSD'];

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

// [FIX 6] Deriv accepts only these multiplier values for MULTUP/MULTDOWN.
const ACCEPTED_MULTIPLIERS = [100, 200, 300, 500, 800];
const DEFAULT_MULTIPLIER = 100;

// ============================================================
// HELPERS
// ============================================================
function generateRequestId() { return ++_requestCounter; }

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
  if (clean.length === 6) return clean.slice(0, 3) + '_' + clean.slice(3);
  return symbol;
}

const FALLBACK_SYMBOLS = {
  'EUR_USD': 'frxEURUSD', 'GBP_USD': 'frxGBPUSD', 'USD_JPY': 'frxUSDJPY',
  'AUD_USD': 'frxAUDUSD', 'USD_CAD': 'frxUSDCAD', 'USD_CHF': 'frxUSDCHF',
  'NZD_USD': 'frxNZDUSD', 'EUR_GBP': 'frxEURGBP', 'EUR_JPY': 'frxEURJPY',
  'GBP_JPY': 'frxGBPJPY',
};

function redactSensitive(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const copy = JSON.parse(JSON.stringify(obj));
  if (copy.authorize) copy.authorize = '***REDACTED***';
  if (copy.api_token) copy.api_token = '***REDACTED***';
  if (copy.token) copy.token = '***REDACTED***';
  if (copy.otp) copy.otp = '***REDACTED***';
  return copy;
}

function isPatToken(token) {
  return typeof token === 'string' && token.startsWith('pat_');
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
      if (this.tokens >= 1) { this.tokens--; return true; }
      await sleep(Math.ceil((1 - this.tokens) / this.rate * 1000));
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
    this._pendingSubscriptions = new Map();
  }

  async subscribe(type, symbol, callback) {
    const key = `${type}:${symbol}`;

    if (this._subscriptions.has(key)) {
      const sub = this._subscriptions.get(key);
      if (!sub.callbacks.includes(callback)) sub.callbacks.push(callback);
      return;
    }

    if (this._pendingSubscriptions.has(key)) {
      const pending = this._pendingSubscriptions.get(key);
      if (!pending.callbacks.includes(callback)) pending.callbacks.push(callback);
      return pending.promise;
    }

    const pending = { callbacks: [callback] };
    pending.promise = (async () => {
      try {
        await this.broker._ensurePublicReady();
        const response = await this.broker._sendPublicRequest({ [type]: symbol, subscribe: 1 });
        const subscriptionId = response.subscription?.id;
        if (!subscriptionId) {
          logger.error(`[Streaming] No subscription ID for ${key}`);
          return;
        }
        this._subscriptions.set(key, {
          type, symbol, subscriptionId, callbacks: pending.callbacks,
        });
        this._subscriptionIdMap.set(subscriptionId, key);
        logger.info(`[Streaming] Subscribed to ${key} (ID: ${subscriptionId})`);
      } catch (err) {
        logger.error(`[Streaming] Subscribe failed for ${key}:`, err.message);
      } finally {
        this._pendingSubscriptions.delete(key);
      }
    })();

    this._pendingSubscriptions.set(key, pending);
    return pending.promise;
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
  }

  async restoreSubscriptions() {
    if (this._subscriptions.size === 0) return;
    logger.info('[Streaming] Restoring subscriptions...');
    try { await this.broker._sendPublicRequest({ forget_all: 'ticks' }); } catch (_) {}
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
      } catch (err) { logger.error(`[Streaming] Restore failed ${key}:`, err.message); }
    }
  }

  handleTick(tick) {
    const symbol = tick.symbol;
    const bid = tick.bid ? parseFloat(tick.bid) : null;
    const ask = tick.ask ? parseFloat(tick.ask) : null;
    const mid = tick.quote ? parseFloat(tick.quote) : null;
    const price = mid || (bid && ask ? (bid + ask) / 2 : null);
    if (price) this._priceCache.set(symbol, { bid, ask, mid: price, time: tick.epoch || Date.now() });
    for (const [, sub] of this._subscriptions) {
      if (sub.symbol === symbol) {
        for (const cb of sub.callbacks) { try { cb(tick); } catch (_) {} }
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
  constructor() { this._symbols = new Map(); }
  setSymbols(symbols) {
    for (const sym of symbols) {
      const key = sym.underlying_symbol ?? sym.symbol;
      if (key) this._symbols.set(key, sym);
    }
  }
  getSymbolInfo(derivSymbol) { return this._symbols.get(derivSymbol) || null; }
}

// ============================================================
// BROKER
// ============================================================
const BROKER_CAPABILITIES = {
  supportsTrailingStop: false, supportsHedging: false, supportsNetting: true,
  supportsPartialClose: false, supportsGuaranteedSL: false, supportsOCO: false,
  supportsMarketOrders: true, supportsLimitOrders: false, supportsStopOrders: false,
  supportsDemo: true, supportsLive: true,
  supportedMarkets: ['Forex', 'Indices', 'Commodities', 'Cryptocurrencies'],
};

class DerivBroker extends EventEmitter {
  constructor(config = {}) {
    super();
    const appId = config.appId || process.env.DERIV_APP_ID || '1089';

    this.config = {
      apiToken: config.apiToken || process.env.DERIV_API_TOKEN,
      appId: appId,
      restBaseUrl: config.restBaseUrl || process.env.DERIV_REST_BASE_URL || 'https://api.derivws.com',
      publicWsUrl: config.publicWsUrl || process.env.DERIV_PUBLIC_WS_URL || 'wss://api.derivws.com/trading/v1/options/ws/public',
      accountId: config.accountId || process.env.DERIV_ACCOUNT_ID || null,
      accountType: (config.accountType || process.env.DERIV_ACCOUNT_TYPE || 'demo').toLowerCase(),
      connectionTimeout: parseInt(config.connectionTimeout || process.env.DERIV_CONNECTION_TIMEOUT || 30000),
      reconnectBaseDelay: parseInt(config.reconnectBaseDelay || process.env.DERIV_RECONNECT_DELAY || 2000),
      maxReconnectDelay: parseInt(config.maxReconnectDelay || process.env.DERIV_MAX_RECONNECT_DELAY || 30000),
      maxRetries: parseInt(config.maxRetries || process.env.DERIV_MAX_RETRIES || 3),
      maxQueueSize: parseInt(config.maxQueueSize || process.env.DERIV_MAX_QUEUE_SIZE || 100),
      minOrderSize: parseFloat(config.minOrderSize || 0.01),
      maxOrderSize: parseFloat(config.maxOrderSize || 100),
      minStopDistance: parseFloat(config.minStopDistance || 0.0001),
      rateLimit: parseFloat(config.rateLimit || 5),
      rateCapacity: parseFloat(config.rateCapacity || 10),
      leverage: parseFloat(config.leverage || 100),
      riskValidator: config.riskValidator || null,
      fatalAfterAuthFailures: parseInt(config.fatalAfterAuthFailures || 3),
      readinessTimeout: parseInt(config.readinessTimeout || process.env.DERIV_READINESS_TIMEOUT || 30000),
      symbolTimeout: parseInt(config.symbolTimeout || process.env.DERIV_SYMBOL_TIMEOUT || 30000),
      heartbeatTimeout: parseInt(config.heartbeatTimeout || process.env.DERIV_HEARTBEAT_TIMEOUT || 60000),
      balanceTimeout: parseInt(config.balanceTimeout || process.env.DERIV_BALANCE_TIMEOUT || 10000),
      // [LIVE-4] Minimum gap between Trade-document state writes per contract.
      // Final settlement always writes immediately.
      contractPersistIntervalMs: parseInt(
        config.contractPersistIntervalMs
        || process.env.DERIV_CONTRACT_PERSIST_INTERVAL_MS
        || 3000
      ),
      // [LIVE-3] Timeout for the initial proposal_open_contract response.
      contractSubscribeTimeout: parseInt(
        config.contractSubscribeTimeout
        || process.env.DERIV_CONTRACT_SUBSCRIBE_TIMEOUT
        || 15000
      ),
    };

    this.validateConfig();

    this._publicState = STATE.DISCONNECTED;
    this._publicSocket = null;
    this._publicPendingRequests = new Map();
    this._publicMessageQueue = [];
    this._publicHeartbeatInterval = null;
    this._publicHeartbeatTimeout = null;
    this._publicLastPong = Date.now();
    this._publicConnectionPromise = null;
    this._publicReconnectTimer = null;

    this._authState = STATE.DISCONNECTED;
    this._authSocket = null;
    this._authWsUrl = null;
    this._authPendingRequests = new Map();
    this._authMessageQueue = [];
    this._authHeartbeatInterval = null;
    this._authHeartbeatTimeout = null;
    this._authLastPong = Date.now();
    this._authConnectionPromise = null;
    this._authReconnectTimer = null;

    this._rateLimiter = new RateLimiter(this.config.rateLimit, this.config.rateCapacity);
    this.streaming = new StreamingManager(this);
    this.symbolManager = new SymbolManager();

    this._cbState = CB_STATE.CLOSED;
    this._cbFailureCount = 0;
    this._cbOpenedAt = null;

    this.symbolMap = { ...FALLBACK_SYMBOLS };
    this.reverseMap = {};
    for (const [k, v] of Object.entries(FALLBACK_SYMBOLS)) this.reverseMap[v] = k;
    this.spreadMap = {};
    for (const k of Object.keys(FALLBACK_SYMBOLS)) this.spreadMap[FALLBACK_SYMBOLS[k]] = 0.0001;
    this._symbolsDiscovered = false;
    this._symbolsLoaded = false;

    this._orders = new Map();
    this._orderMap = new Map();
    this.accountCurrency = 'USD';

    // [LIVE-3] Per-contract subscription bookkeeping.
    this._contractSubscriptions = new Map();
    this._contractStates = new Map();
    this._contractPersistAt = new Map();
    this._contractPersistTimers = new Map();

    this.metrics = {
      connectedSince: null, requestsSent: 0, requestsFailed: 0, reconnections: 0,
      totalLatency: 0, latencyCount: 0, heartbeatMisses: 0, lastHeartbeat: null,
      ordersPlaced: 0, ordersFilled: 0, ordersRejected: 0, lastPong: Date.now(),
      contractSubscriptions: 0, contractUpdates: 0, contractUpdatesPersisted: 0,
    };

    this.capabilities = { ...BROKER_CAPABILITIES };
    this._authFailCount = 0;
    this._account = null;
    this._openPositions = [];
    this._ready = false;

    // [FIX 1] Single-flight guard for connect().
    this._connectPromise = null;

    // [FIX 4] Deferred resolved once the first balance frame arrives.
    this._accountReady = null;
    this._accountReadyResolve = null;

    logger.info('[DerivBroker] Initialized with Current Options API (OTP-URL auth).');
    logger.info(`[DerivBroker] REST base: ${this.config.restBaseUrl}`);
    logger.info(`[DerivBroker] Public WS: ${this.config.publicWsUrl}`);
    logger.info(`[DerivBroker] Account type preference: ${this.config.accountType}`);
    logger.info(`[DerivBroker] Watchlist: ${WATCHLIST.join(', ')}`);
    logger.info(`[DerivBroker] Contract persist interval: ${this.config.contractPersistIntervalMs}ms`);
  }

  validateConfig() {
    if (!this.config.apiToken) throw new Error('DERIV_API_TOKEN is required');
    if (!this.config.appId) throw new Error('DERIV_APP_ID is required');
    if (!this.config.publicWsUrl?.startsWith('ws')) throw new Error('Invalid public WebSocket URL');
    if (!this.config.restBaseUrl?.startsWith('http')) throw new Error('Invalid REST base URL');
    if (this.config.maxQueueSize < 1) throw new Error('maxQueueSize must be at least 1');
    if (!['demo', 'real'].includes(this.config.accountType)) {
      throw new Error(
        `DERIV_ACCOUNT_TYPE must be "demo" or "real" (got "${this.config.accountType}")`
      );
    }
    logger.info('[DerivBroker] Configuration validated.');
  }

  getLeverage(_symbol) { return 100; }

  // [FIX 8] Spread lookup — required by risk validation and trade placement.
  getSpread(instrument) {
    if (!instrument) return 0;
    let symbol = toDerivSymbol(instrument, this.symbolMap);
    if (symbol && !symbol.startsWith('frx')) {
      const upper = symbol.toUpperCase();
      if (upper.length === 6 && !upper.includes('_')) {
        const sep = upper.slice(0, 3) + '_' + upper.slice(3);
        if (this.symbolMap[sep]) symbol = this.symbolMap[sep];
      }
    }
    const cached = this.streaming.getPrice(symbol);
    if (cached && cached.bid != null && cached.ask != null) {
      const live = Math.abs(cached.ask - cached.bid);
      if (Number.isFinite(live) && live > 0) return live;
    }
    const mapped = this.spreadMap[symbol];
    if (Number.isFinite(mapped) && mapped > 0) return mapped;
    return 0.0001;
  }

  // ============================================================
  // REST HEADERS
  // ============================================================
  _restHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${this.config.apiToken}`,
    };
    if (isPatToken(this.config.apiToken)) {
      headers['Deriv-App-ID'] = String(this.config.appId);
    }
    return headers;
  }

  async _fetchAccounts() {
    const url = `${this.config.restBaseUrl}/trading/v1/options/accounts`;
    logger.info(`[DerivBroker] GET ${url}`);
    const resp = await axios.get(url, {
      headers: this._restHeaders(),
      timeout: this.config.connectionTimeout,
    });
    const raw = resp.data?.data ?? resp.data;
    let list = [];
    if (Array.isArray(raw)) list = raw;
    else if (Array.isArray(raw?.accounts)) list = raw.accounts;
    else if (raw && typeof raw === 'object') list = [raw];
    logger.info(`[DerivBroker] Discovered ${list.length} Options account(s).`);
    for (const acc of list) {
      const id = acc.account_id || acc.id || acc.accountId;
      const type = acc.account_type || acc.type || 'unknown';
      const cur = acc.currency || 'N/A';
      logger.info(`[DerivBroker]   • account_id=${id} type=${type} currency=${cur}`);
    }
    return list;
  }

  async _resolveAccountId() {
    const accounts = await this._fetchAccounts();
    if (!accounts || accounts.length === 0) {
      throw new Error('No Options trading accounts found for this PAT');
    }
    const normType = (a) => String(a.account_type || a.type || '').toLowerCase();
    const normId   = (a) => a.account_id || a.id || a.accountId;

    const remember = (acc) => {
      this._account = {
        loginid: normId(acc),
        account_id: normId(acc),
        currency: acc.currency || 'USD',
        account_type: normType(acc),
        balance: this._account?.balance ?? null,
      };
      if (acc.currency) this.accountCurrency = acc.currency;
    };

    if (this.config.accountId) {
      const match = accounts.find(a => normId(a) === this.config.accountId);
      if (match) {
        const id = normId(match);
        logger.info(`[DerivBroker] Using configured accountId (validated): ${id} [type=${normType(match)} currency=${match.currency || 'N/A'}]`);
        remember(match);
        return id;
      }
      logger.warn(`[DerivBroker] Configured accountId "${this.config.accountId}" not in discovered list. Falling back to type-based selection.`);
    }

    const wanted = this.config.accountType;
    const byType = accounts.filter(a => normType(a) === wanted);
    if (byType.length === 0) {
      const available = accounts.map(a => `${normType(a)}(${normId(a)})`).join(', ');
      throw new Error(`No Options account of type "${wanted}" found. Available: [${available}]. Set DERIV_ACCOUNT_TYPE to one of those, or set DERIV_ACCOUNT_ID explicitly.`);
    }
    if (byType.length > 1) {
      logger.warn(`[DerivBroker] ${byType.length} "${wanted}" accounts found; selecting first. Set DERIV_ACCOUNT_ID to pin a specific one.`);
    }

    const chosen = byType[0];
    const id = normId(chosen);
    if (!id) throw new Error('Account object missing account_id: ' + JSON.stringify(chosen));
    logger.info(`[DerivBroker] Auto-selected accountId: ${id} [type=${normType(chosen)} currency=${chosen.currency || 'N/A'}]`);
    remember(chosen);
    return id;
  }

  async _requestOtpUrl() {
    const accountId = await this._resolveAccountId();
    const url = `${this.config.restBaseUrl}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`;
    logger.info(`[DerivBroker] POST ${url}`);
    const resp = await axios.post(url, {}, {
      headers: this._restHeaders(),
      timeout: this.config.connectionTimeout,
    });
    const data = resp.data?.data ?? resp.data;
    const wsUrl = data?.url;
    if (!wsUrl || !wsUrl.startsWith('ws')) {
      throw new Error('OTP response did not contain a WebSocket URL: ' + JSON.stringify(resp.data));
    }
    logger.info(`[DerivBroker] Received OTP WS URL: ${wsUrl.split('?')[0]}`);
    return wsUrl;
  }

  async connect() {
    if (this._connectPromise) {
      logger.info('[DerivBroker] connect() already in flight — joining existing promise.');
      return this._connectPromise;
    }
    this._connectPromise = this._doConnect();
    try {
      return await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
  }

  async _doConnect() {
    await Promise.all([this._connectPublic(), this._connectAuth()]);
    await this._loadSymbolsWithTimeout();
    if (!this._symbolsDiscovered) {
      logger.warn('[DerivBroker] Symbol discovery failed, using fallbacks.');
      this._useFallbackSymbols();
    }
    this._ready = true;
    this.emit('ready');
    this.emit('connected');

    await this._ensureBalanceLoaded();
    await this._subscribeDefaultSymbols();
    await this._reconcilePositions();
    await this._loadPendingOrders();

    // [LIVE-5] Re-subscribe every open contract from Deriv's portfolio and
    // repair any Trade documents that are missing from MongoDB.
    await this._resumeContractSubscriptions();
  }

  async _ensureBalanceLoaded(timeoutMs = this.config.balanceTimeout) {
    if (this._account && this._account.balance != null) return this._account;

    if (!this._accountReady) {
      this._accountReady = new Promise((resolve) => { this._accountReadyResolve = resolve; });
    }

    try {
      await this._sendAuthRequest({ balance: 1, subscribe: 1 });
    } catch (err) {
      logger.warn('[DerivBroker] Balance subscribe failed:', err.message);
    }

    await Promise.race([
      this._accountReady,
      sleep(timeoutMs).then(() => {
        logger.warn('[DerivBroker] Balance load timeout — proceeding without account.');
      }),
    ]);

    return this._account;
  }

  // ---- PUBLIC SOCKET ----
  async _connectPublic() {
    if (this._publicState === STATE.READY || this._publicState === STATE.CONNECTED) return;
    if (this._publicConnectionPromise) return this._publicConnectionPromise;
    this._publicConnectionPromise = this._doConnectPublic();
    try { await this._publicConnectionPromise; } finally { this._publicConnectionPromise = null; }
  }

  _doConnectPublic() {
    return new Promise((resolve, reject) => {
      if (this._publicReconnectTimer) { clearTimeout(this._publicReconnectTimer); this._publicReconnectTimer = null; }
      if (this._publicState === STATE.FATAL) return reject(new Error('Public WS FATAL'));
      if (this._publicSocket?.readyState === WebSocket.OPEN) return resolve();

      this._publicState = STATE.CONNECTING;
      this._closePublicSocket();
      logger.info(`[DerivBroker] Connecting public WS: ${this.config.publicWsUrl}`);

      try {
        this._publicSocket = new WebSocket(this.config.publicWsUrl);
        const socket = this._publicSocket;
        const timer = setTimeout(() => {
          if (this._publicState !== STATE.CONNECTED) {
            socket.terminate(); this._publicState = STATE.FAILED;
            reject(new Error('Public WS connection timeout'));
          }
        }, this.config.connectionTimeout);

        socket.on('open', () => {
          clearTimeout(timer);
          logger.info('[DerivBroker] Public WS connected.');
          this._publicState = STATE.CONNECTED;
          this._startPublicHeartbeat();
          this._flushPublicQueue();
          this.streaming.restoreSubscriptions().catch(() => {});
          this.emit('publicReady');
          resolve();
        });
        socket.on('message', (d) => this._handlePublicMessage(d));
        socket.on('error', (e) => logger.error('[DerivBroker] Public WS error:', e.message));
        socket.on('close', (code) => {
          clearTimeout(timer);
          logger.info(`[DerivBroker] Public WS closed. Code: ${code}`);
          this._publicState = STATE.DISCONNECTED;
          this._stopPublicHeartbeat();
          this._publicReconnectTimer = setTimeout(() => {
            this._connectPublic().catch(() => {});
          }, this._getReconnectDelay(0));
        });
      } catch (err) { this._publicState = STATE.FAILED; reject(err); }
    });
  }

  _startPublicHeartbeat() {
    this._stopPublicHeartbeat();
    this._publicLastPong = Date.now();
    this._publicHeartbeatInterval = setInterval(() => {
      if (this._publicState === STATE.CONNECTED || this._publicState === STATE.READY) this._sendPublicRaw({ ping: 1 });
    }, 30000);
    this._publicHeartbeatTimeout = setInterval(() => {
      if (Date.now() - this._publicLastPong > this.config.heartbeatTimeout) {
        logger.warn('[DerivBroker] Public WS heartbeat timeout');
        this._closePublicSocket();
        this._connectPublic().catch(() => {});
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
    for (const [id, p] of this._publicPendingRequests) {
      clearTimeout(p.timeout); p.reject?.(new Error('Public closed'));
      this._publicPendingRequests.delete(id);
    }
    if (this._publicState !== STATE.DISCONNECTED && this._publicState !== STATE.FATAL)
      this._publicState = STATE.DISCONNECTED;
  }
  _sendPublicRaw(payload) {
    if (!this._publicSocket || this._publicSocket.readyState !== WebSocket.OPEN) {
      if (this._publicMessageQueue.length < this.config.maxQueueSize)
        this._publicMessageQueue.push({ payload, timestamp: Date.now() });
      return;
    }
    try {
      const important = payload.active_symbols || payload.ticks || payload.ohlc;
      if (important) logger.info(`[Out Public] ${payload.req_id || '-'} →`, JSON.stringify(redactSensitive(payload)));
      this._publicSocket.send(JSON.stringify(payload));
    } catch (e) {
      if (this._publicMessageQueue.length < this.config.maxQueueSize)
        this._publicMessageQueue.push({ payload, timestamp: Date.now() });
    }
  }
  _flushPublicQueue() {
    while (this._publicMessageQueue.length > 0)
      this._sendPublicRaw(this._publicMessageQueue.shift().payload);
  }
  async _sendPublicRequest(payload, timeoutMs = 15000, signal = null) {
    await this._rateLimiter.acquire();
    if (this._publicState !== STATE.CONNECTED && this._publicState !== STATE.READY) await this._connectPublic();
    if (!this._publicSocket || this._publicSocket.readyState !== WebSocket.OPEN) throw new Error('Public WS not open');
    let lastErr = null;
    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        if (signal?.aborted) throw new Error('Request cancelled');
        return await this._sendPublicRawRequest(payload, timeoutMs, signal);
      } catch (err) {
        lastErr = err;
        if (attempt < this.config.maxRetries) {
          await sleep(this._getReconnectDelay(attempt));
          if (this._publicState !== STATE.CONNECTED) await this._connectPublic();
        }
      }
    }
    throw lastErr;
  }
  _sendPublicRawRequest(payload, timeoutMs = 15000, signal = null) {
    return new Promise((resolve, reject) => {
      const reqId = generateRequestId();
      const msg = { ...payload, req_id: reqId };
      const timeout = setTimeout(() => {
        if (this._publicPendingRequests.has(reqId)) {
          this._publicPendingRequests.delete(reqId);
          reject(new Error(`Public request timeout (${timeoutMs}ms)`));
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
      this._publicPendingRequests.set(reqId, { resolve, reject, timeout, sentAt: Date.now(), cancel: onCancel, signal });
      this._sendPublicRaw(msg);
    });
  }
  _handlePublicMessage(rawData) {
    try {
      const msg = JSON.parse(rawData);
      let handled = false;
      if (msg.pong) { this._publicLastPong = Date.now(); handled = true; }
      if (msg.error) logger.error('[In Public] API Error:', JSON.stringify(msg.error));
      if (msg.req_id && this._publicPendingRequests.has(msg.req_id)) {
        const p = this._publicPendingRequests.get(msg.req_id);
        clearTimeout(p.timeout);
        this._publicPendingRequests.delete(msg.req_id);
        this.metrics.totalLatency += Date.now() - p.sentAt;
        this.metrics.latencyCount++;
        if (msg.error) { this.metrics.requestsFailed++; p.reject(new Error(`Deriv API error: ${msg.error.code}`)); }
        else { this.metrics.requestsSent++; p.resolve(msg); }
        handled = true;
      }
      if (msg.msg_type === 'tick' && msg.tick) {
        const tick = msg.tick;
        const bid = tick.bid ? parseFloat(tick.bid) : null;
        const ask = tick.ask ? parseFloat(tick.ask) : null;
        const time = tick.epoch ? tick.epoch * 1000 : Date.now();
        if (bid !== null && ask !== null) {
          priceBuffer.update(tick.symbol, bid, ask, time);
          Price.upsertPrice(tick.symbol, bid, ask, time, 'deriv').catch(() => {});
          this.emit('tick', { symbol: tick.symbol, bid, ask, time });
        }
        this.streaming.handleTick(tick);
        handled = true;
      }
      if (msg.active_symbols !== undefined) handled = true;
      if (!handled) logger.debug('[In Public] Unhandled:', JSON.stringify(redactSensitive(msg)));
    } catch (e) { logger.error('[In Public] Parse error:', e.message); }
  }
  async _ensurePublicReady() {
    if (this._publicState === STATE.CONNECTED || this._publicState === STATE.READY) return;
    await this._connectPublic();
    await sleep(200);
  }

  // ---- AUTH SOCKET (OTP URL) ----
  async _connectAuth() {
    if (this._authState === STATE.READY) return;
    if (this._authConnectionPromise) return this._authConnectionPromise;
    this._authConnectionPromise = this._doConnectAuth();
    try { await this._authConnectionPromise; } finally { this._authConnectionPromise = null; }
  }
  async _doConnectAuth() {
    let wsUrl;
    try {
      wsUrl = await this._requestOtpUrl();
      this._authWsUrl = wsUrl;
    } catch (err) {
      logger.error('[DerivBroker] OTP request failed:', err.message);
      this._authState = STATE.FAILED;
      this._scheduleAuthReconnect();
      throw err;
    }

    return new Promise((resolve, reject) => {
      if (this._authReconnectTimer) { clearTimeout(this._authReconnectTimer); this._authReconnectTimer = null; }
      if (this._authState === STATE.FATAL) return reject(new Error('Auth WS FATAL'));
      if (this._authSocket?.readyState === WebSocket.OPEN) return resolve();

      this._authState = STATE.CONNECTING;
      this._closeAuthSocket();
      this._authState = STATE.CONNECTING;
      logger.info('[DerivBroker] Connecting Auth WS (OTP URL)...');

      try {
        this._authSocket = new WebSocket(wsUrl);
        const socket = this._authSocket;
        const timer = setTimeout(() => {
          if (this._authState !== STATE.CONNECTED) {
            socket.terminate(); this._authState = STATE.FAILED;
            reject(new Error('Auth WS connection timeout'));
          }
        }, this.config.connectionTimeout);

        socket.on('open', () => {
          clearTimeout(timer);
          logger.info('[DerivBroker] Auth WS connected (OTP-authenticated).');
          this._authState = STATE.READY;
          this._startAuthHeartbeat();
          this._flushAuthQueue();
          this.emit('authReady');
          resolve();

          // [LIVE-6] Re-subscribe on every auth WS open (initial connect AND
          // reconnect after network blip).
          this._restoreAuthSubscriptions().catch((err) => {
            logger.warn(`[DerivBroker] Auth-subscription restore failed: ${err.message}`);
          });
        });
        socket.on('message', (d) => this._handleAuthMessage(d));
        socket.on('error', (e) => logger.error('[DerivBroker] Auth WS error:', e.message));
        socket.on('close', (code) => {
          clearTimeout(timer);
          logger.info(`[DerivBroker] Auth WS closed. Code: ${code}`);
          this._authState = STATE.DISCONNECTED;
          this._stopAuthHeartbeat();
          this._scheduleAuthReconnect();
        });
      } catch (err) { this._authState = STATE.FAILED; this._scheduleAuthReconnect(); reject(err); }
    });
  }
  _scheduleAuthReconnect() {
    if (this._authReconnectTimer) clearTimeout(this._authReconnectTimer);
    this._authReconnectTimer = setTimeout(() => {
      this._connectAuth().catch(() => {});
    }, this._getReconnectDelay(0));
  }
  _startAuthHeartbeat() {
    this._stopAuthHeartbeat();
    this._authLastPong = Date.now();
    this._authHeartbeatInterval = setInterval(() => {
      if (this._authState === STATE.READY || this._authState === STATE.CONNECTED) this._sendAuthRaw({ ping: 1 });
    }, 30000);
    this._authHeartbeatTimeout = setInterval(() => {
      if (Date.now() - this._authLastPong > this.config.heartbeatTimeout) {
        logger.warn('[DerivBroker] Auth WS heartbeat timeout');
        this._closeAuthSocket();
        this._scheduleAuthReconnect();
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
    for (const [id, p] of this._authPendingRequests) {
      clearTimeout(p.timeout); p.reject?.(new Error('Auth closed'));
      this._authPendingRequests.delete(id);
    }
    // [LIVE-3] Subscriptions do not survive the socket. Forget local records
    // so the next auth open re-subscribes cleanly.
    this._contractSubscriptions.clear();
    if (this._authState !== STATE.DISCONNECTED && this._authState !== STATE.FATAL)
      this._authState = STATE.DISCONNECTED;
  }
  _sendAuthRaw(payload) {
    if (!this._authSocket || this._authSocket.readyState !== WebSocket.OPEN) {
      if (this._authMessageQueue.length < this.config.maxQueueSize)
        this._authMessageQueue.push({ payload, timestamp: Date.now() });
      return;
    }
    try {
      const important = payload.proposal || payload.buy || payload.sell || payload.portfolio
        || payload.balance || payload.proposal_open_contract;
      if (important) logger.info(`[Out Auth] ${payload.req_id || '-'} →`, JSON.stringify(redactSensitive(payload)));
      this._authSocket.send(JSON.stringify(payload));
    } catch (e) {
      if (this._authMessageQueue.length < this.config.maxQueueSize)
        this._authMessageQueue.push({ payload, timestamp: Date.now() });
    }
  }
  _flushAuthQueue() {
    while (this._authMessageQueue.length > 0)
      this._sendAuthRaw(this._authMessageQueue.shift().payload);
  }
  async _sendAuthRequest(payload, timeoutMs = 15000, signal = null) {
    await this._rateLimiter.acquire();
    if (this._authState !== STATE.READY) await this._connectAuth();
    if (!this._authSocket || this._authSocket.readyState !== WebSocket.OPEN) throw new Error('Auth WS not open');
    let lastErr = null;
    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        if (signal?.aborted) throw new Error('Request cancelled');
        return await this._sendAuthRawRequest(payload, timeoutMs, signal);
      } catch (err) {
        lastErr = err;
        if (attempt < this.config.maxRetries) {
          await sleep(this._getReconnectDelay(attempt));
          if (this._authState !== STATE.READY) await this._connectAuth();
        }
      }
    }
    throw lastErr;
  }
  _sendAuthRawRequest(payload, timeoutMs = 15000, signal = null) {
    return new Promise((resolve, reject) => {
      const reqId = generateRequestId();
      const msg = { ...payload, req_id: reqId };
      const timeout = setTimeout(() => {
        if (this._authPendingRequests.has(reqId)) {
          this._authPendingRequests.delete(reqId);
          reject(new Error(`Auth request timeout (${timeoutMs}ms)`));
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
      this._authPendingRequests.set(reqId, { resolve, reject, timeout, sentAt: Date.now(), cancel: onCancel, signal });
      this._sendAuthRaw(msg);
    });
  }
  _handleAuthMessage(rawData) {
    try {
      const msg = JSON.parse(rawData);
      let handled = false;
      if (msg.pong) { this._authLastPong = Date.now(); handled = true; }
      if (msg.error) logger.error('[In Auth] API Error:', JSON.stringify(msg.error));
      if (msg.req_id && this._authPendingRequests.has(msg.req_id)) {
        const p = this._authPendingRequests.get(msg.req_id);
        clearTimeout(p.timeout);
        this._authPendingRequests.delete(msg.req_id);
        this.metrics.totalLatency += Date.now() - p.sentAt;
        this.metrics.latencyCount++;
        if (msg.error) { this.metrics.requestsFailed++; p.reject(new Error(`Deriv API error: ${msg.error.code} - ${msg.error.message}`)); }
        else { this.metrics.requestsSent++; p.resolve(msg); }
        handled = true;
      }
      if (msg.portfolio) {
        const contracts = msg.portfolio.contracts || [];
        this._openPositions = contracts
          .filter(c => c.status && ['open', 'active'].includes(c.status.toLowerCase()))
          .map(c => this._normalizeContract(c));
        this.emit('_portfolioUpdated', this._openPositions);
        this.emit('positions', this._openPositions);
        handled = true;
      }

      // [LIVE-2] Per-contract live updates.
      if (msg.proposal_open_contract) {
        this._handleContractUpdate(msg.proposal_open_contract).catch((err) => {
          logger.warn(`[DerivBroker] contract update handling failed: ${err.message}`);
        });
        handled = true;
      }

      // [FIX 4] Balance — store, remember currency, resolve the deferred.
      if (msg.balance) {
        const b = msg.balance;
        this._account = {
          loginid: b.loginid || this._account?.loginid,
          account_id: this._account?.account_id,
          balance: b.balance,
          currency: b.currency || this._account?.currency || this.accountCurrency || 'USD',
          account_type: this._account?.account_type || this.config.accountType,
        };
        if (b.currency) this.accountCurrency = b.currency;
        logger.info(
          `[DerivBroker] Balance update: ${b.balance} ${b.currency}` +
          (b.loginid ? ` (${b.loginid})` : '')
        );
        if (this._accountReadyResolve) {
          this._accountReadyResolve(this._account);
          this._accountReadyResolve = null;
        }
        this.emit('accountUpdate', this._account);
        handled = true;
      }

      if (msg.buy || msg.sell || msg.proposal) handled = true;
      if (!handled) logger.debug('[In Auth] Unhandled:', JSON.stringify(redactSensitive(msg)));
    } catch (e) { logger.error('[In Auth] Parse error:', e.message); }
  }

  async _ensureAuthReady() {
    if (this._authState === STATE.READY) return;
    await this._connectAuth();
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Auth ready timeout')), this.config.readinessTimeout);
      this.once('authReady', () => { clearTimeout(t); resolve(); });
    });
  }

  // ============================================================
  // [LIVE-3..7] CONTRACT MONITORING
  // ============================================================
  async _restoreAuthSubscriptions() {
    // Balance first
    if (!this._account || this._account.balance == null) {
      this._accountReady = new Promise((resolve) => { this._accountReadyResolve = resolve; });
    }
    try {
      await this._sendAuthRequest({ balance: 1, subscribe: 1 });
      logger.info('[DerivBroker] Balance subscription restored.');
    } catch (err) {
      logger.warn(`[DerivBroker] Balance restore failed: ${err.message}`);
    }
    // Then every open contract
    await this._resumeContractSubscriptions();
  }

  // [LIVE-5] Subscribe to each open contract from Deriv's portfolio AND
  // repair missing Trade docs.
  async _resumeContractSubscriptions() {
    let positions = [];
    try {
      positions = await this.getOpenTrades();
    } catch (err) {
      logger.warn(`[DerivBroker] Portfolio fetch during resume failed: ${err.message}`);
      return;
    }
    if (positions.length === 0) {
      logger.info('[DerivBroker] No open contracts to resume.');
      return;
    }
    logger.info(`[DerivBroker] Resuming ${positions.length} open contract(s).`);

    for (const pos of positions) {
      const contractId = String(pos.id);
      if (!contractId) continue;

      // Repair path: if the Trade doc is missing, create it from Deriv state.
      try {
        const existing = await Trade.findOne({ contractId: String(contractId) });
        if (!existing) {
          logger.warn(`[DerivBroker] Trade doc missing for ${contractId} — creating from portfolio.`);
          const side = pos.side === 'BUY' ? 'buy' : pos.side === 'SELL' ? 'sell' : 'buy';
          await Trade.create({
            contractId: String(contractId),
            instrument: pos.instrument,
            side,
            lotSize: pos.units || 0,
            openPrice: pos.entryPrice ?? pos.price ?? 0,
            status: 'OPEN',
            openTime: new Date(pos.openTime || Date.now()),
            product: 'deriv_multiplier',
            currentPrice: pos.currentPrice ?? pos.entryPrice ?? pos.price ?? null,
            floatingProfit: pos.unrealizedPL ?? 0,
            stake: pos.purchasePrice ?? null,
            purchasePrice: pos.purchasePrice ?? null,
          });
        }
      } catch (err) {
        if (err.code !== 11000) {
          logger.warn(`[DerivBroker] Trade repair failed for ${contractId}: ${err.message}`);
        }
      }

      await this._subscribeOpenContract(contractId).catch((err) => {
        logger.warn(`[DerivBroker] Resume subscribe failed for ${contractId}: ${err.message}`);
      });
    }
  }

  // [LIVE-3] Subscribe to proposal_open_contract for a single contract.
  async _subscribeOpenContract(contractId) {
    const key = String(contractId);
    if (!key) return;
    if (this._contractSubscriptions.has(key)) return;

    const resp = await this._sendAuthRequest(
      {
        proposal_open_contract: 1,
        contract_id: key,
        subscribe: 1,
      },
      this.config.contractSubscribeTimeout
    );

    const poc = resp.proposal_open_contract;
    if (!poc) {
      logger.warn(`[DerivBroker] proposal_open_contract returned nothing for ${key}`);
      return;
    }
    const subscriptionId = resp.subscription?.id;

    this._contractSubscriptions.set(key, {
      subscriptionId,
      subscribedAt: Date.now(),
    });
    this.metrics.contractSubscriptions = this._contractSubscriptions.size;
    logger.info(`[DerivBroker] Subscribed to contract ${key} (sub=${subscriptionId || 'n/a'})`);

    await this._handleContractUpdate(poc, true);
  }

  // [LIVE-3/4] Apply a proposal_open_contract snapshot.
  async _handleContractUpdate(poc, forcePersist = false) {
    const contractId = String(poc.contract_id ?? '');
    if (!contractId) return;

    const state = {
      contractId,
      symbol: poc.underlying,
      contractType: poc.contract_type,
      status: poc.status,
      currentSpot: poc.current_spot != null ? Number(poc.current_spot) : null,
      entrySpot: poc.entry_spot != null ? Number(poc.entry_spot) : null,
      currentProfit: poc.profit != null ? Number(poc.profit) : 0,
      profitPercentage: poc.profit_percentage != null ? Number(poc.profit_percentage) : null,
      buyPrice: poc.buy_price != null ? Number(poc.buy_price) : null,
      sellPrice: poc.sell_price != null ? Number(poc.sell_price) : null,
      exitTick: poc.exit_tick != null ? Number(poc.exit_tick) : null,
      payout: poc.payout != null ? Number(poc.payout) : null,
      isSold: !!poc.is_sold,
      isExpired: !!poc.is_expired,
      isValidToSell: !!poc.is_valid_to_sell,
      sellTime: poc.sell_time ? new Date(poc.sell_time * 1000) : null,
      entryTime: poc.entry_tick_time ? new Date(poc.entry_tick_time * 1000) : null,
      raw: poc,
      receivedAt: Date.now(),
    };

    this._contractStates.set(contractId, state);
    this.metrics.contractUpdates++;

    try {
      this.emit('contractUpdate', state);
    } catch (err) {
      logger.warn(`[DerivBroker] contractUpdate listener threw: ${err.message}`);
    }

    const finalStatuses = ['sold', 'won', 'lost', 'cancelled', 'expired'];
    const isFinal =
      state.isSold ||
      state.isExpired ||
      finalStatuses.includes(String(state.status || '').toLowerCase());

    await this._persistContractState(contractId, isFinal || forcePersist);

    if (isFinal) {
      logger.info(
        `[DerivBroker] Contract ${contractId} settled (status=${state.status}, profit=${state.currentProfit}).`
      );
      this._contractSubscriptions.delete(contractId);
      this.metrics.contractSubscriptions = this._contractSubscriptions.size;
    }
  }

  // [LIVE-4] Throttled write to Trade.
  async _persistContractState(contractId, force) {
    const key = String(contractId);
    const state = this._contractStates.get(key);
    if (!state) return;

    const now = Date.now();
    const last = this._contractPersistAt.get(key) || 0;
    const interval = this.config.contractPersistIntervalMs;

    if (!force && (now - last) < interval) {
      if (!this._contractPersistTimers.has(key)) {
        const delay = interval - (now - last);
        const timer = setTimeout(() => {
          this._contractPersistTimers.delete(key);
          this._persistContractState(key, true).catch(() => {});
        }, delay);
        if (typeof timer.unref === 'function') timer.unref();
        this._contractPersistTimers.set(key, timer);
      }
      return;
    }

    const pending = this._contractPersistTimers.get(key);
    if (pending) { clearTimeout(pending); this._contractPersistTimers.delete(key); }

    this._contractPersistAt.set(key, now);

    const finalStatuses = ['sold', 'won', 'lost', 'cancelled', 'expired'];
    const isFinal =
      state.isSold ||
      state.isExpired ||
      finalStatuses.includes(String(state.status || '').toLowerCase());

    const update = {
      currentPrice: state.currentSpot ?? state.entrySpot ?? null,
      floatingProfit: state.currentProfit ?? 0,
    };

    if (isFinal) {
      update.status = 'CLOSED';
      update.closePrice = state.exitTick ?? state.sellPrice ?? state.currentSpot ?? null;
      update.realizedProfit = state.currentProfit ?? 0;
      update.pnl = state.currentProfit ?? 0;
      update.closeTime = state.sellTime || new Date();
      update.floatingProfit = 0;
    }

    try {
      const res = await Trade.findOneAndUpdate(
        { contractId: String(key) },
        { $set: update },
        { new: false }
      );
      if (res) {
        this.metrics.contractUpdatesPersisted++;
      }
    } catch (err) {
      logger.warn(`[DerivBroker] Trade persist failed for ${key}: ${err.message}`);
    }
  }

  // ---- SYMBOLS ----
  async _loadSymbolsWithTimeout() {
    return Promise.race([
      this._loadSymbolsInternal(),
      sleep(this.config.symbolTimeout).then(() => { throw new Error('Symbol load timeout'); }),
    ]);
  }
  async _loadSymbolsInternal() {
    logger.info('[DerivBroker] Fetching active symbols...');
    let symbols = null;
    try {
      const resp = await this._sendPublicRequest({ active_symbols: 'brief' }, 10000);
      if (Array.isArray(resp.active_symbols) && resp.active_symbols.length > 0) {
        symbols = resp.active_symbols;
      } else {
        const resp2 = await this._sendPublicRequest({ active_symbols: 'full' }, 10000);
        if (Array.isArray(resp2.active_symbols) && resp2.active_symbols.length > 0) symbols = resp2.active_symbols;
      }
    } catch (err) { logger.warn('[DerivBroker] Symbol request failed:', err.message); }

    if (symbols?.length) {
      this._buildSymbolMaps(symbols);
      this._symbolsDiscovered = true;
      this._symbolsLoaded = true;
      logger.info(`[DerivBroker] ${Object.keys(this.symbolMap).length} forex pairs mapped.`);
    } else {
      throw new Error('No symbols received');
    }
  }
  _useFallbackSymbols() {
    this.symbolMap = { ...FALLBACK_SYMBOLS };
    this.reverseMap = {};
    this.spreadMap = {};
    for (const [k, v] of Object.entries(FALLBACK_SYMBOLS)) {
      this.reverseMap[v] = k;
      this.spreadMap[v] = 0.0001;
    }
    this._symbolsDiscovered = true;
    this._symbolsLoaded = true;
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
    this.symbolManager.setSymbols(symbols);
    return count;
  }
  async _subscribeDefaultSymbols() {
    const valid = new Set(Object.values(this.symbolMap));
    const toSub = WATCHLIST.filter(s => valid.has(s));
    const list = toSub.length > 0 ? toSub : Object.values(FALLBACK_SYMBOLS).slice(0, 4);
    for (const sym of list) {
      try { await this.streaming.subscribe('ticks', sym, () => {}); } catch (_) {}
    }
  }

  // ---------- ORDER BOOKKEEPING ----------
  async _loadPendingOrders() {
    try {
      const pending = await Order.find({ status: { $in: ['PENDING', 'ACCEPTED', 'EXECUTING'] } });
      for (const o of pending) {
        this._orders.set(o.clientOrderId, o);
        if (o.contractId) this._orderMap.set(String(o.contractId), o.clientOrderId);
      }
      logger.info(`[DerivBroker] Loaded ${pending.length} pending orders.`);
    } catch (_) {}
  }
  async _updateOrderStatus(clientOrderId, status, contractId = null, txData = null) {
    const update = { status, updatedAt: new Date() };
    if (contractId) update.contractId = String(contractId);
    if (status === ORDER_STATUS.FILLED) update.filledAt = new Date();
    if (status === ORDER_STATUS.REJECTED) { update.rejectedAt = new Date(); update.rejectReason = txData?.error?.message || 'Unknown'; }
    await Order.findOneAndUpdate({ clientOrderId }, update, { upsert: true, new: true });
    const o = this._orders.get(clientOrderId);
    if (o) { Object.assign(o, update); if (contractId) this._orderMap.set(String(contractId), clientOrderId); }
    this.metrics.ordersPlaced++;
    if (status === ORDER_STATUS.FILLED) this.metrics.ordersFilled++;
    if (status === ORDER_STATUS.REJECTED) this.metrics.ordersRejected++;
    this.emit('orderUpdate', { clientOrderId, status, contractId });
  }
  async _reconcilePositions() {
    try {
      const positions = await this.getOpenTrades();
      const dbOrders = await Order.find({ status: ORDER_STATUS.FILLED });
      const dbMap = new Map();
      for (const ord of dbOrders) if (ord.contractId) dbMap.set(String(ord.contractId), ord);
      for (const pos of positions) {
        if (!dbMap.has(String(pos.id))) {
          const newOrder = new Order({
            clientOrderId: generateClientOrderId(),
            instrument: pos.instrument,
            side: pos.side,
            units: pos.units,
            entryPrice: pos.entryPrice ?? pos.price ?? 0,
            purchasePrice: pos.purchasePrice ?? null,
            status: ORDER_STATUS.FILLED,
            contractId: String(pos.id),
            filledAt: new Date(pos.openTime || Date.now()),
          });
          await newOrder.save();
          this._orders.set(newOrder.clientOrderId, newOrder);
          this._orderMap.set(String(pos.id), newOrder.clientOrderId);
        }
      }
      const openIds = new Set(positions.map(p => String(p.id)));
      for (const [cid, coid] of this._orderMap) {
        if (!openIds.has(String(cid))) {
          await this._updateOrderStatus(coid, ORDER_STATUS.CLOSED);
          this._orderMap.delete(cid);
        }
      }
      this.emit('positions', positions);
    } catch (err) { logger.error('[Reconcile] Failed:', err.message); }
  }

  // [CHANGE-5] Normalize a Deriv contract / portfolio position.
  _normalizeContract(c) {
    const contractId = String(c.contract_id ?? c.id ?? '');
    const derivSymbol = c.underlying_symbol ?? c.underlying ?? c.symbol;

    const entrySpotRaw = c.entry_spot ?? c.entry_tick ?? c.entry_price;
    const entrySpotNum = Number(entrySpotRaw);
    const entryPrice = Number.isFinite(entrySpotNum) && entrySpotNum > 0 ? entrySpotNum : null;

    const purchasePriceRaw = c.buy_price ?? c.purchase_price;
    const purchasePriceNum = Number(purchasePriceRaw);
    const purchasePrice = Number.isFinite(purchasePriceNum) && purchasePriceNum > 0
      ? purchasePriceNum
      : null;

    const currentSpotRaw = c.current_spot ?? c.current_tick;
    const currentSpotNum = Number(currentSpotRaw);
    const currentPrice = Number.isFinite(currentSpotNum) && currentSpotNum > 0
      ? currentSpotNum
      : (entryPrice ?? 0);

    let side = 'UNKNOWN';
    if (c.direction === 'up' || /UP/i.test(c.contract_type || '')) side = 'BUY';
    else if (c.direction === 'down' || /DOWN/i.test(c.contract_type || '')) side = 'SELL';

    const startRaw = c.start_time ?? c.purchase_time ?? c.date_start;
    let openTime = Date.now();
    if (startRaw != null) {
      if (typeof startRaw === 'number') openTime = startRaw > 1e12 ? startRaw : startRaw * 1000;
      else {
        const parsed = new Date(startRaw).getTime();
        if (Number.isFinite(parsed)) openTime = parsed;
      }
    }

    return {
      id: contractId,
      contractId,
      instrument: fromDerivSymbol(derivSymbol, this.reverseMap) || 'UNKNOWN',
      side,
      purchasePrice,
      entryPrice,
      price: entryPrice ?? 0,
      units: c.amount ?? 0,
      unrealizedPL: Number(c.profit ?? c.profit_loss ?? 0),
      currentPrice,
      stopLoss: Number(c.stop_loss ?? 0),
      takeProfit: Number(c.take_profit ?? 0),
      openTime,
      status: 'OPEN',
      raw: c,
    };
  }

  // ============================================================
  // PUBLIC API
  // ============================================================
  async getAccount() {
    await this._ensureAuthReady();
    if (!this._account || this._account.balance == null) {
      try { await this._ensureBalanceLoaded(); } catch (_) {}
    }
    if (!this._account || this._account.balance == null) {
      return this._getDefaultAccount();
    }
    const acc = this._account;
    const bal = Number(acc.balance) || 0;
    return {
      id: acc.loginid || acc.account_id || 'N/A',
      balance: String(bal),
      currency: acc.currency || 'USD',
      equity: String(bal),
      marginUsed: '0',
      marginAvailable: String(bal),
      accountType: acc.account_type || this.config.accountType,
      createdTime: new Date().toISOString(),
    };
  }
  _getDefaultAccount() {
    return {
      id: 'UNKNOWN',
      balance: '0',
      currency: 'USD',
      equity: '0',
      marginUsed: '0',
      marginAvailable: '0',
      accountType: this.config.accountType,
      createdTime: new Date().toISOString(),
      stale: true,
    };
  }
  async getPrices(instruments) {
    await this._ensurePublicReady();
    const results = [];
    for (const pair of instruments) {
      const symbol = toDerivSymbol(pair, this.symbolMap);
      if (!symbol) continue;
      const cached = this.streaming.getPrice(symbol);
      if (cached) {
        results.push({ instrument: pair,
          bids: [{ price: cached.bid ? cached.bid.toFixed(5) : (cached.mid - 0.00005).toFixed(5) }],
          asks: [{ price: cached.ask ? cached.ask.toFixed(5) : (cached.mid + 0.00005).toFixed(5) }],
          time: cached.time });
        continue;
      }
      try {
        const resp = await this._sendPublicRequest({ ticks: symbol });
        const t = resp.tick;
        const bid = t.bid !== undefined ? parseFloat(t.bid) : parseFloat(t.quote || t.price) - 0.00005;
        const ask = t.ask !== undefined ? parseFloat(t.ask) : parseFloat(t.quote || t.price) + 0.00005;
        results.push({ instrument: pair, bids: [{ price: bid.toFixed(5) }], asks: [{ price: ask.toFixed(5) }], time: t.epoch || Date.now() });
      } catch (_) {}
    }
    return results;
  }
  async getCandles(instrument, count = 100, granularity = 'M5') {
    await this._ensurePublicReady();
    const symbol = toDerivSymbol(instrument, this.symbolMap);
    if (!symbol) throw new Error(`Unknown instrument: ${instrument}`);
    const intervalMap = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D: 86400 };
    const sec = intervalMap[granularity] || 300;
    const end = Math.floor(Date.now() / 1000);
    const start = end - (count * sec + 10);
    const resp = await this._sendPublicRequest({ ohlc: symbol, interval: sec, start, end });
    const candles = (resp.candles || []).slice(-count);
    return candles.map(c => ({ mid: { o: c.open, h: c.high, l: c.low, c: c.close }, time: c.epoch, complete: true }));
  }
  async getOpenTrades() {
    await this._ensureAuthReady();
    try {
      const resp = await this._sendAuthRequest({ portfolio: 1 });
      const contracts = (resp.portfolio?.contracts) || [];
      return contracts
        .filter(c => c.status && ['open', 'active'].includes(c.status.toLowerCase()))
        .map(c => this._normalizeContract(c));
    } catch (err) { logger.error('[DerivBroker] Portfolio fetch failed:', err.message); return []; }
  }
  async getPositions() { return this.getOpenTrades(); }

  // ============================================================
  // PLACE MARKET ORDER
  // ============================================================
  async placeMarketOrder(instrument, units, stopLoss = null, takeProfit = null, options = {}) {
    await this._ensureAuthReady();
    if (!this._account || this._account.balance == null) {
      try { await this._ensureBalanceLoaded(); } catch (_) {}
    }
    const opts = (options && typeof options === 'object') ? options : {};

    const amount = Math.abs(Number(units));
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Order units must be positive.');
    const direction = units > 0 ? 'MULTUP' : 'MULTDOWN';
    const symbol = toDerivSymbol(instrument, this.symbolMap);
    if (!symbol) throw new Error(`Unknown instrument: ${instrument}`);

    // [CHANGE-8] Validate multiplier BEFORE any purchase request.
    let finalMultiplier;
    if (opts.multiplier == null) {
      finalMultiplier = DEFAULT_MULTIPLIER;
    } else {
      finalMultiplier = Math.floor(Number(opts.multiplier));
      if (!Number.isFinite(finalMultiplier) || !ACCEPTED_MULTIPLIERS.includes(finalMultiplier)) {
        throw new Error(
          `Invalid multiplier ${opts.multiplier}. Accepted values: ${ACCEPTED_MULTIPLIERS.join(', ')}`
        );
      }
    }

    // [FIX 5 / FIX 7] Deriv's multiplier workflow: no `duration` on the
    // proposal; `duration_unit: 's'` and `subscribe: 1` retained.
    const proposalPayload = {
      proposal: 1,
      amount,
      basis: 'stake',
      contract_type: direction,
      currency: this.accountCurrency || 'USD',
      underlying_symbol: symbol,
      multiplier: finalMultiplier,
      duration_unit: 's',
      subscribe: 1,
    };

    if (stopLoss != null || takeProfit != null) {
      proposalPayload.limit_order = {};
      if (stopLoss != null) proposalPayload.limit_order.stop_loss = Number(stopLoss);
      if (takeProfit != null) proposalPayload.limit_order.take_profit = Number(takeProfit);
    }

    logger.info(`[DerivBroker] Proposal: ${JSON.stringify(redactSensitive(proposalPayload))}`);

    const proposalResp = await this._sendAuthRequest(proposalPayload);
    const proposal = proposalResp.proposal;
    if (!proposal?.id) throw new Error(`Proposal missing: ${JSON.stringify(proposalResp)}`);

    const askPrice = Number(proposal.ask_price);
    if (!Number.isFinite(askPrice) || askPrice <= 0) throw new Error(`Invalid ask price: ${proposal.ask_price}`);

    const buyResp = await this._sendAuthRequest({ buy: proposal.id, price: askPrice });
    const buy = buyResp.buy;

    // [CHANGE-1A] Explicit purchase-vs-entry extraction.
    const contractId = String(buy?.contract_id ?? '');
    const purchasePrice = Number(buy?.buy_price ?? buy?.price);
    const entrySpot = Number(buy?.entry_spot ?? proposal.spot);

    if (!contractId || contractId === 'undefined') {
      throw new Error('Deriv returned no contract ID: ' + JSON.stringify(buyResp));
    }
    if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) {
      throw new Error(`Invalid purchase price: ${JSON.stringify(buyResp)}`);
    }

    // [LIVE-1] Subscribe to proposal_open_contract. Failure must not fail
    // the trade — the buy is already done. Startup recovery retries.
    this._subscribeOpenContract(contractId).catch((err) => {
      logger.warn(`[DerivBroker] Initial contract subscription failed for ${contractId}: ${err.message}`);
    });

    this.getOpenTrades()
      .then(p => this.emit('positions', p))
      .catch(() => {});

    return {
      contractId,
      tradeID: contractId,
      ticket: contractId,
      purchasePrice,
      entryPrice: Number.isFinite(entrySpot) && entrySpot > 0 ? entrySpot : null,
      price: Number.isFinite(entrySpot) && entrySpot > 0 ? entrySpot : null,
      raw: buyResp,
    };
  }

  // ---------- Close / modify ----------
  async closeTrade(tradeId) {
    await this._ensureAuthReady();
    if (!tradeId) throw new Error('tradeId required');
    const resp = await this._sendAuthRequest({ sell: tradeId, price: 0 });
    if (!resp.sell) throw new Error('Close failed: ' + JSON.stringify(resp));

    // Update Order status
    let coid = this._orderMap.get(String(tradeId));
    if (!coid) {
      try {
        const ord = await Order.findOne({ contractId: String(tradeId) });
        if (ord) {
          coid = ord.clientOrderId;
          this._orderMap.set(String(tradeId), coid);
          this._orders.set(coid, ord);
        }
      } catch (err) {
        logger.warn(`[DerivBroker] closeTrade lookup failed for ${tradeId}: ${err.message}`);
      }
    }
    if (coid) {
      await this._updateOrderStatus(coid, ORDER_STATUS.CLOSED);
      this._orderMap.delete(String(tradeId));
    }

    // [LIVE-7] Persist final Trade state immediately from the sell response.
    try {
      const soldFor = resp.sell.sold_for != null ? Number(resp.sell.sold_for) : null;
      const balanceAfter = resp.sell.balance_after != null ? Number(resp.sell.balance_after) : null;
      const buyPrice = resp.sell.buy_price != null ? Number(resp.sell.buy_price) : null;
      const profit = (soldFor != null && buyPrice != null) ? (soldFor - buyPrice) : null;

      const update = { status: 'CLOSED', closeTime: new Date() };
      if (soldFor != null) update.closePrice = soldFor;
      if (profit != null) {
        update.realizedProfit = profit;
        update.pnl = profit;
      }
      update.floatingProfit = 0;

      await Trade.findOneAndUpdate(
        { contractId: String(tradeId) },
        { $set: update }
      );
      if (balanceAfter != null && this._account) {
        this._account.balance = balanceAfter;
        this.emit('accountUpdate', this._account);
      }
    } catch (err) {
      logger.warn(`[DerivBroker] Post-close Trade update failed for ${tradeId}: ${err.message}`);
    }

    this.getOpenTrades().then(p => this.emit('positions', p)).catch(() => {});
    return resp;
  }

  async modifySLTP(tradeId, stopLoss, takeProfit) {
    await this._ensureAuthReady();
    const positions = await this.getOpenTrades();
    const pos = positions.find(p => p.id === String(tradeId));
    if (!pos) throw new Error(`Trade ${tradeId} not open`);
    await this.closeTrade(tradeId);
    const units = pos.units * (pos.side === 'BUY' ? 1 : -1);
    const r = await this.placeMarketOrder(pos.instrument, units, stopLoss, takeProfit);
    return { message: 'Reopened with new SL/TP', newTradeId: r.tradeID, price: r.price };
  }
  async partialClose() { throw new Error('Partial close not supported'); }
  async placeLimitOrder(instrument, units, price, sl = null, tp = null) {
    logger.warn('[DerivBroker] Limit orders not supported, using market order');
    return this.placeMarketOrder(instrument, units, sl, tp);
  }

  // ---------- Health ----------
  isMarketDataConnected() { return [STATE.CONNECTED, STATE.READY].includes(this._publicState); }
  isTradingReady() { return this._authState === STATE.READY; }
  isConnected() { return this.isMarketDataConnected() && this.isTradingReady(); }
  isAuthorized() { return this.isTradingReady(); }
  getHealth() {
    return {
      publicState: this._publicState, authState: this._authState,
      marketDataConnected: this.isMarketDataConnected(),
      tradingReady: this.isTradingReady(), ready: this._ready,
      circuitBreaker: this._cbState, reconnectCount: this.metrics.reconnections,
      queueSize: this._publicMessageQueue.length + this._authMessageQueue.length,
      pendingRequests: this._publicPendingRequests.size + this._authPendingRequests.size,
      lastHeartbeat: this.metrics.lastHeartbeat, lastPong: this.metrics.lastPong,
      averageLatency: this.metrics.latencyCount > 0 ? this.metrics.totalLatency / this.metrics.latencyCount : 0,
      orders: {
        placed: this.metrics.ordersPlaced, filled: this.metrics.ordersFilled, rejected: this.metrics.ordersRejected,
      },
      contractMonitoring: {
        activeSubscriptions: this._contractSubscriptions.size,
        trackedContracts: this._contractStates.size,
        totalUpdates: this.metrics.contractUpdates,
        persistedUpdates: this.metrics.contractUpdatesPersisted,
      },
      subscriptions: this.streaming._subscriptions.size,
      pendingSubscriptions: this.streaming._pendingSubscriptions.size,
      openPositions: this._openPositions.length,
      accountType: this.config.accountType,
      accountLoaded: !!(this._account && this._account.balance != null),
      acceptedMultipliers: ACCEPTED_MULTIPLIERS,
    };
  }

  getContractState(contractId) {
    return this._contractStates.get(String(contractId)) || null;
  }
  getAllContractStates() {
    return Array.from(this._contractStates.values());
  }

  async killSwitch() {
    const positions = await this.getOpenTrades();
    for (const p of positions) { try { await this.closeTrade(p.id); } catch (_) {} }
    await this.disconnect();
  }
  async disconnect() {
    this._closePublicSocket();
    this._closeAuthSocket();
    this._publicState = STATE.DISCONNECTED;
    this._authState = STATE.DISCONNECTED;
    this._ready = false;
    this._connectPromise = null;
    for (const [, timer] of this._contractPersistTimers) clearTimeout(timer);
    this._contractPersistTimers.clear();
  }
  _getReconnectDelay(attempt) {
    const base = this.config.reconnectBaseDelay;
    const max = this.config.maxReconnectDelay;
    const delay = Math.min(base * Math.pow(2, attempt), max);
    return Math.round(delay * (0.8 + 0.4 * Math.random()));
  }
}

// ============================================================
// EXPORT
// ============================================================
const brokerInstance = new DerivBroker({
  apiToken: process.env.DERIV_API_TOKEN,
  appId: process.env.DERIV_APP_ID,
  restBaseUrl: process.env.DERIV_REST_BASE_URL || 'https://api.derivws.com',
  publicWsUrl: process.env.DERIV_PUBLIC_WS_URL || 'wss://api.derivws.com/trading/v1/options/ws/public',
  accountId: process.env.DERIV_ACCOUNT_ID || null,
  accountType: process.env.DERIV_ACCOUNT_TYPE || 'demo',
  connectionTimeout: parseInt(process.env.DERIV_CONNECTION_TIMEOUT) || 30000,
  reconnectBaseDelay: parseInt(process.env.DERIV_RECONNECT_DELAY) || 2000,
  maxReconnectDelay: parseInt(process.env.DERIV_MAX_RECONNECT_DELAY) || 30000,
  maxRetries: parseInt(process.env.DERIV_MAX_RETRIES) || 3,
  maxQueueSize: parseInt(process.env.DERIV_MAX_QUEUE_SIZE) || 100,
  rateLimit: parseFloat(process.env.DERIV_RATE_LIMIT) || 5,
  rateCapacity: parseFloat(process.env.DERIV_RATE_CAPACITY) || 10,
  readinessTimeout: parseInt(process.env.DERIV_READINESS_TIMEOUT) || 30000,
  symbolTimeout: parseInt(process.env.DERIV_SYMBOL_TIMEOUT) || 30000,
  heartbeatTimeout: parseInt(process.env.DERIV_HEARTBEAT_TIMEOUT) || 60000,
  balanceTimeout: parseInt(process.env.DERIV_BALANCE_TIMEOUT) || 10000,
  contractPersistIntervalMs: parseInt(process.env.DERIV_CONTRACT_PERSIST_INTERVAL_MS) || 3000,
  contractSubscribeTimeout: parseInt(process.env.DERIV_CONTRACT_SUBSCRIBE_TIMEOUT) || 15000,
});

module.exports = brokerInstance;
module.exports.DerivBroker = DerivBroker;
