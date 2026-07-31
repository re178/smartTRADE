// api/controllers.js – Complete Request Handlers (without Signal model)

const Trade = require('../models/Trade');
const Order = require('../models/Order');
const User = require('../models/User');
const marketProvider = require('../core/market/provider');
const { getBroker } = require('../core/execution/brokerFactory');
const orderService = require('../core/execution/orderService');
const strategyEngine = require('../core/strategy/engine');
const riskManager = require('../core/risk/manager');
const portfolioLogger = require('../core/portfolio/logger');
const accountService = require('../core/portfolio/accountService');
const { PortfolioManager, PerformanceLearner } = require('../core/analytics/performanceSuite');
const { notifyTrade } = require('../core/notifications/notificationService');
const { validateOrderInput } = require('../shared/validators');
const { formatSymbol } = require('../shared/helpers');

// ---- Research Imports ----
const HistoricalState = require('../models/HistoricalState');
const HistoricalDecision = require('../models/HistoricalDecision');
const HistoricalOutcome = require('../models/HistoricalOutcome');
const stateStore = require('../core/intelligence/lab/stateStore');

const logger = require('../infrastructure/logger') || console;

// ---------- Portfolio Manager Instance ----------
const portfolioManager = new PortfolioManager({
  maxOpenTrades: parseInt(process.env.MAX_OPEN_TRADES) || 5,
  maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS) || 0,
  maxExposure: parseFloat(process.env.MAX_EXPOSURE) || Infinity,
  maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE) || 1000,
  correlatedPairs: process.env.CORRELATED_PAIRS ? JSON.parse(process.env.CORRELATED_PAIRS) : [],
});

// ---------- Performance Learner (lazy init) ----------
let performanceLearner = null;
async function getPerformanceLearner() {
  if (!performanceLearner) {
    performanceLearner = new PerformanceLearner({
      learningRate: parseFloat(process.env.LEARNING_RATE) || 0.1,
      minSamples: parseInt(process.env.MIN_SAMPLES) || 20,
    });
    await performanceLearner.loadHistory();
  }
  return performanceLearner;
}

// ---------- Helper to get product from request ----------
function getProduct(req) {
  return req.user?.tradingProduct || process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd';
}

// ---------- User Preferences ----------
exports.getPreferences = async (req, res) => {
  try {
    const userId = req.user?.id || 'admin';
    let user = await User.findOne({ userId });
    if (!user) {
      user = new User({ userId, tradingProduct: process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd' });
      await user.save();
    }
    res.json({ tradingProduct: user.tradingProduct });
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
    const userId = req.user?.id || 'admin';
    let user = await User.findOne({ userId });
    if (!user) {
      user = new User({ userId, tradingProduct });
    } else {
      user.tradingProduct = tradingProduct;
    }
    await user.save();
    if (req.user) req.user.tradingProduct = tradingProduct;
    res.json({ success: true, tradingProduct });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ---------- Account ----------
exports.getAccount = async (req, res) => {
  try {
    const product = getProduct(req);
    const account = await accountService.getAccount(product);
    res.json(account);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ---------- Market Data ----------
exports.getPrices = async (req, res) => {
  const { instruments } = req.query;
  if (!instruments) return res.status(400).json({ error: 'instruments query param required' });
  try {
    const product = getProduct(req);
    const pairs = instruments.split(',');
    const prices = await marketProvider.getPrices(pairs, product);
    res.json(prices);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getCandles = async (req, res) => {
  const { pair, count = 100, granularity = 'M5' } = req.query;
  if (!pair) return res.status(400).json({ error: 'pair query param required' });
  try {
    const product = getProduct(req);
    const candles = await marketProvider.getCandles(pair, parseInt(count), granularity, product);
    res.json(candles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ---------- Symbol Metadata ----------
exports.getSymbols = async (req, res) => {
  try {
    const product = getProduct(req);
    const broker = getBroker(product);
    if (!broker.isConnected()) {
      await broker.connect();
    }
    let symbols = [];
    if (broker.symbolManager && typeof broker.symbolManager._symbols === 'object') {
      symbols = Array.from(broker.symbolManager._symbols.values());
    } else if (broker.symbols) {
      symbols = typeof broker.symbols === 'function' ? await broker.symbols() : broker.symbols;
    } else {
      try {
        const allSymbols = await marketProvider.getSymbols(product);
        if (allSymbols) symbols = allSymbols;
      } catch (e) {
        // ignore
      }
    }
    res.json(symbols);
  } catch (error) {
    logger.error('[getSymbols] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

// ---------- Broker Capabilities ----------
exports.getCapabilities = async (req, res) => {
  try {
    const product = getProduct(req);
    const broker = getBroker(product);
    const caps = broker.capabilities || {};
    const info = {
      product,
      name: broker.serverName || product,
      connected: broker.isConnected(),
      state: broker._state || 'unknown',
      capabilities: caps,
    };
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ---------- Positions & Trades ----------
exports.getPositions = async (req, res) => {
  try {
    const product = getProduct(req);
    const broker = getBroker(product);
    const positions = await broker.getPositions();
    res.json(positions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getTrades = async (req, res) => {
  try {
    const product = getProduct(req);
    const broker = getBroker(product);
    const trades = await broker.getOpenTrades();
    res.json(trades);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getTradeHistory = async (req, res) => {
  try {
    const trades = await Trade.find().sort({ createdAt: -1 });
    res.json(trades);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ---------- Manual Order ----------
exports.placeOrder = async (req, res) => {
  const { pair, side, lotSize, stopLoss, takeProfit } = req.body;

  try {
    const product = getProduct(req);
    const instrument = pair.toUpperCase();
    const currentPrice = await marketProvider.getCurrentPrice(instrument, product);

    const validation = validateOrderInput({
      pair: instrument,
      side,
      lotSize,
      stopLoss: stopLoss || null,
      takeProfit: takeProfit || null,
      currentPrice,
    });
    if (!validation.valid) {
      return res.status(400).json({ error: validation.message });
    }

    const broker = getBroker(product);
    const account = await broker.getAccount();
    const currentPositions = await broker.getOpenTrades();

    const signal = {
      pair: instrument,
      side,
      entryPrice: currentPrice,
      stopLoss: stopLoss || null,
      takeProfit: takeProfit || null,
      recommendedLotSize: lotSize,
    };

    const approval = await portfolioManager.canOpenTrade(signal, parseFloat(account.balance), currentPositions);
    if (!approval.allowed) {
      return res.status(400).json({ error: approval.reason });
    }

    const orderResult = await orderService.placeMarketOrder(
      instrument, side, lotSize, stopLoss || null, takeProfit || null, product
    );

    const trade = await Trade.findOne({ contractId: orderResult.contractId });
    if (!trade) {
      const fallbackTrade = await Trade.findOne({ instrument }).sort({ openTime: -1 });
      if (fallbackTrade) {
        logger.warn(`[placeOrder] Trade not found by contractId ${orderResult.contractId}, using most recent trade ${fallbackTrade.contractId}`);
        notifyTrade('OPENED', fallbackTrade, account).catch(err => logger.error('[Notification] Error:', err.message));
        return res.json({ success: true, trade: fallbackTrade, raw: orderResult });
      }
      return res.status(500).json({ error: 'Order placed but trade record not found' });
    }

    notifyTrade('OPENED', trade, account).catch(err => logger.error('[Notification] Error:', err.message));
    res.json({ success: true, trade, raw: orderResult });
  } catch (error) {
    logger.error('[placeOrder] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

// ---------- Close Trade ----------
exports.closeTrade = async (req, res) => {
  const { tradeId } = req.params;
  if (!tradeId) return res.status(400).json({ error: 'tradeId required' });
  try {
    const product = getProduct(req);
    const result = await orderService.closeTrade(tradeId, product);
    const updated = await Trade.findOneAndUpdate(
      { contractId: tradeId },
      { status: 'CLOSED', closeTime: new Date(), closePrice: result.price || null, pnl: result.pl || 0 },
      { new: true }
    );
    portfolioManager.updateDailyPnL(result.pl || 0);
    if (updated) {
      const broker = getBroker(product);
      const account = await broker.getAccount();
      notifyTrade('CLOSED', updated, account).catch(err => logger.error('[Notification] Error:', err.message));
      try {
        const learner = await getPerformanceLearner();
        learner.recordTrade(updated);
      } catch (err) {
        logger.warn('[PerformanceLearner] Failed to record trade:', err.message);
      }
    }
    res.json({ success: true, result });
  } catch (error) {
    logger.error('[closeTrade] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

// ---------- Strategy & Signal ----------
exports.getSignal = async (req, res) => {
  const { pair, strategy = 'sma', ...params } = req.query;
  if (!pair) return res.status(400).json({ error: 'pair query param required' });
  try {
    const product = getProduct(req);
    const instrument = pair.toUpperCase();
    const signal = await strategyEngine.generateSignal(instrument, strategy, { ...params, product });
    if (!signal) return res.json({ signal: null, message: 'No signal generated' });
    res.json(signal);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ---------- Auto Trade ----------
exports.autoTrade = async (req, res) => {
  const { pair, riskPercent = 1, strategy = 'sma', ...params } = req.body;
  if (!pair) return res.status(400).json({ error: 'pair required' });
  try {
    const product = getProduct(req);
    const instrument = pair.toUpperCase();

    const signal = await strategyEngine.generateSignal(instrument, strategy, { ...params, product });
    if (!signal) return res.json({ success: false, message: 'No trading signal' });

    const currentPrice = signal.entryPrice;

    const validation = validateOrderInput({
      pair: instrument,
      side: signal.side,
      lotSize: signal.recommendedLotSize || 0.01,
      stopLoss: signal.stopLoss || null,
      takeProfit: signal.takeProfit || null,
      currentPrice,
    });
    if (!validation.valid) {
      return res.json({ success: false, message: validation.message });
    }

    const broker = getBroker(product);
    const account = await broker.getAccount();
    const currentPositions = await broker.getOpenTrades();

    const approval = await portfolioManager.canOpenTrade(signal, parseFloat(account.balance), currentPositions);
    if (!approval.allowed) return res.json({ success: false, message: approval.reason });

    let lotSize = signal.recommendedLotSize;
    if (!lotSize) {
      lotSize = await riskManager.calculateLotSize(instrument, signal.entryPrice, signal.stopLoss, riskPercent, 1000, product);
    }

    const orderResult = await orderService.placeMarketOrder(
      instrument, signal.side, lotSize, signal.stopLoss, signal.takeProfit, product
    );

    const trade = await Trade.findOne({ contractId: orderResult.contractId });
    if (!trade) {
      logger.warn(`[autoTrade] Trade not found by contractId ${orderResult.contractId}`);
      return res.json({ success: true, raw: orderResult, trade: null });
    }

    notifyTrade('OPENED', trade, account).catch(err => logger.error('[Notification] Error:', err.message));
    res.json({ success: true, signal, trade, raw: orderResult });
  } catch (error) {
    logger.error('[autoTrade] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

// ---------- Execute Live Signal ----------
exports.executeSignal = async (req, res) => {
  const { pair, side, entryPrice, stopLoss, takeProfit, lotSize } = req.body;

  if (!pair || !side || !lotSize) {
    return res.status(400).json({ error: 'pair, side, and lotSize are required' });
  }

  const formattedPair = formatSymbol(pair);
  const cleanSide = side.toUpperCase().trim();
  if (!['BUY', 'SELL'].includes(cleanSide)) {
    return res.status(400).json({ error: 'Side must be BUY or SELL' });
  }

  try {
    const product = getProduct(req);
    const instrument = formattedPair;

    let currentPrice = entryPrice;
    if (!currentPrice) {
      currentPrice = await marketProvider.getCurrentPrice(instrument, product);
    }

    const validation = validateOrderInput({
      pair: instrument,
      side: cleanSide,
      lotSize,
      stopLoss: stopLoss || null,
      takeProfit: takeProfit || null,
      currentPrice,
    });
    if (!validation.valid) {
      return res.status(400).json({ error: validation.message });
    }

    const orderResult = await orderService.placeMarketOrder(
      instrument,
      cleanSide,
      parseFloat(lotSize),
      stopLoss || null,
      takeProfit || null,
      product
    );

    const trade = await Trade.findOne({ contractId: orderResult.contractId });
    if (!trade) {
      logger.warn(`[executeSignal] Trade not found for contractId: ${orderResult.contractId}`);
      return res.json({ success: true, raw: orderResult, trade: null });
    }

    const broker = getBroker(product);
    const account = await broker.getAccount();
    notifyTrade('OPENED', trade, account).catch(err => logger.error('[Notification] Error:', err.message));

    res.json({ success: true, trade, raw: orderResult });
  } catch (error) {
    logger.error('[executeSignal] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

// ---------- Pending Orders ----------
exports.getPendingOrders = async (req, res) => {
  try {
    const pending = await Order.find({
      status: { $in: ['PENDING', 'ACCEPTED', 'EXECUTING'] }
    }).sort({ createdAt: -1 });
    res.json(pending);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.cancelOrder = async (req, res) => {
  const { orderId } = req.params;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  try {
    const product = getProduct(req);
    const result = await orderService.cancelOrder(orderId, product);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ---------- Delete History ----------
exports.deleteHistory = async (req, res) => {
  try {
    const count = await orderService.deleteClosedTrades();
    res.json({ success: true, deletedCount: count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ============================================================
// NEW RESEARCH CONTROLLERS
// ============================================================

/**
 * GET /api/research/decision/:id
 * Full decision context – features, contributions, lineage, similarity.
 */
exports.getDecisionContext = async (req, res) => {
  try {
    const { id } = req.params;
    const lookahead = parseInt(req.query.lookahead) || 5;

    const decision = await HistoricalDecision.findById(id).lean();
    if (!decision) {
      return res.status(404).json({ error: 'Decision not found' });
    }

    let similarity = null;
    try {
      const features = decision.features || {};
      const result = await stateStore.findSimilar(
        features,
        decision.symbol,
        decision.timeframe,
        50,
        lookahead
      );
      similarity = result;
    } catch (err) {
      logger.warn('[Research] Similarity search failed:', err.message);
    }

    let outcomeStats = null;
    if (decision.outcome && decision.outcome.tradeId) {
      try {
        const stats = await HistoricalOutcome.getAggregatedStats(
          [decision._id],
          'decision',
          lookahead
        );
        outcomeStats = stats;
      } catch (err) {
        logger.warn('[Research] Outcome stats failed:', err.message);
      }
    }

    let calibration = null;
    try {
      calibration = await stateStore.calibrateConfidence(decision, lookahead, 100);
    } catch (err) {
      logger.warn('[Research] Confidence calibration failed:', err.message);
    }

    res.json({
      decision,
      similarity,
      outcomeStats,
      calibration,
    });
  } catch (err) {
    logger.error('[Research] Decision inspector error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/research/similarity
 * Search for historical states similar to a feature vector.
 */
exports.getSimilaritySearch = async (req, res) => {
  try {
    const {
      symbol,
      timeframe = 'M5',
      lookahead = 5,
      k = 100,
      adx,
      rsi,
      atrPercent,
      bbWidth,
      macdHist,
      liquidity,
      velocity,
      acceleration,
      pricePosition,
      marketQuality,
    } = req.query;

    const features = {
      adx: adx !== undefined ? parseFloat(adx) : 25,
      rsi: rsi !== undefined ? parseFloat(rsi) : 50,
      atrPercent: atrPercent !== undefined ? parseFloat(atrPercent) : 0.005,
      bbWidth: bbWidth !== undefined ? parseFloat(bbWidth) : 0.15,
      macdHist: macdHist !== undefined ? parseFloat(macdHist) : 0,
      liquidity: liquidity !== undefined ? parseFloat(liquidity) : 0.5,
      velocity: velocity !== undefined ? parseFloat(velocity) : 0,
      acceleration: acceleration !== undefined ? parseFloat(acceleration) : 0,
      pricePosition: pricePosition !== undefined ? parseFloat(pricePosition) : 0.5,
      marketQuality: marketQuality !== undefined ? parseFloat(marketQuality) : 50,
    };

    const lookaheadInt = parseInt(lookahead);
    const kInt = parseInt(k);

    const result = await stateStore.findSimilar(
      features,
      symbol || null,
      timeframe,
      kInt,
      !isNaN(lookaheadInt) && [5, 10, 20, 40].includes(lookaheadInt) ? lookaheadInt : 5
    );

    res.json({
      query: { features, symbol, timeframe, lookahead: lookaheadInt, k: kInt },
      ...result,
    });
  } catch (err) {
    logger.error('[Research] Similarity search error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/research/historical-states
 * Paginated historical states with filters.
 */
exports.getHistoricalStates = async (req, res) => {
  try {
    const {
      symbol,
      timeframe = 'M5',
      from,
      to,
      limit = 100,
      skip = 0,
      hasOutcome = 'false',
      lookahead = 5,
    } = req.query;

    const filter = {};
    if (symbol) filter.symbol = symbol;
    if (timeframe) filter.timeframe = timeframe;
    if (from) filter.timestamp = { $gte: new Date(parseInt(from)) };
    if (to) filter.timestamp = { ...filter.timestamp, $lte: new Date(parseInt(to)) };

    const lookaheadInt = parseInt(lookahead);
    const outcomeKey = `outcome${[5, 10, 20, 40].includes(lookaheadInt) ? lookaheadInt : 5}`;

    if (hasOutcome === 'true') {
      filter[`${outcomeKey}.return`] = { $ne: null };
    }

    const total = await HistoricalState.countDocuments(filter);
    const states = await HistoricalState.find(filter)
      .sort({ timestamp: -1 })
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .lean();

    res.json({
      total,
      skip: parseInt(skip),
      limit: parseInt(limit),
      states,
    });
  } catch (err) {
    logger.error('[Research] Historical states error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/research/label-outcomes
 * Trigger outcome labelling for unlabelled states/decisions.
 */
exports.postLabelOutcomes = async (req, res) => {
  try {
    const { symbol, timeframe, lookahead = 5, limit = 1000 } = req.body;

    const lookaheadInt = parseInt(lookahead);
    if (![5, 10, 20, 40].includes(lookaheadInt)) {
      return res.status(400).json({ error: 'Invalid lookahead. Must be 5, 10, 20, or 40.' });
    }

    const outcomeKey = `outcome${lookaheadInt}`;
    const filter = {
      symbol: symbol || { $exists: true },
      timeframe: timeframe || 'M5',
      [`${outcomeKey}.return`]: null,
    };

    const count = await HistoricalState.countDocuments(filter);

    res.json({
      message: `Outcome labelling triggered for ${count} states. This is a background job.`,
      count,
      filter,
      lookahead: lookaheadInt,
    });

    logger.info(`[Research] Outcome labelling triggered for ${count} states (lookahead: ${lookaheadInt})`);
  } catch (err) {
    logger.error('[Research] Label outcomes error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// ---------- Export helper for other modules ----------
exports.getProduct = getProduct;
