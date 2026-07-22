// api/routes/publicApi.js – Public API (strictly delegates to controllers)

const express = require('express');
const router = express.Router();

// ---------- Models & Services ----------
const ApiKey = require('../models/ApiKey');
const User = require('../models/User');
const { compareSecret } = require('../services/apiKeyGenerator');

// ---------- Controllers ----------
const controllers = require('../controllers');

const logger = require('../infrastructure/logger') || console;

// ============================================================
// AUTHENTICATION MIDDLEWARE
// ============================================================
const authenticateApiKey = async (req, res, next) => {
  try {
    const apiKeyHeader = req.headers['x-api-key'];
    const apiSecretHeader = req.headers['x-api-secret'];

    if (!apiKeyHeader || !apiSecretHeader) {
      logger.warn('Missing API Key or Secret');
      return res.status(401).json({ error: 'Missing API Key or Secret' });
    }

    const credential = await ApiKey.findOne({ apiKey: apiKeyHeader });
    if (!credential) {
      logger.warn(`Invalid API Key: ${apiKeyHeader}`);
      return res.status(401).json({ error: 'Invalid API credentials' });
    }

    if (credential.status !== 'active' || credential.disabled) {
      logger.warn(`Disabled API Key: ${apiKeyHeader}`);
      return res.status(403).json({ error: 'API Key is disabled' });
    }

    const secretValid = await compareSecret(apiSecretHeader, credential.hashedSecret);
    if (!secretValid) {
      logger.warn(`Invalid Secret for Key: ${apiKeyHeader}`);
      return res.status(401).json({ error: 'Invalid API credentials' });
    }

    // Update last used timestamp
    credential.lastUsed = new Date();
    await credential.save();

    // ---- Fetch user's trading product from the owner ----
    let tradingProduct = process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd';
    if (credential.owner) {
      const user = await User.findOne({ userId: credential.owner });
      if (user && user.tradingProduct) {
        tradingProduct = user.tradingProduct;
      } else {
        logger.warn(`[PublicAPI] No user found for owner ${credential.owner}, using fallback`);
      }
    }

    // Attach to request – controllers expect `req.user.tradingProduct`
    req.apiKey = credential.apiKey;
    req.permissions = credential.permissions;
    req.user = { tradingProduct };

    next();
  } catch (error) {
    logger.error('API Key authentication error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Apply authentication to all public routes
router.use(authenticateApiKey);

// ============================================================
// ROUTES – All delegate to controllers
// ============================================================

// ---- Account ----
router.get('/account', controllers.getAccount);

// ---- Positions ----
router.get('/positions', controllers.getPositions);

// ---- Open Trades ----
router.get('/trades', controllers.getTrades);

// ---- Prices (multiple instruments) ----
router.get('/prices', controllers.getPrices);

// ---- Price for a single symbol (reuses getPrices) ----
router.get('/price/:symbol', (req, res) => {
  req.query.instruments = req.params.symbol;
  controllers.getPrices(req, res);
});

// ---- Candles (OHLCV) ----
router.get('/candles', controllers.getCandles);

// ---- Symbol Metadata ----
router.get('/symbols', controllers.getSymbols);

// ---- Broker Capabilities ----
router.get('/capabilities', controllers.getCapabilities);

// ---- Trade History ----
router.get('/history', controllers.getTradeHistory);

// ---- Place Order (maps public fields to controller fields) ----
router.post('/orders', (req, res) => {
  if (!req.permissions.includes('orders.write')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  const { symbol, type, volume, stopLoss, takeProfit } = req.body;
  if (!symbol || !type || !volume) {
    return res.status(400).json({ error: 'symbol, type and volume are required' });
  }

  // Convert type to side (buy→BUY, sell→SELL)
  const side = type.toUpperCase() === 'BUY' ? 'BUY' : 'SELL';

  // Re‑build request body for controller
  req.body = {
    pair: symbol,
    side,
    lotSize: parseFloat(volume),
    stopLoss: stopLoss || null,
    takeProfit: takeProfit || null,
  };

  controllers.placeOrder(req, res);
});

// ---- Close Trade ----
router.post('/close/:tradeId', (req, res) => {
  if (!req.permissions.includes('orders.write')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  controllers.closeTrade(req, res);
});

// ---- Submit Signal (store in DB) ----
router.post('/signals', (req, res) => {
  if (!req.permissions.includes('signals.write')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  controllers.submitSignal(req, res);
});

// ---- Get Signal (generate from strategy) ----
router.get('/signal', controllers.getSignal);

// ---- Auto-Trade (optional) ----
router.post('/auto-trade', (req, res) => {
  if (!req.permissions.includes('orders.write')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  controllers.autoTrade(req, res);
});

// ---- Pending Orders (optional for external visibility) ----
router.get('/pending-orders', (req, res) => {
  if (!req.permissions.includes('orders.write')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  controllers.getPendingOrders(req, res);
});

// ---- Cancel Order ----
router.delete('/order/:orderId', (req, res) => {
  if (!req.permissions.includes('orders.write')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  controllers.cancelOrder(req, res);
});

// ---- Delete History (admin-like) ----
router.delete('/history', (req, res) => {
  if (!req.permissions.includes('history.write')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  controllers.deleteHistory(req, res);
});

module.exports = router;
