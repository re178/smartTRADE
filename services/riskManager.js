const oanda = require('./oandaService');

class RiskManager {
  // Calculate lot size based on account balance, risk % per trade, and stop loss distance
  async calculateLotSize(pair, entry, stopLoss, riskPercent = 1) {
    try {
      const account = await oanda.getAccount();
      const balance = parseFloat(account.balance);
      const riskAmount = balance * (riskPercent / 100);
      const pipDistance = Math.abs(entry - stopLoss);
      // For simplicity, assume 1 lot = 100,000 units and pip value = $10 for USD pairs
      // Better to use proper pip value calculation, but this is a demo
      const pipValue = 10; // approx for EUR/USD
      const lotSize = riskAmount / (pipDistance * pipValue);
      // Round to 0.01 lots
      return Math.round(lotSize * 100) / 100;
    } catch (error) {
      console.error('Risk calculation error:', error.message);
      return 0.01; // fallback
    }
  }
}

module.exports = new RiskManager();
