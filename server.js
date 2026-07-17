// server.js – RTS Entry Point (with MT5 Bridge & JSON repair)

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');

// Database connection
const connectDB = require('./config/db');

// API routes (existing)
const apiRoutes = require('./api/routes');

// MT5 Bridge routes
const mt5Routes = require('./api/routes/mt5');

// Models
const User = require('./models/User');
const Order = require('./models/Order');
const Trade = require('./models/Trade');

const app = express();
const PORT = process.env.PORT || 5000;

// ---------- Connect to MongoDB ----------
connectDB();

// ---------- Database Cleanup & Admin Creation ----------
async function cleanDatabaseAndCreateAdmin() {
  try {
    console.log('🧹 Cleaning database...');

    const collections = await mongoose.connection.db.collections();
    for (const collection of collections) {
      await collection.drop();
      console.log(`   Dropped collection: ${collection.collectionName}`);
    }

    console.log('✅ Database cleaned successfully.');

    const defaultProduct = process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd';
    const admin = new User({
      userId: 'admin',
      tradingProduct: defaultProduct,
    });
    await admin.save();
    console.log(`✅ Admin user created with product: ${defaultProduct}`);

  } catch (err) {
    console.error('❌ Database cleanup failed:', err.message);
  }
}

// ---------- Helper: Repair truncated JSON ----------
function repairJson(raw) {
  // Count open braces and brackets
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
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

  let repaired = raw;
  // Append missing closing brackets/braces
  while (openBrackets > 0) { repaired += ']'; openBrackets--; }
  while (openBraces > 0) { repaired += '}'; openBraces--; }
  return repaired;
}

// ---------- Middleware ----------
app.use(cors());

// ================================================================
// Manual raw body reader with JSON repair
// ================================================================
app.use((req, res, next) => {
  let rawBody = '';
  req.on('data', chunk => {
    rawBody += chunk.toString();
  });
  req.on('end', () => {
    req.rawBody = rawBody;

    // If Content-Type is JSON, try to parse it, repairing if needed
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('application/json') && rawBody.length > 0) {
      let parsed = null;
      let parseError = null;
      let repaired = rawBody;

      // First attempt: parse as is
      try {
        parsed = JSON.parse(rawBody);
      } catch (err) {
        // If parsing fails, try to repair
        if (err instanceof SyntaxError && err.message.includes('Unexpected end')) {
          repaired = repairJson(rawBody);
          try {
            parsed = JSON.parse(repaired);
            console.log('✅ JSON repaired successfully.');
            console.log('   Original:', rawBody);
            console.log('   Repaired:', repaired);
          } catch (err2) {
            parseError = err2;
          }
        } else {
          parseError = err;
        }
      }

      if (parsed !== null) {
        req.body = parsed;
        // If we used repaired, also attach original for debugging
        if (repaired !== rawBody) {
          req.originalRawBody = rawBody;
          req.repairedRawBody = repaired;
        }
      } else {
        req.body = null;
        req.parseError = parseError || new Error('Invalid JSON');
        console.error('========== JSON PARSE ERROR ==========');
        console.error('Raw body length:', rawBody.length);
        console.error('Raw body:', rawBody);
        console.error('Repaired attempt:', repaired);
        console.error('Error:', parseError?.message);
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

// Handle JSON parse errors
app.use((req, res, next) => {
  if (req.parseError) {
    return res.status(400).json({
      error: 'Invalid JSON payload',
      raw: req.rawBody,
      repaired: req.repairedRawBody || undefined,
      message: req.parseError.message
    });
  }
  next();
});

// ---------- Request Logger Middleware ----------
app.use((req, res, next) => {
  console.log('\n==============================');
  console.log(new Date().toISOString());
  console.log(req.method, req.originalUrl);
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body length:', req.rawBody?.length || 0);
  console.log('Body:', req.rawBody);
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

// ---------- MT5 Bridge Routes ----------
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
  await cleanDatabaseAndCreateAdmin();

  app.listen(PORT, () => {
    console.log(`✅ RTS server running on http://localhost:${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`🔌 API base: http://localhost:${PORT}/api`);
    console.log(`🟢 MT5 Bridge endpoints: http://localhost:${PORT}/api/mt5`);
    console.log('📡 Request logging enabled for all endpoints.');
    console.log('🛠️  JSON repair enabled for truncated payloads.');
  });
}

startServer().catch(err => {
  console.error('❌ Server start error:', err);
  process.exit(1);
});
