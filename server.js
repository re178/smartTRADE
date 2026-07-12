require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 5000;

// Connect to MongoDB
connectDB();

// Middleware
app.use(cors());
app.use(express.json());

// ** Serve static frontend files from the "public" folder **
app.use(express.static('public'));

// API routes (all endpoints under /api)
app.use('/api', apiRoutes);

// Health check
app.get('/health', (req, res) => res.send('RTS is running'));

// Catch-all: any non-API request serves the dashboard (SPA support)
app.get('*', (req, res) => {
  // If the request is not for an API route, serve index.html
  if (!req.path.startsWith('/api')) {
    res.sendFile('index.html', { root: 'public' });
  } else {
    res.status(404).json({ error: 'API endpoint not found' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`RTS server running on port ${PORT}`);
});
