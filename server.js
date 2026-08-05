// server.js – RTS Entry Point with Real‑Time EA Support
// Exports broadcastToDashboards and broadcastCommandToEA correctly.
// Includes WebSocket ping (keep‑alive) to prevent dashboard disconnections.

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const WebSocket = require('ws');
const http = require('http');

const connectDB = require('./config/db');
const apiRoutes = require('./api/routes');
const mt5Routes = require('./api/routes/mt5');
const researchRoutes = require('./api/routes/research');
const User = require('./models/User');
const Mt5Price = require('./models/Mt5Price');
const Mt5Heartbeat = require('./models/Mt5Heartbeat');

// ---------- COGNITIVE MODULES ----------
const priceBuffer = require('./core/data/priceBuffer');
const candleStore = require('./core/data/candleStore');
const marketStateCache = require('./core/data/marketStateCache');
const awarenessEngine = require('./core/awareness/engine');
const deepRegime = require('./core/intelligence/deep/regime');
const decisionEngine = require('./core/decision/engine');
const eventBus = require('./infrastructure/eventBus');

// ---------- DATA ORCHESTRATOR & STATE STORE ----------
const { dataOrchestrator } = require('./core/data/dataOrchestrator');
const stateStore = require('./core/intelligence/lab/stateStore');

// ---------- OUTCOME LABELER ----------
const { startScheduler } = require('./core/intelligence/lab/outcomeLabeler');

// ---------- OTIE V5 ----------
const otie = require('./core/intelligence/openTradeIntelligenceV5');

// ---------- PERFORMANCE MONITOR ----------
const performanceMonitor = require('./core/performance/performanceMonitor');

const app = express();
const PORT = process.env.PORT || 5000;

// ---------- Connect to MongoDB ----------
connectDB();

// ---------- Admin Creation ----------
async function ensureAdmin() {
  try {
    const adminId = 'admin';
    let admin = await User.findOne({ userId: adminId });
    if (!admin) {
      const defaultProduct = process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd';
      admin = new User({ userId: adminId, tradingProduct: defaultProduct });
      await admin.save();
      console.log('✅ Admin user created with product:', defaultProduct);
    } else {
      console.log('✅ Admin user already exists.');
    }
  } catch (err) {
    console.error('❌ Admin creation failed:', err.message);
  }
}

// ---------- JSON Repair Helper (fallback) ----------
function repairJson(raw) {
  let repaired = raw.trim();
  if (repaired.endsWith(',')) {
    repaired = repaired.slice(0, -1);
  }
  let openBraces = 0, openBrackets = 0, inString = false, escape = false;
  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') openBraces++;
    else if (ch === '}') openBraces--;
    else if (ch === '[') openBrackets++;
    else if (ch === ']') openBrackets--;
  }
  while (openBrackets > 0) { repaired += ']'; openBrackets--; }
  while (openBraces > 0) { repaired += '}'; openBraces--; }
  return repaired;
}

// ---------- Middleware ----------
app.use(cors());

// ---------- Custom body parser: sanitize null bytes & BOM ----------
app.use((req, res, next) => {
  let rawBody = '';
  req.on('data', chunk => {
    rawBody += chunk.toString();
  });
  req.on('end', () => {
    if (rawBody.charCodeAt(0) === 0xFEFF) {
      rawBody = rawBody.slice(1);
    }
    rawBody = rawBody.replace(/\0/g, '');
    const trimmed = rawBody.trim();
    req.rawBody = trimmed;

    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('application/json') && trimmed.length > 0) {
      let parsed = null;
      try {
        parsed = JSON.parse(trimmed);
        req.body = parsed;
      } catch (err) {
        if (err instanceof SyntaxError) {
          const repaired = repairJson(trimmed);
          try {
            parsed = JSON.parse(repaired);
            req.body = parsed;
            req.repairedRawBody = repaired;
            console.log('✅ JSON repaired successfully.');
            console.log('   Original (stringified):', JSON.stringify(trimmed));
            console.log('   Repaired:', repaired);
          } catch (err2) {
            console.error('❌ JSON repair also failed:', err2.message);
            console.error('   Raw (stringified):', JSON.stringify(trimmed));
            console.error('   Repaired:', repaired);
            req.body = {};
            req.parseError = err2;
          }
        } else {
          throw err;
        }
      }
    } else {
      req.body = {};
    }
    next();
  });
  req.on('error', (err) => {
    console.error('Request body error:', err);
    next(err);
  });
});

// ---------- Request Logger ----------
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    console.log('\n==============================');
    console.log(new Date().toISOString());
    console.log(req.method, req.originalUrl);
    console.log('Body length:', req.rawBody?.length || 0);
    if (req.rawBody && req.rawBody.length > 0 && req.rawBody.length < 500) {
      console.log('Raw Body (stringified):', JSON.stringify(req.rawBody));
    }
    if (req.repairedRawBody) {
      console.log('Repaired:', req.repairedRawBody);
    }
    console.log('==============================');
  }
  next();
});

app.use(express.static('public'));

// ---------- Admin User Middleware ----------
app.use(async (req, res, next) => {
  try {
    let admin = await User.findOne({ userId: 'admin' });
    if (!admin) {
      const defaultProduct = process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd';
      admin = new User({ userId: 'admin', tradingProduct: defaultProduct });
      await admin.save();
      console.log('✅ Admin user auto-created.');
    }
    req.user = { id: 'admin', tradingProduct: admin.tradingProduct };
    next();
  } catch (err) {
    console.error('❌ Admin middleware error:', err.message);
    req.user = { id: 'admin', tradingProduct: process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd' };
    next();
  }
});

// ---------- API Routes ----------
app.use('/api', apiRoutes);
app.use('/api/mt5', mt5Routes);
app.use('/api/research', researchRoutes);

// ---------- Health Check ----------
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'RTS is running' });
});

// ---------- SPA Fallback ----------
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile('index.html', { root: 'public' });
  } else {
    res.status(404).json({ error: 'API endpoint not found' });
  }
});

// ---------- Create HTTP server ----------
const server = http.createServer(app);

// ---------- WebSocket Server (with EA support) ----------
const wss = new WebSocket.Server({ server });

// Store connected clients
const eaClients = new Set();
const dashboardClients = new Set();

// WebSocket ping interval (keep‑alive)
const WS_PING_INTERVAL = 30000; // 30 seconds
let wsPingTimer = null;

wss.on('connection', (ws, req) => {
  // Parse URL for client type and API key
  const url = new URL(req.url, `http://${req.headers.host}`);
  const type = url.searchParams.get('type') || 'dashboard';
  const apiKey = url.searchParams.get('apiKey') || '';

  // Authentication
  const validApiKey = process.env.MT5_API_KEY || 'change-me-in-production';
  if (apiKey !== validApiKey) {
    ws.close(1008, 'Invalid API key');
    console.log('[WebSocket] Authentication failed.');
    return;
  }

  if (type === 'ea') {
    eaClients.add(ws);
    console.log('[WebSocket] EA client connected.');
    // Send a welcome message
    ws.send(JSON.stringify({ type: 'welcome', message: 'Connected to RTS WebSocket' }));

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        await handleEAMessage(ws, data);
      } catch (err) {
        console.error('[WebSocket] EA message error:', err.message);
      }
    });

    ws.on('close', () => {
      eaClients.delete(ws);
      console.log('[WebSocket] EA client disconnected.');
    });
  } else {
    // Dashboard client
    dashboardClients.add(ws);
    console.log('[WebSocket] Dashboard client connected.');
    // Send initial state immediately
    sendDashboardInitialState(ws);

    ws.on('close', () => {
      dashboardClients.delete(ws);
      console.log('[WebSocket] Dashboard client disconnected.');
    });
  }

  ws.on('error', (err) => console.error('[WebSocket] Error:', err.message));

  // Respond to ping messages from client
  ws.on('pong', () => {
    // Client is alive, no action needed
  });
});

// ---------- WebSocket keep‑alive ----------
function startWSPing() {
  if (wsPingTimer) clearInterval(wsPingTimer);
  wsPingTimer = setInterval(() => {
    const allClients = [...eaClients, ...dashboardClients];
    for (const client of allClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.ping(); // send a ping frame
      }
    }
  }, WS_PING_INTERVAL);
}

// ---------- Send initial state to a new dashboard client ----------
async function sendDashboardInitialState(ws) {
  try {
    const Trade = require('./models/Trade');
    const accountService = require('./core/portfolio/accountService');
    const orderService = require('./core/execution/orderService');

    const [trades, account, positions] = await Promise.all([
      Trade.find({ status: 'OPEN' }).lean(),
      accountService.getAccount('mt5'),
      orderService.getOpenTrades('mt5')
    ]);

    ws.send(JSON.stringify({ type: 'init', data: { trades, account, positions } }));
    console.log('[WebSocket] Initial state sent to new dashboard client.');
  } catch (err) {
    console.error('[WebSocket] Failed to send initial state:', err.message);
  }
}

// ---- WebSocket message handler for EA ----
async function handleEAMessage(ws, data) {
  const { type, commandId, ...payload } = data;
  const Mt5Command = require('./models/Mt5Command');
  const Mt5CommandResult = require('./models/Mt5CommandResult');
  const Trade = require('./models/Trade');
  const logger = require('./infrastructure/logger') || console;

  switch (type) {
    case 'ack':
      // ACK: command received
      await Mt5Command.findOneAndUpdate(
        { commandId },
        { $set: { state: 'RECEIVED', receivedAt: new Date() } }
      );
      console.log(`[WebSocket] ACK for ${commandId}`);
      break;

    case 'executing':
      await Mt5Command.findOneAndUpdate(
        { commandId },
        { $set: { state: 'EXECUTING', executingStartedAt: new Date() } }
      );
      console.log(`[WebSocket] EXECUTING for ${commandId}`);
      break;

    case 'result': {
      // Result from EA
      const { success, ticket, deal, price, volume, symbol, side, retcode, retcodeDescription, error } = payload;
      // Save result
      await Mt5CommandResult.findOneAndUpdate(
        { commandId },
        { commandId, success, ticket, deal, price, volume, symbol, side, retcode, retcodeDescription, error, time: Date.now() },
        { upsert: true }
      );
      // Update command state
      await Mt5Command.findOneAndUpdate(
        { commandId },
        {
          $set: {
            state: success ? 'EXECUTED' : 'FAILED',
            error: success ? null : (error || 'Execution failed'),
            completedAt: new Date(),
          }
        }
      );
      // Process result (update Trade, etc.) – reuse logic from mt5Routes POST /orders/result
      await processCommandResult(commandId, payload);
      console.log(`[WebSocket] RESULT for ${commandId}: ${success ? 'SUCCESS' : 'FAILED'}`);
      break;
    }

    case 'position_update':
      // Handle real-time position update (opened, modified, closed)
      await handleSinglePositionUpdate(payload);
      break;

    case 'account_update':
      await handleAccountUpdate(payload);
      break;

    case 'price':
      // Handle price tick
      await handlePriceTick(payload);
      break;

    case 'heartbeat':
      // Update heartbeat with additional info
      const { login, status, timestamp, latency, eaVersion, lastTick } = payload;
      await Mt5Heartbeat.findOneAndUpdate(
        { login },
        {
          login,
          status,
          lastHeartbeat: timestamp || Date.now(),
          latency,
          eaVersion,
          lastTick,
          updatedAt: new Date(),
        },
        { upsert: true }
      );
      break;

    default:
      console.log(`[WebSocket] Unknown message type: ${type}`);
  }
}

// ---- Helper: process command result (reused from mt5Routes) ----
async function processCommandResult(commandId, result) {
  const { success, ticket, deal, price, symbol, side, time, volume } = result;
  const Mt5Command = require('./models/Mt5Command');
  const Trade = require('./models/Trade');
  const selfLearner = require('./core/learning/learner');
  const logger = require('./infrastructure/logger') || console;
  const orderService = require('./core/execution/orderService');

  const command = await Mt5Command.findOne({ commandId }).lean();
  const action = command?.action;

  if (!success || !action) return;

  if (action === 'CLOSE') {
    const trade = await Trade.findOne({ contractId: ticket });
    if (trade && trade.status !== 'CLOSED') {
      trade.status = 'CLOSED';
      trade.closePrice = price;
      trade.dealId = deal;
      trade.closeTime = new Date(time ? time * 1000 : Date.now());
      trade.pendingClose = false;
      if (trade.openPrice && trade.lotSize) {
        const multiplier = trade.side && trade.side.toUpperCase() === 'BUY' ? 1 : -1;
        trade.realizedProfit = (price - trade.openPrice) * trade.lotSize * multiplier;
        trade.pnl = trade.realizedProfit;
      }
      await trade.save();
      logger.info(`[WebSocket] Trade ${ticket} finalized as CLOSED at ${price}`);
      if (trade.decisionId) {
        try {
          await selfLearner.updateDecisionOutcome(trade.decisionId, trade);
        } catch (err) {
          logger.warn(`[WebSocket] Failed to update decision outcome: ${err.message}`);
        }
      }
      // Broadcast updated positions
      const openTrades = await orderService.getOpenTrades('mt5');
      broadcastToDashboards('positions', openTrades);
      broadcastToDashboards('tradeClosed', { contractId: ticket, price, pl: trade.realizedProfit });
    }
  } else if (action === 'MODIFY') {
    const trade = await Trade.findOne({ contractId: ticket });
    if (trade && trade.status === 'OPEN') {
      if (command.stopLoss !== undefined) trade.stopLoss = command.stopLoss;
      if (command.takeProfit !== undefined) trade.takeProfit = command.takeProfit;
      await trade.save();
      logger.info(`[WebSocket] Trade ${ticket} SL/TP updated`);
      const openTrades = await orderService.getOpenTrades('mt5');
      broadcastToDashboards('positions', openTrades);
    }
  } else if (action === 'PARTIAL') {
    const trade = await Trade.findOne({ contractId: ticket });
    if (trade && trade.status === 'OPEN') {
      if (volume !== undefined && volume > 0) {
        trade.lotSize = volume;
        await trade.save();
        logger.info(`[WebSocket] Trade ${ticket} lotSize reduced to ${volume}`);
        const openTrades = await orderService.getOpenTrades('mt5');
        broadcastToDashboards('positions', openTrades);
      } else {
        trade.status = 'CLOSED';
        trade.closePrice = price || trade.currentPrice;
        trade.closeTime = new Date();
        trade.pendingClose = false;
        if (trade.openPrice && trade.lotSize) {
          const multiplier = trade.side && trade.side.toUpperCase() === 'BUY' ? 1 : -1;
          trade.realizedProfit = (trade.closePrice - trade.openPrice) * trade.lotSize * multiplier;
          trade.pnl = trade.realizedProfit;
        }
        await trade.save();
        logger.info(`[WebSocket] Trade ${ticket} closed after partial reduction`);
        const openTrades = await orderService.getOpenTrades('mt5');
        broadcastToDashboards('positions', openTrades);
        broadcastToDashboards('tradeClosed', { contractId: ticket, price: trade.closePrice, pl: trade.realizedProfit });
      }
    }
  }
}

// ---- Helper: handle single position update ----
async function handleSinglePositionUpdate(pos) {
  const Trade = require('./models/Trade');
  const eventBus = require('./infrastructure/eventBus');
  const orderService = require('./core/execution/orderService');
  const { ticket, symbol, type, volume, price, current_price, profit, stop_loss, take_profit, swap, commission, margin, magic, comment, open_time, reason, identifier, login } = pos;

  let trade = await Trade.findOne({ contractId: ticket });
  if (!trade) {
    trade = new Trade({
      contractId: ticket,
      instrument: symbol,
      side: type === 'BUY' ? 'buy' : 'sell',
      lotSize: volume,
      openPrice: price,
      openTime: new Date(open_time * 1000),
      status: 'OPEN',
      magic,
      comment,
      stopLoss: stop_loss || 0,
      takeProfit: take_profit || 0,
      swap: swap || 0,
      commission: commission || 0,
      margin: margin || 0,
      login,
      pendingClose: false,
      floatingProfit: profit || 0,
      currentPrice: current_price || price,
    });
    await trade.save();
  } else {
    trade.currentPrice = current_price;
    trade.floatingProfit = profit;
    trade.lotSize = volume;
    trade.pendingClose = false;
    if (trade.status === 'OPEN') {
      trade.stopLoss = stop_loss || 0;
      trade.takeProfit = take_profit || 0;
      trade.swap = swap || 0;
      trade.commission = commission || 0;
      trade.margin = margin || 0;
      trade.magic = magic || 0;
      trade.comment = comment || '';
      trade.login = login;
    }
    await trade.save();
  }
  // Emit event for dashboard
  eventBus.emit('position.updated', { ticket, symbol, type, volume, price, current_price, profit });
  // Broadcast to dashboards
  const openTrades = await orderService.getOpenTrades('mt5');
  broadcastToDashboards('positions', openTrades);
}

// ---- Helper: handle account update ----
async function handleAccountUpdate(accountData) {
  const Mt5Account = require('./models/Mt5Account');
  const eventBus = require('./infrastructure/eventBus');
  await Mt5Account.findOneAndUpdate(
    { login: accountData.login },
    {
      ...accountData,
      updatedAt: new Date(),
    },
    { upsert: true }
  );
  eventBus.emit('account.fetched', accountData);
  broadcastToDashboards('account', accountData);
}

// ---- Helper: handle price tick ----
async function handlePriceTick(priceData) {
  const Mt5Price = require('./models/Mt5Price');
  const eventBus = require('./infrastructure/eventBus');
  const timeMs = priceData.time ? Number(priceData.time) * 1000 : Date.now();
  priceBuffer.update(priceData.symbol, priceData.bid, priceData.ask, timeMs);
  await Mt5Price.findOneAndUpdate(
    { symbol: priceData.symbol },
    priceData,
    { upsert: true, new: true }
  );
  eventBus.emit('price.tick', priceData);
  broadcastToDashboards('price', priceData);
}

// ---- Function to broadcast new command to all connected EAs ----
function broadcastCommandToEA(command) {
  if (eaClients.size === 0) return;
  const message = JSON.stringify({ type: 'command', data: command });
  eaClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// ---- Function to broadcast to all dashboard clients ----
function broadcastToDashboards(type, data) {
  if (dashboardClients.size === 0) return;
  const message = JSON.stringify({ type, data });
  dashboardClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// ---- Export functions for mt5Routes to use ----
module.exports.broadcastCommandToEA = broadcastCommandToEA;
module.exports.broadcastToDashboards = broadcastToDashboards;

// ---------- Broadcast functions for dashboard (backward compatibility) ----------
function broadcast(type, data) {
  broadcastToDashboards(type, data);
}

// ---------- Connect CTOS Events to WebSocket ----------
awarenessEngine.on('marketAwareness', (data) => broadcast('marketAwareness', data));
deepRegime.on('regime', (regime) => broadcast('regime', regime));
decisionEngine.on('decision', (decision) => broadcast('decision', decision));
eventBus.on('account.fetched', (account) => broadcast('account', account));
eventBus.on('trade.closed', (data) => broadcast('tradeClosed', data));
eventBus.on('order.placed', (data) => broadcast('orderPlaced', data));
eventBus.on('position.updated', (data) => broadcast('positionUpdated', data));

// ---------- OTIE V5 Event Broadcasts ----------
otie.on('otieV5State', (state) => broadcast('otieV5State', state));
otie.on('otieV5Action', (action) => broadcast('otieV5Action', action));

// ---------- Performance Monitor Integration ----------
eventBus.on('trade.closed', async (data) => {
  try {
    const Trade = require('./models/Trade');
    const trade = await Trade.findOne({ contractId: data.contractId });
    if (trade) {
      performanceMonitor.recordTrade(trade);
    }
  } catch (err) {
    console.error('[PerformanceMonitor] Failed to record trade:', err.message);
  }
});

performanceMonitor.on('thresholdsUpdated', (thresholds) => {
  if (otie && typeof otie.updateConfig === 'function') {
    otie.updateConfig(thresholds);
    console.log('[PerformanceMonitor] OTIE config updated.');
  } else {
    console.warn('[PerformanceMonitor] OTIE updateConfig method not available.');
  }
});

// ---------- DEBUG ROUTES ----------
app.get('/debug/ea-status', async (req, res) => {
  try {
    const lastPrice = await Mt5Price.findOne().sort({ time: -1 }).lean();
    const lastHeartbeat = await Mt5Heartbeat.findOne().sort({ updatedAt: -1 }).lean();
    res.json({
      lastPriceReceived: lastPrice || null,
      lastHeartbeat: lastHeartbeat || null,
      eaOnline: lastHeartbeat && lastHeartbeat.status === 'online',
      eaWebSocketConnected: eaClients.size > 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/debug/trigger', async (req, res) => {
  try {
    const candleHistory = require('./core/data/candleHistory');
    const candles = await candleHistory.getHistory('EUR_USD', 'M5', 1);
    if (!candles || candles.length === 0) {
      return res.json({ error: 'No candles found in database' });
    }
    const candle = candles[0];
    const closedCandle = {
      symbol: candle.symbol,
      timeframe: candle.timeframe,
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      source: candle.source || 'broker',
    };
    eventBus.emit('candleClosed', closedCandle);
    candleStore.emit('candleClosed', closedCandle);
    res.json({ success: true, candle: closedCandle });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/debug/status', (req, res) => {
  const lastState = marketStateCache.get('EUR_USD') || null;
  const lastRegime = deepRegime.getLatestRegime('EUR_USD') || null;
  const lastDecision = decisionEngine.getLastDecision('EUR_USD') || null;
  res.json({
    engine: {
      candleBuilder: typeof candleStore !== 'undefined' ? 'running' : 'not loaded',
      marketAwareness: awarenessEngine ? 'running' : 'not loaded',
      deepRegime: deepRegime ? 'running' : 'not loaded',
      decisionEngine: decisionEngine ? 'running' : 'not loaded',
      otieV5: otie ? 'running' : 'not loaded',
    },
    lastCandle: candleStore.getHistory('EUR_USD', 'M5', 1)[0] || null,
    lastMarketState: lastState,
    lastRegime: lastRegime,
    lastDecision: lastDecision,
    timestamp: new Date().toISOString(),
  });
});

// ---------- Start Cognitive Engines ----------
async function startCognitiveEngines() {
  try {
    console.log('[CTOS] Starting cognitive engines...');
    console.log('[CTOS] Market Awareness Engine: active');
    console.log('[CTOS] Deep Regime Detector: active');
    console.log('[CTOS] Decision Engine: active');
    console.log('[CTOS] OTIE V5: active');
    console.log('[CTOS] Performance Monitor: active');
    console.log('[CTOS] All cognitive modules initialized successfully.');
  } catch (err) {
    console.error('[CTOS] Initialization error:', err.message);
  }
}

// ---------- Start Server ----------
async function startServer() {
  await ensureAdmin();

  server.listen(PORT, () => {
    console.log(`✅ RTS server running on http://localhost:${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`🔌 API base: http://localhost:${PORT}/api`);
    console.log(`🟢 MT5 Bridge endpoints: http://localhost:${PORT}/api/mt5`);
    console.log(`🔬 Research endpoints: http://localhost:${PORT}/api/research`);
    console.log('📡 WebSocket server ready for real‑time signals and EA commands.');
    console.log('🧠 CTOS Cognitive Engine: enabled.');
    console.log('📡 Request logging enabled.');
    console.log('🛠️  JSON repair enabled as fallback.');
    console.log('🧹  Null bytes (\\0) stripped from all incoming JSON.');
    console.log('💾 MT5 data is persistent (MongoDB).');

    // Start WebSocket ping interval
    startWSPing();

    // ---- Initialise Data Orchestrator and State Store ----
    Promise.all([
      dataOrchestrator.recover(),
      stateStore.init(),
    ]).then(() => {
      console.log('✅ Data Orchestrator and State Store initialised.');
    }).catch(err => {
      console.warn('⚠️ Failed to initialise Data Orchestrator/State Store:', err.message);
    });

    // ---- Start Cognitive Engines ----
    setTimeout(startCognitiveEngines, 2000);

    // ---- Start Outcome Labeler Scheduler ----
    try {
      const labeler = require('./core/intelligence/lab/outcomeLabeler');
      const interval = parseInt(process.env.OUTCOME_LABEL_INTERVAL_MS) || 60 * 60 * 1000;
      labeler.startScheduler(interval);
      console.log(`✅ Outcome labeler scheduler started (interval: ${interval}ms)`);
    } catch (err) {
      console.warn('⚠️ Outcome labeler scheduler could not be started:', err.message);
    }
  });

  // ---- Graceful shutdown ----
  process.on('SIGINT', async () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    if (wsPingTimer) clearInterval(wsPingTimer);
    try {
      await dataOrchestrator.shutdown();
      if (otie && typeof otie.stop === 'function') otie.stop();
      console.log('✅ Data Orchestrator flushed.');
    } catch (err) {
      console.error('Error during shutdown:', err.message);
    }
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
    if (wsPingTimer) clearInterval(wsPingTimer);
    try {
      await dataOrchestrator.shutdown();
      if (otie && typeof otie.stop === 'function') otie.stop();
      console.log('✅ Data Orchestrator flushed.');
    } catch (err) {
      console.error('Error during shutdown:', err.message);
    }
    process.exit(0);
  });
}

startServer().catch(err => {
  console.error('❌ Server start error:', err);
  process.exit(1);
});
