const oanda = require('./oandaService');

class StrategyService {
  // Generate signal for a pair using a simple MA crossover
  async generateSignal(pair) {
    try {
      const candles = await oanda.getCandles(pair, 200, 'M5');
      const closes = candles.map(c => c.mid.c);

      if (closes.length < 50) return null;

      // Calculate SMA 10 and SMA 30
      const sma10 = this.sma(closes, 10);
      const sma30 = this.sma(closes, 30);

      const currentSMA10 = sma10[sma10.length - 1];
      const currentSMA30 = sma30[sma30.length - 1];
      const prevSMA10 = sma10[sma10.length - 2];
      const prevSMA30 = sma30[sma30.length - 2];

      let signal = null;
      if (prevSMA10 <= prevSMA30 && currentSMA10 > currentSMA30) {
        signal = 'BUY';
      } else if (prevSMA10 >= prevSMA30 && currentSMA10 < currentSMA30) {
        signal = 'SELL';
      }

      if (!signal) return null;

      // Get current price
      const prices = await oanda.getPrices([pair]);
      const currentPrice = parseFloat(prices[0].bids[0].price);

      // Simple stop loss and take profit (1% and 2% away)
      const atr = this.atr(candles, 14); // simplistic: use ATR from last candle or fixed pips
      // For simplicity, use fixed pips (e.g., 50 pips for EUR/USD)
      const pipSize = 0.0001; // for most pairs, adjust
      const slPips = 50;
      const tpPips = 100;

      let stopLoss, takeProfit;
      if (signal === 'BUY') {
        stopLoss = currentPrice - slPips * pipSize;
        takeProfit = currentPrice + tpPips * pipSize;
      } else {
        stopLoss = currentPrice + slPips * pipSize;
        takeProfit = currentPrice - tpPips * pipSize;
      }

      return {
        pair,
        side: signal,
        entryPrice: currentPrice,
        stopLoss,
        takeProfit,
        confidence: 75, // placeholder
      };
    } catch (error) {
      console.error('Strategy error:', error.message);
      return null;
    }
  }

  // Helper: simple moving average
  sma(data, period) {
    const result = [];
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) {
        result.push(null);
      } else {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) {
          sum += data[j];
        }
        result.push(sum / period);
      }
    }
    return result;
  }

  // Simplified ATR (using last candle high-low)
  atr(candles, period) {
    // Placeholder: just return average of high-low over last period
    const hl = candles.slice(-period).map(c => c.mid.h - c.mid.l);
    return hl.reduce((a, b) => a + b, 0) / hl.length;
  }
}

module.exports = new StrategyService();
