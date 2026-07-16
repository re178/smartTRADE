// server.js – RTS Entry Point (with admin user auto‑creation)

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

// Database connection
const connectDB = require('./config/db');

// API routes
const apiRoutes = require('./api/routes');

// Models
const User = require('./models/User');

const app = express();
const PORT = process.env.PORT || 5000;

// Connect to MongoDB
connectDB();

// ---------- Middleware ----------
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ---------- Admin User Middleware ----------
// Ensures the admin user exists and attaches it to req.user
app.use(async (req, res, next) => {
  try {
    // Fixed admin user ID
    const adminId = 'admin';
    let admin = await User.findOne({ userId: adminId });
    if (!admin) {
      // Create admin with default product
      const defaultProduct = process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd';
      admin = new User({ userId: adminId, tradingProduct: defaultProduct });
      await admin.save();
      console.log(`✅ Admin user created with product: ${defaultProduct}`);
    }
    // Attach to request so controllers can use it
    req.user = { id: adminId, tradingProduct: admin.tradingProduct };
    next();
  } catch (err) {
    console.error('❌ Admin user middleware error:', err.message);
    // Fallback – still allow request with default product
    req.user = { id: 'admin', tradingProduct: process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd' };
    next();
  }
});

// ---------- API Routes ----------
app.use('/api', apiRoutes);

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
app.listen(PORT, () => {
  console.log(`✅ RTS server running on http://localhost:${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`🔌 API base: http://localhost:${PORT}/api`);
});
