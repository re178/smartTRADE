// api/controllers.js – Complete Request Handlers (with defensive candles + resilient close)
//
// [FIX-STRAT] placeOrder / autoTrade / executeSignal now destructure and
//   pass through `strategy`, `regimeCode`, and `entryThesis` to
//   orderService.placeMarketOrder. Previously these were silently dropped
//   from req.body, so Trade.strategy was null for every manual and
//   live-signal trade — breaking strategy performance attribution.
//
// [FIX-BROKER-ERR] handleOrderError is now async and reconciles before
//   returning BROKER_ERROR. On any non-validation broker error, it:
//     1. Waits RECONCILE_GRACE_MS (2s) for Deriv to settle.
//     2. Busts the broker portfolio cache.
//     3. Fetches open contracts.
//     4. Matches against {symbol, side, purchasePrice within $0.01,
//        openTime within lookback window}.
//     5. On match → returns CONFIRMED_RECORD_FAILED (accurate).
//     6. On no match → returns BROKER_ERROR (accurate).
//   The frontend's "purchase may have completed" warning now only
//   fires when no contract actually exists.
//
// All callers of handleOrderError now pass a `context` object with
// { product, symbol, side, stake, lookbackMs } so reconciliation has
// the criteria to match against.

const Trade = require('../models/Trade');
const Order = require('../models/Order');
const User = require('../models/User');
const marketProvider = require('../core/market/provider');
const { getBroker } = require('../core/execution/brokerFactory');
const orderService = require('../core/execution/orderService');
const strategyEngine = require('../core/strategy/engine');
const riskManager = require('../core/risk/manager');
const accountService = require('../core/portfolio/accountService');
const { PortfolioManager, PerformanceLearner } = require('../core/analytics/performanceSuite');
const { notifyTrade } = require('../core/notifications/notificationService');
const { validateOrderInput } = require('../shared/validators');
const { formatSymbol } = require('../shared/helpers');
const logger = require('../infrastructure/logger') || console;

const { generateReport } = require('../core/reporting/reportGenerator');
const { broadcastToDashboards } = require('../server');

// [FIX-BROKER-ERR] Reconcile parameters — mirror broker.js and
// contractService.js so all three reconcilers are in lockstep.
const RECONCILE_GRACE_MS = 2000;
const RECONCILE_LOOKBACK_MS = 60_000;
const RECONCILE_STAKE_TOLERANCE = 0.01;

const portfolioManager = new PortfolioManager({
  maxOpenTrades: parseInt(process.env.MAX_OPEN_TRADES) || 5,
  maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS) || 0,
  maxExposure: parseFloat(process.env.MAX_EXPOSURE) || Infinity,
  maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE) || 1000,
  correlatedPairs: process.env.CORRELATED_PAIRS ? JSON.parse(process.env.CORRELATED_PAIRS) : [],
});

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

function getProduct(req) {
  if (req.user && req.user.tradingProduct) return req.user.tradingProduct;
  return process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd';
}

function enhanceAccount(accountData, broker) {
  if (!accountData) return accountData;
  let tradeMode = 0;
  let server = 'Unknown';
  if (broker && broker._account) {
    tradeMode = broker._account.is_virtual !== undefined ? (broker._account.is_virtual ? 1 : 0) : 0;
    server = broker._account.landing_company_name || 'Unknown';
  }
  return { ...accountData, tradeMode, server };
}

const PRE_PURCHASE_VALIDATION_PATTERNS = [
  /^Multiplier must be/, /^Duration must be/, /^Stake must be/,
  /^Knockout must be/, /^Take profit must be/, /^Portfolio risk rejection/,
  /^Auto[- ]trade rejected/, /^Either stake/, /^Order units must be/,
  /^Unknown instrument/, /^Invalid multiplier/,
];

function classifyOrderOutcome(orderResult) {
  const rec = orderResult && orderResult.recording;
  if (!rec) return 'FILLED';
  const orderOk = !rec.order || rec.order.ok !== false;
  const tradeOk = !rec.trade || rec.trade.ok !== false;
  return (orderOk && tradeOk) ? 'FILLED' : 'CONFIRMED_RECORD_FAILED';
}

function respondConfirmedButUnrecorded(res, contractId, details, reason) {
  logger.warn(`[controllers] Purchase CONFIRMED for ${contractId || '<unknown>'} but not recorded: ${reason}`);
  return res.status(200).json({
    success: true,
    status: 'CONFIRMED_RECORD_FAILED',
    contractId: contractId ? String(contractId) : null,
    ...details,
    warning: 'Deriv confirmed the purchase. The database record could not be written. DO NOT retry.',
  });
}

// [FIX-BROKER-ERR] Reconcile a post-buy error against the live portfolio.
// Match criteria (identical to broker._reconcileOrphanBuy and
// contractService._reconcileBuy):
//   • same normalized symbol
//   • same side (BUY/SELL), if determinable
//   • purchasePrice within $0.01 of intended stake
//   • openTime >= (Date.now() - lookbackMs)
// Returns the matching normalized position, or null.
async function _reconcilePostBuyError(context) {
  const { product, symbol, side, stake, lookbackMs = RECONCILE_LOOKBACK_MS } = context;
  if (!symbol) return null;

  // Give Deriv time to settle a possibly-succeeded buy.
  await new Promise(r => setTimeout(r, RECONCILE_GRACE_MS));

  let broker;
  try { broker = getBroker(product); }
  catch (err) {
    logger.warn(`[controllers] reconcile: broker lookup failed: ${err.message}`);
    return null;
  }

  // Bust the cache so we see the post-buy portfolio, not a 3s-stale snapshot.
  if (broker._portfolioCache) broker._portfolioCache.at = 0;

  let positions;
  try { positions = await broker.getOpenTrades(); }
  catch (err) {
    logger.warn(`[controllers] reconcile: portfolio fetch failed: ${err.message}`);
    return null;
  }

  const targetSymbol = String(symbol).replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
  const expectedSide = (side === 'BUY' || side === 'SELL') ? side : null;
  const stakeNum = Math.abs(Number(stake));
  const minOpenTime = Date.now() - lookbackMs;

  const candidates = positions.filter(p => {
    const pSym = String(p.instrument || '').replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
    if (pSym !== targetSymbol) return false;

    if (expectedSide && p.side && p.side !== 'UNKNOWN' && p.side !== expectedSide) return false;

    if (Number.isFinite(stakeNum) && stakeNum > 0 && p.purchasePrice != null) {
      if (Math.abs(Number(p.purchasePrice) - stakeNum) > RECONCILE_STAKE_TOLERANCE) return false;
    }

    if (p.openTime && p.openTime < minOpenTime) return false;
    return true;
  });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.openTime || 0) - (a.openTime || 0));
  return candidates[0];
}

// [FIX-BROKER-ERR] handleOrderError is async and reconciles before
// returning BROKER_ERROR. The reconciliation only runs for errors that
// are neither pre-purchase validation nor already-confirmed execution —
// those two categories have known outcomes and don't need the check.
async function handleOrderError(res, error, logTag, context = {}) {
  logger.error(`[${logTag}] Error:`, error.message);

  // 1. Execution already confirmed — respond immediately.
  if (error.executionConfirmed === true || error.contractId) {
    return respondConfirmedButUnrecorded(res, error.contractId || null, {
      strategy: context.strategy || null,
      regimeCode: context.regimeCode || null,
    }, error.message);
  }

  // 2. Pre-purchase validation — safe to retry after correcting input.
  const isValidation = PRE_PURCHASE_VALIDATION_PATTERNS.some(re => re.test(error.message || ''));
  if (isValidation) {
    return res.status(400).json({
      success: false, status: 'REJECTED',
      error: error.message, canRetry: true,
    });
  }

  // 3. Post-purchase ambiguity — reconcile before declaring broker failure.
  if (context.symbol && context.stake) {
    try {
      const recovered = await _reconcilePostBuyError(context);
      if (recovered) {
        logger.warn(
          `[${logTag}] Recovered contract ${recovered.id} despite error "${error.message}" ` +
          `— returning CONFIRMED_RECORD_FAILED (not BROKER_ERROR)`
        );
        return res.status(200).json({
          success: true,
          status: 'CONFIRMED_RECORD_FAILED',
          contractId: String(recovered.id),
          entryPrice: recovered.entryPrice,
          purchasePrice: recovered.purchasePrice,
          strategy: context.strategy || null,
          regimeCode: context.regimeCode || null,
          recovered: true,
          originalError: error.message,
          warning: 'Purchase confirmed by portfolio reconciliation. DO NOT retry.',
        });
      }
    } catch (recErr) {
      logger.warn(`[${logTag}] Reconcile attempt failed: ${recErr.message}`);
    }
  }

  // 4. No recovery — genuine broker error.
  return res.status(500).json({
    success: false, status: 'BROKER_ERROR', error: error.message, canRetry: false,
    warning: 'The broker returned an error. Check open positions before retrying.',
  });
}

async function broadcastHistoryUpdate() {
  try {
    const recentClosed = await Trade.find({ status: 'CLOSED' })
      .sort({ closeTime: -1 }).limit(200).lean();
    const historyPayload = recentClosed.map(t => ({
      pair: t.instrument || t.pair || 'N/A',
      side: t.side || 'N/A',
      entryPrice: t.openPrice || t.entryPrice || null,
      exitPrice: t.closePrice || t.exitPrice || null,
      lotSize: t.lotSize || 0,
      pnl: t.realizedProfit !== undefined ? t.realizedProfit : (t.pnl || 0),
      status: t.status || 'CLOSED',
      date: t.closeTime || t.updatedAt || t.createdAt,
    }));
    broadcastToDashboards('history', historyPayload);
  } catch (err) {
    logger.warn(`[controllers] broadcastHistoryUpdate failed: ${err.message}`);
  }
}

// ---------- Preferences ----------
exports.getPreferences = async (req, res) => {
  try {
    const userId = req.user?.id || 'admin';
    let user = await User.findOne({ userId });
    if (!user) { user = new User({ userId, tradingProduct: 'deriv_cfd' }); await user.save(); }
    res.json({ tradingProduct: user.tradingProduct });
  } catch (error) { res.status(500).json({ error: error.message }); }
};

exports.updatePreferences = async (req, res) => {
  const { tradingProduct } = req.body;
  const validProducts = ['mt5', 'deriv_cfd', 'deriv_multiplier', 'deriv_basic'];
  if (!validProducts.includes(tradingProduct)) return res.status(400).json({ error: 'Invalid product' });
  try {
    const userId = req.user?.id || 'admin';
    let user = await User.findOne({ userId });
    if (!user) { user = new User({ userId, tradingProduct }); } else { user.tradingProduct = tradingProduct; }
    await user.save();
    if (req.user) req.user.tradingProduct = tradingProduct;
    res.json({ success: true, tradingProduct });
  } catch (error) { res.status(500).json({ error: error.message }); }
};

// ---------- Account ----------
exports.getAccount = async (req, res) => {
  try {
    const product = getProduct(req);
    const account = await accountService.getAccount(product);
    let enhanced = account;
    try { const broker = getBroker(product); enhanced = enhanceAccount(account, broker); } catch (_) {}
    res.json(enhanced);
  } catch (error) {
    logger.error('[getAccount] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

// ---------- Prices ----------
exports.getPrices = async (req, res) => {
  const { instruments } = req.query;
  if (!instruments) return res.status(400).json({ error: 'instruments query param required' });
  try {
    const product = getProduct(req);
    const pairs = instruments.split(',');
    const prices = await marketProvider.getPrices(pairs, product);
    res.json(prices);
  } catch (error) { res.status(500).json({ error: error.message }); }
};

// ---------- CANDLES ----------
exports.getCandles = async (req, res) => {
  const { pair, count = 100, granularity = 'M5' } = req.query;
  if (!pair) return res.status(400).json({ error: 'pair query param required' });

  try {
    const product = getProduct(req);
    const clean = String(pair).toUpperCase().replace(/[/\-_]/g, '');
    const formats = [clean];
    if (clean.length === 6) {
      formats.push(clean.slice(0, 3) + '_' + clean.slice(3));
      formats.push('frx' + clean);
      formats.push('frx' + clean.slice(0, 3) + '_' + clean.slice(3));
    } else {
      formats.push(pair);
    }

    try {
      const broker = getBroker(product);
      if (!broker.isConnected || !broker.isConnected()) {
        logger.warn('[getCandles] Broker not connected — attempting connect');
        await broker.connect();
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (e) {
      logger.warn('[getCandles] Broker connect attempt failed:', e.message);
    }

    let lastErr = null;
    const attempts = [];
    for (const fmt of formats) {
      try {
        const candles = await marketProvider.getCandles(fmt, parseInt(count), granularity, product);
        attempts.push({ format: fmt, count: Array.isArray(candles) ? candles.length : 'not-array' });
        if (Array.isArray(candles) && candles.length > 0) {
          logger.info(`[getCandles] ${pair}: success with "${fmt}" (${candles.length} candles)`);
          return res.json(candles);
        }
      } catch (err) {
        attempts.push({ format: fmt, error: err.message });
        lastErr = err;
      }
    }

    let brokerConnected = false;
    try { const b = getBroker(product); brokerConnected = b.isConnected ? b.isConnected() : false; } catch (_) {}

    logger.error(`[getCandles] All formats failed for ${pair}. Attempts: ${JSON.stringify(attempts)}`);
    return res.status(500).json({
      error: 'No candles returned from any symbol format',
      pair, attempts,
      lastError: lastErr ? lastErr.message : 'All formats returned empty',
      brokerConnected,
      hint: brokerConnected ? 'Broker connected but candle endpoint failed.' : 'Broker not connected — wait 30s and retry.',
    });
  } catch (error) {
    logger.error('[getCandles] Fatal:', error.message);
    return res.status(500).json({ error: error.message, stage: 'outer-catch' });
  }
};

// ---------- Symbols ----------
exports.getSymbols = async (req, res) => {
  try {
    const product = getProduct(req);
    const broker = getBroker(product);
    if (!broker.isConnected()) await broker.connect();
    let symbols = [];
    if (broker.symbolManager && typeof broker.symbolManager._symbols === 'object') {
      symbols = Array.from(broker.symbolManager._symbols.values());
    } else if (broker.symbols) {
      symbols = typeof broker.symbols === 'function' ? await broker.symbols() : broker.symbols;
    }
    res.json(symbols);
  } catch (error) { res.status(500).json({ error: error.message }); }
};

exports.getCapabilities = async (req, res) => {
  try {
    const product = getProduct(req);
    const broker = getBroker(product);
    res.json({
      product, name: broker.serverName || product,
      connected: broker.isConnected(),
      state: broker._state || 'unknown',
      capabilities: broker.capabilities || {},
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
};

// ---------- Positions / Trades ----------
exports.getPositions = async (req, res) => {
  try {
    const product = getProduct(req);
    const broker = getBroker(product);
    const positions = await broker.getPositions();
    res.json(positions);
  } catch (error) { res.status(500).json({ error: error.message }); }
};

exports.getTrades = async (req, res) => {
  try {
    const product = getProduct(req);
    const broker = getBroker(product);
    const rawTrades = await broker.getOpenTrades();
    const trades = rawTrades.map(t => ({
      id: t.id, instrument: t.instrument, side: t.side, price: t.price,
      entryPrice: t.entryPrice ?? null, purchasePrice: t.purchasePrice ?? null,
      currentPrice: t.currentPrice, units: t.units, unrealizedPL: t.unrealizedPL,
      stopLoss: t.stopLoss, takeProfit: t.takeProfit, openTime: t.openTime,
    }));
    res.json(trades);
  } catch (error) { res.status(500).json({ error: error.message }); }
};

exports.getTradeHistory = async (req, res) => {
  try {
    const trades = await Trade.find({ status: 'CLOSED' }).sort({ closeTime: -1 }).lean();
    const mapped = trades.map(t => ({
      pair: t.instrument || t.pair || 'N/A',
      side: t.side || 'N/A',
      entryPrice: t.openPrice || t.entryPrice || null,
      exitPrice: t.closePrice || t.exitPrice || null,
      lotSize: t.lotSize || 0,
      pnl: t.realizedProfit !== undefined ? t.realizedProfit : (t.pnl || 0),
      status: t.status || 'CLOSED',
      date: t.closeTime || t.updatedAt || t.createdAt,
    }));
    res.json(mapped);
  } catch (error) { res.status(500).json({ error: error.message }); }
};

exports.getPendingOrders = async (req, res) => {
  try {
    const pending = await Order.find({ status: { $in: ['PENDING', 'ACCEPTED', 'EXECUTING'] } })
      .sort({ createdAt: -1 }).lean();
    res.json(pending.map(o => ({
      contractId: o.contractId || o.clientOrderId,
      instrument: o.instrument, side: o.side,
      entryPrice: o.entryPrice || o.placedPrice,
      units: o.units || o.lotSize,
      status: o.status, clientOrderId: o.clientOrderId,
    })));
  } catch (error) { res.status(500).json({ error: error.message }); }
};

// ---------- Place Order ----------
exports.placeOrder = async (req, res) => {
  const {
    pair, side, lotSize, stopLoss, takeProfit, stake, multiplier,
    duration, knockoutLevel, takeProfitLevel, product: overrideProduct,
    // [FIX-STRAT]
    strategy, regimeCode, entryThesis,
  } = req.body;

  // [FIX-BROKER-ERR] Pre-compute product and instrument so the catch
  // block can pass them as reconcile context. Guarded against missing
  // `pair` — the original validation inside `try` still surfaces the
  // correct REJECTED error.
  const product = overrideProduct || getProduct(req);
  const instrument = (typeof pair === 'string' && pair.length > 0) ? pair.toUpperCase() : null;

  try {
    const isMultiplier = stake !== undefined && stake !== null && stake > 0;
    const isCFD = lotSize !== undefined && lotSize !== null && lotSize > 0;

    if (!isMultiplier && !isCFD) {
      return res.status(400).json({
        success: false, status: 'REJECTED',
        error: 'Either stake (Multiplier) or lotSize (CFD) must be provided.',
        canRetry: true,
      });
    }

    if (!instrument) {
      return res.status(400).json({
        success: false, status: 'REJECTED',
        error: 'pair is required',
        canRetry: true,
      });
    }

    let orderResult;

    if (isMultiplier) {
      orderResult = await orderService.placeMarketOrder({
        instrument, side, stake, multiplier, duration,
        knockoutLevel: knockoutLevel || null,
        takeProfitLevel: takeProfitLevel || null,
        product,
        // [FIX-STRAT]
        strategy, regimeCode, entryThesis,
      });
    } else {
      const currentPrice = await marketProvider.getCurrentPrice(instrument, product);
      const validation = validateOrderInput({
        pair: instrument, side, lotSize,
        stopLoss: stopLoss || null, takeProfit: takeProfit || null, currentPrice,
      });
      if (!validation.valid) {
        return res.status(400).json({ success: false, status: 'REJECTED', error: validation.message, canRetry: true });
      }
      const broker = getBroker(product);
      const account = await broker.getAccount();
      const currentPositions = await broker.getOpenTrades();
      const signal = { pair: instrument, side, entryPrice: currentPrice, stopLoss, takeProfit, recommendedLotSize: lotSize };
      const approval = await portfolioManager.canOpenTrade(signal, parseFloat(account.balance), currentPositions);
      if (!approval.allowed) {
        return res.status(400).json({ success: false, status: 'REJECTED', error: approval.reason, canRetry: true });
      }
      orderResult = await orderService.placeMarketOrder({
        instrument, side, lotSize,
        stopLoss: stopLoss || null, takeProfit: takeProfit || null, product,
        // [FIX-STRAT]
        strategy, regimeCode, entryThesis,
      });
    }

    const contractId = String(orderResult.contractId);
    const outcome = classifyOrderOutcome(orderResult);

    if (outcome === 'CONFIRMED_RECORD_FAILED') {
      return respondConfirmedButUnrecorded(res, contractId, {
        entryPrice: orderResult.entryPrice, purchasePrice: orderResult.purchasePrice,
        recording: orderResult.recording, raw: orderResult,
        // [FIX-STRAT]
        strategy: orderResult.strategy || strategy || null,
        regimeCode: orderResult.regimeCode || regimeCode || null,
      }, (orderResult.recording?.order?.error || orderResult.recording?.trade?.error || 'unknown'));
    }

    const trade = await Trade.findOne({ contractId: String(contractId) });
    if (!trade) {
      return res.status(200).json({
        success: true, status: 'CONFIRMED_RECORD_MISSING', contractId, trade: null, raw: orderResult,
        warning: 'Purchase confirmed but record not yet visible. Reconciliation will fix.',
      });
    }

    const broker = getBroker(product);
    const account = await broker.getAccount();
    notifyTrade('OPENED', trade, account).catch(() => {});

    return res.status(200).json({
      success: true, status: 'FILLED', contractId,
      entryPrice: orderResult.entryPrice, purchasePrice: orderResult.purchasePrice,
      trade, raw: orderResult,
      // [FIX-STRAT] echo back so the frontend can confirm
      strategy: orderResult.strategy || strategy || null,
      regimeCode: orderResult.regimeCode || regimeCode || null,
    });
  } catch (error) {
    return handleOrderError(res, error, 'placeOrder', {
      product,
      symbol: instrument,
      side,
      stake,
      lookbackMs: RECONCILE_LOOKBACK_MS,
      // [FIX-STRAT]
      strategy,
      regimeCode,
    });
  }
};

// ---------- Close (resilient) ----------
exports.closeTrade = async (req, res) => {
  const { tradeId } = req.params;
  if (!tradeId) return res.status(400).json({ error: 'tradeId required' });

  const cid = String(tradeId);
  const product = getProduct(req);
  const broker = getBroker(product);

  let brokerClosed = false;
  let closeResult = null;
  let brokerError = null;

  try {
    closeResult = await orderService.closeTrade(cid, product);
    brokerClosed = true;
  } catch (err) {
    brokerError = err;
    logger.warn(`[closeTrade] Broker close failed for ${cid}: ${err.message} — attempting verification`);
  }

  if (!brokerClosed) {
    let verify = { status: 'unknown' };
    try {
      verify = await broker.getContractStatus(cid);
    } catch (vErr) {
      logger.warn(`[closeTrade] verify failed for ${cid}: ${vErr.message}`);
    }

    if (verify.status === 'closed') {
      try {
        await Trade.findOneAndUpdate(
          { contractId: cid },
          {
            $set: {
              status: 'CLOSED',
              closeTime: new Date(),
              closePrice: verify.soldFor || null,
              realizedProfit: verify.profit || 0,
              pnl: verify.profit || 0,
              floatingProfit: 0,
            },
          }
        );
        logger.info(`[closeTrade] ${cid} already settled at Deriv — Trade marked CLOSED (pnl=${verify.profit || 0})`);
        brokerClosed = true;
      } catch (dbErr) {
        return res.status(500).json({ error: `Settlement verified but DB update failed: ${dbErr.message}` });
      }
    } else if (verify.status === 'unknown') {
      try {
        await Trade.findOneAndUpdate(
          { contractId: cid, status: 'OPEN' },
          {
            $set: {
              status: 'CLOSED',
              closeTime: new Date(),
              floatingProfit: 0,
              closeReason: 'force-closed-stale',
            },
          }
        );
        logger.warn(`[closeTrade] ${cid} not found at Deriv — force-closed as stale`);
        brokerClosed = true;
      } catch (dbErr) {
        return res.status(500).json({ error: `Force-close failed: ${dbErr.message}` });
      }
    } else {
      return res.status(500).json({
        error: brokerError ? brokerError.message : 'Close failed',
        contractStatus: verify.status,
        hint: 'Contract still open at Deriv but sell failed. Retry or check broker logs.',
      });
    }
  }

  try {
    const openTrades = await orderService.getOpenTrades(product);
    broadcastToDashboards('positions', openTrades);
  } catch (_) {}

  try {
    const account = await accountService.getAccount(product);
    broadcastToDashboards('account', enhanceAccount(account, broker));
  } catch (_) {}

  await broadcastHistoryUpdate();
  portfolioManager.updateDailyPnL(closeResult?.pl || 0);

  const updated = await Trade.findOne({ contractId: cid });
  if (updated) {
    try {
      const account = await broker.getAccount();
      notifyTrade('CLOSED', updated, account).catch(() => {});
    } catch (_) {}
    try {
      const learner = await getPerformanceLearner();
      learner.recordTrade(updated);
    } catch (_) {}
  }

  res.json({ success: true, contractId: cid, result: closeResult || { forced: true } });
};

exports.cancelOrder = async (req, res) => {
  const { orderId } = req.params;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  try {
    const product = getProduct(req);
    const result = await orderService.cancelOrder(orderId, product);
    res.json({ success: true, result });
  } catch (error) { res.status(500).json({ error: error.message }); }
};

exports.deleteHistory = async (req, res) => {
  try {
    const count = await orderService.deleteClosedTrades();
    await broadcastHistoryUpdate();
    res.json({ success: true, deletedCount: count });
  } catch (error) { res.status(500).json({ error: error.message }); }
};

exports.getSignal = async (req, res) => {
  const { pair, strategy = 'sma', ...params } = req.query;
  if (!pair) return res.status(400).json({ error: 'pair query param required' });
  try {
    const product = getProduct(req);
    const signal = await strategyEngine.generateSignal(pair.toUpperCase(), strategy, { ...params, product });
    if (!signal) return res.json({ signal: null, message: 'No signal generated' });
    res.json(signal);
  } catch (error) { res.status(500).json({ error: error.message }); }
};

exports.autoTrade = async (req, res) => {
  const {
    pair, riskPercent = 1, strategy: stratParam = 'sma', ...params
  } = req.body;

  // [FIX-BROKER-ERR] Pre-compute for reconcile context.
  const product = getProduct(req);
  const instrument = (typeof pair === 'string' && pair.length > 0) ? pair.toUpperCase() : null;

  // [FIX-STRAT] Destructure the attribution fields from req.body.
  const {
    stake, multiplier, duration, knockoutLevel, takeProfitLevel,
    strategy: bodyStrategy, regimeCode, entryThesis,
  } = req.body;
  // Prefer explicit body.strategy (attribution) over stratParam (engine selector).
  const attributionStrategy = bodyStrategy || null;

  try {
    if (!instrument) {
      return res.status(400).json({ error: 'pair required' });
    }
    const signal = await strategyEngine.generateSignal(instrument, stratParam, { ...params, product });
    if (!signal) return res.json({ success: false, status: 'NO_SIGNAL', message: 'No trading signal' });

    const currentPrice = signal.entryPrice;
    const isMultiplier = stake !== undefined && stake !== null && stake > 0;

    let orderResult;
    if (isMultiplier) {
      orderResult = await orderService.placeMarketOrder({
        instrument, side: signal.side, stake, multiplier, duration,
        knockoutLevel: knockoutLevel || null, takeProfitLevel: takeProfitLevel || null,
        product, decisionId: null, autoTrade: true,
        // [FIX-STRAT]
        strategy: attributionStrategy, regimeCode, entryThesis,
      });
    } else {
      const validation = validateOrderInput({
        pair: instrument, side: signal.side, lotSize: signal.recommendedLotSize || 0.01,
        stopLoss: signal.stopLoss || null, takeProfit: signal.takeProfit || null, currentPrice,
      });
      if (!validation.valid) {
        return res.status(400).json({ success: false, status: 'REJECTED', error: validation.message, canRetry: true });
      }
      const broker = getBroker(product);
      const account = await broker.getAccount();
      const currentPositions = await broker.getOpenTrades();
      const approval = await portfolioManager.canOpenTrade(signal, parseFloat(account.balance), currentPositions);
      if (!approval.allowed) {
        return res.status(400).json({ success: false, status: 'REJECTED', error: approval.reason, canRetry: true });
      }
      let lotSize = signal.recommendedLotSize;
      if (!lotSize) {
        lotSize = await riskManager.calculateLotSize(instrument, signal.entryPrice, signal.stopLoss, riskPercent, 1000, product);
      }
      orderResult = await orderService.placeMarketOrder({
        instrument, side: signal.side, lotSize,
        stopLoss: signal.stopLoss || null, takeProfit: signal.takeProfit || null,
        product, decisionId: null, autoTrade: true,
        // [FIX-STRAT]
        strategy: attributionStrategy, regimeCode, entryThesis,
      });
    }

    const contractId = String(orderResult.contractId);
    const outcome = classifyOrderOutcome(orderResult);
    if (outcome === 'CONFIRMED_RECORD_FAILED') {
      return respondConfirmedButUnrecorded(res, contractId, {
        signal, entryPrice: orderResult.entryPrice, purchasePrice: orderResult.purchasePrice,
        recording: orderResult.recording, raw: orderResult,
        strategy: orderResult.strategy || attributionStrategy || null,
        regimeCode: orderResult.regimeCode || regimeCode || null,
      }, (orderResult.recording?.order?.error || orderResult.recording?.trade?.error || 'unknown'));
    }
    const trade = await Trade.findOne({ contractId: String(contractId) });
    if (!trade) {
      return res.status(200).json({
        success: true, status: 'CONFIRMED_RECORD_MISSING', contractId, signal, trade: null, raw: orderResult,
      });
    }
    const broker = getBroker(product);
    const account = await broker.getAccount();
    notifyTrade('OPENED', trade, account).catch(() => {});
    return res.status(200).json({
      success: true, status: 'FILLED', contractId, signal, trade, raw: orderResult,
      strategy: orderResult.strategy || attributionStrategy || null,
      regimeCode: orderResult.regimeCode || regimeCode || null,
    });
  } catch (error) {
    return handleOrderError(res, error, 'autoTrade', {
      product,
      symbol: instrument,
      side: null,   // side comes from the signal, unknown at catch time
      stake,
      lookbackMs: RECONCILE_LOOKBACK_MS,
      strategy: attributionStrategy,
      regimeCode,
    });
  }
};

exports.executeSignal = async (req, res) => {
  const {
    pair, side, entryPrice, stopLoss, takeProfit, lotSize,
    stake, multiplier, duration, knockoutLevel, takeProfitLevel,
    // [FIX-STRAT]
    strategy, regimeCode, entryThesis,
  } = req.body;

  // [FIX-BROKER-ERR] Pre-compute for reconcile context.
  const product = getProduct(req);
  const formattedPair = pair ? formatSymbol(pair) : null;
  const cleanSide = (typeof side === 'string') ? side.toUpperCase().trim() : null;

  try {
    if (!formattedPair || !cleanSide) return res.status(400).json({ error: 'pair and side are required' });
    if (!['BUY', 'SELL'].includes(cleanSide)) return res.status(400).json({ error: 'Side must be BUY or SELL' });

    const instrument = formattedPair;
    const currentPrice = entryPrice || await marketProvider.getCurrentPrice(instrument, product);
    const isMultiplier = stake !== undefined && stake !== null && stake > 0;

    let orderResult;
    if (isMultiplier) {
      orderResult = await orderService.placeMarketOrder({
        instrument, side: cleanSide, stake, multiplier, duration,
        knockoutLevel: knockoutLevel || null, takeProfitLevel: takeProfitLevel || null, product,
        // [FIX-STRAT]
        strategy, regimeCode, entryThesis,
      });
    } else {
      if (!lotSize || lotSize <= 0) {
        return res.status(400).json({ success: false, status: 'REJECTED', error: 'lotSize is required for CFD trade', canRetry: true });
      }
      const validation = validateOrderInput({
        pair: instrument, side: cleanSide, lotSize,
        stopLoss: stopLoss || null, takeProfit: takeProfit || null, currentPrice,
      });
      if (!validation.valid) {
        return res.status(400).json({ success: false, status: 'REJECTED', error: validation.message, canRetry: true });
      }
      orderResult = await orderService.placeMarketOrder({
        instrument, side: cleanSide, lotSize: parseFloat(lotSize),
        stopLoss: stopLoss || null, takeProfit: takeProfit || null, product,
        // [FIX-STRAT]
        strategy, regimeCode, entryThesis,
      });
    }

    const contractId = String(orderResult.contractId);
    const outcome = classifyOrderOutcome(orderResult);
    if (outcome === 'CONFIRMED_RECORD_FAILED') {
      return respondConfirmedButUnrecorded(res, contractId, {
        entryPrice: orderResult.entryPrice, purchasePrice: orderResult.purchasePrice,
        recording: orderResult.recording, raw: orderResult,
        strategy: orderResult.strategy || strategy || null,
        regimeCode: orderResult.regimeCode || regimeCode || null,
      }, (orderResult.recording?.order?.error || orderResult.recording?.trade?.error || 'unknown'));
    }
    const trade = await Trade.findOne({ contractId: String(contractId) });
    if (!trade) {
      return res.status(200).json({
        success: true, status: 'CONFIRMED_RECORD_MISSING', contractId, trade: null, raw: orderResult,
      });
    }
    const broker = getBroker(product);
    const account = await broker.getAccount();
    notifyTrade('OPENED', trade, account).catch(() => {});
    return res.status(200).json({
      success: true, status: 'FILLED', contractId,
      entryPrice: orderResult.entryPrice, purchasePrice: orderResult.purchasePrice, trade, raw: orderResult,
      strategy: orderResult.strategy || strategy || null,
      regimeCode: orderResult.regimeCode || regimeCode || null,
    });
  } catch (error) {
    return handleOrderError(res, error, 'executeSignal', {
      product,
      symbol: formattedPair,
      side: cleanSide,
      stake,
      lookbackMs: RECONCILE_LOOKBACK_MS,
      strategy,
      regimeCode,
    });
  }
};

exports.generateReport = async (req, res) => {
  try {
    const { from, to, includeTrades = true } = req.body;
    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const toDate = to ? new Date(to) : new Date();
    if (fromDate > toDate) return res.status(400).json({ error: 'From date must be before To date' });
    let trades = [];
    if (includeTrades) {
      const rawTrades = await Trade.find({ status: 'CLOSED', closeTime: { $gte: fromDate, $lte: toDate } })
        .sort({ closeTime: -1 }).lean();
      trades = rawTrades.map(t => ({
        pair: t.instrument || t.pair || 'N/A',
        side: t.side || 'N/A',
        entryPrice: t.openPrice || t.entryPrice || null,
        exitPrice: t.closePrice || t.exitPrice || null,
        lotSize: t.lotSize || 0,
        pnl: t.realizedProfit !== undefined ? t.realizedProfit : (t.pnl || 0),
        status: t.status || 'CLOSED',
        date: t.closeTime || t.updatedAt || t.createdAt,
      }));
    }
    const product = getProduct(req);
    const account = await accountService.getAccount(product);
    const { calculateMetrics } = require('../core/analytics/performanceSuite');
    const metrics = calculateMetrics(trades, account.balance || 10000);
    const crypto = require('crypto');
    const reportHash = crypto.createHash('sha256')
      .update(JSON.stringify({ trades, metrics, account, fromDate, toDate }))
      .digest('hex').slice(0, 16);
    const pdfBuffer = await generateReport({
      fromDate, toDate, trades, metrics, account,
      verificationCode: reportHash, systemName: 'RTS v2.0',
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=RTS_Report_${new Date().toISOString().slice(0, 10)}.pdf`);
    res.send(pdfBuffer);
  } catch (error) {
    logger.error('[generateReport] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

exports.getProduct = getProduct;
