// api/routes/deriv.js
// REST endpoints for Deriv broker data and operations
// All data is sourced from the Deriv broker or the new broker-agnostic models (Price, Account).

const express = require('express');
const router = express.Router();
const logger = require('../../infrastructure/logger') || console;

// Models
const Price = require('../../models/Price');
const Account = require('../../models/Account');

// Services
const { getBroker } = require('../../core/execution/brokerFactory');
const orderService = require('../../core/execution/orderService');

// Authentication (reuse the same API key as before)
const API_KEY = process.env.MT5_API_KEY || 'change-me-in-production'; // keep the same env var for simplicity, or rename to DERIV_API_KEY
const authenticate = (req, res, next) => {
  const key = req.headers['x-api-key'];
  if (key && key === API_KEY) return next();
  res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
};
router.use(authenticate);

// ---------- Health ----------
router.get('/health', async (req, res) => {
  try {
    const broker = getBroker('deriv_cfd');
    const health = broker.getHealth();
    res.json({
      status: 'ok',
      broker: 'deriv',
      health,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Price ----------
router.get('/price/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const upperSymbol = symbol.toUpperCase();
    const price = await Price.getLatest(upperSymbol);
    if (!price) {
      return res.status(404).json({ error: 'No price available for symbol' });
    }
    res.json(price);
  } catch (err) {
    logger.error('[Deriv] Error fetching price:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Optionally get multiple prices
router.get('/prices', async (req, res) => {
  try {
    const symbols = req.query.symbols ? req.query.symbols.split(',') : [];
    if (symbols.length === 0) {
      return res.status(400).json({ error: 'Provide symbols query param (comma-separated)' });
    }
    const prices = await Promise.all(
      symbols.map(async (sym) => {
        const price = await Price.getLatest(sym.toUpperCase());
        return { symbol: sym.toUpperCase(), ...price };
      })
    );
    res.json({ prices });
  } catch (err) {
    logger.error('[Deriv] Error fetching prices:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Account ----------
router.get('/account', async (req, res) => {
  try {
    const account = await Account.getLatest('default');
    res.json(account);
  } catch (err) {
    logger.error('[Deriv] Error fetching account:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Optionally update account manually (for testing)
router.post('/account/refresh', async (req, res) => {
  try {
    const broker = getBroker('deriv_cfd');
    const accountData = await broker.getAccount();
    await Account.upsertAccount({
      accountId: 'default',
      balance: parseFloat(accountData.balance) || 0,
      equity: parseFloat(accountData.equity) || 0,
      marginUsed: parseFloat(accountData.marginUsed) || 0,
      marginAvailable: parseFloat(accountData.marginAvailable) || 0,
      currency: accountData.currency || 'USD',
      broker: 'deriv',
      loginId: accountData.id || '',
      leverage: 100, // adjust if available
      status: 'online',
    });
    const updated = await Account.getLatest('default');
    res.json(updated);
  } catch (err) {
    logger.error('[Deriv] Error refreshing account:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Positions ----------
router.get('/positions', async (req, res) => {
  try {
    const positions = await orderService.getPositions('deriv_cfd');
    res.json({ positions });
  } catch (err) {
    logger.error('[Deriv] Error fetching positions:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Place Order (market) ----------
router.post('/order', async (req, res) => {
  try {
    const { instrument, side, lotSize, stopLoss, takeProfit, product, decisionId, autoTrade } = req.body;
    if (!instrument || !side || !lotSize) {
      return res.status(400).json({ error: 'Missing required fields: instrument, side, lotSize' });
    }
    const result = await orderService.placeMarketOrder(
      instrument,
      side,
      lotSize,
      stopLoss,
      takeProfit,
      product || 'deriv_cfd',
      decisionId || null,
      autoTrade || false
    );
    res.status(201).json({ success: true, result });
  } catch (err) {
    logger.error('[Deriv] Order placement error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Close Trade ----------
router.post('/close', async (req, res) => {
  try {
    const { contractId, product } = req.body;
    if (!contractId) {
      return res.status(400).json({ error: 'Missing contractId' });
    }
    const result = await orderService.closeTrade(contractId, product || 'deriv_cfd');
    res.json({ success: true, result });
  } catch (err) {
    logger.error('[Deriv] Close trade error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Modify SL/TP ----------
router.post('/modify', async (req, res) => {
  try {
    const { contractId, stopLoss, takeProfit, product } = req.body;
    if (!contractId) {
      return res.status(400).json({ error: 'Missing contractId' });
    }
    if (!stopLoss && !takeProfit) {
      return res.status(400).json({ error: 'At least one of stopLoss or takeProfit is required' });
    }
    const result = await orderService.modifyTrade(contractId, stopLoss, takeProfit, product || 'deriv_cfd');
    res.json({ success: true, result });
  } catch (err) {
    logger.error('[Deriv] Modify trade error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
