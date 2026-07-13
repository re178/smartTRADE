// src/core/execution/broker.js – Deriv WebSocket Driver (with extended timeout and debug logs)

const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { sleep } = require('../../shared/helpers');
const logger = require('../../infrastructure/logger') || console;
const Order = require('../../../models/Order');

// ---------- Constants ----------
const STATE = {
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  AUTHENTICATING: 'AUTHENTICATING',
  READY: 'READY',
  RECONNECTING: 'RECONNECTING',
  FAILED: 'FAILED',
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

// ---------- Helpers ----------
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

function generateClientOrderId() {
  return `ord_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

function toDerivSymbol(pair, symbolMap) {
  const upper = pair.toUpperCase();
  if (symbolMap[upper]) return symbolMap[upper];
  return upper;
}

function fromDerivSymbol(symbol, reverseMap) {
  if (reverseMap[symbol]) return reverseMap[symbol];
  const clean = symbol.replace(/^frx/, '');
  if (clean.length === 6) {
    return clean.slice(0, 3) + '_' + clean.slice(3);
  }
  return symbol;
}

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

// ---------- Order Builder ----------
class DerivOrderBuilder {
  constructor(broker) {
    this.broker = broker;
  }

  build(instrument, units, price, stopLoss, takeProfit, orderType, leverage, duration) {
    const symbol = toDerivSymbol(instrument, this.broker.symbolMap);
    const amount = Math.abs(units);
    const payload = {
      buy: symbol,
      amount: amount,
      price: orderType === 'market' ? 0 : price,
    };
    if (stopLoss !== null) payload.stop_loss = stopLoss;
    if (takeProfit !== null) payload.take_profit = takeProfit;
    if (this.broker.config.contractType === 'multiplier') {
      payload.leverage = leverage || this.broker.config.leverage;
      if (duration) payload.duration = duration;
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
    // Configuration
    this.config = {
      apiToken: config.apiToken || process.env.DERIV_API_TOKEN,
      appId: config.appId || process.env.DERIV_APP_ID || '1089',
      wsUrl: config.wsUrl || process.env.DERIV_WS_URL || `wss://ws.deriv.com/websockets/v3?app_id=${this.appId}`,
      connectionTimeout: parseInt(config.connectionTimeout || process.env.DERIV_CONNECTION_TIMEOUT || 30000),
      reconnectBaseDelay: parseInt(config.reconnectBaseDelay || process.env.DERIV_RECONNECT_DELAY || 2000),
      maxReconnectDelay: parseInt(config.maxReconnectDelay || process.env.DERIV_MAX_RECONNECT_DELAY || 30000),
      maxRetries: parseInt(config.maxRetries || process.env.DERIV_MAX_RETRIES || 3),
      maxQueueSize: parseInt(config.maxQueueSize || process.env.DERIV_MAX_QUEUE_SIZE || 1000),
      circuitBreakerThreshold: parseInt(config.circuitBreakerThreshold || process.env.DERIV_CIRCUIT_BREAKER_THRESHOLD || 5),
      circuitBreakerTimeout: parseInt(config.circuitBreakerTimeout || process.env.DERIV_CIRCUIT_BREAKER_TIMEOUT || 60000),
      minOrderSize: parseFloat(config.minOrderSize || process.env.DERIV_MIN_ORDER_SIZE || 0.01),
      maxOrderSize: parseFloat(config.maxOrderSize || process.env.DERIV_MAX_ORDER_SIZE || 100),
      minStopDistance: parseFloat(config.minStopDistance || process.env.DERIV_MIN_STOP_DISTANCE || 0.0001),
      rateLimit: parseFloat(config.rateLimit || process.env.DERIV_RATE_LIMIT || 10),
      rateCapacity: parseFloat(config.rateCapacity || process.env.DERIV_RATE_CAPACITY || 20),
      contractType: config.contractType || process.env.DERIV_CONTRACT_TYPE || 'cfd',
      leverage: parseFloat(config.leverage || process.env.DERIV_LEVERAGE || 1),
      duration: config.duration || process.env.DERIV_DURATION || null,
      riskValidator: config.riskValidator || null,
    };

    this.validateConfig();

    // State machine
    this._state = STATE.DISCONNECTED;
    this._socket = null;
    this._pendingRequests = new Map();
    this._messageQueue = [];
    this._heartbeatInterval = null;
    this._connectionPromise = null;
    this._rateLimiter = new RateLimiter(this.config.rateLimit, this.config.rateCapacity);

    // Streaming manager
    this.streaming = new StreamingManager(this);

    // Circuit breaker
    this._cbState = CB_STATE.CLOSED;
    this._cbFailureCount = 0;
    this._cbOpenedAt = null;

    // Symbol maps
    this.symbolMap = {};
    this.reverseMap = {};
    this.spreadMap = {};

    // Order tracking
    this._orders = new Map();
    this._orderMap = new Map();

    // Metrics
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

    // Capabilities
    this.capabilities = { ...BROKER_CAPABILITIES };

    // Order builder placeholder
    this.orderBuilder = null;

    // Trading session
    this._session = {
      isOpen: true,
      accountEnabled: true,
      marginSufficient: true,
      lastCheck: null,
    };

    this.metadata = {
      name: 'Deriv',
      version: '1.0.0',
    };

    logger.info('[DerivBroker] Created. Call connect() to start.');
  }

  // ---------- Configuration ----------
  validateConfig() {
    if (!this.config.apiToken) throw new Error('DERIV_API_TOKEN is required');
    if (!this.config.appId) throw new Error('DERIV_APP_ID is required');
    if (!this.config.wsUrl || !this.config.wsUrl.startsWith('ws')) throw new Error('Invalid WebSocket URL');
    if (this.config.maxQueueSize < 1) throw new Error('maxQueueSize must be at least 1');
    logger.info('[DerivBroker] Configuration validated.');
  }

  // ---------- Connection Management ----------
  async connect() {
    if (this._state === STATE.READY) return;
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
      const attemptConnect = async (attempt = 0) => {
        if (this._state === STATE.RECONNECTING) {
          await sleep(this._getReconnectDelay(attempt));
          return attemptConnect(attempt + 1);
        }

        this._setState(STATE.CONNECTING);
        logger.info(`[DerivBroker] Connection attempt ${attempt + 1}`);

        try {
          this._socket = new WebSocket(this.config.wsUrl);
          const socket = this._socket;

          socket.on('open', () => {
            logger.info('[DerivBroker] WebSocket connected.');
            this._setState(STATE.CONNECTED);
            this.metrics.connectedSince = Date.now();
            if (attempt > 0) this.metrics.reconnections++;
            this._startHeartbeat();
            this._authorize()
              .then(async () => {
                logger.info('[DerivBroker] Authorized.');
                this._setState(STATE.AUTHENTICATING);
                await this._loadSymbols();
                this._setState(STATE.READY);
                this.streaming.restoreSubscriptions();
                this._flushQueue();
                this._resetCircuitBreaker();
                await this._reconcilePositions();
                await this._loadPendingOrders();
                this.emit('connected');
                resolve();
              })
              .catch((err) => {
                logger.error('[DerivBroker] Authorization failed:', err.message);
                this._setState(STATE.FAILED);
                this._closeSocket();
                this._scheduleReconnect(attempt + 1);
                reject(err);
              });
          });

          socket.on('message', (data) => this._handleMessage(data));
          socket.on('error', (err) => {
            logger.error('[DerivBroker] WebSocket error:', err.message);
            // Don't immediately reconnect; let 'close' handle it.
          });
          socket.on('close', (code, reason) => {
            logger.info(`[DerivBroker] WebSocket closed. Code: ${code}, Reason: ${reason || 'No reason'}`);
            if (this._state === STATE.READY || this._state === STATE.CONNECTED) {
              this._setState(STATE.RECONNECTING);
              this._scheduleReconnect(0);
            }
          });

          // Connection timeout - now configurable
          const timeout = setTimeout(() => {
            if (this._state !== STATE.CONNECTED) {
              logger.error(`[DerivBroker] Connection timeout after ${this.config.connectionTimeout}ms`);
              this._closeSocket();
              reject(new Error(`Connection timeout (${this.config.connectionTimeout}ms)`));
            }
          }, this.config.connectionTimeout);
          this.once('connected', () => clearTimeout(timeout));
        } catch (err) {
          this._setState(STATE.FAILED);
          reject(err);
        }
      };
      attemptConnect(0);
    });
  }

  _setState(newState) {
    const old = this._state;
    this._state = newState;
    logger.debug(`[DerivBroker] State: ${old} → ${newState}`);
    this.emit('stateChange', { from: old, to: newState });
  }

  _authorize() {
    return this._sendRawRequest({ authorize: this.config.apiToken }, 10000);
  }

  // ---------- Reconnection ----------
  _getReconnectDelay(attempt) {
    const base = this.config.reconnectBaseDelay;
    const max = this.config.maxReconnectDelay;
    const delay = Math.min(base * Math.pow(2, attempt), max);
    const jitter = delay * (0.8 + 0.4 * Math.random());
    return Math.round(jitter);
  }

  _scheduleReconnect(attempt = 0) {
    if (this._state === STATE.RECONNECTING) return;
    this._setState(STATE.RECONNECTING);
    const delay = this._getReconnectDelay(attempt);
    logger.info(`[DerivBroker] Scheduling reconnect in ${delay}ms`);
    setTimeout(() => {
      this._setState(STATE.CONNECTING);
      this.connect().catch((err) => logger.error('[DerivBroker] Reconnect failed:', err.message));
    }, delay);
  }

  // ---------- Circuit Breaker ----------
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

  // ---------- Heartbeat ----------
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

  // ---------- Message Handling ----------
  _handleMessage(rawData) {
    try {
      const msg = JSON.parse(rawData);

      // Response to a request with req_id
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

      // subscription confirmations are handled via req_id
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

  // ---------- Sending ----------
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
      this._scheduleReconnect(0);
    }
  }

  async _sendRequest(payload, timeoutMs = 15000, signal = null) {
    await this._rateLimiter.acquire();
    if (this._state !== STATE.READY) {
      await this.connect();
      if (this._state !== STATE.READY) throw new Error('Not ready');
    }
    if (!this._isRequestAllowed()) throw new Error('Circuit breaker is OPEN');

    // Idempotency check
    if (payload.client_order_id) {
      const existing = await Order.findOne({ clientOrderId: payload.client_order_id });
      if (existing && (existing.status === ORDER_STATUS.FILLED || existing.status === ORDER_STATUS.PENDING)) {
        throw new Error(`Duplicate order: ${payload.client_order_id}`);
      }
    }

    let lastError = null;
    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        if (signal && signal.aborted) throw new Error('Request cancelled');
        const result = await this._sendRawRequest(payload, timeoutMs, signal);
        if (this._cbState === CB_STATE.HALF_OPEN) this._resetCircuitBreaker();
        return result;
      } catch (err) {
        lastError = err;
        logger.warn(`[DerivBroker] Request failed (attempt ${attempt}/${this.config.maxRetries}):`, err.message);
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
      this._sendRaw(msg);
    });
  }

  _flushQueue() {
    while (this._messageQueue.length > 0) {
      const msg = this._messageQueue.shift();
      this._sendRaw(msg);
    }
  }

  // ---------- Symbol Loading ----------
  async _loadSymbols() {
    const response = await this._sendRawRequest({ active_symbols: 'all' }, 15000);
    const symbols = response.active_symbols || [];
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
    logger.info(`[DerivBroker] Loaded ${Object.keys(this.symbolMap).length} symbols.`);
    this.orderBuilder = new DerivOrderBuilder(this);
  }

  // ---------- Order Persistence ----------
  async _loadPendingOrders() {
    const pendingOrders = await Order.find({ status: { $in: ['PENDING', 'ACCEPTED', 'EXECUTING'] } });
    for (const order of pendingOrders) {
      this._orders.set(order.clientOrderId, order);
      if (order.contractId) {
        this._orderMap.set(order.contractId, order.clientOrderId);
      }
      logger.info(`[DerivBroker] Loaded pending order ${order.clientOrderId} (${order.status})`);
    }
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

  // ---------- Position Reconciliation ----------
  async _reconcilePositions() {
    try {
      const brokerPositions = await this.getOpenTrades();
      const dbOrders = await Order.find({ status: ORDER_STATUS.FILLED });
      const dbMap = new Map();
      for (const ord of dbOrders) {
        if (ord.contractId) dbMap.set(ord.contractId, ord);
      }

      for (const pos of brokerPositions) {
        const existing = dbMap.get(pos.id);
        if (!existing) {
          const newOrder = new Order({
            clientOrderId: generateClientOrderId(),
            instrument: pos.instrument,
            side: pos.side,
            units: Math.abs(pos.units),
            entryPrice: pos.price,
            status: ORDER_STATUS.FILLED,
            contractId: pos.id,
            filledAt: new Date(),
          });
          await newOrder.save();
          this._orders.set(newOrder.clientOrderId, newOrder);
          this._orderMap.set(pos.id, newOrder.clientOrderId);
          logger.warn(`[Reconcile] Created order for position ${pos.id}`);
        } else {
          this._orders.set(existing.clientOrderId, existing);
          this._orderMap.set(pos.id, existing.clientOrderId);
        }
      }

      for (const [contractId, clientOrderId] of this._orderMap) {
        const stillOpen = brokerPositions.some(p => p.id === contractId);
        if (!stillOpen) {
          await this._updateOrderStatus(clientOrderId, ORDER_STATUS.CLOSED);
          this._orderMap.delete(contractId);
        }
      }
      logger.info('[Reconcile] Position reconciliation complete.');
    } catch (err) {
      logger.error('[Reconcile] Failed:', err.message);
    }
  }

  // ---------- Risk Validation ----------
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
    const response = await this._sendRequest({ account: 1 });
    const acc = response.account;
    return {
      id: acc.account_id || acc.loginid,
      balance: acc.balance || '0',
      currency: acc.currency || 'USD',
      equity: acc.balance || '0',
      marginUsed: '0',
      marginAvailable: acc.balance || '0',
      createdTime: new Date().toISOString(),
    };
  }

  async getPrices(instruments) {
    await this._ensureReady();
    const results = [];
    for (const pair of instruments) {
      const symbol = toDerivSymbol(pair, this.symbolMap);
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
      const response = await this._sendRequest({ ticks: symbol, subscribe: 0 });
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
    });
    const candles = response.candles || [];
    const sorted = candles.slice(-count);
    return sorted.map(c => ({
      mid: { o: c.open, h: c.high, l: c.low, c: c.close },
      time: c.epoch,
      complete: true,
    }));
  }

  async placeMarketOrder(instrument, units, stopLoss = null, takeProfit = null, clientOrderId = null) {
    await this._ensureReady();
    await this._validateOrderRisk(instrument, units > 0 ? 'BUY' : 'SELL', units, stopLoss, takeProfit);

    const orderId = clientOrderId || generateClientOrderId();
    const orderDoc = new Order({
      clientOrderId: orderId,
      instrument,
      side: units > 0 ? 'BUY' : 'SELL',
      units: Math.abs(units),
      stopLoss,
      takeProfit,
      status: ORDER_STATUS.PENDING,
    });
    await orderDoc.save();
    this._orders.set(orderId, orderDoc);

    const payload = this.orderBuilder.build(instrument, units, 0, stopLoss, takeProfit, 'market');
    payload.client_order_id = orderId;

    try {
      const response = await this._sendRequest(payload);
      const tx = response.buy;
      const contractId = tx.contract_id || tx.transaction_id;
      const executedPrice = tx.buy_price || 0;
      await this._updateOrderStatus(orderId, ORDER_STATUS.FILLED, contractId);
      return {
        tradeID: contractId,
        id: contractId,
        price: executedPrice,
        averagePrice: executedPrice,
        clientOrderId: orderId,
      };
    } catch (err) {
      await this._updateOrderStatus(orderId, ORDER_STATUS.REJECTED);
      throw err;
    }
  }

  async placeLimitOrder(instrument, units, price, stopLoss = null, takeProfit = null, clientOrderId = null) {
    await this._ensureReady();
    await this._validateOrderRisk(instrument, units > 0 ? 'BUY' : 'SELL', units, stopLoss, takeProfit);

    const orderId = clientOrderId || generateClientOrderId();
    const orderDoc = new Order({
      clientOrderId: orderId,
      instrument,
      side: units > 0 ? 'BUY' : 'SELL',
      units: Math.abs(units),
      entryPrice: price,
      stopLoss,
      takeProfit,
      status: ORDER_STATUS.PENDING,
    });
    await orderDoc.save();
    this._orders.set(orderId, orderDoc);

    const payload = this.orderBuilder.build(instrument, units, price, stopLoss, takeProfit, 'limit');
    payload.client_order_id = orderId;

    try {
      const response = await this._sendRequest(payload);
      const tx = response.buy;
      const contractId = tx.contract_id || tx.transaction_id;
      const executedPrice = tx.buy_price || price;
      await this._updateOrderStatus(orderId, ORDER_STATUS.FILLED, contractId);
      return {
        tradeID: contractId,
        id: contractId,
        price: executedPrice,
        averagePrice: executedPrice,
        clientOrderId: orderId,
      };
    } catch (err) {
      await this._updateOrderStatus(orderId, ORDER_STATUS.REJECTED);
      throw err;
    }
  }

  async closeTrade(tradeId, clientOrderId = null) {
    await this._ensureReady();
    const orderId = clientOrderId || generateClientOrderId();
    const orderDoc = new Order({
      clientOrderId: orderId,
      instrument: 'CLOSE',
      side: 'CLOSE',
      units: 0,
      status: ORDER_STATUS.PENDING,
      metadata: { tradeId },
    });
    await orderDoc.save();
    this._orders.set(orderId, orderDoc);

    const payload = { sell: tradeId, price: 0, client_order_id: orderId };
    try {
      const response = await this._sendRequest(payload);
      const tx = response.sell;
      const contractId = tx.contract_id || tx.transaction_id;
      await this._updateOrderStatus(orderId, ORDER_STATUS.FILLED, contractId);
      return response.sell;
    } catch (err) {
      await this._updateOrderStatus(orderId, ORDER_STATUS.REJECTED);
      throw err;
    }
  }

  async getOpenTrades() {
    await this._ensureReady();
    const response = await this._sendRequest({ portfolio: 1 });
    const contracts = response.portfolio || [];
    return contracts.map(c => ({
      id: c.contract_id,
      instrument: fromDerivSymbol(c.symbol, this.reverseMap),
      side: c.buy ? 'BUY' : 'SELL',
      price: c.buy_price || c.entry_spot,
      units: c.buy ? c.amount : -c.amount,
      unrealizedPL: c.profit_loss || 0,
      currentPrice: c.current_spot || c.entry_spot,
    }));
  }

  async getPositions() {
    return this.getOpenTrades();
  }

  // ---------- Health & Kill ----------
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

  // ---------- Disconnect ----------
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
      pending.reject(new Error('Disconnected'));
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
      pending.reject(new Error('Connection closed'));
      this._pendingRequests.delete(id);
    }
    if (this._state !== STATE.DISCONNECTED) this._setState(STATE.DISCONNECTED);
  }

  _ensureReady() {
    if (this._state === STATE.READY) return Promise.resolve();
    return this.connect();
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
  maxQueueSize: parseInt(process.env.DERIV_MAX_QUEUE_SIZE) || 1000,
  circuitBreakerThreshold: parseInt(process.env.DERIV_CIRCUIT_BREAKER_THRESHOLD) || 5,
  circuitBreakerTimeout: parseInt(process.env.DERIV_CIRCUIT_BREAKER_TIMEOUT) || 60000,
  minOrderSize: parseFloat(process.env.DERIV_MIN_ORDER_SIZE) || 0.01,
  maxOrderSize: parseFloat(process.env.DERIV_MAX_ORDER_SIZE) || 100,
  minStopDistance: parseFloat(process.env.DERIV_MIN_STOP_DISTANCE) || 0.0001,
  rateLimit: parseFloat(process.env.DERIV_RATE_LIMIT) || 10,
  rateCapacity: parseFloat(process.env.DERIV_RATE_CAPACITY) || 20,
  contractType: process.env.DERIV_CONTRACT_TYPE || 'cfd',
  leverage: parseFloat(process.env.DERIV_LEVERAGE) || 1,
  duration: process.env.DERIV_DURATION || null,
});

module.exports = brokerInstance;
