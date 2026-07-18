// server.js – RTS Entry Point (with MT5 Bridge & robust JSON repair)

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');

// Database connection
const connectDB = require('./config/db');

// API routes (existing)
const apiRoutes = require('./api/routes');

// MT5 Bridge routes (persistent, using Mongoose)
const mt5Routes = require('./api/routes/mt5');

// Models
const User = require('./models/User');

const app = express();
const PORT = process.env.PORT || 5000;

// ---------- Connect to MongoDB ----------
connectDB();

// ---------- Admin Creation (without dropping collections) ----------
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

// ---------- JSON Repair Helper ----------
function repairJson(raw) {
  let repaired = raw.trim();
  if (repaired.endsWith(',')) {
    repaired = repaired.slice(0, -1);
  }

  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
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

// ---------- Manual Raw Body Reader with JSON Repair ----------
app.use((req, res, next) => {
  let rawBody = '';
  req.on('data', chunk => {
    rawBody += chunk.toString();
  });
  req.on('end', () => {
    req.rawBody = rawBody;

    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('application/json') && rawBody.length > 0) {
      let parsed = null;
      let repaired = rawBody;

      try {
        parsed = JSON.parse(rawBody);
      } catch (err) {
        if (err instanceof SyntaxError) {
          repaired = repairJson(rawBody);
          try {
            parsed = JSON.parse(repaired);
            console.log('✅ JSON repaired successfully.');
            console.log('   Original:', rawBody);
            console.log('   Repaired:', repaired);
          } catch (err2) {
            console.error('❌ JSON repair also failed:', err2.message);
            console.error('   Raw:', rawBody);
            console.error('   Repaired:', repaired);
          }
        } else {
          throw err;
        }
      }

      if (parsed !== null) {
        req.body = parsed;
        if (repaired !== rawBody) {
          req.repairedRawBody = repaired;
        }
      } else {
        req.body = {};
        req.parseError = new Error('Invalid JSON after repair');
        console.error('========== JSON PARSE ERROR ==========');
        console.error('Raw body length:', rawBody.length);
        console.error('Raw body:', rawBody);
        console.error('Repaired attempt:', repaired);
        console.error('======================================');
      }
    } else {
      req.body = {};
    }
    next();
  });
  req.on('error', (err) => {
    console.error('Request error:', err);
    next(err);
  });
});

// ---------- Request Logger ----------
app.use((req, res, next) => {
  console.log('\n==============================');
  console.log(new Date().toISOString());
  console.log(req.method, req.originalUrl);
  console.log('Body length:', req.rawBody?.length || 0);
  if (req.rawBody && req.rawBody.length > 0) {
    console.log('Raw Body:', req.rawBody);
  }
  if (req.repairedRawBody) {
    console.log('Repaired:', req.repairedRawBody);
  }
  console.log('==============================');
  next();
});

app.use(express.static('public'));

// ---------- Admin User Middleware ----------
app.use(async (req, res, next) => {
  try {
    const adminId = 'admin';
    let admin = await User.findOne({ userId: adminId });
    if (!admin) {
      const defaultProduct = process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd';
      admin = new User({ userId: adminId, tradingProduct: defaultProduct });
      await admin.save();
      console.log('✅ Admin user auto-created (fallback).');
    }
    req.user = { id: adminId, tradingProduct: admin.tradingProduct };
    next();
  } catch (err) {
    console.error('❌ Admin middleware error:', err.message);
    req.user = { id: 'admin', tradingProduct: process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd' };
    next();
  }
});

// ---------- API Routes ----------
app.use('/api', apiRoutes);
app.use('/api/mt5', mt5Routes);   // <-- persistent MT5 endpoints

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

// ---------- Start Server ----------
async function startServer() {
  await ensureAdmin();   // only creates admin if missing, no collection drops
  app.listen(PORT, () => {
    console.log(`✅ RTS server running on http://localhost:${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`🔌 API base: http://localhost:${PORT}/api`);
    console.log(`🟢 MT5 Bridge endpoints: http://localhost:${PORT}/api/mt5`);
    console.log('📡 Request logging enabled.');
    console.log('🛠️  JSON repair enabled (auto‑closes missing braces).');
    console.log('💾 MT5 data is now persistent (MongoDB).');
  });
}

startServer().catch(err => {
  console.error('❌ Server start error:', err);
  process.exit(1);
});
