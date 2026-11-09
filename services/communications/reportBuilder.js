// services/communications/reportBuilder.js
// Assembles report data (daily / weekly / custom) from Mongo + broker.
//
// [FIX-REPORT-BUILDER] **Full report data assembly.**
//
//   Three public builders (buildDailyReport, buildWeeklyReport,
//   buildCustomReport) share one internal pipeline:
//
//     1. _gatherCommonData(from, to)   — parallel fetches everything
//     2. _buildHtmlReport(data, meta)  — rich email body
//     3. _buildPdfReport(...)          — PDF buffer via reportGenerator
//     4. _buildSubject(type, ...)      — auto-generated subject line
//     5. _buildStats(data)             — small summary for ReportLog.stats
//
//   Returns:
//     {
//       type: 'daily' | 'weekly' | 'custom',
//       periodStart, periodEnd, timezone, generatedAt,
//       subject,                        // email subject
//       html,                           // email body (inside wrapper)
//       pdfBuffer,                      // Buffer or null (PDF failed)
//       stats: {...},                   // ReportLog.stats payload
//       structured: {...},              // full data for logging/debugging
//     }
//
//   Data sources (each independently try/caught — one failure never kills
//   the whole report):
//     • accountService.getAccount       — current balance / equity / type
//     • orderService.getOpenTrades      — current open positions snapshot
//     • Trade.find({ status:'CLOSED' }) — closed trades in period
//     • BotRun.find({ status:'CLOSED' })— bot runs in period
//     • StrategyPerformance.topStrategies(20) — top strategies
//     • calculateMetrics                — win rate, PF, Sharpe, DD, etc.
//     • generateReport                  — PDF buffer
//
//   Every consumer of this module (reportScheduler, /api/reports/send-now)
//   receives the exact same shape — no branches in callers.

'use strict';

const crypto = require('crypto');

const Trade = require('../../models/Trade');
const BotRun = require('../../models/BotRun');
const StrategyPerformance = require('../../models/StrategyPerformance');

const accountService = require('../../core/portfolio/accountService');
const orderService = require('../../core/execution/orderService');
const { getBroker } = require('../../core/execution/brokerFactory');
const { calculateMetrics } = require('../../core/analytics/performanceSuite');

const logger = require('../../infrastructure/logger') || console;

// All reports use this timezone for boundary computation labels.
// The scheduler computes periodStart/periodEnd in this TZ before
// calling the builder — the builder only uses it for display formatting.
const TIMEZONE = 'Africa/Nairobi';

const PRODUCT = 'deriv_cfd';

// ─────────────────────────────────────────────────────────────
// Fetch helpers — every one is fail-safe
// ─────────────────────────────────────────────────────────────

async function _fetchAccount() {
  try {
    const acc = await accountService.getAccount(PRODUCT);
    let enhanced = acc;
    try {
      const broker = getBroker(PRODUCT);
      const derivedType = broker?.config?.accountType || null;
      if (derivedType) enhanced = { ...acc, accountType: derivedType };
    } catch (_) {}
    return enhanced;
  } catch (err) {
    logger.warn(`[ReportBuilder] Account fetch failed: ${err.message}`);
    return { balance: '0', equity: '0', currency: 'USD', accountType: 'demo', stale: true };
  }
}

async function _fetchOpenPositions() {
  try {
    const positions = await orderService.getOpenTrades(PRODUCT);
    return Array.isArray(positions) ? positions : [];
  } catch (err) {
    logger.warn(`[ReportBuilder] Open positions fetch failed: ${err.message}`);
    return [];
  }
}

async function _fetchClosedTrades(periodStart, periodEnd) {
  try {
    return await Trade.find({
      status: 'CLOSED',
      closeTime: { $gte: periodStart, $lt: periodEnd },
    })
      .sort({ closeTime: 1 })
      .lean();
  } catch (err) {
    logger.warn(`[ReportBuilder] Closed trades fetch failed: ${err.message}`);
    return [];
  }
}

async function _fetchBotRuns(periodStart, periodEnd) {
  try {
    return await BotRun.find({
      status: 'CLOSED',
      closedAt: { $gte: periodStart, $lt: periodEnd },
    })
      .sort({ closedAt: 1 })
      .lean();
  } catch (err) {
    logger.warn(`[ReportBuilder] BotRun fetch failed: ${err.message}`);
    return [];
  }
}

async function _fetchStrategySummary() {
  try {
    const raw = await StrategyPerformance.topStrategies(20);
    if (!Array.isArray(raw)) return [];
    return raw.map(s => ({
      strategy: s.strategy || '?',
      symbol: s.symbol || '?',
      trades: Number(s.trades) || 0,
      wins: Number(s.wins) || 0,
      losses: Number(s.losses) || 0,
      winRate: Number(s.winRate) || 0,
      avgR: Number(s.avgR) || 0,
      recentWinRate: Number(s.recentWinRate) || 0,
      flagged: !!s.flagged,
    }));
  } catch (err) {
    logger.warn(`[ReportBuilder] Strategy fetch failed: ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// Summarization — pure functions over raw docs
// ─────────────────────────────────────────────────────────────

/**
 * Map Trade docs into the shape `generateReport` expects.
 * Matches api/controllers.js's mapping exactly.
 */
function _mapTradesForPdf(rawTrades) {
  return rawTrades.map(t => ({
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

function _summarizeBots(botRuns) {
  const map = new Map();
  for (const r of botRuns) {
    if (!r.botId) continue;
    let agg = map.get(r.botId);
    if (!agg) {
      agg = { botId: r.botId, trades: 0, wins: 0, losses: 0, pnl: 0 };
      map.set(r.botId, agg);
    }
    agg.trades++;
    const pnl = Number(r.realizedProfit ?? r.pnl ?? 0) || 0;
    agg.pnl += pnl;
    if (r.result === 'WIN' || pnl > 0) agg.wins++;
    else if (r.result === 'LOSS' || pnl < 0) agg.losses++;
  }
  const list = Array.from(map.values());
  for (const b of list) {
    b.winRate = b.trades > 0 ? b.wins / b.trades : 0;
    b.pnl = Math.round(b.pnl * 100) / 100;
  }
  list.sort((a, b) => b.pnl - a.pnl);
  return list;
}

function _summarizeShadow(botRuns) {
  const map = new Map();
  for (const r of botRuns) {
    if (!r.shadowEnabled) continue;
    if (!r.botId) continue;
    let agg = map.get(r.botId);
    if (!agg) {
      agg = {
        botId: r.botId,
        shadowWins: 0, shadowLosses: 0,
        gateSum: 0, gateCount: 0,
        totalTightens: 0,
      };
      map.set(r.botId, agg);
    }
    const ss = r.shadowStats || {};
    agg.shadowWins += Number(ss.wins || 0) || 0;
    agg.shadowLosses += Number(ss.losses || 0) || 0;
    if (Number.isFinite(Number(r.gateAtEntry))) {
      agg.gateSum += Number(r.gateAtEntry);
      agg.gateCount++;
    }
    agg.totalTightens += Number(r.gateTightenCount) || 0;
  }
  const list = Array.from(map.values());
  for (const s of list) {
    const total = s.shadowWins + s.shadowLosses;
    s.shadowWinRate = total > 0 ? s.shadowWins / total : 0;
    s.avgGate = s.gateCount > 0 ? Number((s.gateSum / s.gateCount).toFixed(2)) : null;
  }
  list.sort((a, b) => b.shadowWins - a.shadowWins);
  return list;
}

function _summarizeHighPayout(botRuns) {
  const classes = {
    touch:       { trades: 0, wins: 0, losses: 0, pnl: 0 },
    vanilla:     { trades: 0, wins: 0, losses: 0, pnl: 0 },
    turbo:       { trades: 0, wins: 0, losses: 0, pnl: 0 },
    accumulator: { trades: 0, wins: 0, losses: 0, pnl: 0 },
  };
  const typeMap = {
    ONETOUCH: 'touch', NOTOUCH: 'touch',
    VANILLALONGCALL: 'vanilla', VANILLALONGPUT: 'vanilla',
    TURBOSLONG: 'turbo', TURBOSSHORT: 'turbo',
    ACCU: 'accumulator',
  };
  for (const r of botRuns) {
    const cls = typeMap[r.contractType];
    if (!cls) continue;
    const pnl = Number(r.realizedProfit ?? r.pnl ?? 0) || 0;
    classes[cls].trades++;
    classes[cls].pnl += pnl;
    if (r.result === 'WIN' || pnl > 0) classes[cls].wins++;
    else if (r.result === 'LOSS' || pnl < 0) classes[cls].losses++;
  }
  for (const key of Object.keys(classes)) {
    const c = classes[key];
    c.winRate = c.trades > 0 ? c.wins / c.trades : 0;
    c.pnl = Math.round(c.pnl * 100) / 100;
  }
  return classes;
}

// ─────────────────────────────────────────────────────────────
// Common data gatherer
// ─────────────────────────────────────────────────────────────

async function _gatherCommonData(periodStart, periodEnd) {
  const [account, openPositions, closedTrades, botRuns, strategySummary] = await Promise.all([
    _fetchAccount(),
    _fetchOpenPositions(),
    _fetchClosedTrades(periodStart, periodEnd),
    _fetchBotRuns(periodStart, periodEnd),
    _fetchStrategySummary(),
  ]);

  const tradesForPdf = _mapTradesForPdf(closedTrades);

  let metrics = {};
  try {
    const balanceNum = parseFloat(account.balance) || 10000;
    metrics = calculateMetrics(tradesForPdf, balanceNum);
  } catch (err) {
    logger.warn(`[ReportBuilder] calculateMetrics failed: ${err.message}`);
    metrics = {
      winRate: 0, profitFactor: 0, sharpe: 0, maxDrawdown: 0,
      expectancy: 0, totalTrades: closedTrades.length, dailyPnL: 0,
      currentDrawdown: 0,
    };
  }

  const totalPnl = closedTrades.reduce(
    (sum, t) => sum + (Number(t.realizedProfit ?? t.pnl ?? 0) || 0),
    0
  );

  return {
    periodStart,
    periodEnd,
    timezone: TIMEZONE,
    generatedAt: new Date(),
    account,
    openPositions,
    closedTrades,
    tradesForPdf,
    metrics,
    totalPnl: Math.round(totalPnl * 100) / 100,
    botRuns,
    botSummary: _summarizeBots(botRuns),
    shadowSummary: _summarizeShadow(botRuns),
    highPayoutSummary: _summarizeHighPayout(botRuns),
    strategySummary,
  };
}

// ─────────────────────────────────────────────────────────────
// Display helpers — all pure, all fail-safe
// ─────────────────────────────────────────────────────────────

function _formatDateTime(date) {
  try {
    const d = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(d.getTime())) return '—';
    return d.toLocaleString('en-GB', {
      timeZone: TIMEZONE,
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch (_) { return '—'; }
}

function _formatDate(date) {
  try {
    const d = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(d.getTime())) return '—';
    return d.toLocaleDateString('en-GB', {
      timeZone: TIMEZONE,
      year: 'numeric', month: 'short', day: '2-digit',
    });
  } catch (_) { return '—'; }
}

function _formatMoney(n, currency) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const sign = v >= 0 ? '' : '-';
  const abs = Math.abs(v).toFixed(2);
  const cur = currency || 'USD';
  return `${sign}$${abs} ${cur}`;
}

function _formatPct(n, decimals = 1) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(decimals)}%`;
}

function _formatPeriodLabel(type, periodStart, periodEnd) {
  if (type === 'daily') {
    return _formatDate(periodStart);
  }
  if (type === 'weekly') {
    return `${_formatDate(periodStart)} → ${_formatDate(periodEnd)}`;
  }
  return `${_formatDateTime(periodStart)} → ${_formatDateTime(periodEnd)}`;
}

function _escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _pnlColor(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return '#6b7a8f';
  return v > 0 ? '#00b894' : '#e74c5e';
}

// ─────────────────────────────────────────────────────────────
// Section renderers — each returns an HTML string, never throws
// ─────────────────────────────────────────────────────────────

function _renderKpiCards(data) {
  const m = data.metrics || {};
  const acc = data.account || {};
  const currency = acc.currency || 'USD';

  const cards = [
    { label: 'Balance',    value: _formatMoney(parseFloat(acc.balance) || 0, currency), color: '#1a73e8' },
    { label: 'Net P&L',    value: _formatMoney(data.totalPnl, currency),                color: _pnlColor(data.totalPnl) },
    { label: 'Trades',     value: String(m.totalTrades || data.closedTrades.length),     color: '#1e2a41' },
    { label: 'Win Rate',   value: _formatPct(m.winRate || 0),                            color: (m.winRate || 0) >= 0.5 ? '#00b894' : '#e74c5e' },
    { label: 'Profit Factor', value: (m.profitFactor === Infinity || m.profitFactor === null) ? '∞' : Number(m.profitFactor || 0).toFixed(2), color: '#1e2a41' },
    { label: 'Expectancy', value: _formatMoney(m.expectancy || 0, currency),             color: _pnlColor(m.expectancy) },
    { label: 'Max DD',     value: _formatPct(m.maxDrawdown || 0),                         color: '#e74c5e' },
    { label: 'Sharpe',     value: Number(m.sharpe || 0).toFixed(2),                      color: '#1e2a41' },
  ];

  return `
    <div style="display:flex; flex-wrap:wrap; gap:10px; margin:20px 0;">
      ${cards.map(c => `
        <div style="flex:1 1 calc(25% - 10px); min-width:140px; background:#f8fafc; border:1px solid #e9edf2; border-radius:8px; padding:12px 14px;">
          <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.05em; color:#6b7a8f; font-weight:600;">${_escapeHtml(c.label)}</div>
          <div style="font-size:20px; font-weight:700; color:${c.color}; margin-top:4px;">${_escapeHtml(c.value)}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function _renderAccountSnapshot(data) {
  const acc = data.account || {};
  const openCount = Array.isArray(data.openPositions) ? data.openPositions.length : 0;
  const type = (acc.accountType || 'demo').toUpperCase();
  const typeColor = type === 'REAL' ? '#00b894' : '#f39c12';

  return `
    <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:8px; padding:14px 18px; margin:16px 0;">
      <table style="width:100%; border-collapse:collapse; font-size:13px;">
        <tr>
          <td style="padding:4px 0; color:#6b7a8f;">Account</td>
          <td style="padding:4px 0; font-weight:600; text-align:right;">${_escapeHtml(acc.id || '—')}</td>
        </tr>
        <tr>
          <td style="padding:4px 0; color:#6b7a8f;">Type</td>
          <td style="padding:4px 0; font-weight:700; text-align:right; color:${typeColor};">${_escapeHtml(type)}</td>
        </tr>
        <tr>
          <td style="padding:4px 0; color:#6b7a8f;">Currency</td>
          <td style="padding:4px 0; font-weight:600; text-align:right;">${_escapeHtml(acc.currency || 'USD')}</td>
        </tr>
        <tr>
          <td style="padding:4px 0; color:#6b7a8f;">Open Positions</td>
          <td style="padding:4px 0; font-weight:600; text-align:right;">${openCount}</td>
        </tr>
        <tr>
          <td style="padding:4px 0; color:#6b7a8f;">Balance</td>
          <td style="padding:4px 0; font-weight:700; text-align:right;">${_formatMoney(parseFloat(acc.balance) || 0, acc.currency)}</td>
        </tr>
        <tr>
          <td style="padding:4px 0; color:#6b7a8f;">Equity</td>
          <td style="padding:4px 0; font-weight:700; text-align:right;">${_formatMoney(parseFloat(acc.equity) || 0, acc.currency)}</td>
        </tr>
      </table>
    </div>
  `;
}

function _renderNoTradesNotice(data) {
  if (data.closedTrades.length > 0) return '';
  return `
    <div style="background:#fef3c7; border:1px solid #fde68a; border-radius:8px; padding:14px 18px; margin:16px 0; color:#92400e; font-size:13px;">
      <strong>No trades closed in this period.</strong>
      Balance and open positions above are current as of ${_formatDateTime(data.generatedAt)}.
    </div>
  `;
}

function _renderBotRankings(data) {
  if (!Array.isArray(data.botSummary) || data.botSummary.length === 0) return '';
  const currency = data.account?.currency || 'USD';
  return `
    <h3 style="font-size:15px; margin:24px 0 10px; color:#1e2a41; border-bottom:2px solid #1a73e8; padding-bottom:6px;">
      🤖 Bot Rankings
    </h3>
    <table style="width:100%; border-collapse:collapse; font-size:12px;">
      <thead>
        <tr style="background:#f1f5f9;">
          <th style="text-align:left; padding:8px 6px; font-weight:600; color:#475569;">Bot</th>
          <th style="text-align:right; padding:8px 6px; font-weight:600; color:#475569;">Trades</th>
          <th style="text-align:right; padding:8px 6px; font-weight:600; color:#475569;">W</th>
          <th style="text-align:right; padding:8px 6px; font-weight:600; color:#475569;">L</th>
          <th style="text-align:right; padding:8px 6px; font-weight:600; color:#475569;">Win %</th>
          <th style="text-align:right; padding:8px 6px; font-weight:600; color:#475569;">P&amp;L</th>
        </tr>
      </thead>
      <tbody>
        ${data.botSummary.map(b => `
          <tr style="border-bottom:1px solid #e9edf2;">
            <td style="padding:8px 6px; font-weight:500;">${_escapeHtml(b.botId)}</td>
            <td style="padding:8px 6px; text-align:right;">${b.trades}</td>
            <td style="padding:8px 6px; text-align:right; color:#00b894; font-weight:600;">${b.wins}</td>
            <td style="padding:8px 6px; text-align:right; color:#e74c5e; font-weight:600;">${b.losses}</td>
            <td style="padding:8px 6px; text-align:right;">${(b.winRate * 100).toFixed(0)}%</td>
            <td style="padding:8px 6px; text-align:right; font-weight:700; color:${_pnlColor(b.pnl)};">${_formatMoney(b.pnl, currency)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function _renderStrategyRankings(data) {
  if (!Array.isArray(data.strategySummary) || data.strategySummary.length === 0) return '';
  const top = data.strategySummary.slice(0, 10);
  return `
    <h3 style="font-size:15px; margin:24px 0 10px; color:#1e2a41; border-bottom:2px solid #1a73e8; padding-bottom:6px;">
      📊 Top Strategies
    </h3>
    <table style="width:100%; border-collapse:collapse; font-size:12px;">
      <thead>
        <tr style="background:#f1f5f9;">
          <th style="text-align:left; padding:8px 6px; font-weight:600; color:#475569;">Strategy</th>
          <th style="text-align:left; padding:8px 6px; font-weight:600; color:#475569;">Symbol</th>
          <th style="text-align:right; padding:8px 6px; font-weight:600; color:#475569;">Trades</th>
          <th style="text-align:right; padding:8px 6px; font-weight:600; color:#475569;">Win %</th>
          <th style="text-align:right; padding:8px 6px; font-weight:600; color:#475569;">Recent</th>
          <th style="text-align:right; padding:8px 6px; font-weight:600; color:#475569;">Avg R</th>
          <th style="text-align:center; padding:8px 6px; font-weight:600; color:#475569;">Status</th>
        </tr>
      </thead>
      <tbody>
        ${top.map(s => `
          <tr style="border-bottom:1px solid #e9edf2;">
            <td style="padding:8px 6px; font-weight:500;">${_escapeHtml(s.strategy)}</td>
            <td style="padding:8px 6px; color:#6b7a8f;">${_escapeHtml(s.symbol)}</td>
            <td style="padding:8px 6px; text-align:right;">${s.trades}</td>
            <td style="padding:8px 6px; text-align:right; font-weight:600; color:${s.winRate >= 0.5 ? '#00b894' : '#e74c5e'};">${(s.winRate * 100).toFixed(0)}%</td>
            <td style="padding:8px 6px; text-align:right; color:#6b7a8f;">${(s.recentWinRate * 100).toFixed(0)}%</td>
            <td style="padding:8px 6px; text-align:right; font-weight:600; color:${_pnlColor(s.avgR)};">${Number(s.avgR).toFixed(2)}</td>
            <td style="padding:8px 6px; text-align:center;">
              ${s.flagged ? '<span style="background:#fef2f2; color:#991b1b; padding:2px 8px; border-radius:10px; font-size:10px; font-weight:600;">FLAGGED</span>' : '<span style="color:#6b7a8f;">—</span>'}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function _renderShadowSection(data) {
  if (!Array.isArray(data.shadowSummary) || data.shadowSummary.length === 0) return '';
  return `
    <h3 style="font-size:15px; margin:24px 0 10px; color:#1e2a41; border-bottom:2px solid #d97706; padding-bottom:6px;">
      👤 Shadow Phase Summary
    </h3>
    <table style="width:100%; border-collapse:collapse; font-size:12px;">
      <thead>
        <tr style="background:#fffbeb;">
          <th style="text-align:left; padding:8px 6px; font-weight:600; color:#92400e;">Bot</th>
          <th style="text-align:right; padding:8px 6px; font-weight:600; color:#92400e;">Shadow Wins</th>
          <th style="text-align:right; padding:8px 6px; font-weight:600; color:#92400e;">Shadow Losses</th>
          <th style="text-align:right; padding:8px 6px; font-weight:600; color:#92400e;">Win %</th>
          <th style="text-align:right; padding:8px 6px; font-weight:600; color:#92400e;">Avg Gate</th>
          <th style="text-align:right; padding:8px 6px; font-weight:600; color:#92400e;">Tightens</th>
        </tr>
      </thead>
      <tbody>
        ${data.shadowSummary.map(s => `
          <tr style="border-bottom:1px solid #e9edf2;">
            <td style="padding:8px 6px; font-weight:500;">${_escapeHtml(s.botId)}</td>
            <td style="padding:8px 6px; text-align:right; color:#00b894; font-weight:600;">${s.shadowWins}</td>
            <td style="padding:8px 6px; text-align:right; color:#e74c5e; font-weight:600;">${s.shadowLosses}</td>
            <td style="padding:8px 6px; text-align:right;">${(s.shadowWinRate * 100).toFixed(0)}%</td>
            <td style="padding:8px 6px; text-align:right;">${s.avgGate != null ? s.avgGate : '—'}</td>
            <td style="padding:8px 6px; text-align:right;">${s.totalTightens}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function _renderHighPayoutSection(data) {
  const hp = data.highPayoutSummary || {};
  const classes = Object.keys(hp);
  const hasData = classes.some(k => (hp[k]?.trades || 0) > 0);
  if (!hasData) return '';
  const currency = data.account?.currency || 'USD';

  return `
    <h3 style="font-size:15px; margin:24px 0 10px; color:#1e2a41; border-bottom:2px solid #9333ea; padding-bottom:6px;">
      💎 High-Payout Contract Performance
    </h3>
    <table style="width:100%; border-collapse:collapse; font-size:12px;">
      <thead>
        <tr style="background:#faf5ff;">
          <th style="text-align:left; padding:8px 6px; font-weight:600; color:#6b21a8;">Contract Class</th>
          <th style="text-align:right; padding:8px 6px; font-weight:600; color:#6b21a8;">Trades</th>
          <th style="text-align:right; padding:8px 6px; font-weight:600; color:#6b21a8;">W</th>
          <th style="text-align:right; padding:8px 6px; font-weight:600; color:#6b21a8;">L</th>
          <th style="text-align:right; padding:8px 6px; font-weight:600; color:#6b21a8;">Win %</th>
          <th style="text-align:right; padding:8px 6px; font-weight:600; color:#6b21a8;">P&amp;L</th>
        </tr>
      </thead>
      <tbody>
        ${classes.map(k => {
          const c = hp[k];
          if (!c || c.trades === 0) return '';
          return `
            <tr style="border-bottom:1px solid #e9edf2;">
              <td style="padding:8px 6px; font-weight:500; text-transform:capitalize;">${_escapeHtml(k)}</td>
              <td style="padding:8px 6px; text-align:right;">${c.trades}</td>
              <td style="padding:8px 6px; text-align:right; color:#00b894; font-weight:600;">${c.wins}</td>
              <td style="padding:8px 6px; text-align:right; color:#e74c5e; font-weight:600;">${c.losses}</td>
              <td style="padding:8px 6px; text-align:right;">${(c.winRate * 100).toFixed(0)}%</td>
              <td style="padding:8px 6px; text-align:right; font-weight:700; color:${_pnlColor(c.pnl)};">${_formatMoney(c.pnl, currency)}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function _renderRecentTrades(data) {
  if (!Array.isArray(data.closedTrades) || data.closedTrades.length === 0) return '';
  const currency = data.account?.currency || 'USD';
  // Show last 25 — full list is in the PDF attachment
  const recent = data.closedTrades.slice(-25).reverse();
  const truncated = data.closedTrades.length > 25;

  return `
    <h3 style="font-size:15px; margin:24px 0 10px; color:#1e2a41; border-bottom:2px solid #00b894; padding-bottom:6px;">
      📈 Recent Closed Trades ${truncated ? `<span style="font-size:11px; font-weight:400; color:#6b7a8f;">(last 25 of ${data.closedTrades.length})</span>` : ''}
    </h3>
    <table style="width:100%; border-collapse:collapse; font-size:11px;">
      <thead>
        <tr style="background:#f0fdf4;">
          <th style="text-align:left; padding:6px 4px; font-weight:600; color:#065f46;">Time</th>
          <th style="text-align:left; padding:6px 4px; font-weight:600; color:#065f46;">Pair</th>
          <th style="text-align:left; padding:6px 4px; font-weight:600; color:#065f46;">Side</th>
          <th style="text-align:right; padding:6px 4px; font-weight:600; color:#065f46;">Entry</th>
          <th style="text-align:right; padding:6px 4px; font-weight:600; color:#065f46;">Exit</th>
          <th style="text-align:right; padding:6px 4px; font-weight:600; color:#065f46;">P&amp;L</th>
          <th style="text-align:center; padding:6px 4px; font-weight:600; color:#065f46;">Result</th>
        </tr>
      </thead>
      <tbody>
        ${recent.map(t => {
          const pnl = Number(t.realizedProfit ?? t.pnl ?? 0);
          const result = t.result || (pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'BE');
          const resultColor = result === 'WIN' ? '#00b894' : result === 'LOSS' ? '#e74c5e' : '#6b7a8f';
          return `
            <tr style="border-bottom:1px solid #f1f5f9;">
              <td style="padding:6px 4px; color:#6b7a8f;">${_formatDateTime(t.closeTime)}</td>
              <td style="padding:6px 4px; font-weight:500;">${_escapeHtml(t.instrument || '?')}</td>
              <td style="padding:6px 4px;">
                <span style="background:${t.side === 'BUY' ? '#d1fae5' : '#fee2e2'}; color:${t.side === 'BUY' ? '#065f46' : '#991b1b'}; padding:2px 6px; border-radius:4px; font-size:10px; font-weight:600;">
                  ${_escapeHtml(t.side || '?')}
                </span>
              </td>
              <td style="padding:6px 4px; text-align:right; font-family:monospace; font-size:10px;">${_escapeHtml(String(t.openPrice || t.entryPrice || '—'))}</td>
              <td style="padding:6px 4px; text-align:right; font-family:monospace; font-size:10px;">${_escapeHtml(String(t.closePrice || '—'))}</td>
              <td style="padding:6px 4px; text-align:right; font-weight:700; color:${_pnlColor(pnl)};">${_formatMoney(pnl, currency)}</td>
              <td style="padding:6px 4px; text-align:center;">
                <span style="color:${resultColor}; font-weight:600; font-size:10px;">${result}</span>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
    ${truncated ? `<p style="font-size:11px; color:#6b7a8f; text-align:center; margin-top:8px;">Full trade list is in the attached PDF.</p>` : ''}
  `;
}

// ─────────────────────────────────────────────────────────────
// Report builders (HTML body + PDF)
// ─────────────────────────────────────────────────────────────

function _buildHtmlReport(data, meta) {
  const type = meta.type;
  const titleLabel = type === 'daily' ? 'Daily Report'
                    : type === 'weekly' ? 'Weekly Report'
                    : 'Custom Report';
  const periodLabel = _formatPeriodLabel(type, data.periodStart, data.periodEnd);

  return `
    <div style="max-width:900px; margin:0 auto; padding:20px; background:#fff; font-family:-apple-system,BlinkMacSystemFont,'Inter',Arial,sans-serif; color:#1e2a41;">
      <div style="border-bottom:3px solid #1a73e8; padding-bottom:14px; margin-bottom:8px;">
        <h1 style="margin:0; font-size:24px; color:#1a73e8;">RTS ${titleLabel}</h1>
        <p style="margin:6px 0 0; color:#6b7a8f; font-size:13px;">${_escapeHtml(periodLabel)} · ${TIMEZONE}</p>
        <p style="margin:2px 0 0; color:#6b7a8f; font-size:11px;">Generated ${_formatDateTime(data.generatedAt)}</p>
      </div>

      ${_renderAccountSnapshot(data)}
      ${_renderKpiCards(data)}
      ${_renderNoTradesNotice(data)}
      ${_renderBotRankings(data)}
      ${_renderStrategyRankings(data)}
      ${_renderShadowSection(data)}
      ${_renderHighPayoutSection(data)}
      ${_renderRecentTrades(data)}

      <div style="margin-top:32px; padding-top:14px; border-top:1px solid #e9edf2; text-align:center; color:#94a3b8; font-size:11px;">
        <p style="margin:0;">RTS Automated Reporting System</p>
        <p style="margin:4px 0 0;">${_escapeHtml(TIMEZONE)} · Report ID: ${_escapeHtml(meta.reportId || '—')}</p>
      </div>
    </div>
  `;
}

async function _buildPdfReport(data, meta) {
  try {
    const { generateReport } = require('../../core/reporting/reportGenerator');

    const reportHash = crypto.createHash('sha256')
      .update(JSON.stringify({
        periodStart: data.periodStart,
        periodEnd: data.periodEnd,
        totalPnl: data.totalPnl,
        tradeCount: data.closedTrades.length,
      }))
      .digest('hex')
      .slice(0, 16);

    const pdfBuffer = await generateReport({
      fromDate: data.periodStart,
      toDate: data.periodEnd,
      trades: data.tradesForPdf,
      metrics: data.metrics,
      account: data.account,
      verificationCode: reportHash,
      systemName: 'RTS v2.0',
      reportType: meta.type,
    });

    if (!Buffer.isBuffer(pdfBuffer)) {
      logger.warn(`[ReportBuilder] generateReport returned non-Buffer — PDF skipped`);
      return null;
    }

    return pdfBuffer;
  } catch (err) {
    logger.error(`[ReportBuilder] PDF generation failed: ${err.message}`);
    return null;
  }
}

function _buildSubject(data, meta) {
  const type = meta.type;
  const label = type === 'daily' ? 'Daily' : type === 'weekly' ? 'Weekly' : 'Custom';
  const periodLabel = _formatPeriodLabel(type, data.periodStart, data.periodEnd);
  const currency = data.account?.currency || 'USD';
  const pnlStr = _formatMoney(data.totalPnl, currency);
  const tradeStr = data.closedTrades.length === 0
    ? 'no trades'
    : `${data.closedTrades.length} trade${data.closedTrades.length === 1 ? '' : 's'}`;

  return `RTS ${label} Report — ${periodLabel} · ${pnlStr} (${tradeStr})`;
}

function _buildStats(data) {
  const m = data.metrics || {};
  const acc = data.account || {};
  return {
    tradeCount: data.closedTrades.length,
    winCount: Number(m.winCount ?? data.botRuns.filter(r => r.result === 'WIN').length) || 0,
    lossCount: Number(m.lossCount ?? data.botRuns.filter(r => r.result === 'LOSS').length) || 0,
    totalPnl: data.totalPnl,
    winRate: Number(m.winRate) || 0,
    balanceAtSend: Number(parseFloat(acc.balance)) || null,
    currency: acc.currency || null,
    accountType: acc.accountType || null,
    botsCovered: data.botSummary.length,
    strategiesCovered: data.strategySummary.length,
  };
}

// ─────────────────────────────────────────────────────────────
// Public builders
// ─────────────────────────────────────────────────────────────

/**
 * Build a daily report.
 * @param {Date} periodStart - inclusive, midnight EAT
 * @param {Date} periodEnd   - exclusive, next-day midnight EAT
 */
async function buildDailyReport(periodStart, periodEnd) {
  return _buildReport('daily', periodStart, periodEnd);
}

/**
 * Build a weekly report (Sat→Fri window, per scheduler's convention).
 */
async function buildWeeklyReport(periodStart, periodEnd) {
  return _buildReport('weekly', periodStart, periodEnd);
}

/**
 * Build a custom-range report.
 */
async function buildCustomReport(periodStart, periodEnd) {
  return _buildReport('custom', periodStart, periodEnd);
}

async function _buildReport(type, periodStart, periodEnd) {
  if (!periodStart || !periodEnd) {
    throw new Error('_buildReport requires periodStart and periodEnd');
  }
  if (!(periodEnd > periodStart)) {
    throw new Error('periodEnd must be after periodStart');
  }

  logger.info(
    `[ReportBuilder] Building ${type} report: ` +
    `${periodStart.toISOString()} → ${periodEnd.toISOString()}`
  );

  const data = await _gatherCommonData(periodStart, periodEnd);

  const reportId = crypto.randomUUID
    ? crypto.randomUUID()
    : `rep_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  const meta = { type, reportId };

  const html = _buildHtmlReport(data, meta);
  const pdfBuffer = await _buildPdfReport(data, meta);
  const subject = _buildSubject(data, meta);
  const stats = _buildStats(data);

  logger.info(
    `[ReportBuilder] ${type} report ready: ` +
    `${data.closedTrades.length} trades · pnl=${data.totalPnl} · ` +
    `pdf=${pdfBuffer ? `${pdfBuffer.length} bytes` : 'FAILED'} · ` +
    `subject="${subject}"`
  );

  return {
    type,
    periodStart,
    periodEnd,
    timezone: TIMEZONE,
    generatedAt: data.generatedAt,
    reportId,
    subject,
    html,
    pdfBuffer,
    stats,
    structured: {
      account: data.account,
      metrics: data.metrics,
      totalPnl: data.totalPnl,
      tradeCount: data.closedTrades.length,
      botCount: data.botSummary.length,
      strategyCount: data.strategySummary.length,
      shadowCount: data.shadowSummary.length,
    },
  };
}

module.exports = {
  buildDailyReport,
  buildWeeklyReport,
  buildCustomReport,
  // Exposed for tests / future reuse
  _gatherCommonData,
  _summarizeBots,
  _summarizeShadow,
  _summarizeHighPayout,
  TIMEZONE,
};
