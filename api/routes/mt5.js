const express = require('express');
const router = express.Router();
const logger = require('../infrastructure/logger') || console;

// Import Mongoose models
const Mt5Command = require('../models/Mt5Command');
const Mt5CommandResult = require('../models/Mt5CommandResult');
const Mt5Account = require('../models/Mt5Account');
const Mt5Position = require('../models/Mt5Position');
const Mt5Price = require('../models/Mt5Price');
const Mt5Heartbeat = require('../models/Mt5Heartbeat');

// ---------- Utility ----------
function generateCommandId() {
  return `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ---------- Endpoints ----------

// POST /api/mt5/orders/command
router.post('/orders/command', async (req, res) => {
  try {
    const command = req.body;
    if (!command.commandId) {
      command.commandId = generateCommandId();
    }
    await Mt5Command.findOneAndUpdate(
      { commandId: command.commandId },
      command,
      { upsert: true, new: true }
    );
    logger.info(`[MT5] Command stored: ${command.commandId}`);
    res.status(201).json({ commandId: command.commandId, status: 'queued' });
  } catch (err) {
    logger.error('[MT5] Error storing command:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mt5/orders/pending
router.get('/orders/pending', async (req, res) => {
  try {
    const commands = await Mt5Command.find().lean();
    res.json(commands);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mt5/orders/result
router.post('/orders/result', async (req, res) => {
  try {
    const result = req.body;
    const { commandId } = result;
    if (!commandId) {
      return res.status(400).json({ error: 'Missing commandId' });
    }
    await Mt5CommandResult.findOneAndUpdate(
      { commandId },
      result,
      { upsert: true, new: true }
    );
    await Mt5Command.deleteOne({ commandId });
    logger.info(`[MT5] Result stored for ${commandId}`);
    res.status(201).json({ status: 'accepted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mt5/orders/result/:commandId
router.get('/orders/result/:commandId', async (req, res) => {
  try {
    const { commandId } = req.params;
    const result = await Mt5CommandResult.findOne({ commandId }).lean();
    if (result) {
      res.json(result);
    } else {
      res.status(404).json({ error: 'Result not found' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mt5/account/status
router.post('/account/status', async (req, res) => {
  try {
    const status = req.body;
    await Mt5Account.findOneAndUpdate(
      { login: status.login },
      status,
      { upsert: true, new: true }
    );
    logger.debug(`[MT5] Account status updated for ${status.login}`);
    res.status(201).json({ status: 'accepted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mt5/account/status
router.get('/account/status', async (req, res) => {
  try {
    const account = await Mt5Account.findOne().sort({ updatedAt: -1 }).lean();
    if (account) {
      res.json(account);
    } else {
      res.status(404).json({ error: 'No account status yet' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mt5/positions
router.post('/positions', async (req, res) => {
  try {
    const { login, positions, timestamp } = req.body;
    await Mt5Position.deleteMany({ login });
    if (positions && positions.length) {
      const docs = positions.map(p => ({ ...p, login, updatedAt: new Date() }));
      await Mt5Position.insertMany(docs);
    }
    logger.debug(`[MT5] Positions updated for login ${login}: ${positions?.length || 0} open`);
    res.status(201).json({ status: 'accepted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mt5/positions
router.get('/positions', async (req, res) => {
  try {
    const positions = await Mt5Position.find().lean();
    res.json({ positions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mt5/heartbeat
router.post('/heartbeat', async (req, res) => {
  try {
    const { login, status, timestamp } = req.body;
    await Mt5Heartbeat.findOneAndUpdate(
      { login },
      { login, status, lastHeartbeat: timestamp || Date.now() },
      { upsert: true, new: true }
    );
    logger.debug(`[MT5] Heartbeat received: login=${login}, status=${status}`);
    res.status(201).json({ status: 'accepted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mt5/heartbeat
router.get('/heartbeat', async (req, res) => {
  try {
    const heartbeat = await Mt5Heartbeat.findOne().sort({ updatedAt: -1 }).lean();
    res.json(heartbeat || { online: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mt5/price
router.post('/price', async (req, res) => {
  try {
    const priceData = req.body;
    if (!priceData.symbol) {
      return res.status(400).json({ error: 'Missing symbol' });
    }
    await Mt5Price.findOneAndUpdate(
      { symbol: priceData.symbol },
      priceData,
      { upsert: true, new: true }
    );
    logger.debug(`[MT5] Price updated for ${priceData.symbol}`);
    res.status(201).json({ status: 'accepted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mt5/price/:symbol
router.get('/price/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const price = await Mt5Price.findOne({ symbol }).lean();
    if (price) {
      res.json(price);
    } else {
      res.status(404).json({ error: 'Price not found' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mt5/trade/:ticket
router.get('/trade/:ticket', async (req, res) => {
  try {
    const { ticket } = req.params;
    const position = await Mt5Position.findOne({ ticket: Number(ticket) }).lean();
    if (position) {
      return res.json(position);
    }
    res.status(404).json({ error: 'Trade not found' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mt5/history (stub – expand with your Trade model)
router.get('/history', async (req, res) => {
  res.json({ history: [] });
});

// POST /api/mt5/sync
router.post('/sync', async (req, res) => {
  const { login, status } = req.body;
  logger.info(`[MT5] Sync received: login=${login}, status=${status}`);
  res.status(201).json({ status: 'synced' });
});

module.exports = router;
