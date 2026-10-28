// server.js – RTS Entry Point (Deriv-only, pattern-based, with balance guard)

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const WebSocket = require('ws');
const http = require('http');

const dashboardClients = new Set();

function broadcastToDashboards(type, data) {
  if (dashboardClients.size === 0) return;
  let message;
  try { message = JSON.stringify({ type, data }); }
  catch (err) {
    console.error(`[WS] Failed to serialize '${type}':`, err.message);
    return;
  }
  for (const client of dashboardClients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(message); } catch (_) {}
    }
  }
}
function broadcast(type, data) { broadcastToDashboards(type, data); }

module.exports.broadcastToDashboards = broadcastToDashboards;
module.exports.broadcast = broadcast;

const connectDB = require('./config/db');
const apiRoutes = require('./api/routes');
const botRoutes = require('./api/botRoutes');
const User = require('./models/User');

const Trade = require('./models/Trade');
const StrategyPerformance = require('./models/StrategyPerformance');

const priceBuffer = require('./core/data/priceBuffer');
const candleStore = require('./core/data/candleStore');
const marketStateCache = require('./core/data/marketStateCache');
const awarenessEngine = require('./core/awareness/engine');
const deepRegime = require('./core/intelligence/deep/regime');
const decisionEngine = require('./core/decision/engine');
const eventBus = require('./infrastructure/eventBus');

const { dataOrchestrator } = require('./core/data/dataOrchestrator');

const strategyEngine = require('./core/strategy/engine');
const ranker = require('./core/strategy/ranker');

const predictor = require('./core/intelligence/patterns/predictor');
const opportunityEngine = require('./core/intelligence/opportunityEngine');
const riskEngine = require('./core/risk/riskEngine');

const analyticsDashboard = require('./core/analytics/dashboard');
const candleBootstrapper = require('./core/data/candleBootstrapper');
const otie = require('./core/intelligence/openTradeIntelligenceV5');
const performanceMonitor = require('./core/performance/performanceMonitor');

const botRunner = require('./core/bots/runner');
const digitAnalyzer = require('./core/intelligence/digit/analyzer');
const balanceGuard = require('./core/risk/balanceGuard');

const { getBroker } = require('./core/execution/brokerFactory');

function normalizeSymbol(symbol) {
  if (!symbol) return '';
  return symbol.replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
}

const app = express();
const PORT = process.env.PORT || 5000;

connectDB();

const _consensusCache = new Map();
const _predictionCache = new Map();
const _opportunityCache = new Map();

function flattenConsensus(consensus) {
  if (!consensus || !consensus.consensus) return null;
  const c = consensus.consensus;
  return {
    symbol: consensus.symbol,
    timeframe: consensus.timeframe,
    regime: consensus.regime,
    evaluatedAt: consensus.evaluatedAt,
    action: c.action,
    direction: c.direction,
    confidence: c.confidence,
    anchorStrategy: c.anchorStrategy,
    agreeing: c.agreeing || [],
    conflicting: c.conflicting || [],
    buyWeight: c.buyWeight,
    sellWeight: c.sellWeight,
    activeCount: c.activeCount,
    silentCount: c.silentCount,
    flaggedCount: c.flaggedCount,
    reasons: c.reasons || [],
    strategies: (consensus.strategies || []).map(r => ({
      name: r.name,
      signalSide: r.signalSide,
      status: r.status,
      weight: Number((r.weight || 0).toFixed(3)),
      effectiveWinRate: Number((r.effectiveWinRate || 0).toFixed(3)),
      trades: r.trades || 0,
      flagged: !!r.flagged,
    })),
  };
}

async function ensureAdmin() {
  try {
    const adminId = 'admin';
    let admin = await User.findOne({ userId: adminId });
    if (!admin) {
      admin = new User({ userId: adminId, tradingProduct: 'deriv_cfd' });
      await admin.save();
    } else if (admin.tradingProduct === 'mt5') {
      admin.tradingProduct = 'deriv_cfd';
      await admin.save();
    }
  } catch (err) {
    console.error('[Admin] Creation failed:', err.message);
  }
}

function repairJson(raw) {
  let repaired = raw.trim();
  if (repaired.endsWith(',')) repaired = repaired.slice(0, -1);
  let openBraces = 0, openBrackets = 0, inString = false, escape = false;
  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') openBraces++;
    else if (ch === '}') openBraces--;
    else if (ch === '[') openBrackets++;
    else if (ch === ']') openBrackets--;
  }
  while (openBrackets > 0) { repaired += ']'; openBrackets--; }
  while (openBraces > 0) { repaired += '}'; openBraces--; }
  return repaired;
}

app.use(cors());

app.use((req, res, next) => {
  let rawBody = '';
  req.on('data', chunk => { rawBody += chunk.toString(); });
  req.on('end', () => {
    if (rawBody.charCodeAt(0) === 0xFEFF) rawBody = rawBody.slice(1);
    rawBody = rawBody.replace(/\0/g, '');
    const trimmed = rawBody.trim();
    req.rawBody = trimmed;

    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('application/json') && trimmed.length > 0) {
      let parsed = null;
      try { parsed = JSON.parse(trimmed); req.body = parsed; }
      catch (err) {
        if (err instanceof SyntaxError) {
          const repaired = repairJson(trimmed);
          try { parsed = JSON.parse(repaired); req.body = parsed; req.repairedRawBody = repaired; }
          catch (err2) { req.body = {}; req.parseError = err2; }
        } else { throw err; }
      }
    } else { req.body = {}; }
    next();
  });
  req.on('error', (err) => { next(err); });
});

app.use(express.static('public'));

app.use(async (req, res, next) => {
  try {
    let admin = await User.findOne({ userId: 'admin' });
    if (!admin) {
      const defaultProduct = process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd';
      admin = new User({ userId: 'admin', tradingProduct: defaultProduct });
      await admin.save();
    }
    req.user = { id: 'admin', tradingProduct: admin.tradingProduct };
    next();
  } catch (err) {
    req.user = { id: 'admin', tradingProduct: process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd' };
    next();
  }
});

app.use('/api', apiRoutes);
app.use('/api', botRoutes);

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'RTS is running with Deriv broker' });
});

app.get('/health/pipeline', async (req, res) => {
  try {
    const broker = getBroker('deriv_cfd');
    const connected = broker.isConnected ? broker.isConnected() : false;
    const cache = marketStateCache._cache || new Map();
    const hasMarketData = cache.size > 0;
    const hasConsensus = _consensusCache.size > 0;
    const hasBots = botRunner.list().length > 0;
    const healthy = connected && hasMarketData && hasConsensus;
    res.status(healthy ? 200 : 503).json({
      healthy,
      brokerConnected: connected,
      marketCachePopulated: hasMarketData,
      strategyConsensusActive: hasConsensus,
      runningBots: hasBots,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, healthy: false });
  }
});

app.get('/api/balance-guard', (req, res) => {
  try {
    res.json(balanceGuard.getState());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/balance-guard/reset', (req, res) => {
  try {
    balanceGuard.reset();
    res.json({ success: true, state: balanceGuard.getState() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/debug/pipeline', async (req, res) => {
  try {
    const broker = getBroker('deriv_cfd');
    const brokerHealth = broker.getHealth ? broker.getHealth() : {};
    const cache = marketStateCache._cache || new Map();

    let deepBuffers = 0;
    try {
      deepBuffers = require('./core/intelligence/deep/marketState')._buffers?.size || 0;
    } catch (_) {}

    let dashboardMetrics = {};
    try {
      dashboardMetrics = analyticsDashboard.getMetrics ? analyticsDashboard.getMetrics() : {};
    } catch (_) {}

    let otieState = {};
    try {
      otieState = otie.getAllStates ? otie.getAllStates() : {};
    } catch (_) {}

    res.json({
      timestamp: new Date().toISOString(),
      broker: {
        connected: broker.isConnected ? broker.isConnected() : false,
        publicState: brokerHealth.publicState,
        authState: brokerHealth.authState,
        contractMonitoring: brokerHealth.contractMonitoring,
        accountLoaded: brokerHealth.accountLoaded,
      },
      marketCache: { symbolCount: cache.size, symbols: Array.from(cache.keys()) },
      deepState: { bufferCount: deepBuffers },
      pipeline: { timerRunning: !!pipelineTimer },
      analyticsDashboard: {
        hasMetrics: Object.keys(dashboardMetrics).length > 0,
        totalTrades: dashboardMetrics.totalTrades || 0,
      },
      otie: { observerCount: otie.observerCount || 0, states: otieState },
      strategyPipeline: {
        rankerActive: _consensusCache.size > 0,
        symbolsWithConsensus: Array.from(_consensusCache.keys()),
        symbolsWithPrediction: Array.from(_predictionCache.keys()),
        symbolsWithOpportunity: Array.from(_opportunityCache.keys()),
        candleCacheStats: strategyEngine.getCandleCacheStats ? strategyEngine.getCandleCacheStats() : [],
      },
      balanceGuard: balanceGuard.getState(),
      runningBots: botRunner.list(),
      watchedSymbols: WATCHED_SYMBOLS,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/signal/active', async (req, res) => {
  try {
    const broker = getBroker('deriv_cfd');
    const account = broker.isConnected() ? await broker.getAccount() : { balance: '0', currency: 'USD' };
    const positions = broker.isConnected() ? await broker.getOpenTrades() : [];

    const signals = {};
    for (const symbol of WATCHED_SYMBOLS) {
      const consensus = _consensusCache.get(symbol);
      const prediction = _predictionCache.get(symbol);
      const opportunity = _opportunityCache.get(symbol);

      signals[symbol] = {
        consensus: consensus ? flattenConsensus(consensus) : null,
        prediction: prediction ? {
          direction: prediction.direction,
          source: prediction.source,
          modeLabel: prediction.modeLabel,
          confidence: prediction.calibratedConfidence,
          probabilities: prediction.probabilities,
          expectedMove: prediction.expectedMove,
          pattern: prediction.pattern,
          momentum: prediction.momentum,
          volatility: prediction.volatility,
          strategyConsensus: prediction.strategyConsensus,
          strategyLevels: prediction.strategyLevels,
          qualifiedCount: prediction.qualifiedCount,
          effectiveSampleSize: prediction.effectiveSampleSize,
          timestamp: prediction.timestamp,
        } : null,
        opportunity: opportunity ? {
          tradable: opportunity.tradable,
          reason: opportunity.reason,
          direction: opportunity.direction,
          multiplier: opportunity.multiplier,
          stake: opportunity.stake,
          duration: opportunity.duration,
          entryPrice: opportunity.entryPrice,
          knockoutLevel: opportunity.knockoutLevel,
          takeProfitLevel: opportunity.takeProfitLevel,
          source: opportunity.source,
          tradeEconomics: opportunity.tradeEconomics,
          strategyInfo: opportunity.strategyInfo,
          timestamp: opportunity.timestamp,
        } : null,
      };
    }

    res.json({
      timestamp: new Date().toISOString(),
      account: {
        balance: account.balance,
        currency: account.currency,
        openPositions: positions.length,
      },
      signals,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/debug/strategies', async (req, res) => {
  try {
    const top = await StrategyPerformance.topStrategies(20);
    const allSymbols = new Map();
    for (const s of WATCHED_SYMBOLS) {
      const consensus = _consensusCache.get(s);
      if (consensus) {
        allSymbols.set(s, {
          regime: consensus.regime,
          evaluatedAt: consensus.evaluatedAt,
          action: consensus.consensus?.action,
          direction: consensus.consensus?.direction,
          confidence: consensus.consensus?.confidence,
          anchorStrategy: consensus.consensus?.anchorStrategy,
          agreeing: consensus.consensus?.agreeing,
          conflicting: consensus.consensus?.conflicting,
          buyWeight: consensus.consensus?.buyWeight,
          sellWeight: consensus.consensus?.sellWeight,
        });
      }
    }

    res.json({
      timestamp: new Date().toISOString(),
      registeredStrategies: Object.keys(strategyEngine.STRATEGIES || {}),
      candleCache: strategyEngine.getCandleCacheStats ? strategyEngine.getCandleCacheStats() : [],
      currentConsensus: Object.fromEntries(allSymbols),
      topPerformance: top.map(t => ({
        strategy: t.strategy,
        symbol: t.symbol,
        trades: t.trades || 0,
        wins: t.wins || 0,
        losses: t.losses || 0,
        winRate: Number((t.winRate || 0).toFixed(3)),
        avgR: Number((t.avgR || 0).toFixed(3)),
        recentWinRate: Number((t.recentWinRate || 0).toFixed(3)),
        flagged: !!t.flagged,
        lastTradeAt: t.lastTradeAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/debug/status', (req, res) => {
  const lastState = marketStateCache.get('EURUSD') || null;
  const lastRegime = deepRegime.getLatestRegime('EURUSD') || null;
  const lastDecision = decisionEngine.getLastDecision('EURUSD') || null;
  res.json({
    engine: {
      candleBuilder: typeof candleStore !== 'undefined' ? 'running' : 'not loaded',
      marketAwareness: awarenessEngine ? 'running' : 'not loaded',
      deepRegime: deepRegime ? 'running' : 'not loaded',
      decisionEngine: decisionEngine ? 'running' : 'not loaded',
      otieV5: otie ? 'running' : 'not loaded',
      strategyRanker: ranker ? 'running' : 'not loaded',
      botRunner: botRunner ? 'running' : 'not loaded',
      digitAnalyzer: digitAnalyzer ? 'running' : 'not loaded',
      balanceGuard: balanceGuard ? 'running' : 'not loaded',
    },
    lastCandle: candleStore.getHistory('EURUSD', 'M5', 1)[0] || null,
    lastMarketState: lastState,
    lastRegime,
    lastDecision,
    timestamp: new Date().toISOString(),
  });
});

app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'API endpoint not found' });
  }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const WS_PING_INTERVAL = 30000;
let wsPingTimer = null;

wss.on('connection', (ws, req) => {
  dashboardClients.add(ws);
  sendDashboardInitialState(ws);
  ws.on('close', () => { dashboardClients.delete(ws); });
  ws.on('error', (err) => console.error('[WS] Error:', err.message));
  ws.on('pong', () => {});
});

function startWSPing() {
  if (wsPingTimer) clearInterval(wsPingTimer);
  wsPingTimer = setInterval(() => {
    for (const client of dashboardClients) {
      if (client.readyState === WebSocket.OPEN) client.ping();
    }
  }, WS_PING_INTERVAL);
}

function enhanceAccount(accountData, broker) {
  if (!accountData) return accountData;
  let tradeMode = 0;
  let srv = 'Unknown';
  if (broker && broker._account) {
    tradeMode = broker._account.is_virtual !== undefined ? (broker._account.is_virtual ? 1 : 0) : 0;
    srv = broker._account.landing_company_name || 'Unknown';
  }
  return { ...accountData, tradeMode, server: srv };
}

async function sendDashboardInitialState(ws) {
  try {
    const accountService = require('./core/portfolio/accountService');
    const orderService = require('./core/execution/orderService');

    const [trades, account, positions] = await Promise.all([
      Trade.find({ status: 'OPEN' }).lean(),
      accountService.getAccount('deriv_cfd'),
      orderService.getOpenTrades('deriv_cfd')
    ]);

    let broker;
    try { broker = getBroker('deriv_cfd'); } catch (e) {}
    const enhancedAccount = enhanceAccount(account, broker);

    let otieState = {};
    try { otieState = otie.getAllStates ? otie.getAllStates() : {}; } catch (_) {}

    let strategyConsensus = {};
    try {
      for (const s of WATCHED_SYMBOLS) {
        const c = _consensusCache.get(s);
        if (c) strategyConsensus[s] = flattenConsensus(c);
      }
    } catch (_) {}

    let digitViews = {};
    try { digitViews = digitAnalyzer.getAllViews(); } catch (_) {}

    ws.send(JSON.stringify({
      type: 'init',
      data: {
        trades,
        account: enhancedAccount,
        positions,
        otieStates: otieState,
        strategyConsensus,
        digitViews,
        runningBots: botRunner.list(),
        balanceGuard: balanceGuard.getState(),
      }
    }));
  } catch (err) {
    console.error('[WS] Failed to send initial state:', err.message);
  }
}

awarenessEngine.on('marketAwareness', (data) => broadcast('marketAwareness', data));
deepRegime.on('regime', (regime) => broadcast('regime', regime));
decisionEngine.on('decision', (decision) => broadcast('decision', decision));
eventBus.on('account.fetched', (account) => broadcast('account', account));
eventBus.on('trade.closed', (data) => broadcast('tradeClosed', data));
eventBus.on('order.placed', (data) => broadcast('trade.placed', data));
eventBus.on('position.updated', (data) => broadcast('positions', data));
otie.on('otieV5State', (state) => broadcast('otieV5State', state));
otie.on('otieV5Action', (action) => broadcast('otieV5Action', action));
otie.on('otieState', (state) => broadcast('otieState', state));

eventBus.on('trade.closed', async (data) => {
  const contractId = data?.contractId;
  const strategy = data?.strategy;
  const instrument = data?.instrument;
  const realizedProfit = Number(data?.realizedProfit);
  const riskAmount = Number(data?.riskAmount);

  if (!strategy || !instrument || !Number.isFinite(realizedProfit)) {
    return;
  }

  try {
    const symbol = normalizeSymbol(instrument);
    const risk = Number.isFinite(riskAmount) && riskAmount > 0 ? riskAmount : 1;
    const regimeCode = data?.regimeCode || 'NEUTRAL';

    const updated = await StrategyPerformance.recordOutcome(
      strategy, symbol, realizedProfit, risk, regimeCode
    );

    console.log(
      `[StrategyPerformance] ${strategy}/${symbol} (${regimeCode}): ` +
      `pnl=${realizedProfit.toFixed(2)}$ R=${(realizedProfit/risk).toFixed(2)} ` +
      `trades=${updated.trades} wr=${(updated.winRate*100).toFixed(0)}% ` +
      `recentWR=${(updated.recentWinRate*100).toFixed(0)}% flagged=${updated.flagged}`
    );
  } catch (err) {
    console.error(`[StrategyPerformance] Failed for ${contractId}: ${err.message}`);
  }
});

eventBus.on('trade.closed', async (data) => {
  try {
    const trade = await Trade.findOne({ contractId: String(data.contractId) });
    if (trade) performanceMonitor.recordTrade(trade);
  } catch (err) {
    console.error('[PerformanceMonitor] Failed to record trade:', err.message);
  }
});
performanceMonitor.on('thresholdsUpdated', (thresholds) => {
  if (otie && typeof otie.updateConfig === 'function') {
    otie.updateConfig(thresholds);
  }
});

const WATCHED_SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'];

async function runPredictionPipeline(symbol) {
  try {
    const state = await require('./core/intelligence/deep/marketState').compute(symbol, 'M5', 200);
    if (!state) {
      console.log(`[Pipeline] ${symbol}: no state (candles insufficient)`);
      return false;
    }

    let strategyConsensus = null;
    try {
      strategyConsensus = await ranker.rank(state, symbol, { timeframe: 'M5' });
      _consensusCache.set(symbol, strategyConsensus);
      broadcastToDashboards('strategyConsensus', flattenConsensus(strategyConsensus));
    } catch (rankErr) {
      console.warn(`[Pipeline] Ranker failed for ${symbol}: ${rankErr.message}`);
    }

    const broker = getBroker('deriv_cfd');
    const account = await broker.getAccount();
    const positions = await broker.getOpenTrades();

    const marketData = {
      currentPrice: state.price.current,
      spread: state.awareness?.spread || 0,
      timestamp: new Date().toISOString(),
    };

    const prediction = await predictor.predict(symbol, state, strategyConsensus, { timeframe: 'M5' });
    if (!prediction) {
      console.log(`[Pipeline] ${symbol}: no prediction`);
      return false;
    }
    _predictionCache.set(symbol, prediction);
    broadcastToDashboards('prediction', prediction);

    const opportunity = await opportunityEngine.evaluate(
      prediction, account, positions, marketData,
      { riskPerTradePct: parseFloat(process.env.RISK_PER_TRADE_PCT) || 1.0 }
    );
    _opportunityCache.set(symbol, opportunity);
    broadcastToDashboards('opportunity', opportunity);

    const src = opportunity.source || prediction.source || 'unknown';
    console.log(
      `[Pipeline] ${symbol}: ${opportunity.decision || 'NO_TRADE'} ` +
      `${opportunity.tradable
        ? `${opportunity.multiplier}x ${opportunity.direction} [${src}]`
        : (opportunity.reason || '')}`
    );
    return true;
  } catch (err) {
    console.error(`[Pipeline] Error for ${symbol}:`, err.message);
    return false;
  }
}

async function runPredictionPipelineAll() {
  let ok = 0;
  for (const symbol of WATCHED_SYMBOLS) {
    const result = await runPredictionPipeline(symbol);
    if (result) ok++;
  }
  if (ok === 0) {
    console.debug(`[Pipeline] Cycle complete: 0/${WATCHED_SYMBOLS.length} produced predictions`);
  }
}

candleStore.on('candleClosed', async (candle) => {
  if (candle.timeframe === 'M5' && WATCHED_SYMBOLS.includes(candle.symbol)) {
    await runPredictionPipeline(candle.symbol);
  }
});

let pipelineTimer = null;
function startPipelineTimer() {
  if (pipelineTimer) clearInterval(pipelineTimer);
  const intervalMs = parseInt(process.env.PREDICTION_INTERVAL_MS) || 30000;
  pipelineTimer = setInterval(() => {
    runPredictionPipelineAll().catch(err => {
      console.error('[Pipeline] Timer error:', err.message);
    });
  }, intervalMs);
  console.log(`[Pipeline] Timer started (${intervalMs}ms).`);
}

async function startCognitiveEngines() {
  try {
    console.log('[CTOS] Cognitive engines active: Awareness, Regime, Decision, OTIE, StrategyRanker, BotRunner, DigitAnalyzer, BalanceGuard.');
  } catch (err) {
    console.error('[CTOS] Initialization error:', err.message);
  }
}

async function startDerivBroker() {
  try {
    const broker = getBroker('deriv_cfd');
    broker.on('tick', (data) => broadcastToDashboards('price', data));
    broker.on('accountUpdate', async (accountData) => {
      const enhanced = enhanceAccount(accountData, broker);
      broadcastToDashboards('account', enhanced);
    });
    broker.on('contractUpdate', (state) => broadcastToDashboards('contractUpdate', state));
    broker.on('positions', (positions) => broadcastToDashboards('positions', positions));
    broker.on('orderUpdate', (data) => broadcastToDashboards('orderUpdate', data));
    broker.on('_portfolioUpdated', (positions) => broadcastToDashboards('positions', positions));
    await broker.connect();
    console.log('[Deriv] Broker connected.');
  } catch (err) {
    console.error('[Deriv] Failed to start Deriv broker:', err.message);
    throw err;
  }
}

async function startServer() {
  await ensureAdmin();

  server.listen(PORT, () => {
    console.log('==============================================');
    console.log(`RTS server running on http://localhost:${PORT}`);
    console.log(`Dashboard:      http://localhost:${PORT}`);
    console.log(`API base:       http://localhost:${PORT}/api`);
    console.log(`Signals:        http://localhost:${PORT}/api/signal/active`);
    console.log(`Bots:           http://localhost:${PORT}/api/bots`);
    console.log(`Digits:         http://localhost:${PORT}/api/digit`);
    console.log(`Balance guard:  http://localhost:${PORT}/api/balance-guard`);
    console.log(`Strategies:     http://localhost:${PORT}/debug/strategies`);
    console.log(`Health:         http://localhost:${PORT}/health/pipeline`);
    console.log(`Debug:          http://localhost:${PORT}/debug/pipeline`);
    console.log('==============================================');

    startWSPing();

    dataOrchestrator.recover()
      .then(() => console.log('Data Orchestrator initialised.'))
      .catch(err => console.warn('Data Orchestrator recover failed:', err.message));

    setTimeout(startCognitiveEngines, 2000);

    try {
      digitAnalyzer.start();
      digitAnalyzer.on('digitUpdate', (view) => broadcastToDashboards('digitUpdate', view));
      digitAnalyzer.on('digitSignal', (sig) => broadcastToDashboards('digitSignal', sig));
      console.log('Digit analyzer started.');
    } catch (err) {
      console.error('Digit analyzer failed:', err.message);
    }

    try {
      balanceGuard.start();
      balanceGuard.on && balanceGuard.on('triggered', () => {});
      console.log('Balance guard started.');
    } catch (err) {
      console.error('Balance guard failed:', err.message);
    }

    try {
      botRunner.on('botStarted', (d) => broadcastToDashboards('botStarted', d));
      botRunner.on('botStopped', (d) => broadcastToDashboards('botStopped', d));
      botRunner.on('botEntry', (d) => broadcastToDashboards('botEntry', d));
      botRunner.on('botResult', (d) => broadcastToDashboards('botResult', d));
      botRunner.on('botCycle', (d) => broadcastToDashboards('botCycle', d));
      botRunner.on('botError', (d) => broadcastToDashboards('botError', d));
      console.log('Bot runner wired to dashboards.');
    } catch (err) {
      console.error('Bot runner wiring failed:', err.message);
    }

    try { analyticsDashboard.start(); console.log('Analytics dashboard started.'); }
    catch (err) { console.error('Analytics dashboard failed:', err.message); }

    try {
      candleBootstrapper.bootstrap()
        .then(() => console.log('Candle bootstrap complete.'))
        .catch(err => console.warn('Candle bootstrap failed (non-fatal):', err.message));
    } catch (err) {
      console.warn('Candle bootstrap threw (non-fatal):', err.message);
    }

    setTimeout(() => {
      startDerivBroker().then(() => {
        const broker = getBroker('deriv_cfd');
        if (broker.isConnected()) {
          console.log('Broker ready — starting pipeline timer.');
          startPipelineTimer();
          setTimeout(() => {
            runPredictionPipelineAll().catch(err => {
              console.error('[Pipeline] Initial run error:', err.message);
            });
          }, 2000);
        } else {
          broker.once('ready', () => {
            console.log('Broker ready (delayed) — starting pipeline timer.');
            startPipelineTimer();
          });
        }
      }).catch(err => {
        console.error('startDerivBroker failed:', err.message);
        startPipelineTimer();
      });
    }, 3000);

    setTimeout(() => {
      console.log('==============================================');
      console.log('RTS Subsystem Status:');
      try {
        const broker = getBroker('deriv_cfd');
        console.log(`   Broker:            ${broker.isConnected() ? 'connected' : 'disconnected'}`);
      } catch (_) { console.log('   Broker:            not initialized'); }
      console.log(`   Pipeline timer:    ${pipelineTimer ? 'running' : 'stopped'}`);
      console.log(`   StrategyRanker:    ${_consensusCache.size > 0 ? _consensusCache.size + ' symbol(s)' : 'waiting'}`);
      console.log(`   Predictions:       ${_predictionCache.size} symbol(s)`);
      console.log(`   Opportunities:     ${_opportunityCache.size} symbol(s)`);
      console.log(`   Running bots:      ${botRunner.list().length}`);
      console.log(`   OTIE observers:    ${otie.observerCount || 0} contract(s)`);
      try { console.log(`   Market cache:      ${marketStateCache._cache.size} symbols`); } catch (_) {}
      console.log(`   Balance guard:     ${balanceGuard.getState().enabled ? 'active' : 'disabled'}`);
      console.log('==============================================');
    }, 20000);
  });

  async function shutdown(signal) {
    console.log(`\nReceived ${signal}, shutting down gracefully...`);
    if (wsPingTimer) clearInterval(wsPingTimer);
    if (pipelineTimer) clearInterval(pipelineTimer);
    try { botRunner.stopAll(); } catch (_) {}
    try {
      await dataOrchestrator.shutdown();
      if (otie && typeof otie.stop === 'function') otie.stop();
    } catch (err) { console.error('Shutdown error:', err.message); }
    try { if (analyticsDashboard.stop) analyticsDashboard.stop(); } catch (_) {}
    try { if (ranker.clearCache) ranker.clearCache(); } catch (_) {}
    try {
      const broker = getBroker('deriv_cfd');
      if (broker && broker.disconnect) await broker.disconnect();
    } catch (_) {}
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startServer().catch(err => {
  console.error('Server start error:', err);
  process.exit(1);
});
