// core/execution/mt5Broker.js
// Production MT5 Broker – Minimized streaming to reduce 502 errors.
// Prices are updated infrequently; dashboard reads cached values.
// Trading commands remain responsive.

const axios = require('axios');
const { EventEmitter } = require('events');
const { sleep } = require('../../shared/helpers');
const logger = require('../../infrastructure/logger') || console;
const Order = require('../../models/Order');

// ============================================================
// CONSTANTS
// ============================================================
const STATE = {
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  READY: 'READY',
  RECONNECTING: 'RECONNECTING',
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

const DEFAULT_SYMBOL_MAP = {
  'EUR_USD': 'EURUSD',
  'GBP_USD': 'GBPUSD',
  'USD_JPY': 'USDJPY',
  'AUD_USD': 'AUDUSD',
  'USD_CAD': 'USDCAD',
  'USD_CHF': 'USDCHF',
  'NZD_USD': 'NZDUSD',
  'EUR_GBP': 'EURGBP',
  'EUR_JPY': 'EURJPY',
  'GBP_JPY': 'GBPJPY',
  'XAU_USD': 'XAUUSD',
  'XAG_USD': 'XAGUSD',
  'US30': 'US30.cash',
  'NAS100': 'NAS100.cash',
  'DE40': 'DE40.cash',
  'UK100': 'UK100.cash',
  'BTC_USD': 'BTCUSD',
  'ETH_USD': 'ETHUSD',
};

// ============================================================
// HELPERS
// ============================================================
function generateClientOrderId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `ord_${crypto.randomUUID()}`;
  }
  return `ord_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

function redactSensitive(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const copy = JSON.parse(JSON.stringify(obj));
  if (copy.apiToken) copy.apiToken = '***REDACTED***';
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
// MAIN BROKER CLASS
// ============================================================
class MT5Broker extends EventEmitter {
  constructor(config = {}) {
    super();

    // ---------- Core settings ----------
    this.renderUrl = config.renderUrl || process.env.RENDER_URL || 'https://tradermarketopen.onrender.com';
    this.pollInterval = config.pollInterval || 1000;           // command result polling
    this.heartbeatInterval = config.heartbeatInterval || 15000; // less frequent
    this.priceRefreshInterval = config.priceRefreshInterval || 60000; // 1 minute – minimal
    this.reconnectBaseDelay = config.reconnectBaseDelay || 2000;
    this.maxReconnectDelay = config.maxReconnectDelay || 30000;
    this.maxRetries = config.maxRetries || 2;                 // fewer retries
    this.maxQueueSize = config.maxQueueSize || 100;
    this.circuitBreakerThreshold = config.circuitBreakerThreshold || 3; // more sensitive
    this.circuitBreakerTimeout = config.circuitBreakerTimeout || 60000;
    this.rateLimit = config.rateLimit || 3;                   // reduce rate
    this.rateCapacity = config.rateCapacity || 5;
    this.readinessTimeout = config.readinessTimeout || 20000;
    this.maxLots = config.maxLots || 10;
    this.maxExposurePercent = config.maxExposurePercent || 0.1;
    this.dailyLossLimit = config.dailyLossLimit || 0.05;
    this.duplicateCommandTTL = config.duplicateCommandTTL || 300000;

    // ---------- State ----------
    this._state = STATE.DISCONNECTED;
    this._pendingCommands = new Map();
    this._processedCommands = new Map();
    this._messageQueue = [];
    this._pollingTimer = null;
    this._heartbeatTimer = null;
    this._reconcileTimer = null;
    this._priceRefreshTimer = null;
    this._cbState = CB_STATE.CLOSED;
    this._cbFailureCount = 0;
    this._cbOpenedAt = null;
    this._rateLimiter = new RateLimiter(this.rateLimit, this.rateCapacity);
    this._lastHeartbeatOk = false;
    this._lastStatus = null;
    this._positions = [];
    this._orders = new Map();
    this._orderMap = new Map();

    // ---------- Caches ----------
    this.priceCache = new Map();           // symbol -> { bid, ask, mid, timestamp }
    this.symbolCache = new Map();
    this.symbolMap = { ...DEFAULT_SYMBOL_MAP };
    this.reverseMap = {};
    for (const [key, val] of Object.entries(DEFAULT_SYMBOL_MAP)) {
      this.reverseMap[val] = key;
    }
    this.supportedSymbols = new Set(Object.values(DEFAULT_SYMBOL_MAP));
    this.spreadCache = new Map();

    // ---------- Broker info ----------
    this.brokerInfo = {
      broker: 'MT5',
      server: 'Unknown',
      company: 'Unknown',
      terminalBuild: 'Unknown',
      accountType: 'Unknown',
      leverage: 100,
      currency: 'USD',
      timezone: 'UTC',
    };

    this._lastAccountState = null;

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
      pendingCommands: 0,
      priceUpdates: 0,
    };

    this.capabilities = {
      supportsMarketOrders: true,
      supportsLimitOrders: true,
      supportsPartialClose: true,
      supportsHedging: true,
      supportsNetting: false,
      supportedMarkets: ['Forex', 'Indices', 'Commodities', 'Cryptocurrencies'],
      supportsTrailingStop: true,
      supportsBreakEven: true,
    };

    logger.info('[MT5Broker] Initialized (minimal streaming) with Render URL:', this.renderUrl);
  }

  // ============================================================
  // STATE MANAGEMENT
  // ============================================================
  _setState(newState) {
    const old = this._state;
    this._state = newState;
    logger.debug(`[MT5Broker] State: ${old} → ${newState}`);
    this.emit('stateChange', { from: old, to: newState });
  }

  // ============================================================
  // CONNECTION
  // ============================================================
  async connect() {
    if (this._state === STATE.READY) return;
    if (this._state === STATE.FATAL) throw new Error('Broker in FATAL state.');
    if (this._state === STATE.CONNECTING) {
      return new Promise((resolve, reject) => {
        const onReady = () => { this.removeListener('ready', onReady); resolve(); };
        const onError = (err) => { this.removeListener('error', onError); reject(err); };
        this.once('ready', onReady);
        this.once('error', onError);
      });
    }

    this._setState(STATE.CONNECTING);
    this._stopPolling();
    this._stopHeartbeat();
    this._stopReconcile();
    this._stopPriceRefresh();

    let attempt = 0;
    let lastError = null;

    while (attempt < 2) { // fewer attempts
      attempt++;
      try {
        logger.info(`[MT5Broker] Connection attempt ${attempt}`);
        await this._pingBridge();
        await this._loadBrokerInfo();
        await this._loadSymbols();
        this._setState(STATE.READY);
        this.metrics.connectedSince = Date.now();
        this._lastHeartbeatOk = true;
        this._startPolling();
        this._startHeartbeat();
        this._startReconcile();
        this._startPriceRefresh();
        this._flushQueue();
        this.emit('ready');
        this.emit('connected');
        logger.info('[MT5Broker] Connected successfully');
        return;
      } catch (err) {
        lastError = err;
        logger.warn(`[MT5Broker] Connection attempt ${attempt} failed:`, err.message);
        if (attempt < 2) {
          await sleep(this._getReconnectDelay(attempt));
        }
      }
    }

    this._setState(STATE.FATAL);
    this.emit('error', lastError);
    throw new Error(`Failed to connect: ${lastError.message}`);
  }

  async disconnect() {
    this._stopPolling();
    this._stopHeartbeat();
    this._stopReconcile();
    this._stopPriceRefresh();
    this._setState(STATE.DISCONNECTED);
    for (const [cmdId, pending] of this._pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Broker disconnected'));
    }
    this._pendingCommands.clear();
    this._messageQueue = [];
    logger.info('[MT5Broker] Disconnected');
    this.emit('disconnected');
  }

  isConnected() { return this._state === STATE.READY; }
  isAuthorized() { return this._state === STATE.READY; }

  async _pingBridge() {
    const response = await this._axiosGet('/api/mt5/account/status', { timeout: 5000 });
    if (response.data && response.data.login) {
      this._lastStatus = response.data;
      this._updateAccountState(response.data);
      return true;
    }
    throw new Error('Bridge did not return valid status');
  }

  // ============================================================
  // RETRY & CIRCUIT BREAKER
  // ============================================================
  async _axiosGet(url, options = {}) {
    return this._axiosRequest('get', url, null, options);
  }

  async _axiosPost(url, data, options = {}) {
    return this._axiosRequest('post', url, data, options);
  }

  async _axiosRequest(method, url, data, options = {}) {
    await this._rateLimiter.acquire();

    if (this._cbState === CB_STATE.OPEN) {
      if (Date.now() - this._cbOpenedAt > this.circuitBreakerTimeout) {
        this._cbState = CB_STATE.HALF_OPEN;
        logger.warn('[MT5Broker] Circuit breaker HALF-OPEN');
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    const fullUrl = `${this.renderUrl}${url}`;
    let lastError = null;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const start = Date.now();
        let response;
        if (method === 'get') {
          response = await axios.get(fullUrl, { ...options, timeout: options.timeout || 8000 });
        } else {
          response = await axios.post(fullUrl, data, { ...options, timeout: options.timeout || 8000 });
        }
        const latency = Date.now() - start;
        this.metrics.totalLatency += latency;
        this.metrics.latencyCount++;
        this.metrics.requestsSent++;
        if (this._cbState === CB_STATE.HALF_OPEN) {
          this._cbState = CB_STATE.CLOSED;
          this._cbFailureCount = 0;
          logger.warn('[MT5Broker] Circuit breaker CLOSED');
        }
        return response;
      } catch (err) {
        lastError = err;
        this.metrics.requestsFailed++;
        logger.warn(`[MT5Broker] Request failed (attempt ${attempt}):`, err.message);
        if (attempt < this.maxRetries) {
          await sleep(this._getReconnectDelay(attempt));
        }
      }
    }

    this._cbFailureCount++;
    if (this._cbFailureCount >= this.circuitBreakerThreshold) {
      this._cbState = CB_STATE.OPEN;
      this._cbOpenedAt = Date.now();
      logger.error('[MT5Broker] Circuit breaker OPEN');
    }
    throw lastError || new Error('Request failed after retries');
  }

  _getReconnectDelay(attempt) {
    const base = this.reconnectBaseDelay;
    const max = this.maxReconnectDelay;
    const delay = Math.min(base * Math.pow(2, attempt - 1), max);
    const jitter = delay * (0.8 + 0.4 * Math.random());
    return Math.round(jitter);
  }

  // ============================================================
  // MESSAGE QUEUE
  // ============================================================
  _enqueueCommand(payload) {
    if (this._messageQueue.length >= this.maxQueueSize) {
      throw new Error('Command queue full');
    }
    this._messageQueue.push({ payload, timestamp: Date.now() });
    logger.debug(`[MT5Broker] Command queued (queue size: ${this._messageQueue.length})`);
    if (this._state === STATE.READY) this._flushQueue();
  }

  _flushQueue() {
    const now = Date.now();
    const maxAge = 300000;
    while (this._messageQueue.length > 0) {
      const item = this._messageQueue[0];
      if (now - item.timestamp > maxAge) {
        this._messageQueue.shift();
        logger.warn('[MT5Broker] Discarded expired queued command');
        continue;
      }
      if (this._state !== STATE.READY) break;
      const payload = item.payload;
      this._messageQueue.shift();
      this._sendRawCommand(payload).catch(err => {
        logger.error('[MT5Broker] Queued command failed:', err.message);
      });
    }
  }

  // ============================================================
  // SEND COMMAND
  // ============================================================
  async _sendRawCommand(payload) {
    if (payload.commandId && this._processedCommands.has(payload.commandId)) {
      logger.warn(`[MT5Broker] Duplicate command ${payload.commandId} ignored`);
      return { success: true, message: 'Duplicate command ignored' };
    }

    if (this._state !== STATE.READY) {
      this._enqueueCommand(payload);
      throw new Error('Broker not ready; command queued');
    }

    if (this._cbState === CB_STATE.OPEN) {
      throw new Error('Circuit breaker open');
    }

    if (payload.commandId) {
      this._processedCommands.set(payload.commandId, Date.now());
      setImmediate(() => this._cleanProcessedCommands());
    }

    return this._axiosPost('/api/mt5/orders/command', payload);
  }

  _cleanProcessedCommands() {
    const now = Date.now();
    for (const [id, ts] of this._processedCommands) {
      if (now - ts > this.duplicateCommandTTL) {
        this._processedCommands.delete(id);
      }
    }
  }

  // ============================================================
  // ORDER PLACEMENT
  // ============================================================
  async placeMarketOrder(instrument, units, stopLoss = null, takeProfit = null, reason = 'MANUAL') {
    await this._ensureReady();
    const side = units > 0 ? 'BUY' : 'SELL';
    const absUnits = Math.abs(units);
    if (absUnits <= 0) throw new Error('Order units must be positive');

    const mt5Symbol = this._toMT5Symbol(instrument);
    if (!mt5Symbol || !this.supportedSymbols.has(mt5Symbol)) {
      throw new Error(`Unsupported symbol: ${instrument}`);
    }

    await this._validateOrderRisk(instrument, side, absUnits, stopLoss, takeProfit);
    if (!this._isTradingSession(mt5Symbol)) {
      throw new Error(`Market closed for ${instrument}`);
    }

    const clientOrderId = generateClientOrderId();
    const order = new Order({
      clientOrderId,
      instrument,
      side,
      units: absUnits,
      stopLoss,
      takeProfit,
      status: ORDER_STATUS.PENDING,
      broker: 'MT5',
      placedAt: new Date(),
      reason,
    });
    await order.save();
    this._orders.set(clientOrderId, order);
    this.emit('orderUpdate', { clientOrderId, status: ORDER_STATUS.PENDING });

    const cmdId = `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const payload = {
      commandId: cmdId,
      action: 'OPEN',
      instrument: mt5Symbol,
      side,
      units: absUnits,
      stopLoss,
      takeProfit,
    };

    let response;
    try {
      response = await this._sendRawCommand(payload);
    } catch (err) {
      await this._updateOrderStatus(clientOrderId, ORDER_STATUS.REJECTED, null, err.message);
      throw err;
    }

    const result = await this._waitForResult(cmdId, 8000); // 8 second timeout
    if (!result.success) {
      await this._updateOrderStatus(clientOrderId, ORDER_STATUS.REJECTED, null, result.error || 'Execution failed');
      throw new Error(result.error || 'Order execution failed');
    }

    const ticket = result.ticket;
    const execPrice = result.price || 0;
    await this._updateOrderStatus(clientOrderId, ORDER_STATUS.FILLED, ticket, null);
    this._orderMap.set(ticket, clientOrderId);
    this.emit('orderUpdate', { clientOrderId, status: ORDER_STATUS.FILLED, ticket });
    this.emit('trade', { clientOrderId, ticket, instrument, side, units: absUnits, price: execPrice });

    let slippage = 0;
    const cached = this.priceCache.get(mt5Symbol);
    if (cached && cached.mid) {
      const requested = side === 'BUY' ? cached.ask || cached.mid : cached.bid || cached.mid;
      slippage = execPrice - requested;
    }

    return {
      tradeID: String(ticket),
      id: String(ticket),
      price: execPrice,
      averagePrice: execPrice,
      slippage,
      raw: result,
    };
  }

  async placeLimitOrder(instrument, units, price, stopLoss = null, takeProfit = null, reason = 'MANUAL') {
    throw new Error('Limit orders not implemented in this version');
  }

  async closeTrade(tradeId) {
    if (!tradeId) throw new Error('tradeId required');
    await this._ensureReady();

    let clientOrderId = this._orderMap.get(String(tradeId));
    if (!clientOrderId) {
      const order = await Order.findOne({ contractId: String(tradeId), status: ORDER_STATUS.FILLED });
      if (order) {
        clientOrderId = order.clientOrderId;
        this._orderMap.set(String(tradeId), clientOrderId);
      }
    }

    const cmdId = `close_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const payload = { commandId: cmdId, action: 'CLOSE', tradeId: String(tradeId) };

    let response;
    try {
      response = await this._sendRawCommand(payload);
    } catch (err) {
      throw err;
    }

    const result = await this._waitForResult(cmdId, 8000);
    if (!result.success) throw new Error(result.error || 'Close failed');

    if (clientOrderId) {
      await this._updateOrderStatus(clientOrderId, ORDER_STATUS.CLOSED, null, null);
      this._orderMap.delete(String(tradeId));
      this.emit('tradeClosed', { clientOrderId, tradeId });
    }

    return result;
  }

  async modifySLTP(tradeId, stopLoss, takeProfit) {
    if (!tradeId) throw new Error('tradeId required');
    await this._ensureReady();

    const cmdId = `mod_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const payload = {
      commandId: cmdId,
      action: 'MODIFY',
      tradeId: String(tradeId),
      stopLoss,
      takeProfit,
    };

    let response;
    try {
      response = await this._sendRawCommand(payload);
    } catch (err) {
      throw err;
    }

    const result = await this._waitForResult(cmdId, 8000);
    if (!result.success) throw new Error(result.error || 'Modify failed');

    const clientOrderId = this._orderMap.get(String(tradeId));
    if (clientOrderId) {
      await Order.findOneAndUpdate(
        { clientOrderId },
        { stopLoss, takeProfit, updatedAt: new Date() }
      );
      this.emit('orderModified', { clientOrderId, tradeId, stopLoss, takeProfit });
    }

    return result;
  }

  async partialClose(tradeId, units) {
    throw new Error('Partial close not implemented in this version');
  }

  async setTrailingStop(tradeId, trailingStop) {
    throw new Error('Trailing stop not implemented yet');
  }

  async setBreakEven(tradeId) {
    throw new Error('Break-even not implemented yet');
  }

  // ============================================================
  // COMMAND RESULT POLLING
  // ============================================================
  _waitForResult(commandId, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingCommands.delete(commandId);
        reject(new Error(`Command ${commandId} timed out`));
      }, timeoutMs);

      this._pendingCommands.set(commandId, { resolve, reject, timer });
    });
  }

  _startPolling() {
    if (this._pollingTimer) return;
    this._pollingTimer = setInterval(async () => {
      if (this._state !== STATE.READY) return;
      if (this._pendingCommands.size === 0) return;
      for (const [cmdId, pending] of this._pendingCommands) {
        try {
          const response = await this._axiosGet(`/api/mt5/orders/result/${cmdId}`, { timeout: 2000 });
          const result = response.data;
          if (result && result.success !== undefined) {
            clearTimeout(pending.timer);
            this._pendingCommands.delete(cmdId);
            pending.resolve(result);
          }
        } catch (err) {
          if (err.response && err.response.status === 404) continue;
          logger.warn(`[MT5Broker] Error polling result for ${cmdId}:`, err.message);
        }
      }
      this.metrics.pendingCommands = this._pendingCommands.size;
    }, this.pollInterval);
  }

  _stopPolling() {
    if (this._pollingTimer) {
      clearInterval(this._pollingTimer);
      this._pollingTimer = null;
    }
    for (const [cmdId, pending] of this._pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Polling stopped'));
    }
    this._pendingCommands.clear();
  }

  // ============================================================
  // HEARTBEAT WATCHDOG
  // ============================================================
  _startHeartbeat() {
    if (this._heartbeatTimer) return;
    this._heartbeatTimer = setInterval(async () => {
      if (this._state !== STATE.READY) return;
      try {
        const resp = await this._axiosGet('/api/mt5/account/status', { timeout: 3000 });
        this._lastHeartbeatOk = true;
        this.metrics.lastHeartbeat = Date.now();
        this._updateAccountState(resp.data);
      } catch (err) {
        this._lastHeartbeatOk = false;
        this.metrics.heartbeatMisses++;
        logger.warn('[MT5Broker] Heartbeat failed:', err.message);
        this._setState(STATE.RECONNECTING);
        this._stopPolling();
        this._stopHeartbeat();
        this._stopReconcile();
        this._stopPriceRefresh();
        this._reconnectWithBackoff();
      }
    }, this.heartbeatInterval);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  async _reconnectWithBackoff() {
    let attempt = 1;
    while (attempt <= 3) {
      const delay = this._getReconnectDelay(attempt);
      logger.info(`[MT5Broker] Reconnect attempt ${attempt} in ${delay}ms`);
      await sleep(delay);
      try {
        await this.connect();
        return;
      } catch (err) {
        logger.warn(`[MT5Broker] Reconnect attempt ${attempt} failed:`, err.message);
        attempt++;
      }
    }
    this._setState(STATE.FATAL);
    this.emit('error', new Error('Failed to reconnect'));
  }

  // ============================================================
  // PRICE REFRESH – MINIMAL POLLING
  // ============================================================
  async _refreshPrices() {
    if (this._state !== STATE.READY) return;
    const symbols = Array.from(this.supportedSymbols);
    if (symbols.length === 0) return;

    // Only refresh a subset? To reduce load, we'll just update the first few or all but with a large batch.
    const batchSize = 20;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      try {
        for (const sym of batch) {
          try {
            const resp = await this._axiosGet(`/api/mt5/tick/${sym}`, { timeout: 2000 });
            const tick = resp.data;
            if (tick) {
              const bid = parseFloat(tick.bid) || parseFloat(tick.price) - 0.00005;
              const ask = parseFloat(tick.ask) || parseFloat(tick.price) + 0.00005;
              const mid = (bid + ask) / 2;
              const timestamp = tick.time || Date.now();
              this.priceCache.set(sym, { bid, ask, mid, timestamp });
              this.emit('price', { symbol: sym, bid, ask, mid, timestamp });
              this.metrics.priceUpdates++;
            }
          } catch (err) {
            // Log only at debug level
            logger.debug(`[MT5Broker] Failed to fetch tick for ${sym}: ${err.message}`);
          }
        }
      } catch (err) {
        logger.warn(`[MT5Broker] Price refresh batch failed: ${err.message}`);
      }
    }
  }

  _startPriceRefresh() {
    if (this._priceRefreshTimer) return;
    const interval = this.priceRefreshInterval || 60000;
    this._priceRefreshTimer = setInterval(async () => {
      try {
        await this._refreshPrices();
      } catch (err) {
        logger.warn('[MT5Broker] Periodic price refresh error:', err.message);
      }
    }, interval);
    // Run once immediately on connect (but only if we have symbols)
    if (this.supportedSymbols.size > 0) {
      this._refreshPrices().catch(err => logger.warn('[MT5Broker] Initial price refresh error:', err.message));
    }
    logger.info(`[MT5Broker] Started minimal price polling every ${interval}ms`);
  }

  _stopPriceRefresh() {
    if (this._priceRefreshTimer) {
      clearInterval(this._priceRefreshTimer);
      this._priceRefreshTimer = null;
    }
  }

  // ============================================================
  // SYMBOL MANAGEMENT
  // ============================================================
  updateSymbols(symbolsList) {
    for (const sym of symbolsList) {
      const mt5Symbol = sym.symbol;
      this.symbolCache.set(mt5Symbol, {
        digits: sym.digits || 5,
        point: sym.point || 0.00001,
        contractSize: sym.contractSize || 100000,
        tickValue: sym.tickValue || 1,
        minLot: sym.minLot || 0.01,
        maxLot: sym.maxLot || 100,
        lotStep: sym.lotStep || 0.01,
        ...sym,
      });
      this.supportedSymbols.add(mt5Symbol);
      if (!Object.values(this.symbolMap).includes(mt5Symbol)) {
        const internal = this._inferInternalSymbol(mt5Symbol);
        if (internal) {
          this.symbolMap[internal] = mt5Symbol;
          this.reverseMap[mt5Symbol] = internal;
        }
      }
    }
    logger.info(`[MT5Broker] Updated symbols: ${this.supportedSymbols.size} symbols`);
  }

  _inferInternalSymbol(mt5Symbol) {
    let clean = mt5Symbol.replace(/^frx/, '');
    if (clean.length === 6) {
      return clean.slice(0, 3) + '_' + clean.slice(3);
    }
    return clean;
  }

  _toMT5Symbol(instrument) {
    return this.symbolMap[instrument] || instrument;
  }

  // ============================================================
  // BROKER INFO & SYMBOLS LOAD
  // ============================================================
  async _loadBrokerInfo() {
    try {
      const resp = await this._axiosGet('/api/mt5/broker/info', { timeout: 5000 });
      const info = resp.data;
      if (info) {
        this.brokerInfo = {
          broker: 'MT5',
          server: info.server || 'Unknown',
          company: info.company || 'Unknown',
          terminalBuild: info.build || 'Unknown',
          accountType: info.accountType || 'Unknown',
          leverage: info.leverage || 100,
          currency: info.currency || 'USD',
          timezone: info.timezone || 'UTC',
        };
        logger.info('[MT5Broker] Broker info loaded.');
      }
    } catch (err) {
      logger.warn('[MT5Broker] Failed to load broker info:', err.message);
    }
  }

  async _loadSymbols() {
    try {
      const resp = await this._axiosGet('/api/mt5/symbols', { timeout: 5000 });
      const symbols = resp.data?.symbols || [];
      if (symbols.length > 0) {
        this.updateSymbols(symbols);
        logger.info(`[MT5Broker] Loaded ${symbols.length} symbols.`);
      }
    } catch (err) {
      logger.warn('[MT5Broker] Failed to load symbols, using defaults.');
      for (const sym of Object.values(DEFAULT_SYMBOL_MAP)) {
        this.supportedSymbols.add(sym);
        this.symbolCache.set(sym, {
          digits: 5,
          point: 0.00001,
          contractSize: 100000,
          tickValue: 1,
          minLot: 0.01,
          maxLot: 100,
          lotStep: 0.01,
        });
      }
    }
  }

  _isTradingSession(symbol) {
    return true; // assume always open to avoid blocking orders
  }

  // ============================================================
  // ACCOUNT STATE EVENTS
  // ============================================================
  _updateAccountState(data) {
    const newState = {
      balance: parseFloat(data.balance) || 0,
      equity: parseFloat(data.equity) || 0,
      margin: parseFloat(data.margin) || 0,
      freeMargin: parseFloat(data.free_margin) || 0,
      currency: data.currency || 'USD',
    };
    if (this._lastAccountState) {
      const old = this._lastAccountState;
      if (newState.balance !== old.balance) this.emit('balanceChanged', { old: old.balance, new: newState.balance });
      if (newState.equity !== old.equity) this.emit('equityChanged', { old: old.equity, new: newState.equity });
      if (newState.margin !== old.margin) this.emit('marginChanged', { old: old.margin, new: newState.margin });
      if (newState.freeMargin !== old.freeMargin) this.emit('freeMarginChanged', { old: old.freeMargin, new: newState.freeMargin });
    }
    this._lastAccountState = newState;
  }

  // ============================================================
  // POSITION RECONCILIATION
  // ============================================================
  _startReconcile() {
    if (this._reconcileTimer) return;
    this._reconcileTimer = setInterval(async () => {
      if (this._state !== STATE.READY) return;
      try {
        await this._reconcilePositions();
      } catch (err) {
        logger.error('[MT5Broker] Position reconciliation error:', err.message);
      }
    }, 120000); // 2 minutes
  }

  _stopReconcile() {
    if (this._reconcileTimer) {
      clearInterval(this._reconcileTimer);
      this._reconcileTimer = null;
    }
  }

  async _reconcilePositions() {
    let positions;
    try {
      const response = await this._axiosGet('/api/mt5/positions', { timeout: 5000 });
      positions = response.data?.positions || [];
    } catch (err) {
      logger.warn('[MT5Broker] Failed to fetch positions for reconciliation:', err.message);
      return;
    }

    const oldPosMap = new Map();
    for (const pos of this._positions) oldPosMap.set(String(pos.ticket), pos);
    const newPosMap = new Map();
    for (const pos of positions) newPosMap.set(String(pos.ticket), pos);

    for (const [ticket, pos] of newPosMap) {
      if (!oldPosMap.has(ticket)) {
        this.emit('positionOpened', { ticket, symbol: pos.symbol, type: pos.type, volume: pos.volume, price: pos.price, stopLoss: pos.stop_loss, takeProfit: pos.take_profit });
      }
    }

    for (const [ticket, pos] of oldPosMap) {
      if (!newPosMap.has(ticket)) {
        const clientOrderId = this._orderMap.get(ticket);
        if (clientOrderId) {
          await this._updateOrderStatus(clientOrderId, ORDER_STATUS.CLOSED);
          this._orderMap.delete(ticket);
        }
        this.emit('positionClosed', { ticket, symbol: pos.symbol });
      }
    }

    for (const [ticket, newPos] of newPosMap) {
      const oldPos = oldPosMap.get(ticket);
      if (oldPos && (oldPos.stop_loss !== newPos.stop_loss || oldPos.take_profit !== newPos.take_profit || oldPos.price !== newPos.price)) {
        this.emit('positionModified', { ticket, symbol: newPos.symbol, oldPrice: oldPos.price, newPrice: newPos.price, oldStopLoss: oldPos.stop_loss, newStopLoss: newPos.stop_loss, oldTakeProfit: oldPos.take_profit, newTakeProfit: newPos.take_profit });
      }
    }

    this._positions = positions;
    await this._syncOrdersWithPositions(positions);
  }

  async _syncOrdersWithPositions(positions) {
    const dbOrders = await Order.find({ status: ORDER_STATUS.FILLED, broker: 'MT5' });
    const dbMap = new Map();
    for (const ord of dbOrders) {
      if (ord.contractId) dbMap.set(ord.contractId, ord);
    }

    for (const pos of positions) {
      const ticket = String(pos.ticket);
      if (!dbMap.has(ticket)) {
        const newOrder = new Order({
          clientOrderId: generateClientOrderId(),
          instrument: pos.symbol || 'UNKNOWN',
          side: pos.type || 'BUY',
          units: pos.volume || 0,
          entryPrice: pos.price || 0,
          status: ORDER_STATUS.FILLED,
          contractId: ticket,
          broker: 'MT5',
          filledAt: new Date(),
          stopLoss: pos.stop_loss || 0,
          takeProfit: pos.take_profit || 0,
        });
        await newOrder.save();
        this._orders.set(newOrder.clientOrderId, newOrder);
        this._orderMap.set(ticket, newOrder.clientOrderId);
        logger.warn(`[Reconcile] Created order for orphaned position ${ticket}`);
      }
    }
  }

  // ============================================================
  // TRADE HISTORY
  // ============================================================
  async getTradeHistory(startTime = null, endTime = null, instrument = null) {
    try {
      const params = {};
      if (startTime) params.start = startTime;
      if (endTime) params.end = endTime;
      if (instrument) params.symbol = this._toMT5Symbol(instrument);
      const response = await this._axiosGet('/api/mt5/history', { params, timeout: 10000 });
      return response.data?.history || [];
    } catch (err) {
      logger.warn('[MT5Broker] Failed to get trade history:', err.message);
      return [];
    }
  }

  // ============================================================
  // MARGIN & PROFIT CALCULATORS
  // ============================================================
  async calculateMargin(instrument, units, price = null) {
    try {
      const mt5Symbol = this._toMT5Symbol(instrument);
      const response = await this._axiosPost('/api/mt5/calc_margin', {
        symbol: mt5Symbol,
        volume: Math.abs(units),
        price: price || 0,
      }, { timeout: 5000 });
      return response.data?.margin || 0;
    } catch (err) {
      logger.warn('[MT5Broker] Margin calculation failed:', err.message);
      return 0;
    }
  }

  async calculateProfit(instrument, units, openPrice, closePrice) {
    try {
      const mt5Symbol = this._toMT5Symbol(instrument);
      const response = await this._axiosPost('/api/mt5/calc_profit', {
        symbol: mt5Symbol,
        volume: Math.abs(units),
        openPrice,
        closePrice,
      }, { timeout: 5000 });
      return response.data?.profit || 0;
    } catch (err) {
      logger.warn('[MT5Broker] Profit calculation failed:', err.message);
      return 0;
    }
  }

  // ============================================================
  // RISK VALIDATION
  // ============================================================
  async _validateOrderRisk(instrument, side, units, stopLoss, takeProfit) {
    if (units > this.maxLots) throw new Error(`Order size ${units} exceeds max lots ${this.maxLots}`);
    const account = await this.getAccount();
    const balance = parseFloat(account.balance);
    const marginAvailable = parseFloat(account.marginAvailable);
    if (marginAvailable <= 0) throw new Error('Insufficient free margin');
    const requiredMargin = await this.calculateMargin(instrument, units);
    if (requiredMargin > marginAvailable) {
      throw new Error(`Insufficient margin: required ${requiredMargin}, available ${marginAvailable}`);
    }
    const exposure = units * 0.01;
    if (exposure > balance * this.maxExposurePercent) {
      throw new Error(`Order size exceeds ${this.maxExposurePercent * 100}% of balance`);
    }
  }

  // ============================================================
  // PUBLIC API
  // ============================================================

  async getAccount() {
    try {
      const response = await this._axiosGet('/api/mt5/account/status', { timeout: 5000 });
      const data = response.data;
      if (data && data.login) {
        this._lastStatus = data;
        this._updateAccountState(data);
        return {
          id: String(data.login),
          balance: String(data.balance || 0),
          currency: data.currency || 'USD',
          equity: String(data.equity || 0),
          marginUsed: String(data.margin || 0),
          marginAvailable: String(data.free_margin || 0),
          createdTime: new Date().toISOString(),
        };
      }
    } catch (err) {
      logger.warn('[MT5Broker] getAccount failed:', err.message);
    }
    return {
      id: 'MT5_ACCOUNT',
      balance: '0',
      currency: 'USD',
      equity: '0',
      marginUsed: '0',
      marginAvailable: '0',
      createdTime: new Date().toISOString(),
    };
  }

  async getOpenTrades() {
    try {
      const response = await this._axiosGet('/api/mt5/positions', { timeout: 5000 });
      const positions = response.data?.positions || [];
      this._positions = positions;
      return positions.map(p => ({
        id: String(p.ticket),
        instrument: p.symbol || 'UNKNOWN',
        side: p.type || 'BUY',
        price: p.price || 0,
        units: p.volume || 0,
        unrealizedPL: p.profit || 0,
        currentPrice: p.current_price || p.price || 0,
        stopLoss: p.stop_loss || 0,
        takeProfit: p.take_profit || 0,
      }));
    } catch (err) {
      logger.warn('[MT5Broker] getOpenTrades failed:', err.message);
      return [];
    }
  }
  async getPositions() { return this.getOpenTrades(); }

  // ---------- Prices: return cache only (no fallback to avoid extra requests) ----------
  async getPrices(instruments) {
    const results = [];
    for (const inst of instruments) {
      const mt5Symbol = this._toMT5Symbol(inst);
      const cached = this.priceCache.get(mt5Symbol);
      if (cached && (Date.now() - cached.timestamp < 120000)) { // cache valid for 2 min
        results.push({
          instrument: inst,
          bids: [{ price: cached.bid ? cached.bid.toFixed(5) : (cached.mid - 0.00005).toFixed(5) }],
          asks: [{ price: cached.ask ? cached.ask.toFixed(5) : (cached.mid + 0.00005).toFixed(5) }],
          time: cached.timestamp,
        });
      } else {
        // Return a placeholder or skip – to avoid 502 we don't fetch on the fly
        results.push({
          instrument: inst,
          bids: [{ price: '0.00000' }],
          asks: [{ price: '0.00000' }],
          time: Date.now(),
          error: 'Price not available',
        });
      }
    }
    return results;
  }

  async getCandles(instrument, count = 100, granularity = 'M5') {
    try {
      const mt5Symbol = this._toMT5Symbol(instrument);
      const response = await this._axiosGet(`/api/mt5/candles/${mt5Symbol}`, {
        params: { count, granularity },
        timeout: 10000,
      });
      return response.data?.candles || [];
    } catch (err) {
      logger.warn('[MT5Broker] Candle retrieval failed:', err.message);
      return [];
    }
  }

  async getSymbolSpec(symbol) {
    const mt5Symbol = this._toMT5Symbol(symbol);
    return this.symbolCache.get(mt5Symbol) || null;
  }

  getBrokerInfo() {
    return { ...this.brokerInfo };
  }

  async getServerTime() {
    try {
      const resp = await this._axiosGet('/api/mt5/time', { timeout: 3000 });
      return resp.data?.time || Date.now();
    } catch (err) {
      return Date.now();
    }
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
    const pendingOrders = await Order.find({ status: ORDER_STATUS.PENDING, broker: 'MT5' });
    for (const order of pendingOrders) {
      await this._updateOrderStatus(order.clientOrderId, ORDER_STATUS.CANCELLED);
      logger.info(`[Kill] Cancelled order ${order.clientOrderId}`);
    }
    await this.disconnect();
    logger.warn('🚨 Kill switch complete.');
  }

  getHealth() {
    const avgLatency = this.metrics.latencyCount > 0 ? this.metrics.totalLatency / this.metrics.latencyCount : 0;
    const uptime = this.metrics.connectedSince ? Date.now() - this.metrics.connectedSince : 0;
    return {
      state: this._state,
      connected: this.isConnected(),
      authorized: this.isAuthorized(),
      circuitBreaker: this._cbState,
      reconnectCount: this.metrics.reconnections,
      queueSize: this._messageQueue.length,
      pendingCommands: this._pendingCommands.size,
      lastHeartbeat: this.metrics.lastHeartbeat,
      averageLatency: avgLatency,
      uptime,
      orders: {
        placed: this.metrics.ordersPlaced,
        filled: this.metrics.ordersFilled,
        rejected: this.metrics.ordersRejected,
      },
      positions: this._positions.length,
      priceCacheSize: this.priceCache.size,
      supportedSymbols: this.supportedSymbols.size,
      lastStatus: this._lastStatus ? 'available' : 'none',
    };
  }

  async _updateOrderStatus(clientOrderId, status, contractId = null, error = null) {
    const update = { status, updatedAt: new Date() };
    if (contractId) update.contractId = String(contractId);
    if (status === ORDER_STATUS.FILLED) update.filledAt = new Date();
    if (status === ORDER_STATUS.REJECTED) {
      update.rejectedAt = new Date();
      update.rejectReason = error || 'Unknown';
    }
    if (status === ORDER_STATUS.CLOSED) update.closedAt = new Date();

    const updated = await Order.findOneAndUpdate({ clientOrderId }, update, { new: true });
    if (updated) {
      this._orders.set(clientOrderId, updated);
      if (contractId) this._orderMap.set(String(contractId), clientOrderId);
      this.emit('orderUpdate', { clientOrderId, status, contractId });
      if (status === ORDER_STATUS.FILLED) this.metrics.ordersFilled++;
      if (status === ORDER_STATUS.REJECTED) this.metrics.ordersRejected++;
      this.metrics.ordersPlaced++;
    }
  }

  async _ensureReady() {
    if (this._state === STATE.READY) return;
    if (this._state === STATE.FATAL) throw new Error('Broker in FATAL state');
    await this.connect();
    if (this._state !== STATE.READY) {
      throw new Error('Broker not ready');
    }
  }
}

// ============================================================
// EXPORT – class as default
// ============================================================
module.exports = MT5Broker;

// Also provide a default instance for convenience (but not required)
const mt5BrokerInstance = new MT5Broker({
  renderUrl: process.env.RENDER_URL,
  pollInterval: parseInt(process.env.MT5_POLL_INTERVAL) || 1000,
  heartbeatInterval: parseInt(process.env.MT5_HEARTBEAT_INTERVAL) || 15000,
  priceRefreshInterval: parseInt(process.env.MT5_PRICE_REFRESH_INTERVAL) || 60000,
  reconnectBaseDelay: parseInt(process.env.MT5_RECONNECT_DELAY) || 2000,
  maxReconnectDelay: parseInt(process.env.MT5_MAX_RECONNECT_DELAY) || 30000,
  maxRetries: parseInt(process.env.MT5_MAX_RETRIES) || 2,
  maxQueueSize: parseInt(process.env.MT5_MAX_QUEUE_SIZE) || 100,
  circuitBreakerThreshold: parseInt(process.env.MT5_CIRCUIT_BREAKER_THRESHOLD) || 3,
  circuitBreakerTimeout: parseInt(process.env.MT5_CIRCUIT_BREAKER_TIMEOUT) || 60000,
  rateLimit: parseFloat(process.env.MT5_RATE_LIMIT) || 3,
  rateCapacity: parseFloat(process.env.MT5_RATE_CAPACITY) || 5,
  readinessTimeout: parseInt(process.env.MT5_READINESS_TIMEOUT) || 20000,
  maxLots: parseFloat(process.env.MT5_MAX_LOTS) || 10,
  maxExposurePercent: parseFloat(process.env.MT5_MAX_EXPOSURE_PERCENT) || 0.1,
  dailyLossLimit: parseFloat(process.env.MT5_DAILY_LOSS_LIMIT) || 0.05,
  duplicateCommandTTL: parseInt(process.env.MT5_DUPLICATE_TTL) || 300000,
});

module.exports.mt5Broker = mt5BrokerInstance;
module.exports.MT5Broker = MT5Broker;
