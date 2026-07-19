// server.js – RTS Entry Point (with MT5 Bridge, Cognitive Intelligence, WebSocket)

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
const User = require('./models/User');

// ---------- COGNITIVE MODULES ----------
const priceBuffer = require('./core/data/priceBuffer');
const candleStore = require('./core/data/candleStore');
const marketIntelligence = require('./core/market/intelligence');
const regimeEngine = require('./core/market/regime');
const fusionEngine = require('./core/signal/fusion');
const selfLearner = require('./core/learning/learner');
const analyticsDashboard = require('./core/analytics/dashboard');
const eventBus = require('./infrastructure/eventBus');

// Optional: validation engine, explainability (not started automatically)
// const validationEngine = require('./core/validation/engine');

const logger = require('./infrastructure/logger') || console;

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

// ---------- Connect cognitive events to WebSocket ----------
// 1. Fusion decisions
fusionEngine.on('decision', (decision) => {
  broadcast('decision', decision);
});

// 2. Regime changes
regimeEngine.on('regime', (regime) => {
  broadcast('regime', regime);
});

// 3. Market closed events
fusionEngine.on('marketClosed', (data) => {
  broadcast('marketClosed', data);
});

// 4. Performance metrics (if analyticsDashboard emits)
analyticsDashboard.on('metrics', (metrics) => {
  broadcast('metrics', metrics);
});

// Optional: explanation events
fusionEngine.on('explanation', (explanation) => {
  broadcast('explanation', explanation);
});

// ---------- Start Cognitive Engines ----------
async function startCognitiveEngines() {
  try {
    // Load historical trades for self‑learner
    await selfLearner.loadHistory();
    console.log('[Cognitive] SelfLearner loaded history.');

    // Start the fusion engine (which loads weights from learner)
    await fusionEngine.start();
    console.log('[Cognitive] FusionEngine started.');

    // Start analytics dashboard
    analyticsDashboard.start();
    console.log('[Cognitive] AnalyticsDashboard started.');

    // Connect learner to fusion for weight updates
    selfLearner.on('weightsUpdated', (weights) => {
      fusionEngine.updateWeights(weights);
      console.log('[Cognitive] Fusion weights updated.');
    });

    // Connect trade closure events to the learner
    eventBus.on('trade.closed', (data) => {
      if (data.trade) {
        selfLearner.recordTrade(data.trade);
        // Also update analytics dashboard (if needed)
        // analyticsDashboard._addTrade(data.trade); // optional
      }
    });

    // Also forward account updates to analytics dashboard
    eventBus.on('account.fetched', (account) => {
      const equity = parseFloat(account.equity);
      const balance = parseFloat(account.balance);
      // Set initial balance if not set
      if (analyticsDashboard._initialBalance === 0) {
        analyticsDashboard.setInitialBalance(balance);
      }
      // The dashboard will update equity via its own event listener.
    });

    console.log('[Cognitive] All cognitive modules initialized.');
  } catch (err) {
    console.error('[Cognitive] Initialization error:', err.message);
  }
}

// ---------- Start Server ----------
async function startServer() {
  await ensureAdmin();

  // Start HTTP server
  server.listen(PORT, () => {
    console.log(`✅ RTS server running on http://localhost:${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`🔌 API base: http://localhost:${PORT}/api`);
    console.log(`🟢 MT5 Bridge endpoints: http://localhost:${PORT}/api/mt5`);
    console.log('📡 WebSocket server ready for real‑time signals.');
    console.log('📡 Request logging enabled.');
    console.log('🛠️  JSON repair enabled as fallback.');
    console.log('🧹  Null bytes (\\0) stripped from all incoming JSON.');
    console.log('💾 MT5 data is persistent (MongoDB).');
  });

  // Start cognitive engines after server is up
  setTimeout(startCognitiveEngines, 2000);
}

startServer().catch(err => {
  console.error('❌ Server start error:', err);
  process.exit(1);
});
