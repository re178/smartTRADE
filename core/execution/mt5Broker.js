// core/execution/mt5Broker.js
// MT5 Broker Adapter – uses the polling-based MT5 Bridge

const axios = require('axios');
const { EventEmitter } = require('events');
const logger = require('../../infrastructure/logger') || console;

class MT5Broker extends EventEmitter {
  constructor(config = {}) {
    super();
    this.renderUrl = config.renderUrl || process.env.RENDER_URL || 'https://tradermarketopen.onrender.com';
    this.apiKey = config.apiKey || process.env.MT5_API_KEY || '';
    this.pollInterval = config.pollInterval || 2000;
    this._state = 'DISCONNECTED';
    this._pendingCommands = new Map();
    this._pollingTimer = null;
    this._lastStatus = null;
    this._positions = [];
    this._heartbeatState = {
      bridgeOnline: false,
      eaOnline: false,
      brokerOnline: false,
      tradingAllowed: false,
    };

    this.capabilities = {
      supportsMarketOrders: true,
      supportsLimitOrders: true,
      supportsPendingOrders: true,
      supportsModify: true,
      supportsClose: true,
      supportsCancel: true,
      supportsPartialClose: false,
      supportsHedging: true,
      supportsNetting: false,
      supportsPriceFeed: true,
      supportsSpread: true,
      supportsHistory: true,
    };

    this.serverName = 'MT5';

    logger.info('[MT5Broker] Initialized with Render URL:', this.renderUrl);
    if (this.apiKey) {
      logger.info('[MT5Broker] API key configured (length:', this.apiKey.length, ')');
    } else {
      logger.warn('[MT5Broker] No API key set – requests will be unauthenticated.');
    }
  }

  // ---------- Helper: get headers with API key ----------
  _getHeaders(extra = {}) {
    const headers = { 'Content-Type': 'application/json', ...extra };
    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }
    return headers;
  }

  // ---------- Internal: ensure ready ----------
  async _ensureReady() {
    if (this._state !== 'READY') {
      await this.connect();
    }
  }

  // ---------- Connection (uses account status, not heartbeat) ----------
  async connect() {
    if (this._state === 'READY') return;
    try {
      // Check account status (with API key)
      const statusResp = await axios.get(`${this.renderUrl}/api/mt5/account/status`, {
        headers: this._getHeaders(),
        timeout: 5000,
      });
      const data = statusResp.data;
      if (!data || !data.login) {
        throw new Error('Invalid account status response');
      }
      this._lastStatus = data;
      this._state = 'READY';
      this._heartbeatState.bridgeOnline = true;
      this._heartbeatState.eaOnline = true;    // EA is online if account status is available
      this._heartbeatState.brokerOnline = true;
      this._heartbeatState.tradingAllowed = true;
      this.emit('ready');
      this.emit('connected');
      logger.info('[MT5Broker] Connected to MT5 Bridge (via account status)');
      this._startPolling();
    } catch (err) {
      logger.error('[MT5Broker] Connection failed:', err.message);
      throw new Error('MT5 Bridge unreachable or EA offline (account status check failed)');
    }
  }

  async disconnect() {
    this._stopPolling();
    this._state = 'DISCONNECTED';
    this._heartbeatState.bridgeOnline = false;
    this._heartbeatState.eaOnline = false;
    this._heartbeatState.brokerOnline = false;
    this._heartbeatState.tradingAllowed = false;
    logger.info('[MT5Broker] Disconnected');
  }

  isConnected() { return this._state === 'READY'; }
  isAuthorized() { return this._state === 'READY'; }

  // ---------- Market Order ----------
  async placeMarketOrder(instrument, units, stopLoss = null, takeProfit = null) {
    await this._ensureReady();
    const side = units > 0 ? 'BUY' : 'SELL';
    const cmdId = `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const payload = {
      commandId: cmdId,
      action: 'OPEN',
      instrument,
      side,
      units: Math.abs(units),
      stopLoss,
      takeProfit,
    };

    await axios.post(`${this.renderUrl}/api/mt5/orders/command`, payload, {
      headers: this._getHeaders(),
      timeout: 5000,
    });

    const result = await this._waitForResult(cmdId);
    if (!result.success) {
      throw new Error(result.error || 'Order execution failed');
    }

    return {
      tradeID: String(result.ticket || result.tradeID || ''),
      ticket: result.ticket || result.tradeID || '',
      price: result.price || 0,
      raw: result,
    };
  }

  // ---------- Close Trade ----------
  async closeTrade(tradeId) {
    await this._ensureReady();
    if (!this.capabilities.supportsClose) throw new Error('Close not supported');
    const cmdId = `close_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const payload = { commandId: cmdId, action: 'CLOSE', tradeId };
    await axios.post(`${this.renderUrl}/api/mt5/orders/command`, payload, {
      headers: this._getHeaders(),
      timeout: 5000,
    });
    const result = await this._waitForResult(cmdId);
    if (!result.success) throw new Error(result.error || 'Close failed');
    return result;
  }

  // ---------- Modify SL/TP ----------
  async modifySLTP(tradeId, stopLoss, takeProfit) {
    await this._ensureReady();
    if (!this.capabilities.supportsModify) throw new Error('Modify not supported');
    const cmdId = `mod_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const payload = { commandId: cmdId, action: 'MODIFY', tradeId, stopLoss, takeProfit };
    await axios.post(`${this.renderUrl}/api/mt5/orders/command`, payload, {
      headers: this._getHeaders(),
      timeout: 5000,
    });
    const result = await this._waitForResult(cmdId);
    if (!result.success) throw new Error(result.error || 'Modify failed');
    return result;
  }

  // ---------- Cancel Order (pending) ----------
  async cancelOrder(tradeId) {
    await this._ensureReady();
    if (!this.capabilities.supportsCancel) throw new Error('Cancel not supported');
    const cmdId = `cancel_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const payload = { commandId: cmdId, action: 'CANCEL', tradeId };
    await axios.post(`${this.renderUrl}/api/mt5/orders/command`, payload, {
      headers: this._getHeaders(),
      timeout: 5000,
    });
    const result = await this._waitForResult(cmdId);
    if (!result.success) throw new Error(result.error || 'Cancel failed');
    return result;
  }

  // ---------- Alias for modify ----------
  async modifyTrade(tradeId, stopLoss, takeProfit) {
    return this.modifySLTP(tradeId, stopLoss, takeProfit);
  }

  // ---------- Get Price and Spread ----------
  async getPrice(symbol) {
    await this._ensureReady();
    try {
      const response = await axios.get(
        `${this.renderUrl}/api/mt5/price/${encodeURIComponent(symbol)}`,
        {
          headers: this._getHeaders(),
          timeout: 5000,
        }
      );
      return response.data;
    } catch (err) {
      logger.warn(`[MT5Broker] getPrice failed for ${symbol}:`, err.message);
      throw err;
    }
  }

  async getSpread(symbol) {
    await this._ensureReady();
    try {
      const priceData = await this.getPrice(symbol);
      return priceData.spread || 0;
    } catch (err) {
      logger.warn(`[MT5Broker] getSpread failed for ${symbol}:`, err.message);
      return 0;
    }
  }

  // ---------- getPrices (dashboard compatibility) ----------
  async getPrices(instruments) {
    if (!Array.isArray(instruments)) {
      instruments = [instruments];
    }
    const results = [];
    for (const symbol of instruments) {
      try {
        const priceData = await this.getPrice(symbol);
        results.push({
          symbol: priceData.symbol,
          bids: [{ price: priceData.bid }],
          asks: [{ price: priceData.ask }],
          time: priceData.time,
          spread: priceData.spread,
        });
      } catch (err) {
        logger.warn(`[MT5Broker] getPrices failed for ${symbol}:`, err.message);
        results.push({
          symbol,
          bids: [{ price: 0 }],
          asks: [{ price: 0 }],
          error: err.message,
        });
      }
    }
    return results;
  }

  // ---------- Get Trade by ticket ----------
  async getTrade(ticket) {
    await this._ensureReady();
    try {
      const response = await axios.get(
        `${this.renderUrl}/api/mt5/trade/${encodeURIComponent(ticket)}`,
        {
          headers: this._getHeaders(),
          timeout: 5000,
        }
      );
      return response.data;
    } catch (err) {
      logger.warn(`[MT5Broker] getTrade ${ticket} failed:`, err.message);
      throw err;
    }
  }

  // ---------- Get History ----------
  async getHistory(from, to, symbol) {
    await this._ensureReady();
    if (!this.capabilities.supportsHistory) throw new Error('History not supported');
    try {
      const params = new URLSearchParams();
      if (from) params.append('from', from);
      if (to) params.append('to', to);
      if (symbol) params.append('symbol', symbol);
      const url = `${this.renderUrl}/api/mt5/history?${params.toString()}`;
      const response = await axios.get(url, {
        headers: this._getHeaders(),
        timeout: 10000,
      });
      return response.data;
    } catch (err) {
      logger.warn('[MT5Broker] getHistory failed:', err.message);
      throw err;
    }
  }

  // ---------- Wait for Command Result (Polling) ----------
  _waitForResult(commandId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingCommands.delete(commandId);
        reject(new Error(`Command ${commandId} timed out`));
      }, timeoutMs);

      this._pendingCommands.set(commandId, { resolve, reject, timer });
    });
  }

  // ---------- Poll Results from Backend ----------
  _startPolling() {
    if (this._pollingTimer) return;
    this._pollingTimer = setInterval(async () => {
      if (this._pendingCommands.size === 0) return;
      const entries = Array.from(this._pendingCommands.entries());
      for (const [cmdId, pending] of entries) {
        try {
          const response = await axios.get(
            `${this.renderUrl}/api/mt5/orders/result/${cmdId}`,
            {
              headers: this._getHeaders(),
              timeout: 3000,
            }
          );
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
    }, this.pollInterval);
  }

  _stopPolling() {
    if (this._pollingTimer) {
      clearInterval(this._pollingTimer);
      this._pollingTimer = null;
    }
    for (const [cmdId, pending] of this._pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Broker disconnected'));
    }
    this._pendingCommands.clear();
  }

  // ---------- Get Account ----------
  async getAccount() {
    await this._ensureReady();
    try {
      const response = await axios.get(
        `${this.renderUrl}/api/mt5/account/status`,
        {
          headers: this._getHeaders(),
          timeout: 5000,
        }
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
          leverage: data.leverage || '0',
          marginLevel: data.marginLevel || '0',
          stopOut: data.stopOut || '0',
          tradeMode: data.tradeMode || 'unknown',
          company: data.company || '',
          accountName: data.accountName || '',
          server: data.server || '',
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
    await this._ensureReady();
    try {
      const response = await axios.get(
        `${this.renderUrl}/api/mt5/positions`,
        {
          headers: this._getHeaders(),
          timeout: 5000,
        }
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
        stopLoss: p.stop_loss || 0,
        takeProfit: p.take_profit || 0,
        swap: p.swap || 0,
        openTime: p.open_time || 0,
        magic: p.magic || 0,
        comment: p.comment || '',
        identifier: p.identifier || '',
      }));
    } catch (err) {
      logger.warn('[MT5Broker] getOpenTrades failed:', err.message);
      return [];
    }
  }

  async getPositions() { return this.getOpenTrades(); }

  // ---------- Heartbeat State ----------
  getHeartbeatState() {
    return { ...this._heartbeatState };
  }

  // ---------- Health ----------
  getHealth() {
    return {
      state: this._state,
      connected: this.isConnected(),
      lastStatus: this._lastStatus ? 'available' : 'none',
      positions: this._positions ? this._positions.length : 0,
      pendingCommands: this._pendingCommands.size,
      heartbeat: this._heartbeatState,
    };
  }
}

module.exports = MT5Broker;
