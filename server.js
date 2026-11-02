// server.js – RTS Entry Point (Deriv-only, pattern-based, with balance guard)
//
// [FIX-S1] Replaced console.log/error/warn with the shared logger so log
//          levels and transports are consistent with the rest of the system.
//          The startup ASCII banner stays on console.log by design.
// [FIX-S2] WATCHED_SYMBOLS is now configurable via the WATCHED_SYMBOLS env
//          var (comma-separated). Falls back to the original 4-symbol list.
//          This lets you add synthetics without editing the file.
// [FIX-S3] _pipelineInFlight now has a 60s timeout so a stuck pipeline call
//          (broker getAccount hanging, etc.) cannot permanently block future
//          cycles for that symbol.
// [FIX-S4] New /debug/regime endpoint returns the current regime for every
//          watched symbol plus the last decision from decisionEngine. This
//          is the fastest way to confirm whether the "unknown regime"
//          coerce spam has stopped after the dataOrchestrator fix deploys.
// [FIX-S5] New /debug/orchestrator endpoint returns dataOrchestrator cache
//          stats, queue depths, and — critically — the per-symbol,
//          per-code publish counts for historicalState. If a symbol shows
//          a count under key 'unknown', we've located the source. If not,
//          the message is coming from a document mutated AFTER publish.
// [FIX-S6] dataOrchestrator.publish is wrapped (server startup only) to
//          increment _regimePublishCounts. This is a diagnostic hook —
//          wrapped call semantics are identical to the original.
// [FIX-S7] Pipeline NO_TRADE log lines are throttled to once per 60s per
//          symbol per reason. TRADE results always log at INFO. Previously
//          every cycle logged all 4 symbols regardless of whether anything
//          changed.
// [FIX-S8] runPredictionPipeline now explicitly logs when marketState
//          returns null (previously silent — masked missing-data conditions).
// [FIX-S9] sendDashboardInitialState broker/account calls are wrapped in a
//          5s timeout so a slow broker can't block a new WebSocket client
//          from receiving its initial state.
// [FIX-S10] marketState updates are broadcast to dashboards (type
//           'marketStateUpdate') after each pipeline cycle. The dashboard
//           previously had no real-time view of regime/quality changes.

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const WebSocket = require('ws');
const http = require('http');

const logger = require('./infrastructure/logger') || console;

const dashboardClients = new Set();

function broadcastToDashboards(type, data) {
  if (dashboardClients.size === 0) return;
  let message;
  try { message = JSON.stringify({ type, data }); }
  catch (err) {
    logger.error(`[WS] Failed to serialize '${type}':`, err.message);
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
const performanceMonitor = require('./core/performance/performanceMonitor');

const botRunner = require('./core/bots/runner');
const digitAnalyzer = require('./core/intelligence/digit/analyzer');
const balanceGuard = require('./core/risk/balanceGuard');

const { getBroker } = require('./core/execution/brokerFactory');

// --- OTIE lazily initialised (see initOtie) ---
let otie = null;

function normalizeSymbol(symbol) {
  if (!symbol) return '';
  return symbol.replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
}

const BROKER_SYMBOL_MAP = {
  EURUSD: 'frxEURUSD',
  GBPUSD: 'frxGBPUSD',
  USDJPY: 'frxUSDJPY',
  AUDUSD: 'frxAUDUSD',
  R_10: 'R_10',
  R_25: 'R_25',
  R_50: 'R_50',
  R_75: 'R_75',
  R_100: 'R_100',
};

function toBrokerSymbol(displaySymbol) {
  const key = normalizeSymbol(displaySymbol);
  return BROKER_SYMBOL_MAP[key] || displaySymbol;
}

const app = express();
const PORT = process.env.PORT || 5000;

// [FIX-S2] Watched symbols — configurable via env var.
const DEFAULT_WATCHED = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'];
const WATCHED_SYMBOLS = (process.env.WATCHED_SYMBOLS || DEFAULT_WATCHED.join(','))
  .split(',')
  .map(s => normalizeSymbol(s))
  .filter(Boolean);

connectDB();

const _consensusCache = new Map();
const _predictionCache = new Map();
const _opportunityCache = new Map();
const _pipelineInFlight = new Map(); // symbol -> Promise (dedupe)

// [FIX-S3] Pipeline in-flight timeout.
const PIPELINE_TIMEOUT_MS = 60 * 1000;

// [FIX-S7] Per-symbol log throttling for repeated NO_TRADE reasons.
const PIPELINE_LOG_THROTTLE_MS = 60 * 1000;
const _pipelineLogThrottle = new Map(); // symbol -> { reason, at }

// [FIX-S6] Regime-code publish counters per symbol. Populated by the
// wrapped dataOrchestrator.publish below. Used by /debug/orchestrator to
// locate the source of 'unknown' regime codes.
const _regimePublishCounts = {};
const _originalPublish = dataOrchestrator.publish.bind(dataOrchestrator);
dataOrchestrator.publish = function (key, data, metadata) {
  try {
    if (key === 'historicalState' && data && data.symbol) {
      const code = (data.regime && data.regime.code) || '(missing)';
      if (!_regimePublishCounts[data.symbol]) _regimePublishCounts[data.symbol] = {};
      _regimePublishCounts[data.symbol][code] =
        (_regimePublishCounts[data.symbol][code] || 0) + 1;
    }
  } catch (_) { /* never let a diagnostic hook break publish */ }
  return _originalPublish(key, data, metadata);
};

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
    logger.error('[Admin] Creation failed:', err.message);
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

app.use('/api/edge-test', require('./api/edgeController'));

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
    let deepDiagnostics = null;
    try {
      const ds = require('./core/intelligence/deep/marketState');
      deepBuffers = ds._buffers?.size || 0;
      deepDiagnostics = typeof ds.getDiagnostics === 'function' ? ds.getDiagnostics() : null;
    } catch (_) {}

    let dashboardMetrics = {};
    try {
      dashboardMetrics = analyticsDashboard.getMetrics ? analyticsDashboard.getMetrics() : {};
    } catch (_) {}

    let otieState = {};
    try {
      otieState = otie && otie.getAllStates ? otie.getAllStates() : {};
    } catch (_) {}

    res.json({
      timestamp: new Date().toISOString(),
      broker: {
        connected: broker.isConnected ? broker.isConnected() : false,
        publicState: brokerHealth.publicState,
        authState: brokerHealth.authState,
        contractMonitoring: brokerHealth.contractMonitoring,
        accountLoaded: brokerHealth.accountLoaded,
        // [FIX-C2] Surface portfolio dedupe + rate-limit stats
        portfolioDiagnostics: brokerHealth.portfolioDiagnostics,
        // [FIX-C1] Surface SL/TP conversion stats
        limitOrderDiagnostics: brokerHealth.limitOrderDiagnostics,
      },
      marketCache: { symbolCount: cache.size, symbols: Array.from(cache.keys()) },
      deepState: {
        bufferCount: deepBuffers,
        diagnostics: deepDiagnostics,
      },
      pipeline: { timerRunning: !!pipelineTimer },
      analyticsDashboard: {
        hasMetrics: Object.keys(dashboardMetrics).length > 0,
        totalTrades: dashboardMetrics.totalTrades || 0,
      },
      otie: {
        observerCount: (otie && otie.observerCount) || 0,
        states: otieState,
      },
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

// [FIX-S4] Regime debug — the fastest way to trace the 'unknown' coerce.
app.get('/debug/regime', (req, res) => {
  try {
    const regimes = {};
    for (const symbol of WATCHED_SYMBOLS) {
      const regime = deepRegime.getLatestRegime(symbol);
      const state = marketStateCache.get(symbol);
      const decision = decisionEngine.getLastDecision(symbol);
      regimes[symbol] = {
        regime: regime ? {
          code: regime.code,
          name: regime.name,
          confidence: regime.confidence,
          reason: regime.reason,
          family: regime.family,
        } : null,
        marketStateCachePresent: !!state,
        lastDecision: decision ? {
          decision: decision.decision,
          confidence: decision.confidence,
          reason: decision.reason,
        } : null,
      };
    }
    res.json({
      timestamp: new Date().toISOString(),
      symbols: regimes,
      regimePublishCounts: _regimePublishCounts,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// [FIX-S5] Orchestrator debug — exposes cache stats, queue depths, and
// historicalState publish counts by symbol AND regime code. If any symbol
// has a count under key 'unknown' here, we've located the source.
app.get('/debug/orchestrator', (req, res) => {
  try {
    const cacheStats = dataOrchestrator.getCacheStats();
    res.json({
      timestamp: new Date().toISOString(),
      cacheStats,
      regimePublishCounts: _regimePublishCounts,
      queues: {
        snapshotQueueLength: dataOrchestrator._snapshotQueue?.length || 0,
        appendQueueLength: dataOrchestrator._appendQueue?.length || 0,
      },
      warnedKeys: Array.from(dataOrchestrator._warnedKeys || []),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// [FIX-S5] Focused view: only the 'unknown' coerce source. Returns a
// compact summary that makes it obvious whether the fix worked.
app.get('/debug/regime-publish', (req, res) => {
  try {
    const summary = {};
    let hasUnknown = false;
    for (const [symbol, counts] of Object.entries(_regimePublishCounts)) {
      summary[symbol] = { ...counts };
      if (counts['unknown']) hasUnknown = true;
    }
    res.json({
      timestamp: new Date().toISOString(),
      hasUnknownCode: hasUnknown,
      bySymbol: summary,
      note: hasUnknown
        ? 'Some publisher is emitting historicalState with regime.code="unknown". Check the symbols with "unknown" entries — send core/data/candleBootstrapper.js or core/awareness/engine.js for further tracing.'
        : 'No historicalState doc with regime.code="unknown" has been published since server start. If coerce logs still appear, the code was mutated after publish (in the append queue) — check dataOrchestrator._handleResearch callers.',
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
          confidenceBreakdown: consensus.consensus?.confidenceBreakdown,   // [FIX-RN5]
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
  ws.on('error', (err) => logger.error('[WS] Error:', err.message));
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

// [FIX-S9] Wrap broker calls in a timeout so a slow broker can't block
// new WebSocket client initialization.
function withTimeout(promise, ms, fallback) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

async function sendDashboardInitialState(ws) {
  try {
    const accountService = require('./core/portfolio/accountService');
    const orderService = require('./core/execution/orderService');

    const [trades, account, positions] = await Promise.all([
      Trade.find({ status: 'OPEN' }).lean(),
      withTimeout(accountService.getAccount('deriv_cfd'), 5000, { balance: '0', currency: 'USD' }),
      withTimeout(orderService.getOpenTrades('deriv_cfd'), 5000, []),
    ]);

    let broker;
    try { broker = getBroker('deriv_cfd'); } catch (e) {}
    const enhancedAccount = enhanceAccount(account, broker);

    let otieState = {};
    try { otieState = otie && otie.getAllStates ? otie.getAllStates() : {}; } catch (_) {}

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
    logger.error('[WS] Failed to send initial state:', err.message);
  }
}

awarenessEngine.on('marketAwareness', (data) => broadcast('marketAwareness', data));
deepRegime.on('regime', (regime) => broadcast('regime', regime));
decisionEngine.on('decision', (decision) => broadcast('decision', decision));
eventBus.on('account.fetched', (account) => broadcast('account', account));
eventBus.on('trade.closed', (data) => broadcast('tradeClosed', data));
eventBus.on('order.placed', (data) => broadcast('trade.placed', data));
eventBus.on('position.updated', (data) => broadcast('positions', data));

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

    logger.info(
      `[StrategyPerformance] ${strategy}/${symbol} (${regimeCode}): ` +
      `pnl=${realizedProfit.toFixed(2)}$ R=${(realizedProfit/risk).toFixed(2)} ` +
      `trades=${updated.trades} wr=${(updated.winRate*100).toFixed(0)}% ` +
      `recentWR=${(updated.recentWinRate*100).toFixed(0)}% flagged=${updated.flagged}`
    );
  } catch (err) {
    logger.error(`[StrategyPerformance] Failed for ${contractId}: ${err.message}`);
  }
});

eventBus.on('trade.closed', async (data) => {
  try {
    const trade = await Trade.findOne({ contractId: String(data.contractId) });
    if (trade) performanceMonitor.recordTrade(trade);
  } catch (err) {
    logger.error('[PerformanceMonitor] Failed to record trade:', err.message);
  }
});
performanceMonitor.on('thresholdsUpdated', (thresholds) => {
  if (otie && typeof otie.updateConfig === 'function') {
    otie.updateConfig(thresholds);
  }
});

// [FIX-S7] Log helper with per-symbol throttling for repetitive reasons.
function logPipelineResult(symbol, reason, opportunity, level = 'info') {
  const now = Date.now();
  const prev = _pipelineLogThrottle.get(symbol);
  if (prev && prev.reason === reason && (now - prev.at) < PIPELINE_LOG_THROTTLE_MS) {
    return;
  }
  _pipelineLogThrottle.set(symbol, { reason, at: now });
  const detail = opportunity && opportunity.tradable
    ? `${opportunity.multiplier}x ${opportunity.direction} [${opportunity.source || '?'}]`
    : (opportunity && opportunity.reason) || reason;
  logger[level](`[Pipeline] ${symbol}: ${reason} — ${detail}`);
}

async function runPredictionPipeline(symbol, ctx = {}) {
  try {
    const state = await require('./core/intelligence/deep/marketState').compute(symbol, 'M5', 200);
    // [FIX-S8] Explicitly log null-state condition.
    if (!state) {
      logPipelineResult(symbol, 'NO_STATE', null, 'debug');
      return false;
    }

    let strategyConsensus = null;
    try {
      strategyConsensus = await ranker.rank(state, symbol, { timeframe: 'M5' });
      _consensusCache.set(symbol, strategyConsensus);
      broadcastToDashboards('strategyConsensus', flattenConsensus(strategyConsensus));
    } catch (rankErr) {
      logger.warn(`[Pipeline] Ranker failed for ${symbol}: ${rankErr.message}`);
    }

    const broker = getBroker('deriv_cfd');
    const account = ctx.account || await broker.getAccount();
    const positions = ctx.positions || await broker.getOpenTrades();

    const marketData = {
      currentPrice: state.price.current,
      spread: state.awareness?.spread || 0,
      timestamp: new Date().toISOString(),
    };

    const prediction = await predictor.predict(symbol, state, strategyConsensus, { timeframe: 'M5' });
    if (!prediction) {
      logPipelineResult(symbol, 'NO_PREDICTION', null, 'debug');
      return false;
    }
    _predictionCache.set(symbol, prediction);
    broadcastToDashboards('prediction', prediction);

    // [FIX-S10] Broadcast marketState summary so dashboard sees real-time state.
    try {
      broadcastToDashboards('marketStateUpdate', {
        symbol,
        timeframe: 'M5',
        regime: state.regime?.code,
        regimeConfidence: state.regime?.confidence,
        trend: state.trend?.direction,
        adx: state.trend?.adx,
        rsi: state.momentum?.rsi,
        atrPercent: state.volatility?.atrPercent,
        marketQuality: state.summary?.marketQuality,
        confidence: state.confidence,
        timestamp: state.time,
      });
    } catch (_) {}

    const opportunity = await opportunityEngine.evaluate(
      prediction, account, positions, marketData,
      { riskPerTradePct: parseFloat(process.env.RISK_PER_TRADE_PCT) || 1.0 }
    );
    _opportunityCache.set(symbol, opportunity);
    broadcastToDashboards('opportunity', opportunity);

    // [FIX-S7] Throttled pipeline logging.
    if (opportunity.tradable) {
      logPipelineResult(symbol, 'TRADE', opportunity, 'info');
    } else {
      logPipelineResult(symbol, `NO_TRADE_${opportunity.reason || 'UNKNOWN'}`, opportunity, 'debug');
    }
    return true;
  } catch (err) {
    logger.error(`[Pipeline] Error for ${symbol}:`, err.message);
    return false;
  }
}

// [FIX-S3] Add 60s timeout to prevent stuck in-flight entries.
function runPredictionPipelineOnce(symbol, ctx) {
  if (_pipelineInFlight.has(symbol)) return _pipelineInFlight.get(symbol);
  let timer = null;
  const p = Promise.race([
    runPredictionPipeline(symbol, ctx),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Pipeline timeout (${PIPELINE_TIMEOUT_MS}ms)`)), PIPELINE_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ])
    .catch(err => {
      logger.error(`[Pipeline] Uncaught for ${symbol}: ${err.message}`);
      return false;
    })
    .finally(() => {
      if (timer) clearTimeout(timer);
      _pipelineInFlight.delete(symbol);
    });
  _pipelineInFlight.set(symbol, p);
  return p;
}

async function runPredictionPipelineAll() {
  let ctx = { account: null, positions: null };
  try {
    const broker = getBroker('deriv_cfd');
    if (broker.isConnected()) {
      ctx.account = await broker.getAccount();
      ctx.positions = await broker.getOpenTrades();
    }
  } catch (e) {
    // Fall back to per-symbol fetch inside runPredictionPipeline
  }

  let ok = 0;
  const reasons = {};
  for (const symbol of WATCHED_SYMBOLS) {
    const result = await runPredictionPipelineOnce(symbol, ctx);
    if (result) {
      ok++;
      const opp = _opportunityCache.get(symbol);
      const key = opp?.tradable ? 'TRADE' : (opp?.reason || 'UNKNOWN');
      reasons[key] = (reasons[key] || 0) + 1;
    }
  }
  // [FIX-S7] Cycle summary — one line instead of N. Only log when it
  // changes or at INFO when trades occurred.
  const hasTrades = Object.prototype.hasOwnProperty.call(reasons, 'TRADE');
  const summary = `${ok}/${WATCHED_SYMBOLS.length} ran [${Object.entries(reasons).map(([k, v]) => `${k}×${v}`).join(', ') || 'no opportunities'}]`;
  if (hasTrades) logger.info(`[Pipeline] Cycle: ${summary}`);
  else logger.debug(`[Pipeline] Cycle: ${summary}`);
}

candleStore.on('candleClosed', async (candle) => {
  if (candle.timeframe === 'M5' && WATCHED_SYMBOLS.includes(normalizeSymbol(candle.symbol))) {
    await runPredictionPipelineOnce(normalizeSymbol(candle.symbol), {});
  }
});

let pipelineTimer = null;
function startPipelineTimer() {
  if (pipelineTimer) clearInterval(pipelineTimer);
  const intervalMs = parseInt(process.env.PREDICTION_INTERVAL_MS) || 30000;
  pipelineTimer = setInterval(() => {
    runPredictionPipelineAll().catch(err => {
      logger.error('[Pipeline] Timer error:', err.message);
    });
  }, intervalMs);
  logger.info(`[Pipeline] Timer started (${intervalMs}ms). Watched: ${WATCHED_SYMBOLS.join(', ')}`);
}

async function startCognitiveEngines() {
  try {
    logger.info('[CTOS] Cognitive engines active: Awareness, Regime, Decision, OTIE, StrategyRanker, BotRunner, DigitAnalyzer, BalanceGuard, EdgeTest.');
  } catch (err) {
    logger.error('[CTOS] Initialization error:', err.message);
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
    logger.info('[Deriv] Broker connected.');
    return broker;
  } catch (err) {
    logger.error('[Deriv] Failed to start Deriv broker:', err.message);
    throw err;
  }
}

function initOtie() {
  if (otie) return otie;
  try {
    otie = require('./core/intelligence/openTradeIntelligenceV5');
    otie.on('otieV5State', (state) => broadcast('otieV5State', state));
    otie.on('otieV5Action', (action) => broadcast('otieV5Action', action));
    otie.on('otieState', (state) => broadcast('otieState', state));
    logger.info('[OTIE] Post-auth initialisation hook attached.');
  } catch (err) {
    logger.error('[OTIE] Failed to initialise:', err.message);
  }
  return otie;
}

async function waitForBrokerReady(broker, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  if (typeof broker.waitForAuthReady === 'function') {
    try { await broker.waitForAuthReady(timeoutMs); }
    catch (e) { logger.warn('[Broker] auth ready timeout:', e.message); }
  }
  if (typeof broker.waitForPortfolio === 'function') {
    try { await broker.waitForPortfolio(timeoutMs); }
    catch (e) { logger.warn('[Broker] portfolio ready timeout:', e.message); }
  }
  while (Date.now() < deadline) {
    const ready = typeof broker.isReady === 'function'
      ? broker.isReady()
      : broker.isConnected && broker.isConnected();
    if (ready) return true;
    await sleep(250);
  }
  return !!(broker.isConnected && broker.isConnected());
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
    console.log(`Edge test:      http://localhost:${PORT}/api/edge-test/status`);
    console.log(`Digits:         http://localhost:${PORT}/api/digit`);
    console.log(`Balance guard:  http://localhost:${PORT}/api/balance-guard`);
    console.log(`Strategies:     http://localhost:${PORT}/debug/strategies`);
    console.log(`Regime:         http://localhost:${PORT}/debug/regime`);
    console.log(`Orchestrator:   http://localhost:${PORT}/debug/orchestrator`);
    console.log(`Regime publish: http://localhost:${PORT}/debug/regime-publish`);
    console.log(`Health:         http://localhost:${PORT}/health/pipeline`);
    console.log(`Debug:          http://localhost:${PORT}/debug/pipeline`);
    console.log('==============================================');

    startWSPing();

    dataOrchestrator.recover()
      .then(() => logger.info('Data Orchestrator initialised.'))
      .catch(err => logger.warn('Data Orchestrator recover failed:', err.message));

    setTimeout(startCognitiveEngines, 2000);

    try {
      digitAnalyzer.start();
      digitAnalyzer.on('digitUpdate', (view) => broadcastToDashboards('digitUpdate', view));
      digitAnalyzer.on('digitSignal', (sig) => broadcastToDashboards('digitSignal', sig));
      logger.info('Digit analyzer started.');
    } catch (err) {
      logger.error('Digit analyzer failed:', err.message);
    }

    try {
      balanceGuard.start();
      balanceGuard.on && balanceGuard.on('triggered', () => {});
      logger.info('Balance guard started.');
    } catch (err) {
      logger.error('Balance guard failed:', err.message);
    }

    try {
      botRunner.on('botStarted', (d) => broadcastToDashboards('botStarted', d));
      botRunner.on('botStopped', (d) => broadcastToDashboards('botStopped', d));
      botRunner.on('botEntry', (d) => broadcastToDashboards('botEntry', d));
      botRunner.on('botResult', (d) => broadcastToDashboards('botResult', d));
      botRunner.on('botCycle', (d) => broadcastToDashboards('botCycle', d));
      botRunner.on('botError', (d) => broadcastToDashboards('botError', d));
      logger.info('Bot runner wired to dashboards.');
    } catch (err) {
      logger.error('Bot runner wiring failed:', err.message);
    }

    try { analyticsDashboard.start(); logger.info('Analytics dashboard started.'); }
    catch (err) { logger.error('Analytics dashboard failed:', err.message); }

    (async () => {
      let broker;
      try {
        await new Promise(r => setTimeout(r, 3000));
        broker = await startDerivBroker();
      } catch (err) {
        logger.error('startDerivBroker failed:', err.message);
        startPipelineTimer();
        return;
      }

      const ready = await waitForBrokerReady(broker, 30000);
      if (!ready) {
        logger.warn('[Boot] Broker not fully ready after 30s — proceeding anyway.');
      }

      try {
        await candleBootstrapper.bootstrap();
        logger.info('Candle bootstrap complete.');
      } catch (err) {
        logger.warn('Candle bootstrap failed (non-fatal):', err.message);
      }

      initOtie();

      logger.info('Broker ready — starting pipeline timer.');
      startPipelineTimer();
      setTimeout(() => {
        runPredictionPipelineAll().catch(err => {
          logger.error('[Pipeline] Initial run error:', err.message);
        });
      }, 2000);
    })();

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
      console.log(`   OTIE observers:    ${(otie && otie.observerCount) || 0} contract(s)`);
      try { console.log(`   Market cache:      ${marketStateCache._cache.size} symbols`); } catch (_) {}
      console.log(`   Balance guard:     ${balanceGuard.getState().enabled ? 'active' : 'disabled'}`);
      console.log('==============================================');
    }, 20000);
  });

  async function shutdown(signal) {
    logger.info(`\nReceived ${signal}, shutting down gracefully...`);
    if (wsPingTimer) clearInterval(wsPingTimer);
    if (pipelineTimer) clearInterval(pipelineTimer);
    try { botRunner.stopAll(); } catch (_) {}
    try {
      await dataOrchestrator.shutdown();
      if (otie && typeof otie.stop === 'function') otie.stop();
    } catch (err) { logger.error('Shutdown error:', err.message); }
    try { if (analyticsDashboard.stop) analyticsDashboard.stop(); } catch (_) {}
    try { if (ranker.clearCache) ranker.clearCache(); } catch (_) {}
    try {
      const broker = getBroker('deriv_cfd');
      if (broker && broker.disconnect) await broker.disconnect();
    } catch (_) {}
    try { wss.close(); } catch (_) {}
    try { server.close(); } catch (_) {}
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startServer().catch(err => {
  logger.error('Server start error:', err);
  process.exit(1);
});
