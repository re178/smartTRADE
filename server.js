// server.js – RTS Entry Point (with MT5 Bridge integration)

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');

// Database connection
const connectDB = require('./config/db');

// API routes (existing)
const apiRoutes = require('./api/routes');

// MT5 Bridge routes (NEW)
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

    // Drop all collections (this wipes everything)
    const collections = await mongoose.connection.db.collections();
    for (const collection of collections) {
      await collection.drop();
      console.log(`   Dropped collection: ${collection.collectionName}`);
    }

    console.log('✅ Database cleaned successfully.');

    // Create admin user with default product
    const defaultProduct = process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd';
    const admin = new User({
      userId: 'admin',
      tradingProduct: defaultProduct,
    });
    await admin.save();
    console.log(`✅ Admin user created with product: ${defaultProduct}`);

  } catch (err) {
    console.error('❌ Database cleanup failed:', err.message);
    // Continue anyway – maybe collections don't exist yet
  }
}

// ---------- Middleware ----------
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ---------- Admin User Middleware ----------
app.use(async (req, res, next) => {
  try {
    const adminId = 'admin';
    let admin = await User.findOne({ userId: adminId });
    if (!admin) {
      // Fallback: create if not exists (should already exist)
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

// ---------- MT5 Bridge Routes (NEW) ----------
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
  // Wait for DB connection and clean up before starting
  await cleanDatabaseAndCreateAdmin();

  app.listen(PORT, () => {
    console.log(`✅ RTS server running on http://localhost:${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`🔌 API base: http://localhost:${PORT}/api`);
    console.log(`🟢 MT5 Bridge endpoints: http://localhost:${PORT}/api/mt5`);
  });
}

startServer().catch(err => {
  console.error('❌ Server start error:', err);
  process.exit(1);
});
