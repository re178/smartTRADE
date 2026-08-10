// api/routes/index.js
// Aggregates all API route modules.

const express = require('express');
const router = express.Router();

// Import route modules
const derivRoutes = require('./deriv');
// Keep any other existing route modules (e.g., research, admin, etc.)
const researchRoutes = require('./research'); // if present
// const adminRoutes = require('./admin');   // etc.

// Mount Deriv routes under /deriv
router.use('/deriv', derivRoutes);

// If you have a /research endpoint, keep it
if (researchRoutes) {
  router.use('/research', researchRoutes);
}

// Optionally add a root health check
router.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', service: 'RTS API', broker: 'Deriv' });
});

// All other routes (if any) go here

module.exports = router;
