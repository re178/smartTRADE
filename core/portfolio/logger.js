// src/core/portfolio/logger.js – Trade Logging Service

const Trade = require('../../models/Trade');
const eventBus = require('../../infrastructure/eventBus');

/**
 * Log a trade to MongoDB.
 * @param {Object} tradeData - Trade details.
 * @param {string} tradeData.pair - e.g., 'EUR_USD'
 * @param {string} tradeData.side - 'BUY' or 'SELL'
 * @param {number} tradeData.entryPrice - Entry price.
 * @param {number|null} tradeData.stopLoss - Stop loss (optional).
 * @param {number|null} tradeData.takeProfit - Take profit (optional).
 * @param {number} tradeData.lotSize - Lot size (units).
 * @param {string} tradeData.status - 'OPEN', 'CLOSED', etc.
 * @param {string|null} tradeData.oandaTradeId - OANDA trade ID.
 * @param {string|null} tradeData.oandaOrderId - OANDA order ID.
 * @param {string} tradeData.broker - Broker name (default: 'OANDA').
 * @param {string} tradeData.strategy - Strategy name.
 * @param {string} tradeData.notes - Additional notes.
 * @returns {Promise<Object>} The created trade document.
 */
async function logTrade({
  pair,
  side,
  entryPrice,
  stopLoss = null,
  takeProfit = null,
  lotSize,
  status = 'OPEN',
  oandaTradeId = null,
  oandaOrderId = null,
  broker = 'OANDA',
  strategy = 'Manual',
  notes = '',
}) {
  try {
    const trade = new Trade({
      pair,
      side,
      entryPrice,
      stopLoss,
      takeProfit,
      lotSize,
      status,
      oandaTradeId,
      oandaOrderId,
      broker,
      strategy,
      notes,
      openTime: new Date(),
    });

    const saved = await trade.save();

    // Emit event for any listeners
    eventBus.emit('trade.logged', {
      tradeId: saved._id,
      oandaTradeId: saved.oandaTradeId,
      pair: saved.pair,
      side: saved.side,
      status: saved.status,
      timestamp: saved.createdAt,
    });

    return saved;
  } catch (error) {
    console.error('Failed to log trade:', error.message);
    throw error;
  }
}

/**
 * Update an existing trade record (e.g., when closed).
 * @param {string} oandaTradeId - OANDA trade ID to identify the trade.
 * @param {Object} updates - Fields to update.
 * @param {string} updates.status - New status.
 * @param {number} updates.closePrice - Closing price.
 * @param {number} updates.pnl - Profit/Loss.
 * @param {Date} updates.closeTime - When closed.
 * @returns {Promise<Object>} Updated trade document.
 */
async function updateTrade(oandaTradeId, updates) {
  try {
    const trade = await Trade.findOneAndUpdate(
      { oandaTradeId },
      { ...updates, updatedAt: new Date() },
      { new: true }
    );
    if (!trade) {
      throw new Error(`Trade with oandaTradeId ${oandaTradeId} not found`);
    }

    eventBus.emit('trade.updated', {
      oandaTradeId,
      updates,
      timestamp: new Date(),
    });

    return trade;
  } catch (error) {
    console.error('Failed to update trade:', error.message);
    throw error;
  }
}

/**
 * Get trade by OANDA trade ID.
 * @param {string} oandaTradeId - OANDA trade ID.
 * @returns {Promise<Object|null>} Trade document or null.
 */
async function getTradeByOandaId(oandaTradeId) {
  return Trade.findOne({ oandaTradeId });
}

/**
 * Get all trades (with optional filters).
 * @param {Object} filter - MongoDB filter (e.g., { status: 'OPEN' }).
 * @param {Object} sort - Sort options (e.g., { createdAt: -1 }).
 * @param {number} limit - Max number of records.
 * @returns {Promise<Array>} Array of trade documents.
 */
async function getTrades(filter = {}, sort = { createdAt: -1 }, limit = 100) {
  return Trade.find(filter).sort(sort).limit(limit);
}

module.exports = {
  logTrade,
  updateTrade,
  getTradeByOandaId,
  getTrades,
};
