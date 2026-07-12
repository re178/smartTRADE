// src/core/strategy/engine.js – Signal Generation Engine

const marketProvider = require('../market/provider');
const { formatPrice, sleep } = require('../../shared/helpers');

/**
 * Generate a trading signal for a given instrument using the MA crossover strategy.
 * Future extension: call AI service for enhanced signals.
 * @param {string} instrument - e.g., 'EUR_USD'
 * @param {string} timeframe - Candle granularity (default: 'M5')
 * @param {number} fastPeriod - Fast moving average period (default: 10)
 * @param {number} slowPeriod - Slow moving average period (default: 30)
 * @returns {Promise<Object|null>} Signal object { pair, side, entryPrice, stopLoss, takeProfit, confidence, strategy }
 */
async function generateSignal(
  instrument,
  timeframe = 'M5',
  fastPeriod = 10,
  slowPeriod = 30
) {
  try {
    // 1. Fetch candles
    const candles = await marketProvider.getCandles(instrument, 200, timeframe);
    if (!candles || candles.length < slowPeriod + 1) {
      return null; // Not enough data
    }

    // Extract closing prices
    const closes = candles.map(c => parseFloat(c.mid.c));

    // 2. Calculate SMAs
    const smaFast = calculateSMA(closes, fastPeriod);
    const smaSlow = calculateSMA(closes, slowPeriod);

    // 3. Check crossover
    const lastIdx = closes.length - 1;
    const prevIdx = lastIdx - 1;

    const fastCurrent = smaFast[lastIdx];
    const fastPrev = smaFast[prevIdx];
    const slowCurrent = smaSlow[lastIdx];
    const slowPrev = smaSlow[prevIdx];

    let side = null;
    if (fastPrev <= slowPrev && fastCurrent > slowCurrent) {
      side = 'BUY';
    } else if (fastPrev >= slowPrev && fastCurrent < slowCurrent) {
      side = 'SELL';
    }

    if (!side) {
      return null; // No crossover
    }

    // 4. Get current price
    const currentPrice = await marketProvider.getCurrentPrice(instrument);

    // 5. Calculate stop loss and take profit using fixed pips or ATR
    // For simplicity, use fixed pips (adjust based on pair)
    const pipSize = getPipSize(instrument);
    const slPips = 50;   // Stop loss in pips
    const tpPips = 100;  // Take profit in pips

    let stopLoss, takeProfit;
    if (side === 'BUY') {
      stopLoss = currentPrice - slPips * pipSize;
      takeProfit = currentPrice + tpPips * pipSize;
    } else {
      stopLoss = currentPrice + slPips * pipSize;
      takeProfit = currentPrice - tpPips * pipSize;
    }

    // Round prices to 5 decimals
    const round = (v) => Math.round(v * 100000) / 100000;

    // 6. (Optional) Call AI service if enabled
    let aiSignal = null;
    if (process.env.ENABLE_AI === 'true') {
      aiSignal = await callAIService(instrument, candles, { smaFast, smaSlow });
    }

    // 7. Build signal
    const signal = {
      pair: instrument,
      side,
      entryPrice: round(currentPrice),
      stopLoss: round(stopLoss),
      takeProfit: round(takeProfit),
      confidence: aiSignal ? aiSignal.confidence : 75,
      strategy: aiSignal ? 'AI_Enhanced' : 'MA_Crossover',
      aiReason: aiSignal ? aiSignal.reason : null,
      timestamp: new Date().toISOString(),
    };

    return signal;
  } catch (error) {
    console.error('Strategy engine error:', error.message);
    return null;
  }
}

/**
 * Calculate Simple Moving Average (SMA) for an array of prices.
 * @param {number[]} prices - Array of prices.
 * @param {number} period - SMA period.
 * @returns {number[]} Array of SMA values (same length, with null for first period-1 entries).
 */
function calculateSMA(prices, period) {
  const result = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) {
        sum += prices[j];
      }
      result.push(sum / period);
    }
  }
  return result;
}

/**
 * Get pip size for a given instrument (simple approximation).
 * @param {string} instrument - e.g., 'EUR_USD'
 * @returns {number} Pip value in price units.
 */
function getPipSize(instrument) {
  if (instrument.includes('JPY')) {
    return 0.01; // JPY pairs have pip at 0.01
  }
  return 0.0001; // Most pairs
}

/**
 * Call external AI service (e.g., Python FastAPI).
 * This is a placeholder – the URL must be set in environment variables.
 * @param {string} instrument - Instrument name.
 * @param {Array} candles - Candle data.
 * @param {Object} indicators - Pre-calculated indicators.
 * @returns {Promise<Object|null>} AI signal with confidence and reason.
 */
async function callAIService(instrument, candles, indicators) {
  try {
    const aiUrl = process.env.AI_SERVICE_URL;
    if (!aiUrl) {
      console.warn('AI_SERVICE_URL not set, skipping AI call.');
      return null;
    }

    const response = await fetch(`${aiUrl}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instrument,
        candles: candles.slice(-100), // send last 100 candles
        indicators,
      }),
      timeout: 5000,
    });

    if (!response.ok) {
      console.error(`AI service error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    return {
      confidence: data.confidence || 50,
      reason: data.reason || 'AI analysis',
    };
  } catch (error) {
    console.error('AI call failed:', error.message);
    return null;
  }
}

module.exports = {
  generateSignal,
};
