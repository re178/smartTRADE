// public/js/app.js – Dashboard Logic (Fully Event-Driven)
// All updates come from WebSocket (live.js). HTTP is only for manual actions.
// Updated for Multiplier trading: stake, multiplier, duration, knockout.

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

// ---- API helper (for manual actions) ----
async function fetchJson(url, options = {}) {
  const fullUrl = (CONFIG.API_BASE || '') + url;
  const res = await fetch(fullUrl, {
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
// 1. CLIENT STATE STORE (extended)
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
  // ---- NEW fields ----
  prediction: null,
  opportunity: null,
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
  renderPredictionWidget();    // NEW
  renderOpportunityWidget();   // NEW
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
  // Update account badge
  if (window.updateAccountBadge) {
    window.updateAccountBadge(acc);
  } else {
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
  renderHistoryTable();
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
  // Handled by live.js directly
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
  // Handled by live.js directly
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

// ============================================================
//  NEW: Prediction Widget
// ============================================================
function renderPredictionWidget() {
  const prediction = dashboardState.prediction;
  const panel = document.getElementById('predictionPanel');
  if (!panel) return;
  if (!prediction) {
    panel.innerHTML = '<p class="text-muted">Waiting for prediction data...</p>';
    return;
  }

  const { probabilities, expectedMove, expectedAdverse, expectedFavorable, mfe, mae, sampleSize, calibratedConfidence, marketQuality } = prediction;
  const upPct = (probabilities?.up || 0) * 100;
  const downPct = (probabilities?.down || 0) * 100;
  const neutralPct = (probabilities?.neutral || 0) * 100;

  panel.innerHTML = `
    <div class="row">
      <div class="col-md-8">
        <div class="prediction-bar">
          <div class="prob-block prob-up">
            <div class="value">${upPct.toFixed(0)}%</div>
            <div class="label">UP</div>
          </div>
          <div class="prob-block prob-down">
            <div class="value">${downPct.toFixed(0)}%</div>
            <div class="label">DOWN</div>
          </div>
          <div class="prob-block prob-neutral">
            <div class="value">${neutralPct.toFixed(0)}%</div>
            <div class="label">NEUTRAL</div>
          </div>
          <div style="margin-left:auto; text-align:right;">
            <div><small>Calibrated Confidence: <strong>${calibratedConfidence || 0}%</strong></small></div>
            <div><small>Sample: <strong>${sampleSize || 0}</strong> analogues</small></div>
          </div>
        </div>
        <div class="mt-2">
          <small>Expected Move: <strong>${(expectedMove * 10000).toFixed(1)} pips</strong> | Favorable: <strong>${(expectedFavorable * 10000).toFixed(1)} pips</strong> | Adverse: <strong>${(expectedAdverse * 10000).toFixed(1)} pips</strong></small>
        </div>
        <div class="mt-1">
          <small>MFE: <strong>${(mfe * 10000).toFixed(1)} pips</strong> | MAE: <strong>${(mae * 10000).toFixed(1)} pips</strong> | Market Quality: <strong>${marketQuality || 50}/100</strong></small>
        </div>
      </div>
      <div class="col-md-4">
        <div style="background:#f1f5f9; border-radius:8px; padding:8px 12px;">
          <small><strong>Time to Max Favorable:</strong> ${prediction.timeToMaxFavorable !== null ? prediction.timeToMaxFavorable + ' candles' : '—'}</small><br>
          <small><strong>Time to Max Adverse:</strong> ${prediction.timeToMaxAdverse !== null ? prediction.timeToMaxAdverse + ' candles' : '—'}</small><br>
          <small><strong>Similarity:</strong> ${prediction.averageSimilarity !== undefined ? prediction.averageSimilarity.toFixed(3) : '—'}</small>
        </div>
      </div>
    </div>
  `;
}

// ============================================================
//  NEW: Opportunity Widget
// ============================================================
function renderOpportunityWidget() {
  const opp = dashboardState.opportunity;
  const panel = document.getElementById('opportunityPanel');
  if (!panel) return;
  if (!opp) {
    panel.innerHTML = '<p class="text-muted">Waiting for opportunity data...</p>';
    return;
  }

  const { tradable, reason, direction, stake, multiplier, duration, entryPrice, knockoutLevel, takeProfitLevel, tradeEconomics, riskMetrics } = opp;

  if (!tradable) {
    panel.innerHTML = `
      <div class="opportunity-card no-trade">
        <div class="d-flex justify-content-between align-items-center">
          <div>
            <h6 class="mb-1"><i class="fas fa-times-circle text-danger"></i> NO TRADE</h6>
            <p class="mb-0 small">${reason || 'Trade does not meet criteria'}</p>
            <p class="mb-0 small text-muted">${opp.message || ''}</p>
          </div>
          <span class="badge bg-danger">Rejected</span>
        </div>
      </div>
    `;
    return;
  }

  const probTP = (tradeEconomics?.probTP || 0) * 100;
  const probSL = (tradeEconomics?.probSL || 0) * 100;
  const probOther = (tradeEconomics?.probOther || 0) * 100;
  const ev = tradeEconomics?.ev || 0;
  const evOverStake = tradeEconomics?.evOverStake || 0;

  panel.innerHTML = `
    <div class="opportunity-card trade">
      <div class="row">
        <div class="col-md-6">
          <h6 class="mb-1"><i class="fas fa-check-circle text-success"></i> TRADE OPPORTUNITY</h6>
          <p class="mb-1"><strong>${direction}</strong> ${opp.prediction?.symbol || ''} | Stake: $${stake.toFixed(2)} | Multiplier: ${multiplier}x | Duration: ${duration}s</p>
          <p class="mb-1 small">Entry: ${formatPrice(entryPrice)} | Knockout: ${formatPrice(knockoutLevel)} | TP: ${formatPrice(takeProfitLevel)}</p>
          <p class="mb-0 small">${reason || 'Approved'}</p>
        </div>
        <div class="col-md-6">
          <div class="row small">
            <div class="col-6"><strong>P(TP):</strong> ${probTP.toFixed(0)}%</div>
            <div class="col-6"><strong>P(SL):</strong> ${probSL.toFixed(0)}%</div>
            <div class="col-6"><strong>P(Other):</strong> ${probOther.toFixed(0)}%</div>
            <div class="col-6"><strong>EV:</strong> $${ev.toFixed(2)}</div>
            <div class="col-6"><strong>EV / Stake:</strong> ${(evOverStake * 100).toFixed(1)}%</div>
            <div class="col-6"><strong>Max Loss:</strong> $${riskMetrics?.maxLoss || stake}</div>
            <div class="col-6"><strong>Target Profit:</strong> $${riskMetrics?.targetProfit || 0}</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ================================================================
// 2. EXPOSE STATE UPDATE TO live.js
// ================================================================
window.updateDashboardState = updateDashboardState;

// ================================================================
// 3. MANUAL REFRESH (HTTP)
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
  } catch (e) {
    console.error('Manual refresh error:', e);
  }
}
window.refreshDashboard = refreshAllData;

// ---- Override old load functions to use state ----
window.loadOpenTrades = function() {
  console.warn('loadOpenTrades is deprecated – positions are updated via WebSocket');
};
window.loadAccount = function() {
  console.warn('loadAccount is deprecated – account is updated via WebSocket');
};
window.loadTradeHistory = function() {
  console.warn('loadTradeHistory is deprecated – history is updated via WebSocket');
};
window.loadPendingOrders = function() {
  console.warn('loadPendingOrders is deprecated – pending orders are updated via WebSocket');
};
window.loadPrices = function() {
  console.warn('loadPrices is deprecated – prices are updated via WebSocket');
};

// ---- Close trade and cancel order (HTTP) ----
window.closeTrade = async function(tradeId) {
  if (!confirm(`Close trade ${tradeId}?`)) return;
  try {
    await fetchJson(`/api/close/${tradeId}`, { method: 'PUT' });
    SoundManager.tradeClose();
    alert('Trade closed successfully.');
  } catch (e) {
    alert('Error closing trade: ' + e.message);
    SoundManager.reject();
  }
};

window.cancelPending = async function(orderId) {
  if (!confirm(`Cancel order ${orderId}?`)) return;
  try {
    await fetchJson(`/api/order/${orderId}`, { method: 'DELETE' });
    alert('Order cancelled successfully.');
  } catch (e) {
    alert('Error cancelling order: ' + e.message);
  }
};

// ================================================================
// 4. HISTORY TABLE RENDERING (uses dashboardState.history)
// ================================================================
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

  if (filtered.length > 0) {
    const totalRow = document.createElement('div');
    totalRow.id = 'totalPnLDisplay';
    totalRow.className = 'fw-bold mb-2';
    totalRow.innerHTML = `Total P&L (filtered): <span class="${totalPnL >= 0 ? 'text-success' : 'text-danger'}">${totalPnL.toFixed(2)}</span>`;
    container.parentNode.insertBefore(totalRow, container);
  }
}

// ================================================================
// 5. UI EVENT BINDINGS (updated for Multiplier fields)
// ================================================================
document.addEventListener('DOMContentLoaded', async function() {
  // Safe loadProductPreference
  try {
    if (typeof loadProductPreference === 'function') {
      await loadProductPreference();
    } else {
      console.warn('[App] loadProductPreference not defined, skipping.');
    }
  } catch (e) {
    console.warn('[App] Error loading product preference:', e);
  }

  // Initial data load via HTTP (optional – WebSocket will also send init)
  await refreshAllData();

  // ---- Signal Generator ----
  document.getElementById('getSignalBtn')?.addEventListener('click', async function() {
    const pair = document.getElementById('signalPair').value.trim();
    const strategy = document.getElementById('signalStrategy').value;
    if (!pair) { alert('Please enter a pair.'); return; }
    try {
      const result = await fetchJson(`/api/signal?symbol=${encodeURIComponent(pair)}&strategy=${encodeURIComponent(strategy)}`);
      const container = document.getElementById('signalResult');
      if (result.signal) {
        container.innerHTML = `
          <div class="alert alert-${result.signal === 'BUY' ? 'success' : result.signal === 'SELL' ? 'danger' : 'secondary'}">
            <strong>${result.signal}</strong> (${result.confidence || 0}%)<br>
            <small>${result.reason || ''}</small>
          </div>
        `;
      } else {
        container.innerHTML = `<div class="alert alert-info">${result.message || 'No signal available.'}</div>`;
      }
    } catch (e) {
      alert('Error fetching signal: ' + e.message);
    }
  });

  // ---- Trade Form (Multiplier) ----
  document.getElementById('tradeForm')?.addEventListener('submit', async function(e) {
    e.preventDefault();
    if (isSubmitting) return;
    isSubmitting = true;
    const pair = document.getElementById('tradePair').value.trim();
    const side = document.getElementById('tradeSide').value;
    const stake = parseFloat(document.getElementById('tradeStake').value);
    const multiplier = parseFloat(document.getElementById('tradeMultiplier').value);
    const duration = parseInt(document.getElementById('tradeDuration').value);
    const knockout = parseFloat(document.getElementById('tradeKnockout').value) || null;
    const tp = parseFloat(document.getElementById('tradeTP').value) || null;

    if (!pair || !stake || stake <= 0 || !multiplier || multiplier < 1 || !duration || duration < 10) {
      alert('Please fill in all required fields correctly.');
      isSubmitting = false;
      return;
    }

    try {
      // Use the new endpoint `/api/multiplier-trade` or adapt existing `/api/trade`
      // For now, we'll use the existing `/api/trade` but with new fields.
      // The backend controllers need to be updated to accept these fields.
      // We'll send them as part of the request body.
      const response = await fetchJson('/api/trade', {
        method: 'POST',
        body: JSON.stringify({
          pair,
          side,
          stake,
          multiplier,
          duration,
          knockoutLevel: knockout,
          takeProfitLevel: tp,
          product: document.getElementById('currentProduct')?.textContent || 'deriv_cfd',
        })
      });
      alert('Multiplier trade placed successfully!');
      SoundManager.tradeOpen();
      // WebSocket will update positions automatically.
    } catch (e) {
      alert('Error placing trade: ' + e.message);
      SoundManager.reject();
    }
    isSubmitting = false;
  });

  // ---- Auto-Trade Form ----
  document.getElementById('autoTradeForm')?.addEventListener('submit', async function(e) {
    e.preventDefault();
    if (isAutoSubmitting) return;
    isAutoSubmitting = true;
    const pair = document.getElementById('autoPair').value.trim();
    const risk = parseFloat(document.getElementById('autoRisk').value);
    const strategy = document.getElementById('autoStrategy').value;
    if (!pair || !risk || risk <= 0) { alert('Please fill in all fields.'); isAutoSubmitting = false; return; }
    try {
      const response = await fetchJson('/api/auto-trade', {
        method: 'POST',
        body: JSON.stringify({ pair, riskPercent: risk, strategy })
      });
      alert('Auto-trade placed successfully!');
      SoundManager.tradeOpen();
    } catch (e) {
      alert('Error auto-trading: ' + e.message);
      SoundManager.reject();
    }
    isAutoSubmitting = false;
  });

  // ---- History filter ----
  document.getElementById('applyHistoryFilter')?.addEventListener('click', applyHistoryFilters);
  document.getElementById('resetHistoryFilter')?.addEventListener('click', function() {
    document.getElementById('historyFrom').value = '';
    document.getElementById('historyTo').value = '';
    document.getElementById('historySymbol').value = '';
    document.getElementById('historySide').value = '';
    document.getElementById('historyStatus').value = '';
    applyHistoryFilters();
  });

  // ---- Pagination ----
  document.getElementById('prevPage')?.addEventListener('click', function() {
    if (historyPage > 1) { historyPage--; renderHistoryTable(); }
  });
  document.getElementById('nextPage')?.addEventListener('click', function() {
    if (historyPage < historyTotalPages) { historyPage++; renderHistoryTable(); }
  });

  // ---- Refresh buttons ----
  document.getElementById('refreshTrades')?.addEventListener('click', refreshAllData);
  document.getElementById('refreshHistory')?.addEventListener('click', refreshAllData);
  document.getElementById('refreshPending')?.addEventListener('click', refreshAllData);

  // ---- Delete history ----
  document.getElementById('deleteHistoryBtn')?.addEventListener('click', async function() {
    if (!confirm('Delete all closed trades from history? This cannot be undone.')) return;
    try {
      const result = await fetchJson('/api/history', { method: 'DELETE' });
      alert(`Deleted ${result.deletedCount} closed trades.`);
      refreshAllData();
    } catch (e) {
      alert('Error deleting history: ' + e.message);
    }
  });

  // ---- Test notification ----
  document.getElementById('testNotificationBtn')?.addEventListener('click', async function() {
    try {
      await fetchJson('/api/test-email', { method: 'POST' });
      alert('Test email sent! Check your inbox.');
    } catch (e) {
      alert('Error sending test email: ' + e.message);
    }
  });

  // ---- Export CSV ----
  document.getElementById('exportCSVBtn')?.addEventListener('click', function() {
    if (typeof window.exportHistoryCSV === 'function') {
      window.exportHistoryCSV();
    } else {
      alert('CSV export function not available.');
    }
  });

  // ---- Report generation ----
  document.getElementById('generateReportBtn')?.addEventListener('click', function() {
    if (typeof window.generateReport === 'function') {
      window.generateReport();
      const modal = bootstrap.Modal.getInstance(document.getElementById('reportModal'));
      if (modal) modal.hide();
    } else {
      alert('Report generation function not loaded.');
    }
  });
});

// ================================================================
// 6. EXPOSE FUNCTIONS FOR live.js
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
window.updateAccountBadge = function(account) {
  if (typeof window._updateAccountBadge === 'function') {
    window._updateAccountBadge(account);
  } else {
    const idEl = document.getElementById('accountId');
    const typeEl = document.getElementById('accountTypeLabel');
    const currencyEl = document.getElementById('accountCurrency');
    if (account) {
      if (idEl) idEl.textContent = account.id || account.login || '—';
      if (currencyEl) currencyEl.textContent = account.currency || 'USD';
      if (typeEl) {
        let type = 'demo';
        const server = account.server || '';
        type = server.toLowerCase().includes('demo') ? 'demo' : 'real';
        typeEl.textContent = type.toUpperCase();
        typeEl.className = 'account-type ' + type;
      }
    }
  }
};
window.exportHistoryCSV = function() {
  const history = dashboardState.history || [];
  if (history.length === 0) { alert('No history to export.'); return; }
  let csv = 'Pair,Side,Entry Price,Exit Price,Lot,P/L,Status,Date\n';
  history.forEach(t => {
    csv += `${t.pair},${t.side},${t.entryPrice},${t.exitPrice},${t.lotSize},${t.pnl},${t.status},${new Date(t.date).toISOString()}\n`;
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `trade_history_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};
window.generateReport = function() {
  alert('Report generation is not fully implemented yet.');
};
window.openDecisionInspector = function(decisionId) {
  alert('Decision inspector will be implemented in a future update.');
};

console.log('✅ App.js loaded – fully event‑driven with Multiplier support.');
