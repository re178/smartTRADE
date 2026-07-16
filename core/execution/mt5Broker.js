// core/execution/mt5Broker.js
// MT5 Broker Adapter – communicates with MT5 Bridge via Render API

const axios = require('axios');
const { EventEmitter } = require('events');
const logger = require('../../infrastructure/logger') || console;

class MT5Broker extends EventEmitter {
  constructor(config = {}) {
    super();
    this.renderUrl = config.renderUrl || process.env.RENDER_URL || 'https://tradermarketopen.onrender.com';
    this._state = 'DISCONNECTED';
    this._lastStatus = null;
    this._positions = [];
    this.capabilities = {
      supportsMarketOrders: true,
      supportsLimitOrders: false,
      supportsPartialClose: false,
      supportsHedging: true,
      supportsNetting: false,
    };
    logger.info('[MT5Broker] Initialized with Render URL:', this.renderUrl);
  }

  // ---------- Connection ----------
  async connect() {
    if (this._state === 'READY') return;
    this._state = 'READY';
    this.emit('ready');
    this.emit('connected');
    logger.info('[MT5Broker] Connected to MT5 Bridge');
  }

  async disconnect() {
    this._state = 'DISCONNECTED';
    logger.info('[MT5Broker] Disconnected');
  }

  isConnected() { return this._state === 'READY'; }
  isAuthorized() { return this._state === 'READY'; }

  // ---------- Market Order ----------
  async placeMarketOrder(instrument, units, stopLoss = null, takeProfit = null) {
    const side = units > 0 ? 'BUY' : 'SELL';
    const payload = {
      action: 'OPEN',
      instrument,
      side,
      units: Math.abs(units),
      stopLoss,
      takeProfit,
    };
    try {
      const response = await axios.post(
        `${this.renderUrl}/api/mt5/orders/command`,
        payload,
        { timeout: 10000 }
      );
      return {
        tradeID: response.data.orderId,
        price: 0, // Will be updated when executed
        raw: response.data,
      };
    } catch (err) {
      logger.error('[MT5Broker] placeMarketOrder error:', err.message);
      throw new Error(`MT5 order failed: ${err.message}`);
    }
  }

  // ---------- Close Trade ----------
  async closeTrade(tradeId) {
    const payload = { action: 'CLOSE', tradeId };
    try {
      const response = await axios.post(
        `${this.renderUrl}/api/mt5/orders/command`,
        payload,
        { timeout: 10000 }
      );
      return response.data;
    } catch (err) {
      logger.error('[MT5Broker] closeTrade error:', err.message);
      throw new Error(`MT5 close failed: ${err.message}`);
    }
  }

  // ---------- Modify SL/TP ----------
  async modifySLTP(tradeId, stopLoss, takeProfit) {
    const payload = { action: 'MODIFY', tradeId, stopLoss, takeProfit };
    try {
      const response = await axios.post(
        `${this.renderUrl}/api/mt5/orders/command`,
        payload,
        { timeout: 10000 }
      );
      return response.data;
    } catch (err) {
      logger.error('[MT5Broker] modifySLTP error:', err.message);
      throw new Error(`MT5 modify failed: ${err.message}`);
    }
  }

  // ---------- Get Account ----------
  async getAccount() {
    try {
      const response = await axios.get(
        `${this.renderUrl}/api/mt5/account/status`,
        { timeout: 5000 }
      );
      const data = response.data;
      if (data && data.login) {
        this._lastStatus = data;
        return {
          id: String(data.login),
          balance: String(data.balance || 0),
          currency: data.currency || 'USD',
          equity: String(data.equity || 0),
          marginUsed: String(data.margin || 0),
          marginAvailable: String(data.free_margin || 0),
        };
      }
    } catch (err) {
      logger.warn('[MT5Broker] getAccount failed, returning default');
    }
    return {
      id: 'MT5_ACCOUNT',
      balance: '0',
      currency: 'USD',
      equity: '0',
      marginUsed: '0',
      marginAvailable: '0',
    };
  }

  // ---------- Get Open Trades ----------
  async getOpenTrades() {
    try {
      const response = await axios.get(
        `${this.renderUrl}/api/mt5/positions`,
        { timeout: 5000 }
      );
      const positions = response.data?.positions || [];
      this._positions = positions;
      return positions.map(p => ({
        id: String(p.ticket),
        instrument: p.symbol,
        side: p.type,
        price: p.price || 0,
        units: p.volume || 0,
        unrealizedPL: p.profit || 0,
        currentPrice: p.current_price || p.price || 0,
      }));
    } catch (err) {
      logger.warn('[MT5Broker] getOpenTrades failed:', err.message);
      return [];
    }
  }

  async getPositions() { return this.getOpenTrades(); }

  // ---------- Health ----------
  getHealth() {
    return {
      state: this._state,
      connected: this.isConnected(),
      lastStatus: this._lastStatus ? 'available' : 'none',
      positions: this._positions.length,
    };
  }

  // ---------- Helper to ensure ready ----------
  async _ensureReady() {
    if (this._state !== 'READY') await this.connect();
  }
}

module.exports = MT5Broker;
