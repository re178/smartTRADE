// server.js – RTS Entry Point
// Load environment variables
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

// Import database connection
const connectDB = require('./config/db');

// Import API routes (new modular structure)
const apiRoutes = require('./api/routes');

// Initialize Express
const app = express();
const PORT = process.env.PORT || 5000;

// Connect to MongoDB
connectDB();

// ---------- Middleware ----------
app.use(cors());                         // Enable CORS
app.use(express.json());                 // Parse JSON bodies
app.use(express.static('public'));       // Serve frontend static files

// ---------- API Routes ----------
// All API endpoints are prefixed with /api
app.use('/api', apiRoutes);

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
