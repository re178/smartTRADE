// public/js/app.js
// Core dashboard state + render functions for positions, account, history,
// OTIE panel, and the Live Signal Engine.
// Module-specific files (tradingview.js, bots.js, digits.js) attach their own
// handlers to window.on* hooks.

'use strict';

const HISTORY_PAGE_SIZE = 20;
let isSubmitting = false;
let isAutoSubmitting = false;
let historyPage = 1;
let historyTotalPages = 1;
let _activeSignalFetchInFlight = false;

// ================================================================
// Sound
// ================================================================
const SoundManager = {
  _ctx: null,
  _init() { if (!this._ctx) this._ctx = new (window.AudioContext || window.webkitAudioContext)(); },
  _playTone(freq, dur, type = 'sine', vol = 0.3) {
    try {
      this._init();
      const osc = this._ctx.createOscillator();
      const gain = this._ctx.createGain();
      osc.connect(gain); gain.connect(this._ctx.destination);
      osc.frequency.value = freq; osc.type = type; gain.gain.value = vol;
      osc.start(); osc.stop(this._ctx.currentTime + dur);
    } catch (e) {}
  },
  signal() { this._playTone(800, 0.2, 'sine', 0.4); },
  tradeOpen() { this._playTone(600, 0.15, 'sine', 0.4); setTimeout(() => this._playTone(900, 0.2, 'sine', 0.4), 150); },
  tradeClose() { this._playTone(900, 0.15, 'sine', 0.4); setTimeout(() => this._playTone(600, 0.2, 'sine', 0.4), 150); },
  danger() { this._playTone(150, 0.3, 'sawtooth', 0.3); setTimeout(() => this._playTone(150, 0.3, 'sawtooth', 0.3), 300); },
  reject() { this._playTone(300, 0.3, 'square', 0.2); setTimeout(() => this._playTone(200, 0.4, 'square', 0.2), 350); }
};

// ================================================================
// Helpers
// ================================================================
async function fetchJson(url, options = {}) {
  const res = await fetch((CONFIG.API_BASE || '') + url, {
    headers: { 'Content-Type': 'application/json' }, ...options
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

function formatPrice(p) {
  if (p === null || p === undefined || p === '') return '—';
  const n = parseFloat(p);
  return Number.isFinite(n) ? n.toFixed(5) : '—';
}

function formatSymbol(s) {
  if (!s || typeof s !== 'string') return s;
  return s.replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
}

function symbolToDisplay(sym) {
  const clean = formatSymbol(sym);
  if (clean.length === 6) return clean.slice(0, 3) + '/' + clean.slice(3);
  return clean;
}

// ================================================================
// State
// ================================================================
const dashboardState = {
  account: null,
  positions: [],
  prices: {},
  history: [],
  pendingOrders: [],
  regime: null,
  awareness: null,
  metrics: null,
  fusion: null,
  otieStates: {},
  contractStates: {},
  lastContractUpdateAt: null,
  strategyConsensus: {},
  signalOpportunities: {},
  signalPredictions: {},
  runningBots: [],
  digitViews: {},
};

function updateDashboardState(newState) {
  Object.assign(dashboardState, newState);
  renderAllWidgets();
}

function renderAllWidgets() {
  renderAccountWidget();
  renderPositionsWidget();
  renderPriceWidgets();
  renderStatsWidget();
  renderHistoryWidget();
  renderRegimeWidget();
  renderAwarenessWidget();
  renderMetricsWidget();
  renderLiveMonitorStatus();
  renderOTIEPanel();
  renderLiveSignalPanel();
}

// ================================================================
// Account
// ================================================================
function renderAccountWidget() {
  const acc = dashboardState.account;
  if (!acc) return;
  const balance = parseFloat(acc.balance) || 0;
  const equity = parseFloat(acc.equity) || 0;
  const currency = acc.currency || 'USD';
  const elB = document.getElementById('statBalance');
  const elE = document.getElementById('statEquity');
  if (elB) elB.textContent = `${balance.toFixed(2)} ${currency}`;
  if (elE) elE.textContent = `${equity.toFixed(2)} ${currency}`;
  if (window.updateAccountBadge) window.updateAccountBadge(acc);
}

// ================================================================
// Positions
// ================================================================
function renderPositionsWidget() {
  const positions = dashboardState.positions || [];
  const badge = document.getElementById('positionCount');
  if (badge) badge.textContent = positions.length;
  const container = document.getElementById('openTradesContainer');
  if (!container) return;

  const stOpen = document.getElementById('statOpenTrades');
  const stPL = document.getElementById('statOpenPL');

  if (positions.length === 0) {
    container.innerHTML = '<p class="text-muted">No open trades.</p>';
    if (stOpen) stOpen.textContent = '0';
    if (stPL) stPL.textContent = '—';
    return;
  }

  let html = `<table class="table table-striped"><thead><tr>
    <th>ID</th><th>Pair</th><th>Side</th><th>Entry</th><th>Current</th>
    <th>Stake</th><th>P/L</th><th>OTIE</th><th>Status</th><th>Action</th>
  </tr></thead><tbody>`;
  let totalPL = 0;

  for (const t of positions) {
    const pl = Number(t.unrealizedPL ?? 0) || 0;
    totalPL += pl;
    const cid = String(t.id ?? t.contractId);
    const live = dashboardState.contractStates[cid];
    const otie = dashboardState.otieStates[cid];
    const status = live?.status || t.status || 'OPEN';
    const canClose = live
      ? (live.isValidToSell !== false && !live.isSold && !live.isExpired)
      : status === 'OPEN';
    const plClass = pl > 0 ? 'text-success' : pl < 0 ? 'text-danger' : 'text-muted';

    let otieCell = '<span class="text-muted small">—</span>';
    if (otie) {
      const actionBadge = otie.action === 'CLOSE'
        ? '<span class="badge bg-danger">CLOSE</span>'
        : '<span class="badge bg-success">HOLD</span>';
      otieCell = `${actionBadge} <div class="small text-muted">peak ${Number(otie.peak||0).toFixed(2)}$</div>`;
    }

    html += `<tr>
      <td style="font-family:monospace; font-size:0.85em;">${cid}</td>
      <td>${t.instrument ?? '—'}</td>
      <td><span class="badge ${t.side === 'BUY' ? 'bg-success' : t.side === 'SELL' ? 'bg-danger' : 'bg-secondary'}">${t.side ?? '—'}</span></td>
      <td>${formatPrice(t.entryPrice ?? t.price)}</td>
      <td>${formatPrice(t.currentPrice)}</td>
      <td>$${Number(t.units || t.stake || 0).toFixed(2)}</td>
      <td class="${plClass}">${pl.toFixed(2)}</td>
      <td>${otieCell}</td>
      <td><span class="badge ${status === 'OPEN' ? 'bg-primary' : 'bg-secondary'}">${status}</span></td>
      <td>${canClose
        ? `<button class="btn btn-sm btn-danger" onclick="window.closeTrade('${cid}')"><i class="fas fa-times"></i></button>`
        : '<span class="small text-muted">settling…</span>'}</td>
    </tr>`;
  }
  html += `<tr><td colspan="6"><strong>Total Unrealized P&L</strong></td>
           <td class="${totalPL > 0 ? 'text-success' : totalPL < 0 ? 'text-danger' : ''}"><strong>${totalPL.toFixed(2)}</strong></td>
           <td colspan="3"></td></tr></tbody></table>`;
  container.innerHTML = html;

  if (stOpen) stOpen.textContent = positions.length;
  if (stPL) {
    stPL.textContent = (totalPL >= 0 ? '+' : '') + totalPL.toFixed(2);
    stPL.className = `stat-change ${totalPL >= 0 ? 'positive' : 'negative'}`;
  }
}

// ================================================================
// Prices
// ================================================================
function renderPriceWidgets() {
  const priceInfo = document.getElementById('priceInfo');
  if (!priceInfo) return;
  const prices = dashboardState.prices || {};
  const symbols = Object.keys(prices);
  if (symbols.length === 0) {
    priceInfo.innerHTML = '<p class="text-muted">No price data yet.</p>';
    return;
  }
  let html = '';
  for (const [symbol, d] of Object.entries(prices)) {
    const bid = d.bid || 0, ask = d.ask || 0, mid = (bid + ask) / 2;
    html += `<div class="d-flex justify-content-between"><span>${symbolToDisplay(symbol)}</span><span><strong>${formatPrice(mid)}</strong> (B:${formatPrice(bid)} A:${formatPrice(ask)})</span></div>`;
  }
  priceInfo.innerHTML = html;
}

// ================================================================
// Stats
// ================================================================
function renderStatsWidget() {
  const history = dashboardState.history || [];
  const wr = document.getElementById('statWinRate');
  const pf = document.getElementById('statProfitFactor');
  if (history.length === 0) {
    if (wr) wr.textContent = '—';
    if (pf) pf.textContent = 'PF: —';
    return;
  }
  const wins = history.filter(t => t.pnl > 0).length;
  if (wr) wr.textContent = ((wins / history.length) * 100).toFixed(1) + '%';
  const tw = history.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const tl = history.filter(t => t.pnl < 0).reduce((s, t) => s + Math.abs(t.pnl), 0);
  const factor = tl > 0 ? tw / tl : (tw > 0 ? Infinity : 0);
  if (pf) pf.textContent = `PF: ${factor === Infinity ? '∞' : factor.toFixed(2)}`;
}

// ================================================================
// History
// ================================================================
function renderHistoryWidget() { renderHistoryTable(); }
function applyHistoryFilters() { historyPage = 1; renderHistoryTable(); }

function renderHistoryTable() {
  const all = dashboardState.history || [];
  const from = document.getElementById('historyFrom')?.value;
  const to = document.getElementById('historyTo')?.value;
  const symbol = document.getElementById('historySymbol')?.value.trim();
  const side = document.getElementById('historySide')?.value;
  const status = document.getElementById('historyStatus')?.value;

  const filtered = all.filter(t => {
    if (from && new Date(t.date) < new Date(from)) return false;
    if (to && new Date(t.date) > new Date(to)) return false;
    if (symbol && !String(t.pair || '').toUpperCase().includes(symbol.toUpperCase())) return false;
    if (side && t.side !== side) return false;
    if (status && t.status !== status) return false;
    return true;
  });
  filtered.sort((a, b) => new Date(b.date) - new Date(a.date));

  const cnt = document.getElementById('historyCount');
  if (cnt) cnt.textContent = filtered.length;

  historyTotalPages = Math.ceil(filtered.length / HISTORY_PAGE_SIZE) || 1;
  if (historyPage < 1) historyPage = 1;
  if (historyPage > historyTotalPages) historyPage = historyTotalPages;

  const start = (historyPage - 1) * HISTORY_PAGE_SIZE;
  const end = Math.min(start + HISTORY_PAGE_SIZE, filtered.length);
  const pageItems = filtered.slice(start, end);

  const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setTxt('pageStart', filtered.length > 0 ? start + 1 : 0);
  setTxt('pageEnd', end);
  setTxt('pageTotal', filtered.length);
  setTxt('pageInfo', `Page ${historyPage} of ${historyTotalPages}`);

  const container = document.getElementById('historyContainer');
  if (!container) return;
  if (pageItems.length === 0) { container.innerHTML = '<p class="text-muted">No matching records.</p>'; return; }

  let html = `<div class="table-responsive"><table class="table table-striped table-sm">
    <thead><tr><th>Pair</th><th>Side</th><th>Entry</th><th>Exit</th><th>Stake</th><th>P/L</th><th>Status</th><th>Date</th></tr></thead><tbody>`;
  pageItems.forEach(t => {
    const pl = t.pnl ? parseFloat(t.pnl).toFixed(2) : '0.00';
    html += `<tr>
      <td>${t.pair}</td>
      <td><span class="badge ${t.side === 'BUY' ? 'bg-success' : 'bg-danger'}">${t.side}</span></td>
      <td>${t.entryPrice !== null ? formatPrice(t.entryPrice) : '-'}</td>
      <td>${t.exitPrice !== null ? formatPrice(t.exitPrice) : '-'}</td>
      <td>${t.lotSize}</td>
      <td class="${pl >= 0 ? 'text-success' : 'text-danger'}">${pl}</td>
      <td><span class="badge bg-secondary">${t.status}</span></td>
      <td>${new Date(t.date).toLocaleString()}</td>
    </tr>`;
  });
  html += '</tbody></table></div>';
  container.innerHTML = html;
}

// ================================================================
// Regime / Awareness / Metrics
// ================================================================
function renderRegimeWidget() {
  const r = dashboardState.regime;
  const panel = document.getElementById('regimePanel');
  if (!panel) return;
  if (!r) { panel.innerHTML = '<p class="text-muted">Waiting for regime data...</p>'; return; }
  panel.innerHTML = `<div class="card"><div class="card-body">
    <h6 class="card-title">Current Regime</h6>
    <p class="card-text"><strong>${r.name}</strong> (${r.confidence}%)</p>
    <p class="small">${r.description || ''}</p>
    <p class="small text-muted">${r.symbol} | ${new Date(r.timestamp).toLocaleString()}</p>
  </div></div>`;
}

function renderAwarenessWidget() {
  const a = dashboardState.awareness;
  const panel = document.getElementById('awarenessPanel');
  if (!panel) return;
  if (!a) { panel.innerHTML = '<p class="text-muted">Waiting for market awareness...</p>'; return; }
  panel.innerHTML = `<div class="card"><div class="card-body">
    <h6 class="card-title">Awareness (${a.symbol})</h6>
    <p>Spread: ${(a.spread || 0).toFixed(5)} | Velocity: ${(a.velocity || 0).toFixed(6)}</p>
    <p>Accel: ${(a.acceleration || 0).toFixed(6)} | Liquidity: ${((a.liquidity || 0) * 100).toFixed(0)}%</p>
    <p>Unusual: ${a.unusual ? a.unusual.join(', ') : 'None'}</p>
    <p class="small text-muted">${new Date(a.lastUpdated).toLocaleString()}</p>
  </div></div>`;
}

function renderMetricsWidget() {
  const m = dashboardState.metrics;
  const panel = document.getElementById('metricsPanel');
  if (!panel) return;
  if (!m) { panel.innerHTML = '<p class="text-muted">Waiting for metrics...</p>'; return; }
  panel.innerHTML = `<div class="card"><div class="card-body">
    <h6 class="card-title">Performance</h6>
    <div class="row small">
      <div class="col-6">Win Rate: ${((m.winRate || 0) * 100).toFixed(1)}%</div>
      <div class="col-6">PF: ${(m.profitFactor || 0).toFixed(2)}</div>
      <div class="col-6">Sharpe: ${(m.sharpe || 0).toFixed(2)}</div>
      <div class="col-6">Max DD: ${((m.maxDrawdown || 0) * 100).toFixed(1)}%</div>
      <div class="col-6">Expectancy: ${(m.expectancy || 0).toFixed(2)}</div>
      <div class="col-6">Trades: ${m.totalTrades || 0}</div>
      <div class="col-6">Daily P&L: ${(m.dailyPnL || 0).toFixed(2)}</div>
      <div class="col-6">Belief: ${m.belief || '—'} (${m.beliefConfidence || 0}%)</div>
    </div>
  </div></div>`;
}

// ================================================================
// Live monitoring status
// ================================================================
function renderLiveMonitorStatus() {
  const el = document.getElementById('liveMonitorStatus');
  if (!el) return;
  const now = Date.now();
  const last = dashboardState.lastContractUpdateAt;
  const count = Object.keys(dashboardState.contractStates || {}).length;
  if (!last) {
    el.textContent = count > 0 ? `${count} contract(s) — waiting for first tick` : 'Live monitoring idle';
    el.className = 'small text-muted';
    return;
  }
  const ageSec = Math.round((now - last) / 1000);
  const label = `${count} contract(s) · last tick ${ageSec}s ago`;
  if (ageSec < 10) { el.textContent = label; el.className = 'small text-success'; }
  else if (ageSec < 60) { el.textContent = label; el.className = 'small text-warning'; }
  else { el.textContent = `${label} — stalled`; el.className = 'small text-danger'; }
}
setInterval(renderLiveMonitorStatus, 5000);

// ================================================================
// Live Signal Engine
// ================================================================
window.onStrategyConsensus = function (payload) {
  if (!payload || !payload.symbol) return;
  const sym = formatSymbol(payload.symbol);
  dashboardState.strategyConsensus[sym] = payload;
  renderLiveSignalPanel();
};

window.onOpportunityUpdate = function (payload) {
  if (!payload || !payload.prediction?.symbol) return;
  const sym = formatSymbol(payload.prediction.symbol);
  dashboardState.signalOpportunities[sym] = payload;
  if (payload.prediction) dashboardState.signalPredictions[sym] = payload.prediction;
  renderLiveSignalPanel();
};

window.onPredictionUpdate = function (payload) {
  if (!payload || !payload.symbol) return;
  const sym = formatSymbol(payload.symbol);
  dashboardState.signalPredictions[sym] = payload;
};

function renderLiveSignalPanel() {
  const container = document.getElementById('liveSignalEngineContent');
  if (!container) return;

  const symbols = (window.WATCHED_SYMBOLS || ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'])
    .map(s => formatSymbol(s));

  const headerBadge = document.getElementById('liveSignalEngineBadge');
  if (headerBadge) {
    const ready = symbols.filter(s => dashboardState.signalOpportunities[s]?.tradable).length;
    const active = symbols.filter(s => dashboardState.strategyConsensus[s]).length;
    if (ready > 0) { headerBadge.textContent = `${ready} actionable`; headerBadge.className = 'badge bg-success'; }
    else if (active > 0) { headerBadge.textContent = `${active} evaluated`; headerBadge.className = 'badge bg-info'; }
    else { headerBadge.textContent = 'Waiting...'; headerBadge.className = 'badge bg-secondary'; }
  }

  const cards = symbols.map(sym => {
    const consensus = dashboardState.strategyConsensus[sym];
    const prediction = dashboardState.signalPredictions[sym];
    const opportunity = dashboardState.signalOpportunities[sym];
    if (!consensus && !prediction && !opportunity) return renderWaitingSignalCard(sym);
    return renderSignalCard(sym, consensus, prediction, opportunity);
  });

  container.innerHTML = cards.join('');
}

function renderWaitingSignalCard(sym) {
  return `<div class="card mb-3"><div class="card-body text-muted small">
    <strong>${symbolToDisplay(sym)}</strong> — awaiting pipeline cycle (every 30s)
  </div></div>`;
}

function renderSignalCard(sym, consensus, prediction, opportunity) {
  const c = consensus || {};
  const p = prediction || {};
  const o = opportunity || null;
  const isTradable = o && o.tradable === true;
  const isConflict = c.action === 'CONFLICT';
  const isNeutral = c.action === 'NEUTRAL';
  const isSignal = c.action === 'SIGNAL';

  const borderColor = isTradable ? '#00b894' : isConflict ? '#e74c5e' : isNeutral ? '#cbd5e1' : isSignal ? '#3b82f6' : '#e2e8f0';
  const bgColor = isTradable ? '#f0fdf4' : isConflict ? '#fef2f2' : '#ffffff';

  let consensusLine = '';
  if (isSignal && c.direction) {
    const dirClass = c.direction === 'BUY' ? 'success' : 'danger';
    consensusLine = `<span class="badge bg-${dirClass} fs-6">${c.direction}</span>
      <span class="ms-2">conf <strong>${c.confidence}%</strong></span>
      <span class="ms-2 small text-muted">${(c.agreeing || []).length}/${(c.strategies || []).length} agree</span>
      ${c.anchorStrategy ? `<span class="ms-2 small">anchor: <strong>${c.anchorStrategy}</strong></span>` : ''}`;
  } else if (isConflict) {
    consensusLine = `<span class="badge bg-danger fs-6">CONFLICT</span>`;
  } else if (isNeutral) {
    consensusLine = `<span class="badge bg-secondary fs-6">NEUTRAL</span>`;
  } else {
    consensusLine = `<span class="badge bg-secondary fs-6">—</span>`;
  }

  const rows = (c.strategies || []).map(r => {
    let statusIcon = '', statusClass = 'text-muted';
    if (r.status === 'AGREE') { statusIcon = '✓'; statusClass = 'text-success fw-bold'; }
    else if (r.status === 'CONFLICT') { statusIcon = '✗'; statusClass = 'text-danger'; }
    else if (r.status === 'FLAGGED') { statusIcon = '⊘'; statusClass = 'text-warning'; }
    const sideBadge = r.signalSide
      ? `<span class="badge bg-${r.signalSide === 'BUY' ? 'success' : 'danger'}" style="font-size:0.7em;">${r.signalSide}</span>`
      : `<span class="badge bg-light text-muted" style="font-size:0.7em;">—</span>`;
    const wr = Number(r.effectiveWinRate || 0) * 100;
    return `<div class="d-flex justify-content-between py-1" style="font-size:0.8em; border-bottom:1px solid #f1f5f9;">
      <div><span class="${statusClass}" style="width:14px; display:inline-block;">${statusIcon}</span>
        <strong>${r.name}</strong> ${sideBadge}</div>
      <div><span class="${wr >= 55 ? 'text-success' : wr >= 45 ? 'text-muted' : 'text-danger'}">${wr.toFixed(0)}%</span>
        <span class="text-muted"> (${r.trades || 0}) w=${(r.weight || 0).toFixed(2)}</span></div>
    </div>`;
  }).join('');

  let opportunityBlock = '';
  if (isTradable) {
    const eco = o.tradeEconomics || {};
    opportunityBlock = `<div class="mt-3 p-3 rounded" style="background:rgba(255,255,255,0.7); border:1px solid #bbf7d0;">
      <div class="row small">
        <div class="col-md-6">
          <div><strong>${o.direction}</strong> ${symbolToDisplay(sym)}</div>
          <div>Entry ${formatPrice(o.entryPrice)}</div>
          <div>KO ${formatPrice(o.knockoutLevel)} / TP ${formatPrice(o.takeProfitLevel)}</div>
        </div>
        <div class="col-md-6">
          <div>Stake $${(o.stake || 0).toFixed(2)} · ${o.multiplier}x · ${o.duration}s</div>
          <div>P(TP) ${((eco.probTP||0)*100).toFixed(0)}% · P(SL) ${((eco.probSL||0)*100).toFixed(0)}%</div>
          <div>EV $${(eco.ev||0).toFixed(2)} (${((eco.evOverStake||0)*100).toFixed(1)}%)</div>
        </div>
      </div>
      <div class="mt-2">
        <button class="btn btn-sm btn-success" onclick="window.executeLiveSignal('${sym}')">
          <i class="fas fa-play"></i> Execute
        </button>
        <button class="btn btn-sm btn-outline-secondary ms-2" onclick="window.dismissSignal('${sym}')">Dismiss</button>
      </div>
    </div>`;
  } else if (o && !o.tradable) {
    opportunityBlock = `<div class="mt-2 small text-muted"><i class="fas fa-ban"></i> ${o.reason || 'Not tradable'}</div>`;
  }

  let predictionLine = '';
  if (p && p.modeLabel) {
    predictionLine = `<div class="small text-muted mt-1">
      ${p.direction || '—'} · ${p.calibratedConfidence || 0}% · mode ${p.modeLabel}
      ${p.pattern ? ` · pattern ${p.pattern.bias} (${p.pattern.confidence}%)` : ''}
      ${p.momentum ? ` · mom ${p.momentum.direction}` : ''}
    </div>`;
  }

  return `<div class="card mb-3" style="border-left: 4px solid ${borderColor}; background: ${bgColor};">
    <div class="card-body">
      <div class="d-flex justify-content-between align-items-start mb-2">
        <div>
          <h6 class="mb-1">${symbolToDisplay(sym)} <span class="small text-muted ms-2">${c.regime || ''}</span></h6>
          <div>${consensusLine}</div>
        </div>
        <div class="text-end small text-muted">${c.evaluatedAt ? new Date(c.evaluatedAt).toLocaleTimeString() : ''}</div>
      </div>
      ${predictionLine}
      ${rows ? `<div class="mt-2">${rows}</div>` : ''}
      ${opportunityBlock}
    </div>
  </div>`;
}

window.executeLiveSignal = async function (symbol) {
  const sym = formatSymbol(symbol);
  const opportunity = dashboardState.signalOpportunities[sym];
  if (!opportunity || !opportunity.tradable) { alert('No tradable opportunity'); return; }
  const stratInfo = opportunity.strategyInfo || {};
  const strategy = stratInfo.anchorStrategy || opportunity.prediction?.strategyConsensus?.anchorStrategy || null;
  const regimeCode = opportunity.prediction?.regime || null;

  const msg = `Execute ${opportunity.direction} ${symbolToDisplay(sym)}?\n` +
    `Entry: ${formatPrice(opportunity.entryPrice)}\nKO: ${formatPrice(opportunity.knockoutLevel)}\nTP: ${formatPrice(opportunity.takeProfitLevel)}\n` +
    `Stake: $${(opportunity.stake || 0).toFixed(2)}\nMult: ${opportunity.multiplier}x\nDur: ${opportunity.duration}s\n` +
    (strategy ? `Strategy: ${strategy}\n` : '') + (regimeCode ? `Regime: ${regimeCode}` : '');
  if (!confirm(msg)) return;

  const res = await fetch('/api/trade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pair: symbol, side: opportunity.direction, stake: opportunity.stake,
      multiplier: opportunity.multiplier, duration: opportunity.duration,
      knockoutLevel: opportunity.knockoutLevel, takeProfitLevel: opportunity.takeProfitLevel,
      product: 'deriv_cfd', strategy, regimeCode,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (body.success) {
    SoundManager.tradeOpen();
    alert(`✅ Trade placed: ${body.contractId || '?'}`);
    delete dashboardState.signalOpportunities[sym];
    renderLiveSignalPanel();
    refreshAllData();
  } else {
    SoundManager.reject();
    alert(`❌ ${body.status || 'Error'}: ${body.error || 'unknown'}`);
  }
};

window.dismissSignal = function (symbol) {
  delete dashboardState.signalOpportunities[formatSymbol(symbol)];
  renderLiveSignalPanel();
};

// ================================================================
// OTIE
// ================================================================
window.onOtieState = function (state) {
  if (!state || !state.tradeId) return;
  if (state.action === 'RELEASED') delete dashboardState.otieStates[state.tradeId];
  else dashboardState.otieStates[state.tradeId] = state;
  renderOTIEPanel();
  renderPositionsWidget();
};

function renderOTIEPanel() {
  const container = document.getElementById('otieContent');
  if (!container) return;
  const states = dashboardState.otieStates || {};
  const ids = Object.keys(states).sort();
  const headerBadge = document.querySelector('#section-trademanagement .card-header .badge');
  if (headerBadge) {
    if (ids.length > 0) { headerBadge.textContent = `${ids.length} monitored`; headerBadge.className = 'badge bg-success'; }
    else { headerBadge.textContent = 'Idle'; headerBadge.className = 'badge bg-secondary'; }
  }
  if (ids.length === 0) { container.innerHTML = '<p class="text-muted">No open contracts.</p>'; return; }
  container.innerHTML = ids.map(id => _renderOtieCard(states[id])).join('');
}

function _renderOtieCard(s) {
  const isClose = s.action === 'CLOSE';
  const borderColor = isClose ? '#e74c5e' : '#00b894';
  const bgColor = isClose ? '#fef2f2' : '#f0fdf4';
  const profitColor = Number(s.profit) >= 0 ? '#00b894' : '#e74c5e';
  const ddPct = (Number(s.drawdownPct || 0) * 100).toFixed(0);
  return `<div style="border-left:4px solid ${borderColor}; background:${bgColor}; border-radius:8px; padding:16px; margin-bottom:12px;">
    <div class="d-flex justify-content-between mb-2">
      <div><strong>${s.symbol}</strong>
        <span class="badge ${s.side === 'BUY' ? 'bg-success' : 'bg-danger'} ms-2">${s.side}</span>
        <span class="badge bg-primary ms-1">${s.multiplier}x</span>
        <span class="small text-muted ms-2">$${Number(s.stake).toFixed(2)}</span></div>
      <div><span class="badge ${isClose ? 'bg-danger' : 'bg-success'}">${s.action}</span></div>
    </div>
    <div class="row text-center">
      <div class="col-3"><div class="small text-muted">PROFIT</div>
        <div style="font-size:1.2em; font-weight:700; color:${profitColor};">${Number(s.profit)>=0?'+':''}$${Number(s.profit).toFixed(2)}</div></div>
      <div class="col-3"><div class="small text-muted">PEAK</div>
        <div style="font-size:1.2em; font-weight:700; color:#00b894;">+$${Number(s.peak||0).toFixed(2)}</div></div>
      <div class="col-3"><div class="small text-muted">DD</div>
        <div style="font-size:1.2em; font-weight:700;">${ddPct}%</div></div>
      <div class="col-3"><div class="small text-muted">REVS</div>
        <div style="font-size:1.2em; font-weight:700;">${s.reversals||0}</div></div>
    </div>
    ${isClose && s.reason ? `<div class="alert alert-danger mt-2 mb-0 py-1 small"><strong>CLOSE:</strong> ${s.reason}</div>` : ''}
  </div>`;
}

// ================================================================
// Refresh
// ================================================================
async function refreshAllData() {
  try {
    const [account, positions, history] = await Promise.all([
      fetchJson('/api/account').catch(() => null),
      fetchJson('/api/trades').catch(() => []),
      fetchJson('/api/trade-history').catch(() => []),
    ]);
    if (account) dashboardState.account = account;
    if (Array.isArray(positions)) dashboardState.positions = positions;
    if (Array.isArray(history)) dashboardState.history = history;
    renderAllWidgets();
  } catch (e) { console.error('Refresh error:', e); }
}

async function refreshSignals() {
  if (_activeSignalFetchInFlight) return;
  _activeSignalFetchInFlight = true;
  try {
    const data = await fetchJson('/api/signal/active');
    if (data && data.signals) {
      for (const [sym, payload] of Object.entries(data.signals)) {
        if (payload.consensus) dashboardState.strategyConsensus[sym] = payload.consensus;
        if (payload.opportunity) dashboardState.signalOpportunities[sym] = payload.opportunity;
        if (payload.prediction) dashboardState.signalPredictions[sym] = payload.prediction;
      }
      renderLiveSignalPanel();
    }
  } catch (e) { console.warn('[App] refreshSignals failed:', e.message); }
  finally { _activeSignalFetchInFlight = false; }
}

// ================================================================
// Actions
// ================================================================
async function closeTrade(tradeId) {
  if (!confirm(`Close contract ${tradeId}?`)) return;
  try {
    await fetchJson(`/api/close/${tradeId}`, { method: 'PUT' });
    SoundManager.tradeClose();
  } catch (e) { alert('Error: ' + e.message); SoundManager.reject(); }
}

window.closeTrade = closeTrade;

// ================================================================
// Exports
// ================================================================
window.dashboardState = dashboardState;
window.updateDashboardState = updateDashboardState;
window.renderAllWidgets = renderAllWidgets;
window.renderPositionsWidget = renderPositionsWidget;
window.renderOTIEPanel = renderOTIEPanel;
window.renderLiveSignalPanel = renderLiveSignalPanel;
window.SoundManager = SoundManager;
window.refreshDashboard = refreshAllData;
window.refreshSignals = refreshSignals;

window.updatePositionBadge = function (count) {
  const b = document.getElementById('positionCount');
  if (b) b.textContent = count || 0;
};
window.updateApiStatus = function (connected) {
  const dot = document.getElementById('apiStatusDot');
  const text = document.getElementById('apiStatusText');
  if (dot) dot.className = 'dot ' + (connected ? 'connected' : 'disconnected');
  if (text) text.textContent = connected ? 'Connected' : 'Disconnected';
};
window.updateAccountBadge = function (acc) {
  if (!acc) return;
  const idEl = document.getElementById('accountId');
  const curEl = document.getElementById('accountCurrency');
  const typeEl = document.getElementById('accountTypeLabel');
  if (idEl) idEl.textContent = acc.id || acc.login || '—';
  if (curEl) curEl.textContent = acc.currency || 'USD';
  if (typeEl) {
    const srv = String(acc.server || '').toLowerCase();
    const type = srv.includes('demo') ? 'demo' : 'real';
    typeEl.textContent = type.toUpperCase();
    typeEl.className = 'account-type ' + type;
  }
};

// ================================================================
// DOM wiring
// ================================================================
document.addEventListener('DOMContentLoaded', async function () {
  await refreshAllData();
  await refreshSignals();

  setInterval(() => {
    if (document.visibilityState === 'visible') refreshSignals();
  }, 30000);

  document.getElementById('refreshTrades')?.addEventListener('click', refreshAllData);
  document.getElementById('refreshHistory')?.addEventListener('click', refreshAllData);
  document.getElementById('refreshLiveSignals')?.addEventListener('click', refreshSignals);
  document.getElementById('applyHistoryFilter')?.addEventListener('click', applyHistoryFilters);
  document.getElementById('prevPage')?.addEventListener('click', function () {
    if (historyPage > 1) { historyPage--; renderHistoryTable(); }
  });
  document.getElementById('nextPage')?.addEventListener('click', function () {
    if (historyPage < historyTotalPages) { historyPage++; renderHistoryTable(); }
  });
  document.getElementById('resetHistoryFilter')?.addEventListener('click', function () {
    ['historyFrom','historyTo','historySymbol','historySide','historyStatus'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    applyHistoryFilters();
  });

  renderLiveSignalPanel();
});

console.log('✅ app.js loaded');
