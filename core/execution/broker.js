// core/execution/broker.js – Stable Dual-WebSocket Deriv Broker
//
// [FIX-1] Emits trade.closed when a contract settles.
// [FIX-2] _reconcileTradeStatus includes deriv_digital + idempotent emit.
// [FIX-3] Multipliers [200, 400, 600, 800].
// [FIX-4] placeMarketOrder: no duration_unit:'s' (InvalidExpiry).
// [FIX-5] Portfolio cache (3s TTL) + invalidation on buy/sell/close.
// [FIX-A] toDerivSymbol normalizes EURUSD ↔ EUR_USD.
// [FIX-B] Cancellable timers in _ensureBalanceLoaded / _loadSymbolsWithTimeout.
// [FIX-C] _ensureAuthReady re-checks _authState after _connectAuth.
// [FIX-D] Symbol maps seeded from FALLBACK_SYMBOLS + no-underscore aliases.
// [FIX-C1] placeMarketOrder: SL/TP price levels → currency amounts (2dp).
// [FIX-C2] Portfolio requests: in-flight dedupe + RateLimit cooldown.
// [FIX-H2] getCandles: removed adjust_start_time (M5 was returning 177/500).
// [FIX-M5] _verifyContractStatus: exponential backoff on 'unknown' (60s → 15min).
// [FILE-4.4] tick event includes mid. Synthetics in symbol map + watchlist.
// [FILE-4.1] getCandles uses ticks_history with style='candles'.
// [FIX-ICP] _sendAuthRequest clamps buy retries to 1; InvalidContractProposal
//           is permanent. Proposal IDs are single-use.
// [FIX-RECON-BUY] placeMarketOrder wraps buy with _reconcileOrphanBuy.
// [FIX-ORPHAN] Periodic _sweepOrphanContracts adopts live contracts with no Trade doc.
// [FIX-SWITCH] switchAccountType(newType) — demo ⇄ real. Guards on open positions,
//           rolls back on failure, emits 'accountSwitched'.

const WebSocket = require('ws');
const axios = require('axios');
const { EventEmitter } = require('events');
const { sleep } = require('../../shared/helpers');
const logger = require('../../infrastructure/logger') || console;
const Order = require('../../models/Order');
const Trade = require('../../models/Trade');
const priceBuffer = require('../../core/data/priceBuffer');
const Price = require('../../models/Price');
const Account = require('../../models/Account');
const eventBus = require('../../infrastructure/eventBus');

EventEmitter.defaultMaxListeners = 20;

const WATCHLIST = [
  'frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxAUDUSD',
  'R_100', 'R_75', 'R_50', 'R_25', 'R_10',
];

const STATE = {
  DISCONNECTED: 'DISCONNECTED', CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED', AUTHENTICATING: 'AUTHENTICATING',
  READY: 'READY', RECONNECTING: 'RECONNECTING',
  FAILED: 'FAILED', FATAL: 'FATAL',
};

const ORDER_STATUS = {
  PENDING: 'PENDING', ACCEPTED: 'ACCEPTED', EXECUTING: 'EXECUTING',
  FILLED: 'FILLED', REJECTED: 'REJECTED', CANCELLED: 'CANCELLED', CLOSED: 'CLOSED',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED', MODIFIED: 'MODIFIED', EXPIRED: 'EXPIRED',
};

const CB_STATE = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };
let _requestCounter = 0;

const ACCEPTED_MULTIPLIERS = [200, 400, 600, 800];
const DEFAULT_MULTIPLIER = ACCEPTED_MULTIPLIERS[0];

const RATE_LIMIT_COOLDOWN_MS = 5000;
const RATE_LIMIT_LOG_THROTTLE_MS = 5000;
const VERIFY_BACKOFF_BASE_MS = 60_000;
const VERIFY_BACKOFF_MAX_MS = 15 * 60_000;
const MIN_LIMIT_ORDER_AMOUNT = 0.01;
const RECONCILE_BUY_LOOKBACK_MS = 60_000;
const RECONCILE_BUY_GRACE_MS = 2000;

function generateRequestId() { return ++_requestCounter; }

function generateClientOrderId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `ord_${crypto.randomUUID()}`;
  return `ord_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

function toDerivSymbol(pair, symbolMap) {
  if (!pair) return null;
  const upper = pair.toUpperCase();
  if (symbolMap[upper]) return symbolMap[upper];
  if (upper.length === 6 && !upper.includes('_')) {
    const sep = upper.slice(0, 3) + '_' + upper.slice(3);
    if (symbolMap[sep]) return symbolMap[sep];
  }
  if (upper.includes('_')) {
    const noSep = upper.replace(/_/g, '');
    if (symbolMap[noSep]) return symbolMap[noSep];
  }
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
  'R_10': 'R_10', 'R_25': 'R_25', 'R_50': 'R_50', 'R_75': 'R_75', 'R_100': 'R_100',
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

function isPatToken(token) { return typeof token === 'string' && token.startsWith('pat_'); }

function isPermanentApiError(err) {
  if (!err || !err.message) return false;
  const msg = String(err.message);
  return (msg.includes('InputValidationFailed') || msg.includes('InvalidSymbol') ||
    msg.includes('ContractCreationFailure') || msg.includes('AuthorizationRequired') ||
    msg.includes('InvalidToken') || msg.includes('PermissionDenied') || msg.includes('InvalidExpiry') ||
    msg.includes('InvalidContractProposal'));
}

function isRateLimitError(err) {
  if (!err || !err.message) return false;
  return err.message.includes('RateLimit');
}
function isRateLimitErrorMsg(errObj) {
  if (!errObj) return false;
  if (errObj.code === 'RateLimit') return true;
  if (typeof errObj.message === 'string' && errObj.message.includes('rate limit')) return true;
  return false;
}

class RateLimiter {
  constructor(rate, capacity) { this.rate = rate; this.capacity = capacity; this.tokens = capacity; this.lastRefill = Date.now(); }
  async acquire() {
    while (true) {
      const now = Date.now(); const elapsed = (now - this.lastRefill) / 1000;
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
      this.lastRefill = now;
      if (this.tokens >= 1) { this.tokens--; return true; }
      await sleep(Math.ceil((1 - this.tokens) / this.rate * 1000));
    }
  }
}

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
        if (!subscriptionId) { logger.error(`[Streaming] No subscription ID for ${key}`); return; }
        this._subscriptions.set(key, { type, symbol, subscriptionId, callbacks: pending.callbacks });
        this._subscriptionIdMap.set(subscriptionId, key);
        logger.info(`[Streaming] Subscribed to ${key} (ID: ${subscriptionId})`);
      } catch (err) { logger.error(`[Streaming] Subscribe failed for ${key}:`, err.message); }
      finally { this._pendingSubscriptions.delete(key); }
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
    try { await this.broker._sendPublicRequest({ forget_all: 'ticks' }); } catch (_) {}
    for (const [key, sub] of this._subscriptions) {
      try {
        const response = await this.broker._sendPublicRequest({ [sub.type]: sub.symbol, subscribe: 1 });
        const newId = response.subscription?.id;
        if (newId) {
          this._subscriptionIdMap.delete(sub.subscriptionId);
          sub.subscriptionId = newId;
          this._subscriptionIdMap.set(newId, key);
        }
      } catch (_) {}
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

const BROKER_CAPABILITIES = {
  supportsTrailingStop: false, supportsHedging: false, supportsNetting: true,
  supportsPartialClose: false, supportsGuaranteedSL: false, supportsOCO: false,
  supportsMarketOrders: true, supportsLimitOrders: false, supportsStopOrders: false,
  supportsDemo: true, supportsLive: true,
  supportsClose: true, supportsModify: false, supportsCancel: false,
  supportedMarkets: ['Forex', 'Indices', 'Commodities', 'Cryptocurrencies'],
};

class DerivBroker extends EventEmitter {
  constructor(config = {}) {
    super();
    const appId = config.appId || process.env.DERIV_APP_ID || '1089';
    this.config = {
      apiToken: config.apiToken || process.env.DERIV_API_TOKEN,
      appId,
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
      heartbeatTimeout: parseInt(config.heartbeatTimeout || process.env.DERIV_HEARTBEAT_TIMEOUT || 120000),
      wsPingIntervalMs: parseInt(config.wsPingIntervalMs || process.env.DERIV_WS_PING_INTERVAL || 20000),
      balanceTimeout: parseInt(config.balanceTimeout || process.env.DERIV_BALANCE_TIMEOUT || 10000),
      contractPersistIntervalMs: parseInt(config.contractPersistIntervalMs || process.env.DERIV_CONTRACT_PERSIST_INTERVAL_MS || 3000),
      contractSubscribeTimeout: parseInt(config.contractSubscribeTimeout || process.env.DERIV_CONTRACT_SUBSCRIBE_TIMEOUT || 15000),
      tradeReconcileIntervalMs: parseInt(config.tradeReconcileIntervalMs || process.env.DERIV_TRADE_RECONCILE_INTERVAL || 30000),
      tradeReconcileMinAgeMs: parseInt(config.tradeReconcileMinAgeMs || process.env.DERIV_TRADE_RECONCILE_MIN_AGE || 60000),
      tradeReconcileMissesRequired: parseInt(config.tradeReconcileMissesRequired || process.env.DERIV_TRADE_RECONCILE_MISSES || 2),
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

    this._portfolioCache = { contracts: null, at: 0, ttl: 3000 };
    this._portfolioInflight = null;
    this._rateLimitUntil = 0;
    this._lastRateLimitLogAt = 0;

    this._cbState = CB_STATE.CLOSED;
    this._cbFailureCount = 0;
    this._cbOpenedAt = null;

    this._seedSymbolMaps();
    this._symbolsDiscovered = false;
    this._symbolsLoaded = false;

    this._orders = new Map();
    this._orderMap = new Map();
    this.accountCurrency = 'USD';

    this._contractSubscriptions = new Map();
    this._contractStates = new Map();
    this._contractPersistAt = new Map();
    this._contractPersistTimers = new Map();
    this._contractUpdateCounts = new Map();
    this._reconcileMissCounts = new Map();
    this._verifyUnknownCounts = new Map();
    this._closedEmitted = new Set();
    this._tradeReconcileTimer = null;
    this._lastOrphanSweepAt = null;

    this.metrics = {
      connectedSince: null, requestsSent: 0, requestsFailed: 0, reconnections: 0,
      totalLatency: 0, latencyCount: 0, heartbeatMisses: 0, lastHeartbeat: null,
      ordersPlaced: 0, ordersFilled: 0, ordersRejected: 0, lastPong: Date.now(),
      contractSubscriptions: 0, contractUpdates: 0, contractUpdatesPersisted: 0,
      tradesReconciledClosed: 0, reconcileSkippedFresh: 0,
      reconcileSkippedFetchError: 0, reconcileSkippedFalseAlarm: 0,
      portfolioEmptyResponses: 0,
      portfolioCacheHits: 0, portfolioCacheMisses: 0,
      portfolioInflightJoins: 0, portfolioRateLimitedServed: 0,
      limitOrderConverted: 0, limitOrderSkippedWrongSide: 0,
      verifyBackoffHits: 0,
      buyReconcileAttempts: 0, buyReconcileRecovered: 0,
      orphansAdopted: 0,
    };

    this.capabilities = { ...BROKER_CAPABILITIES };
    this._authFailCount = 0;
    this._account = null;
    this._openPositions = [];
    this._ready = false;
    this._connectPromise = null;
    this._accountReady = null;
    this._accountReadyResolve = null;

    logger.info('[DerivBroker] Initialized with Current Options API (OTP-URL auth).');
    logger.info(`[DerivBroker] Account type preference: ${this.config.accountType}`);
  }

  validateConfig() {
    if (!this.config.apiToken) throw new Error('DERIV_API_TOKEN is required');
    if (!this.config.appId) throw new Error('DERIV_APP_ID is required');
    if (!this.config.publicWsUrl?.startsWith('ws')) throw new Error('Invalid public WebSocket URL');
    if (!this.config.restBaseUrl?.startsWith('http')) throw new Error('Invalid REST base URL');
    if (!['demo', 'real'].includes(this.config.accountType)) {
      throw new Error(`DERIV_ACCOUNT_TYPE must be "demo" or "real" (got "${this.config.accountType}")`);
    }
    logger.info('[DerivBroker] Configuration validated.');
  }

  _seedSymbolMaps() {
    this.symbolMap = {};
    this.reverseMap = {};
    this.spreadMap = {};
    for (const [k, v] of Object.entries(FALLBACK_SYMBOLS)) {
      this.symbolMap[k] = v;
      const noSep = k.replace(/_/g, '');
      if (noSep !== k) this.symbolMap[noSep] = v;
      this.reverseMap[v] = k;
      this.spreadMap[v] = 0.0001;
    }
  }

  getLeverage(_symbol) { return 100; }

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

  _restHeaders() {
    const headers = {
      'Content-Type': 'application/json', 'Accept': 'application/json',
      'Authorization': `Bearer ${this.config.apiToken}`,
    };
    if (isPatToken(this.config.apiToken)) headers['Deriv-App-ID'] = String(this.config.appId);
    return headers;
  }

  async _fetchAccounts() {
    const url = `${this.config.restBaseUrl}/trading/v1/options/accounts`;
    const resp = await axios.get(url, { headers: this._restHeaders(), timeout: this.config.connectionTimeout });
    const raw = resp.data?.data ?? resp.data;
    let list = [];
    if (Array.isArray(raw)) list = raw;
    else if (Array.isArray(raw?.accounts)) list = raw.accounts;
    else if (raw && typeof raw === 'object') list = [raw];
    logger.info(`[DerivBroker] Discovered ${list.length} Options account(s).`);
    for (const acc of list) {
      logger.info(`[DerivBroker]   • account_id=${acc.account_id || acc.id} type=${acc.account_type || acc.type} currency=${acc.currency || 'N/A'}`);
    }
    return list;
  }

  async _resolveAccountId() {
    const accounts = await this._fetchAccounts();
    if (!accounts || accounts.length === 0) throw new Error('No Options trading accounts found for this PAT');
    const normType = (a) => String(a.account_type || a.type || '').toLowerCase();
    const normId = (a) => a.account_id || a.id || a.accountId;
    const remember = (acc) => {
      this._account = {
        loginid: normId(acc), account_id: normId(acc),
        currency: acc.currency || 'USD', account_type: normType(acc),
        balance: this._account?.balance ?? null,
      };
      if (acc.currency) this.accountCurrency = acc.currency;
    };
    if (this.config.accountId) {
      const match = accounts.find(a => normId(a) === this.config.accountId);
      if (match) { remember(match); return normId(match); }
      logger.warn(`[DerivBroker] Configured accountId not in list. Falling back.`);
    }
    const wanted = this.config.accountType;
    const byType = accounts.filter(a => normType(a) === wanted);
    if (byType.length === 0) {
      const available = accounts.map(a => `${normType(a)}(${normId(a)})`).join(', ');
      throw new Error(`No Options account of type "${wanted}" found. Available: [${available}].`);
    }
    const chosen = byType[0];
    remember(chosen);
    logger.info(`[DerivBroker] Auto-selected accountId: ${normId(chosen)} [type=${normType(chosen)}]`);
    return normId(chosen);
  }

  async _requestOtpUrl() {
    const accountId = await this._resolveAccountId();
    const url = `${this.config.restBaseUrl}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`;
    const resp = await axios.post(url, {}, { headers: this._restHeaders(), timeout: this.config.connectionTimeout });
    const data = resp.data?.data ?? resp.data;
    const wsUrl = data?.url;
    if (!wsUrl || !wsUrl.startsWith('ws')) {
      throw new Error('OTP response did not contain a WebSocket URL: ' + JSON.stringify(resp.data));
    }
    return wsUrl;
  }

  async connect() {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._doConnect();
    try { return await this._connectPromise; } finally { this._connectPromise = null; }
  }

  async _doConnect() {
    await Promise.all([this._connectPublic(), this._connectAuth()]);
    await this._loadSymbolsWithTimeout();
    if (!this._symbolsDiscovered) this._useFallbackSymbols();
    this._ready = true;
    this.emit('ready');
    this.emit('connected');
    await this._ensureBalanceLoaded();
    await this._subscribeDefaultSymbols();
    await this._reconcilePositions();
    await this._loadPendingOrders();
    await this._resumeContractSubscriptions();
    await this._reconcileTradeStatus();
    this._startTradeReconcileTimer();
  }

  async _ensureBalanceLoaded(timeoutMs = this.config.balanceTimeout) {
    if (this._account && this._account.balance != null) return this._account;
    if (!this._accountReady) {
      this._accountReady = new Promise((resolve) => { this._accountReadyResolve = resolve; });
    }
    try { await this._sendAuthRequest({ balance: 1, subscribe: 1 }); }
    catch (err) { logger.warn('[DerivBroker] Balance subscribe failed:', err.message); }

    let timer = null;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => { logger.warn('[DerivBroker] Balance load timeout.'); resolve(); }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    try { await Promise.race([this._accountReady, timeoutPromise]); }
    finally { if (timer) clearTimeout(timer); }
    return this._account;
  }

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
      try {
        this._publicSocket = new WebSocket(this.config.publicWsUrl);
        const socket = this._publicSocket;
        const timer = setTimeout(() => {
          if (this._publicState !== STATE.CONNECTED) {
            socket.terminate(); this._publicState = STATE.FAILED;
            reject(new Error('Public WS connection timeout'));
          }
        }, this.config.connectionTimeout);
        socket.on('pong', () => { this._publicLastPong = Date.now(); });
        socket.on('open', () => {
          clearTimeout(timer);
          logger.info('[DerivBroker] Public WS connected.');
          this._publicState = STATE.CONNECTED;
          this._publicLastPong = Date.now();
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
          this._publicState = STATE.DISCONNECTED;
          this._stopPublicHeartbeat();
          this._publicReconnectTimer = setTimeout(() => { this._connectPublic().catch(() => {}); }, this._getReconnectDelay(0));
        });
      } catch (err) { this._publicState = STATE.FAILED; reject(err); }
    });
  }

  _startPublicHeartbeat() {
    this._stopPublicHeartbeat();
    this._publicLastPong = Date.now();
    this._publicHeartbeatInterval = setInterval(() => {
      if (this._publicSocket?.readyState === WebSocket.OPEN) {
        try { this._publicSocket.ping(); } catch (_) {}
      }
    }, this.config.wsPingIntervalMs);
    this._publicHeartbeatTimeout = setInterval(() => {
      if (Date.now() - this._publicLastPong > this.config.heartbeatTimeout) {
        this._closePublicSocket();
        this._connectPublic().catch(() => {});
      }
    }, 30000);
  }
  _stopPublicHeartbeat() {
    if (this._publicHeartbeatInterval) clearInterval(this._publicHeartbeatInterval);
    if (this._publicHeartbeatTimeout) clearInterval(this._publicHeartbeatTimeout);
    this._publicHeartbeatInterval = null;
    this._publicHeartbeatTimeout = null;
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
      const important = payload.active_symbols || payload.ticks || payload.ticks_history || payload.ohlc;
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
        if (isPermanentApiError(err)) break;
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
      this._publicLastPong = Date.now();
      let handled = false;
      if (msg.msg_type === 'ping' || (msg.ping && !msg.pong)) {
        this._sendPublicRaw({ pong: msg.ping != null ? msg.ping : 1 });
        handled = true;
      }
      if (msg.pong) { handled = true; }
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
          const mid = (bid + ask) / 2;
          this.emit('tick', { symbol: tick.symbol, bid, ask, mid, time });
        }
        this.streaming.handleTick(tick);
        handled = true;
      }
      if (msg.active_symbols !== undefined) handled = true;
      if (msg.candles !== undefined) handled = true;
      if (!handled) logger.debug('[In Public] Unhandled:', JSON.stringify(redactSensitive(msg)));
    } catch (e) { logger.error('[In Public] Parse error:', e.message); }
  }
  async _ensurePublicReady() {
    if (this._publicState === STATE.CONNECTED || this._publicState === STATE.READY) return;
    await this._connectPublic();
    await sleep(200);
  }

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
      try {
        this._authSocket = new WebSocket(wsUrl);
        const socket = this._authSocket;
        const timer = setTimeout(() => {
          if (this._authState !== STATE.CONNECTED) {
            socket.terminate(); this._authState = STATE.FAILED;
            reject(new Error('Auth WS connection timeout'));
          }
        }, this.config.connectionTimeout);
        socket.on('pong', () => { this._authLastPong = Date.now(); });
        socket.on('open', () => {
          clearTimeout(timer);
          this._authState = STATE.READY;
          this._authLastPong = Date.now();
          this._startAuthHeartbeat();
          this._flushAuthQueue();
          this.emit('authReady');
          resolve();
          this._restoreAuthSubscriptions().catch(() => {});
        });
        socket.on('message', (d) => this._handleAuthMessage(d));
        socket.on('error', (e) => logger.error('[DerivBroker] Auth WS error:', e.message));
        socket.on('close', (code) => {
          clearTimeout(timer);
          this._authState = STATE.DISCONNECTED;
          this._stopAuthHeartbeat();
          this._scheduleAuthReconnect();
        });
      } catch (err) { this._authState = STATE.FAILED; this._scheduleAuthReconnect(); reject(err); }
    });
  }
  _scheduleAuthReconnect() {
    if (this._authReconnectTimer) clearTimeout(this._authReconnectTimer);
    this._authReconnectTimer = setTimeout(() => { this._connectAuth().catch(() => {}); }, this._getReconnectDelay(0));
  }
  _startAuthHeartbeat() {
    this._stopAuthHeartbeat();
    this._authLastPong = Date.now();
    this._authHeartbeatInterval = setInterval(() => {
      if (this._authSocket?.readyState === WebSocket.OPEN) {
        try { this._authSocket.ping(); } catch (_) {}
      }
    }, this.config.wsPingIntervalMs);
    this._authHeartbeatTimeout = setInterval(() => {
      if (Date.now() - this._authLastPong > this.config.heartbeatTimeout) {
        this._closeAuthSocket();
        this._scheduleAuthReconnect();
      }
    }, 30000);
  }
  _stopAuthHeartbeat() {
    if (this._authHeartbeatInterval) clearInterval(this._authHeartbeatInterval);
    if (this._authHeartbeatTimeout) clearInterval(this._authHeartbeatTimeout);
    this._authHeartbeatInterval = null;
    this._authHeartbeatTimeout = null;
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

    const isBuyRequest = payload && payload.buy != null;
    const maxAttempts = isBuyRequest ? 1 : this.config.maxRetries;

    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (signal?.aborted) throw new Error('Request cancelled');
        return await this._sendAuthRawRequest(payload, timeoutMs, signal);
      } catch (err) {
        lastErr = err;
        if (isRateLimitError(err)) { this._setRateLimitCooldown(); throw err; }
        if (isPermanentApiError(err)) break;
        if (attempt < maxAttempts) {
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

  _setRateLimitCooldown() { this._rateLimitUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS; }
  _isInRateLimitCooldown() { return this._rateLimitUntil > 0 && Date.now() < this._rateLimitUntil; }

  _handleAuthMessage(rawData) {
    try {
      const msg = JSON.parse(rawData);
      this._authLastPong = Date.now();
      let handled = false;
      if (msg.msg_type === 'ping' || (msg.ping && !msg.pong)) {
        this._sendAuthRaw({ pong: msg.ping != null ? msg.ping : 1 });
        handled = true;
      }
      if (msg.pong) { handled = true; }
      if (msg.error) {
        if (isRateLimitErrorMsg(msg.error)) {
          this._setRateLimitCooldown();
          const now = Date.now();
          if (now - this._lastRateLimitLogAt >= RATE_LIMIT_LOG_THROTTLE_MS) {
            this._lastRateLimitLogAt = now;
            logger.warn(`[In Auth] API Error: RateLimit (cooldown active, ${RATE_LIMIT_COOLDOWN_MS}ms)`);
          }
        } else {
          logger.error('[In Auth] API Error:', JSON.stringify(msg.error));
        }
      }
      if (msg.req_id && this._authPendingRequests.has(msg.req_id)) {
        const p = this._authPendingRequests.get(msg.req_id);
        clearTimeout(p.timeout);
        this._authPendingRequests.delete(msg.req_id);
        this.metrics.totalLatency += Date.now() - p.sentAt;
        this.metrics.latencyCount++;
        if (msg.error) { this.metrics.requestsFailed++; p.reject(new Error(`Deriv API error: ${msg.error.code}`)); }
        else { this.metrics.requestsSent++; p.resolve(msg); }
        handled = true;
      }
      if (msg.portfolio) {
        const contracts = msg.portfolio.contracts || [];
        if (contracts.length === 0) this.metrics.portfolioEmptyResponses++;
        this._openPositions = contracts
          .filter(c => c.status && ['open', 'active'].includes(c.status.toLowerCase()))
          .map(c => this._normalizeContract(c));
        if (this._portfolioCache) {
          this._portfolioCache.contracts = this._openPositions;
          this._portfolioCache.at = Date.now();
        }
        this.emit('_portfolioUpdated', this._openPositions);
        this.emit('positions', this._openPositions);
        handled = true;
      }
      if (msg.proposal_open_contract) {
        this._handleContractUpdate(msg.proposal_open_contract).catch(() => {});
        handled = true;
      }
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
    if (this._authState === STATE.READY) return;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Auth ready timeout')), this.config.readinessTimeout);
      this.once('authReady', () => { clearTimeout(t); resolve(); });
    });
  }

  async _restoreAuthSubscriptions() {
    if (!this._account || this._account.balance == null) {
      this._accountReady = new Promise((resolve) => { this._accountReadyResolve = resolve; });
    }
    try { await this._sendAuthRequest({ balance: 1, subscribe: 1 }); } catch (_) {}
    await this._resumeContractSubscriptions();
    await this._reconcileTradeStatus();
  }

  async _resumeContractSubscriptions() {
    let positions;
    try { positions = await this.getOpenTrades(); } catch (_) { return; }
    if (positions.length === 0) return;
    for (const pos of positions) {
      const contractId = String(pos.id);
      if (!contractId) continue;
      try {
        const existing = await Trade.findOne({ contractId: String(contractId) });
        if (!existing) {
          const side = pos.side === 'BUY' ? 'buy' : pos.side === 'SELL' ? 'sell' : 'buy';
          await Trade.create({
            contractId: String(contractId), instrument: pos.instrument, side,
            lotSize: pos.units || 0, openPrice: pos.entryPrice ?? pos.price ?? 0,
            status: 'OPEN', openTime: new Date(pos.openTime || Date.now()),
            product: 'deriv_multiplier', currentPrice: pos.currentPrice ?? pos.entryPrice ?? pos.price ?? null,
            floatingProfit: pos.unrealizedPL ?? 0, stake: pos.purchasePrice ?? null,
            purchasePrice: pos.purchasePrice ?? null,
          });
        }
      } catch (err) { if (err.code !== 11000) logger.warn(`[DerivBroker] Trade repair failed: ${err.message}`); }
      await this._subscribeOpenContract(contractId).catch(() => {});
    }
  }

  async _reconcileTradeStatus() {
    if (this._authState !== STATE.READY) return;
    let openTrades;
    try {
      openTrades = await Trade.find({
        status: 'OPEN',
        product: { $in: ['deriv_multiplier', 'deriv_digital'] },
      }).lean();
    } catch (_) { return; }
    if (openTrades.length === 0) return;
    let portfolio;
    try { portfolio = await this.getOpenTrades(); }
    catch (_) { this.metrics.reconcileSkippedFetchError++; return; }
    const portfolioIds = new Set(portfolio.map(p => String(p.id)));
    const now = Date.now();
    for (const trade of openTrades) {
      const cid = String(trade.contractId);
      if (portfolioIds.has(cid)) { this._reconcileMissCounts.delete(cid); continue; }
      const openedAt = trade.openTime ? new Date(trade.openTime).getTime() : 0;
      if (openedAt && (now - openedAt) < this.config.tradeReconcileMinAgeMs) {
        this.metrics.reconcileSkippedFresh++;
        continue;
      }
      const misses = (this._reconcileMissCounts.get(cid) || 0) + 1;
      this._reconcileMissCounts.set(cid, misses);
      if (misses < this.config.tradeReconcileMissesRequired) continue;
      const verify = await this._verifyContractStatus(cid);
      if (verify.status === 'open') {
        this.metrics.reconcileSkippedFalseAlarm++;
        this._reconcileMissCounts.delete(cid);
        continue;
      }
      if (verify.status === 'closed') {
        const realizedProfit = Number(verify.profit || 0);
        try {
          await Trade.findOneAndUpdate({ contractId: cid }, {
            $set: {
              status: 'CLOSED', closeTime: new Date(), floatingProfit: 0,
              realizedProfit, pnl: realizedProfit, closePrice: verify.soldFor || null,
            },
          });
          this.metrics.tradesReconciledClosed++;
        } catch (_) {}
        this._reconcileMissCounts.delete(cid);
        if (this._portfolioCache) this._portfolioCache.at = 0;
        if (!this._closedEmitted.has(cid)) {
          this._closedEmitted.add(cid);
          const riskAmount = Number(trade.stake || trade.lotSize || 1) || 1;
          const closedPayload = {
            contractId: cid, strategy: trade.strategy || null,
            instrument: trade.instrument || null,
            regimeCode: (trade.entryThesis && trade.entryThesis.regime) || null,
            realizedProfit, riskAmount,
            result: { closePrice: verify.soldFor || null, buyPrice: verify.buyPrice || null },
            source: 'reconciliation', timestamp: new Date().toISOString(),
          };
          try {
            eventBus.emit('trade.closed', closedPayload);
            logger.info(`[DerivBroker] Emitted trade.closed (reconcile) for ${cid} — pnl=${realizedProfit.toFixed(2)} strategy=${trade.strategy || 'unknown'}`);
          } catch (emitErr) {
            logger.warn(`[DerivBroker] trade.closed (reconcile) emit failed for ${cid}: ${emitErr.message}`);
          }
        }
      }
    }
  }

  _recordVerifyUnknown(key, reason = 'unknown') {
    const prev = this._verifyUnknownCounts.get(key) || { count: 0 };
    const count = prev.count + 1;
    const delayMs = Math.min(VERIFY_BACKOFF_BASE_MS * Math.pow(2, count - 1), VERIFY_BACKOFF_MAX_MS);
    this._verifyUnknownCounts.set(key, { count, nextRetryAt: Date.now() + delayMs, lastReason: reason });
  }

  async _verifyContractStatus(contractId, bypassBackoff = false) {
    const key = String(contractId);
    const numericId = Number(key);
    if (!Number.isInteger(numericId) || numericId <= 0) return { status: 'unknown' };

    if (!bypassBackoff) {
      const tracking = this._verifyUnknownCounts.get(key);
      if (tracking && tracking.nextRetryAt && Date.now() < tracking.nextRetryAt) {
        this.metrics.verifyBackoffHits++;
        return { status: 'unknown', backoff: true };
      }
    }

    try {
      const resp = await this._sendAuthRequest({ proposal_open_contract: 1, contract_id: numericId }, 8000);
      const poc = resp?.proposal_open_contract;
      if (!poc) { this._recordVerifyUnknown(key, 'empty-response'); return { status: 'unknown' }; }
      const finalStatuses = ['sold', 'won', 'lost', 'cancelled', 'expired'];
      const isFinal = poc.is_sold || poc.is_expired || finalStatuses.includes(String(poc.status || '').toLowerCase());
      const soldFor = poc.sell_price != null ? Number(poc.sell_price) : null;
      const buyPrice = poc.buy_price != null ? Number(poc.buy_price) : null;
      const profit = (soldFor != null && buyPrice != null) ? (soldFor - buyPrice) : null;
      const limitStopLoss = poc.limit_order?.stop_loss != null ? Number(poc.limit_order.stop_loss) : null;
      const limitTakeProfit = poc.limit_order?.take_profit != null ? Number(poc.limit_order.take_profit) : null;
      this._verifyUnknownCounts.delete(key);
      return isFinal
        ? { status: 'closed', profit, soldFor, buyPrice, limitStopLoss, limitTakeProfit }
        : { status: 'open', profit, soldFor, buyPrice, limitStopLoss, limitTakeProfit };
    } catch (err) {
      const reason = isRateLimitError(err) ? 'rate-limited' : 'error';
      this._recordVerifyUnknown(key, reason);
      return { status: 'unknown' };
    }
  }

  async getContractStatus(contractId) {
    await this._ensureAuthReady();
    return this._verifyContractStatus(contractId, true);
  }

  _startTradeReconcileTimer() {
    if (this._tradeReconcileTimer) clearInterval(this._tradeReconcileTimer);
    this._tradeReconcileTimer = setInterval(async () => {
      await this._reconcileTradeStatus().catch(() => {});
      await this._sweepOrphanContracts().catch(() => {});
    }, this.config.tradeReconcileIntervalMs);
    if (typeof this._tradeReconcileTimer.unref === 'function') this._tradeReconcileTimer.unref();
  }

  async _sweepOrphanContracts() {
    if (this._authState !== STATE.READY) return;
    if (this._isInRateLimitCooldown()) return;

    let positions;
    try { positions = await this.getOpenTrades(); }
    catch (_) { return; }
    if (!positions.length) { this._lastOrphanSweepAt = new Date(); return; }

    const ids = positions.map(p => String(p.id)).filter(Boolean);
    if (!ids.length) { this._lastOrphanSweepAt = new Date(); return; }

    let existing = [];
    try { existing = await Trade.find({ contractId: { $in: ids } }).lean(); }
    catch (_) { return; }
    const known = new Set(existing.map(t => String(t.contractId)));
    this._lastOrphanSweepAt = new Date();

    for (const pos of positions) {
      const cid = String(pos.id);
      if (!cid || known.has(cid)) continue;
      logger.warn(`[DerivBroker] ORPHAN CONTRACT DETECTED: ${cid} is live on Deriv but has no Trade record — adopting.`);

      try {
        await Trade.create({
          contractId: cid, instrument: pos.instrument,
          side: (pos.side || 'BUY').toLowerCase(), lotSize: pos.units || 0,
          openPrice: pos.entryPrice || 0, status: 'OPEN',
          openTime: new Date(pos.openTime || Date.now()),
          product: 'deriv_digital', currentPrice: pos.currentPrice || pos.entryPrice || 0,
          floatingProfit: pos.unrealizedPL || 0,
          purchasePrice: pos.purchasePrice || null, stake: pos.purchasePrice || null,
          entryThesis: { adopted: true, reason: 'orphan_sweep' },
        });
        this.metrics.orphansAdopted++;
      } catch (err) {
        if (err.code !== 11000) { logger.warn(`[DerivBroker] Orphan Trade create failed for ${cid}: ${err.message}`); continue; }
      }

      this._subscribeOpenContract(cid).catch(() => {});
      if (this._portfolioCache) this._portfolioCache.at = 0;

      try {
        eventBus.emit('trade.adopted', {
          contractId: cid, instrument: pos.instrument,
          entryPrice: pos.entryPrice, stake: pos.purchasePrice,
          side: pos.side, timestamp: new Date().toISOString(),
        });
      } catch (_) {}
    }
  }

  async _reconcileOrphanBuy(derivSymbol, direction, stake, submittedAt) {
    this.metrics.buyReconcileAttempts++;
    await sleep(RECONCILE_BUY_GRACE_MS);

    let positions;
    try { positions = await this.getOpenTrades(); }
    catch (err) {
      logger.warn(`[DerivBroker] _reconcileOrphanBuy: portfolio fetch failed: ${err.message}`);
      return null;
    }

    const expectedSide = direction === 'MULTUP' ? 'BUY' : direction === 'MULTDOWN' ? 'SELL' : null;
    const stakeNum = Math.abs(Number(stake));
    const minOpenTime = submittedAt - RECONCILE_BUY_LOOKBACK_MS;

    const candidates = [];
    for (const p of positions) {
      const raw = p.raw || {};
      const pSymbol = raw.underlying_symbol || raw.underlying || '';
      if (pSymbol !== derivSymbol) continue;
      if (expectedSide && p.side !== expectedSide) continue;
      const pPrice = Number(p.purchasePrice || raw.buy_price || 0);
      if (Number.isFinite(pPrice) && Math.abs(pPrice - stakeNum) > 0.01) continue;
      const openTime = Number(p.openTime || 0);
      if (openTime && openTime < minOpenTime) continue;
      candidates.push(p);
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (b.openTime || 0) - (a.openTime || 0));
    this.metrics.buyReconcileRecovered++;
    return candidates[0];
  }

  async _subscribeOpenContract(contractId) {
    const key = String(contractId);
    if (!key || this._contractSubscriptions.has(key)) return;
    const numericContractId = Number(key);
    if (!Number.isInteger(numericContractId) || numericContractId <= 0) return;
    const resp = await this._sendAuthRequest(
      { proposal_open_contract: 1, contract_id: numericContractId, subscribe: 1 },
      this.config.contractSubscribeTimeout
    );
    const poc = resp.proposal_open_contract;
    if (!poc) return;
    this._contractSubscriptions.set(key, { subscriptionId: resp.subscription?.id, subscribedAt: Date.now() });
    this.metrics.contractSubscriptions = this._contractSubscriptions.size;
    await this._handleContractUpdate(poc, true);
  }

  async _handleContractUpdate(poc, forcePersist = false) {
    const contractId = String(poc.contract_id ?? '');
    if (!contractId) return;
    const limitStopLoss = poc.limit_order?.stop_loss != null ? Number(poc.limit_order.stop_loss) : null;
    const limitTakeProfit = poc.limit_order?.take_profit != null ? Number(poc.limit_order.take_profit) : null;
    const state = {
      contractId, symbol: poc.underlying, contractType: poc.contract_type,
      status: poc.status,
      currentSpot: poc.current_spot != null ? Number(poc.current_spot) : null,
      entrySpot: poc.entry_spot != null ? Number(poc.entry_spot) : null,
      currentProfit: poc.profit != null ? Number(poc.profit) : 0,
      buyPrice: poc.buy_price != null ? Number(poc.buy_price) : null,
      sellPrice: poc.sell_price != null ? Number(poc.sell_price) : null,
      exitTick: poc.exit_tick != null ? Number(poc.exit_tick) : null,
      isSold: !!poc.is_sold, isExpired: !!poc.is_expired,
      isValidToSell: !!poc.is_valid_to_sell,
      sellTime: poc.sell_time ? new Date(poc.sell_time * 1000) : null,
      entryTime: poc.entry_tick_time ? new Date(poc.entry_tick_time * 1000) : null,
      limitStopLoss, limitTakeProfit, raw: poc, receivedAt: Date.now(),
    };
    this._contractStates.set(contractId, state);
    this.metrics.contractUpdates++;
    const count = (this._contractUpdateCounts.get(contractId) || 0) + 1;
    this._contractUpdateCounts.set(contractId, count);
    try { this.emit('contractUpdate', state); } catch (_) {}
    const finalStatuses = ['sold', 'won', 'lost', 'cancelled', 'expired'];
    const isFinal = state.isSold || state.isExpired || finalStatuses.includes(String(state.status || '').toLowerCase());
    await this._persistContractState(contractId, isFinal || forcePersist);
    if (isFinal) {
      this._contractSubscriptions.delete(contractId);
      this._contractUpdateCounts.delete(contractId);
      this.metrics.contractSubscriptions = this._contractSubscriptions.size;
    }
  }

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
    const isFinal = state.isSold || state.isExpired || finalStatuses.includes(String(state.status || '').toLowerCase());
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
      const res = await Trade.findOneAndUpdate({ contractId: String(key) }, { $set: update }, { new: false });
      if (res) this.metrics.contractUpdatesPersisted++;

      if (isFinal) {
        if (this._portfolioCache) this._portfolioCache.at = 0;

        if (!this._closedEmitted.has(key)) {
          this._closedEmitted.add(key);

          let tradeDoc = null;
          try { tradeDoc = await Trade.findOne({ contractId: String(key) }).lean(); } catch (_) {}

          const realizedProfit = Number(state.currentProfit ?? 0);
          const riskAmount = Number(tradeDoc?.stake || tradeDoc?.lotSize || 1) || 1;

          const closedPayload = {
            contractId: String(key),
            strategy: tradeDoc?.strategy || null,
            instrument: tradeDoc?.instrument || state.symbol || null,
            regimeCode: (tradeDoc?.entryThesis && tradeDoc.entryThesis.regime) || null,
            realizedProfit, riskAmount,
            result: {
              closePrice: state.exitTick ?? state.sellPrice ?? state.currentSpot ?? null,
              buyPrice: state.buyPrice ?? null,
            },
            source: 'broker_settlement',
            timestamp: new Date().toISOString(),
          };

          try {
            eventBus.emit('trade.closed', closedPayload);
            logger.info(`[DerivBroker] Emitted trade.closed for ${key} — pnl=${realizedProfit.toFixed(2)} strategy=${tradeDoc?.strategy || 'unknown'}`);
          } catch (emitErr) {
            logger.warn(`[DerivBroker] trade.closed emit failed for ${key}: ${emitErr.message}`);
          }
        }
      }
    } catch (err) {
      logger.warn(`[DerivBroker] Trade persist failed for ${key}: ${err.message}`);
    }
  }
 
  async _loadSymbolsWithTimeout() {
    let timer = null;
    const timeoutPromise = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Symbol load timeout')), this.config.symbolTimeout);
      if (typeof timer.unref === 'function') timer.unref();
    });
    const loadPromise = this._loadSymbolsInternal();
    loadPromise.catch(() => {});
    try {
      return await Promise.race([loadPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async _loadSymbolsInternal() {
    let symbols = null;
    try {
      const resp = await this._sendPublicRequest({ active_symbols: 'brief' }, 10000);
      if (Array.isArray(resp.active_symbols) && resp.active_symbols.length > 0) symbols = resp.active_symbols;
      else {
        const resp2 = await this._sendPublicRequest({ active_symbols: 'full' }, 10000);
        if (Array.isArray(resp2.active_symbols) && resp2.active_symbols.length > 0) symbols = resp2.active_symbols;
      }
    } catch (_) {}
    if (symbols?.length) {
      this._buildSymbolMaps(symbols);
      this._symbolsDiscovered = true;
      this._symbolsLoaded = true;
      logger.info(`[DerivBroker] ${Object.keys(this.symbolMap).length} symbols mapped.`);
    } else {
      throw new Error('No symbols received');
    }
  }
  _useFallbackSymbols() {
    this._seedSymbolMaps();
    this._symbolsDiscovered = true; this._symbolsLoaded = true;
  }
  _buildSymbolMaps(symbols) {
    this._seedSymbolMaps();
    let count = 0;
    for (const sym of symbols) {
      const derivSymbol = sym.underlying_symbol ?? sym.symbol;
      const display = sym.underlying_symbol_name ?? sym.display_name ?? '';
      const pip = Number(sym.pip_size ?? sym.pip ?? 0.0001);
      if (!derivSymbol) continue;

      const fxMatch = display.match(/([A-Z]{3})\/([A-Z]{3})/);
      if (fxMatch) {
        const ourPair = fxMatch[1] + '_' + fxMatch[2];
        const noSep = fxMatch[1] + fxMatch[2];
        this.symbolMap[ourPair] = derivSymbol;
        this.symbolMap[noSep] = derivSymbol;
        this.reverseMap[derivSymbol] = ourPair;
        this.spreadMap[derivSymbol] = pip * 0.5;
        count++;
        continue;
      }

      if (/^(R_|1HZ)/i.test(derivSymbol)) {
        this.symbolMap[derivSymbol] = derivSymbol;
        this.reverseMap[derivSymbol] = derivSymbol;
        this.spreadMap[derivSymbol] = pip * 0.5;
        count++;
      }
    }
    this.symbolManager.setSymbols(symbols);
    logger.info(
      `[DerivBroker] Symbol map built: ${count} discovered (+ fallback seeded), ` +
      `total keys=${Object.keys(this.symbolMap).length}`
    );
    return count;
  }
  async _subscribeDefaultSymbols() {
    const valid = new Set(Object.values(this.symbolMap));
    const toSub = WATCHLIST.filter(s => valid.has(s));
    const list = toSub.length > 0 ? toSub : Object.values(FALLBACK_SYMBOLS).slice(0, 4);
    for (const sym of list) {
      try { await this.streaming.subscribe('ticks', sym, () => {}); } catch (_) {}
    }
    logger.info(`[DerivBroker] Subscribed to ${list.length} default symbols: ${list.join(', ')}`);
  }

  async _loadPendingOrders() {
    try {
      const pending = await Order.find({ status: { $in: ['PENDING', 'ACCEPTED', 'EXECUTING'] } });
      for (const o of pending) {
        this._orders.set(o.clientOrderId, o);
        if (o.contractId) this._orderMap.set(String(o.contractId), o.clientOrderId);
      }
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
    let positions;
    try { positions = await this.getOpenTrades(); } catch (_) { return; }
    try {
      const dbOrders = await Order.find({ status: ORDER_STATUS.FILLED });
      const dbMap = new Map();
      for (const ord of dbOrders) if (ord.contractId) dbMap.set(String(ord.contractId), ord);
      for (const pos of positions) {
        if (!dbMap.has(String(pos.id))) {
          const newOrder = new Order({
            clientOrderId: generateClientOrderId(), instrument: pos.instrument,
            side: pos.side, units: pos.units, entryPrice: pos.entryPrice ?? pos.price ?? 0,
            purchasePrice: pos.purchasePrice ?? null, status: ORDER_STATUS.FILLED,
            contractId: String(pos.id), filledAt: new Date(pos.openTime || Date.now()),
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
    } catch (_) {}
  }

  _normalizeContract(c) {
    const contractId = String(c.contract_id ?? c.id ?? '');
    const derivSymbol = c.underlying_symbol ?? c.underlying ?? c.symbol;
    const entrySpotRaw = c.entry_spot ?? c.entry_tick ?? c.entry_price;
    const entrySpotNum = Number(entrySpotRaw);
    const entryPrice = Number.isFinite(entrySpotNum) && entrySpotNum > 0 ? entrySpotNum : null;
    const purchasePriceRaw = c.buy_price ?? c.purchase_price;
    const purchasePriceNum = Number(purchasePriceRaw);
    const purchasePrice = Number.isFinite(purchasePriceNum) && purchasePriceNum > 0 ? purchasePriceNum : null;
    const currentSpotRaw = c.current_spot ?? c.current_tick;
    const currentSpotNum = Number(currentSpotRaw);
    const currentPrice = Number.isFinite(currentSpotNum) && currentSpotNum > 0 ? currentSpotNum : (entryPrice ?? 0);
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
      id: contractId, contractId,
      instrument: fromDerivSymbol(derivSymbol, this.reverseMap) || 'UNKNOWN',
      side, purchasePrice, entryPrice, price: entryPrice ?? 0,
      units: c.amount ?? 0, unrealizedPL: Number(c.profit ?? c.profit_loss ?? 0),
      currentPrice, stopLoss: Number(c.stop_loss ?? 0),
      takeProfit: Number(c.take_profit ?? 0), openTime, status: 'OPEN', raw: c,
    };
  }

  async getAccount() {
    await this._ensureAuthReady();
    if (!this._account || this._account.balance == null) {
      try { await this._ensureBalanceLoaded(); } catch (_) {}
    }
    if (!this._account || this._account.balance == null) return this._getDefaultAccount();
    const acc = this._account;
    const bal = Number(acc.balance) || 0;
    return {
      id: acc.loginid || acc.account_id || 'N/A',
      balance: String(bal), currency: acc.currency || 'USD',
      equity: String(bal), marginUsed: '0', marginAvailable: String(bal),
      accountType: acc.account_type || this.config.accountType,
      createdTime: new Date().toISOString(),
    };
  }
  _getDefaultAccount() {
    return {
      id: 'UNKNOWN', balance: '0', currency: 'USD', equity: '0',
      marginUsed: '0', marginAvailable: '0',
      accountType: this.config.accountType,
      createdTime: new Date().toISOString(), stale: true,
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
    const intervalMap = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 };
    const sec = intervalMap[granularity] || 300;
    const safeCount = Math.max(1, Math.min(parseInt(count) || 100, 5000));
    const reqPayload = {
      ticks_history: symbol, count: safeCount,
      end: 'latest', style: 'candles', granularity: sec,
    };
    logger.info(`[DerivBroker] getCandles(${instrument}/${granularity}) → ${symbol} count=${safeCount} gran=${sec}s`);
    let resp;
    try { resp = await this._sendPublicRequest(reqPayload, 20000); }
    catch (err) { logger.error(`[DerivBroker] getCandles(${instrument}) failed: ${err.message}`); throw err; }
    if (!resp || !Array.isArray(resp.candles)) {
      logger.warn(`[DerivBroker] getCandles(${instrument}): no candles array. Keys: ${resp ? Object.keys(resp).join(',') : 'null'}`);
      return [];
    }
    if (resp.candles.length === 0) {
      logger.warn(`[DerivBroker] getCandles(${instrument}): 0 candles`);
      return [];
    }
    if (resp.candles.length < safeCount * 0.8) {
      logger.warn(
        `[DerivBroker] getCandles(${instrument}/${granularity}): only ` +
        `${resp.candles.length}/${safeCount} candles returned (market may have limited history)`
      );
    }
    logger.info(`[DerivBroker] getCandles(${instrument}) ✓ ${resp.candles.length} candles`);
    return resp.candles.slice(-safeCount).map(c => ({
      mid: { o: c.open, h: c.high, l: c.low, c: c.close }, time: c.epoch, complete: true,
    }));
  }

  async getOpenTrades() {
    await this._ensureAuthReady();
    const now = Date.now();

    if (this._portfolioCache && this._portfolioCache.contracts &&
        (now - this._portfolioCache.at) < this._portfolioCache.ttl) {
      this.metrics.portfolioCacheHits++;
      return this._portfolioCache.contracts;
    }

    if (this._portfolioInflight) {
      this.metrics.portfolioCacheHits++;
      this.metrics.portfolioInflightJoins++;
      return this._portfolioInflight;
    }

    if (this._isInRateLimitCooldown() && this._portfolioCache?.contracts) {
      this.metrics.portfolioCacheHits++;
      this.metrics.portfolioRateLimitedServed++;
      return this._portfolioCache.contracts;
    }

    this.metrics.portfolioCacheMisses++;
    this._portfolioInflight = (async () => {
      try {
        const resp = await this._sendAuthRequest({ portfolio: 1 });
        const contracts = (resp.portfolio?.contracts) || [];
        const normalized = contracts
          .filter(c => c.status && ['open', 'active'].includes(c.status.toLowerCase()))
          .map(c => this._normalizeContract(c));
        if (this._portfolioCache) {
          this._portfolioCache.contracts = normalized;
          this._portfolioCache.at = Date.now();
        }
        return normalized;
      } catch (err) {
        if (isRateLimitError(err) && this._portfolioCache?.contracts) {
          this.metrics.portfolioRateLimitedServed++;
          logger.debug(
            `[DerivBroker] Portfolio rate-limited; serving stale cache ` +
            `(age ${Date.now() - this._portfolioCache.at}ms)`
          );
          return this._portfolioCache.contracts;
        }
        throw err;
      } finally {
        this._portfolioInflight = null;
      }
    })();
    return this._portfolioInflight;
  }
  async getPositions() { return this.getOpenTrades(); }

  _buildLimitOrder(symbol, direction, units, finalMultiplier, stopLossPrice, takeProfitPrice, referencePrice) {
    if (stopLossPrice == null && takeProfitPrice == null) return { limitOrder: {}, referencePrice, usedBaseProposal: false };
    if (referencePrice == null || !Number.isFinite(referencePrice) || referencePrice <= 0) {
      return { limitOrder: {}, referencePrice: null, usedBaseProposal: false, needsBaseProposal: true };
    }

    const stake = Math.abs(Number(units));
    const notional = stake * finalMultiplier;
    const limitOrder = {};

    if (stopLossPrice != null) {
      const sl = Number(stopLossPrice);
      if (Number.isFinite(sl) && sl > 0) {
        const priceDiff = direction === 'MULTUP' ? (referencePrice - sl) : (sl - referencePrice);
        if (priceDiff > 0) {
          const lossAmount = notional * priceDiff / referencePrice;
          const rounded = Math.round(lossAmount * 100) / 100;
          if (rounded >= MIN_LIMIT_ORDER_AMOUNT) limitOrder.stop_loss = rounded;
        } else {
          this.metrics.limitOrderSkippedWrongSide++;
          logger.warn(
            `[DerivBroker] placeMarketOrder: stopLoss ${sl} is on the wrong side of ` +
            `reference ${referencePrice} for ${direction} — omitting stop_loss`
          );
        }
      }
    }

    if (takeProfitPrice != null) {
      const tp = Number(takeProfitPrice);
      if (Number.isFinite(tp) && tp > 0) {
        const priceDiff = direction === 'MULTUP' ? (tp - referencePrice) : (referencePrice - tp);
        if (priceDiff > 0) {
          const profitAmount = notional * priceDiff / referencePrice;
          const rounded = Math.round(profitAmount * 100) / 100;
          if (rounded >= MIN_LIMIT_ORDER_AMOUNT) limitOrder.take_profit = rounded;
        } else {
          this.metrics.limitOrderSkippedWrongSide++;
          logger.warn(
            `[DerivBroker] placeMarketOrder: takeProfit ${tp} is on the wrong side of ` +
            `reference ${referencePrice} for ${direction} — omitting take_profit`
          );
        }
      }
    }

    if (Object.keys(limitOrder).length > 0) this.metrics.limitOrderConverted++;
    return { limitOrder, referencePrice, usedBaseProposal: false };
  }

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
    let finalMultiplier;
    if (opts.multiplier == null) finalMultiplier = DEFAULT_MULTIPLIER;
    else {
      finalMultiplier = Math.floor(Number(opts.multiplier));
      if (!Number.isFinite(finalMultiplier) || !ACCEPTED_MULTIPLIERS.includes(finalMultiplier)) {
        throw new Error(`Invalid multiplier ${opts.multiplier}.`);
      }
    }

    const baseProposalPayload = {
      proposal: 1, amount, basis: 'stake', contract_type: direction,
      currency: this.accountCurrency || 'USD', underlying_symbol: symbol,
      multiplier: finalMultiplier, subscribe: 1,
    };

    let referencePrice = null;
    const cached = this.streaming.getPrice(symbol);
    if (cached && cached.mid != null && Number.isFinite(cached.mid) && cached.mid > 0) {
      const age = Date.now() - (cached.time || 0);
      if (age < 5000) referencePrice = cached.mid;
    }

    if ((stopLoss != null || takeProfit != null) && referencePrice == null) {
      try {
        const baseResp = await this._sendAuthRequest(baseProposalPayload);
        const baseProp = baseResp.proposal;
        if (baseProp?.spot != null) {
          const spot = Number(baseProp.spot);
          if (Number.isFinite(spot) && spot > 0) referencePrice = spot;
        }
      } catch (err) {
        logger.debug(`[DerivBroker] placeMarketOrder: base proposal for spot failed: ${err.message}`);
      }
    }

    const { limitOrder } = this._buildLimitOrder(
      symbol, direction, units, finalMultiplier, stopLoss, takeProfit, referencePrice
    );

    const proposalPayload = { ...baseProposalPayload };
    if (Object.keys(limitOrder).length > 0) proposalPayload.limit_order = limitOrder;

    const proposalResp = await this._sendAuthRequest(proposalPayload);
    const proposal = proposalResp.proposal;
    if (!proposal?.id) throw new Error(`Proposal missing: ${JSON.stringify(proposalResp)}`);
    const askPrice = Number(proposal.ask_price);
    if (!Number.isFinite(askPrice) || askPrice <= 0) throw new Error(`Invalid ask price.`);

    const buySubmittedAt = Date.now();
    let buyResp;
    try {
      buyResp = await this._sendAuthRequest({ buy: proposal.id, price: askPrice });
    } catch (buyErr) {
      logger.warn(
        `[DerivBroker] placeMarketOrder: buy failed for ${symbol} ${direction} ` +
        `stake=${amount} (${buyErr.message}). Reconciling against portfolio...`
      );
      const recovered = await this._reconcileOrphanBuy(symbol, direction, amount, buySubmittedAt);
      if (recovered) {
        logger.warn(
          `[DerivBroker] RECOVERED contract ${recovered.id} from portfolio after buy error. ` +
          `Treating as success — do NOT retry.`
        );
        if (this._portfolioCache) this._portfolioCache.at = 0;
        this._subscribeOpenContract(recovered.id).catch(() => {});
        return {
          contractId: recovered.id,
          tradeID: recovered.id,
          ticket: recovered.id,
          purchasePrice: recovered.purchasePrice,
          entryPrice: recovered.entryPrice,
          price: recovered.entryPrice,
          raw: { reconciled: true, originalError: buyErr.message },
        };
      }
      throw buyErr;
    }
    const buy = buyResp.buy;
    const contractId = String(buy?.contract_id ?? '');
    const purchasePrice = Number(buy?.buy_price ?? buy?.price);
    const entrySpot = Number(buy?.entry_spot ?? proposal.spot);
    if (!contractId || contractId === 'undefined') throw new Error('No contract ID');
    if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) throw new Error(`Invalid purchase price.`);

    if (this._portfolioCache) this._portfolioCache.at = 0;

    this._subscribeOpenContract(contractId).catch(() => {});
    this.getOpenTrades().then(p => this.emit('positions', p)).catch(() => {});
    return {
      contractId, tradeID: contractId, ticket: contractId, purchasePrice,
      entryPrice: Number.isFinite(entrySpot) && entrySpot > 0 ? entrySpot : null,
      price: Number.isFinite(entrySpot) && entrySpot > 0 ? entrySpot : null,
      raw: buyResp,
    };
  }

  async closeTrade(tradeId) {
    await this._ensureAuthReady();
    if (!tradeId) throw new Error('tradeId required');
    const numericTradeId = Number(tradeId);
    if (!Number.isInteger(numericTradeId) || numericTradeId <= 0) throw new Error(`Invalid contract ID.`);
    const resp = await this._sendAuthRequest({ sell: numericTradeId, price: 0 });
    if (!resp.sell) throw new Error('Close failed');

    if (this._portfolioCache) this._portfolioCache.at = 0;

    let coid = this._orderMap.get(String(tradeId));
    if (!coid) {
      try {
        const ord = await Order.findOne({ contractId: String(tradeId) });
        if (ord) { coid = ord.clientOrderId; this._orderMap.set(String(tradeId), coid); this._orders.set(coid, ord); }
      } catch (_) {}
    }
    if (coid) { await this._updateOrderStatus(coid, ORDER_STATUS.CLOSED); this._orderMap.delete(String(tradeId)); }
    try {
      const soldFor = resp.sell.sold_for != null ? Number(resp.sell.sold_for) : null;
      const balanceAfter = resp.sell.balance_after != null ? Number(resp.sell.balance_after) : null;
      const buyPrice = resp.sell.buy_price != null ? Number(resp.sell.buy_price) : null;
      const profit = (soldFor != null && buyPrice != null) ? (soldFor - buyPrice) : null;
      const update = { status: 'CLOSED', closeTime: new Date() };
      if (soldFor != null) update.closePrice = soldFor;
      if (profit != null) { update.realizedProfit = profit; update.pnl = profit; }
      update.floatingProfit = 0;
      await Trade.findOneAndUpdate({ contractId: String(tradeId) }, { $set: update });
      if (balanceAfter != null && this._account) {
        this._account.balance = balanceAfter;
        this.emit('accountUpdate', this._account);
      }
    } catch (_) {}
    this.getOpenTrades().then(p => this.emit('positions', p)).catch(() => {});
    return resp;
  }

  async modifySLTP(tradeId, stopLoss, takeProfit) {
    await this._ensureAuthReady();
    const positions = await this.getOpenTrades();
    const pos = positions.find(p => p.id === String(tradeId));
    if (!pos) throw new Error(`Trade ${tradeId} not open`);
    const finalSL = (stopLoss != null) ? Number(stopLoss) : (pos.stopLoss || null);
    const finalTP = (takeProfit != null) ? Number(takeProfit) : (pos.takeProfit || null);
    let finalMultiplier = DEFAULT_MULTIPLIER;
    try {
      const tradeDoc = await Trade.findOne({ contractId: String(tradeId) }).lean();
      if (tradeDoc && tradeDoc.multiplier) finalMultiplier = Number(tradeDoc.multiplier);
    } catch (_) {}
    await this.closeTrade(tradeId);
    const units = pos.units * (pos.side === 'BUY' ? 1 : -1);
    const r = await this.placeMarketOrder(pos.instrument, units, finalSL, finalTP, { multiplier: finalMultiplier });
    return { message: 'Reopened with new SL/TP', newTradeId: r.tradeID, price: r.price };
  }

  async partialClose() { throw new Error('Partial close not supported'); }
  async placeLimitOrder(instrument, units, price, sl = null, tp = null) {
    return this.placeMarketOrder(instrument, units, sl, tp);
  }

  isMarketDataConnected() { return [STATE.CONNECTED, STATE.READY].includes(this._publicState); }
  isTradingReady() { return this._authState === STATE.READY; }
  isConnected() { return this.isMarketDataConnected() && this.isTradingReady(); }
  isAuthorized() { return this.isTradingReady(); }
  getHealth() {
    return {
      publicState: this._publicState, authState: this._authState,
      marketDataConnected: this.isMarketDataConnected(),
      tradingReady: this.isTradingReady(), ready: this._ready,
      reconnectCount: this.metrics.reconnections,
      contractMonitoring: {
        activeSubscriptions: this._contractSubscriptions.size,
        trackedContracts: this._contractStates.size,
        totalUpdates: this.metrics.contractUpdates,
        persistedUpdates: this.metrics.contractUpdatesPersisted,
        verifyBackoffHits: this.metrics.verifyBackoffHits,
        verifyBackoffTracked: this._verifyUnknownCounts.size,
      },
      tradeReconciliation: {
        intervalMs: this.config.tradeReconcileIntervalMs,
        minAgeMs: this.config.tradeReconcileMinAgeMs,
        missesRequired: this.config.tradeReconcileMissesRequired,
        closedTrades: this.metrics.tradesReconciledClosed,
        skippedFresh: this.metrics.reconcileSkippedFresh,
        skippedFetchError: this.metrics.reconcileSkippedFetchError,
        skippedFalseAlarm: this.metrics.reconcileSkippedFalseAlarm,
      },
      orphanRecovery: {
        buyReconcileAttempts: this.metrics.buyReconcileAttempts,
        buyReconcileRecovered: this.metrics.buyReconcileRecovered,
        orphansAdopted: this.metrics.orphansAdopted,
        lastOrphanSweepAt: this._lastOrphanSweepAt ? this._lastOrphanSweepAt.toISOString() : null,
      },
      portfolioDiagnostics: {
        emptyResponses: this.metrics.portfolioEmptyResponses,
        cacheHits: this.metrics.portfolioCacheHits,
        cacheMisses: this.metrics.portfolioCacheMisses,
        cacheTtlMs: this._portfolioCache?.ttl ?? 0,
        cacheAgeMs: this._portfolioCache?.at ? (Date.now() - this._portfolioCache.at) : null,
        inflightJoins: this.metrics.portfolioInflightJoins,
        rateLimitedServed: this.metrics.portfolioRateLimitedServed,
        rateLimitCooldownRemainingMs: Math.max(0, this._rateLimitUntil - Date.now()),
      },
      limitOrderDiagnostics: {
        converted: this.metrics.limitOrderConverted,
        skippedWrongSide: this.metrics.limitOrderSkippedWrongSide,
        minAmount: MIN_LIMIT_ORDER_AMOUNT,
      },
      accountLoaded: !!(this._account && this._account.balance != null),
      acceptedMultipliers: ACCEPTED_MULTIPLIERS,
      accountType: this.config.accountType,
    };
  }

  getContractState(contractId) { return this._contractStates.get(String(contractId)) || null; }
  getAllContractStates() { return Array.from(this._contractStates.values()); }

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
    if (this._tradeReconcileTimer) { clearInterval(this._tradeReconcileTimer); this._tradeReconcileTimer = null; }
    this._reconcileMissCounts.clear();
    this._verifyUnknownCounts.clear();
    this._closedEmitted.clear();
    this._portfolioInflight = null;
    this._rateLimitUntil = 0;
    if (this._portfolioCache) { this._portfolioCache.contracts = null; this._portfolioCache.at = 0; }
  }
  _getReconnectDelay(attempt) {
    const base = this.config.reconnectBaseDelay;
    const max = this.config.maxReconnectDelay;
    const delay = Math.min(base * Math.pow(2, attempt), max);
    return Math.round(delay * (0.8 + 0.4 * Math.random()));
  }

  /**
   * [FIX-SWITCH] Switch between demo and real accounts.
   *
   * Deriv does not allow hot-swapping between demo and real accounts on
   * the same WebSocket connection. Each account type requires its own
   * OTP-backed authenticated WebSocket. This method orchestrates the full
   * teardown/rebuild cycle and rolls back to the previous account on any
   * failure.
   *
   * Public WS (market data) is account-agnostic and stays connected —
   * only the auth WS and account-scoped state are torn down.
   *
   * @param {string} newType - 'demo' | 'real'
   * @returns {Promise<{changed:boolean, accountType:string, previousAccountType:string, account:Object}>}
   * @throws {Error} code='OPEN_POSITIONS' if positions exist on current account
   * @throws {Error} code='SWITCH_FAILED'  if the switch or rollback path fails
   */
  async switchAccountType(newType) {
    if (newType !== 'demo' && newType !== 'real') {
      throw new Error(`Invalid account type "${newType}". Must be "demo" or "real".`);
    }

    const previousType = this.config.accountType;
    if (newType === previousType) {
      const account = await this.getAccount();
      return {
        changed: false,
        accountType: newType,
        previousAccountType: previousType,
        account,
      };
    }

    // Guard: refuse if any open positions on current account
    let positions = [];
    try { positions = await this.getOpenTrades(); }
    catch (_) { positions = []; }
    if (Array.isArray(positions) && positions.length > 0) {
      const err = new Error(
        `Cannot switch account type: ${positions.length} open position(s). ` +
        `Close all positions on the current account first.`
      );
      err.code = 'OPEN_POSITIONS';
      err.positions = positions.map(p => ({
        id: p.id, instrument: p.instrument, side: p.side,
        units: p.units, unrealizedPL: p.unrealizedPL,
      }));
      throw err;
    }

    // Save for rollback
    const previousAccountId = this.config.accountId;
    const previousAccount = this._account;

    logger.info(`[DerivBroker] Switching account type: ${previousType} → ${newType}`);

    const clearAccountState = () => {
      this._account = null;
      this._accountReady = null;
      this._accountReadyResolve = null;
      this._portfolioCache = { contracts: null, at: 0, ttl: 3000 };
      this._portfolioInflight = null;
      this._rateLimitUntil = 0;
      this._openPositions = [];
      this._closedEmitted.clear();
      this._reconcileMissCounts.clear();
      this._verifyUnknownCounts.clear();
      if (this._authReconnectTimer) {
        clearTimeout(this._authReconnectTimer);
        this._authReconnectTimer = null;
      }
    };

    try {
      // Update config; null accountId forces _resolveAccountId to pick by type
      this.config.accountType = newType;
      this.config.accountId = null;

      // Tear down + rebuild auth connection
      this._closeAuthSocket();
      clearAccountState();

      await this._connectAuth();
      await this._ensureBalanceLoaded();

      const account = await this.getAccount();

      logger.info(
        `[DerivBroker] Switched to ${newType} account: ${account.id} ` +
        `(balance=${account.balance} ${account.currency || 'USD'})`
      );

      // Refresh portfolio for new account
      if (this._portfolioCache) this._portfolioCache.at = 0;
      try { await this.getOpenTrades(); } catch (_) {}

      try {
        this.emit('accountSwitched', {
          previousAccountType: previousType,
          newAccountType: newType,
          account,
        });
      } catch (_) {}

      return {
        changed: true,
        accountType: newType,
        previousAccountType: previousType,
        account,
      };
    } catch (err) {
      logger.error(
        `[DerivBroker] Failed to switch to ${newType}: ${err.message}. ` +
        `Rolling back to ${previousType}.`
      );

      // Rollback
      try {
        this.config.accountType = previousType;
        this.config.accountId = previousAccountId;
        this._closeAuthSocket();
        clearAccountState();

        await this._connectAuth();
        await this._ensureBalanceLoaded();

        if (previousAccount) this._account = previousAccount;

        logger.warn(`[DerivBroker] Rollback to ${previousType} complete`);
      } catch (rollbackErr) {
        logger.error(
          `[DerivBroker] Rollback to ${previousType} ALSO FAILED: ` +
          `${rollbackErr.message}. Broker may be in inconsistent state. ` +
          `Manual restart may be required.`
        );
      }

      const wrapped = new Error(`Failed to switch to ${newType}: ${err.message}`);
      wrapped.code = 'SWITCH_FAILED';
      wrapped.previousAccountType = previousType;
      wrapped.targetAccountType = newType;
      wrapped.originalError = err.message;
      throw wrapped;
    }
  }
}

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
  heartbeatTimeout: parseInt(process.env.DERIV_HEARTBEAT_TIMEOUT) || 120000,
  wsPingIntervalMs: parseInt(process.env.DERIV_WS_PING_INTERVAL) || 20000,
  balanceTimeout: parseInt(process.env.DERIV_BALANCE_TIMEOUT) || 10000,
  contractPersistIntervalMs: parseInt(process.env.DERIV_CONTRACT_PERSIST_INTERVAL_MS) || 3000,
  contractSubscribeTimeout: parseInt(process.env.DERIV_CONTRACT_SUBSCRIBE_TIMEOUT) || 15000,
  tradeReconcileIntervalMs: parseInt(process.env.DERIV_TRADE_RECONCILE_INTERVAL) || 30000,
  tradeReconcileMinAgeMs: parseInt(process.env.DERIV_TRADE_RECONCILE_MIN_AGE) || 60000,
  tradeReconcileMissesRequired: parseInt(process.env.DERIV_TRADE_RECONCILE_MISSES) || 2,
});

module.exports = brokerInstance;
module.exports.DerivBroker = DerivBroker; 
