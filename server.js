// server.js – RTS Entry Point
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

// Import database connection
const connectDB = require('./config/db');

// Import API routes (new modular structure)
const apiRoutes = require('./api/routes');

// ---------- Import broker factory middleware ----------
const brokerFactory = require('./core/execution/brokerFactory');

// Initialize Express
const app = express();
const PORT = process.env.PORT || 5000;

// Connect to MongoDB
connectDB();

// ---------- Middleware ----------
app.use(cors());                         // Enable CORS
app.use(express.json());                 // Parse JSON bodies
app.use(express.static('public'));       // Serve frontend static files

// ---------- (Optional) Authentication middleware ----------
// Example: attach user to req (you may have your own)
// app.use((req, res, next) => {
//   // For demo, read from header or query
//   const product = req.headers['x-product'] || req.query.product || 'deriv';
//   req.user = { tradingProduct: product };
//   next();
// });

// ---------- Broker Product Context Middleware ----------
// This must run AFTER you have determined the user's preference.
// It sets the product in AsyncLocalStorage so that getBroker() knows which one to return.
app.use(brokerFactory.middleware((req) => {
  // --- CUSTOMIZE THIS FUNCTION ---
  // Read the product preference from the authenticated user, database, or session.
  // For now, we use a header, query param, or fallback to environment variable.

  // 1. From authenticated user (if you have a user object):
  // return req.user?.tradingProduct || process.env.TRADING_PRODUCT || 'deriv';

  // 2. From header (for testing):
  const headerProduct = req.headers['x-product'];
  if (headerProduct) return headerProduct;

  // 3. From query parameter (for quick testing):
  const queryProduct = req.query.product;
  if (queryProduct) return queryProduct;

  // 4. Environment variable (global default)
  return process.env.TRADING_PRODUCT || 'deriv';
}));

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
