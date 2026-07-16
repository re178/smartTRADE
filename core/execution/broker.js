// core/execution/broker.js – Full Deriv broker with true CFD via cfd_open_position

const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { sleep } = require('../../shared/helpers');
const logger = require('../../infrastructure/logger') || console;
const Order = require('../../models/Order');

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

// --- Helper to redact sensitive data ---
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
// STREAMING MANAGER
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
    await this.broker._ensureReady();
    const response = await this.broker._sendRequest({ [type]: symbol, subscribe: 1 });
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
    await this.broker._sendRequest({ forget: sub.subscriptionId });
    this._subscriptions.delete(key);
    this._subscriptionIdMap.delete(sub.subscriptionId);
    this._priceCache.delete(symbol);
    logger.info(`[Streaming] Unsubscribed from ${key}`);
  }

  async restoreSubscriptions() {
    if (this._subscriptions.size === 0) return;
    logger.info('[Streaming] Restoring subscriptions...');
    try {
      await this.broker._sendRequest({ forget_all: 'ticks' });
      logger.info('[Streaming] Cleared old subscriptions.');
    } catch (err) {
      logger.warn('[Streaming] Failed to clear old subscriptions:', err.message);
    }
    for (const [key, sub] of this._subscriptions) {
      try {
        const response = await this.broker._sendRequest({ [sub.type]: sub.symbol, subscribe: 1 });
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
      this._symbols.set(sym.symbol, sym);
      if (sym.leverage) this._leverageMap[sym.symbol] = sym.leverage;
    }
  }

  getLeverage(derivSymbol) { return this._leverageMap[derivSymbol] || 100; }
  getPip(derivSymbol) { return this._symbols.get(derivSymbol)?.pip || 0.0001; }
  getSymbolInfo(derivSymbol) { return this._symbols.get(derivSymbol) || null; }
}

// ============================================================
// PRODUCT EXECUTORS
// ============================================================
class BaseExecutor {
  constructor(broker) { this.broker = broker; }
  async placeMarket(instrument, units, stopLoss, takeProfit) { throw new Error('Not implemented'); }
  async placeLimit(instrument, units, price, stopLoss, takeProfit) { throw new Error('Not implemented'); }
  async close(tradeId) { throw new Error('Not implemented'); }
  async modifySLTP(tradeId, stopLoss, takeProfit) { throw new Error('Not implemented'); }
  async partialClose(tradeId, units) { throw new Error('Not implemented'); }
  async getPositions() { throw new Error('Not implemented'); }
}

// ---- CFD Executor (uses cfd_open_position) ----
class CFDExecutor extends BaseExecutor {
  async placeMarket(instrument, units, stopLoss, takeProfit) {
    const { symbol, amount, direction } = this._prepare(instrument, units);
    const leverage = this.broker.getLeverage(symbol);
    const payload = {
      cfd_open_position: 1,
      symbol,
      amount,
      direction,
      leverage,
    };
    if (stopLoss && !isNaN(stopLoss) && stopLoss > 0) payload.stop_loss = stopLoss;
    if (takeProfit && !isNaN(takeProfit) && takeProfit > 0) payload.take_profit = takeProfit;

    logger.info('[CFDExecutor] Sending open position request:', JSON.stringify(redactSensitive(payload), null, 2));
    const response = await this.broker._sendRequest(payload);
    logger.info('[CFDExecutor] Open position response:', JSON.stringify(redactSensitive(response), null, 2));

    const result = response.cfd_open_position;
    if (!result || !result.position_id) {
      throw new Error('Failed to open CFD position: ' + JSON.stringify(response));
    }
    return {
      tradeID: result.position_id,
      id: result.position_id,
      price: result.entry_price || 0,
      averagePrice: result.entry_price || 0,
      raw: response,
    };
  }

  async placeLimit(instrument, units, price, stopLoss, takeProfit) {
    logger.warn('[CFDExecutor] Limit orders not supported for CFDs; placing market order with price ignored.');
    return this.placeMarket(instrument, units, stopLoss, takeProfit);
  }

  async close(tradeId) {
    if (!tradeId) throw new Error('Position ID required');
    const payload = { cfd_close_position: 1, position_id: tradeId };
    logger.info('[CFDExecutor] Sending close position request:', JSON.stringify(redactSensitive(payload), null, 2));
    const response = await this.broker._sendRequest(payload);
    logger.info('[CFDExecutor] Close position response:', JSON.stringify(redactSensitive(response), null, 2));
    const result = response.cfd_close_position;
    if (!result) throw new Error('Failed to close CFD position: ' + JSON.stringify(response));
    return result;
  }

  async modifySLTP(tradeId, stopLoss, takeProfit) {
    if (!tradeId) throw new Error('Position ID required');
    const payload = { cfd_update_position: 1, position_id: tradeId };
    if (stopLoss && !isNaN(stopLoss) && stopLoss > 0) payload.stop_loss = stopLoss;
    if (takeProfit && !isNaN(takeProfit) && takeProfit > 0) payload.take_profit = takeProfit;
    if (!payload.stop_loss && !payload.take_profit) throw new Error('At least one of stop_loss or take_profit required');
    logger.info('[CFDExecutor] Sending update position request:', JSON.stringify(redactSensitive(payload), null, 2));
    const response = await this.broker._sendRequest(payload);
    logger.info('[CFDExecutor] Update position response:', JSON.stringify(redactSensitive(response), null, 2));
    return response.cfd_update_position;
  }

  async partialClose(tradeId, units) {
    throw new Error('Partial close not supported for CFDs via API');
  }

  async getPositions() {
    const payload = { cfd_get_positions: 1 };
    logger.info('[CFDExecutor] Sending get positions request:', JSON.stringify(redactSensitive(payload), null, 2));
    const response = await this.broker._sendRequest(payload);
    logger.info('[CFDExecutor] Get positions response:', JSON.stringify(redactSensitive(response), null, 2));
    const positions = response.cfd_get_positions || [];
    return positions.map(pos => ({
      id: pos.position_id,
      instrument: fromDerivSymbol(pos.symbol, this.broker.reverseMap) || 'UNKNOWN',
      side: pos.direction === 'up' ? 'BUY' : 'SELL',
      price: pos.entry_price || 0,
      units: pos.amount || 0,
      unrealizedPL: pos.profit_loss || 0,
      currentPrice: pos.current_spot || pos.entry_price || 0,
    }));
  }

  _prepare(instrument, units) {
    const symbol = toDerivSymbol(instrument, this.broker.symbolMap);
    if (!symbol) throw new Error(`Unknown instrument: ${instrument}`);
    const amount = Math.abs(units);
    if (amount <= 0) throw new Error('Units must be positive');
    const direction = units > 0 ? 'up' : 'down';
    return { symbol, amount, direction };
  }
}

// ---- Multiplier Executor (uses proposal -> buy) ----
class MultiplierExecutor extends BaseExecutor {
  async placeMarket(instrument, units, stopLoss, takeProfit) {
    const { symbol, amount, side } = this._prepare(instrument, units);
    const leverage = this.broker.getLeverage(symbol);
    const proposalPayload = {
      proposal: 1,
      amount,
      basis: 'stake',
      currency: this.broker.accountCurrency || 'USD',
      symbol,
      product_type: 'multiplier',
      contract_type: side === 'BUY' ? 'MULTUP' : 'MULTIDOWN',
      multiplier: leverage,
    };
    const limitOrder = {};
    if (stopLoss && !isNaN(stopLoss) && stopLoss > 0) limitOrder.stop_loss = stopLoss;
    if (takeProfit && !isNaN(takeProfit) && takeProfit > 0) limitOrder.take_profit = takeProfit;
    if (Object.keys(limitOrder).length) proposalPayload.limit_order = limitOrder;
    if (this.broker.config.duration) {
      proposalPayload.duration = this.broker.config.duration;
      proposalPayload.duration_unit = 's';
    }
    const proposalResponse = await this.broker._sendRequest(proposalPayload);
    if (!proposalResponse.proposal?.id) throw new Error('Multiplier proposal failed');
    const buyPayload = { buy: proposalResponse.proposal.id, price: 0 };
    const buyResponse = await this.broker._sendRequest(buyPayload);
    return this._formatResponse(buyResponse);
  }

  async placeLimit(instrument, units, price, stopLoss, takeProfit) {
    const { symbol, amount, side } = this._prepare(instrument, units);
    const leverage = this.broker.getLeverage(symbol);
    const proposalPayload = {
      proposal: 1,
      amount,
      basis: 'stake',
      currency: this.broker.accountCurrency || 'USD',
      symbol,
      product_type: 'multiplier',
      contract_type: side === 'BUY' ? 'MULTUP' : 'MULTIDOWN',
      multiplier: leverage,
    };
    const limitOrder = {};
    if (stopLoss && !isNaN(stopLoss) && stopLoss > 0) limitOrder.stop_loss = stopLoss;
    if (takeProfit && !isNaN(takeProfit) && takeProfit > 0) limitOrder.take_profit = takeProfit;
    if (Object.keys(limitOrder).length) proposalPayload.limit_order = limitOrder;
    if (this.broker.config.duration) {
      proposalPayload.duration = this.broker.config.duration;
      proposalPayload.duration_unit = 's';
    }
    const proposalResponse = await this.broker._sendRequest(proposalPayload);
    if (!proposalResponse.proposal?.id) throw new Error('Multiplier proposal failed');
    const buyPayload = { buy: proposalResponse.proposal.id, price: price };
    const buyResponse = await this.broker._sendRequest(buyPayload);
    return this._formatResponse(buyResponse);
  }

  async close(tradeId) {
    const response = await this.broker._sendRequest({ sell: tradeId, price: 0 });
    return response.sell;
  }

  async modifySLTP(tradeId, stopLoss, takeProfit) {
    throw new Error('Modify SL/TP not implemented for Multipliers');
  }

  async partialClose(tradeId, units) {
    throw new Error('Partial close not supported for Multipliers');
  }

  async getPositions() {
    return this.broker.getOpenTrades();
  }

  _prepare(instrument, units) {
    const symbol = toDerivSymbol(instrument, this.broker.symbolMap);
    if (!symbol) throw new Error(`Unknown instrument: ${instrument}`);
    const amount = Math.abs(units);
    if (amount <= 0) throw new Error('Units must be positive');
    const side = units > 0 ? 'BUY' : 'SELL';
    return { symbol, amount, side };
  }

  _formatResponse(response) {
    const tx = response.buy;
    const contractId = tx.contract_id || tx.transaction_id;
    return {
      tradeID: contractId,
      id: contractId,
      price: tx.buy_price || tx.price || 0,
      averagePrice: tx.buy_price || tx.price || 0,
      raw: response,
    };
  }
}

// ---- Basic Options Executor (uses proposal -> buy) ----
class OptionsExecutor extends BaseExecutor {
  async placeMarket(instrument, units, stopLoss, takeProfit) {
    const { symbol, amount, side } = this._prepare(instrument, units);
    if (stopLoss || takeProfit) logger.warn('[Options] SL/TP ignored');
    const duration = this.broker.config.duration || 60;
    const proposalPayload = {
      proposal: 1,
      amount,
      basis: 'stake',
      currency: this.broker.accountCurrency || 'USD',
      symbol,
      product_type: 'basic',
      contract_type: side === 'BUY' ? 'CALL' : 'PUT',
      duration,
      duration_unit: 's',
    };
    const proposalResponse = await this.broker._sendRequest(proposalPayload);
    if (!proposalResponse.proposal?.id) throw new Error('Options proposal failed');
    const buyPayload = { buy: proposalResponse.proposal.id, price: 0 };
    const buyResponse = await this.broker._sendRequest(buyPayload);
    return this._formatResponse(buyResponse);
  }

  async placeLimit(instrument, units, price, stopLoss, takeProfit) {
    logger.warn('[Options] Limit orders not supported; placing market order with price ignored.');
    return this.placeMarket(instrument, units, stopLoss, takeProfit);
  }

  async close(tradeId) {
    const response = await this.broker._sendRequest({ sell: tradeId, price: 0 });
    return response.sell;
  }

  async modifySLTP() { throw new Error('Options do not support SL/TP modification'); }
  async partialClose() { throw new Error('Options do not support partial close'); }

  async getPositions() {
    return this.broker.getOpenTrades();
  }

  _prepare(instrument, units) {
    const symbol = toDerivSymbol(instrument, this.broker.symbolMap);
    if (!symbol) throw new Error(`Unknown instrument: ${instrument}`);
    const amount = Math.abs(units);
    if (amount <= 0) throw new Error('Units must be positive');
    const side = units > 0 ? 'BUY' : 'SELL';
    return { symbol, amount, side };
  }

  _formatResponse(response) {
    const tx = response.buy;
    const contractId = tx.contract_id || tx.transaction_id;
    return {
      tradeID: contractId,
      id: contractId,
      price: tx.buy_price || tx.price || 0,
      averagePrice: tx.buy_price || tx.price || 0,
      raw: response,
    };
  }
}

// ============================================================
// MAIN BROKER CLASS
// ============================================================
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
      duration: config.duration ? parseInt(config.duration) : 60,
      riskValidator: config.riskValidator || null,
      fatalAfterAuthFailures: parseInt(config.fatalAfterAuthFailures || 3),
      readinessTimeout: parseInt(config.readinessTimeout || process.env.DERIV_READINESS_TIMEOUT || 30000),
      symbolTimeout: parseInt(config.symbolTimeout || process.env.DERIV_SYMBOL_TIMEOUT || 30000),
      heartbeatTimeout: parseInt(config.heartbeatTimeout || process.env.DERIV_HEARTBEAT_TIMEOUT || 60000),
    };

    // ---- CHANGE: use config.productType, fallback to environment ----
    const rawProduct = (config.productType || process.env.TRADING_PRODUCT || 'cfd').toLowerCase();
    const validProducts = ['cfd', 'multiplier', 'basic'];
    if (!validProducts.includes(rawProduct)) {
      logger.warn(`[DerivBroker] Invalid productType '${rawProduct}', defaulting to 'cfd'`);
      this.productType = 'cfd';
    } else {
      this.productType = rawProduct;
    }

    this.validateConfig();

    // ---------- Core components ----------
    this._state = STATE.DISCONNECTED;
    this._socket = null;
    this._pendingRequests = new Map();
    this._messageQueue = [];
    this._heartbeatInterval = null;
    this._heartbeatTimeout = null;
    this._lastPong = Date.now();
    this._connectionPromise = null;
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
    logger.info(`[DerivBroker] Using fallback symbols (${Object.keys(this.symbolMap).length} pairs).`);

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
    this._account = null;
    this._portfolioLogged = false;

    // ---------- Instantiate the appropriate executor ----------
    switch (this.productType) {
      case 'cfd':
        this.executor = new CFDExecutor(this);
        break;
      case 'multiplier':
        this.executor = new MultiplierExecutor(this);
        break;
      case 'basic':
        this.executor = new OptionsExecutor(this);
        break;
      default:
        this.executor = new CFDExecutor(this);
    }

    logger.info(`[DerivBroker] Created with product type: ${this.productType}, using ${this.executor.constructor.name}`);
  }

  validateConfig() {
    if (!this.config.apiToken) throw new Error('DERIV_API_TOKEN is required');
    if (!this.config.appId) throw new Error('DERIV_APP_ID is required');
    if (!this.config.wsUrl || !this.config.wsUrl.startsWith('ws')) throw new Error('Invalid WebSocket URL');
    if (this.config.maxQueueSize < 1) throw new Error('maxQueueSize must be at least 1');
    if (isNaN(this.config.leverage) || this.config.leverage <= 0) throw new Error('leverage must be positive');
    if (isNaN(this.config.duration) || this.config.duration <= 0) throw new Error('duration must be positive');
    logger.info('[DerivBroker] Configuration validated.');
  }

  getLeverage(symbol) {
    return this.symbolManager.getLeverage(symbol) || this.config.leverage || 100;
  }

  // ---------- CONNECTION ----------
  async connect() {
    if (this._state === STATE.READY) return;
    if (this._state === STATE.FATAL) throw new Error('Broker in FATAL state.');
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
      let connectionTimer = null;

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
        this.metrics.reconnections++;
        if (attempts > 3) {
          this._setState(STATE.FATAL);
          reject(new Error('Connection failed after 3 attempts.'));
          return;
        }

        this._setState(STATE.CONNECTING);
        logger.info(`[DerivBroker] Connection attempt ${attempts}`);

        if (connectionTimer) {
          clearTimeout(connectionTimer);
          connectionTimer = null;
        }

        try {
          this._socket = new WebSocket(this.config.wsUrl);
          const socket = this._socket;

          this._resetCircuitBreaker();
          socket.removeAllListeners();

          socket.on('open', () => {
            logger.info('[DerivBroker] WebSocket connected.');
            this._setState(STATE.CONNECTED);
            this.metrics.connectedSince = Date.now();
            this._startHeartbeat();

            this._authorize()
              .then(async (authResponse) => {
                if (authResponse && authResponse.authorize) {
                  this._account = authResponse.authorize;
                  this.accountCurrency = this._account.currency || 'USD';
                  logger.info('[DerivBroker] Account stored from authorize.');
                }
                logger.info('[DerivBroker] Authorized.');
                this._authFailCount = 0;
                this._setState(STATE.AUTHENTICATING);

                logger.info('[DerivBroker] Startup: Loading symbols...');
                try {
                  await this._loadSymbolsWithTimeout();
                  logger.info('[DerivBroker] Startup: Symbols loaded.');
                } catch (err) {
                  logger.warn('[DerivBroker] Startup: Symbol loading failed, using fallback:', err.message);
                }

                this._setState(STATE.READY);
                this._flushQueue();

                setImmediate(() => {
                  if (this._state === STATE.READY && this._socket && this._socket.readyState === WebSocket.OPEN) {
                    logger.info('[DerivBroker] Startup: Restoring subscriptions...');
                    this.streaming.restoreSubscriptions()
                      .catch(err => logger.error('[DerivBroker] Subscription restore error:', err.message));

                    logger.info('[DerivBroker] Startup: Reconciling positions...');
                    this._reconcilePositions()
                      .then(() => logger.info('[DerivBroker] Startup: Positions reconciled.'))
                      .catch((err) => logger.error('[DerivBroker] Startup: Position reconciliation error:', err.message));

                    logger.info('[DerivBroker] Startup: Loading pending orders...');
                    this._loadPendingOrders()
                      .then(() => logger.info('[DerivBroker] Startup: Pending orders loaded.'))
                      .catch((err) => logger.error('[DerivBroker] Startup: Pending orders loading error:', err.message));
                  } else {
                    logger.warn('[DerivBroker] Startup: Skipped background tasks – socket not open or not READY.');
                  }
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
                setTimeout(() => attemptConnect(), this._getReconnectDelay(attempts));
              });
          });

          socket.on('message', (data) => this._handleMessage(data));
          socket.on('error', (err) => logger.error('[DerivBroker] WebSocket error:', err.message));
          socket.on('close', (code, reason) => {
            logger.info(`[DerivBroker] WebSocket closed. Code: ${code}, Reason: ${reason || 'No reason'}`);
            if (connectionTimer) {
              clearTimeout(connectionTimer);
              connectionTimer = null;
            }
            if (this._state === STATE.READY || this._state === STATE.CONNECTED || this._state === STATE.AUTHENTICATING) {
              this._setState(STATE.RECONNECTING);
              setTimeout(() => attemptConnect(), this._getReconnectDelay(attempts));
            } else if (this._state === STATE.CONNECTING || this._state === STATE.CONNECTED) {
              reject(new Error(`WebSocket closed unexpectedly: ${code}`));
            }
          });

          connectionTimer = setTimeout(() => {
            logger.error('[DerivBroker] Connection attempt timed out.');
            this._closeSocket();
            reject(new Error('Connection attempt timed out'));
          }, this.config.connectionTimeout);

          this.once('connected', () => {
            if (connectionTimer) {
              clearTimeout(connectionTimer);
              connectionTimer = null;
            }
          });

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

  // ---------- AUTHORIZATION ----------
  _authorize() {
    return new Promise((resolve, reject) => {
      const reqId = generateRequestId();
      const payload = { authorize: this.config.apiToken, req_id: reqId };
      const timeout = setTimeout(() => {
        if (this._pendingRequests.has(reqId)) {
          this._pendingRequests.delete(reqId);
          reject(new Error('Authorize timeout'));
        }
      }, 10000);

      this._pendingRequests.set(reqId, {
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

      this._sendRaw(payload);
    });
  }

  _getReconnectDelay(attempt) {
    const base = this.config.reconnectBaseDelay;
    const max = this.config.maxReconnectDelay;
    const delay = Math.min(base * Math.pow(2, attempt), max);
    const jitter = delay * (0.8 + 0.4 * Math.random());
    return Math.round(jitter);
  }

  // ---------- CIRCUIT BREAKER ----------
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

  // ---------- HEARTBEAT ----------
  _startHeartbeat() {
    this._stopHeartbeat();
    this._lastPong = Date.now();
    this._heartbeatInterval = setInterval(() => {
      if (this._state === STATE.READY || this._state === STATE.CONNECTED) {
        this._sendRaw({ ping: 1 });
        this.metrics.lastHeartbeat = Date.now();
      }
    }, 30000);

    this._heartbeatTimeout = setInterval(() => {
      const now = Date.now();
      if (now - this._lastPong > this.config.heartbeatTimeout) {
        logger.warn('[DerivBroker] Heartbeat timeout – no pong received. Reconnecting...');
        this.metrics.heartbeatMisses++;
        this._closeSocket();
        this.connect().catch(err => logger.error('[DerivBroker] Reconnect after heartbeat timeout failed:', err));
      }
    }, 10000);
  }

  _stopHeartbeat() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
    if (this._heartbeatTimeout) {
      clearInterval(this._heartbeatTimeout);
      this._heartbeatTimeout = null;
    }
  }

  // ---------- MESSAGE HANDLER ----------
  _handleMessage(rawData) {
    try {
      const msg = JSON.parse(rawData);
      logger.debug('[In]', JSON.stringify(redactSensitive(msg)));

      let handled = false;

      if (msg.pong) {
        this._lastPong = Date.now();
        this.metrics.lastPong = this._lastPong;
        handled = true;
      }

      if (msg.error) {
        logger.error('[In] API Error:', JSON.stringify(msg.error, null, 2));
      }

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
        handled = true;
      }

      if (msg.msg_type === 'tick' && msg.tick) {
        this.streaming.handleTick(msg.tick);
        handled = true;
      }

      if (msg.buy || msg.sell || msg.cfd_open_position) {
        this._handleOrderResponse(msg);
        handled = true;
      }

      if (msg.cfd_open_position || msg.cfd_close_position || msg.cfd_update_position || msg.cfd_get_positions) {
        logger.info('[In] CFD response:', JSON.stringify(redactSensitive(msg), null, 2));
      }

      if (msg.portfolio || msg.contracts) {
        const portfolio = msg.portfolio || msg.contracts;
        logger.info('[In] Portfolio response (first 2):', JSON.stringify(Array.isArray(portfolio) ? portfolio.slice(0, 2) : portfolio, null, 2));
        logger.debug('[In] Full portfolio:', JSON.stringify(portfolio, null, 2));
      }

      if (!handled) {
        logger.warn('[In] Unknown message type:', JSON.stringify(redactSensitive(msg), null, 2));
      }
    } catch (err) {
      logger.error('[In] Parse error:', err.message);
    }
  }

  _handleOrderResponse(msg) {
    if (msg.cfd_open_position) {
      const pos = msg.cfd_open_position;
      if (pos.position_id) {
        logger.info('[DerivBroker] CFD position opened:', pos.position_id);
      }
      return;
    }
    if (msg.echo_req && msg.echo_req.client_order_id) {
      const clientOrderId = msg.echo_req.client_order_id;
      const tx = msg.buy || msg.sell;
      if (tx) {
        const contractId = tx.contract_id || tx.transaction_id;
        const status = tx.status || 'FILLED';
        let mappedStatus = ORDER_STATUS.FILLED;
        if (status === 'PENDING') mappedStatus = ORDER_STATUS.PENDING;
        else if (status === 'ACCEPTED') mappedStatus = ORDER_STATUS.ACCEPTED;
        else if (status === 'EXECUTING') mappedStatus = ORDER_STATUS.EXECUTING;
        else if (status === 'REJECTED') mappedStatus = ORDER_STATUS.REJECTED;
        else if (status === 'CANCELLED') mappedStatus = ORDER_STATUS.CANCELLED;
        else if (status === 'CLOSED') mappedStatus = ORDER_STATUS.CLOSED;
        this._updateOrderStatus(clientOrderId, mappedStatus, contractId, tx);
      }
    }
  }

  // ---------- SEND LOGIC ----------
  _sendRaw(payload) {
    if (!this._socket || this._socket.readyState !== WebSocket.OPEN) {
      if (this._messageQueue.length < this.config.maxQueueSize) {
        this._messageQueue.push({ payload, timestamp: Date.now() });
        logger.debug('[DerivBroker] Message queued (socket not open)');
      } else {
        logger.error('[DerivBroker] Queue full, dropping message.');
      }
      return;
    }
    try {
      const isImportant = payload.cfd_open_position || payload.cfd_close_position ||
                          payload.cfd_update_position || payload.cfd_get_positions ||
                          payload.buy || payload.sell || payload.proposal || payload.portfolio ||
                          payload.authorize || payload.active_symbols;
      if (isImportant) {
        logger.info(`[Out] ${payload.req_id || 'no-req-id'} →`, JSON.stringify(redactSensitive(payload), null, 2));
      } else {
        logger.debug(`[Out] ${payload.req_id || 'no-req-id'} →`, JSON.stringify(redactSensitive(payload)));
      }
      this._socket.send(JSON.stringify(payload));
    } catch (err) {
      logger.error('[DerivBroker] Send error:', err.message);
      if (this._messageQueue.length < this.config.maxQueueSize) {
        this._messageQueue.push({ payload, timestamp: Date.now() });
      }
    }
  }

  async _sendRequest(payload, timeoutMs = 15000, signal = null) {
    await this._rateLimiter.acquire();
    if (this._state === STATE.FATAL) throw new Error('Broker in FATAL state.');
    if (this._state !== STATE.READY) await this._ensureReady();
    if (!this._socket || this._socket.readyState !== WebSocket.OPEN) throw new Error('WebSocket not open');
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
        resolve, reject, timeout, sentAt: Date.now(), cancel: onCancel, signal,
      });
      logger.debug(`[DerivBroker] Sending: ${JSON.stringify(msg)}`);
      this._sendRaw(msg);
    });
  }

  _flushQueue() {
    const now = Date.now();
    const maxAge = 300000;
    while (this._messageQueue.length > 0) {
      const item = this._messageQueue[0];
      if (now - item.timestamp > maxAge) {
        this._messageQueue.shift();
        logger.warn('[DerivBroker] Discarded expired queued message');
        continue;
      }
      this._sendRaw(item.payload);
      this._messageQueue.shift();
    }
  }

  // ---------- SYMBOL LOADING ----------
  async _loadSymbolsWithTimeout() {
    return Promise.race([
      this._loadSymbolsInternal(),
      sleep(this.config.symbolTimeout).then(() => {
        throw new Error(`Symbol loading timed out after ${this.config.symbolTimeout}ms`);
      })
    ]);
  }

  async _loadSymbolsInternal() {
    logger.info('[DerivBroker] Fetching active symbols...');
    let lastError = null;
    try {
      const response = await this._sendRawRequest({ active_symbols: 'brief' }, 10000);
      const symbols = response.active_symbols || [];
      if (symbols.length > 0) {
        logger.info(`[Symbols] Loaded ${symbols.length} symbols (brief).`);
        logger.info('[Symbols] First 5 symbols:', JSON.stringify(symbols.slice(0, 5), null, 2));
        logger.debug('[Symbols] Full list:', JSON.stringify(symbols, null, 2));
        this._buildSymbolMaps(symbols);
        this.symbolManager.setSymbols(symbols);
        return;
      }
    } catch (err) {
      lastError = err;
      logger.warn('[DerivBroker] Brief symbol request failed:', err.message);
    }
    try {
      const response = await this._sendRawRequest({ active_symbols: 'all' }, 10000);
      const symbols = response.active_symbols || [];
      if (symbols.length > 0) {
        logger.info(`[Symbols] Loaded ${symbols.length} symbols (all).`);
        logger.info('[Symbols] First 5 symbols:', JSON.stringify(symbols.slice(0, 5), null, 2));
        logger.debug('[Symbols] Full list:', JSON.stringify(symbols, null, 2));
        this._buildSymbolMaps(symbols);
        this.symbolManager.setSymbols(symbols);
        return;
      }
    } catch (err) {
      lastError = err;
      logger.warn('[DerivBroker] All symbol request failed:', err.message);
    }
    throw lastError || new Error('Failed to load symbols from Deriv API.');
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

  // ---------- POSITION RECONCILIATION ----------
  async _reconcilePositions() {
    logger.info('[DerivBroker] Reconciling positions...');
    try {
      if (this.productType === 'cfd') {
        const positions = await this.executor.getPositions();
        logger.info('[Reconcile] CFD positions from API:', JSON.stringify(positions, null, 2));
        const dbOrders = await Order.find({ status: ORDER_STATUS.FILLED });
        const dbMap = new Map();
        for (const ord of dbOrders) {
          if (ord.contractId) dbMap.set(ord.contractId, ord);
        }
        for (const pos of positions) {
          const contractId = pos.id;
          const existing = dbMap.get(contractId);
          if (!existing) {
            const newOrder = new Order({
              clientOrderId: generateClientOrderId(),
              instrument: pos.instrument,
              side: pos.side,
              units: pos.units,
              entryPrice: pos.price,
              status: ORDER_STATUS.FILLED,
              contractId: contractId,
              filledAt: new Date(),
            });
            await newOrder.save();
            this._orders.set(newOrder.clientOrderId, newOrder);
            this._orderMap.set(contractId, newOrder.clientOrderId);
            logger.warn(`[Reconcile] Created order for CFD position ${contractId}`);
          }
        }
        for (const [contractId, clientOrderId] of this._orderMap) {
          const stillOpen = positions.some(p => p.id === contractId);
          if (!stillOpen) {
            await this._updateOrderStatus(clientOrderId, ORDER_STATUS.CLOSED);
            this._orderMap.delete(contractId);
          }
        }
        logger.info('[Reconcile] CFD position reconciliation complete.');
        return;
      }

      const response = await this._sendRequest({ portfolio: 1 });
      let rawPortfolio = response.portfolio || response.contracts || [];
      if (!Array.isArray(rawPortfolio)) {
        if (typeof rawPortfolio === 'object' && rawPortfolio !== null) {
          const keys = Object.keys(rawPortfolio);
          if (keys.length > 0 && !isNaN(keys[0])) {
            rawPortfolio = Object.values(rawPortfolio);
          } else {
            const maybeArray = Object.values(rawPortfolio).find(v => Array.isArray(v));
            if (maybeArray) rawPortfolio = maybeArray;
          }
        }
      }
      if (!Array.isArray(rawPortfolio)) {
        rawPortfolio = [];
        logger.warn('[Reconcile] Unable to parse portfolio response; defaulting to empty array.');
      }
      if (!this._portfolioLogged) {
        logger.info('[Reconcile] Portfolio structure (first 2 items):', JSON.stringify(rawPortfolio.slice(0, 2), null, 2));
        this._portfolioLogged = true;
      }

      const brokerPositions = rawPortfolio;
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

  // ---------- RISK VALIDATION ----------
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

  // ---------- PUBLIC API ----------
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

  // ---------- ORDER PLACEMENT (delegates to executor) ----------
  async placeMarketOrder(instrument, units, stopLoss = null, takeProfit = null) {
    await this._ensureReady();
    const amount = Math.abs(units);
    if (amount <= 0) throw new Error('Order units must be positive.');
    await this._validateOrderRisk(instrument, units > 0 ? 'BUY' : 'SELL', amount, stopLoss, takeProfit);
    const result = await this.executor.placeMarket(instrument, units, stopLoss, takeProfit);
    if (this.productType === 'cfd') {
      const newOrder = new Order({
        clientOrderId: generateClientOrderId(),
        instrument,
        side: units > 0 ? 'BUY' : 'SELL',
        units: amount,
        entryPrice: result.price,
        status: ORDER_STATUS.FILLED,
        contractId: result.tradeID,
        filledAt: new Date(),
      });
      await newOrder.save();
      this._orders.set(newOrder.clientOrderId, newOrder);
      this._orderMap.set(result.tradeID, newOrder.clientOrderId);
    }
    return result;
  }

  async placeLimitOrder(instrument, units, price, stopLoss = null, takeProfit = null) {
    await this._ensureReady();
    const amount = Math.abs(units);
    if (amount <= 0) throw new Error('Order units must be positive.');
    if (price <= 0) throw new Error('Price must be positive.');
    await this._validateOrderRisk(instrument, units > 0 ? 'BUY' : 'SELL', amount, stopLoss, takeProfit);
    return this.executor.placeLimit(instrument, units, price, stopLoss, takeProfit);
  }

  async closeTrade(tradeId) {
    await this._ensureReady();
    if (!tradeId) throw new Error('tradeId is required');
    return this.executor.close(tradeId);
  }

  async modifySLTP(tradeId, stopLoss, takeProfit) {
    await this._ensureReady();
    if (!tradeId) throw new Error('tradeId is required');
    return this.executor.modifySLTP(tradeId, stopLoss, takeProfit);
  }

  async partialClose(tradeId, units) {
    await this._ensureReady();
    if (!tradeId) throw new Error('tradeId is required');
    if (units <= 0) throw new Error('Units must be positive');
    return this.executor.partialClose(tradeId, units);
  }

  async getOpenTrades() {
    await this._ensureReady();
    if (this.productType === 'cfd') {
      return this.executor.getPositions();
    }
    const response = await this._sendRequest({ portfolio: 1 });
    let contracts = response.portfolio || response.contracts || [];
    if (!Array.isArray(contracts)) {
      if (typeof contracts === 'object' && contracts !== null) {
        const keys = Object.keys(contracts);
        if (keys.length > 0 && !isNaN(keys[0])) {
          contracts = Object.values(contracts);
        } else {
          const maybeArray = Object.values(contracts).find(v => Array.isArray(v));
          if (maybeArray) contracts = maybeArray;
          else contracts = [];
        }
      } else {
        contracts = [];
      }
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

  async getPositions() { return this.getOpenTrades(); }

  isConnected() { return this._state === STATE.READY || this._state === STATE.CONNECTED; }
  isAuthorized() { return this._state === STATE.READY || this._state === STATE.AUTHENTICATING; }

  getHealth() {
    const avgLatency = this.metrics.latencyCount > 0 ? this.metrics.totalLatency / this.metrics.latencyCount : 0;
    return {
      state: this._state,
      connected: this.isConnected(),
      authorized: this.isAuthorized(),
      circuitBreaker: this._cbState,
      reconnectCount: this.metrics.reconnections,
      queueSize: this._messageQueue.length,
      pendingRequests: this._pendingRequests.size,
      lastHeartbeat: this.metrics.lastHeartbeat,
      lastPong: this.metrics.lastPong,
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
      this._socket.removeAllListeners();
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
    if (this._state === STATE.FATAL) return Promise.reject(new Error('Broker in FATAL state.'));
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

// ============================================================
// EXPORT – singleton AND class
// ============================================================
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
  leverage: parseFloat(process.env.DERIV_LEVERAGE) || 100,
  duration: process.env.DERIV_DURATION ? parseInt(process.env.DERIV_DURATION) : 60,
  fatalAfterAuthFailures: parseInt(process.env.DERIV_FATAL_AFTER_AUTH_FAILURES) || 3,
  readinessTimeout: parseInt(process.env.DERIV_READINESS_TIMEOUT) || 30000,
  symbolTimeout: parseInt(process.env.DERIV_SYMBOL_TIMEOUT) || 30000,
  heartbeatTimeout: parseInt(process.env.DERIV_HEARTBEAT_TIMEOUT) || 60000,
  productType: process.env.TRADING_PRODUCT || 'cfd', // backward compatibility
});

// Export both the singleton and the class
module.exports = brokerInstance;
module.exports.DerivBroker = DerivBroker;
