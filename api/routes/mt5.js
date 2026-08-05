// api/routes/mt5.js

const express = require('express');
const router = express.Router();
const logger = require('../../infrastructure/logger') || console;

// Import Mongoose models
const Mt5Command = require('../../models/Mt5Command');
const Mt5CommandResult = require('../../models/Mt5CommandResult');
const Mt5Account = require('../../models/Mt5Account');
const Mt5Position = require('../../models/Mt5Position');
const Mt5Price = require('../../models/Mt5Price');
const Mt5Heartbeat = require('../../models/Mt5Heartbeat');
const Trade = require('../../models/Trade');

// ---- COGNITIVE: import priceBuffer ----
const priceBuffer = require('../../core/data/priceBuffer');

// ---- IMPORT selfLearner for decision outcome updates ----
const selfLearner = require('../../core/learning/learner');

// ---------- Authentication ----------
const API_KEY = process.env.MT5_API_KEY || 'change-me-in-production';

const authenticate = (req, res, next) => {
  const key = req.headers['x-api-key'];
  if (key && key === API_KEY) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
};

// Apply authentication to all routes
router.use(authenticate);

// ---------- Utility ----------
function generateCommandId() {
  return `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ---------- Command Endpoints ----------
router.post('/orders/command', async (req, res) => {
  try {
    const command = req.body;
    if (!command.commandId) {
      command.commandId = generateCommandId();
    }
    command.state = 'QUEUED';
    await Mt5Command.findOneAndUpdate(
      { commandId: command.commandId },
      command,
      { upsert: true, new: true }
    );
    logger.info(`[MT5] Command stored: ${command.commandId}`);
    res.status(201).json({ commandId: command.commandId, status: 'queued' });
  } catch (err) {
    logger.error('[MT5] Error storing command:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/orders/claim', async (req, res) => {
  try {
    const { commandId } = req.body;
    if (!commandId) {
      return res.status(400).json({ error: 'Missing commandId' });
    }
    const command = await Mt5Command.findOneAndUpdate(
      { commandId, state: 'QUEUED' },
      {
        $set: {
          state: 'PROCESSING',
          processingStartedAt: new Date(),
          lastAttemptAt: new Date(),
        },
        $inc: { attempts: 1 },
      },
      { new: true }
    );
    if (command) {
      res.json(command);
    } else {
      res.status(404).json({ error: 'Command not available for claiming' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/orders/pending', async (req, res) => {
  try {
    const commands = await Mt5Command.find({ state: 'QUEUED' }).lean();
    res.json(commands);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- ENHANCED: POST /orders/result (handles PARTIAL, MODIFY, CLOSE) ----------
router.post('/orders/result', async (req, res) => {
  try {
    const result = req.body;
    const { commandId, success, ticket, deal, price, symbol, side, time, volume } = result;
    if (!commandId) {
      return res.status(400).json({ error: 'Missing commandId' });
    }

    // 1. Save the result (existing behaviour)
    await Mt5CommandResult.findOneAndUpdate(
      { commandId },
      result,
      { upsert: true, new: true }
    );

    // 2. Update command state
    const successFlag = success === true;
    await Mt5Command.findOneAndUpdate(
      { commandId },
      {
        $set: {
          state: successFlag ? 'COMPLETED' : 'FAILED',
          error: successFlag ? null : (result.error || 'Execution failed'),
        },
      }
    );
    logger.info(`[MT5] Result stored for ${commandId}, success=${successFlag}`);

    // 3. Get the original command
    const command = await Mt5Command.findOne({ commandId }).lean();
    const action = command?.action;

    if (!successFlag) {
      return res.status(201).json({ status: 'accepted' });
    }

    // 4. Process by action type
    if (action === 'CLOSE') {
      // ----- CLOSE: finalise trade -----
      const trade = await Trade.findOne({ contractId: ticket });
      if (trade && trade.status !== 'CLOSED') {
        trade.status = 'CLOSED';
        trade.closePrice = price;
        trade.dealId = deal;
        trade.closeTime = new Date(time ? time * 1000 : Date.now());
        trade.pendingClose = false;
        if (trade.openPrice && trade.lotSize) {
          const multiplier = trade.side && trade.side.toUpperCase() === 'BUY' ? 1 : -1;
          trade.realizedProfit = (price - trade.openPrice) * trade.lotSize * multiplier;
          trade.pnl = trade.realizedProfit;
        }
        await trade.save();
        logger.info(`[MT5] Trade ${ticket} finalized as CLOSED at ${price}`);
        if (trade.decisionId) {
          try {
            await selfLearner.updateDecisionOutcome(trade.decisionId, trade);
          } catch (err) {
            logger.warn(`[MT5] Failed to update decision outcome: ${err.message}`);
          }
        }
      }
    } else if (action === 'MODIFY') {
      // ----- MODIFY: update SL/TP -----
      const trade = await Trade.findOne({ contractId: ticket });
      if (trade && trade.status === 'OPEN') {
        if (command.stopLoss !== undefined) trade.stopLoss = command.stopLoss;
        if (command.takeProfit !== undefined) trade.takeProfit = command.takeProfit;
        await trade.save();
        logger.info(`[MT5] Trade ${ticket} SL/TP updated`);
      }
    } else if (action === 'PARTIAL') {
      // ----- PARTIAL: reduce lotSize (the 'volume' field from EA is the NEW remaining volume) -----
      const trade = await Trade.findOne({ contractId: ticket });
      if (trade && trade.status === 'OPEN') {
        // The EA sends back the new remaining volume in the 'volume' field.
        // If volume is not present, we assume it's a full close (should not happen for PARTIAL).
        if (volume !== undefined && volume > 0) {
          trade.lotSize = volume;
          await trade.save();
          logger.info(`[MT5] Trade ${ticket} lotSize reduced to ${volume}`);
        } else {
          // If volume is 0 or missing, treat as full close.
          trade.status = 'CLOSED';
          trade.closePrice = price || trade.currentPrice;
          trade.closeTime = new Date();
          trade.pendingClose = false;
          if (trade.openPrice && trade.lotSize) {
            const multiplier = trade.side && trade.side.toUpperCase() === 'BUY' ? 1 : -1;
            trade.realizedProfit = (trade.closePrice - trade.openPrice) * trade.lotSize * multiplier;
            trade.pnl = trade.realizedProfit;
          }
          await trade.save();
          logger.info(`[MT5] Trade ${ticket} closed after partial reduction`);
        }
      }
    }

    res.status(201).json({ status: 'accepted' });
  } catch (err) {
    logger.error('[MT5] Error in /orders/result:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/orders/result/:commandId', async (req, res) => {
  try {
    const { commandId } = req.params;
    const result = await Mt5CommandResult.findOne({ commandId }).lean();
    if (result) {
      res.json(result);
    } else {
      res.status(404).json({ error: 'Result not found' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Account ----------
router.post('/account/status', async (req, res) => {
  try {
    const status = req.body;
    logger.info(`[MT5] POST account/status received: login=${status.login}, balance=${status.balance}`);

    const saved = await Mt5Account.findOneAndUpdate(
      { login: status.login },
      {
        ...status,
        updatedAt: new Date(),
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
      }
    );

    if (saved) {
      logger.info('[MT5] Saved account:', JSON.stringify(saved, null, 2));
      res.status(201).json({ status: 'accepted', account: saved });
    } else {
      logger.error('[MT5] Account save returned null');
      res.status(500).json({ error: 'Failed to save account' });
    }
  } catch (err) {
    logger.error('[MT5] Error saving account status:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/account/status', async (req, res) => {
  try {
    let account = await Mt5Account.findOne().sort({ updatedAt: -1 }).lean();
    if (!account) {
      account = {
        login: 0,
        balance: 0,
        equity: 0,
        margin: 0,
        free_margin: 0,
        profit: 0,
        currency: 'USD',
        server: 'Unknown',
        leverage: 0,
        marginLevel: 0,
        tradeMode: 0,
        company: '',
        accountName: '',
        status: 'offline',
        timestamp: Date.now(),
      };
    }
    logger.info('[MT5] GET account/status:', JSON.stringify(account, null, 2));
    res.json(account);
  } catch (err) {
    logger.error('[MT5] GET account/status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- ENHANCED: POST /positions with pending-close finalisation ----------
router.post('/positions', async (req, res) => {
  try {
    const { login, positions, timestamp, magic } = req.body;

    // 1. Store raw snapshot in Mt5Position (existing behavior)
    await Mt5Position.deleteMany({ login });
    if (positions && positions.length) {
      const docs = positions.map(p => ({ ...p, login, updatedAt: new Date() }));
      await Mt5Position.insertMany(docs);
    }
    logger.debug(`[MT5] Positions updated for login ${login}: ${positions?.length || 0} open`);

    // 2. Synchronize Trade collection
    const incomingTickets = new Set(positions.map(p => p.ticket));

    for (const pos of positions) {
      let trade = await Trade.findOne({ contractId: pos.ticket });

      if (!trade) {
        trade = new Trade({
          contractId: pos.ticket,
          instrument: pos.symbol,
          side: pos.type === 'BUY' ? 'buy' : 'sell',
          lotSize: pos.volume,
          openPrice: pos.price,
          openTime: new Date(pos.open_time * 1000),
          status: 'OPEN',
          magic: pos.magic || magic,
          comment: pos.comment || '',
          stopLoss: pos.stop_loss || 0,
          takeProfit: pos.take_profit || 0,
          swap: pos.swap || 0,
          commission: pos.commission || 0,
          margin: pos.margin || 0,
          login: login,
          pendingClose: false,
          floatingProfit: pos.profit || 0,
          currentPrice: pos.current_price || pos.price,
        });
      } else {
        trade.currentPrice = pos.current_price;
        trade.floatingProfit = pos.profit;
        trade.lotSize = pos.volume;
        trade.pendingClose = false;
        if (trade.status === 'OPEN') {
          trade.stopLoss = pos.stop_loss || 0;
          trade.takeProfit = pos.take_profit || 0;
          trade.swap = pos.swap || 0;
          trade.commission = pos.commission || 0;
          trade.margin = pos.margin || 0;
          trade.magic = pos.magic || magic;
          trade.comment = pos.comment || '';
          trade.login = login;
        }
      }
      await trade.save();
    }

    // 3. Mark open trades missing from incoming as pendingClose
    const openTrades = await Trade.find({ status: 'OPEN', login: login });
    for (const trade of openTrades) {
      if (!incomingTickets.has(trade.contractId)) {
        trade.pendingClose = true;
        await trade.save();
        logger.debug(`[MT5] Marked trade ${trade.contractId} as pendingClose`);
      }
    }

    // 4. NEW: Finalise pendingClose trades using last known price
    const pendingTrades = await Trade.find({ status: 'OPEN', pendingClose: true, login: login });
    if (pendingTrades.length > 0) {
      logger.info(`[MT5] Finalising ${pendingTrades.length} pending close trades...`);
      for (const trade of pendingTrades) {
        try {
          // Use latest price from Mt5Price (most recent) or fallback to trade.currentPrice
          const priceDoc = await Mt5Price.findOne({ symbol: trade.instrument }).sort({ time: -1 });
          const closePrice = priceDoc ? (trade.side.toUpperCase() === 'BUY' ? priceDoc.bid : priceDoc.ask) : trade.currentPrice;
          if (closePrice && trade.openPrice) {
            const multiplier = trade.side && trade.side.toUpperCase() === 'BUY' ? 1 : -1;
            const pnl = (closePrice - trade.openPrice) * trade.lotSize * multiplier;
            trade.status = 'CLOSED';
            trade.closePrice = closePrice;
            trade.closeTime = new Date();
            trade.realizedProfit = pnl;
            trade.pnl = pnl;
            trade.pendingClose = false;
            await trade.save();
            logger.info(`[MT5] Finalised pending close trade ${trade.contractId} at ${closePrice} with P&L ${pnl}`);
            // Emit trade.closed event for dashboard and performance monitor
            const eventBus = require('../../infrastructure/eventBus');
            eventBus.emit('trade.closed', { contractId: trade.contractId, price: closePrice, pl: pnl });
          } else {
            logger.warn(`[MT5] Could not finalise trade ${trade.contractId} – no price data available.`);
          }
        } catch (err) {
          logger.error(`[MT5] Failed to finalise pending close trade ${trade.contractId}:`, err.message);
        }
      }
    }

    res.status(201).json({ status: 'accepted' });
  } catch (err) {
    logger.error('[MT5] Error in /positions:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/positions', async (req, res) => {
  try {
    const positions = await Mt5Position.find().lean();
    res.json({ positions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Heartbeat ----------
router.post('/heartbeat', async (req, res) => {
  try {
    const { login, status, timestamp } = req.body;
    await Mt5Heartbeat.findOneAndUpdate(
      { login },
      { login, status, lastHeartbeat: timestamp || Date.now() },
      { upsert: true, new: true }
    );
    logger.debug(`[MT5] Heartbeat received: login=${login}, status=${status}`);
    res.status(201).json({ status: 'accepted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/heartbeat', async (req, res) => {
  try {
    const heartbeat = await Mt5Heartbeat.findOne().sort({ updatedAt: -1 }).lean();
    res.json(heartbeat || { online: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Price Feed (with cognitive integration) ----------
router.post('/price', async (req, res) => {
  try {
    const priceData = req.body;
    if (!priceData.symbol) {
      return res.status(400).json({ error: 'Missing symbol' });
    }

    const timeMs = priceData.time ? Number(priceData.time) * 1000 : Date.now();
    priceBuffer.update(priceData.symbol, priceData.bid, priceData.ask, timeMs);

    await Mt5Price.findOneAndUpdate(
      { symbol: priceData.symbol },
      priceData,
      { upsert: true, new: true }
    );

    logger.debug(`[MT5] Price updated for ${priceData.symbol} (time: ${timeMs})`);
    res.status(201).json({ status: 'accepted' });
  } catch (err) {
    logger.error('[MT5] Price error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/price/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const lookupSymbol = symbol.replace(/_/g, '');
    let price = await Mt5Price.findOne({ symbol: lookupSymbol }).lean();
    if (!price) {
      price = await Mt5Price.findOne({ symbol }).lean();
    }
    if (price) {
      res.json(price);
    } else {
      res.status(404).json({
        symbol: lookupSymbol,
        bid: 0,
        ask: 0,
        spread: 0,
        error: 'Price not yet available from EA'
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Trade by ticket ----------
router.get('/trade/:ticket', async (req, res) => {
  try {
    const { ticket } = req.params;
    const position = await Mt5Position.findOne({ ticket: Number(ticket) }).lean();
    if (position) {
      return res.json(position);
    }
    res.status(404).json({ error: 'Trade not found' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- UPDATED: History (with field mapping for dashboard) ----------
router.get('/history', async (req, res) => {
  try {
    const { from, to, symbol } = req.query;
    const filter = { status: 'CLOSED' };
    if (symbol) filter.instrument = symbol;
    if (from) filter.closeTime = { $gte: new Date(Number(from)) };
    if (to) filter.closeTime = { ...filter.closeTime, $lte: new Date(Number(to)) };

    const trades = await Trade.find(filter).sort({ closeTime: -1 }).lean();

    // Map fields to dashboard expectations
    const history = trades.map(t => ({
      pair: t.instrument,
      side: t.side,
      entry: t.openPrice,
      exit: t.closePrice,
      lot: t.lotSize,
      pl: t.realizedProfit || t.pnl || 0,
      status: t.status,
      date: t.closeTime,
      // keep original fields for any other consumer
      ...t,
    }));

    res.json({ history });
  } catch (err) {
    logger.warn('[MT5] History error:', err.message);
    res.json({ history: [] });
  }
});

// ---------- Sync (EA startup) ----------
router.post('/sync', async (req, res) => {
  const { login, status } = req.body;
  logger.info(`[MT5] Sync received: login=${login}, status=${status}`);
  res.status(201).json({ status: 'synced' });
});

// ---------- GET /api/mt5/candles ----------
router.get('/candles', async (req, res) => {
  try {
    const { symbol, count = 200, timeframe = 'M5' } = req.query;
    if (!symbol) {
      return res.status(400).json({ error: 'symbol query param required' });
    }

    const lookupSymbol = symbol.replace(/_/g, '');
    const candleHistory = require('../../core/data/candleHistory');
    let candles = await candleHistory.getHistory(lookupSymbol, timeframe, parseInt(count));
    if (!candles || candles.length === 0) {
      candles = await candleHistory.getHistory(symbol, timeframe, parseInt(count));
    }

    if (candles && candles.length > 0) {
      const formatted = candles.map(c => ({
        time: Math.floor(new Date(c.time).getTime() / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume || 0,
      }));
      return res.json(formatted);
    }
    res.json([]);
  } catch (err) {
    logger.error('[MT5] GET /candles error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Historical candle ingestion ----------
router.post('/historical', async (req, res) => {
  try {
    const { symbol, timeframe, candles } = req.body;
    if (!symbol || !timeframe || !candles || !Array.isArray(candles)) {
      return res.status(400).json({ error: 'Missing required fields (symbol, timeframe, candles array)' });
    }

    const candleHistory = require('../../core/data/candleHistory');
    let stored = 0;
    for (const c of candles) {
      const timeMs = (c.time && c.time < 1e12) ? c.time * 1000 : c.time;
      await candleHistory.store({
        symbol,
        timeframe,
        time: timeMs,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.tick_volume || 0,
        source: 'broker',
      });
      stored++;
    }
    logger.info(`[MT5] Stored ${stored} historical candles for ${symbol}:${timeframe}`);
    res.status(201).json({ status: 'accepted', stored });
  } catch (err) {
    logger.error('[MT5] Historical ingest error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
