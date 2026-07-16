// ---------- User Preferences (Product Toggle) ----------
exports.getPreferences = async (req, res) => {
  try {
    const product = req.user?.tradingProduct || process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd';
    res.json({ tradingProduct: product });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updatePreferences = async (req, res) => {
  const { tradingProduct } = req.body;
  const validProducts = ['mt5', 'deriv_cfd', 'deriv_multiplier', 'deriv_basic'];
  if (!validProducts.includes(tradingProduct)) {
    return res.status(400).json({ error: 'Invalid product' });
  }
  try {
    // Assuming you have a User model and req.user contains the user ID
    const User = require('../models/User'); // adjust path if needed
    await User.findOneAndUpdate(
      { userId: req.user.id },
      { tradingProduct },
      { upsert: true, new: true }
    );
    // Update the current request's user object
    req.user.tradingProduct = tradingProduct;
    res.json({ success: true, tradingProduct });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
