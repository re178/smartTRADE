// routes/mt5.js
// Backend API for MT5 Bridge – Express Router

const express = require('express');
const router = express.Router();
const logger = require('../infrastructure/logger') || console;

// ---------- In‑Memory Storage ----------
// For production, replace with Redis or a database.
const pendingCommands = new Map();      // commandId -> command object
const commandResults = new Map();       // commandId -> result object
const priceFeed = new Map();            // symbol -> latest price data
let heartbeatStatus = {
  lastHeartbeat: null,
  online: false,
  login: null,
};

// ---------- Utility ----------
function generateCommandId() {
  return `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ---------- Endpoints ----------

/**
 * POST /api/mt5/orders/command
 * Receive a new command from the Node adapter, store it for the EA to pick up.
 * Expected payload: { commandId, action, instrument, side, units, stopLoss, takeProfit, ... }
 * If commandId is not provided, generate one.
 */
router.post('/orders/command', (req, res) => {
  const command = req.body;
  if (!command.commandId) {
    command.commandId = generateCommandId();
  }
  // Store the command for the EA to poll
  pendingCommands.set(command.commandId, command);
  logger.info(`[MT5] Command stored: ${command.commandId} (action: ${command.action})`);
  res.status(201).json({ commandId: command.commandId, status: 'queued' });
});

/**
 * GET /api/mt5/orders/pending
 * EA polls this to retrieve all pending commands.
 * Returns an array of command objects.
 */
router.get('/orders/pending', (req, res) => {
  const commands = Array.from(pendingCommands.values());
  res.json(commands);
});

/**
 * POST /api/mt5/orders/result
 * EA posts the result of a command execution.
 * Payload: { commandId, success, ticket, deal, price, volume, symbol, side, retcode, ... }
 */
router.post('/orders/result', (req, res) => {
  const result = req.body;
  const { commandId } = result;
  if (!commandId) {
    return res.status(400).json({ error: 'Missing commandId' });
  }
  // Store the result for retrieval by the Node adapter
  commandResults.set(commandId, result);
  // Remove the command from pending (if still there)
  pendingCommands.delete(commandId);
  logger.info(`[MT5] Result received for ${commandId}: success=${result.success}`);
  res.status(201).json({ status: 'accepted' });
});

/**
 * GET /api/mt5/orders/result/:commandId
 * Node adapter polls this to get the result for a specific command.
 * Returns the result object if available, else 404.
 */
router.get('/orders/result/:commandId', (req, res) => {
  const { commandId } = req.params;
  const result = commandResults.get(commandId);
  if (result) {
    // Optionally delete after retrieval to free memory (or keep for history)
    // commandResults.delete(commandId); // uncomment if you want one-time retrieval
    res.json(result);
  } else {
    res.status(404).json({ error: 'Result not found' });
  }
});

/**
 * POST /api/mt5/account/status
 * EA sends account status periodically.
 * Payload: { login, balance, equity, margin, free_margin, profit, server, currency, leverage, ... }
 */
router.post('/account/status', (req, res) => {
  const status = req.body;
  // Store the latest status (you might want to keep it in memory or DB)
  // For simplicity, we just log and keep in a global variable
  global.mt5AccountStatus = status;
  logger.debug(`[MT5] Account status updated for login ${status.login}`);
  res.status(201).json({ status: 'accepted' });
});

/**
 * GET /api/mt5/account/status
 * Node adapter retrieves the latest account status.
 */
router.get('/account/status', (req, res) => {
  if (global.mt5AccountStatus) {
    res.json(global.mt5AccountStatus);
  } else {
    res.status(404).json({ error: 'No account status yet' });
  }
});

/**
 * POST /api/mt5/positions
 * EA sends current open positions.
 * Payload: { login, positions: [ { ticket, symbol, type, volume, price, ... } ], timestamp }
 */
router.post('/positions', (req, res) => {
  const data = req.body;
  // Store the positions (you might want to replace the entire set)
  global.mt5Positions = data.positions || [];
  logger.debug(`[MT5] Positions updated: ${global.mt5Positions.length} open`);
  res.status(201).json({ status: 'accepted' });
});

/**
 * GET /api/mt5/positions
 * Node adapter retrieves current positions.
 */
router.get('/positions', (req, res) => {
  if (global.mt5Positions) {
    res.json({ positions: global.mt5Positions });
  } else {
    res.json({ positions: [] });
  }
});

/**
 * POST /api/mt5/heartbeat
 * EA sends heartbeat to indicate it's online.
 * Payload: { login, status, timestamp }
 */
router.post('/heartbeat', (req, res) => {
  const { login, status, timestamp } = req.body;
  heartbeatStatus.lastHeartbeat = timestamp || Date.now();
  heartbeatStatus.online = (status === 'online' || status === 'started');
  heartbeatStatus.login = login || null;
  logger.debug(`[MT5] Heartbeat received: login=${login}, status=${status}`);
  res.status(201).json({ status: 'accepted' });
});

/**
 * GET /api/mt5/heartbeat (optional) – for health checks
 */
router.get('/heartbeat', (req, res) => {
  res.json(heartbeatStatus);
});

/**
 * POST /api/mt5/price
 * EA sends price feed for a symbol.
 * Payload: { symbol, bid, ask, spread, digits, point, tick_size, tick_value, time }
 */
router.post('/price', (req, res) => {
  const priceData = req.body;
  if (!priceData.symbol) {
    return res.status(400).json({ error: 'Missing symbol' });
  }
  priceFeed.set(priceData.symbol, priceData);
  logger.debug(`[MT5] Price updated for ${priceData.symbol}: bid=${priceData.bid}, ask=${priceData.ask}`);
  res.status(201).json({ status: 'accepted' });
});

/**
 * GET /api/mt5/price/:symbol
 * Node adapter retrieves latest price for a symbol.
 */
router.get('/price/:symbol', (req, res) => {
  const { symbol } = req.params;
  const data = priceFeed.get(symbol);
  if (data) {
    res.json(data);
  } else {
    res.status(404).json({ error: 'Price not found' });
  }
});

/**
 * GET /api/mt5/trade/:ticket
 * Retrieve trade details (optional – you could implement if you have trade history)
 * For now, we can return a not‑found or use positions to look up.
 */
router.get('/trade/:ticket', (req, res) => {
  const { ticket } = req.params;
  // If you have a trade history store, use it; otherwise search positions
  if (global.mt5Positions) {
    const found = global.mt5Positions.find(p => String(p.ticket) === ticket);
    if (found) {
      return res.json(found);
    }
  }
  res.status(404).json({ error: 'Trade not found' });
});

/**
 * GET /api/mt5/history
 * Retrieve trade history (you would need a DB; here we return empty array)
 * Query params: from, to, symbol (optional)
 */
router.get('/history', (req, res) => {
  // In a real implementation, query a database of closed trades.
  // For now, return empty.
  res.json({ history: [] });
});

/**
 * POST /api/mt5/sync
 * EA sends sync on startup.
 * Payload: { login, status, timestamp }
 */
router.post('/sync', (req, res) => {
  const { login, status } = req.body;
  logger.info(`[MT5] Sync received: login=${login}, status=${status}`);
  // You can reset state or perform initialization.
  res.status(201).json({ status: 'synced' });
});

// ---------- Cleanup (optional) ----------
// Periodically clean old results and pending commands (TTL)
// ... implement if needed.

module.exports = router;
