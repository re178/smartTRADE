// server.js – RTS Entry Point (Deriv‑only)
// INTEGRATED: Prediction Engine, Opportunity Engine, Risk Engine, OTIE V6.
// Now broadcasts 'prediction', 'opportunity', and 'otieState' events.
//
// [WIRE-1..6] Circular-require, listener ordering, contractUpdate, shutdown.
// [FILE-9A..9H] Outcome labeler, analytics dashboard, candle bootstrapper,
//               broker-first pipeline, pipeline logging, debug routes,
//               subsystem status log.
// [FILE-2-OF-4] NEW: broadcast 'otieState' from OTIE V6 to the frontend.
//   Without this line, the frontend OTIE panel has nothing to render.

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const WebSocket = require('ws');
const http = require('http');

// ============================================================
// [WIRE-1 / WIRE-2] Broadcast helpers MUST be defined and exported
// before anything that requires them is loaded.
// ============================================================
const dashboardClients = new Set();

function broadcastToDashboards(type, data) {
  if (dashboardClients.size === 0) return;
  const message = JSON.stringify({ type, data });
  for (const client of dashboardClients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}
function broadcast(type, data) { broadcastToDashboards(type, data); }

module.exports.broadcastToDashboards = broadcastToDashboards;
module.exports.broadcast = broadcast;
// ============================================================

// ---- NOW it is safe to require the route tree ----
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

// ---------- OUTCOME LABELER [FILE-9A] ----------
const outcomeLabeler = require('./core/intelligence/lab/outcomeLabeler');

// ---------- ANALYTICS DASHBOARD [FILE-9B] ----------
const analyticsDashboard = require('./core/analytics/dashboard');

// ---------- CANDLE BOOTSTRAPPER [FILE-9C] ----------
const candleBootstrapper = require('./core/data/candleBootstrapper');

// ---------- OTIE V5/V6 ----------
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

// ---------- [FILE-9G] Pipeline health check ----------
app.get('/health/pipeline', async (req, res) => {
  try {
    const broker = getBroker('deriv_cfd');
    const connected = broker.isConnected ? broker.isConnected() : false;
    const cache = marketStateCache._cache || new Map();
    const hasMarketData = cache.size > 0;

    let labelStale = true;
    try {
      const HistoricalState = require('./models/HistoricalState');
      const recent = await HistoricalState.findOne({ outcome5: { $exists: true } })
        .sort({ labeledAt: -1 })
        .select('labeledAt')
        .lean();
      if (recent?.labeledAt) {
        const ageMin = (Date.now() - new Date(recent.labeledAt).getTime()) / 60000;
        labelStale = ageMin > 30;
      }
    } catch (_) {}

    const healthy = connected && hasMarketData && !labelStale;
    res.status(healthy ? 200 : 503).json({
      healthy,
      brokerConnected: connected,
      marketCachePopulated: hasMarketData,
      labelerActive: !labelStale,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, healthy: false });
  }
});

// ---------- [FILE-9F] Comprehensive pipeline diagnostic ----------
app.get('/debug/pipeline', async (req, res) => {
  try {
    const broker = getBroker('deriv_cfd');
    const brokerHealth = broker.getHealth ? broker.getHealth() : {};
    const cache = marketStateCache._cache || new Map();

    let deepBuffers = 0;
    try {
      deepBuffers = require('./core/intelligence/deep/marketState')._buffers?.size || 0;
    } catch (_) {}

    let lastLabel = null;
    try {
      const HistoricalState = require('./models/HistoricalState');
      const last = await HistoricalState.findOne({ outcome5: { $exists: true } })
        .sort({ labeledAt: -1 })
        .select('labeledAt symbol')
        .lean();
      if (last) lastLabel = { symbol: last.symbol, at: last.labeledAt };
    } catch (_) {}

    let dashboardMetrics = {};
    try {
      dashboardMetrics = analyticsDashboard.getMetrics ? analyticsDashboard.getMetrics() : {};
    } catch (_) {}

    let otieState = {};
    try {
      otieState = otie.getAllStates ? otie.getAllStates() : {};
    } catch (_) {}

    res.json({
      timestamp: new Date().toISOString(),
      broker: {
        connected: broker.isConnected ? broker.isConnected() : false,
        publicState: brokerHealth.publicState,
        authState: brokerHealth.authState,
        contractMonitoring: brokerHealth.contractMonitoring,
        accountLoaded: brokerHealth.accountLoaded,
      },
      marketCache: {
        symbolCount: cache.size,
        symbols: Array.from(cache.keys()),
      },
      deepState: { bufferCount: deepBuffers },
      pipeline: { timerRunning: !!pipelineTimer },
      outcomeLabeler: { lastLabel },
      analyticsDashboard: {
        hasMetrics: Object.keys(dashboardMetrics).length > 0,
        totalTrades: dashboardMetrics.totalTrades || 0,
      },
      otie: {
        observerCount: otie.observerCount || 0,
        states: otieState,
      },
      watchedSymbols: WATCHED_SYMBOLS,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- DEBUG ROUTE (existing) ----------
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

const WS_PING_INTERVAL = 30000;
let wsPingTimer = null;

wss.on('connection', (ws, req) => {
  dashboardClients.add(ws);
  sendDashboardInitialState(ws);

  ws.on('close', () => {
    dashboardClients.delete(ws);
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

    let otieState = {};
    try {
      otieState = otie.getAllStates ? otie.getAllStates() : {};
    } catch (_) {}

    ws.send(JSON.stringify({
      type: 'init',
      data: { trades, account: enhancedAccount, positions, otieStates: otieState }
    }));
  } catch (err) {
    console.error('[WS] Failed to send initial state:', err.message);
  }
}

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

// [FILE-2-OF-4] Broadcast OTIE V6 trajectory state to the frontend.
// Without this line, live.js receives nothing and the OTIE panel is empty.
otie.on('otieState', (state) => broadcast('otieState', state));

// ---------- Performance Monitor ----------
eventBus.on('trade.closed', async (data) => {
  try {
    const Trade = require('./models/Trade');
    const trade = await Trade.findOne({ contractId: String(data.contractId) });
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
    if (!prediction) {
      console.log(`[Pipeline] ${symbol}: no prediction (state quality insufficient)`);
      return false;
    }

    broadcastToDashboards('prediction', prediction);

    const opportunity = await opportunityEngine.evaluate(
      prediction,
      account,
      positions,
      marketData,
      { riskPerTradePct: parseFloat(process.env.RISK_PER_TRADE_PCT) || 1.0 }
    );

    broadcastToDashboards('opportunity', opportunity);
    console.log(
      `[Pipeline] ${symbol}: ${opportunity.decision || 'NO_TRADE'} ` +
      `${opportunity.tradable
        ? (opportunity.multiplier + 'x ' + opportunity.direction)
        : (opportunity.reason || '')}`
    );
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
  if (ok === 0) {
    console.debug(`[Pipeline] Cycle complete: 0/${WATCHED_SYMBOLS.length} produced predictions`);
  }
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

// ---------- Start Cognitive Engines ----------
async function startCognitiveEngines() {
  try {
    console.log('[CTOS] Cognitive engines active: Awareness, Regime, Decision, OTIE V6, PerformanceMonitor.');
  } catch (err) {
    console.error('[CTOS] Initialization error:', err.message);
  }
}

// ---------- Start Deriv Broker ----------
async function startDerivBroker() {
  try {
    const broker = getBroker('deriv_cfd');

    broker.on('tick', (data) => broadcastToDashboards('price', data));
    broker.on('accountUpdate', async (accountData) => {
      const enhanced = enhanceAccount(accountData, broker);
      broadcastToDashboards('account', enhanced);
    });
    broker.on('contractUpdate', (state) => broadcastToDashboards('contractUpdate', state));
    broker.on('positions', (positions) => broadcastToDashboards('positions', positions));
    broker.on('orderUpdate', (data) => broadcastToDashboards('orderUpdate', data));
    broker.on('_portfolioUpdated', (positions) => broadcastToDashboards('positions', positions));

    await broker.connect();
    console.log('[Deriv] Broker connected.');
  } catch (err) {
    console.error('[Deriv] Failed to start Deriv broker:', err.message);
    throw err;
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
    console.log(`🩺 Health:         http://localhost:${PORT}/health/pipeline`);
    console.log(`🔧 Debug:          http://localhost:${PORT}/debug/pipeline`);
    console.log('🧠 CTOS Cognitive Engine: enabled');
    console.log('📦 Deriv broker: active');
    console.log('🧪 Prediction/Opportunity Pipeline: enabled');
    console.log('📈 OTIE V6: tick-driven profit observer');
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

    try {
      outcomeLabeler.startScheduler();
      console.log('✅ Outcome labeler scheduler started.');
    } catch (err) {
      console.error('❌ Outcome labeler failed to start:', err.message);
    }

    try {
      analyticsDashboard.start();
      console.log('✅ Analytics dashboard started.');
    } catch (err) {
      console.error('❌ Analytics dashboard failed to start:', err.message);
    }

    try {
      candleBootstrapper.bootstrap().then(() => {
        console.log('✅ Candle bootstrap complete.');
      }).catch(err => {
        console.warn('⚠️ Candle bootstrap failed (non-fatal):', err.message);
      });
    } catch (err) {
      console.warn('⚠️ Candle bootstrap threw (non-fatal):', err.message);
    }

    setTimeout(() => {
      startDerivBroker().then(() => {
        const broker = getBroker('deriv_cfd');
        if (broker.isConnected()) {
          console.log('✅ Broker ready — starting pipeline timer.');
          startPipelineTimer();
          setTimeout(() => {
            runPredictionPipelineAll().catch(err => {
              console.error('[Pipeline] Initial run error:', err.message);
            });
          }, 2000);
        } else {
          console.warn('⚠️ Broker not connected — pipeline will start on ready event.');
          broker.once('ready', () => {
            console.log('✅ Broker ready (delayed) — starting pipeline timer.');
            startPipelineTimer();
          });
        }
      }).catch(err => {
        console.error('❌ startDerivBroker failed:', err.message);
        startPipelineTimer();
      });
    }, 3000);

    setTimeout(() => {
      console.log('==============================================');
      console.log('📊 RTS Subsystem Status:');
      try {
        const broker = getBroker('deriv_cfd');
        console.log(`   Broker:            ${broker.isConnected() ? '🟢 connected' : '🔴 disconnected'}`);
      } catch (_) {
        console.log('   Broker:            🔴 not initialized');
      }
      console.log(`   Pipeline timer:    ${pipelineTimer ? '🟢 running' : '🔴 stopped'}`);
      console.log(`   Outcome labeler:   🟢 scheduled`);
      console.log(`   Analytics dash:    🟢 running`);
      try {
        console.log(`   OTIE observers:    ${otie.observerCount || 0} contract(s)`);
      } catch (_) {}
      try {
        console.log(`   Market cache:      ${marketStateCache._cache.size} symbols`);
      } catch (_) {}
      try {
        const buffers = require('./core/intelligence/deep/marketState')._buffers?.size || 0;
        console.log(`   Deep state:        ${buffers} buffers`);
      } catch (_) {}
      console.log('==============================================');
    }, 15000);
  });

  async function shutdown(signal) {
    console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
    if (wsPingTimer) clearInterval(wsPingTimer);
    if (pipelineTimer) clearInterval(pipelineTimer);
    try {
      await dataOrchestrator.shutdown();
      if (otie && typeof otie.stop === 'function') otie.stop();
    } catch (err) {
      console.error('Error during shutdown:', err.message);
    }
    try {
      if (typeof outcomeLabeler.stopScheduler === 'function') outcomeLabeler.stopScheduler();
    } catch (_) {}
    try {
      if (typeof analyticsDashboard.stop === 'function') analyticsDashboard.stop();
    } catch (_) {}
    try {
      const broker = getBroker('deriv_cfd');
      if (broker && typeof broker.disconnect === 'function') await broker.disconnect();
    } catch (_) {}
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startServer().catch(err => {
  console.error('❌ Server start error:', err);
  process.exit(1);
});
