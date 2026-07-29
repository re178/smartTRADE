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
const Trade = require('../../models/Trade');

// ---- COGNITIVE: import priceBuffer ----
const priceBuffer = require('../../core/data/priceBuffer');

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

router.get('/orders/pending', async (req, res) => {
  try {
    const commands = await Mt5Command.find({ state: 'QUEUED' }).lean();
    res.json(commands);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    logger.info(`[MT5] POST account/status received: login=${status.login}, balance=${status.balance}`);

    const saved = await Mt5Account.findOneAndUpdate(
      { login: status.login },
      {
        ...status,
        updatedAt: new Date(),
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
      }
    );

    if (saved) {
      logger.info('[MT5] Saved account:', JSON.stringify(saved, null, 2));
      res.status(201).json({ status: 'accepted', account: saved });
    } else {
      logger.error('[MT5] Account save returned null');
      res.status(500).json({ error: 'Failed to save account' });
    }
  } catch (err) {
    logger.error('[MT5] Error saving account status:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/account/status', async (req, res) => {
  try {
    let account = await Mt5Account.findOne().sort({ updatedAt: -1 }).lean();
    if (!account) {
      account = {
        login: 0,
        balance: 0,
        equity: 0,
        margin: 0,
        free_margin: 0,
        profit: 0,
        currency: 'USD',
        server: 'Unknown',
        leverage: 0,
        marginLevel: 0,
        tradeMode: 0,
        company: '',
        accountName: '',
        status: 'offline',
        timestamp: Date.now(),
      };
    }
    logger.info('[MT5] GET account/status:', JSON.stringify(account, null, 2));
    res.json(account);
  } catch (err) {
    logger.error('[MT5] GET account/status error:', err.message);
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

// ---------- Price Feed (with cognitive integration) ----------
router.post('/price', async (req, res) => {
  try {
    const priceData = req.body;
    if (!priceData.symbol) {
      return res.status(400).json({ error: 'Missing symbol' });
    }

    // ---- Forward tick to cognitive engine ----
    // Convert time to milliseconds if in seconds
    const timeMs = priceData.time ? Number(priceData.time) * 1000 : Date.now();
    priceBuffer.update(priceData.symbol, priceData.bid, priceData.ask, timeMs);

    // Save to database (existing logic)
    await Mt5Price.findOneAndUpdate(
      { symbol: priceData.symbol },
      priceData,
      { upsert: true, new: true }
    );

    logger.debug(`[MT5] Price updated for ${priceData.symbol} (time: ${timeMs})`);
    res.status(201).json({ status: 'accepted' });
  } catch (err) {
    logger.error('[MT5] Price error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Handle underscores in symbol names ----
router.get('/price/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const lookupSymbol = symbol.replace(/_/g, '');
    let price = await Mt5Price.findOne({ symbol: lookupSymbol }).lean();
    if (!price) {
      price = await Mt5Price.findOne({ symbol }).lean();
    }
    if (price) {
      res.json(price);
    } else {
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

// ---------- NEW: Historical candle ingestion (for EA bootstrap) ----------
router.post('/historical', async (req, res) => {
  try {
    const { symbol, timeframe, candles } = req.body;
    if (!symbol || !timeframe || !candles || !Array.isArray(candles)) {
      return res.status(400).json({ error: 'Missing required fields (symbol, timeframe, candles array)' });
    }

    const candleHistory = require('../../core/data/candleHistory');
    let stored = 0;
    for (const c of candles) {
      // Convert time to milliseconds if in seconds
      const timeMs = (c.time && c.time < 1e12) ? c.time * 1000 : c.time;
      await candleHistory.store({
        symbol,
        timeframe,
        time: timeMs,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.tick_volume || 0,
        source: 'broker',
      });
      stored++;
    }
    logger.info(`[MT5] Stored ${stored} historical candles for ${symbol}:${timeframe}`);
    res.status(201).json({ status: 'accepted', stored });
  } catch (err) {
    logger.error('[MT5] Historical ingest error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
