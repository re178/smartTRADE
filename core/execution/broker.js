// src/core/execution/broker.js – Broker Abstraction (OANDA Implementation)

const axios = require('axios');

/**
 * Broker interface for OANDA REST API v20.
 * All methods return promises with normalized data.
 * To add a new broker, implement the same methods.
 */
class Broker {
  constructor() {
    this.apiKey = process.env.OANDA_API_KEY;
    this.accountId = process.env.OANDA_ACCOUNT_ID;
    this.baseUrl = process.env.OANDA_API_URL || 'https://api-fxpractice.oanda.com';

    // Validate required environment variables
    if (!this.apiKey || !this.accountId) {
      console.warn('⚠️ OANDA credentials missing. Broker will not work.');
    }

    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });
  }

  /**
   * Get account details (balance, equity, margin, currency, etc.)
   * @returns {Promise<Object>} Account object.
   */
  async getAccount() {
    const res = await this.client.get(`/v3/accounts/${this.accountId}`);
    return res.data.account;
  }

  /**
   * Get current prices for one or more instruments.
   * @param {string[]} instruments - Array of instrument names.
   * @returns {Promise<Object[]>} Array of price objects.
   */
  async getPrices(instruments) {
    const res = await this.client.get(`/v3/accounts/${this.accountId}/pricing`, {
      params: { instruments: instruments.join(',') },
    });
    return res.data.prices;
  }

  /**
   * Get candlestick data.
   * @param {string} instrument - Instrument name.
   * @param {number} count - Number of candles (max 5000).
   * @param {string} granularity - Granularity (e.g., 'M5', 'H1', 'D').
   * @param {string} price - Price component ('M' for mid, 'B' for bid, 'A' for ask).
   * @returns {Promise<Object[]>} Array of candle objects.
   */
  async getCandles(instrument, count = 100, granularity = 'M5', price = 'M') {
    const res = await this.client.get(`/v3/instruments/${instrument}/candles`, {
      params: { count, granularity, price },
    });
    return res.data.candles;
  }

  /**
   * Place a market order.
   * @param {string} instrument - Instrument name.
   * @param {number} units - Positive for BUY, negative for SELL.
   * @param {number|null} stopLoss - Stop loss price (optional).
   * @param {number|null} takeProfit - Take profit price (optional).
   * @returns {Promise<Object>} Transaction object containing trade ID and execution price.
   */
  async placeMarketOrder(instrument, units, stopLoss = null, takeProfit = null) {
    const order = {
      order: {
        type: 'MARKET',
        instrument,
        units,
      },
    };

    if (stopLoss) {
      order.order.stopLossOnFill = { price: stopLoss.toString() };
    }
    if (takeProfit) {
      order.order.takeProfitOnFill = { price: takeProfit.toString() };
    }

    const res = await this.client.post(`/v3/accounts/${this.accountId}/orders`, order);
    // The response contains the transaction that executed the order.
    // It may be in orderFillTransaction or orderCreateTransaction depending on success.
    const fill = res.data.orderFillTransaction || res.data.orderCreateTransaction;
    return fill;
  }

  /**
   * Get all open trades.
   * @returns {Promise<Object[]>} Array of trade objects.
   */
  async getOpenTrades() {
    const res = await this.client.get(`/v3/accounts/${this.accountId}/trades`);
    return res.data.trades || [];
  }

  /**
   * Get all positions.
   * @returns {Promise<Object[]>} Array of position objects.
   */
  async getPositions() {
    const res = await this.client.get(`/v3/accounts/${this.accountId}/positions`);
    return res.data.positions || [];
  }

  /**
   * Close a specific trade by ID.
   * @param {string} tradeId - OANDA trade ID.
   * @returns {Promise<Object>} Close transaction response.
   */
  async closeTrade(tradeId) {
    const res = await this.client.put(`/v3/accounts/${this.accountId}/trades/${tradeId}/close`);
    return res.data;
  }

  /**
   * Get instrument specification (pip location, etc.) – not used now.
   * @param {string} instrument - Instrument name.
   * @returns {Promise<Object>} Instrument details.
   */
  async getInstrument(instrument) {
    const res = await this.client.get(`/v3/accounts/${this.accountId}/instruments/${instrument}`);
    return res.data.instrument;
  }

  /**
   * Place a limit order (future).
   * @param {string} instrument - Instrument name.
   * @param {number} units - Positive for BUY, negative for SELL.
   * @param {number} price - Limit price.
   * @param {number|null} stopLoss - Stop loss price (optional).
   * @param {number|null} takeProfit - Take profit price (optional).
   * @returns {Promise<Object>} Transaction object.
   */
  async placeLimitOrder(instrument, units, price, stopLoss = null, takeProfit = null) {
    const order = {
      order: {
        type: 'LIMIT',
        instrument,
        units,
        price: price.toString(),
      },
    };
    if (stopLoss) order.order.stopLossOnFill = { price: stopLoss.toString() };
    if (takeProfit) order.order.takeProfitOnFill = { price: takeProfit.toString() };

    const res = await this.client.post(`/v3/accounts/${this.accountId}/orders`, order);
    return res.data.orderCreateTransaction;
  }
}

// Export a singleton instance – we can later use a factory to switch brokers.
module.exports = new Broker();
