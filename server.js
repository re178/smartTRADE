// server.js – RTS Entry Point
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

// Import database connection
const connectDB = require('./config/db');

// Import API routes (new modular structure)
const apiRoutes = require('./api/routes');

// Import broker factory
const { getBroker } = require('./core/execution/brokerFactory');

// Initialize Express
const app = express();
const PORT = process.env.PORT || 5000;

// Connect to MongoDB
connectDB();

// ---------- Middleware ----------
app.use(cors());                         // Enable CORS
app.use(express.json());                 // Parse JSON bodies
app.use(express.static('public'));       // Serve frontend static files

// ---------- (Simulated) User & Authentication Middleware ----------
// In production, replace with real JWT/session authentication.
// This middleware attaches a user object to req.user.
// For demo, it reads from a "users" collection or uses a default.
// The key field is `tradingProduct` which determines which broker to use.
app.use(async (req, res, next) => {
  // For demo, we use a header 'x-user-id' to identify the user.
  // In real app, you'd get user from JWT or session.
  const userId = req.headers['x-user-id'] || 'demo-user';

  try {
    // Assume we have a User model (Mongoose)
    const User = require('./models/User');
    let user = await User.findOne({ userId });
    if (!user) {
      // Create a default user with 'deriv_cfd' as the default product
      user = new User({
        userId,
        tradingProduct: 'deriv_cfd', // default
      });
      await user.save();
    }
    req.user = {
      id: user.userId,
      tradingProduct: user.tradingProduct,
    };
  } catch (err) {
    // Fallback if DB is not ready or User model doesn't exist
    logger.warn('Auth fallback: using default user');
    req.user = {
      id: 'demo',
      tradingProduct: req.headers['x-product'] || req.query.product || 'deriv_cfd',
    };
  }
  next();
});

// ---------- API Routes ----------
// Use the main router from api/routes.js
app.use('/api', apiRoutes);

// ---------- Additional route: Update user preference (dashboard toggle) ----------
// This makes the dashboard the single source of truth.
app.post('/api/user/preferences', async (req, res) => {
  try {
    const { tradingProduct } = req.body;
    const validProducts = ['mt5', 'deriv_cfd', 'deriv_multiplier', 'deriv_basic'];
    if (!validProducts.includes(tradingProduct)) {
      return res.status(400).json({ error: 'Invalid product. Must be one of: ' + validProducts.join(', ') });
    }

    // Update the user in the database
    const User = require('./models/User');
    const user = await User.findOneAndUpdate(
      { userId: req.user.id },
      { tradingProduct },
      { new: true }
    );
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update the current request's user object
    req.user.tradingProduct = tradingProduct;

    res.json({ success: true, tradingProduct: user.tradingProduct });
  } catch (err) {
    logger.error('Error updating user preferences:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------- Example route that uses the broker ----------
// This shows how to use the factory: getBroker(req.user.tradingProduct)
app.post('/api/trade', async (req, res) => {
  try {
    const product = req.user.tradingProduct;
    const broker = getBroker(product);

    const { instrument, units, stopLoss, takeProfit } = req.body;
    const result = await broker.placeMarketOrder(instrument, units, stopLoss, takeProfit);
    res.json({ success: true, result });
  } catch (err) {
    logger.error('Trade error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Health Check ----------
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'RTS is running' });
});

// ---------- SPA Fallback ----------
// For any non-API request, serve the dashboard (index.html)
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
