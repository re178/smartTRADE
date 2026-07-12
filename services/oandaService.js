const axios = require('axios');

class OandaService {
  constructor() {
    this.apiKey = process.env.OANDA_API_KEY;
    this.accountId = process.env.OANDA_ACCOUNT_ID;
    this.baseUrl = process.env.OANDA_API_URL;
    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  // Account info
  async getAccount() {
    const res = await this.client.get(`/v3/accounts/${this.accountId}`);
    return res.data.account;
  }

  // Current prices for a list of instruments
  async getPrices(instruments) {
    const res = await this.client.get('/v3/accounts/' + this.accountId + '/pricing', {
      params: { instruments: instruments.join(',') },
    });
    return res.data.prices;
  }

  // Candles (max 5000)
  async getCandles(instrument, count = 100, granularity = 'M5') {
    const res = await this.client.get(`/v3/instruments/${instrument}/candles`, {
      params: { count, granularity, price: 'M' },
    });
    return res.data.candles;
  }

  // Place market order
  async placeMarketOrder(instrument, units, stopLoss, takeProfit) {
    const order = {
      order: {
        type: 'MARKET',
        instrument,
        units,
        stopLossOnFill: stopLoss ? { price: stopLoss.toString() } : undefined,
        takeProfitOnFill: takeProfit ? { price: takeProfit.toString() } : undefined,
      },
    };
    const res = await this.client.post(`/v3/accounts/${this.accountId}/orders`, order);
    return res.data.orderFillTransaction;
  }

  // Place limit order (not used in minimal version)
  async placeLimitOrder(instrument, units, price, stopLoss, takeProfit) {
    const order = {
      order: {
        type: 'LIMIT',
        instrument,
        units,
        price: price.toString(),
        stopLossOnFill: stopLoss ? { price: stopLoss.toString() } : undefined,
        takeProfitOnFill: takeProfit ? { price: takeProfit.toString() } : undefined,
      },
    };
    const res = await this.client.post(`/v3/accounts/${this.accountId}/orders`, order);
    return res.data.orderCreateTransaction;
  }

  // Get open trades
  async getOpenTrades() {
    const res = await this.client.get(`/v3/accounts/${this.accountId}/trades`);
    return res.data.trades;
  }

  // Get positions
  async getPositions() {
    const res = await this.client.get(`/v3/accounts/${this.accountId}/positions`);
    return res.data.positions;
  }

  // Close a trade
  async closeTrade(tradeId) {
    const res = await this.client.put(`/v3/accounts/${this.accountId}/trades/${tradeId}/close`);
    return res.data;
  }
}

module.exports = new OandaService();
