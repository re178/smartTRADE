const express = require('express');
const router = express.Router();

// Reuse existing models – adjust names to match your project’s exact casing
const Mt5Account = require('../models/Mt5Account');
const Mt5Price = require('../models/Mt5Price');
const Mt5Position = require('../models/Mt5Position');
const Trade = require('../models/Trade');
// If an Order model already exists for the command queue, reuse it; otherwise, fallback to inline
let Order;
try {
  Order = require('../models/Order');
} catch (e) {
  // Define a minimal Order model inline (not recommended, adjust to your actual model)
  const mongoose = require('mongoose');
  const orderSchema = new mongoose.Schema({
    symbol: String,
    type: { type: String, enum: ['buy', 'sell'] },
    volume: Number,
    price: Number,
    status: { type: String, default: 'pending' },
    apiKey: String, // track which API key created it
    createdAt: { type: Date, default: Date.now }
  }, { collection: 'orders' });
  Order = mongoose.model('Order', orderSchema);
}

// Inline Signal model (new collection, no separate file)
const mongoose = require('mongoose');
let Signal;
try {
  Signal = require('../models/Signal');
} catch (e) {
  const signalSchema = new mongoose.Schema({
    symbol: String,
    direction: { type: String, enum: ['buy', 'sell'] },
    timeframe: String,
    price: Number,
    comment: String,
    apiKey: String,
    createdAt: { type: Date, default: Date.now }
  });
  Signal = mongoose.model('Signal', signalSchema);
}

const ApiKey = require('../models/ApiKey');
const { compareSecret } = require('../services/apiKeyGenerator');
const { logger } = require('../utils/logger');

// Authentication middleware
const authenticateApiKey = async (req, res, next) => {
  try {
    const apiKeyHeader = req.headers['x-api-key'];
    const apiSecretHeader = req.headers['x-api-secret'];

    if (!apiKeyHeader || !apiSecretHeader) {
      logger.warn('Missing API Key or Secret in request');
      return res.status(401).json({ error: 'Missing API Key or Secret' });
    }

    const credential = await ApiKey.findOne({ apiKey: apiKeyHeader });
    if (!credential) {
      logger.warn(`Invalid API Key: ${apiKeyHeader}`);
      return res.status(401).json({ error: 'Invalid API credentials' });
    }

    if (credential.status !== 'active' || credential.disabled) {
      logger.warn(`Disabled API Key attempt: ${apiKeyHeader}`);
      return res.status(403).json({ error: 'API Key is disabled' });
    }

    const secretValid = await compareSecret(apiSecretHeader, credential.hashedSecret);
    if (!secretValid) {
      logger.warn(`Invalid Secret for API Key: ${apiKeyHeader}`);
      return res.status(401).json({ error: 'Invalid API credentials' });
    }

    // Update last used timestamp
    credential.lastUsed = new Date();
    await credential.save();

    // Attach credentials & permissions to request for further use
    req.apiKey = credential.apiKey;
    req.permissions = credential.permissions;
    next();
  } catch (error) {
    logger.error('API Key authentication error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Apply authentication to all public routes
router.use(authenticateApiKey);

// GET /api/public/account
router.get('/account', async (req, res) => {
  try {
    // Return latest account data (assumes a single document or findOne sorted)
    const account = await Mt5Account.findOne().sort({ _id: -1 });
    if (!account) {
      return res.status(404).json({ error: 'No account data available' });
    }
    res.json(account);
  } catch (error) {
    logger.error('Error fetching account:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/public/positions
router.get('/positions', async (req, res) => {
  try {
    const positions = await Mt5Position.find();
    res.json(positions);
  } catch (error) {
    logger.error('Error fetching positions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/public/prices
router.get('/prices', async (req, res) => {
  try {
    // Return all latest prices – assuming each symbol has one document
    const prices = await Mt5Price.find();
    res.json(prices);
  } catch (error) {
    logger.error('Error fetching prices:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/public/price/:symbol
router.get('/price/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    // Assuming symbol is stored as upper-case; adjust as needed
    const price = await Mt5Price.findOne({ symbol: symbol.toUpperCase() });
    if (!price) {
      return res.status(404).json({ error: `Price not found for symbol: ${symbol}` });
    }
    res.json(price);
  } catch (error) {
    logger.error('Error fetching price:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/public/history
router.get('/history', async (req, res) => {
  try {
    // Return all trades history (or add query params as needed)
    const trades = await Trade.find().sort({ time: -1 });
    res.json(trades);
  } catch (error) {
    logger.error('Error fetching history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/public/signals
router.post('/signals', async (req, res) => {
  try {
    // Only users with signals.write permission can proceed
    if (!req.permissions.includes('signals.write')) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const { symbol, direction, timeframe, price, comment } = req.body;
    if (!symbol || !direction) {
      return res.status(400).json({ error: 'symbol and direction are required' });
    }
    const signal = new Signal({
      symbol: symbol.toUpperCase(),
      direction,
      timeframe: timeframe || 'M5',
      price: price || 0,
      comment: comment || '',
      apiKey: req.apiKey,
      createdAt: new Date()
    });
    await signal.save();
    logger.info(`Signal created by ${req.apiKey}: ${symbol} ${direction}`);
    res.status(201).json({ message: 'Signal recorded', signalId: signal._id });
  } catch (error) {
    logger.error('Error saving signal:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/public/orders
router.post('/orders', async (req, res) => {
  try {
    if (!req.permissions.includes('orders.write')) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const { symbol, type, volume, price } = req.body;
    if (!symbol || !type || !volume) {
      return res.status(400).json({ error: 'symbol, type and volume are required' });
    }
    // Create an order document that the existing command queue can process
    const order = new Order({
      symbol: symbol.toUpperCase(),
      type: type.toLowerCase(),
      volume,
      price: price || 0,
      status: 'pending',
      apiKey: req.apiKey,
      createdAt: new Date()
    });
    await order.save();
    logger.info(`Order created by ${req.apiKey}: ${symbol} ${type} ${volume}`);
    res.status(201).json({ message: 'Order placed', orderId: order._id });
  } catch (error) {
    logger.error('Error placing order:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
