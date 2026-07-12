const express = require('express');
const router = express.Router();
const tradeController = require('../controllers/tradeController');

// Account
router.get('/account', tradeController.getAccount);

// Market data
router.get('/prices', tradeController.getPrices);

// Positions & Trades
router.get('/positions', tradeController.getPositions);
router.get('/trades', tradeController.getTrades);
router.get('/trade-history', tradeController.getTradeHistory);

// Manual order
router.post('/order', tradeController.placeOrder);
router.put('/close/:tradeId', tradeController.closeTrade);

// Strategy signal
router.get('/signal', tradeController.getSignal);

// Auto trade
router.post('/auto-trade', tradeController.autoTrade);

module.exports = router;
