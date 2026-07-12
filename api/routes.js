// src/api/routes.js – All API Routes

const express = require('express');
const router = express.Router();
const controllers = require('./controllers');

// ---------- Account ----------
router.get('/account', controllers.getAccount);

// ---------- Market Data ----------
router.get('/prices', controllers.getPrices);
router.get('/candles', controllers.getCandles);

// ---------- Positions & Trades ----------
router.get('/positions', controllers.getPositions);
router.get('/trades', controllers.getTrades);
router.get('/trade-history', controllers.getTradeHistory);

// ---------- Manual Order ----------
router.post('/order', controllers.placeOrder);
router.put('/close/:tradeId', controllers.closeTrade);

// ---------- Strategy & Signal ----------
router.get('/signal', controllers.getSignal);

// ---------- Auto Trade ----------
router.post('/auto-trade', controllers.autoTrade);

// ---------- Admin / Utility (optional) ----------
router.get('/health', (req, res) => res.json({ status: 'OK' }));

module.exports = router;
