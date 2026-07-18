// server.js – RTS Entry Point (with MT5 Bridge & robust JSON handling)

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

// ---------- JSON Repair Helper (fallback only) ----------
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

// ---------- Express built‑in JSON parser with raw body capture ----------
app.use(express.json({
  limit: '2mb',
  verify: (req, res, buf) => {
    // Store raw body as string for logging/debugging
    req.rawBody = buf.toString('utf8');
  }
}));

// ---------- Error handler for malformed JSON (fallback repair) ----------
app.use((err, req, res, next) => {
  // Only handle JSON parse errors
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    const raw = req.rawBody || '';
    console.warn('⚠️ Malformed JSON received. Attempting repair...');
    console.warn('Raw:', raw);
    try {
      const repaired = repairJson(raw);
      const parsed = JSON.parse(repaired);
      // If repair succeeds, replace body and continue
      req.body = parsed;
      req.repairedRawBody = repaired;
      console.log('✅ JSON repaired successfully.');
      console.log('   Repaired:', repaired);
      return next();
    } catch (repairErr) {
      console.error('❌ JSON repair failed:', repairErr.message);
      console.error('   Raw:', raw);
      // Fall through to default error handler
    }
  }
  // If we reach here, pass the error to Express's default handler
  next(err);
});

// ---------- Request Logger (short, clean) ----------
app.use((req, res, next) => {
  // Only log if not a static asset
  if (req.path.startsWith('/api')) {
    console.log('\n==============================');
    console.log(new Date().toISOString());
    console.log(req.method, req.originalUrl);
    console.log('Body length:', req.rawBody?.length || 0);
    if (req.rawBody && req.rawBody.length > 0 && req.rawBody.length < 500) {
      console.log('Raw Body:', req.rawBody);
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

// ---------- Start Server ----------
async function startServer() {
  await ensureAdmin();
  app.listen(PORT, () => {
    console.log(`✅ RTS server running on http://localhost:${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`🔌 API base: http://localhost:${PORT}/api`);
    console.log(`🟢 MT5 Bridge endpoints: http://localhost:${PORT}/api/mt5`);
    console.log('📡 Request logging enabled (truncated for large bodies).');
    console.log('🛠️  JSON repair enabled as a fallback (rare).');
    console.log('💾 MT5 data is now persistent (MongoDB).');
  });
}

startServer().catch(err => {
  console.error('❌ Server start error:', err);
  process.exit(1);
});
