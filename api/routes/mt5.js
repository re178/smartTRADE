const express = require('express');
const router = express.Router();
const mt5Controller = require('../controllers/mt5Controller');

// All MT5 endpoints (prefix /api/mt5)
router.post('/orders/command', mt5Controller.createCommand);
router.get('/orders/pending', mt5Controller.getPending);
router.post('/orders/result', mt5Controller.handleResult);
router.get('/orders/result/:commandId', mt5Controller.getResult);
router.post('/account/status', mt5Controller.updateAccount);
router.get('/account/status', mt5Controller.getAccount);
router.post('/positions', mt5Controller.updatePositions);
router.get('/positions', mt5Controller.getPositions);
router.post('/heartbeat', mt5Controller.handleHeartbeat);
router.post('/sync', mt5Controller.sync);

module.exports = router;
