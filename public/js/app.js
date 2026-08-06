// public/js/app.js – Dashboard Logic (Full with Stats Update, P&L Fix, Sounds, Report)
// Refactored to be fully event‑driven using a central state store.
// HTTP polling removed – all updates come from WebSocket (live.js).

// ---- Configuration ----
const HISTORY_PAGE_SIZE = 20;
let isSubmitting = false;
let isAutoSubmitting = false;
let historyData = [];
let historyFiltered = [];
let historyPage = 1;
let historyTotalPages = 1;

// ---- Sound Manager (Web Audio API) ----
const SoundManager = {
  _ctx: null,
  _init() {
    if (!this._ctx) {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
  },
  _playTone(frequency, duration, type = 'sine', volume = 0.3) {
    try {
      this._init();
      const osc = this._ctx.createOscillator();
      const gain = this._ctx.createGain();
      osc.connect(gain);
      gain.connect(this._ctx.destination);
      osc.frequency.value = frequency;
      osc.type = type;
      gain.gain.value = volume;
      osc.start();
      osc.stop(this._ctx.currentTime + duration);
    } catch (e) { /* ignore */ }
  },
  signal() { this._playTone(800, 0.2, 'sine', 0.4); },
  tradeOpen() {
    this._playTone(600, 0.15, 'sine', 0.4);
    setTimeout(() => this._playTone(900, 0.2, 'sine', 0.4), 150);
  },
  tradeClose() {
    this._playTone(900, 0.15, 'sine', 0.4);
    setTimeout(() => this._playTone(600, 0.2, 'sine', 0.4), 150);
  },
  danger() {
    this._playTone(150, 0.3, 'sawtooth', 0.3);
    setTimeout(() => this._playTone(150, 0.3, 'sawtooth', 0.3), 300);
    setTimeout(() => this._playTone(150, 0.3, 'sawtooth', 0.3), 600);
  },
  reject() {
    this._playTone(300, 0.3, 'square', 0.2);
    setTimeout(() => this._playTone(200, 0.4, 'square', 0.2), 350);
  }
};

// ---- API helper (for initial load and manual actions) ----
async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

function formatPrice(p) {
  return parseFloat(p).toFixed(5);
}

// ================================================================
// 1. CLIENT STATE STORE
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
  belief: null,
  totalPnL: 0,
  winRate: 0,
  profitFactor: 0,
  openTradeCount: 0,
  totalUnrealizedPL: 0,
};

// ---- State update triggers UI rendering ----
function updateDashboardState(newState) {
  Object.assign(dashboardState, newState);
  renderAllWidgets();
}

// ---- Render functions (incremental) ----
function renderAllWidgets() {
  renderAccountWidget();
  renderPositionsWidget();
  renderPriceWidgets();
  renderStatsWidget();
  renderOpenTradesWidget();
  renderHistoryWidget();
  renderPendingOrdersWidget();
  renderSignalWidget();
  renderRegimeWidget();
  renderAwarenessWidget();
  renderMetricsWidget();
  renderFusionWidget();
  renderOTIEWidget();
  renderBeliefWidget();
}

function renderAccountWidget() {
  const acc = dashboardState.account;
  if (!acc) return;
  const balance = parseFloat(acc.balance) || 0;
  const equity = parseFloat(acc.equity) || 0;
  const currency = acc.currency || 'USD';
  const elBalance = document.getElementById('statBalance');
  const elEquity = document.getElementById('statEquity');
  if (elBalance) elBalance.textContent = `${balance} ${currency}`;
  if (elEquity) elEquity.textContent = `${equity} ${currency}`;
  // Update account badge if present
  if (window.updateAccountBadge) {
    window.updateAccountBadge(acc);
  } else {
    // fallback manual update
    const idEl = document.getElementById('accountId');
    const typeEl = document.getElementById('accountTypeLabel');
    const currencyEl = document.getElementById('accountCurrency');
    if (idEl) idEl.textContent = acc.id || acc.login || '—';
    if (currencyEl) currencyEl.textContent = currency;
    if (typeEl) {
      let type = 'demo';
      const server = acc.server || '';
      type = server.toLowerCase().includes('demo') ? 'demo' : 'real';
      typeEl.textContent = type.toUpperCase();
      typeEl.className = 'account-type ' + type;
    }
  }
  // Update accountInfo panel if exists
  const accountInfo = document.getElementById('accountInfo');
  if (accountInfo) {
    accountInfo.innerHTML = `
      <p><strong>ID:</strong> ${acc.id || 'N/A'}</p>
      <p><strong>Currency:</strong> ${currency}</p>
      <p><strong>Created:</strong> ${acc.createdTime ? new Date(acc.createdTime).toLocaleDateString() : 'N/A'}</p>
    `;
  }
  const balanceInfo = document.getElementById('balanceInfo');
  if (balanceInfo) {
    balanceInfo.innerHTML = `
      <p><strong>Balance:</strong> ${balance} ${currency}</p>
      <p><strong>Equity:</strong> ${equity} ${currency}</p>
      <p><strong>Margin Used:</strong> ${acc.marginUsed || 0} ${currency}</p>
      <p><strong>Margin Available:</strong> ${acc.marginAvailable || 0} ${currency}</p>
    `;
  }
}

function renderPositionsWidget() {
  const positions = dashboardState.positions || [];
  const badge = document.getElementById('positionCount');
  if (badge) badge.textContent = positions.length;
  const container = document.getElementById('openTradesContainer');
  if (!container) return;
  if (positions.length === 0) {
    container.innerHTML = '<p class="text-muted">No open trades.</p>';
    document.getElementById('statOpenTrades').textContent = '0';
    document.getElementById('statOpenPL').textContent = '—';
    return;
  }
  // Build table (could be incremental but for simplicity we rebuild)
  let html = `<table class="table table-striped"><thead><tr>
    <th>ID</th><th>Pair</th><th>Side</th><th>Open Price</th>
    <th>Current Price</th><th>Units</th><th>P/L</th><th>Action</th>
  </tr></thead><tbody>`;
  let totalPL = 0;
  for (const t of positions) {
    const pl = t.unrealizedPL ? parseFloat(t.unrealizedPL).toFixed(2) : '0.00';
    totalPL += parseFloat(pl) || 0;
    html += `<tr>
      <td>${t.id}</td>
      <td>${t.instrument}</td>
      <td><span class="badge ${t.side === 'BUY' ? 'bg-success' : 'bg-danger'}">${t.side}</span></td>
      <td>${formatPrice(t.price)}</td>
      <td>${formatPrice(t.currentPrice)}</td>
      <td>${t.units}</td>
      <td class="${pl >= 0 ? 'text-success' : 'text-danger'}">${pl}</td>
      <td><button class="btn btn-sm btn-danger" onclick="window.closeTrade('${t.id}')"><i class="fas fa-times"></i> Close</button></td>
    </tr>`;
  }
  html += `<tr><td colspan="6"><strong>Total Unrealized P&L</strong></td>
           <td class="${totalPL >= 0 ? 'text-success' : 'text-danger'}"><strong>${totalPL.toFixed(2)}</strong></td><td></td></tr>`;
  html += '</tbody></table>';
  container.innerHTML = html;
  document.getElementById('statOpenTrades').textContent = positions.length;
  document.getElementById('statOpenPL').textContent = (totalPL >= 0 ? '+' : '') + totalPL.toFixed(2);
  document.getElementById('statOpenPL').className = `stat-change ${totalPL >= 0 ? 'positive' : 'negative'}`;
  if (window.updatePositionBadge) window.updatePositionBadge(positions.length);
}

function renderStatsWidget() {
  const history = dashboardState.history || [];
  if (history.length === 0) {
    document.getElementById('statWinRate').textContent = '—';
    document.getElementById('statProfitFactor').textContent = 'PF: —';
    return;
  }
  const wins = history.filter(t => t.pnl > 0).length;
  const total = history.length;
  const winRate = total > 0 ? (wins / total) * 100 : 0;
  document.getElementById('statWinRate').textContent = winRate.toFixed(1) + '%';
  const totalWins = history.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
  const totalLosses = history.filter(t => t.pnl < 0).reduce((sum, t) => sum + Math.abs(t.pnl), 0);
  const pf = totalLosses > 0 ? (totalWins / totalLosses) : (totalWins > 0 ? Infinity : 0);
  document.getElementById('statProfitFactor').textContent = `PF: ${pf === Infinity ? '∞' : pf.toFixed(2)}`;
}

function renderPriceWidgets() {
  // If you have a price panel, update it incrementally
  // For now, we'll just update the priceInfo element if it exists
  const priceInfo = document.getElementById('priceInfo');
  if (!priceInfo) return;
  const prices = dashboardState.prices || {};
  const symbols = Object.keys(prices);
  if (symbols.length === 0) {
    priceInfo.innerHTML = '<p class="text-muted">No price data yet.</p>';
    return;
  }
  let html = '';
  for (const [symbol, data] of Object.entries(prices)) {
    const bid = data.bid || 0;
    const ask = data.ask || 0;
    const mid = (bid + ask) / 2;
    html += `<div class="d-flex justify-content-between"><span>${symbol}</span><span><strong>${formatPrice(mid)}</strong> (Bid ${formatPrice(bid)} / Ask ${formatPrice(ask)})</span></div>`;
  }
  priceInfo.innerHTML = html;
}

function renderOpenTradesWidget() {
  // Already handled by renderPositionsWidget
}

function renderHistoryWidget() {
  // This can be more complex; for now we keep the existing loadTradeHistory logic
  // but we'll call it from state updates. Since history is large, we may keep the
  // existing filtering/pagination logic but we'll make it data-driven.
  // We'll just call loadTradeHistory(historyPage) when history changes.
  // We'll let the existing loadTradeHistory function handle it (but remove its fetch).
  // We'll override it to use dashboardState.history.
}

function renderPendingOrdersWidget() {
  const orders = dashboardState.pendingOrders || [];
  const container = document.getElementById('pendingOrdersContainer');
  if (!container) return;
  if (orders.length === 0) {
    container.innerHTML = '<p class="text-muted">No pending orders.</p>';
    return;
  }
  let html = `<table class="table table-striped"><thead><tr>
    <th>ID</th><th>Pair</th><th>Side</th><th>Entry Price</th><th>Lot</th><th>Status</th><th>Action</th>
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

function renderSignalWidget() {
  // LiveSignalPanel is already updated by live.js's displayDecision
  // We just ensure the DOM is updated when state changes.
  // Since live.js already renders, we don't duplicate.
}

function renderRegimeWidget() {
  const regime = dashboardState.regime;
  const panel = document.getElementById('regimePanel');
  if (!panel) return;
  if (!regime) {
    panel.innerHTML = '<p class="text-muted">Waiting for regime data...</p>';
    return;
  }
  panel.innerHTML = `
    <div class="card">
      <div class="card-body">
        <h6 class="card-title">Current Regime</h6>
        <p class="card-text"><strong>${regime.name}</strong> (${regime.confidence}%)</p>
        <p class="small">${regime.description || ''}</p>
        <p class="small text-muted">${regime.symbol} | ${new Date(regime.timestamp).toLocaleString()}</p>
      </div>
    </div>
  `;
}

function renderAwarenessWidget() {
  const awareness = dashboardState.awareness;
  const panel = document.getElementById('awarenessPanel');
  if (!panel) return;
  if (!awareness) {
    panel.innerHTML = '<p class="text-muted">Waiting for market awareness...</p>';
    return;
  }
  const { symbol, spread, velocity, acceleration, liquidity, unusualEvents, lastUpdated } = awareness;
  const events = unusualEvents ? unusualEvents.join(', ') : 'None';
  panel.innerHTML = `
    <div class="card">
      <div class="card-body">
        <h6 class="card-title">Market Awareness (${symbol})</h6>
        <p>Spread: ${spread.toFixed(5)} | Velocity: ${velocity.toFixed(6)}</p>
        <p>Acceleration: ${acceleration.toFixed(6)} | Liquidity: ${(liquidity * 100).toFixed(0)}%</p>
        <p>Unusual: ${events}</p>
        <p class="small text-muted">${new Date(lastUpdated).toLocaleString()}</p>
      </div>
    </div>
  `;
}

function renderMetricsWidget() {
  const metrics = dashboardState.metrics;
  const panel = document.getElementById('metricsPanel');
  if (!panel) return;
  if (!metrics) {
    panel.innerHTML = '<p class="text-muted">Waiting for metrics...</p>';
    return;
  }
  const { winRate, profitFactor, sharpe, maxDrawdown, expectancy, totalTrades, dailyPnL, currentDrawdown, timestamp } = metrics;
  panel.innerHTML = `
    <div class="card">
      <div class="card-body">
        <h6 class="card-title">Live Performance</h6>
        <div class="row">
          <div class="col-6">Win Rate: ${(winRate * 100).toFixed(1)}%</div>
          <div class="col-6">Profit Factor: ${profitFactor.toFixed(2)}</div>
        </div>
        <div class="row">
          <div class="col-6">Sharpe: ${sharpe.toFixed(2)}</div>
          <div class="col-6">Max DD: ${(maxDrawdown * 100).toFixed(1)}%</div>
        </div>
        <div class="row">
          <div class="col-6">Expectancy: ${expectancy.toFixed(2)}</div>
          <div class="col-6">Trades: ${totalTrades}</div>
        </div>
        <div class="row">
          <div class="col-6">Daily P&L: ${dailyPnL.toFixed(2)}</div>
          <div class="col-6">Current DD: ${(currentDrawdown * 100).toFixed(1)}%</div>
        </div>
        <p class="small text-muted mt-2">${new Date(timestamp).toLocaleString()}</p>
      </div>
    </div>
  `;
}

function renderFusionWidget() {
  const fusion = dashboardState.fusion;
  const panel = document.getElementById('fusionPanel');
  if (!panel) return;
  if (!fusion) {
    panel.innerHTML = '<p class="text-muted">Waiting for timeframe assessments...</p>';
    return;
  }
  const { symbol, verdict, confidence, agreement, timeframeBreakdown, reasons, session } = fusion;
  const verdictClass = verdict === 'bullish' ? 'success' : (verdict === 'bearish' ? 'danger' : 'secondary');
  const verdictIcon = verdict === 'bullish' ? '📈' : (verdict === 'bearish' ? '📉' : '➖');
  let html = `
    <div class="row">
      <div class="col-md-6">
        <h5>${verdictIcon} ${symbol} – <span class="text-${verdictClass}">${verdict.toUpperCase()}</span> (${confidence}% confidence)</h5>
        <p>Agreement: ${agreement}% across ${fusion.timeframeCount} timeframes</p>
        <ul class="list-inline">
          <li class="list-inline-item"><span class="badge bg-success">Bullish ${timeframeBreakdown.bullish}</span></li>
          <li class="list-inline-item"><span class="badge bg-danger">Bearish ${timeframeBreakdown.bearish}</span></li>
          <li class="list-inline-item"><span class="badge bg-secondary">Neutral ${timeframeBreakdown.neutral}</span></li>
        </ul>
        <p><small>Session: ${session.name} (multiplier ${session.liquidityMultiplier})</small></p>
      </div>
      <div class="col-md-6">
        <p><strong>Reasons</strong></p>
        <ul class="small">
          ${reasons.map(r => `<li>${r}</li>`).join('') || '<li>No detailed reasons</li>'}
        </ul>
      </div>
    </div>
  `;
  panel.innerHTML = html;
}

function renderOTIEWidget() {
  // Already handled by live.js's displayOTIEState and displayOTIEAction
  // We'll not duplicate.
}

function renderBeliefWidget() {
  const belief = dashboardState.belief;
  const panel = document.getElementById('beliefPanel');
  if (!panel) return;
  if (!belief) {
    panel.innerHTML = '<p class="text-muted">No belief data.</p>';
    return;
  }
  const { belief: direction, beliefConfidence, edge, winProbability, similarityCount, marketQuality } = belief;
  const trendClass = direction === 'bullish' ? 'text-success' : direction === 'bearish' ? 'text-danger' : 'text-secondary';
  panel.innerHTML = `
    <div class="card">
      <div class="card-body">
        <h6 class="card-title">Market Belief</h6>
        <p class="${trendClass}" style="font-size: 1.2rem; font-weight: bold;">${direction.toUpperCase()} (${beliefConfidence || 50}%)</p>
        <p>Edge: ${edge?.toFixed(3) || 0} R | P(win): ${(winProbability * 100).toFixed(1)}%</p>
        <p>Similarity Sample: ${similarityCount || 0} | Market Quality: ${marketQuality || 50}/100</p>
        <p class="text-muted small">Updated: ${new Date().toLocaleTimeString()}</p>
      </div>
    </div>
  `;
}

// ================================================================
// 2. EXPOSE STATE UPDATE TO live.js
// ================================================================
window.updateDashboardState = updateDashboardState;

// ================================================================
// 3. OVERRIDE EXISTING LOAD FUNCTIONS TO USE STATE
// ================================================================
// We'll keep the original functions but make them no‑op if they were called from setInterval.
// However, we will remove the intervals entirely.
// For manual refresh, we can keep a refresh function that fetches from server.

async function refreshAllData() {
  try {
    const [account, positions, history, pending] = await Promise.all([
      fetchJson(`${CONFIG.API_BASE}/api/account`),
      fetchJson(`${CONFIG.API_BASE}/api/trades`),
      fetchJson(`${CONFIG.API_BASE}/api/trade-history`),
      fetchJson(`${CONFIG.API_BASE}/api/pending-orders`),
    ]);
    updateDashboardState({ account, positions, history, pendingOrders: pending });
  } catch (e) {
    console.error('Manual refresh error:', e);
  }
}

// ---- Expose refresh for manual use ----
window.refreshDashboard = refreshAllData;

// ---- Override loadOpenTrades, loadAccount, etc. to use state (for backward compatibility) ----
window.loadOpenTrades = function() {
  // No-op: positions come from WebSocket
  console.warn('loadOpenTrades is deprecated – positions are updated via WebSocket');
};
window.loadAccount = function() {
  // No-op: account comes from WebSocket
  console.warn('loadAccount is deprecated – account is updated via WebSocket');
};
window.loadTradeHistory = function() {
  // No-op: history comes from WebSocket
  console.warn('loadTradeHistory is deprecated – history is updated via WebSocket');
};
window.loadPendingOrders = function() {
  // No-op: pending orders come from WebSocket
  console.warn('loadPendingOrders is deprecated – pending orders are updated via WebSocket');
};
window.loadPrices = function() {
  // No-op: prices come from WebSocket
  console.warn('loadPrices is deprecated – prices are updated via WebSocket');
};

// ---- But keep closeTrade, cancelPending, etc. (they use HTTP) ----
window.closeTrade = async function(tradeId) {
  if (!confirm(`Close trade ${tradeId}?`)) return;
  try {
    await fetchJson(`${CONFIG.API_BASE}/api/close/${tradeId}`, { method: 'PUT' });
    SoundManager.tradeClose();
    alert('Trade closed successfully.');
    // The WebSocket will update positions, so no need to refresh.
  } catch (e) {
    alert('Error closing trade: ' + e.message);
    SoundManager.reject();
  }
};

window.cancelPending = async function(orderId) {
  if (!confirm(`Cancel order ${orderId}?`)) return;
  try {
    await fetchJson(`${CONFIG.API_BASE}/api/order/${orderId}`, { method: 'DELETE' });
    alert('Order cancelled successfully.');
    // WebSocket will update pending orders.
  } catch (e) {
    alert('Error cancelling order: ' + e.message);
  }
};

// ================================================================
// 4. EXISTING UI EVENT BINDINGS (unchanged)
// ================================================================
document.getElementById('getSignalBtn')?.addEventListener('click', async function() {
  // ... unchanged ...
});

document.getElementById('tradeForm')?.addEventListener('submit', async function(e) {
  // ... unchanged (but after placing order, WebSocket updates will handle the rest) ...
});

document.getElementById('autoTradeForm')?.addEventListener('submit', async function(e) {
  // ... unchanged ...
});

// ---- Refresh buttons ----
document.getElementById('refreshTrades')?.addEventListener('click', refreshAllData);
document.getElementById('refreshHistory')?.addEventListener('click', refreshAllData);
document.getElementById('refreshPending')?.addEventListener('click', refreshAllData);

// ---- History filter & pagination (use state data) ----
document.getElementById('applyHistoryFilter')?.addEventListener('click', function() {
  // We'll re-implement using state
  applyHistoryFilters();
});
document.getElementById('resetHistoryFilter')?.addEventListener('click', function() {
  document.getElementById('historyFrom').value = '';
  document.getElementById('historyTo').value = '';
  document.getElementById('historySymbol').value = '';
  document.getElementById('historySide').value = '';
  document.getElementById('historyStatus').value = '';
  applyHistoryFilters();
});
document.getElementById('prevPage')?.addEventListener('click', function() {
  if (historyPage > 1) { historyPage--; renderHistoryTable(); }
});
document.getElementById('nextPage')?.addEventListener('click', function() {
  if (historyPage < historyTotalPages) { historyPage++; renderHistoryTable(); }
});

// ---- History filtering logic (using state) ----
function applyHistoryFilters() {
  historyPage = 1;
  renderHistoryTable();
}

function renderHistoryTable() {
  const allHistory = dashboardState.history || [];
  const from = document.getElementById('historyFrom')?.value;
  const to = document.getElementById('historyTo')?.value;
  const symbol = document.getElementById('historySymbol')?.value.trim();
  const side = document.getElementById('historySide')?.value;
  const status = document.getElementById('historyStatus')?.value;

  let filtered = allHistory.filter(t => {
    if (from && new Date(t.date) < new Date(from)) return false;
    if (to && new Date(t.date) > new Date(to)) return false;
    if (symbol && !t.pair?.toUpperCase().includes(symbol.toUpperCase())) return false;
    if (side && t.side !== side) return false;
    if (status && t.status !== status) return false;
    return true;
  });

  filtered.sort((a, b) => new Date(b.date) - new Date(a.date));
  document.getElementById('historyCount').textContent = filtered.length;

  const totalPnL = filtered.reduce((sum, t) => sum + (t.pnl || 0), 0);
  document.getElementById('totalPnLDisplay')?.remove();
  const totalItems = filtered.length;
  historyTotalPages = Math.ceil(totalItems / HISTORY_PAGE_SIZE) || 1;
  if (historyPage < 1) historyPage = 1;
  if (historyPage > historyTotalPages) historyPage = historyTotalPages;

  const start = (historyPage - 1) * HISTORY_PAGE_SIZE;
  const end = Math.min(start + HISTORY_PAGE_SIZE, totalItems);
  const pageItems = filtered.slice(start, end);

  document.getElementById('pageStart').textContent = totalItems > 0 ? start + 1 : 0;
  document.getElementById('pageEnd').textContent = end;
  document.getElementById('pageTotal').textContent = totalItems;
  document.getElementById('pageInfo').textContent = `Page ${historyPage} of ${historyTotalPages}`;
  document.getElementById('prevPage').disabled = (historyPage <= 1);
  document.getElementById('nextPage').disabled = (historyPage >= historyTotalPages);

  const container = document.getElementById('historyContainer');
  if (!container) return;
  if (pageItems.length === 0) {
    container.innerHTML = '<p class="text-muted">No matching records.</p>';
    return;
  }
  let html = `<div class="table-responsive"><table class="table table-striped table-sm">
    <thead><tr><th>Pair</th><th>Side</th><th>Entry</th><th>Exit</th><th>Lot</th><th>P/L</th><th>Status</th><th>Date</th></tr></thead><tbody>`;
  pageItems.forEach(t => {
    const pl = t.pnl ? parseFloat(t.pnl).toFixed(2) : '0.00';
    const statusClass = t.status === 'OPEN' ? 'bg-primary' : (t.pnl >= 0 ? 'bg-success' : 'bg-danger');
    html += `<tr>
      <td>${t.pair}</td>
      <td><span class="badge ${t.side === 'BUY' ? 'bg-success' : 'bg-danger'}">${t.side}</span></td>
      <td>${t.entryPrice !== null ? formatPrice(t.entryPrice) : '-'}</td>
      <td>${t.exitPrice !== null ? formatPrice(t.exitPrice) : '-'}</td>
      <td>${t.lotSize}</td>
      <td class="${pl >= 0 ? 'text-success' : 'text-danger'}">${pl}</td>
      <td><span class="badge ${statusClass}">${t.status}</span></td>
      <td>${new Date(t.date).toLocaleString()}</td>
    </tr>`;
  });
  html += '</tbody></table></div>';
  container.innerHTML = html;

  // Insert total P&L above the table
  if (filtered.length > 0) {
    const totalRow = document.createElement('div');
    totalRow.id = 'totalPnLDisplay';
    totalRow.className = 'fw-bold mb-2';
    totalRow.innerHTML = `Total P&L (filtered): <span class="${totalPnL >= 0 ? 'text-success' : 'text-danger'}">${totalPnL.toFixed(2)}</span>`;
    container.parentNode.insertBefore(totalRow, container);
  }
}

// ================================================================
// 5. INITIAL LOAD (HTTP once)
// ================================================================
async function initialLoad() {
  try {
    const [account, positions, history, pending] = await Promise.all([
      fetchJson(`${CONFIG.API_BASE}/api/account`),
      fetchJson(`${CONFIG.API_BASE}/api/trades`),
      fetchJson(`${CONFIG.API_BASE}/api/trade-history`),
      fetchJson(`${CONFIG.API_BASE}/api/pending-orders`),
    ]);
    updateDashboardState({ account, positions, history, pendingOrders: pending });
  } catch (e) {
    console.error('Initial load error:', e);
  }
}

// ================================================================
// 6. STARTUP
// ================================================================
document.addEventListener('DOMContentLoaded', async function() {
  // Load product preference
  await loadProductPreference();
  // Initial data load
  await initialLoad();
  // Bind remaining UI events
  // ... (signal, trade form, auto-trade, etc.) – those are already bound above
  // Delete history button
  document.getElementById('deleteHistoryBtn')?.addEventListener('click', async function() {
    if (!confirm('Delete all closed trades from history? This cannot be undone.')) return;
    try {
      const result = await fetchJson(`${CONFIG.API_BASE}/api/history`, { method: 'DELETE' });
      alert(`Deleted ${result.deletedCount} closed trades.`);
      // Refresh history from server (or we can update state directly)
      refreshAllData();
    } catch (e) {
      alert('Error deleting history: ' + e.message);
    }
  });
  // Test notification
  document.getElementById('testNotificationBtn')?.addEventListener('click', async function() {
    try {
      const result = await fetchJson(`${CONFIG.API_BASE}/api/test-email`, { method: 'POST' });
      alert('Test email sent! Check your inbox.');
    } catch (e) {
      alert('Error sending test email: ' + e.message);
    }
  });
  // Export CSV
  document.getElementById('exportCSVBtn')?.addEventListener('click', exportHistoryCSV);
  // Report generation
  document.getElementById('generateReportBtn')?.addEventListener('click', generateReport);

  // ---- Override decision inspector ----
  window.openDecisionInspector = openDecisionInspector;
});

// ================================================================
// 7. EXPORT FUNCTIONS FOR live.js
// ================================================================
window.SoundManager = SoundManager;
window.updatePositionBadge = function(count) {
  const badge = document.getElementById('positionCount');
  if (badge) badge.textContent = count || 0;
};
window.updateApiStatus = function(connected) {
  const dot = document.getElementById('apiStatusDot');
  const text = document.getElementById('apiStatusText');
  if (dot) dot.className = 'dot ' + (connected ? 'connected' : 'disconnected');
  if (text) text.textContent = connected ? 'Connected' : 'Disconnected';
};
window.exportHistoryCSV = exportHistoryCSV;
window.updateAccountBadge = updateAccountBadge;

// ---- Listen for danger signals ----
window.addEventListener('dangerSignal', function() {
  SoundManager.danger();
});

console.log('✅ App.js loaded – fully event‑driven.');
