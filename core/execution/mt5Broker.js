// core/execution/mt5Broker.js
// MT5 Broker Adapter – uses the polling-based MT5 Bridge

const axios = require('axios');
const { EventEmitter } = require('events');
const logger = require('../../infrastructure/logger') || console;

class MT5Broker extends EventEmitter {
  constructor(config = {}) {
    super();
    this.renderUrl = config.renderUrl || process.env.RENDER_URL || 'https://tradermarketopen.onrender.com';
    this.pollInterval = config.pollInterval || 2000; // increased from 1000 to be gentler
    this._state = 'DISCONNECTED';
    this._pendingCommands = new Map(); // commandId -> { resolve, reject, timeout }
    this._pollingTimer = null;
    this._lastStatus = null;
    this._positions = [];
    this._heartbeatState = {
      bridgeOnline: false,
      eaOnline: false,
      brokerOnline: false,
      tradingAllowed: false,
    };

    // ---- Updated capabilities ----
    this.capabilities = {
      supportsMarketOrders: true,
      supportsLimitOrders: true,        // FIX: now true
      supportsPendingOrders: true,      // FIX: now true
      supportsModify: true,
      supportsClose: true,
      supportsCancel: true,
      supportsPartialClose: false,      // optional; EA can support but we set false if not yet
      supportsHedging: true,
      supportsNetting: false,
      supportsPriceFeed: true,
      supportsSpread: true,
      supportsHistory: true,
    };

    this.serverName = 'MT5'; // for analytics

    logger.info('[MT5Broker] Initialized with Render URL:', this.renderUrl);
  }

  // ---------- Internal: ensure ready ----------
  async _ensureReady() {
    if (this._state !== 'READY') {
      await this.connect();
    }
  }

  // ---------- Connection ----------
  async connect() {
    if (this._state === 'READY') return;
    try {
      await axios.get(`${this.renderUrl}/api/mt5/account/status`, { timeout: 5000 });
      this._state = 'READY';
      this._heartbeatState.bridgeOnline = true;
      this._heartbeatState.eaOnline = true;
      this._heartbeatState.brokerOnline = true;
      this._heartbeatState.tradingAllowed = true;
      this.emit('ready');
      this.emit('connected');
      logger.info('[MT5Broker] Connected to MT5 Bridge');
      this._startPolling();
    } catch (err) {
      logger.error('[MT5Broker] Connection failed:', err.message);
      throw new Error('MT5 Bridge unreachable');
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

    await axios.post(`${this.renderUrl}/api/mt5/orders/command`, payload, { timeout: 5000 });

    const result = await this._waitForResult(cmdId);
    if (!result.success) {
      throw new Error(result.error || 'Order execution failed');
    }

    // ---- FIX: Return execution price from result ----
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
    await axios.post(`${this.renderUrl}/api/mt5/orders/command`, payload, { timeout: 5000 });
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
    await axios.post(`${this.renderUrl}/api/mt5/orders/command`, payload, { timeout: 5000 });
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
    await axios.post(`${this.renderUrl}/api/mt5/orders/command`, payload, { timeout: 5000 });
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
        { timeout: 5000 }
      );
      return response.data; // { bid, ask, spread, digits, point, tick_size, tick_value, symbol, time }
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

  // ---------- Get Trade by ticket ----------
  async getTrade(ticket) {
    await this._ensureReady();
    try {
      const response = await axios.get(
        `${this.renderUrl}/api/mt5/trade/${encodeURIComponent(ticket)}`,
        { timeout: 5000 }
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
      const response = await axios.get(url, { timeout: 10000 });
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
      // ---- FIX: Snapshot to avoid mutation issues ----
      const entries = Array.from(this._pendingCommands.entries());
      for (const [cmdId, pending] of entries) {
        try {
          const response = await axios.get(
            `${this.renderUrl}/api/mt5/orders/result/${cmdId}`,
            { timeout: 3000 }
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
