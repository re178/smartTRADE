// core/execution/broker.js – Production Deriv WebSocket Driver (Multipliers + CFDs)

const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { sleep } = require('../../shared/helpers');
const logger = require('../../infrastructure/logger') || console;
const Order = require('../../models/Order');

EventEmitter.defaultMaxListeners = 20;

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
};

const CB_STATE = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

// --- Helpers ---
let _requestCounter = 0;

function generateRequestId() {
  return ++_requestCounter;
}

function generateClientOrderId() {
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

// ---------- Hardcoded fallback symbols ----------
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

// ---------- Rate Limiter ----------
class RateLimiter {
  constructor(rate, capacity) {
    this.rate = rate;
    this.capacity = capacity;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  async acquire() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
    this.lastRefill = now;
    if (this.tokens < 1) {
      const waitTime = (1 - this.tokens) / this.rate * 1000;
      await sleep(Math.ceil(waitTime));
      return this.acquire();
    }
    this.tokens--;
    return true;
  }
}

// ---------- Streaming Manager ----------
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
      logger.warn(`[Streaming] Subscription ${key} already exists.`);
      return;
    }
    await this.broker._ensureReady();
    const response = await this.broker._sendRequest({ [type]: symbol, subscribe: 1 });
    const subscriptionId = response.subscription?.id;
    if (!subscriptionId) {
      logger.error(`[Streaming] No subscription ID for ${key}`);
      return;
    }
    this._subscriptions.set(key, { type, symbol, subscriptionId, callback });
    this._subscriptionIdMap.set(subscriptionId, key);
    logger.info(`[Streaming] Subscribed to ${key} (ID: ${subscriptionId})`);
  }

  async unsubscribe(type, symbol) {
    const key = `${type}:${symbol}`;
    const sub = this._subscriptions.get(key);
    if (!sub) return;
    await this.broker._sendRequest({ forget: sub.subscriptionId });
    this._subscriptions.delete(key);
    this._subscriptionIdMap.delete(sub.subscriptionId);
    this._priceCache.delete(symbol);
    logger.info(`[Streaming] Unsubscribed from ${key}`);
  }

  restoreSubscriptions() {
    if (this._subscriptions.size === 0) {
      logger.info('[Streaming] No subscriptions to restore.');
      return;
    }
    logger.info('[Streaming] Restoring subscriptions...');
    this.broker._sendRequest({ forget_all: 'ticks' })
      .then(() => {
        for (const [key, sub] of this._subscriptions) {
          this.broker._sendRequest({ [sub.type]: sub.symbol, subscribe: 1 })
            .then((response) => {
              const newId = response.subscription?.id;
              if (newId) {
                this._subscriptionIdMap.delete(sub.subscriptionId);
                sub.subscriptionId = newId;
                this._subscriptionIdMap.set(newId, key);
                logger.info(`[Streaming] Restored ${key} (new ID: ${newId})`);
              }
            })
            .catch((err) => logger.error(`[Streaming] Failed to restore ${key}:`, err.message));
        }
      })
      .catch((err) => logger.error('[Streaming] Failed to clear old subscriptions:', err.message));
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
        sub.callback(tick);
        break;
      }
    }
  }

  getPrice(symbol) {
    return this._priceCache.get(symbol) || null;
  }

  getAllPrices() {
    return Object.fromEntries(this._priceCache);
  }
}

// ---------- PROPOSAL BUILDER (Extended for CFDs) ----------
class DerivProposalBuilder {
  constructor(broker) {
    this.broker = broker;
  }

  /**
   * Build the proposal request payload.
   * @param {string} instrument – e.g., 'EUR_USD'
   * @param {number} units – positive for BUY, negative for SELL
   * @param {number|null} stopLoss – stop loss price (optional)
   * @param {number|null} takeProfit – take profit price (optional)
   * @param {string} orderType – 'market' or 'limit'
   * @param {number} limitPrice – for limit orders (ignored for market)
   * @returns {Object} proposal payload
   */
  buildProposal(instrument, units, stopLoss, takeProfit, orderType, limitPrice = 0) {
    const symbol = toDerivSymbol(instrument, this.broker.symbolMap);
    if (!symbol) throw new Error(`Unknown instrument: ${instrument}`);
    const amount = Math.abs(units);
    if (amount <= 0) throw new Error('Order amount must be greater than zero.');
    const side = units > 0 ? 'BUY' : 'SELL';

    // Get product type from broker config
    const productType = this.broker.productType || 'multiplier';

    // Base proposal payload
    const proposalPayload = {
      proposal: 1,
      amount,
      basis: 'stake',
      currency: 'USD',
      symbol,
      product_type: 'basic',
    };

    // Configure for product type
    if (productType === 'cfd') {
      // For CFDs, we use 'CALL' or 'PUT' contract type based on direction
      // For spot CFDs, we use 'CALL' for BUY and 'PUT' for SELL
      // with duration_unit: 'tick' (no expiry)
      proposalPayload.contract_type = side === 'BUY' ? 'CALL' : 'PUT';
      proposalPayload.duration_unit = 't';
      proposalPayload.duration = 1; // 1 tick (no expiry)
    } else {
      // Multipliers
      proposalPayload.contract_type = 'MULTUP';
      // Ensure multiplier is valid
      const validMultipliers = [100, 200, 300, 500, 800];
      let multiplier = this.broker.config.leverage || 100;
      if (!validMultipliers.includes(multiplier)) {
        multiplier = 100;
        logger.warn(`[DerivBroker] Invalid multiplier, using default 100`);
      }
      proposalPayload.multiplier = multiplier;
    }

    // Add limit order for stop loss and take profit (for both products)
    const limitOrder = {};
    if (stopLoss !== null && stopLoss !== undefined && !isNaN(stopLoss) && stopLoss > 0) {
      limitOrder.stop_loss = stopLoss;
    }
    if (takeProfit !== null && takeProfit !== undefined && !isNaN(takeProfit) && takeProfit > 0) {
      limitOrder.take_profit = takeProfit;
    }
    if (Object.keys(limitOrder).length > 0) {
      proposalPayload.limit_order = limitOrder;
    }

    return proposalPayload;
  }
}

// ---------- Order Builder (for legacy compatibility) ----------
class DerivOrderBuilder {
  constructor(broker) {
    this.broker = broker;
  }

  build(instrument, units, price, stopLoss, takeProfit, orderType) {
    // This is kept for compatibility with the existing proposal flow
    const symbol = toDerivSymbol(instrument, this.broker.symbolMap);
    if (!symbol) throw new Error(`Unknown instrument: ${instrument}`);
    const amount = Math.abs(units);
    if (amount <= 0) throw new Error('Order amount must be greater than zero.');
    const payload = {
      buy: symbol,
      amount: amount,
      price: orderType === 'market' ? 0 : price,
    };
    if (stopLoss !== null && stopLoss !== undefined && !isNaN(stopLoss) && stopLoss > 0) {
      payload.stop_loss = stopLoss;
    }
    if (takeProfit !== null && takeProfit !== undefined && !isNaN(takeProfit) && takeProfit > 0) {
      payload.take_profit = takeProfit;
    }
    return payload;
  }
}

// ---------- Broker Capabilities ----------
const BROKER_CAPABILITIES = {
  supportsTrailingStop: false,
  supportsHedging: false,
  supportsNetting: true,
  supportsPartialClose: true,
  supportsGuaranteedSL: false,
  supportsOCO: false,
  supportsMarketOrders: true,
  supportsLimitOrders: true,
  supportsStopOrders: true,
  supportsDemo: true,
  supportsLive: true,
  supportedMarkets: ['Forex', 'Indices', 'Commodities', 'Cryptocurrencies'],
};

// ---------- Main Broker Class ----------
class DerivBroker extends EventEmitter {
  constructor(config = {}) {
    super();

    const appId = config.appId || process.env.DERIV_APP_ID || '1089';

    this.config = {
      apiToken: config.apiToken || process.env.DERIV_API_TOKEN,
      appId: appId,
      wsUrl: config.wsUrl || process.env.DERIV_WS_URL || `wss://ws.derivws.com/websockets/v3?app_id=${appId}`,
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
      contractType: config.contractType || 'cfd',
      leverage: parseFloat(config.leverage || 100),
      duration: config.duration || null,
      riskValidator: config.riskValidator || null,
      fatalAfterAuthFailures: parseInt(config.fatalAfterAuthFailures || 3),
      readinessTimeout: parseInt(config.readinessTimeout || process.env.DERIV_READINESS_TIMEOUT || 30000),
      symbolTimeout: parseInt(config.symbolTimeout || process.env.DERIV_SYMBOL_TIMEOUT || 10000),
    };

    // Product type (multiplier or cfd)
    this.productType = config.productType || process.env.TRADING_PRODUCT || 'multiplier';

    this.validateConfig();

    this._state = STATE.DISCONNECTED;
    this._socket = null;
    this._pendingRequests = new Map();
    this._messageQueue = [];
    this._heartbeatInterval = null;
    this._connectionPromise = null;
    this._rateLimiter = new RateLimiter(this.config.rateLimit, this.config.rateCapacity);

    this.streaming = new StreamingManager(this);

    this._cbState = CB_STATE.CLOSED;
    this._cbFailureCount = 0;
    this._cbOpenedAt = null;

    // Fallback symbols
    this.symbolMap = { ...FALLBACK_SYMBOLS };
    this.reverseMap = {};
    for (const [key, val] of Object.entries(FALLBACK_SYMBOLS)) {
      this.reverseMap[val] = key;
    }
    this.spreadMap = {};
    for (const key of Object.keys(FALLBACK_SYMBOLS)) {
      this.spreadMap[FALLBACK_SYMBOLS[key]] = 0.0001;
    }
    logger.info(`[DerivBroker] Using fallback symbols (${Object.keys(this.symbolMap).length} pairs).`);

    this._orders = new Map();
    this._orderMap = new Map();

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
    };

    this.capabilities = { ...BROKER_CAPABILITIES };
    this.proposalBuilder = new DerivProposalBuilder(this);
    this.orderBuilder = new DerivOrderBuilder(this);
    this._session = { isOpen: true, accountEnabled: true, marginSufficient: true, lastCheck: null };
    this.metadata = { name: 'Deriv', version: '1.0.0' };
    this._authFailCount = 0;
    this._account = null;

    logger.info(`[DerivBroker] Created with product type: ${this.productType}`);
  }

  validateConfig() {
    if (!this.config.apiToken) throw new Error('DERIV_API_TOKEN is required');
    if (!this.config.appId) throw new Error('DERIV_APP_ID is required');
    if (!this.config.wsUrl || !this.config.wsUrl.startsWith('ws')) throw new Error('Invalid WebSocket URL');
    if (this.config.maxQueueSize < 1) throw new Error('maxQueueSize must be at least 1');
    logger.info('[DerivBroker] Configuration validated.');
  }

  async connect() {
    if (this._state === STATE.READY) return;
    if (this._state === STATE.FATAL) {
      throw new Error('Broker in FATAL state – check credentials.');
    }
    if (this._connectionPromise) return this._connectionPromise;
    this._connectionPromise = this._doConnect();
    try {
      await this._connectionPromise;
    } finally {
      this._connectionPromise = null;
    }
  }

  async _doConnect() {
    this._setState(STATE.CONNECTING);
    this._closeSocket();
    logger.info(`[DerivBroker] Connecting to ${this.config.wsUrl}`);

    return new Promise((resolve, reject) => {
      let attempts = 0;
      const attemptConnect = async () => {
        if (this._state === STATE.FATAL) {
          reject(new Error('FATAL: Broker stopped.'));
          return;
        }
        if (this._state === STATE.READY) {
          resolve();
          return;
        }
        attempts++;
        if (attempts > 3) {
          this._setState(STATE.FATAL);
          reject(new Error('Connection failed after 3 attempts.'));
          return;
        }

        this._setState(STATE.CONNECTING);
        logger.info(`[DerivBroker] Connection attempt ${attempts}`);

        try {
          this._socket = new WebSocket(this.config.wsUrl);
          const socket = this._socket;

          socket.on('open', () => {
            logger.info('[DerivBroker] WebSocket connected.');
            this._setState(STATE.CONNECTED);
            this.metrics.connectedSince = Date.now();
            this._startHeartbeat();

            this._authorize()
              .then(async (authResponse) => {
                if (authResponse && authResponse.authorize) {
                  this._account = authResponse.authorize;
                  logger.info('[DerivBroker] Account stored from authorize.');
                }
                logger.info('[DerivBroker] Authorized.');
                this._authFailCount = 0;
                this._setState(STATE.AUTHENTICATING);

                logger.info('[DerivBroker] Startup: Loading symbols (with timeout)...');
                try {
                  await this._loadSymbolsWithTimeout();
                  logger.info('[DerivBroker] Startup: Symbols loaded.');
                } catch (err) {
                  logger.warn('[DerivBroker] Startup: Symbol loading failed, using fallback:', err.message);
                }

                this._setState(STATE.READY);
                logger.info('[DerivBroker] Startup: Broker READY (early).');

                setImmediate(() => {
                  logger.info('[DerivBroker] Startup: Restoring subscriptions (background)...');
                  this.streaming.restoreSubscriptions();

                  logger.info('[DerivBroker] Startup: Reconciling positions (background)...');
                  this._reconcilePositions()
                    .then(() => logger.info('[DerivBroker] Startup: Positions reconciled.'))
                    .catch((err) => logger.error('[DerivBroker] Startup: Position reconciliation error:', err.message));

                  logger.info('[DerivBroker] Startup: Loading pending orders (background)...');
                  this._loadPendingOrders()
                    .then(() => logger.info('[DerivBroker] Startup: Pending orders loaded.'))
                    .catch((err) => logger.error('[DerivBroker] Startup: Pending orders loading error:', err.message));
                });

                this.emit('ready');
                this.emit('connected');
                resolve();
              })
              .catch((err) => {
                logger.error('[DerivBroker] Authorization failed:', err.message);
                this._authFailCount++;
                if (this._authFailCount >= this.config.fatalAfterAuthFailures) {
                  logger.error(`[DerivBroker] Too many auth failures (${this._authFailCount}). FATAL.`);
                  this._setState(STATE.FATAL);
                  this._closeSocket();
                  reject(new Error(`Authorization failed ${this._authFailCount} times.`));
                  return;
                }
                this._setState(STATE.FAILED);
                this._closeSocket();
                setTimeout(() => attemptConnect(), this.config.reconnectBaseDelay);
              });
          });

          socket.on('message', (data) => this._handleMessage(data));
          socket.on('error', (err) => {
            logger.error('[DerivBroker] WebSocket error:', err.message);
          });
          socket.on('close', (code, reason) => {
            logger.info(`[DerivBroker] WebSocket closed. Code: ${code}, Reason: ${reason || 'No reason'}`);
            if (this._state === STATE.READY || this._state === STATE.CONNECTED) {
              this._setState(STATE.RECONNECTING);
              setTimeout(() => attemptConnect(), this.config.reconnectBaseDelay);
            }
          });

          const timeout = setTimeout(() => {
            if (this._state !== STATE.READY && this._state !== STATE.CONNECTED) {
              logger.error('[DerivBroker] Connection attempt timed out.');
              this._closeSocket();
              reject(new Error('Connection attempt timed out'));
            }
          }, this.config.connectionTimeout);
          this.once('connected', () => clearTimeout(timeout));
        } catch (err) {
          this._setState(STATE.FAILED);
          reject(err);
        }
      };

      attemptConnect();
    });
  }

  _setState(newState) {
    const old = this._state;
    this._state = newState;
    logger.debug(`[DerivBroker] State: ${old} → ${newState}`);
    this.emit('stateChange', { from: old, to: newState });
  }

  _authorize() {
    return new Promise((resolve, reject) => {
      const payload = { authorize: this.config.apiToken };
      const timeout = setTimeout(() => {
        reject(new Error('Authorize timeout'));
      }, 10000);

      const handler = (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.error) {
            clearTimeout(timeout);
            reject(new Error(`Deriv API error: ${msg.error.code} - ${msg.error.message}`));
          } else if (msg.authorize !== undefined) {
            clearTimeout(timeout);
            resolve(msg);
          }
        } catch (err) {
          // ignore
        }
      };

      this._socket.once('message', handler);
      this._sendRaw(payload);
      const timeoutHandler = setTimeout(() => {
        this._socket.removeListener('message', handler);
        reject(new Error('Authorize timeout'));
      }, 10000);
      this._pendingRequests.set('_auth', { timeout: timeoutHandler });
    });
  }

  _getReconnectDelay(attempt) {
    const base = this.config.reconnectBaseDelay;
    const max = this.config.maxReconnectDelay;
    const delay = Math.min(base * Math.pow(2, attempt), max);
    const jitter = delay * (0.8 + 0.4 * Math.random());
    return Math.round(jitter);
  }

  _recordFailure() {
    if (this._cbState === CB_STATE.OPEN) return;
    this._cbFailureCount++;
    if (this._cbFailureCount >= this.config.circuitBreakerThreshold) {
      this._cbState = CB_STATE.OPEN;
      this._cbOpenedAt = Date.now();
      logger.warn('[DerivBroker] Circuit breaker OPEN.');
      setTimeout(() => {
        this._cbState = CB_STATE.HALF_OPEN;
        logger.warn('[DerivBroker] Circuit breaker HALF-OPEN.');
      }, this.config.circuitBreakerTimeout);
    }
  }

  _resetCircuitBreaker() {
    this._cbState = CB_STATE.CLOSED;
    this._cbFailureCount = 0;
    this._cbOpenedAt = null;
  }

  _isRequestAllowed() {
    if (this._cbState === CB_STATE.OPEN) return false;
    return true;
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatInterval = setInterval(() => {
      if (this._state === STATE.READY || this._state === STATE.CONNECTED) {
        this._sendRaw({ ping: 1 });
        this.metrics.lastHeartbeat = Date.now();
      }
    }, 30000);
  }

  _stopHeartbeat() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
  }

  _handleMessage(rawData) {
    try {
      const msg = JSON.parse(rawData);

      if (msg.req_id && this._pendingRequests.has(msg.req_id)) {
        const pending = this._pendingRequests.get(msg.req_id);
        clearTimeout(pending.timeout);
        this._pendingRequests.delete(msg.req_id);
        const latency = Date.now() - pending.sentAt;
        this.metrics.totalLatency += latency;
        this.metrics.latencyCount++;
        if (msg.error) {
          this.metrics.requestsFailed++;
          this._recordFailure();
          pending.reject(new Error(`Deriv API error: ${msg.error.code} - ${msg.error.message}`));
        } else {
          this.metrics.requestsSent++;
          this._resetCircuitBreaker();
          this._handleOrderResponse(msg);
          pending.resolve(msg);
        }
        return;
      }

      if (msg.pong) {
        this.metrics.lastHeartbeat = Date.now();
        return;
      }

      if (msg.msg_type === 'tick' && msg.tick) {
        this.streaming.handleTick(msg.tick);
        return;
      }

      if (msg.buy || msg.sell) {
        this._handleOrderResponse(msg);
      }
    } catch (err) {
      logger.error('[DerivBroker] Error parsing WebSocket message:', err.message);
    }
  }

  _handleOrderResponse(msg) {
    if (msg.echo_req && msg.echo_req.client_order_id) {
      const clientOrderId = msg.echo_req.client_order_id;
      const tx = msg.buy || msg.sell;
      if (tx) {
        const contractId = tx.contract_id || tx.transaction_id;
        const status = tx.status || 'FILLED';
        this._updateOrderStatus(clientOrderId, status, contractId, tx);
      }
    }
  }

  _sendRaw(payload) {
    if (this._state !== STATE.READY && this._state !== STATE.CONNECTED && this._state !== STATE.AUTHENTICATING) {
      if (this._messageQueue.length < this.config.maxQueueSize) {
        this._messageQueue.push(payload);
      } else {
        logger.error('[DerivBroker] Queue full, dropping message.');
      }
      return;
    }
    try {
      this._socket.send(JSON.stringify(payload));
    } catch (err) {
      logger.error('[DerivBroker] Send error:', err.message);
    }
  }

  async _sendRequest(payload, timeoutMs = 15000, signal = null) {
    await this._rateLimiter.acquire();
    if (this._state === STATE.FATAL) {
      throw new Error('Broker in FATAL state.');
    }
    if (this._state !== STATE.READY) {
      await this._ensureReady();
    }
    if (!this._isRequestAllowed()) throw new Error('Circuit breaker is OPEN');

    let lastError = null;
    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        if (signal && signal.aborted) throw new Error('Request cancelled');
        const result = await this._sendRawRequest(payload, timeoutMs, signal);
        if (this._cbState === CB_STATE.HALF_OPEN) this._resetCircuitBreaker();
        return result;
      } catch (err) {
        lastError = err;
        logger.warn(`[DerivBroker] Request failed (attempt ${attempt}):`, err.message);
        if (attempt < this.config.maxRetries) {
          await sleep(this._getReconnectDelay(attempt));
          if (signal && signal.aborted) throw new Error('Request cancelled');
          await this.connect();
        }
      }
    }
    this._recordFailure();
    throw lastError;
  }

  _sendRawRequest(payload, timeoutMs = 15000, signal = null) {
    return new Promise((resolve, reject) => {
      const reqId = generateRequestId();
      const msg = { ...payload, req_id: reqId };
      const timeout = setTimeout(() => {
        if (this._pendingRequests.has(reqId)) {
          this._pendingRequests.delete(reqId);
          reject(new Error(`Request timed out (${timeoutMs}ms)`));
        }
      }, timeoutMs);
      const onCancel = () => {
        clearTimeout(timeout);
        if (this._pendingRequests.has(reqId)) {
          this._pendingRequests.delete(reqId);
          reject(new Error('Request cancelled'));
        }
      };
      if (signal) signal.addEventListener('abort', onCancel, { once: true });
      this._pendingRequests.set(reqId, {
        resolve,
        reject,
        timeout,
        sentAt: Date.now(),
        cancel: onCancel,
        signal,
      });
      logger.debug(`[DerivBroker] Sending: ${JSON.stringify(msg)}`);
      this._sendRaw(msg);
    });
  }

  _flushQueue() {
    while (this._messageQueue.length > 0) {
      const msg = this._messageQueue.shift();
      this._sendRaw(msg);
    }
  }

  async _loadSymbolsWithTimeout() {
    return Promise.race([
      this._loadSymbols(),
      sleep(this.config.symbolTimeout).then(() => {
        throw new Error(`Symbol loading timed out after ${this.config.symbolTimeout}ms`);
      })
    ]);
  }

  async _loadSymbols() {
    logger.info('[DerivBroker] Fetching active symbols...');
    try {
      const response = await this._sendRequest({ active_symbols: 'brief' }, 10000);
      const symbols = response.active_symbols || [];
      if (symbols.length > 0) {
        this._buildSymbolMaps(symbols);
        logger.info(`[DerivBroker] Loaded ${symbols.length} symbols (brief).`);
        return;
      }
    } catch (err) {
      logger.warn('[DerivBroker] Brief symbol request failed:', err.message);
    }

    try {
      const response = await this._sendRequest({ active_symbols: 'all' }, 10000);
      const symbols = response.active_symbols || [];
      if (symbols.length > 0) {
        this._buildSymbolMaps(symbols);
        logger.info(`[DerivBroker] Loaded ${symbols.length} symbols (all).`);
        return;
      }
    } catch (err) {
      logger.warn('[DerivBroker] All symbol request failed:', err.message);
    }

    logger.warn('[DerivBroker] Using fallback symbols.');
  }

  _buildSymbolMaps(symbols) {
    for (const sym of symbols) {
      const derivSymbol = sym.symbol;
      const display = sym.display_name || '';
      const match = display.match(/([A-Z]{3})\/([A-Z]{3})/);
      if (match) {
        const ourPair = match[1] + '_' + match[2];
        this.symbolMap[ourPair] = derivSymbol;
        this.reverseMap[derivSymbol] = ourPair;
        const pip = sym.pip || 0.0001;
        this.spreadMap[derivSymbol] = pip * 0.5;
      }
    }
    logger.info(`[DerivBroker] Symbol map built: ${Object.keys(this.symbolMap).length} forex pairs.`);
  }

  async _loadPendingOrders() {
    logger.info('[DerivBroker] Loading pending orders from MongoDB...');
    const pendingOrders = await Order.find({ status: { $in: ['PENDING', 'ACCEPTED', 'EXECUTING'] } });
    for (const order of pendingOrders) {
      this._orders.set(order.clientOrderId, order);
      if (order.contractId) {
        this._orderMap.set(order.contractId, order.clientOrderId);
      }
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

  async _reconcilePositions() {
    logger.info('[DerivBroker] Reconciling positions...');
    try {
      const response = await this._sendRequest({ portfolio: 1 });
      let brokerPositions = response.portfolio || [];
      if (!Array.isArray(brokerPositions)) {
        logger.warn('[Reconcile] portfolio is not an array, converting object to array');
        brokerPositions = Object.values(brokerPositions);
      }
      const dbOrders = await Order.find({ status: ORDER_STATUS.FILLED });
      const dbMap = new Map();
      for (const ord of dbOrders) {
        if (ord.contractId) dbMap.set(ord.contractId, ord);
      }

      for (const pos of brokerPositions) {
        const contractId = pos.contract_id;
        if (!contractId) continue;
        const existing = dbMap.get(contractId);
        if (!existing) {
          const side = pos.buy ? 'BUY' : 'SELL';
          const instrument = fromDerivSymbol(pos.symbol, this.reverseMap) || 'UNKNOWN';
          const amount = pos.amount || 0;
          const units = Math.abs(amount) || 0.01;
          const entryPrice = pos.buy_price || pos.entry_spot || 0;
          if (isNaN(units) || units <= 0 || !instrument || !side) {
            logger.warn(`[Reconcile] Skipping position with invalid data: ${JSON.stringify(pos)}`);
            continue;
          }
          const newOrder = new Order({
            clientOrderId: generateClientOrderId(),
            instrument,
            side,
            units,
            entryPrice,
            status: ORDER_STATUS.FILLED,
            contractId: contractId,
            filledAt: new Date(),
          });
          await newOrder.save();
          this._orders.set(newOrder.clientOrderId, newOrder);
          this._orderMap.set(contractId, newOrder.clientOrderId);
          logger.warn(`[Reconcile] Created order for position ${contractId}`);
        } else {
          this._orders.set(existing.clientOrderId, existing);
          this._orderMap.set(contractId, existing.clientOrderId);
        }
      }

      for (const [contractId, clientOrderId] of this._orderMap) {
        const stillOpen = brokerPositions.some(p => p.contract_id === contractId);
        if (!stillOpen) {
          await this._updateOrderStatus(clientOrderId, ORDER_STATUS.CLOSED);
          this._orderMap.delete(contractId);
        }
      }
      logger.info('[Reconcile] Position reconciliation complete.');
    } catch (err) {
      logger.error('[Reconcile] Failed:', err.message);
      throw err;
    }
  }

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
      if (!result.approved) {
        throw new Error(`Risk validation failed: ${result.reason}`);
      }
    }
    const account = await this.getAccount();
    const marginAvailable = parseFloat(account.marginAvailable);
    if (marginAvailable <= 0) {
      throw new Error('Insufficient margin');
    }
  }

  // ---------- Public API ----------
  async getAccount() {
    await this._ensureReady();
    if (!this._account) {
      logger.warn('[DerivBroker] Account not yet available, returning default.');
      return this._getDefaultAccount();
    }
    const acc = this._account;
    return {
      id: acc.loginid || 'N/A',
      balance: acc.balance || '0',
      currency: acc.currency || 'USD',
      equity: acc.balance || '0',
      marginUsed: '0',
      marginAvailable: acc.balance || '0',
      createdTime: new Date().toISOString(),
    };
  }

  _getDefaultAccount() {
    return {
      id: 'DEMO_ACCOUNT',
      balance: '0',
      currency: 'USD',
      equity: '0',
      marginUsed: '0',
      marginAvailable: '0',
      createdTime: new Date().toISOString(),
    };
  }

  async getPrices(instruments) {
    await this._ensureReady();
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
      const response = await this._sendRequest({ ticks: symbol });
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

  async getCandles(instrument, count = 100, granularity = 'M5') {
    await this._ensureReady();
    const symbol = toDerivSymbol(instrument, this.symbolMap);
    if (!symbol) throw new Error(`Unknown instrument: ${instrument}`);
    const intervalMap = {
      'M1': 60, 'M5': 300, 'M15': 900, 'M30': 1800,
      'H1': 3600, 'H4': 14400, 'D': 86400,
    };
    const seconds = intervalMap[granularity] || 300;
    const end = Math.floor(Date.now() / 1000);
    const start = end - (count * seconds + 10);
    const response = await this._sendRequest({
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

  // ---------- ORDER PLACEMENT (PROPOSAL + BUY) ----------
  async placeMarketOrder(instrument, units, stopLoss = null, takeProfit = null) {
    await this._ensureReady();
    const amount = Math.abs(units);
    if (amount <= 0) throw new Error('Order units must be greater than zero.');
    await this._validateOrderRisk(instrument, units > 0 ? 'BUY' : 'SELL', amount, stopLoss, takeProfit);

    // 1. Build proposal
    const proposalPayload = this.proposalBuilder.buildProposal(instrument, units, stopLoss, takeProfit, 'market');

    // 2. Send proposal request
    logger.info('[placeMarketOrder] Sending proposal:', JSON.stringify(proposalPayload));
    const proposalResponse = await this._sendRequest(proposalPayload);
    if (!proposalResponse.proposal || !proposalResponse.proposal.id) {
      throw new Error('Proposal failed: no proposal ID returned');
    }
    const proposalId = proposalResponse.proposal.id;
    const price = proposalResponse.proposal.price || proposalResponse.proposal.buy_price || 0;

    // 3. Buy the proposal
    const buyPayload = {
      buy: proposalId,
      price: price,
    };
    logger.info('[placeMarketOrder] Buying proposal:', JSON.stringify(buyPayload));
    const buyResponse = await this._sendRequest(buyPayload);
    const tx = buyResponse.buy;
    const contractId = tx.contract_id || tx.transaction_id;
    const executedPrice = tx.buy_price || tx.price || 0;

    return {
      tradeID: contractId,
      id: contractId,
      price: executedPrice,
      averagePrice: executedPrice,
      raw: buyResponse,
    };
  }

  async placeLimitOrder(instrument, units, price, stopLoss = null, takeProfit = null) {
    await this._ensureReady();
    const amount = Math.abs(units);
    if (amount <= 0) throw new Error('Order units must be greater than zero.');
    await this._validateOrderRisk(instrument, units > 0 ? 'BUY' : 'SELL', amount, stopLoss, takeProfit);

    // For limit orders, we use the same proposal flow with the limit price
    const proposalPayload = this.proposalBuilder.buildProposal(instrument, units, stopLoss, takeProfit, 'limit');

    const proposalResponse = await this._sendRequest(proposalPayload);
    if (!proposalResponse.proposal || !proposalResponse.proposal.id) {
      throw new Error('Proposal failed: no proposal ID returned');
    }
    const proposalId = proposalResponse.proposal.id;
    const buyPayload = {
      buy: proposalId,
      price: price,
    };
    const buyResponse = await this._sendRequest(buyPayload);
    const tx = buyResponse.buy;
    const contractId = tx.contract_id || tx.transaction_id;
    const executedPrice = tx.buy_price || tx.price || price;

    return {
      tradeID: contractId,
      id: contractId,
      price: executedPrice,
      averagePrice: executedPrice,
      raw: buyResponse,
    };
  }

  async closeTrade(tradeId) {
    await this._ensureReady();
    if (!tradeId) throw new Error('tradeId is required');
    const payload = { sell: tradeId, price: 0 };
    try {
      const response = await this._sendRequest(payload);
      return response.sell;
    } catch (err) {
      logger.error('[closeTrade] Error:', err.message);
      throw err;
    }
  }

  async getOpenTrades() {
    await this._ensureReady();
    const response = await this._sendRequest({ portfolio: 1 });
    let contracts = response.portfolio || [];
    if (!Array.isArray(contracts)) {
      logger.warn('[getOpenTrades] portfolio is not an array, converting object to array');
      contracts = Object.values(contracts);
    }
    if (!Array.isArray(contracts) || contracts.length === 0) {
      return [];
    }
    return contracts
      .filter(c => c.contract_id)
      .map(c => ({
        id: c.contract_id,
        instrument: fromDerivSymbol(c.symbol, this.reverseMap) || 'UNKNOWN',
        side: c.buy ? 'BUY' : 'SELL',
        price: c.buy_price || c.entry_spot || 0,
        units: c.buy ? (c.amount || 0) : -(c.amount || 0),
        unrealizedPL: c.profit_loss || 0,
        currentPrice: c.current_spot || c.entry_spot || 0,
      }));
  }

  async getPositions() {
    return this.getOpenTrades();
  }

  getHealth() {
    const avgLatency = this.metrics.latencyCount > 0 ? this.metrics.totalLatency / this.metrics.latencyCount : 0;
    return {
      state: this._state,
      connected: this._state === STATE.READY || this._state === STATE.CONNECTED,
      authorized: this._state === STATE.READY || this._state === STATE.AUTHENTICATING,
      circuitBreaker: this._cbState,
      reconnectCount: this.metrics.reconnections,
      queueSize: this._messageQueue.length,
      pendingRequests: this._pendingRequests.size,
      lastHeartbeat: this.metrics.lastHeartbeat,
      averageLatency: avgLatency,
      uptime: this.metrics.connectedSince ? Date.now() - this.metrics.connectedSince : 0,
      orders: {
        placed: this.metrics.ordersPlaced,
        filled: this.metrics.ordersFilled,
        rejected: this.metrics.ordersRejected,
      },
      subscriptions: this.streaming._subscriptions.size,
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
    this._stopHeartbeat();

    const subs = Array.from(this.streaming._subscriptions.keys());
    for (const key of subs) {
      const sub = this.streaming._subscriptions.get(key);
      try {
        await this._sendRequest({ forget: sub.subscriptionId });
      } catch (e) {}
      this.streaming._subscriptions.delete(key);
    }

    for (const [id, pending] of this._pendingRequests) {
      clearTimeout(pending.timeout);
      if (pending.reject) pending.reject(new Error('Disconnected'));
      this._pendingRequests.delete(id);
    }

    if (this._socket) {
      this._socket.close();
      await new Promise((resolve) => {
        this._socket.once('close', resolve);
        setTimeout(resolve, 5000);
      });
      this._socket = null;
    }

    this._setState(STATE.DISCONNECTED);
    this._messageQueue = [];
    logger.info('[DerivBroker] Disconnected.');
  }

  _closeSocket() {
    this._stopHeartbeat();
    if (this._socket) {
      this._socket.terminate();
      this._socket = null;
    }
    for (const [id, pending] of this._pendingRequests) {
      clearTimeout(pending.timeout);
      if (pending.reject) pending.reject(new Error('Connection closed'));
      this._pendingRequests.delete(id);
    }
    if (this._state !== STATE.DISCONNECTED && this._state !== STATE.FATAL) {
      this._setState(STATE.DISCONNECTED);
    }
  }

  _ensureReady() {
    if (this._state === STATE.READY) return Promise.resolve();
    if (this._state === STATE.FATAL) {
      return Promise.reject(new Error('Broker in FATAL state.'));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListener('ready', onReady);
        reject(new Error(`Broker did not become ready within ${this.config.readinessTimeout}ms`));
      }, this.config.readinessTimeout);

      const onReady = () => {
        clearTimeout(timeout);
        resolve();
      };

      this.once('ready', onReady);

      if (this._state === STATE.DISCONNECTED || this._state === STATE.CONNECTING) {
        this.connect().catch((err) => {
          clearTimeout(timeout);
          this.removeListener('ready', onReady);
          reject(err);
        });
      }
    });
  }
}

// ---------- Singleton Export ----------
const brokerInstance = new DerivBroker({
  apiToken: process.env.DERIV_API_TOKEN,
  appId: process.env.DERIV_APP_ID,
  wsUrl: process.env.DERIV_WS_URL,
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
  contractType: process.env.DERIV_CONTRACT_TYPE || 'cfd',
  leverage: parseFloat(process.env.DERIV_LEVERAGE) || 100,
  duration: process.env.DERIV_DURATION || null,
  fatalAfterAuthFailures: parseInt(process.env.DERIV_FATAL_AFTER_AUTH_FAILURES) || 3,
  readinessTimeout: parseInt(process.env.DERIV_READINESS_TIMEOUT) || 30000,
  symbolTimeout: parseInt(process.env.DERIV_SYMBOL_TIMEOUT) || 10000,
  productType: process.env.TRADING_PRODUCT || 'multiplier',
});

module.exports = brokerInstance;
