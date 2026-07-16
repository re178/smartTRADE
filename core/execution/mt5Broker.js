// core/execution/mt5Broker.js
// MT5 Broker Adapter – uses the polling-based MT5 Bridge

const axios = require('axios');
const { EventEmitter } = require('events');
const logger = require('../../infrastructure/logger') || console;

class MT5Broker extends EventEmitter {
  constructor(config = {}) {
    super();
    this.renderUrl = config.renderUrl || process.env.RENDER_URL || 'https://tradermarketopen.onrender.com';
    this.pollInterval = config.pollInterval || 1000; // ms between result checks
    this._state = 'DISCONNECTED';
    this._pendingCommands = new Map(); // commandId -> { resolve, reject, timeout }
    this._pollingTimer = null;
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
    try {
      await axios.get(`${this.renderUrl}/api/mt5/account/status`, { timeout: 5000 });
      this._state = 'READY';
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
    logger.info('[MT5Broker] Disconnected');
  }

  isConnected() { return this._state === 'READY'; }
  isAuthorized() { return this._state === 'READY'; }

  // ---------- Market Order ----------
  async placeMarketOrder(instrument, units, stopLoss = null, takeProfit = null) {
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

    // Submit command to pending queue (the EA will pick it up)
    await axios.post(`${this.renderUrl}/api/mt5/orders/command`, payload, { timeout: 5000 });

    // Wait for result via polling
    const result = await this._waitForResult(cmdId);
    if (!result.success) {
      throw new Error(result.error || 'Order execution failed');
    }
    return {
      tradeID: String(result.ticket),
      price: 0, // price not returned, can fetch from positions later
      raw: result,
    };
  }

  // ---------- Close Trade ----------
  async closeTrade(tradeId) {
    const cmdId = `close_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const payload = { commandId: cmdId, action: 'CLOSE', tradeId };
    await axios.post(`${this.renderUrl}/api/mt5/orders/command`, payload, { timeout: 5000 });
    const result = await this._waitForResult(cmdId);
    if (!result.success) throw new Error(result.error || 'Close failed');
    return result;
  }

  // ---------- Modify SL/TP ----------
  async modifySLTP(tradeId, stopLoss, takeProfit) {
    const cmdId = `mod_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const payload = { commandId: cmdId, action: 'MODIFY', tradeId, stopLoss, takeProfit };
    await axios.post(`${this.renderUrl}/api/mt5/orders/command`, payload, { timeout: 5000 });
    const result = await this._waitForResult(cmdId);
    if (!result.success) throw new Error(result.error || 'Modify failed');
    return result;
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
      for (const [cmdId, pending] of this._pendingCommands) {
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
        stopLoss: p.stop_loss || 0,
        takeProfit: p.take_profit || 0,
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
      positions: this._positions ? this._positions.length : 0,
      pendingCommands: this._pendingCommands.size,
    };
  }

  // ---------- Ensure ready ----------
  async _ensureReady() {
    if (this._state !== 'READY') await this.connect();
  }
}

module.exports = MT5Broker;
