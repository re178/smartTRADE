// server.js – RTS Entry Point (Deriv‑only)
// INTEGRATED: Prediction Engine, Opportunity Engine, Risk Engine.
// Now broadcasts 'prediction' and 'opportunity' events to dashboard.
// SYMBOL FIX: Watched symbols changed to canonical (EURUSD, etc.)
// PIPELINE: Timer and candle‑close triggers active.
// LOGGING: Verbose logging removed. Summary-only output.

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

// ---------- COGNITIVE MODULES (Legacy) ----------
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

// ---------- NEW MULTIPLIER ENGINES ----------
const predictionEngine = require('./core/intelligence/predictionEngine');
const opportunityEngine = require('./core/intelligence/opportunityEngine');
const riskEngine = require('./core/risk/riskEngine');

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
    } else if (admin.tradingProduct === 'mt5') {
      admin.tradingProduct = 'deriv_cfd';
      await admin.save();
    }
  } catch (err) {
    console.error('[Admin] Creation failed:', err.message);
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
          } catch (err2) {
            console.error('[BodyParser] JSON repair failed:', err2.message);
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
    console.error('[BodyParser] Request body error:', err.message);
    next(err);
  });
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
    }
    req.user = { id: 'admin', tradingProduct: admin.tradingProduct };
    next();
  } catch (err) {
    console.error('[AdminMiddleware] Error:', err.message);
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

// ---------- SPA Fallback ----------
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
const dashboardClients = new Set();

const WS_PING_INTERVAL = 30000;
let wsPingTimer = null;

wss.on('connection', (ws, req) => {
  dashboardClients.add(ws);
  sendDashboardInitialState(ws);
  console.log(`[WS] Dashboard client connected (total: ${dashboardClients.size})`);

  ws.on('close', () => {
    dashboardClients.delete(ws);
    console.log(`[WS] Dashboard client disconnected (total: ${dashboardClients.size})`);
  });

  ws.on('error', (err) => console.error('[WS] Error:', err.message));
  ws.on('pong', () => {});
});

function startWSPing() {
  if (wsPingTimer) clearInterval(wsPingTimer);
  wsPingTimer = setInterval(() => {
    for (const client of dashboardClients) {
      if (client.readyState === WebSocket.OPEN) client.ping();
    }
  }, WS_PING_INTERVAL);
}

// ---------- Helper: enhance account ----------
function enhanceAccount(accountData, broker) {
  if (!accountData) return accountData;
  let tradeMode = 0;
  let server = 'Unknown';
  if (broker && broker._account) {
    tradeMode = broker._account.is_virtual !== undefined ? (broker._account.is_virtual ? 1 : 0) : 0;
    server = broker._account.landing_company_name || 'Unknown';
  }
  return { ...accountData, tradeMode, server };
}

// ---------- Send initial state ----------
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
    try { broker = getBroker('deriv_cfd'); } catch (e) {}
    const enhancedAccount = enhanceAccount(account, broker);

    ws.send(JSON.stringify({ type: 'init', data: { trades, account: enhancedAccount, positions } }));
  } catch (err) {
    console.error('[WS] Failed to send initial state:', err.message);
  }
}

// ---- Broadcast functions ----
function broadcastToDashboards(type, data) {
  if (dashboardClients.size === 0) return;
  const message = JSON.stringify({ type, data });
  dashboardClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}
function broadcast(type, data) { broadcastToDashboards(type, data); }

// ---------- Legacy event bindings ----------
awarenessEngine.on('marketAwareness', (data) => broadcast('marketAwareness', data));
deepRegime.on('regime', (regime) => broadcast('regime', regime));
decisionEngine.on('decision', (decision) => broadcast('decision', decision));
eventBus.on('account.fetched', (account) => broadcast('account', account));
eventBus.on('trade.closed', (data) => broadcast('tradeClosed', data));
eventBus.on('order.placed', (data) => broadcast('trade.placed', data));
eventBus.on('position.updated', (data) => broadcast('positions', data));
otie.on('otieV5State', (state) => broadcast('otieV5State', state));
otie.on('otieV5Action', (action) => broadcast('otieV5Action', action));

// ---------- Performance Monitor ----------
eventBus.on('trade.closed', async (data) => {
  try {
    const Trade = require('./models/Trade');
    const trade = await Trade.findOne({ contractId: data.contractId });
    if (trade) performanceMonitor.recordTrade(trade);
  } catch (err) {
    console.error('[PerformanceMonitor] Failed to record trade:', err.message);
  }
});
performanceMonitor.on('thresholdsUpdated', (thresholds) => {
  if (otie && typeof otie.updateConfig === 'function') {
    otie.updateConfig(thresholds);
  } else {
    console.warn('[PerformanceMonitor] OTIE updateConfig method not available.');
  }
});

// ============================================================
//  PREDICTION / OPPORTUNITY PIPELINE
// ============================================================

const WATCHED_SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'];

async function runPredictionPipeline(symbol) {
  try {
    const state = await require('./core/intelligence/deep/marketState').compute(symbol, 'M5', 200);
    if (!state) return false;

    const product = 'deriv_cfd';
    const broker = getBroker(product);
    const account = await broker.getAccount();
    const positions = await broker.getOpenTrades();

    const marketData = {
      currentPrice: state.price.current,
      spread: state.awareness?.spread || 0,
      timestamp: new Date().toISOString(),
    };

    const prediction = await predictionEngine.predict(state, symbol);
    if (!prediction) return false;

    broadcastToDashboards('prediction', prediction);

    const opportunity = await opportunityEngine.evaluate(
      prediction,
      account,
      positions,
      marketData,
      { riskPerTradePct: parseFloat(process.env.RISK_PER_TRADE_PCT) || 1.0 }
    );

    broadcastToDashboards('opportunity', opportunity);
    return true;
  } catch (err) {
    console.error(`[Pipeline] Error for ${symbol}:`, err.message);
    return false;
  }
}

async function runPredictionPipelineAll() {
  let ok = 0;
  for (const symbol of WATCHED_SYMBOLS) {
    const result = await runPredictionPipeline(symbol);
    if (result) ok++;
  }
  console.log(`[Pipeline] Cycle complete: ${ok}/${WATCHED_SYMBOLS.length} symbols processed.`);
}

// ---- Trigger on candle close ----
candleStore.on('candleClosed', async (candle) => {
  if (candle.timeframe === 'M5' && WATCHED_SYMBOLS.includes(candle.symbol)) {
    await runPredictionPipeline(candle.symbol);
  }
});

// ---- Timer trigger ----
let pipelineTimer = null;
function startPipelineTimer() {
  if (pipelineTimer) clearInterval(pipelineTimer);
  const intervalMs = parseInt(process.env.PREDICTION_INTERVAL_MS) || 30000;
  pipelineTimer = setInterval(() => {
    runPredictionPipelineAll().catch(err => {
      console.error('[Pipeline] Timer error:', err.message);
    });
  }, intervalMs);
  console.log(`[Pipeline] Timer started (${intervalMs}ms).`);
}

// ---------- DEBUG ROUTE ----------
app.get('/debug/status', (req, res) => {
  const lastState = marketStateCache.get('EURUSD') || null;
  const lastRegime = deepRegime.getLatestRegime('EURUSD') || null;
  const lastDecision = decisionEngine.getLastDecision('EURUSD') || null;
  res.json({
    engine: {
      candleBuilder: typeof candleStore !== 'undefined' ? 'running' : 'not loaded',
      marketAwareness: awarenessEngine ? 'running' : 'not loaded',
      deepRegime: deepRegime ? 'running' : 'not loaded',
      decisionEngine: decisionEngine ? 'running' : 'not loaded',
      otieV5: otie ? 'running' : 'not loaded',
    },
    lastCandle: candleStore.getHistory('EURUSD', 'M5', 1)[0] || null,
    lastMarketState: lastState,
    lastRegime: lastRegime,
    lastDecision: lastDecision,
    timestamp: new Date().toISOString(),
  });
});

// ---------- Start Cognitive Engines ----------
async function startCognitiveEngines() {
  try {
    console.log('[CTOS] Cognitive engines active: Awareness, Regime, Decision, OTIE V5, PerformanceMonitor.');
  } catch (err) {
    console.error('[CTOS] Initialization error:', err.message);
  }
}

// ---------- Start Deriv Broker ----------
async function startDerivBroker() {
  try {
    const broker = getBroker('deriv_cfd');
    await broker.connect();
    console.log('[Deriv] Broker connected.');

    broker.on('tick', (data) => broadcastToDashboards('price', data));
    broker.on('account', async (accountData) => {
      const enhanced = enhanceAccount(accountData, broker);
      broadcastToDashboards('account', enhanced);
    });
    broker.on('positions', (positions) => broadcastToDashboards('positions', positions));
    broker.on('orderUpdate', (data) => broadcastToDashboards('orderUpdate', data));
    broker.on('_portfolioUpdated', (positions) => broadcastToDashboards('positions', positions));
  } catch (err) {
    console.error('[Deriv] Failed to start Deriv broker:', err.message);
  }
}

// ---------- Start Server ----------
async function startServer() {
  await ensureAdmin();

  server.listen(PORT, () => {
    console.log('==============================================');
    console.log(`✅ RTS server running on http://localhost:${PORT}`);
    console.log(`📊 Dashboard:      http://localhost:${PORT}`);
    console.log(`🔌 API base:       http://localhost:${PORT}/api`);
    console.log(`🔬 Research:       http://localhost:${PORT}/api/research`);
    console.log(`📡 Deriv REST:     http://localhost:${PORT}/api/deriv`);
    console.log('🧠 CTOS Cognitive Engine: enabled');
    console.log('📦 Deriv broker: active');
    console.log('🧪 Prediction/Opportunity Pipeline: enabled');
    console.log('==============================================');

    startWSPing();

    Promise.all([
      dataOrchestrator.recover(),
      stateStore.init(),
    ]).then(() => {
      console.log('✅ Data Orchestrator and State Store initialised.');
    }).catch(err => {
      console.warn('⚠️ Failed to initialise Data Orchestrator/State Store:', err.message);
    });

    setTimeout(startCognitiveEngines, 2000);
    startPipelineTimer();
    console.log('⏸️ Outcome labeler scheduler disabled.');
    setTimeout(startDerivBroker, 3000);
  });

  process.on('SIGINT', async () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    if (wsPingTimer) clearInterval(wsPingTimer);
    if (pipelineTimer) clearInterval(pipelineTimer);
    try {
      await dataOrchestrator.shutdown();
      if (otie && typeof otie.stop === 'function') otie.stop();
    } catch (err) {
      console.error('Error during shutdown:', err.message);
    }
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
    if (wsPingTimer) clearInterval(wsPingTimer);
    if (pipelineTimer) clearInterval(pipelineTimer);
    try {
      await dataOrchestrator.shutdown();
      if (otie && typeof otie.stop === 'function') otie.stop();
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
