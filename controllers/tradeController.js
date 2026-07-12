const oanda = require('../services/oandaService');
const strategy = require('../services/strategyService');
const risk = require('../services/riskManager');
const Trade = require('../models/Trade');

// Get account summary
exports.getAccount = async (req, res) => {
  try {
    const account = await oanda.getAccount();
    res.json(account);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Get current prices for a list of pairs
exports.getPrices = async (req, res) => {
  const { instruments } = req.query;
  if (!instruments) return res.status(400).json({ error: 'instruments required' });
  try {
    const prices = await oanda.getPrices(instruments.split(','));
    res.json(prices);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Get open positions
exports.getPositions = async (req, res) => {
  try {
    const positions = await oanda.getPositions();
    res.json(positions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Get open trades
exports.getTrades = async (req, res) => {
  try {
    const trades = await oanda.getOpenTrades();
    res.json(trades);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Execute a market order (manual)
exports.placeOrder = async (req, res) => {
  const { pair, side, stopLoss, takeProfit, lotSize } = req.body;
  if (!pair || !side) {
    return res.status(400).json({ error: 'pair and side required' });
  }
  try {
    const units = side === 'BUY' ? lotSize : -lotSize;
    const result = await oanda.placeMarketOrder(pair, units, stopLoss, takeProfit);
    // Save to DB
    const trade = new Trade({
      pair,
      side,
      entryPrice: result.price || result.averagePrice,
      stopLoss,
      takeProfit,
      lotSize,
      status: 'OPEN',
      oandaTradeId: result.tradeID || result.id,
      oandaOrderId: result.id,
    });
    await trade.save();
    res.json({ success: true, trade, oanda: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Close a trade
exports.closeTrade = async (req, res) => {
  const { tradeId } = req.params;
  try {
    const result = await oanda.closeTrade(tradeId);
    // Update DB
    await Trade.findOneAndUpdate({ oandaTradeId: tradeId }, { status: 'CLOSED', closeTime: new Date() });
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Generate a signal based on strategy
exports.getSignal = async (req, res) => {
  const { pair } = req.query;
  if (!pair) return res.status(400).json({ error: 'pair required' });
  try {
    const signal = await strategy.generateSignal(pair);
    if (!signal) return res.json({ signal: null, message: 'No signal' });
    res.json(signal);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Auto-trade: generate signal and execute if found
exports.autoTrade = async (req, res) => {
  const { pair, riskPercent = 1 } = req.body;
  if (!pair) return res.status(400).json({ error: 'pair required' });
  try {
    const signal = await strategy.generateSignal(pair);
    if (!signal) {
      return res.json({ success: false, message: 'No trading signal' });
    }
    // Calculate lot size
    const lotSize = await risk.calculateLotSize(
      signal.pair,
      signal.entryPrice,
      signal.stopLoss,
      riskPercent
    );
    // Place order
    const units = signal.side === 'BUY' ? lotSize : -lotSize;
    const result = await oanda.placeMarketOrder(
      signal.pair,
      units,
      signal.stopLoss,
      signal.takeProfit
    );
    // Save trade
    const trade = new Trade({
      pair: signal.pair,
      side: signal.side,
      entryPrice: result.price || result.averagePrice,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      lotSize,
      status: 'OPEN',
      oandaTradeId: result.tradeID || result.id,
      oandaOrderId: result.id,
      notes: 'Auto-trade from strategy',
    });
    await trade.save();
    res.json({ success: true, signal, trade, oanda: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Get all trades from DB (history)
exports.getTradeHistory = async (req, res) => {
  try {
    const trades = await Trade.find().sort({ createdAt: -1 });
    res.json(trades);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
