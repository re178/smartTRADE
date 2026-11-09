// server.js – RTS Entry Point
//
// [FIX-S1]  Shared logger instead of raw console.*
// [FIX-S2]  WATCHED_SYMBOLS configurable via env var
// [FIX-S3]  Pipeline in-flight 60s timeout
// [FIX-S4]  /debug/regime endpoint
// [FIX-S5]  /debug/orchestrator + /debug/regime-publish endpoints
// [FIX-S6]  dataOrchestrator.publish wrapper for diagnostics
// [FIX-S7]  Pipeline NO_TRADE log throttling
// [FIX-S8]  Explicit null-state logging in runPredictionPipeline
// [FIX-S9]  sendDashboardInitialState broker calls wrapped in 5s timeout
// [FIX-S10] marketStateUpdate broadcasts to dashboards
// [FIX-S11] connectDB() awaited BEFORE ensureAdmin() and server.listen()
// [FIX-S12] /health and /health/pipeline report database state; 503 when DB is down
// [FIX-S13/S14/S15] RTS startup email via shared/emailProvider
//
// [FIX-AUTH] Full dashboard login wall (HMAC session, optional scrypt hash,
//           optional IP allowlist, login rate limiter, 7d TTL).
//
// [FIX-SWITCH] POST /api/account/switch — demo ⇄ real with guards.
//
// [FIX-COMMS] **Communication department integration.**
//
//   Adds:
//     • reportScheduler.start()  → daily reports at 00:00 EAT, weekly Fri 23:59 EAT
//     • securityMonitor.start()  → suspicious-login alerts + audit recording
//     • POST /api/reports/send-now   — manual trigger (daily|weekly|custom)
//     • GET  /api/reports/status     — scheduler diagnostics
//     • GET  /api/security/status    — security monitor diagnostics
//     • GET  /api/security/events    — paginated security audit trail
//
//   Auth events are piped into the monitor:
//     /api/login       → onLoginSuccess / onLoginFailure / onLoginRateLimited
//     /api/logout      → onLogout
//     /api/account/switch → onAccountSwitch
//
//   Reports fire independently of bot/pipeline activity — they summarize
//   whatever happened in the closed period. A quiet account still gets a
//   "no trades this period" report so you know the system was alive.
//
//   Both subsystems start AFTER MongoDB connects and stop during graceful
//   shutdown. Report catch-up runs on boot to backfill missed periods.
//
//   Endpoint auth: all new /api/reports/* and /api/security/* routes are
//   protected by the global auth middleware — no separate checks needed.

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const WebSocket = require('ws');
const http = require('http');
const os = require('os');
const crypto = require('crypto');

const logger = require('./infrastructure/logger') || console;
const { sendEmail } = require('./shared/emailProvider');

// [FIX-COMMS] Communication department
const reportScheduler = require('./services/communications/reportScheduler');
const securityMonitor = require('./services/communications/securityMonitor');

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
const SecurityEvent = require('./models/SecurityEvent');
const ReportLog = require('./models/ReportLog');

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

const DEFAULT_WATCHED = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'];
const WATCHED_SYMBOLS = (process.env.WATCHED_SYMBOLS || DEFAULT_WATCHED.join(','))
  .split(',')
  .map(s => normalizeSymbol(s))
  .filter(Boolean);

// ============================================================
// [FIX-AUTH] Configuration
// ============================================================

const AUTH_USERNAME        = process.env.DASHBOARD_USERNAME || '';
const AUTH_PASSWORD        = process.env.DASHBOARD_PASSWORD || '';
const AUTH_PASSWORD_HASH   = process.env.DASHBOARD_PASSWORD_HASH || '';
const SESSION_SECRET       = process.env.SESSION_SECRET || '';
const AUTH_ALLOWED_IPS_RAW = process.env.DASHBOARD_ALLOWED_IPS || '';

const AUTH_ALLOWED_IPS = AUTH_ALLOWED_IPS_RAW
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const AUTH_CONFIGURED = !!(
  AUTH_USERNAME &&
  SESSION_SECRET &&
  (AUTH_PASSWORD || AUTH_PASSWORD_HASH)
);

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IS_PROD = process.env.NODE_ENV === 'production';
const COOKIE_NAME = 'rts_session';

if (!AUTH_CONFIGURED) {
  logger.error('[Auth] ============================================');
  logger.error('[Auth] MISSING REQUIRED ENV VARS:');
  logger.error('[Auth]   Required: DASHBOARD_USERNAME, SESSION_SECRET,');
  logger.error('[Auth]             DASHBOARD_PASSWORD (or DASHBOARD_PASSWORD_HASH)');
  logger.error('[Auth] Dashboard will be INACCESSIBLE until these are set.');
  logger.error('[Auth] Generate SESSION_SECRET with: openssl rand -hex 32');
  logger.error('[Auth] ============================================');
} else {
  logger.info(`[Auth] Dashboard auth enabled for user "${AUTH_USERNAME}" · TTL 7d`);
  if (AUTH_PASSWORD_HASH) logger.info('[Auth] Password hashing: scrypt (hash configured)');
  else logger.info('[Auth] Password hashing: plaintext (set DASHBOARD_PASSWORD_HASH for max security)');
  if (AUTH_ALLOWED_IPS.length > 0) {
    logger.info(`[Auth] IP allowlist active: [${AUTH_ALLOWED_IPS.join(', ')}]`);
  }
}

function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    try { crypto.timingSafeEqual(ba, ba); } catch (_) {}
    return false;
  }
  try { return crypto.timingSafeEqual(ba, bb); } catch (_) { return false; }
}

function verifyPassword(plaintext, hashField, plaintextField) {
  if (hashField && hashField.startsWith('scrypt$')) {
    const parts = hashField.split('$');
    if (parts.length !== 3) return false;
    const [, saltHex, hashHex] = parts;
    try {
      const expected = Buffer.from(hashHex, 'hex');
      const actual = crypto.scryptSync(plaintext, Buffer.from(saltHex, 'hex'), expected.length);
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    } catch (_) { return false; }
  }
  if (plaintextField) return safeEq(plaintext, plaintextField);
  return false;
}

function signSession(userId) {
  const payload = { uid: userId, exp: Date.now() + SESSION_TTL_MS };
  const p64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(p64).digest('base64url');
  return `${p64}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const p64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(p64).digest('base64url');
  if (!safeEq(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(p64, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch (_) { return null; }
}

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const pair of h.split(';')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch (_) { out[k] = v; }
  }
  return out;
}

function getSession(req) {
  const cookies = parseCookies(req);
  return verifySession(cookies[COOKIE_NAME]);
}

const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_MAX = 5;
const _loginAttempts = new Map();

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const rec = _loginAttempts.get(ip);
  if (!rec) return { allowed: true };
  if (rec.lockedUntil && now < rec.lockedUntil) {
    return { allowed: false, retryInMs: rec.lockedUntil - now };
  }
  if (now - rec.firstAt > LOGIN_RATE_WINDOW_MS) {
    _loginAttempts.delete(ip);
    return { allowed: true };
  }
  return { allowed: true };
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const rec = _loginAttempts.get(ip) || { count: 0, firstAt: now, lockedUntil: 0 };
  if (now - rec.firstAt > LOGIN_RATE_WINDOW_MS) {
    rec.count = 0;
    rec.firstAt = now;
    rec.lockedUntil = 0;
  }
  rec.count++;
  if (rec.count >= LOGIN_RATE_MAX) {
    rec.lockedUntil = now + LOGIN_RATE_WINDOW_MS;
  }
  _loginAttempts.set(ip, rec);
}

function clearLoginFailures(ip) {
  _loginAttempts.delete(ip);
}

function isIpAllowed(ip) {
  if (AUTH_ALLOWED_IPS.length === 0) return true;
  return AUTH_ALLOWED_IPS.includes(ip);
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>RTS · Sign In</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet" />
<link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<style>
  * { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; }
  body { margin: 0; min-height: 100vh; background: #0f1e33;
         display: flex; align-items: center; justify-content: center; color: #1e2a41; }
  .wrap { width: 100%; max-width: 380px; padding: 20px; }
  .brand { text-align: center; color: #fff; margin-bottom: 28px; }
  .brand i { color: #1a73e8; font-size: 2.4rem; }
  .brand h1 { font-size: 1.4rem; font-weight: 800; margin: 10px 0 2px; }
  .brand small { color: #94a3b8; font-size: 0.7rem; letter-spacing: 0.05em; }
  .card { background: #fff; border-radius: 12px; padding: 30px 26px;
          box-shadow: 0 10px 40px rgba(0,0,0,0.35); }
  .card h2 { font-size: 1.1rem; font-weight: 600; margin-bottom: 20px; }
  .form-label { font-size: 0.8rem; font-weight: 600; color: #6b7a8f; }
  .form-control { border-radius: 8px; border-color: #e9edf2; padding: 10px 14px; }
  .form-control:focus { border-color: #1a73e8; box-shadow: 0 0 0 0.2rem rgba(26,115,232,0.15); }
  .btn-primary { background: #1a73e8; border: none; border-radius: 8px; padding: 11px; font-weight: 600; }
  .btn-primary:hover { background: #1557b0; }
  .btn-primary:disabled { background: #94a3b8; }
  .err { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;
         padding: 10px 14px; border-radius: 8px; font-size: 0.85rem;
         margin-bottom: 16px; display: none; }
  .err.show { display: block; }
  .footer { text-align: center; margin-top: 20px; color: #5a6f8a; font-size: 0.7rem; }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">
    <i class="fas fa-chart-line"></i>
    <h1>RTS</h1>
    <small>v2.0 · LIVE TRADING</small>
  </div>
  <div class="card">
    <h2><i class="fas fa-lock me-2" style="color:#1a73e8;"></i>Sign In</h2>
    <div id="error" class="err"></div>
    <form id="loginForm" autocomplete="off">
      <div class="mb-3">
        <label class="form-label">Username</label>
        <input type="text" class="form-control" id="username" required autofocus />
      </div>
      <div class="mb-3">
        <label class="form-label">Password</label>
        <input type="password" class="form-control" id="password" required />
      </div>
      <button type="submit" class="btn btn-primary w-100" id="submitBtn">
        <i class="fas fa-sign-in-alt me-1"></i> Sign In
      </button>
    </form>
  </div>
  <div class="footer">Ray Trading Systems · Authorized access only</div>
</div>
<script>
(function() {
  var form = document.getElementById('loginForm');
  var errEl = document.getElementById('error');
  var btn = document.getElementById('submitBtn');
  function showErr(m) { errEl.textContent = m; errEl.classList.add('show'); }

  form.addEventListener('submit', async function(e) {
    e.preventDefault();
    errEl.classList.remove('show');
    var u = document.getElementById('username').value;
    var p = document.getElementById('password').value;
    if (!u || !p) return;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin me-1"></i> Signing in...';
    try {
      var r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p })
      });
      var d = {};
      try { d = await r.json(); } catch (_) {}
      if (r.ok && d.success) { window.location.href = '/'; return; }
      showErr(d.error || 'Login failed');
    } catch (err) {
      showErr('Network error: ' + err.message);
    }
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-sign-in-alt me-1"></i> Sign In';
  });
})();
</script>
</body>
</html>`;

// ============================================================
// Cache + pipeline state
// ============================================================

const _consensusCache = new Map();
const _predictionCache = new Map();
const _opportunityCache = new Map();
const _pipelineInFlight = new Map();

const PIPELINE_TIMEOUT_MS = 60 * 1000;
const PIPELINE_LOG_THROTTLE_MS = 60 * 1000;
const _pipelineLogThrottle = new Map();

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
  } catch (_) {}
  return _originalPublish(key, data, metadata);
};

// ============================================================
// Startup email
// ============================================================

function getRTSLanAddresses(port) {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.internal || entry.family !== 'IPv4') continue;
      const ip = entry.address;
      const isPrivate =
        ip.startsWith('10.') ||
        ip.startsWith('192.168.') ||
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip);
      if (isPrivate) {
        addresses.push({ interface: interfaceName, ip, url: `http://${ip}:${port}` });
      }
    }
  }
  return addresses;
}

async function sendRTSStartupNotification(port) {
  const addresses = getRTSLanAddresses(port);
  const addressHTML = addresses.length
    ? addresses.map(item => `
        <p>
          <strong>${item.interface}</strong><br>
          IP: ${item.ip}<br>
          <a href="${item.url}">${item.url}</a>
        </p>
      `).join('')
    : '<p>No private LAN IPv4 address was detected.</p>';

  const html = `
    <h2>RTS Laptop Startup Successful</h2>
    <p>Your Ray Trading Hub server has started successfully.</p>
    <p><strong>Status:</strong> ONLINE</p>
    <p><strong>Database:</strong> CONNECTED</p>
    <p><strong>Auth:</strong> ${AUTH_CONFIGURED ? 'ENABLED' : 'MISCONFIGURED'}</p>
    <p><strong>Port:</strong> ${port}</p>
    <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
    <hr>
    <h3>Current Laptop Network Addresses</h3>
    ${addressHTML}
    <hr>
    <p>RTS Automatic Startup Notification</p>`;

  const to = process.env.RTS_NOTIFY_EMAIL || process.env.ALERT_EMAIL || process.env.SUPPORT_EMAIL;
  if (!to) { logger.error('[Notify] No recipient configured'); return; }
  const keyPresent = !!process.env.BREVO_API_KEY;
  const sender = process.env.SUPPORT_EMAIL || 'support@voxtraapp.com';
  logger.info(`[Notify] Sending startup email -> to=${to} sender=${sender} keyPresent=${keyPresent}`);
  if (!keyPresent) { logger.error('[Notify] BREVO_API_KEY missing'); return; }
  try {
    const result = await sendEmail(to, 'RTS is ONLINE - Laptop Startup Notification', html);
    if (result && result.success) { logger.info(`[Notify] Startup email SENT to ${to}`); return; }
    logger.error(`[Notify] Startup email FAILED: ${(result && result.error) || 'unknown'}`);
  } catch (error) { logger.error(`[Notify] Startup email threw: ${error.message}`); }
}

// ============================================================
// Utilities
// ============================================================

function flattenConsensus(consensus) {
  if (!consensus || !consensus.consensus) return null;
  const c = consensus.consensus;
  return {
    symbol: consensus.symbol, timeframe: consensus.timeframe, regime: consensus.regime,
    evaluatedAt: consensus.evaluatedAt, action: c.action, direction: c.direction,
    confidence: c.confidence, anchorStrategy: c.anchorStrategy,
    agreeing: c.agreeing || [], conflicting: c.conflicting || [],
    buyWeight: c.buyWeight, sellWeight: c.sellWeight,
    activeCount: c.activeCount, silentCount: c.silentCount, flaggedCount: c.flaggedCount,
    reasons: c.reasons || [],
    strategies: (consensus.strategies || []).map(r => ({
      name: r.name, signalSide: r.signalSide, status: r.status,
      weight: Number((r.weight || 0).toFixed(3)),
      effectiveWinRate: Number((r.effectiveWinRate || 0).toFixed(3)),
      trades: r.trades || 0, flagged: !!r.flagged,
    })),
  };
}

async function ensureAdmin() {
  try {
    let admin = await User.findOne({ userId: 'admin' });
    if (!admin) {
      admin = new User({ userId: 'admin', tradingProduct: 'deriv_cfd' });
      await admin.save();
    } else if (admin.tradingProduct === 'mt5') {
      admin.tradingProduct = 'deriv_cfd';
      await admin.save();
    }
  } catch (err) { logger.error('[Admin] Creation failed:', err.message); }
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

// ============================================================
// [FIX-AUTH] Login / logout / auth-check (public)
// Each auth hook also feeds securityMonitor so suspicious activity
// is recorded + alerted automatically.
// ============================================================

app.get('/login', (req, res) => {
  const session = getSession(req);
  if (session) return res.redirect('/');
  res.type('html').send(LOGIN_HTML);
});

app.post('/api/login', async (req, res) => {
  if (!AUTH_CONFIGURED) {
    return res.status(503).json({
      error: 'Server not configured. Set DASHBOARD_USERNAME, SESSION_SECRET, DASHBOARD_PASSWORD on Render.',
    });
  }

  const ip = getClientIp(req);
  const userAgent = req.headers['user-agent'] || null;

  if (!isIpAllowed(ip)) {
    logger.warn(`[Auth] Login blocked by IP allowlist: ${ip}`);
    try { await securityMonitor.onLoginFailure(ip, userAgent, 'IP not in allowlist', null); } catch (_) {}
    return res.status(403).json({ error: 'Access denied from this IP' });
  }

  const rateCheck = checkLoginRateLimit(ip);
  if (!rateCheck.allowed) {
    const retryMin = Math.ceil((rateCheck.retryInMs || 0) / 60000);
    logger.warn(`[Auth] Login rate-limited for ${ip} (retry in ${retryMin}m)`);
    try { await securityMonitor.onLoginRateLimited(ip, userAgent, req.body?.username || null); } catch (_) {}
    return res.status(429).json({
      error: `Too many failed attempts. Try again in ${retryMin} minute(s).`,
    });
  }

  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const uOk = safeEq(String(username), AUTH_USERNAME);
  const pOk = verifyPassword(String(password), AUTH_PASSWORD_HASH, AUTH_PASSWORD);

  if (!uOk || !pOk) {
    recordLoginFailure(ip);
    logger.warn(`[Auth] Failed login from ${ip} (user="${String(username).slice(0, 32)}")`);
    try { await securityMonitor.onLoginFailure(ip, userAgent, 'Invalid credentials', String(username)); } catch (_) {}
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  clearLoginFailures(ip);
  const token = signSession('admin');
  const cookieParts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (IS_PROD) cookieParts.push('Secure');
  res.setHeader('Set-Cookie', cookieParts.join('; '));

  logger.info(`[Auth] Login OK from ${ip}`);
  // Non-blocking — security hooks must not delay login response
  securityMonitor.onLoginSuccess(ip, userAgent, String(username)).catch(err => {
    logger.warn(`[Auth] securityMonitor.onLoginSuccess failed: ${err.message}`);
  });
  return res.json({ success: true, user: { id: 'admin' } });
});

app.post('/api/logout', async (req, res) => {
  const ip = getClientIp(req);
  const cookieParts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (IS_PROD) cookieParts.push('Secure');
  res.setHeader('Set-Cookie', cookieParts.join('; '));
  logger.info(`[Auth] Logout from ${ip}`);
  securityMonitor.onLogout(ip).catch(err => {
    logger.warn(`[Auth] securityMonitor.onLogout failed: ${err.message}`);
  });
  return res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  return res.json({ user: { id: session.uid }, configured: AUTH_CONFIGURED });
});

// ============================================================
// [FIX-AUTH] Global auth gate
// ============================================================
const PUBLIC_PATHS = new Set([
  '/login', '/api/login', '/api/logout', '/api/auth/me',
  '/health', '/health/pipeline', '/favicon.ico',
]);

app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  const session = getSession(req);
  if (session) {
    req.user = { id: session.uid };
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized', redirect: '/login' });
  }
  return res.redirect('/login');
});

// ============================================================
// Static + user context
// ============================================================
app.use(express.static('public'));

app.use(async (req, res, next) => {
  try {
    let admin = await User.findOne({ userId: 'admin' });
    if (!admin) {
      const defaultProduct = process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd';
      admin = new User({ userId: 'admin', tradingProduct: defaultProduct });
      await admin.save();
    }
    if (!req.user) req.user = { id: 'admin' };
    req.user.tradingProduct = admin.tradingProduct;
    next();
  } catch (err) {
    if (!req.user) req.user = { id: 'admin' };
    req.user.tradingProduct = process.env.DEFAULT_TRADING_PRODUCT || 'deriv_cfd';
    next();
  }
});

app.use('/api', apiRoutes);
app.use('/api', botRoutes);
app.use('/api/edge-test', require('./api/edgeController'));

// ============================================================
// [FIX-COMMS] Reports endpoints
// ============================================================

app.post('/api/reports/send-now', async (req, res) => {
  try {
    const { type, from, to } = req.body || {};
    if (!['daily', 'weekly', 'custom'].includes(type)) {
      return res.status(400).json({ error: 'type must be daily, weekly, or custom' });
    }
    const result = await reportScheduler.triggerReport({
      type,
      from: from ? new Date(from) : null,
      to: to ? new Date(to) : null,
      trigger: 'manual',
    });
    return res.json({ success: true, result });
  } catch (err) {
    logger.error(`[Reports] send-now failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/status', async (req, res) => {
  try {
    const status = reportScheduler.getStatus();
    const lastDaily = await ReportLog.lastSuccessful('daily');
    const lastWeekly = await ReportLog.lastSuccessful('weekly');
    const recentFailures = await ReportLog.find({ status: 'failed' })
      .sort({ createdAt: -1 })
      .limit(5)
      .select({ type: 1, periodStart: 1, periodEnd: 1, error: 1, createdAt: 1 })
      .lean();
    res.json({
      scheduler: status,
      lastDaily: lastDaily ? {
        sentAt: lastDaily.sentAt,
        periodStart: lastDaily.periodStart,
        periodEnd: lastDaily.periodEnd,
      } : null,
      lastWeekly: lastWeekly ? {
        sentAt: lastWeekly.sentAt,
        periodStart: lastWeekly.periodStart,
        periodEnd: lastWeekly.periodEnd,
      } : null,
      recentFailures: recentFailures.map(f => ({
        type: f.type,
        periodStart: f.periodStart,
        periodEnd: f.periodEnd,
        error: f.error,
        at: f.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// [FIX-COMMS] Security endpoints
// ============================================================

app.get('/api/security/status', (req, res) => {
  try { res.json(securityMonitor.getStatus()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/security/events', async (req, res) => {
  try {
    const {
      since, eventType, severity, ip,
      limit = 100, skip = 0,
    } = req.query;

    const query = {};
    if (since) query.createdAt = { $gte: new Date(since) };
    if (eventType) query.eventType = eventType;
    if (severity) query.severity = severity;
    if (ip) query.ip = ip;

    const lim = Math.min(Math.max(1, parseInt(limit) || 100), 500);
    const sk = Math.max(0, parseInt(skip) || 0);

    const [events, total] = await Promise.all([
      SecurityEvent.find(query)
        .sort({ createdAt: -1 })
        .limit(lim)
        .skip(sk)
        .lean(),
      SecurityEvent.countDocuments(query),
    ]);

    res.json({
      total,
      limit: lim,
      skip: sk,
      events: events.map(e => ({
        id: String(e._id),
        ip: e.ip,
        userId: e.userId,
        username: e.username,
        eventType: e.eventType,
        severity: e.severity,
        message: e.message,
        context: e.context,
        alerted: e.alerted,
        alertedAt: e.alertedAt,
        alertError: e.alertError,
        at: e.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// [FIX-SWITCH] POST /api/account/switch
// ============================================================

app.post('/api/account/switch', async (req, res) => {
  const { accountType } = req.body || {};
  if (accountType !== 'demo' && accountType !== 'real') {
    return res.status(400).json({ success: false, error: 'accountType must be "demo" or "real"' });
  }

  const ip = getClientIp(req);

  let broker;
  try { broker = getBroker('deriv_cfd'); }
  catch (err) {
    return res.status(500).json({ success: false, error: 'Broker not initialized' });
  }

  if (typeof broker.switchAccountType !== 'function') {
    return res.status(501).json({
      success: false,
      error: 'Broker does not support account switching. Deploy updated core/execution/broker.js first.',
    });
  }

  const previousType = broker.config?.accountType || 'demo';

  let positions = [];
  try { positions = await broker.getOpenTrades(); }
  catch (_) { positions = []; }
  if (Array.isArray(positions) && positions.length > 0) {
    securityMonitor.onAccountSwitch(ip, previousType, accountType, false).catch(() => {});
    return res.status(400).json({
      success: false,
      error: `Cannot switch: ${positions.length} open position(s). Close all positions on the current account first.`,
      positions: positions.map(p => ({
        id: p.id, instrument: p.instrument, side: p.side,
        units: p.units, unrealizedPL: p.unrealizedPL,
      })),
    });
  }

  let running = [];
  try { running = botRunner.list() || []; }
  catch (_) { running = []; }
  if (Array.isArray(running) && running.length > 0) {
    securityMonitor.onAccountSwitch(ip, previousType, accountType, false).catch(() => {});
    return res.status(400).json({
      success: false,
      error: `Cannot switch: ${running.length} bot(s) running. Stop all bots first.`,
      runningBots: running.map(b => ({
        instanceId: b.instanceId, botId: b.botId, name: b.name, symbol: b.symbol,
      })),
    });
  }

  try {
    logger.info(`[Switch] API request: → ${accountType}`);
    const result = await broker.switchAccountType(accountType);
    logger.info(`[Switch] API success: now on ${result.accountType} (changed=${result.changed})`);

    securityMonitor.onAccountSwitch(ip, previousType, accountType, true).catch(() => {});

    try {
      broadcastToDashboards('account', {
        id: result.account?.id,
        balance: result.account?.balance,
        currency: result.account?.currency,
        accountType: result.account?.accountType || accountType,
        equity: result.account?.equity,
        server: (result.account?.accountType === 'demo') ? 'demo' : 'real',
      });
    } catch (_) {}

    return res.json({
      success: true,
      changed: result.changed,
      previousAccountType: result.previousAccountType,
      accountType: result.accountType,
      account: result.account,
    });
  } catch (err) {
    logger.error(`[Switch] API failed: ${err.message}`);
    securityMonitor.onAccountSwitch(ip, previousType, accountType, false).catch(() => {});

    if (err.code === 'OPEN_POSITIONS') {
      return res.status(400).json({
        success: false,
        error: err.message,
        positions: err.positions || [],
      });
    }

    return res.status(500).json({
      success: false,
      error: err.message,
      previousAccountType: err.previousAccountType || null,
      targetAccountType: err.targetAccountType || accountType,
    });
  }
});

// ============================================================
// Health endpoints (public — see PUBLIC_PATHS)
// ============================================================

app.get('/health', (req, res) => {
  const databaseConnected = mongoose.connection.readyState === 1;
  if (!databaseConnected) {
    return res.status(503).json({
      status: 'STARTING', database: 'DISCONNECTED',
      message: 'RTS is waiting for MongoDB',
      readyState: mongoose.connection.readyState,
      authConfigured: AUTH_CONFIGURED,
      timestamp: new Date().toISOString(),
    });
  }
  res.status(200).json({
    status: 'OK', database: 'CONNECTED',
    message: 'RTS is running with Deriv broker',
    authConfigured: AUTH_CONFIGURED,
    timestamp: new Date().toISOString(),
  });
});

app.get('/health/pipeline', async (req, res) => {
  try {
    const broker = getBroker('deriv_cfd');
    const connected = broker.isConnected ? broker.isConnected() : false;
    const cache = marketStateCache._cache || new Map();
    const hasMarketData = cache.size > 0;
    const hasConsensus = _consensusCache.size > 0;
    const hasBots = botRunner.list().length > 0;
    const dbConnected = mongoose.connection.readyState === 1;
    const healthy = connected && hasMarketData && hasConsensus && dbConnected;
    res.status(healthy ? 200 : 503).json({
      healthy, brokerConnected: connected, databaseConnected: dbConnected,
      marketCachePopulated: hasMarketData, strategyConsensusActive: hasConsensus,
      runningBots: hasBots, timestamp: new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ error: err.message, healthy: false }); }
});

// ============================================================
// Existing endpoints (all protected by auth middleware above)
// ============================================================

app.get('/api/balance-guard', (req, res) => {
  try { res.json(balanceGuard.getState()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/balance-guard/reset', (req, res) => {
  try {
    balanceGuard.reset();
    res.json({ success: true, state: balanceGuard.getState() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Debug endpoints
// ============================================================

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
    try { dashboardMetrics = analyticsDashboard.getMetrics ? analyticsDashboard.getMetrics() : {}; } catch (_) {}

    let otieState = {};
    try { otieState = otie && otie.getAllStates ? otie.getAllStates() : {}; } catch (_) {}

    res.json({
      timestamp: new Date().toISOString(),
      database: {
        connected: mongoose.connection.readyState === 1,
        readyState: mongoose.connection.readyState,
      },
      auth: {
        configured: AUTH_CONFIGURED,
        passwordHashing: AUTH_PASSWORD_HASH ? 'scrypt' : 'plaintext',
        ipAllowlist: AUTH_ALLOWED_IPS,
        failedAttempts: _loginAttempts.size,
      },
      comms: {
        reportScheduler: reportScheduler.getStatus(),
        securityMonitor: securityMonitor.getStatus(),
      },
      broker: {
        connected: broker.isConnected ? broker.isConnected() : false,
        publicState: brokerHealth.publicState,
        authState: brokerHealth.authState,
        contractMonitoring: brokerHealth.contractMonitoring,
        accountLoaded: brokerHealth.accountLoaded,
        portfolioDiagnostics: brokerHealth.portfolioDiagnostics,
        limitOrderDiagnostics: brokerHealth.limitOrderDiagnostics,
        accountType: brokerHealth.accountType,
      },
      marketCache: { symbolCount: cache.size, symbols: Array.from(cache.keys()) },
      deepState: { bufferCount: deepBuffers, diagnostics: deepDiagnostics },
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

app.get('/debug/regime', (req, res) => {
  try {
    const regimes = {};
    for (const symbol of WATCHED_SYMBOLS) {
      const regime = deepRegime.getLatestRegime(symbol);
      const state = marketStateCache.get(symbol);
      const decision = decisionEngine.getLastDecision(symbol);
      regimes[symbol] = {
        regime: regime ? {
          code: regime.code, name: regime.name,
          confidence: regime.confidence, reason: regime.reason, family: regime.family,
        } : null,
        marketStateCachePresent: !!state,
        lastDecision: decision ? {
          decision: decision.decision, confidence: decision.confidence, reason: decision.reason,
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
        ? 'Some publisher is emitting historicalState with regime.code="unknown".'
        : 'No historicalState doc with regime.code="unknown" has been published since server start.',
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
          confidenceBreakdown: consensus.consensus?.confidenceBreakdown,
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
      reportScheduler: reportScheduler.getStatus().running ? 'running' : 'stopped',
      securityMonitor: securityMonitor.getStatus().running ? 'running' : 'stopped',
    },
    database: {
      connected: mongoose.connection.readyState === 1,
      readyState: mongoose.connection.readyState,
    },
    lastCandle: candleStore.getHistory('EURUSD', 'M5', 1)[0] || null,
    lastMarketState: lastState,
    lastRegime,
    lastDecision,
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// SPA catch-all
// ============================================================
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'API endpoint not found' });
  }
});

// ============================================================
// HTTP + WebSocket servers (auth-checked upgrade)
// ============================================================
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const session = getSession(req);
  if (!session) {
    try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); } catch (_) {}
    try { socket.destroy(); } catch (_) {}
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

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

// ============================================================
// Event subscriptions
// ============================================================

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

  if (!strategy || !instrument || !Number.isFinite(realizedProfit)) return;

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

// ============================================================
// Prediction pipeline
// ============================================================

function logPipelineResult(symbol, reason, opportunity, level = 'info') {
  const now = Date.now();
  const prev = _pipelineLogThrottle.get(symbol);
  if (prev && prev.reason === reason && (now - prev.at) < PIPELINE_LOG_THROTTLE_MS) return;
  _pipelineLogThrottle.set(symbol, { reason, at: now });
  const detail = opportunity && opportunity.tradable
    ? `${opportunity.multiplier}x ${opportunity.direction} [${opportunity.source || '?'}]`
    : (opportunity && opportunity.reason) || reason;
  logger[level](`[Pipeline] ${symbol}: ${reason} — ${detail}`);
}

async function runPredictionPipeline(symbol, ctx = {}) {
  try {
    const state = await require('./core/intelligence/deep/marketState').compute(symbol, 'M5', 200);
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
  } catch (e) {}

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

    broker.on('accountSwitched', (data) => {
      logger.info(`[Deriv] Account switched: ${data.previousAccountType} → ${data.newAccountType}`);
      broadcastToDashboards('account', {
        id: data.account?.id,
        balance: data.account?.balance,
        currency: data.account?.currency,
        accountType: data.account?.accountType || data.newAccountType,
        equity: data.account?.equity,
        server: data.newAccountType,
      });
    });

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

// ============================================================
// startServer
// ============================================================
async function startServer() {
  await connectDB();
  await ensureAdmin();

  server.listen(PORT, () => {
    console.log('==============================================');
    console.log(`RTS server running on http://localhost:${PORT}`);
    console.log(`Database:       MongoDB connected`);
    console.log(`Auth:           ${AUTH_CONFIGURED ? 'ENABLED' : 'MISCONFIGURED — set DASHBOARD_USERNAME, DASHBOARD_PASSWORD, SESSION_SECRET'}`);
    if (AUTH_PASSWORD_HASH) console.log(`Password mode:  scrypt (hashed)`);
    else if (AUTH_PASSWORD) console.log(`Password mode:  plaintext (set DASHBOARD_PASSWORD_HASH for max security)`);
    if (AUTH_ALLOWED_IPS.length > 0) console.log(`IP allowlist:   [${AUTH_ALLOWED_IPS.join(', ')}]`);
    console.log(`Login:          http://localhost:${PORT}/login`);
    console.log(`Dashboard:      http://localhost:${PORT}`);
    console.log(`API base:       http://localhost:${PORT}/api`);
    console.log(`Reports:        /api/reports/status`);
    console.log(`Security:       /api/security/status`);
    console.log(`Health:         http://localhost:${PORT}/health`);
    console.log('==============================================');

    // Startup email — fire-and-forget after port bound
    sendRTSStartupNotification(PORT).catch(err => {
      logger.error('[Notify] sendRTSStartupNotification threw:', err.message);
    });

    // [FIX-COMMS] Start report scheduler + security monitor AFTER DB + admin
    try {
      reportScheduler.start();
      logger.info('[Comms] Report scheduler started');
    } catch (err) {
      logger.error('[Comms] Report scheduler failed to start:', err.message);
    }
    try {
      securityMonitor.start();
      logger.info('[Comms] Security monitor started');
    } catch (err) {
      logger.error('[Comms] Security monitor failed to start:', err.message);
    }

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
      botRunner.on('botShadowPlaced', (d) => broadcastToDashboards('botShadowPlaced', d));
      botRunner.on('botShadowResolved', (d) => broadcastToDashboards('botShadowResolved', d));
      botRunner.on('botCompoundGrow', (d) => broadcastToDashboards('botCompoundGrow', d));
      botRunner.on('botCompoundReset', (d) => broadcastToDashboards('botCompoundReset', d));
      botRunner.on('botTrailingExit', (d) => broadcastToDashboards('botTrailingExit', d));
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
      try {
        console.log('==============================================');
        console.log('RTS Subsystem Status:');
        console.log(`   Database:          ${mongoose.connection.readyState === 1 ? 'connected' : 'DISCONNECTED'}`);
        try {
          const broker = getBroker('deriv_cfd');
          console.log(`   Broker:            ${broker.isConnected() ? 'connected' : 'disconnected'}`);
          console.log(`   Account type:      ${broker.config.accountType}`);
        } catch (_) { console.log('   Broker:            not initialized'); }
        console.log(`   Pipeline timer:    ${pipelineTimer ? 'running' : 'stopped'}`);
        console.log(`   StrategyRanker:    ${_consensusCache.size > 0 ? _consensusCache.size + ' symbol(s)' : 'waiting'}`);
        console.log(`   Predictions:       ${_predictionCache.size} symbol(s)`);
        console.log(`   Opportunities:     ${_opportunityCache.size} symbol(s)`);
        console.log(`   Running bots:      ${botRunner.list().length}`);
        console.log(`   OTIE observers:    ${(otie && otie.observerCount) || 0} contract(s)`);
        try { console.log(`   Market cache:      ${marketStateCache._cache.size} symbols`); } catch (_) {}
        console.log(`   Balance guard:     ${balanceGuard.getState().enabled ? 'active' : 'disabled'}`);
        console.log(`   Auth:              ${AUTH_CONFIGURED ? 'enabled' : 'MISCONFIGURED'}`);

        // [FIX-STATUS-LOG] Defensive — no debug log should crash the process.
        let rs = {};
        try { rs = reportScheduler.getStatus() || {}; } catch (e) { rs = { error: e.message }; }
        let sm = {};
        try { sm = securityMonitor.getStatus() || {}; } catch (e) { sm = { error: e.message }; }
        const smAlerts = (sm && sm.alerts) || {};

        if (rs.error) {
          console.log(`   Report scheduler:  ERROR — ${rs.error}`);
        } else {
          console.log(`   Report scheduler:  ${rs.running ? 'running' : 'stopped'} (next daily in ${rs.nextDailyInMs ? Math.round(rs.nextDailyInMs / 60000) + 'm' : '—'})`);
        }
        if (sm.error) {
          console.log(`   Security monitor:  ERROR — ${sm.error}`);
        } else {
          console.log(`   Security monitor:  ${sm.running ? 'running' : 'stopped'} (alerts sent: ${smAlerts.sent ?? 0}, failed: ${smAlerts.failed ?? 0})`);
        }
        console.log('==============================================');
      } catch (outerErr) {
        console.error('[Startup] Status log itself failed (non-fatal):', outerErr.message);
      }
    }, 20000); 
  });

  async function shutdown(signal) {
    logger.info(`\nReceived ${signal}, shutting down gracefully...`);
    if (wsPingTimer) clearInterval(wsPingTimer);
    if (pipelineTimer) clearInterval(pipelineTimer);
    try { botRunner.stopAll(); } catch (_) {}
    try { reportScheduler.stop(); } catch (_) {}
    try { securityMonitor.stop(); } catch (_) {}
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
    try { await mongoose.connection.close(); } catch (_) {}
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
