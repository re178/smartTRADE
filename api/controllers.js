// src/api/controllers.js – Request Handlers

const Trade = require('../../models/Trade');

// Core modules
const marketProvider = require('../core/market/provider');
const broker = require('../core/execution/broker');
const orderService = require('../core/execution/orderService');
const strategyEngine = require('../core/strategy/engine');
const riskManager = require('../core/risk/manager');
const portfolioLogger = require('../core/portfolio/logger');
const accountService = require('../core/portfolio/accountService');
const { formatPrice, validatePair } = require('../shared/helpers');
const { validateOrderInput } = require('../shared/validators');

// ---------- Account ----------
exports.getAccount = async (req, res) => {
  try {
    const account = await accountService.getAccount();
    res.json(account);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ---------- Market Data ----------
exports.getPrices = async (req, res) => {
  const { instruments } = req.query;
  if (!instruments) {
    return res.status(400).json({ error: 'instruments query param required' });
  }
  try {
    const pairs = instruments.split(',');
    const prices = await marketProvider.getPrices(pairs);
    res.json(prices);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getCandles = async (req, res) => {
  const { pair, count = 100, granularity = 'M5' } = req.query;
  if (!pair) {
    return res.status(400).json({ error: 'pair query param required' });
  }
  try {
    const candles = await marketProvider.getCandles(pair, parseInt(count), granularity);
    res.json(candles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ---------- Positions & Trades ----------
exports.getPositions = async (req, res) => {
  try {
    const positions = await broker.getPositions();
    res.json(positions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getTrades = async (req, res) => {
  try {
    const trades = await broker.getOpenTrades();
    res.json(trades);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getTradeHistory = async (req, res) => {
  try {
    const trades = await Trade.find().sort({ createdAt: -1 });
    res.json(trades);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ---------- Manual Order ----------
exports.placeOrder = async (req, res) => {
  const { pair, side, lotSize, stopLoss, takeProfit } = req.body;

  // Validate input
  const validation = validateOrderInput({ pair, side, lotSize, stopLoss, takeProfit });
  if (!validation.valid) {
    return res.status(400).json({ error: validation.message });
  }

  try {
    // Ensure pair is uppercase
    const instrument = pair.toUpperCase();

    // Place the order via order service
    const orderResult = await orderService.placeMarketOrder(
      instrument,
      side,
      lotSize,
      stopLoss || null,
      takeProfit || null
    );

    // Save to database
    const trade = await portfolioLogger.logTrade({
      pair: instrument,
      side,
      entryPrice: orderResult.price || orderResult.averagePrice,
      stopLoss: stopLoss || null,
      takeProfit: takeProfit || null,
      lotSize,
      status: 'OPEN',
      oandaTradeId: orderResult.tradeID || orderResult.id,
      oandaOrderId: orderResult.id,
      broker: 'OANDA',
      strategy: 'Manual',
    });

    res.json({ success: true, trade, oanda: orderResult });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.closeTrade = async (req, res) => {
  const { tradeId } = req.params;
  if (!tradeId) {
    return res.status(400).json({ error: 'tradeId required' });
  }
  try {
    const result = await orderService.closeTrade(tradeId);
    // Update DB: find trade by oandaTradeId and mark closed
    await Trade.findOneAndUpdate(
      { oandaTradeId: tradeId },
      {
        status: 'CLOSED',
        closeTime: new Date(),
        closePrice: result.price || null,
        pnl: result.pl || 0,
      }
    );
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ---------- Strategy & Signal ----------
exports.getSignal = async (req, res) => {
  const { pair } = req.query;
  if (!pair) {
    return res.status(400).json({ error: 'pair query param required' });
  }
  try {
    const instrument = pair.toUpperCase();
    const signal = await strategyEngine.generateSignal(instrument);
    if (!signal) {
      return res.json({ signal: null, message: 'No signal generated' });
    }
    res.json(signal);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ---------- Auto Trade ----------
exports.autoTrade = async (req, res) => {
  const { pair, riskPercent = 1 } = req.body;
  if (!pair) {
    return res.status(400).json({ error: 'pair required' });
  }
  try {
    const instrument = pair.toUpperCase();

    // 1. Generate signal
    const signal = await strategyEngine.generateSignal(instrument);
    if (!signal) {
      return res.json({ success: false, message: 'No trading signal' });
    }

    // 2. Calculate lot size
    const lotSize = await riskManager.calculateLotSize(
      instrument,
      signal.entryPrice,
      signal.stopLoss,
      riskPercent
    );

    // 3. Validate trade (risk checks)
    const validation = await riskManager.validateTrade(instrument, signal.side, lotSize);
    if (!validation.approved) {
      return res.json({ success: false, message: validation.reason });
    }

    // 4. Place order
    const orderResult = await orderService.placeMarketOrder(
      instrument,
      signal.side,
      lotSize,
      signal.stopLoss,
      signal.takeProfit
    );

    // 5. Log to DB
    const trade = await portfolioLogger.logTrade({
      pair: instrument,
      side: signal.side,
      entryPrice: orderResult.price || orderResult.averagePrice,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      lotSize,
      status: 'OPEN',
      oandaTradeId: orderResult.tradeID || orderResult.id,
      oandaOrderId: orderResult.id,
      broker: 'OANDA',
      strategy: signal.strategy || 'MA_Crossover',
      notes: 'Auto-trade from strategy',
    });

    res.json({ success: true, signal, trade, oanda: orderResult });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
