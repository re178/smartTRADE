// public/js/app.js – Dashboard logic
// Renders all widgets. Live updates come from live.js.
//
// [FILE-8] Live Signal Engine panel:
//   • renderLiveSignalPanel() paints one card per WATCHED_SYMBOL
//   • Each card shows: consensus action/direction/confidence, per-strategy
//     rows with side/status/weight/trades, and (when tradable) the concrete
//     entry/stop/target/multiplier with an Execute button
//   • window.onStrategyConsensus() handles the WS event from server.js
//   • window.onOpportunityUpdate() merges opportunity updates into the panel
//   • Execute button POSTs /api/trade with strategy + regimeCode attribution
//     so the ranker learns from the resulting closed trade
//   • Panel also loads /api/signal/active on page load for immediate state
//
// [FILE-4-OF-4] OTIE trajectory panel — retained from prior version
// All other widgets — retained

const HISTORY_PAGE_SIZE = 20;
let isSubmitting = false;
let isAutoSubmitting = false;
let historyPage = 1;
let historyTotalPages = 1;
let _activeSignalFetchInFlight = false;

// ---- Sound Manager ----
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
  danger() { this._playTone(150, 0.3, 'sawtooth', 0.3); setTimeout(() => this._playTone(150, 0.3, 'sawtooth', 0.3), 300); setTimeout(() => this._playTone(150, 0.3, 'sawtooth', 0.3), 600); },
  reject() { this._playTone(300, 0.3, 'square', 0.2); setTimeout(() => this._playTone(200, 0.4, 'square', 0.2), 350); }
};

// ---- API helpers ----
async function fetchJson(url, options = {}) {
  const res = await fetch((CONFIG.API_BASE || '') + url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function placeOrderFetch(url, body) {
  let res;
  try {
    res = await fetch((CONFIG.API_BASE || '') + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (networkErr) {
    return {
      httpStatus: 0,
      body: { success: false, status: 'NETWORK_ERROR', error: networkErr.message, canRetry: false },
    };
  }
  let payload = {};
  try { payload = await res.json(); } catch (_) { payload = {}; }
  return { httpStatus: res.status, body: payload };
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
// 1. STATE STORE
// ================================================================
const dashboardState = {
  account: null,
  positions: [],
  prices: {},
  history: [],
  pendingOrders: [],
  liveSignal: null,
  regime: null,
  awareness: null,
  metrics: null,
  fusion: null,
  otieDecisions: [],
  otieActions: [],
  otieStates: {},
  belief: null,
  prediction: null,
  opportunity: null,
  contractStates: {},
  lastContractUpdateAt: null,
  // [FILE-8] Per-symbol signal pipeline state
  strategyConsensus: {},   // symbol -> flattened consensus
  signalOpportunities: {}, // symbol -> opportunity
  signalPredictions: {},   // symbol -> prediction (for the panel)
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
  renderPendingOrdersWidget();
  renderRegimeWidget();
  renderAwarenessWidget();
  renderMetricsWidget();
  renderFusionWidget();
  renderBeliefWidget();
  renderPredictionWidget();
  renderOpportunityWidget();
  renderLiveMonitorStatus();
  renderOTIEPanel();
  renderLiveSignalPanel();
}

function renderLiveMonitorStatus() {
  const el = document.getElementById('liveMonitorStatus');
  if (!el) return;
  const now = Date.now();
  const last = dashboardState.lastContractUpdateAt;
  const count = Object.keys(dashboardState.contractStates || {}).length;
  if (!last) {
    el.textContent = count > 0
      ? `${count} contract(s) tracked — waiting for first live tick`
      : 'Live monitoring idle (no open contracts)';
    el.className = 'small text-muted';
    return;
  }
  const ageSec = Math.round((now - last) / 1000);
  const label = `${count} contract(s) · last live tick ${ageSec}s ago`;
  if (ageSec < 10) { el.textContent = label; el.className = 'small text-success'; }
  else if (ageSec < 60) { el.textContent = label; el.className = 'small text-warning'; }
  else { el.textContent = `${label} — stream may have stalled`; el.className = 'small text-danger'; }
}
setInterval(renderLiveMonitorStatus, 5000);

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
    <th>ID</th><th>Pair</th><th>Side</th><th>Entry</th><th>Paid</th>
    <th>Current</th><th>Units</th><th>P/L</th>
    <th>OTIE</th><th>Status</th><th>Action</th>
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
      const peakStr = Number(otie.peak || 0).toFixed(2);
      const ddStr = (Number(otie.drawdownPct || 0) * 100).toFixed(0);
      const ddClass = Number(otie.drawdownPct) > 0.30 ? 'text-danger' : 'text-muted';
      otieCell = `${actionBadge}
        <div class="${ddClass}" style="font-size:0.7em; line-height:1.1; margin-top:2px;">
          peak ${peakStr}$<br>dd ${ddStr}%
        </div>`;
    }

    html += `<tr>
      <td style="font-family:monospace; font-size:0.85em;">${t.id ?? t.contractId ?? '—'}</td>
      <td>${t.instrument ?? '—'}</td>
      <td><span class="badge ${t.side === 'BUY' ? 'bg-success' : t.side === 'SELL' ? 'bg-danger' : 'bg-secondary'}">${t.side ?? '—'}</span></td>
      <td>${formatPrice(t.entryPrice ?? t.price)}</td>
      <td>${formatPrice(t.purchasePrice)}</td>
      <td>${formatPrice(t.currentPrice)}</td>
      <td>${t.units ?? '—'}</td>
      <td class="${plClass}">${pl.toFixed(2)}</td>
      <td>${otieCell}</td>
      <td><span class="badge ${status === 'OPEN' ? 'bg-primary' : 'bg-secondary'}">${status}</span></td>
      <td>${canClose
        ? `<button class="btn btn-sm btn-danger" onclick="window.closeTrade('${cid}')"><i class="fas fa-times"></i> Close</button>`
        : '<span class="small text-muted">settling…</span>'}</td>
    </tr>`;
  }
  html += `<tr><td colspan="8"><strong>Total Unrealized P&L</strong></td>
           <td class="${totalPL > 0 ? 'text-success' : totalPL < 0 ? 'text-danger' : ''}"><strong>${totalPL.toFixed(2)}</strong></td>
           <td colspan="2"></td></tr></tbody></table>`;
  container.innerHTML = html;

  if (stOpen) stOpen.textContent = positions.length;
  if (stPL) {
    stPL.textContent = (totalPL >= 0 ? '+' : '') + totalPL.toFixed(2);
    stPL.className = `stat-change ${totalPL >= 0 ? 'positive' : 'negative'}`;
  }
  if (window.updatePositionBadge) window.updatePositionBadge(positions.length);
}

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
    html += `<div class="d-flex justify-content-between"><span>${symbol}</span><span><strong>${formatPrice(mid)}</strong> (Bid ${formatPrice(bid)} / Ask ${formatPrice(ask)})</span></div>`;
  }
  priceInfo.innerHTML = html;
}

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
  const winRate = (wins / history.length) * 100;
  if (wr) wr.textContent = winRate.toFixed(1) + '%';
  const tw = history.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const tl = history.filter(t => t.pnl < 0).reduce((s, t) => s + Math.abs(t.pnl), 0);
  const factor = tl > 0 ? tw / tl : (tw > 0 ? Infinity : 0);
  if (pf) pf.textContent = `PF: ${factor === Infinity ? '∞' : factor.toFixed(2)}`;
}

function renderHistoryWidget() { renderHistoryTable(); }

function renderPendingOrdersWidget() {
  const orders = dashboardState.pendingOrders || [];
  const container = document.getElementById('pendingOrdersContainer');
  if (!container) return;
  if (orders.length === 0) { container.innerHTML = '<p class="text-muted">No pending orders.</p>'; return; }
  let html = `<table class="table table-striped"><thead><tr>
    <th>ID</th><th>Pair</th><th>Side</th><th>Entry</th><th>Lot</th><th>Status</th><th>Action</th>
  </tr></thead><tbody>`;
  orders.forEach(o => {
    html += `<tr>
      <td>${o.contractId || o.clientOrderId || 'N/A'}</td>
      <td>${o.instrument}</td>
      <td><span class="badge ${o.side === 'BUY' ? 'bg-success' : 'bg-danger'}">${o.side}</span></td>
      <td>${o.entryPrice || '-'}</td>
      <td>${o.units}</td>
      <td><span class="badge bg-warning">${o.status}</span></td>
      <td><button class="btn btn-sm btn-danger" onclick="window.cancelPending('${o.contractId || o.clientOrderId}')">Cancel</button></td>
    </tr>`;
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

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
    <h6 class="card-title">Market Awareness (${a.symbol})</h6>
    <p>Spread: ${(a.spread || 0).toFixed(5)} | Velocity: ${(a.velocity || 0).toFixed(6)}</p>
    <p>Acceleration: ${(a.acceleration || 0).toFixed(6)} | Liquidity: ${((a.liquidity || 0) * 100).toFixed(0)}%</p>
    <p>Unusual: ${a.unusualEvents ? a.unusualEvents.join(', ') : (a.unusual ? a.unusual.join(', ') : 'None')}</p>
    <p class="small text-muted">${new Date(a.lastUpdated).toLocaleString()}</p>
  </div></div>`;
}

function renderMetricsWidget() {
  const m = dashboardState.metrics;
  const panel = document.getElementById('metricsPanel');
  if (!panel) return;
  if (!m) { panel.innerHTML = '<p class="text-muted">Waiting for metrics...</p>'; return; }
  panel.innerHTML = `<div class="card"><div class="card-body">
    <h6 class="card-title">Live Performance</h6>
    <div class="row">
      <div class="col-6">Win Rate: ${((m.winRate || 0) * 100).toFixed(1)}%</div>
      <div class="col-6">Profit Factor: ${(m.profitFactor || 0).toFixed(2)}</div>
      <div class="col-6">Sharpe: ${(m.sharpe || 0).toFixed(2)}</div>
      <div class="col-6">Max DD: ${((m.maxDrawdown || 0) * 100).toFixed(1)}%</div>
      <div class="col-6">Expectancy: ${(m.expectancy || 0).toFixed(2)}</div>
      <div class="col-6">Trades: ${m.totalTrades || 0}</div>
      <div class="col-6">Daily P&L: ${(m.dailyPnL || 0).toFixed(2)}</div>
      <div class="col-6">Current DD: ${((m.currentDrawdown || 0) * 100).toFixed(1)}%</div>
    </div>
    <p class="small text-muted mt-2">${m.timestamp ? new Date(m.timestamp).toLocaleString() : ''}</p>
  </div></div>`;
}

function renderFusionWidget() {
  const f = dashboardState.fusion;
  const panel = document.getElementById('fusionPanel');
  if (!panel) return;
  if (!f) { panel.innerHTML = '<p class="text-muted">Waiting for timeframe assessments...</p>'; return; }
  const vc = f.verdict === 'bullish' ? 'success' : (f.verdict === 'bearish' ? 'danger' : 'secondary');
  const icon = f.verdict === 'bullish' ? '📈' : (f.verdict === 'bearish' ? '📉' : '➖');
  panel.innerHTML = `<div class="row">
    <div class="col-md-6">
      <h5>${icon} ${f.symbol} – <span class="text-${vc}">${f.verdict.toUpperCase()}</span> (${f.confidence}%)</h5>
      <p>Agreement: ${f.agreement}% across ${f.timeframeCount} timeframes</p>
      <ul class="list-inline">
        <li class="list-inline-item"><span class="badge bg-success">Bull ${f.timeframeBreakdown.bullish}</span></li>
        <li class="list-inline-item"><span class="badge bg-danger">Bear ${f.timeframeBreakdown.bearish}</span></li>
        <li class="list-inline-item"><span class="badge bg-secondary">Neutral ${f.timeframeBreakdown.neutral}</span></li>
      </ul>
      <p><small>Session: ${f.session.name} (×${f.session.liquidityMultiplier})</small></p>
    </div>
    <div class="col-md-6">
      <p><strong>Reasons</strong></p>
      <ul class="small">${f.reasons.map(r => `<li>${r}</li>`).join('') || '<li>No detailed reasons</li>'}</ul>
    </div>
  </div>`;
}

function renderBeliefWidget() {
  const b = dashboardState.belief;
  const panel = document.getElementById('beliefPanel');
  if (!panel) return;
  if (!b) { panel.innerHTML = '<p class="text-muted">No belief data.</p>'; return; }
  const tc = b.belief === 'bullish' ? 'text-success' : b.belief === 'bearish' ? 'text-danger' : 'text-secondary';
  panel.innerHTML = `<div class="card"><div class="card-body">
    <h6 class="card-title">Market Belief</h6>
    <p class="${tc}" style="font-size:1.2rem; font-weight:bold;">${b.belief.toUpperCase()} (${b.beliefConfidence || 50}%)</p>
    <p>Edge: ${b.edge?.toFixed(3) || 0} R | P(win): ${(b.winProbability * 100).toFixed(1)}%</p>
    <p>Similarity: ${b.similarityCount || 0} | Quality: ${b.marketQuality || 50}/100</p>
  </div></div>`;
}

function renderPredictionWidget() {
  const p = dashboardState.prediction;
  const panel = document.getElementById('predictionPanel');
  if (!panel) return;
  if (!p) { panel.innerHTML = '<p class="text-muted">Waiting for prediction data...</p>'; return; }
  const up = (p.probabilities?.up || 0) * 100;
  const down = (p.probabilities?.down || 0) * 100;
  const neu = (p.probabilities?.neutral || 0) * 100;
  const srcBadge = p.source
    ? `<span class="badge bg-${p.source === 'combined' ? 'success' : p.source === 'strategy' ? 'info' : 'secondary'} ms-2">${p.source}</span>`
    : '';
  panel.innerHTML = `<div class="row">
    <div class="col-md-8">
      <div class="prediction-bar">
        <div class="prob-block prob-up"><div class="value">${up.toFixed(0)}%</div><div class="label">UP</div></div>
        <div class="prob-block prob-down"><div class="value">${down.toFixed(0)}%</div><div class="label">DOWN</div></div>
        <div class="prob-block prob-neutral"><div class="value">${neu.toFixed(0)}%</div><div class="label">NEUTRAL</div></div>
        <div style="margin-left:auto; text-align:right;">
          <div><small>Confidence: <strong>${p.calibratedConfidence || 0}%</strong>${srcBadge}</small></div>
          <div><small>Direction: <strong>${p.direction || '—'}</strong></small></div>
        </div>
      </div>
      <div class="mt-2"><small>Expected: <strong>${((p.expectedMove || 0) * 10000).toFixed(1)} pips</strong> | Fav: ${((p.expectedFavorable || 0) * 10000).toFixed(1)} | Adv: ${((p.expectedAdverse || 0) * 10000).toFixed(1)}</small></div>
      <div class="mt-1"><small>Sample: ${p.sampleSize || 0} · Effective: ${(p.effectiveSampleSize || 0).toFixed(1)} · Mode: ${p.modeLabel || '—'}</small></div>
    </div>
  </div>`;
}

function renderOpportunityWidget() {
  const o = dashboardState.opportunity;
  const panel = document.getElementById('opportunityPanel');
  if (!panel) return;
  if (!o) { panel.innerHTML = '<p class="text-muted">Waiting for opportunity data...</p>'; return; }
  if (!o.tradable) {
    panel.innerHTML = `<div class="opportunity-card no-trade">
      <h6 class="mb-1"><i class="fas fa-times-circle text-danger"></i> NO TRADE</h6>
      <p class="mb-0 small">${o.reason || 'Does not meet criteria'}</p>
    </div>`;
    return;
  }
  panel.innerHTML = `<div class="opportunity-card trade">
    <h6 class="mb-1"><i class="fas fa-check-circle text-success"></i> TRADE OPPORTUNITY (${o.source || 'analogue'})</h6>
    <p class="mb-1"><strong>${o.direction}</strong> | Stake: $${(o.stake || 0).toFixed(2)} | Mult: ${o.multiplier}x | Dur: ${o.duration}s</p>
    <p class="mb-1 small">Entry: ${formatPrice(o.entryPrice)} | KO: ${formatPrice(o.knockoutLevel)} | TP: ${formatPrice(o.takeProfitLevel)}</p>
    <p class="mb-0 small">EV: $${(o.tradeEconomics?.ev || 0).toFixed(2)} | P(TP): ${((o.tradeEconomics?.probTP || 0) * 100).toFixed(0)}% | P(SL): ${((o.tradeEconomics?.probSL || 0) * 100).toFixed(0)}%</p>
  </div>`;
}

// ================================================================
// [FILE-8] Live Signal Engine panel
// ================================================================
// Called by live.js on 'strategyConsensus' WS events.
window.onStrategyConsensus = function (payload) {
  if (!payload || !payload.symbol) return;
  const sym = formatSymbol(payload.symbol);
  if (!dashboardState.strategyConsensus) dashboardState.strategyConsensus = {};
  dashboardState.strategyConsensus[sym] = payload;
  renderLiveSignalPanel();
};

// Called by live.js on 'opportunity' WS events (in addition to the widget).
window.onOpportunityUpdate = function (payload) {
  if (!payload || !payload.prediction?.symbol) return;
  const sym = formatSymbol(payload.prediction.symbol);
  if (!dashboardState.signalOpportunities) dashboardState.signalOpportunities = {};
  dashboardState.signalOpportunities[sym] = payload;
  if (payload.prediction) {
    if (!dashboardState.signalPredictions) dashboardState.signalPredictions = {};
    dashboardState.signalPredictions[sym] = payload.prediction;
  }
  renderLiveSignalPanel();
};

// Called by live.js on 'prediction' WS events
window.onPredictionUpdate = function (payload) {
  if (!payload || !payload.symbol) return;
  const sym = formatSymbol(payload.symbol);
  if (!dashboardState.signalPredictions) dashboardState.signalPredictions = {};
  dashboardState.signalPredictions[sym] = payload;
  // Note: don't re-render Live Signal panel on every prediction —
  // the opportunity event (which follows) drives the actionable state.
};

// Build the full signal view for one symbol from the state maps.
function buildSignalView(symbol) {
  const sym = formatSymbol(symbol);
  const consensus = dashboardState.strategyConsensus[sym] || null;
  const prediction = dashboardState.signalPredictions[sym] || null;
  const opportunity = dashboardState.signalOpportunities[sym] || null;
  return { sym, consensus, prediction, opportunity };
}

// Render the Live Signal Engine panel.
function renderLiveSignalPanel() {
  const container = document.getElementById('liveSignalEngineContent');
  if (!container) return;

  const symbols = (window.WATCHED_SYMBOLS || ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'])
    .map(s => formatSymbol(s));

  // Header badge
  const headerBadge = document.getElementById('liveSignalEngineBadge');
  if (headerBadge) {
    const ready = symbols.filter(s => {
      const c = dashboardState.strategyConsensus[s];
      const o = dashboardState.signalOpportunities[s];
      return c && o && o.tradable;
    }).length;
    const active = symbols.filter(s => dashboardState.strategyConsensus[s]).length;
    if (ready > 0) {
      headerBadge.textContent = `${ready} actionable`;
      headerBadge.className = 'badge bg-success';
    } else if (active > 0) {
      headerBadge.textContent = `${active} evaluated`;
      headerBadge.className = 'badge bg-info';
    } else {
      headerBadge.textContent = 'Waiting...';
      headerBadge.className = 'badge bg-secondary';
    }
  }

  const cards = symbols.map(sym => {
    const { consensus, prediction, opportunity } = buildSignalView(sym);
    if (!consensus && !prediction && !opportunity) {
      return renderWaitingSignalCard(sym);
    }
    return renderSignalCard(sym, consensus, prediction, opportunity);
  });

  container.innerHTML = cards.join('');
}

function renderWaitingSignalCard(sym) {
  return `
    <div class="card mb-3">
      <div class="card-body text-muted small">
        <strong>${symbolToDisplay(sym)}</strong> — awaiting first pipeline cycle (runs every 30s)
      </div>
    </div>
  `;
}

function renderSignalCard(sym, consensus, prediction, opportunity) {
  const c = consensus || {};
  const o = opportunity || null;
  const p = prediction || {};

  // Determine overall card state
  const isTradable = o && o.tradable === true;
  const isConflict = c.action === 'CONFLICT';
  const isNeutral = c.action === 'NEUTRAL';
  const isSignal = c.action === 'SIGNAL';

  const borderColor = isTradable ? '#00b894'
    : isConflict ? '#e74c5e'
    : isNeutral ? '#cbd5e1'
    : isSignal ? '#3b82f6'
    : '#e2e8f0';

  const bgColor = isTradable ? '#f0fdf4'
    : isConflict ? '#fef2f2'
    : '#ffffff';

  // Consensus header line
  let consensusLine = '';
  if (isSignal && c.direction) {
    const dirClass = c.direction === 'BUY' ? 'success' : 'danger';
    consensusLine = `<span class="badge bg-${dirClass} fs-6">${c.direction}</span>
      <span class="ms-2">confidence <strong>${c.confidence}%</strong></span>
      <span class="ms-2 text-muted small">${(c.agreeing || []).length}/${(c.strategies || []).length} strategies agree</span>
      ${c.anchorStrategy ? `<span class="ms-2 small">anchor: <strong>${c.anchorStrategy}</strong></span>` : ''}`;
  } else if (isConflict) {
    consensusLine = `<span class="badge bg-danger fs-6">CONFLICT</span>
      <span class="ms-2 text-muted small">strategies disagree — no trade</span>`;
  } else if (isNeutral) {
    consensusLine = `<span class="badge bg-secondary fs-6">NEUTRAL</span>
      <span class="ms-2 text-muted small">insufficient weight — no trade</span>`;
  } else {
    consensusLine = `<span class="badge bg-secondary fs-6">—</span>
      <span class="ms-2 text-muted small">no consensus yet</span>`;
  }

  // Strategy rows
  const rows = (c.strategies || []).map(r => {
    let statusIcon = '';
    let statusClass = 'text-muted';
    if (r.status === 'AGREE') { statusIcon = '✓'; statusClass = 'text-success fw-bold'; }
    else if (r.status === 'CONFLICT') { statusIcon = '✗'; statusClass = 'text-danger fw-bold'; }
    else if (r.status === 'FLAGGED') { statusIcon = '⊘'; statusClass = 'text-warning'; }
    else if (r.status === 'BELOW_THRESHOLD') { statusIcon = '·'; statusClass = 'text-muted'; }

    const sideBadge = r.signalSide
      ? `<span class="badge bg-${r.signalSide === 'BUY' ? 'success' : 'danger'}" style="font-size:0.7em;">${r.signalSide}</span>`
      : `<span class="badge bg-light text-muted" style="font-size:0.7em;">—</span>`;

    const wr = Number(r.effectiveWinRate || 0) * 100;
    const wrClass = wr >= 60 ? 'text-success' : (wr >= 50 ? 'text-muted' : 'text-danger');

    return `<div class="d-flex justify-content-between align-items-center py-1" style="font-size:0.8em; border-bottom:1px solid #f1f5f9;">
      <div class="d-flex align-items-center gap-2">
        <span class="${statusClass}" style="width:14px; display:inline-block; text-align:center;">${statusIcon}</span>
        <span style="min-width:80px;"><strong>${r.name}</strong></span>
        ${sideBadge}
      </div>
      <div class="d-flex align-items-center gap-3">
        <span class="${wrClass}" title="effective win rate">
          ${wr.toFixed(0)}%<span class="text-muted"> (${r.trades || 0})</span>
        </span>
        <span class="text-muted" title="weight">w=${(r.weight || 0).toFixed(2)}</span>
      </div>
    </div>`;
  }).join('');

  // Opportunity block (only when tradable)
  let opportunityBlock = '';
  if (isTradable) {
    const eco = o.tradeEconomics || {};
    const stratInfo = o.strategyInfo || {};
    opportunityBlock = `
      <div class="mt-3 p-3 rounded" style="background:rgba(255,255,255,0.7); border:1px solid #bbf7d0;">
        <div class="row small">
          <div class="col-md-6">
            <div><strong>Trade:</strong> ${o.direction} ${symbolToDisplay(sym)}</div>
            <div><strong>Entry:</strong> ${formatPrice(o.entryPrice)}</div>
            <div><strong>Stop:</strong> ${formatPrice(o.knockoutLevel)}</div>
            <div><strong>Target:</strong> ${formatPrice(o.takeProfitLevel)}</div>
          </div>
          <div class="col-md-6">
            <div><strong>Stake:</strong> $${(o.stake || 0).toFixed(2)}</div>
            <div><strong>Multiplier:</strong> ${o.multiplier}x</div>
            <div><strong>Duration:</strong> ${o.duration}s</div>
            <div><strong>Source:</strong> <span class="badge bg-info">${o.source || 'analogue'}</span></div>
          </div>
        </div>
        <div class="row small mt-2">
          <div class="col-4">P(TP): <strong>${((eco.probTP || 0) * 100).toFixed(0)}%</strong></div>
          <div class="col-4">P(SL): <strong>${((eco.probSL || 0) * 100).toFixed(0)}%</strong></div>
          <div class="col-4">EV: <strong>$${(eco.ev || 0).toFixed(2)}</strong> (${((eco.evOverStake || 0) * 100).toFixed(1)}% of stake)</div>
        </div>
        ${stratInfo.anchorStrategy ? `
          <div class="small mt-1 text-muted">
            Anchor: <strong>${stratInfo.anchorStrategy}</strong>
            ${(stratInfo.agreeing || []).length > 1 ? ` · Also agree: ${(stratInfo.agreeing || []).filter(s => s !== stratInfo.anchorStrategy).join(', ')}` : ''}
          </div>
        ` : ''}
        <div class="mt-2">
          <button class="btn btn-sm btn-success" onclick="window.executeLiveSignal('${sym}')">
            <i class="fas fa-play"></i> Execute Trade
          </button>
          <button class="btn btn-sm btn-outline-secondary ms-2" onclick="window.dismissSignal('${sym}')">
            Dismiss
          </button>
        </div>
      </div>
    `;
  } else if (o && !o.tradable) {
    opportunityBlock = `
      <div class="mt-2 small text-muted">
        <i class="fas fa-ban"></i> ${o.reason || 'Not tradable'}
      </div>
    `;
  }

  // Prediction summary line
  let predictionLine = '';
  if (p && p.modeLabel) {
    const srcBadge = p.source
      ? `<span class="badge bg-${p.source === 'combined' ? 'success' : p.source === 'strategy' ? 'info' : 'secondary'}" style="font-size:0.7em;">${p.source}</span>`
      : '';
    predictionLine = `<div class="small text-muted mt-1">
      Prediction: ${p.direction || '—'} · ${p.calibratedConfidence || 0}% · mode ${p.modeLabel} ${srcBadge}
    </div>`;
  }

  return `
    <div class="card mb-3" style="border-left: 4px solid ${borderColor}; background: ${bgColor};">
      <div class="card-body">
        <div class="d-flex justify-content-between align-items-start mb-2">
          <div>
            <h6 class="mb-1">${symbolToDisplay(sym)} <span class="text-muted small ms-2">${c.regime || ''}</span></h6>
            <div>${consensusLine}</div>
          </div>
          <div class="text-end small text-muted">
            ${c.evaluatedAt ? new Date(c.evaluatedAt).toLocaleTimeString() : ''}
          </div>
        </div>
        ${predictionLine}
        ${rows ? `<div class="mt-2">${rows}</div>` : ''}
        ${opportunityBlock}
      </div>
    </div>
  `;
}

// Execute button handler — posts with strategy attribution
window.executeLiveSignal = async function (symbol) {
  const sym = formatSymbol(symbol);
  const opportunity = dashboardState.signalOpportunities[sym];
  const consensus = dashboardState.strategyConsensus[sym];

  if (!opportunity || !opportunity.tradable) {
    alert('No tradable opportunity for ' + symbol);
    return;
  }

  const stratInfo = opportunity.strategyInfo || {};
  const strategy = stratInfo.anchorStrategy
    || opportunity.prediction?.strategyConsensus?.anchorStrategy
    || consensus?.anchorStrategy
    || null;
  const regimeCode = opportunity.prediction?.regime
    || consensus?.regime
    || null;

  const confirmMsg =
    `Execute ${opportunity.direction} ${symbolToDisplay(sym)}?\n\n` +
    `Entry:  ${formatPrice(opportunity.entryPrice)}\n` +
    `Stop:   ${formatPrice(opportunity.knockoutLevel)}\n` +
    `Target: ${formatPrice(opportunity.takeProfitLevel)}\n` +
    `Stake:  $${(opportunity.stake || 0).toFixed(2)}\n` +
    `Mult:   ${opportunity.multiplier}x\n` +
    `Dur:    ${opportunity.duration}s\n` +
    `Source: ${opportunity.source || 'analogue'}\n` +
    (strategy ? `Strategy: ${strategy}\n` : '') +
    (regimeCode ? `Regime: ${regimeCode}\n` : '');

  if (!confirm(confirmMsg)) return;

  const body = {
    pair: symbol.replace(/_/g, '/'),
    side: opportunity.direction,
    stake: opportunity.stake,
    multiplier: opportunity.multiplier,
    duration: opportunity.duration,
    knockoutLevel: opportunity.knockoutLevel,
    takeProfitLevel: opportunity.takeProfitLevel,
    product: 'deriv_cfd',
    // [FILE-8] strategy attribution
    strategy,
    regimeCode,
  };

  const result = await placeOrderFetch('/api/trade', body);
  showOrderOutcome(result);

  // Clear the signal from local state so the same one isn't re-executed
  if (result.body?.success && (result.body?.status === 'FILLED' || result.body?.status === 'CONFIRMED_RECORD_FAILED')) {
    delete dashboardState.signalOpportunities[sym];
    renderLiveSignalPanel();
  }
};

window.dismissSignal = function (symbol) {
  const sym = formatSymbol(symbol);
  delete dashboardState.signalOpportunities[sym];
  renderLiveSignalPanel();
};

// ================================================================
// OTIE panel (unchanged from File-4-of-4)
// ================================================================
window.onOtieState = function (state) {
  if (!state || !state.tradeId) return;
  if (!dashboardState.otieStates) dashboardState.otieStates = {};
  if (state.action === 'RELEASED') {
    delete dashboardState.otieStates[state.tradeId];
  } else {
    dashboardState.otieStates[state.tradeId] = state;
  }
  if (typeof window.renderOTIEPanel === 'function') window.renderOTIEPanel();
  if (typeof window.renderPositionsWidget === 'function') window.renderPositionsWidget();
};

function _sparklinePoints(values, width, height) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const range = max - min || 1;
  const pad = height * 0.1;
  const usable = height - pad * 2;
  const stepX = width / Math.max(values.length - 1, 1);
  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = pad + (1 - (v - min) / range) * usable;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const zeroY = pad + (1 - (0 - min) / range) * usable;
  return { points, zeroY: zeroY.toFixed(1) };
}

function renderOTIEPanel() {
  const container = document.getElementById('otieContent');
  if (!container) return;

  const states = dashboardState.otieStates || {};
  const ids = Object.keys(states).sort();

  const placeholder = document.querySelector('#otiePanel > p.text-muted');
  if (placeholder) placeholder.style.display = ids.length > 0 ? 'none' : 'block';

  const headerBadge = document.querySelector('#section-trademanagement .card-header .badge');
  if (headerBadge) {
    const pendingClose = ids.filter(id => states[id].action === 'CLOSE').length;
    if (pendingClose > 0) {
      headerBadge.textContent = `${ids.length} monitored · ${pendingClose} closing`;
      headerBadge.className = 'badge bg-danger';
    } else if (ids.length > 0) {
      headerBadge.textContent = `${ids.length} monitored`;
      headerBadge.className = 'badge bg-success';
    } else {
      headerBadge.textContent = 'Idle';
      headerBadge.className = 'badge bg-secondary';
    }
  }

  if (ids.length === 0) {
    container.innerHTML = '<p class="text-muted">No open contracts to monitor.</p>';
    return;
  }

  let html = '';
  for (const id of ids) html += _renderOtieCard(states[id]);
  container.innerHTML = html;
}

function _renderOtieCard(s) {
  const isClose = s.action === 'CLOSE';
  const borderColor = isClose ? '#e74c5e' : '#00b894';
  const bgColor = isClose ? '#fef2f2' : '#f0fdf4';
  const statusColor = isClose ? 'bg-danger' : 'bg-success';
  const profitColor = Number(s.profit) >= 0 ? '#00b894' : '#e74c5e';

  const t = s.thresholds || {};
  const ddPct = (Number(s.drawdownPct || 0) * 100).toFixed(0);
  const ddThreshold = t.drawdownClosePct ? (t.drawdownClosePct * 100).toFixed(0) : '40';
  const ddWarn = parseFloat(ddPct) > parseFloat(ddThreshold) * 0.75;
  const ddColor = ddWarn ? '#e74c5e' : '#6b7a8f';

  const revThreshold = t.chopMaxReversals || 8;
  const revWarn = Number(s.reversals) >= revThreshold * 0.75;
  const revColor = revWarn ? '#e74c5e' : '#6b7a8f';

  const spark = _sparklinePoints(s.history, 300, 50);
  const sparkSvg = spark ? `
    <svg width="100%" height="50" viewBox="0 0 300 50" preserveAspectRatio="none" style="display:block;">
      <line x1="0" y1="${spark.zeroY}" x2="300" y2="${spark.zeroY}" stroke="#cbd5e1" stroke-dasharray="2,2" stroke-width="1"/>
      <polyline points="${spark.points}" fill="none" stroke="${profitColor}" stroke-width="2"/>
    </svg>
  ` : '';

  return `
    <div style="border-left: 4px solid ${borderColor}; background: ${bgColor}; border-radius: 8px; padding: 16px; margin-bottom: 12px;">
      <div class="d-flex justify-content-between align-items-center mb-2">
        <div>
          <strong style="font-size: 1.05em;">${s.symbol}</strong>
          <span class="badge ${s.side === 'BUY' ? 'bg-success' : 'bg-danger'} ms-2">${s.side}</span>
          <span class="badge bg-primary ms-1">${s.multiplier}x</span>
          <span class="text-muted ms-2 small">$${Number(s.stake).toFixed(2)} stake</span>
        </div>
        <div>
          <span class="badge ${statusColor}">${s.action}</span>
          <span class="text-muted ms-2" style="font-size:0.75em;">
            ${(Number(s.age) / 1000).toFixed(0)}s · ${s.tickCount || 0} ticks
          </span>
        </div>
      </div>

      <div class="row text-center mb-2">
        <div class="col-3">
          <div class="small text-muted" style="font-size:0.7em; text-transform:uppercase;">Profit</div>
          <div style="font-size: 1.3em; font-weight: 700; color: ${profitColor};">
            ${Number(s.profit) >= 0 ? '+' : ''}$${Number(s.profit).toFixed(2)}
          </div>
          <div class="small text-muted" style="font-size:0.7em;">${Number(s.profitR) >= 0 ? '+' : ''}${Number(s.profitR).toFixed(2)}R</div>
        </div>
        <div class="col-3">
          <div class="small text-muted" style="font-size:0.7em; text-transform:uppercase;">Peak</div>
          <div style="font-size: 1.3em; font-weight: 700; color: #00b894;">
            +$${Number(s.peak).toFixed(2)}
          </div>
          <div class="small text-muted" style="font-size:0.7em;">${Number(s.peakR).toFixed(2)}R</div>
        </div>
        <div class="col-3">
          <div class="small text-muted" style="font-size:0.7em; text-transform:uppercase;">Drawdown</div>
          <div style="font-size: 1.3em; font-weight: 700; color: ${ddColor};">
            ${ddPct}%
          </div>
          <div class="small text-muted" style="font-size:0.7em;">limit ${ddThreshold}%</div>
        </div>
        <div class="col-3">
          <div class="small text-muted" style="font-size:0.7em; text-transform:uppercase;">Reversals</div>
          <div style="font-size: 1.3em; font-weight: 700; color: ${revColor};">
            ${s.reversals || 0}
          </div>
          <div class="small text-muted" style="font-size:0.7em;">limit ${revThreshold}</div>
        </div>
      </div>

      ${sparkSvg ? `<div style="margin: 8px 0 4px;">${sparkSvg}</div>` : ''}

      <div class="d-flex justify-content-between small text-muted" style="font-size:0.75em;">
        <div>
          <strong>Slope:</strong> ${Number(s.slope || 0).toFixed(4)}$/tick
          · <strong>Flat:</strong> ${(Number(s.flatTime) / 1000).toFixed(0)}s
          · <strong>Since peak:</strong> ${(Number(s.timeSincePeak) / 1000).toFixed(0)}s
        </div>
        <div><strong>Contract:</strong> <span style="font-family: monospace;">${s.tradeId}</span></div>
      </div>

      ${isClose && s.reason ? `
        <div class="alert alert-danger mt-2 mb-0 py-2 small">
          <strong>CLOSE TRIGGER:</strong> ${s.reason}
        </div>
      ` : ''}
    </div>
  `;
}

window.renderOTIEPanel = renderOTIEPanel;
window.renderLiveSignalPanel = renderLiveSignalPanel;

// ================================================================
// History table
// ================================================================
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
    if (symbol && !t.pair?.toUpperCase().includes(symbol.toUpperCase())) return false;
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
  const setDisabled = (id, val) => { const el = document.getElementById(id); if (el) el.disabled = val; };
  setTxt('pageStart', filtered.length > 0 ? start + 1 : 0);
  setTxt('pageEnd', end);
  setTxt('pageTotal', filtered.length);
  setTxt('pageInfo', `Page ${historyPage} of ${historyTotalPages}`);
  setDisabled('prevPage', historyPage <= 1);
  setDisabled('nextPage', historyPage >= historyTotalPages);

  const container = document.getElementById('historyContainer');
  if (!container) return;
  if (pageItems.length === 0) { container.innerHTML = '<p class="text-muted">No matching records.</p>'; return; }

  let html = `<div class="table-responsive"><table class="table table-striped table-sm">
    <thead><tr><th>Pair</th><th>Side</th><th>Entry</th><th>Exit</th><th>Lot</th><th>P/L</th><th>Status</th><th>Date</th></tr></thead><tbody>`;
  pageItems.forEach(t => {
    const pl = t.pnl ? parseFloat(t.pnl).toFixed(2) : '0.00';
    const sc = t.status === 'OPEN' ? 'bg-primary' : (t.pnl >= 0 ? 'bg-success' : 'bg-danger');
    html += `<tr>
      <td>${t.pair}</td>
      <td><span class="badge ${t.side === 'BUY' ? 'bg-success' : 'bg-danger'}">${t.side}</span></td>
      <td>${t.entryPrice !== null ? formatPrice(t.entryPrice) : '-'}</td>
      <td>${t.exitPrice !== null ? formatPrice(t.exitPrice) : '-'}</td>
      <td>${t.lotSize}</td>
      <td class="${pl >= 0 ? 'text-success' : 'text-danger'}">${pl}</td>
      <td><span class="badge ${sc}">${t.status}</span></td>
      <td>${new Date(t.date).toLocaleString()}</td>
    </tr>`;
  });
  html += '</tbody></table></div>';
  container.innerHTML = html;
}

// ================================================================
// Manual refresh
// ================================================================
async function refreshAllData() {
  try {
    const [account, positions, history, pending] = await Promise.all([
      fetchJson('/api/account'),
      fetchJson('/api/trades'),
      fetchJson('/api/trade-history'),
      fetchJson('/api/pending-orders'),
    ]);
    updateDashboardState({ account, positions, history, pendingOrders: pending });
  } catch (e) { console.error('Refresh error:', e); }
}

// [FILE-8] Fetch the full signal state from /api/signal/active
async function refreshSignals() {
  if (_activeSignalFetchInFlight) return;
  _activeSignalFetchInFlight = true;
  try {
    const data = await fetchJson('/api/signal/active');
    if (data && data.signals) {
      const consensus = {};
      const opportunities = {};
      const predictions = {};
      for (const [sym, payload] of Object.entries(data.signals)) {
        if (payload.consensus) consensus[sym] = payload.consensus;
        if (payload.opportunity) opportunities[sym] = payload.opportunity;
        if (payload.prediction) predictions[sym] = payload.prediction;
      }
      dashboardState.strategyConsensus = { ...dashboardState.strategyConsensus, ...consensus };
      dashboardState.signalOpportunities = { ...dashboardState.signalOpportunities, ...opportunities };
      dashboardState.signalPredictions = { ...dashboardState.signalPredictions, ...predictions };
      renderLiveSignalPanel();
    }
  } catch (e) {
    console.warn('[App] refreshSignals failed:', e.message);
  } finally {
    _activeSignalFetchInFlight = false;
  }
}

// ================================================================
// User actions
// ================================================================
async function closeTrade(tradeId) {
  if (!confirm(`Close contract ${tradeId}?`)) return;
  try {
    const res = await fetchJson(`/api/close/${tradeId}`, { method: 'PUT' });
    SoundManager.tradeClose();
    console.log('[App] Close confirmed:', res);
  } catch (e) {
    alert('Error closing trade: ' + e.message);
    SoundManager.reject();
  }
}

async function cancelPending(orderId) {
  if (!confirm(`Cancel order ${orderId}?`)) return;
  try {
    await fetchJson(`/api/order/${orderId}`, { method: 'DELETE' });
  } catch (e) { alert('Error cancelling: ' + e.message); }
}

// ================================================================
// Trade form — status-aware
// ================================================================
function showOrderOutcome(result) {
  const status = result.body?.status;
  const contractId = result.body?.contractId ? String(result.body.contractId) : null;

  if (status === 'FILLED' || (result.body?.success && status !== 'CONFIRMED_RECORD_FAILED')) {
    SoundManager.tradeOpen();
    alert(`✅ Trade placed\n\nContract: ${contractId || '?'}\nEntry: ${result.body?.entryPrice ?? '—'}\nPurchase: ${result.body?.purchasePrice ?? '—'}\nStrategy: ${result.body?.strategy ?? '(none)'}\n\nLive P/L will appear in Open Positions.`);
    refreshAllData();
  } else if (status === 'CONFIRMED_RECORD_FAILED') {
    SoundManager.danger();
    alert(`⚠️ Purchase CONFIRMED but record save failed.\n\nContract: ${contractId}\n\nDO NOT RETRY — the contract is live at Deriv and will be picked up by reconciliation.`);
    refreshAllData();
  } else if (status === 'REJECTED') {
    SoundManager.reject();
    alert(`❌ Order rejected\n\n${result.body?.error || 'No reason'}\n\nSafe to retry after correcting the input.`);
  } else if (status === 'BROKER_ERROR' || result.httpStatus >= 500) {
    SoundManager.danger();
    alert(`❗ Broker error — purchase may have completed.\n\n${result.body?.error || ''}\n\nDO NOT click Place Trade again without first checking Open Positions.`);
  } else {
    SoundManager.danger();
    alert(`❓ Unexpected response (HTTP ${result.httpStatus}):\n${JSON.stringify(result.body)}\n\nCheck Open Positions before retrying.`);
  }
}

// ================================================================
// Expose to live.js
// ================================================================
window.dashboardState = dashboardState;
window.updateDashboardState = updateDashboardState;
window.renderPositionsWidget = renderPositionsWidget;
window.renderLiveMonitorStatus = renderLiveMonitorStatus;
window.renderPriceWidgets = renderPriceWidgets;
window.renderAccountWidget = renderAccountWidget;
window.renderHistoryWidget = renderHistoryWidget;
window.renderOTIEPanel = renderOTIEPanel;
window.SoundManager = SoundManager;
window.closeTrade = closeTrade;
window.cancelPending = cancelPending;
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
  const typeEl = document.getElementById('accountTypeLabel');
  const curEl = document.getElementById('accountCurrency');
  if (idEl) idEl.textContent = acc.id || acc.login || '—';
  if (curEl) curEl.textContent = acc.currency || 'USD';
  if (typeEl) {
    const srv = (acc.server || '').toLowerCase();
    const type = srv.includes('demo') ? 'demo' : 'real';
    typeEl.textContent = type.toUpperCase();
    typeEl.className = 'account-type ' + type;
  }
};

window.executeSignalFromCard = function (btn) {
  const card = btn.closest('.live-signal-card');
  if (!card) return;
  let sym = (card.dataset.symbol || '').toUpperCase().replace(/^FRX/, '');
  if (sym.length === 6) sym = sym.slice(0, 3) + '_' + sym.slice(3);
  const side = (card.dataset.side || '').toUpperCase();

  const pair = document.getElementById('tradePair');
  const sideSel = document.getElementById('tradeSide');
  const stakeIn = document.getElementById('tradeStake');
  if (!pair || !sideSel) { alert('Trade form not available.'); return; }
  pair.value = sym;
  sideSel.value = side === 'SELL' ? 'SELL' : 'BUY';
  if (stakeIn && !stakeIn.value) stakeIn.value = '10';

  const tab = document.querySelector('.sidebar-nav .nav-item[data-section="trading"]');
  if (tab) tab.click();
};

window.openDecisionInspector = function (id) { alert('Decision inspector not implemented for ' + id); };
window.exportHistoryCSV = function () {
  const h = dashboardState.history || [];
  if (h.length === 0) { alert('No history to export.'); return; }
  let csv = 'Pair,Side,Entry,Exit,Lot,P/L,Status,Date\n';
  h.forEach(t => {
    csv += `${t.pair},${t.side},${t.entryPrice},${t.exitPrice},${t.lotSize},${t.pnl},${t.status},${new Date(t.date).toISOString()}\n`;
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `trade_history_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
};

// ================================================================
// DOM wiring
// ================================================================
document.addEventListener('DOMContentLoaded', async function () {
  try {
    if (typeof loadProductPreference === 'function') await loadProductPreference();
  } catch (e) {}

  await Promise.all([
    refreshAllData().catch(() => {}),
    refreshSignals().catch(() => {}),
  ]);

  // Poll /api/signal/active every 30s as a fallback if WS is down
  setInterval(() => {
    if (document.visibilityState === 'visible') refreshSignals();
  }, 30000);

  document.getElementById('getSignalBtn')?.addEventListener('click', async function () {
    const pair = document.getElementById('signalPair').value.trim();
    const strategy = document.getElementById('signalStrategy').value;
    if (!pair) { alert('Enter a pair.'); return; }
    try {
      const result = await fetchJson(`/api/signal?symbol=${encodeURIComponent(pair)}&strategy=${encodeURIComponent(strategy)}`);
      const c = document.getElementById('signalResult');
      if (result.signal) {
        c.innerHTML = `<div class="alert alert-${result.signal === 'BUY' ? 'success' : result.signal === 'SELL' ? 'danger' : 'secondary'}">
          <strong>${result.signal}</strong> (${result.confidence || 0}%)<br><small>${result.reason || ''}</small>
        </div>`;
      } else {
        c.innerHTML = `<div class="alert alert-info">${result.message || 'No signal'}</div>`;
      }
    } catch (e) { alert('Error: ' + e.message); }
  });

  document.getElementById('tradeForm')?.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (isSubmitting) return;
    isSubmitting = true;
    const pair = document.getElementById('tradePair').value.trim();
    const side = document.getElementById('tradeSide').value;
    const stake = parseFloat(document.getElementById('tradeStake').value);
    const multiplier = parseFloat(document.getElementById('tradeMultiplier').value);
    const duration = parseInt(document.getElementById('tradeDuration').value);
    const ko = parseFloat(document.getElementById('tradeKnockout').value) || null;
    const tp = parseFloat(document.getElementById('tradeTP').value) || null;

    if (!pair || !stake || stake <= 0 || !multiplier || !duration) {
      alert('Fill in all required fields.'); isSubmitting = false; return;
    }

    const result = await placeOrderFetch('/api/trade', {
      pair, side, stake, multiplier, duration,
      knockoutLevel: ko, takeProfitLevel: tp,
      product: document.getElementById('currentProduct')?.textContent || 'deriv_cfd',
    });
    showOrderOutcome(result);
    isSubmitting = false;
  });

  document.getElementById('autoTradeForm')?.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (isAutoSubmitting) return;
    isAutoSubmitting = true;
    const pair = document.getElementById('autoPair').value.trim();
    const risk = parseFloat(document.getElementById('autoRisk').value);
    const strategy = document.getElementById('autoStrategy').value;
    if (!pair || !risk || risk <= 0) { alert('Fill all fields.'); isAutoSubmitting = false; return; }

    const result = await placeOrderFetch('/api/auto-trade', { pair, riskPercent: risk, strategy });
    const status = result.body?.status;
    if (status === 'FILLED' || (result.body?.success && status !== 'CONFIRMED_RECORD_FAILED')) {
      SoundManager.tradeOpen();
      alert(`✅ Auto-trade placed\nContract: ${result.body?.contractId || '?'}`);
      refreshAllData();
    } else if (status === 'CONFIRMED_RECORD_FAILED') {
      SoundManager.danger();
      alert(`⚠️ Confirmed ${result.body?.contractId} but record failed. DO NOT retry.`);
    } else if (status === 'REJECTED' || status === 'NO_SIGNAL') {
      SoundManager.reject();
      alert(`Not placed: ${result.body?.message || result.body?.error || 'No signal'}`);
    } else {
      SoundManager.danger();
      alert(`❗ Broker error — check positions before retrying.\n${result.body?.error || ''}`);
    }
    isAutoSubmitting = false;
  });

  document.getElementById('applyHistoryFilter')?.addEventListener('click', applyHistoryFilters);
  document.getElementById('resetHistoryFilter')?.addEventListener('click', function () {
    ['historyFrom', 'historyTo', 'historySymbol', 'historySide', 'historyStatus'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    applyHistoryFilters();
  });
  document.getElementById('prevPage')?.addEventListener('click', function () {
    if (historyPage > 1) { historyPage--; renderHistoryTable(); }
  });
  document.getElementById('nextPage')?.addEventListener('click', function () {
    if (historyPage < historyTotalPages) { historyPage++; renderHistoryTable(); }
  });

  document.getElementById('refreshTrades')?.addEventListener('click', refreshAllData);
  document.getElementById('refreshHistory')?.addEventListener('click', refreshAllData);
  document.getElementById('refreshPending')?.addEventListener('click', refreshAllData);
  document.getElementById('refreshLiveSignals')?.addEventListener('click', refreshSignals);

  document.getElementById('deleteHistoryBtn')?.addEventListener('click', async function () {
    if (!confirm('Delete all closed trades? This cannot be undone.')) return;
    try {
      const r = await fetchJson('/api/history', { method: 'DELETE' });
      alert(`Deleted ${r.deletedCount} trades.`);
      refreshAllData();
    } catch (e) { alert('Error: ' + e.message); }
  });

  document.getElementById('exportCSVBtn')?.addEventListener('click', function () {
    if (typeof window.exportHistoryCSV === 'function') window.exportHistoryCSV();
  });
  document.getElementById('generateReportBtn')?.addEventListener('click', function () {
    const modal = bootstrap.Modal.getInstance(document.getElementById('reportModal'));
    if (modal) modal.hide();
    alert('Report generation endpoint not yet implemented on the server.');
  });

  // Initial render of Live Signal panel (empty until first WS event)
  renderLiveSignalPanel();
});

console.log('✅ app.js loaded — Live Signal Engine + OTIE V6 trajectory panel active.');
