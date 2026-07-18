const express = require('express');
const router = express.Router();
const logger = require('../../infrastructure/logger') || console;

// Import Mongoose models
const Mt5Command = require('../../models/Mt5Command');
const Mt5CommandResult = require('../../models/Mt5CommandResult');
const Mt5Account = require('../../models/Mt5Account');
const Mt5Position = require('../../models/Mt5Position');
const Mt5Price = require('../../models/Mt5Price');
const Mt5Heartbeat = require('../../models/Mt5Heartbeat');
const Trade = require('../../models/Trade'); // for history

// ---------- Authentication ----------
const API_KEY = process.env.MT5_API_KEY || 'change-me-in-production';

const authenticate = (req, res, next) => {
  const key = req.headers['x-api-key'];
  if (key && key === API_KEY) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
};

// Apply authentication to all routes
router.use(authenticate);

// ---------- Utility ----------
function generateCommandId() {
  return `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ---------- Command Endpoints ----------

// POST /api/mt5/orders/command
router.post('/orders/command', async (req, res) => {
  try {
    const command = req.body;
    if (!command.commandId) {
      command.commandId = generateCommandId();
    }
    command.state = 'QUEUED';
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

// POST /api/mt5/orders/claim – atomic claim
router.post('/orders/claim', async (req, res) => {
  try {
    const { commandId } = req.body;
    if (!commandId) {
      return res.status(400).json({ error: 'Missing commandId' });
    }
    const command = await Mt5Command.findOneAndUpdate(
      { commandId, state: 'QUEUED' },
      {
        $set: {
          state: 'PROCESSING',
          processingStartedAt: new Date(),
          lastAttemptAt: new Date(),
        },
        $inc: { attempts: 1 },
      },
      { new: true }
    );
    if (command) {
      res.json(command);
    } else {
      res.status(404).json({ error: 'Command not available for claiming' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mt5/orders/pending – only returns QUEUED commands
router.get('/orders/pending', async (req, res) => {
  try {
    const commands = await Mt5Command.find({ state: 'QUEUED' }).lean();
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
    const success = result.success === true;
    await Mt5Command.findOneAndUpdate(
      { commandId },
      {
        $set: {
          state: success ? 'COMPLETED' : 'FAILED',
          error: success ? null : (result.error || 'Execution failed'),
        },
      }
    );
    logger.info(`[MT5] Result stored for ${commandId}, success=${success}`);
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

// ---------- Account ----------
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

// ---------- Positions ----------
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

router.get('/positions', async (req, res) => {
  try {
    const positions = await Mt5Position.find().lean();
    res.json({ positions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Heartbeat ----------
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

router.get('/heartbeat', async (req, res) => {
  try {
    const heartbeat = await Mt5Heartbeat.findOne().sort({ updatedAt: -1 }).lean();
    res.json(heartbeat || { online: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Price Feed ----------
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

// ---- UPDATED: handle underscores in symbol names ----
router.get('/price/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    // Remove underscores to match MT5 symbol format (e.g., EUR_USD -> EURUSD)
    const lookupSymbol = symbol.replace(/_/g, '');
    let price = await Mt5Price.findOne({ symbol: lookupSymbol }).lean();
    // If not found, try the original symbol (just in case)
    if (!price) {
      price = await Mt5Price.findOne({ symbol }).lean();
    }
    if (price) {
      res.json(price);
    } else {
      // Return a fallback structure to avoid dashboard errors
      res.status(404).json({
        symbol: lookupSymbol,
        bid: 0,
        ask: 0,
        spread: 0,
        error: 'Price not yet available from EA'
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Trade by ticket ----------
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

// ---------- History (using Trade model) ----------
router.get('/history', async (req, res) => {
  try {
    const { from, to, symbol } = req.query;
    const filter = { status: 'CLOSED' };
    if (symbol) filter.instrument = symbol;
    if (from) filter.closeTime = { $gte: new Date(Number(from)) };
    if (to) filter.closeTime = { ...filter.closeTime, $lte: new Date(Number(to)) };
    const trades = await Trade.find(filter).sort({ closeTime: -1 }).lean();
    res.json({ history: trades });
  } catch (err) {
    logger.warn('[MT5] History error:', err.message);
    res.json({ history: [] });
  }
});

// ---------- Sync (EA startup) ----------
router.post('/sync', async (req, res) => {
  const { login, status } = req.body;
  logger.info(`[MT5] Sync received: login=${login}, status=${status}`);
  res.status(201).json({ status: 'synced' });
});

module.exports = router;
