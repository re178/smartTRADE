// core/execution/mt5Broker.js – Deriv MT5 CFD Driver (WebSocket)

const WebSocket = require('ws');
const axios = require('axios');
const { EventEmitter } = require('events');
const { sleep } = require('../../shared/helpers');
const logger = require('../../infrastructure/logger') || console;

// ---------- Configuration ----------
const CONFIG = {
  OTP_ENDPOINT: (accountId) =>
    `https://api.derivws.com/trading/v1/options/accounts/${accountId}/otp`,
  WS_URL_PUBLIC: 'wss://api.derivws.com/trading/v1/options/ws/public',
  RECONNECT_BASE_DELAY: 2000,
  MAX_RECONNECT_DELAY: 30000,
  HEARTBEAT_INTERVAL: 30000,
  REQUEST_TIMEOUT: 15000,
  MAX_RETRIES: 3,
};

// ---------- Internal Managers ----------
class ConnectionManager {
  constructor(broker) {
    this.broker = broker;
    this.ws = null;
    this.isConnected = false;
    this.isAuthenticated = false;
    this.reconnectAttempts = 0;
    this.heartbeatInterval = null;
    this.reconnectTimer = null;
  }

  async connect() {
    if (this.isConnected && this.isAuthenticated) return;

    // Get OTP URL
    const wsUrl = await this.broker.authManager.getOtpUrl();
    logger.info('[MT5Broker] Connecting to:', wsUrl);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);
      this.ws.on('open', () => {
        logger.info('[MT5Broker] WebSocket connected.');
        this.isConnected = true;
        this.isAuthenticated = true; // OTP handles auth
        this.reconnectAttempts = 0;
        this._startHeartbeat();
        this.broker.emit('connected');
        resolve();
      });

      this.ws.on('message', (data) => this.broker._handleMessage(data));

      this.ws.on('error', (err) => {
        logger.error('[MT5Broker] WebSocket error:', err.message);
        this._scheduleReconnect();
      });

      this.ws.on('close', () => {
        logger.info('[MT5Broker] WebSocket closed.');
        this.isConnected = false;
        this.isAuthenticated = false;
        this._stopHeartbeat();
        this._scheduleReconnect();
      });
    });
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.isConnected) {
        this.broker._sendRaw({ ping: 1 });
      }
    }, CONFIG.HEARTBEAT_INTERVAL);
  }

  _stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(
      CONFIG.RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts),
      CONFIG.MAX_RECONNECT_DELAY
    );
    this.reconnectAttempts++;
    logger.info(`[MT5Broker] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {});
    }, delay);
  }

  disconnect() {
    this._stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.isAuthenticated = false;
  }

  isReady() {
    return this.isConnected && this.isAuthenticated;
  }
}

class AuthenticationManager {
  constructor(broker) {
    this.broker = broker;
    this.appId = broker.appId;
    this.apiToken = broker.apiToken;
    this.accountId = broker.accountId;
  }

  async getOtpUrl() {
    try {
      const response = await axios.post(
        CONFIG.OTP_ENDPOINT(this.accountId),
        {},
        {
          headers: {
            'Deriv-App-ID': this.appId,
            'Authorization': `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json',
          },
        }
      );
      return response.data.data.url;
    } catch (error) {
      const msg = error.response?.data?.message || error.message;
      logger.error('[MT5Broker] OTP request failed:', msg);
      throw new Error(`OTP request failed: ${msg}`);
    }
  }
}

class MarketDataManager {
  constructor(broker) {
    this.broker = broker;
    this.priceCache = {};
    this.subscriptions = new Map();
  }

  async getPrices(instruments) {
    const results = [];
    for (const pair of instruments) {
      const symbol = this.broker._mapSymbol(pair);
      const response = await this.broker._sendRequest({ ticks: symbol, subscribe: false });
      const tick = response.tick;
      results.push({
        instrument: pair,
        bids: [{ price: tick.bid ? tick.bid.toFixed(5) : tick.quote.toFixed(5) }],
        asks: [{ price: tick.ask ? tick.ask.toFixed(5) : tick.quote.toFixed(5) }],
        time: tick.epoch || Date.now(),
      });
    }
    return results;
  }

  async getCandles(instrument, count = 100, granularity = 'M5') {
    const symbol = this.broker._mapSymbol(instrument);
    const intervalMap = {
      'M1': 60, 'M5': 300, 'M15': 900, 'M30': 1800,
      'H1': 3600, 'H4': 14400, 'D': 86400,
    };
    const seconds = intervalMap[granularity] || 300;
    const end = Math.floor(Date.now() / 1000);
    const start = end - (count * seconds + 10);
    const response = await this.broker._sendRequest({
      ohlc: symbol,
      interval: seconds,
      start,
      end,
    });
    const candles = response.candles || [];
    const sorted = candles.slice(-count);
    return sorted.map(c => ({
      mid: { o: c.open, h: c.high, l: c.low, c: c.close },
      time: c.epoch,
      complete: true,
    }));
  }

  updatePriceCache(symbol, bid, ask) {
    this.priceCache[symbol] = { bid, ask, time: Date.now() };
  }

  getPriceCache(symbol) {
    return this.priceCache[symbol] || null;
  }
}

class OrderManager {
  constructor(broker) {
    this.broker = broker;
    this.pendingOrders = new Map();
    this.filledOrders = new Map();
  }

  async placeMarketOrder(instrument, units, stopLoss = null, takeProfit = null) {
    const side = units > 0 ? 'BUY' : 'SELL';
    const quantity = Math.abs(units);
    const symbol = this.broker._mapSymbol(instrument);
    const payload = {
      new_order: {
        symbol,
        side,
        quantity,
        type: 'market',
      },
    };
    if (stopLoss) payload.new_order.stop_loss = stopLoss;
    if (takeProfit) payload.new_order.take_profit = takeProfit;

    const response = await this.broker._sendRequest(payload);
    const order = response.order;
    return {
      tradeID: order.order_id,
      id: order.order_id,
      price: order.price || 0,
      averagePrice: order.avg_price || order.price || 0,
    };
  }

  async placeLimitOrder(instrument, units, price, stopLoss = null, takeProfit = null) {
    const side = units > 0 ? 'BUY' : 'SELL';
    const quantity = Math.abs(units);
    const symbol = this.broker._mapSymbol(instrument);
    const payload = {
      new_order: {
        symbol,
        side,
        quantity,
        type: 'limit',
        price,
      },
    };
    if (stopLoss) payload.new_order.stop_loss = stopLoss;
    if (takeProfit) payload.new_order.take_profit = takeProfit;

    const response = await this.broker._sendRequest(payload);
    const order = response.order;
    return {
      tradeID: order.order_id,
      id: order.order_id,
      price: order.price || 0,
      averagePrice: order.avg_price || order.price || 0,
    };
  }

  async closeTrade(tradeId) {
    const payload = { close_order: { order_id: tradeId } };
    const response = await this.broker._sendRequest(payload);
    return response.order;
  }

  async getOpenTrades() {
    const response = await this.broker._sendRequest({ positions: 1 });
    const positions = response.positions || [];
    return positions.map(p => ({
      id: p.order_id,
      instrument: this.broker._reverseMapSymbol(p.symbol),
      side: p.side,
      price: p.price,
      units: p.quantity,
      unrealizedPL: p.unrealized_pl || 0,
      currentPrice: p.current_price || p.price,
      stopLoss: p.stop_loss,
      takeProfit: p.take_profit,
    }));
  }
}

class PositionManager {
  constructor(broker) {
    this.broker = broker;
    this._localPositions = new Map(); // orderId -> position
  }

  async reconcile() {
    // Sync broker positions with local cache
    const brokerPositions = await this.broker.orderManager.getOpenTrades();
    const localIds = new Set(this._localPositions.keys());
    const brokerIds = new Set(brokerPositions.map(p => p.id));

    // Remove positions that no longer exist on broker
    for (const id of localIds) {
      if (!brokerIds.has(id)) {
        this._localPositions.delete(id);
        logger.info(`[PositionManager] Removed closed position ${id}`);
      }
    }

    // Add or update positions
    for (const pos of brokerPositions) {
      this._localPositions.set(pos.id, pos);
      logger.debug(`[PositionManager] Synced position ${pos.id}`);
    }

    logger.info(`[PositionManager] Reconciliation complete. ${this._localPositions.size} positions active.`);
    return Array.from(this._localPositions.values());
  }

  getPosition(orderId) {
    return this._localPositions.get(orderId) || null;
  }

  getAllPositions() {
    return Array.from(this._localPositions.values());
  }
}

// ---------- Main Broker Class ----------
class MT5Broker extends EventEmitter {
  constructor(config = {}) {
    super();
    this.appId = config.appId || process.env.DERIV_APP_ID;
    this.apiToken = config.apiToken || process.env.DERIV_API_TOKEN;
    this.accountId = config.accountId || process.env.DERIV_ACCOUNT_ID;
    this.wsUrl = config.wsUrl || process.env.DERIV_MT5_WS_URL;

    if (!this.appId) throw new Error('DERIV_APP_ID is required');
    if (!this.apiToken) throw new Error('DERIV_API_TOKEN is required');
    if (!this.accountId) throw new Error('DERIV_ACCOUNT_ID is required');

    // Managers
    this.authManager = new AuthenticationManager(this);
    this.connectionManager = new ConnectionManager(this);
    this.marketDataManager = new MarketDataManager(this);
    this.orderManager = new OrderManager(this);
    this.positionManager = new PositionManager(this);

    // Pending requests
    this._pendingRequests = new Map();
    this._requestCounter = 0;

    // Symbol maps
    this.symbolMap = {
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
    };
    this.reverseSymbolMap = Object.fromEntries(
      Object.entries(this.symbolMap).map(([k, v]) => [v, k])
    );

    // Feature flags
    this.features = {
      supportsTrailingStop: false,
      supportsHedging: false,
      supportsPartialClose: true,
      supportsGuaranteedSL: false,
      supportsOCO: false,
      supportsMarketOrders: true,
      supportsLimitOrders: true,
      supportsStopOrders: true,
    };

    logger.info('[MT5Broker] Initialized.');
  }

  // ---------- Connection API ----------
  async connect() {
    await this.connectionManager.connect();
    // After connection, reconcile positions
    await this.positionManager.reconcile();
    this.emit('ready');
  }

  async disconnect() {
    this.connectionManager.disconnect();
    this.emit('disconnected');
  }

  isConnected() {
    return this.connectionManager.isReady();
  }

  isAuthorized() {
    return this.connectionManager.isAuthenticated;
  }

  // ---------- Request Sending ----------
  _sendRaw(payload) {
    if (!this.connectionManager.isReady()) {
      throw new Error('WebSocket not ready');
    }
    this.connectionManager.ws.send(JSON.stringify(payload));
  }

  async _sendRequest(payload, timeoutMs = CONFIG.REQUEST_TIMEOUT) {
    // Ensure connection
    if (!this.connectionManager.isReady()) {
      await this.connect();
    }

    const reqId = ++this._requestCounter;
    const msg = { ...payload, req_id: reqId };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this._pendingRequests.has(reqId)) {
          this._pendingRequests.delete(reqId);
          reject(new Error(`Request timed out (${timeoutMs}ms)`));
        }
      }, timeoutMs);

      this._pendingRequests.set(reqId, { resolve, reject, timeout });
      this._sendRaw(msg);
    });
  }

  _handleMessage(rawData) {
    try {
      const msg = JSON.parse(rawData);

      // Response to a pending request
      if (msg.req_id && this._pendingRequests.has(msg.req_id)) {
        const pending = this._pendingRequests.get(msg.req_id);
        clearTimeout(pending.timeout);
        this._pendingRequests.delete(msg.req_id);
        if (msg.error) {
          pending.reject(new Error(`MT5 API error: ${msg.error.message}`));
        } else {
          pending.resolve(msg);
        }
        return;
      }

      // Heartbeat response
      if (msg.pong) {
        // Ignore
        return;
      }

      // Tick updates
      if (msg.msg_type === 'tick' && msg.tick) {
        const tick = msg.tick;
        this.marketDataManager.updatePriceCache(tick.symbol, tick.bid, tick.ask);
        // Emit for subscribers
        this.emit('tick', { symbol: tick.symbol, bid: tick.bid, ask: tick.ask });
        return;
      }

      // Order updates (execution reports)
      if (msg.execution) {
        const exec = msg.execution;
        logger.info(`[MT5Broker] Execution report: ${exec.order_id} ${exec.status}`);
        this.emit('execution', exec);
        return;
      }
    } catch (err) {
      logger.error('[MT5Broker] Error parsing message:', err.message);
    }
  }

  // ---------- Public API (Broker Interface) ----------
  async getAccount() {
    const response = await this._sendRequest({ account: 1 });
    const acc = response.account;
    return {
      id: acc.account_id || this.accountId,
      balance: acc.balance || '0',
      currency: acc.currency || 'USD',
      equity: acc.equity || acc.balance || '0',
      marginUsed: acc.margin_used || '0',
      marginAvailable: acc.margin_available || '0',
      createdTime: new Date().toISOString(),
    };
  }

  async getPrices(instruments) {
    return this.marketDataManager.getPrices(instruments);
  }

  async getCandles(instrument, count = 100, granularity = 'M5') {
    return this.marketDataManager.getCandles(instrument, count, granularity);
  }

  async placeMarketOrder(instrument, units, stopLoss = null, takeProfit = null) {
    const result = await this.orderManager.placeMarketOrder(instrument, units, stopLoss, takeProfit);
    await this.positionManager.reconcile(); // sync after order
    return result;
  }

  async placeLimitOrder(instrument, units, price, stopLoss = null, takeProfit = null) {
    const result = await this.orderManager.placeLimitOrder(instrument, units, price, stopLoss, takeProfit);
    await this.positionManager.reconcile();
    return result;
  }

  async closeTrade(tradeId) {
    const result = await this.orderManager.closeTrade(tradeId);
    await this.positionManager.reconcile();
    return result;
  }

  async getOpenTrades() {
    // Return from local cache (already reconciled)
    return this.positionManager.getAllPositions();
  }

  async getPositions() {
    return this.getOpenTrades();
  }

  // ---------- Symbol Mapping ----------
  _mapSymbol(pair) {
    return this.symbolMap[pair] || pair;
  }

  _reverseMapSymbol(symbol) {
    return this.reverseSymbolMap[symbol] || symbol;
  }

  // ---------- Health ----------
  getHealth() {
    return {
      connected: this.isConnected(),
      authorized: this.isAuthorized(),
      openPositions: this.positionManager.getAllPositions().length,
      pendingRequests: this._pendingRequests.size,
    };
  }

  // ---------- Kill Switch ----------
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
    await this.disconnect();
    logger.warn('🚨 Kill switch complete.');
  }
}

module.exports = MT5Broker;
