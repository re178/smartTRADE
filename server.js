// server.js – RTS Entry Point with Debug Routes & CTOS (Non‑Breaking)
// Added: Outcome labeler scheduler.
// Added: OTIE V5 Open Trade Intelligence Engine.

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

// ---------- WebSocket Server ----------
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('[WebSocket] Client connected.');
  ws.on('close', () => console.log('[WebSocket] Client disconnected.'));
  ws.on('error', (err) => console.error('[WebSocket] Error:', err.message));
});

// ---------- Broadcast functions ----------
function broadcast(type, data) {
  const message = JSON.stringify({ type, data });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// ---------- Connect CTOS Events to WebSocket ----------
awarenessEngine.on('marketAwareness', (data) => {
  broadcast('marketAwareness', data);
});
deepRegime.on('regime', (regime) => {
  broadcast('regime', regime);
});
decisionEngine.on('decision', (decision) => {
  broadcast('decision', decision);
});
eventBus.on('account.fetched', (account) => {
  broadcast('account', account);
});
eventBus.on('trade.closed', (data) => {
  broadcast('tradeClosed', data);
});
eventBus.on('order.placed', (data) => {
  broadcast('orderPlaced', data);
});

// ---------- OTIE V5 Event Broadcasts ----------
otie.on('otieV5State', (state) => {
  broadcast('otieV5State', state);
});
otie.on('otieV5Action', (action) => {
  broadcast('otieV5Action', action);
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
    console.log('📡 WebSocket server ready for real‑time signals.');
    console.log('🧠 CTOS Cognitive Engine: enabled.');
    console.log('📡 Request logging enabled.');
    console.log('🛠️  JSON repair enabled as fallback.');
    console.log('🧹  Null bytes (\\0) stripped from all incoming JSON.');
    console.log('💾 MT5 data is persistent (MongoDB).');

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

    // ---- Start Outcome Labeler Scheduler (every hour) ----
    try {
      const labeler = require('./core/intelligence/lab/outcomeLabeler');
      const interval = parseInt(process.env.OUTCOME_LABEL_INTERVAL_MS) || 60 * 60 * 1000; // default 1 hour
      labeler.startScheduler(interval);
      console.log(`✅ Outcome labeler scheduler started (interval: ${interval}ms)`);
    } catch (err) {
      console.warn('⚠️ Outcome labeler scheduler could not be started:', err.message);
    }
  });

  // ---- Graceful shutdown ----
  process.on('SIGINT', async () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    try {
      await dataOrchestrator.shutdown();
      // Stop OTIE timer
      if (otie && typeof otie.stop === 'function') {
        otie.stop();
      }
      console.log('✅ Data Orchestrator flushed.');
    } catch (err) {
      console.error('Error during shutdown:', err.message);
    }
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
    try {
      await dataOrchestrator.shutdown();
      if (otie && typeof otie.stop === 'function') {
        otie.stop();
      }
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
