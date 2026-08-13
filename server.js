// server.js – RTS Entry Point (Deriv‑only)
// No MT5/EA logic. Deriv broker feeds priceBuffer, Price, Account models,
// and emits events for dashboard WebSocket broadcasts.

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const WebSocket = require('ws');
const http = require('http');

const connectDB = require('./config/db');
const apiRoutes = require('./api/routes');
const researchRoutes = require('./api/routes/research');
const User = require('./models/User');

// ---------- MODELS ----------
const Price = require('./models/Price');
const Account = require('./models/Account');

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

// ---------- BROKER (Deriv) ----------
const { getBroker } = require('./core/execution/brokerFactory');

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
      admin = new User({ userId: adminId, tradingProduct: 'deriv_cfd' });
      await admin.save();
      console.log('✅ Admin user created with product: deriv_cfd');
    } else {
      if (admin.tradingProduct === 'mt5') {
        admin.tradingProduct = 'deriv_cfd';
        await admin.save();
        console.log('✅ Admin product updated to deriv_cfd');
      }
      console.log('✅ Admin user already exists.');
    }
  } catch (err) {
    console.error('❌ Admin creation failed:', err.message);
  }
}

// ---------- JSON Repair Helper ----------
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

// ---------- Custom body parser ----------
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
          } catch (err2) {
            console.error('❌ JSON repair also failed:', err2.message);
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
app.use('/api/research', researchRoutes);

// ---------- Health Check ----------
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'RTS is running with Deriv broker' });
});

// ---------- SPA Fallback (no API key injection) ----------
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'API endpoint not found' });
  }
});

// ---------- Create HTTP server ----------
const server = http.createServer(app);

// ---------- WebSocket Server ----------
const wss = new WebSocket.Server({ server });

// Only dashboard clients
const dashboardClients = new Set();

const WS_PING_INTERVAL = 30000;
let wsPingTimer = null;

wss.on('connection', (ws, req) => {
  // No authentication – allow all connections
  console.log('[WebSocket] Dashboard client connected.');

  // ✅ FIX: Register this client for broadcasts
  dashboardClients.add(ws);

  // Send initial state
  sendDashboardInitialState(ws);

  ws.on('close', () => {
    dashboardClients.delete(ws);
    console.log('[WebSocket] Dashboard client disconnected.');
  });

  ws.on('error', (err) => console.error('[WebSocket] Error:', err.message));
  ws.on('pong', () => {});
});

// ---------- WebSocket keep‑alive ----------
function startWSPing() {
  if (wsPingTimer) clearInterval(wsPingTimer);
  wsPingTimer = setInterval(() => {
    for (const client of dashboardClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
      }
    }
  }, WS_PING_INTERVAL);
}

// ---------- Helper: Enhance account with tradeMode and server ----------
function enhanceAccount(accountData, broker) {
  if (!accountData) return accountData;
  let tradeMode = 0;
  let server = 'Unknown';
  if (broker && broker._account) {
    tradeMode = broker._account.is_virtual !== undefined ? (broker._account.is_virtual ? 1 : 0) : 0;
    server = broker._account.landing_company_name || 'Unknown';
  }
  return {
    ...accountData,
    tradeMode,
    server,
  };
}

// ---------- Send initial state to a new dashboard client ----------
async function sendDashboardInitialState(ws) {
  try {
    const Trade = require('./models/Trade');
    const accountService = require('./core/portfolio/accountService');
    const orderService = require('./core/execution/orderService');

    const [trades, account, positions] = await Promise.all([
      Trade.find({ status: 'OPEN' }).lean(),
      accountService.getAccount('deriv_cfd'),
      orderService.getOpenTrades('deriv_cfd')
    ]);

    let broker;
    try {
      broker = getBroker('deriv_cfd');
    } catch (e) {
      // ignore
    }
    const enhancedAccount = enhanceAccount(account, broker);

    ws.send(JSON.stringify({ type: 'init', data: { trades, account: enhancedAccount, positions } }));
    console.log('[WebSocket] Initial state sent to new dashboard client.');
  } catch (err) {
    console.error('[WebSocket] Failed to send initial state:', err.message);
  }
}

// ---- Broadcast functions with debug logs ----
function broadcastToDashboards(type, data) {
  console.log(`[Broadcast] Attempting to broadcast "${type}" to ${dashboardClients.size} clients`);
  if (dashboardClients.size === 0) {
    console.warn(`[Broadcast] No dashboard clients connected.`);
    return;
  }
  const message = JSON.stringify({ type, data });
  let sent = 0;
  dashboardClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
      sent++;
    } else {
      console.warn(`[Broadcast] Client not open, state: ${client.readyState}`);
    }
  });
  console.log(`[Broadcast] Sent "${type}" to ${sent} clients`);
}

function broadcast(type, data) {
  broadcastToDashboards(type, data);
}

// ---------- Connect CTOS Events to WebSocket ----------
awarenessEngine.on('marketAwareness', (data) => broadcast('marketAwareness', data));
deepRegime.on('regime', (regime) => broadcast('regime', regime));
decisionEngine.on('decision', (decision) => broadcast('decision', decision));
eventBus.on('account.fetched', (account) => broadcast('account', account));
eventBus.on('trade.closed', (data) => broadcast('tradeClosed', data));

// ✅ FIX: Align event names with frontend expectations
eventBus.on('order.placed', (data) => broadcast('trade.placed', data));
eventBus.on('position.updated', (data) => broadcast('positions', data));

// ---------- OTIE V5 Event Broadcasts ----------
otie.on('otieV5State', (state) => broadcast('otieV5State', state));
otie.on('otieV5Action', (action) => broadcast('otieV5Action', action));

// ---------- Performance Monitor ----------
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

// ---------- Start Deriv Broker and connect to events ----------
async function startDerivBroker() {
  try {
    const broker = getBroker('deriv_cfd');
    console.log('[Deriv] Connecting Deriv broker...');
    await broker.connect();
    console.log('[Deriv] Broker connected.');

    // ---- Listen to broker events and broadcast ----
    broker.on('tick', (data) => {
      broadcastToDashboards('price', data);
    });

    broker.on('account', async (accountData) => {
      const enhanced = enhanceAccount(accountData, broker);
      broadcastToDashboards('account', enhanced);
    });

    broker.on('positions', (positions) => {
      broadcastToDashboards('positions', positions);
    });

    broker.on('orderUpdate', (data) => {
      broadcastToDashboards('orderUpdate', data);
    });

    broker.on('_portfolioUpdated', (positions) => {
      broadcastToDashboards('positions', positions);
    });

    console.log('[Deriv] Broker event listeners attached.');
  } catch (err) {
    console.error('[Deriv] Failed to start Deriv broker:', err.message);
  }
}

// ---------- Start Server ----------
async function startServer() {
  await ensureAdmin();

  server.listen(PORT, () => {
    console.log(`✅ RTS server running on http://localhost:${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`🔌 API base: http://localhost:${PORT}/api`);
    console.log(`🔬 Research endpoints: http://localhost:${PORT}/api/research`);
    console.log(`📡 Deriv REST endpoints: http://localhost:${PORT}/api/deriv`);
    console.log('🧠 CTOS Cognitive Engine: enabled.');
    console.log('📡 Request logging enabled.');
    console.log('🛠️  JSON repair enabled as fallback.');
    console.log('🧹  Null bytes (\\0) stripped from all incoming JSON.');
    console.log('📦 Deriv broker: active, connected to WebSocket.');

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

    // ---- Start Outcome Labeler Scheduler (DISABLED) ----
    console.log('⏸️ Outcome labeler scheduler disabled.');

    // ---- Connect Deriv broker after startup ----
    setTimeout(startDerivBroker, 3000);
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
