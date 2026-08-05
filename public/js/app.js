// public/js/app.js – Dashboard Logic (Full with Stats Update, P&L Fix, Sounds, Report)
// Added: Account badge update (Real/Demo) and improved loadAccount.

// ---- Configuration ----
const REFRESH_INTERVAL = 3000; // 3 seconds – real‑time P&L updates
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

// ---- API helper ----
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

// ---- Account Badge Update (New) ----
function updateAccountBadge(account) {
  if (!account) return;
  const idEl = document.getElementById('accountId');
  const typeEl = document.getElementById('accountTypeLabel');
  const currencyEl = document.getElementById('accountCurrency');

  if (idEl) idEl.textContent = account.id || account.login || '—';
  if (currencyEl) currencyEl.textContent = account.currency || 'USD';

  if (typeEl) {
    let type = 'demo'; // default
    // Determine real/demo based on tradeMode and server string
    const tradeMode = account.tradeMode;
    const server = account.server || '';
    if (tradeMode === 0) {
      // Often tradeMode 0 = real, but it's broker-specific
      // If server contains 'Demo', it's demo
      if (server.toLowerCase().includes('demo')) {
        type = 'demo';
      } else {
        type = 'real';
      }
    } else if (tradeMode === 1) {
      type = 'demo';
    } else {
      // fallback: check server string
      type = server.toLowerCase().includes('demo') ? 'demo' : 'real';
    }
    typeEl.textContent = type.toUpperCase();
    typeEl.className = 'account-type ' + type;
  }
}

// ---- Load Product Preference ----
async function loadProductPreference() {
  try {
    const data = await fetchJson(`${CONFIG.API_BASE}/api/user/preferences`);
    const product = data.tradingProduct || 'deriv_cfd';
    document.querySelectorAll('input[name="product"]').forEach(el => {
      el.checked = (el.value === product);
    });
    document.getElementById('currentProduct').textContent = product.toUpperCase();
  } catch (e) {
    console.error('Failed to load product preference:', e);
  }
}

window.handleProductChange = async function(e) {
  const value = e.target.value;
  document.querySelectorAll('input[name="product"]').forEach(el => {
    el.checked = (el.value === value);
  });
  document.getElementById('currentProduct').textContent = value.toUpperCase();
  try {
    await fetchJson(`${CONFIG.API_BASE}/api/user/preferences`, {
      method: 'POST',
      body: JSON.stringify({ tradingProduct: value })
    });
    console.log('Product preference updated to:', value);
    loadAccount();
    loadOpenTrades();
    loadPendingOrders();
  } catch (e) {
    alert('Failed to update product preference: ' + e.message);
    loadProductPreference();
  }
};

// ---- Load Account (updates Balance & Equity stats + account badge) ----
async function loadAccount() {
  try {
    const acc = await fetchJson(`${CONFIG.API_BASE}/api/account`);
    const balance = typeof acc.balance === 'number' ? acc.balance : parseFloat(acc.balance) || 0;
    const equity = typeof acc.equity === 'number' ? acc.equity : parseFloat(acc.equity) || 0;
    const currency = acc.currency || 'USD';
    document.getElementById('statBalance').textContent = `${balance} ${currency}`;
    document.getElementById('statEquity').textContent = `${equity} ${currency}`;
    const created = acc.createdTime || acc.createdAt || acc.updatedAt || null;
    const accountInfo = document.getElementById('accountInfo');
    if (accountInfo) {
      accountInfo.innerHTML = `
        <p><strong>ID:</strong> ${acc.id || 'N/A'}</p>
        <p><strong>Currency:</strong> ${currency}</p>
        <p><strong>Created:</strong> ${created ? new Date(created).toLocaleDateString() : 'N/A'}</p>
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
    // ---- Update account badge ----
    updateAccountBadge(acc);
  } catch (e) {
    console.error('loadAccount error:', e);
    document.getElementById('statBalance').textContent = '—';
    document.getElementById('statEquity').textContent = '—';
  }
}

// ---- Load Prices ----
async function loadPrices() {
  const pairs = CONFIG.PRICE_PAIRS;
  try {
    const data = await fetchJson(`${CONFIG.API_BASE}/api/prices?instruments=${pairs.join(',')}`);
    let html = '';
    data.forEach(p => {
      const bid = parseFloat(p.bids[0].price);
      const ask = parseFloat(p.asks[0].price);
      const mid = (bid + ask) / 2;
      html += `<div class="d-flex justify-content-between"><span>${p.instrument}</span><span><strong>${formatPrice(mid)}</strong> (Bid ${formatPrice(bid)} / Ask ${formatPrice(ask)})</span></div>`;
    });
    document.getElementById('priceInfo').innerHTML = html;
  } catch (e) {
    document.getElementById('priceInfo').innerHTML = `<p class="text-danger">Error: ${e.message}</p>`;
  }
}

// ---- Load Notification Status ----
async function loadNotificationStatus() {
  try {
    const status = await fetchJson(`${CONFIG.API_BASE}/api/notifications/status`);
    document.getElementById('emailStatus').textContent = status.emailEnabled ? 'Enabled' : 'Disabled';
    document.getElementById('emailStatus').className = `badge bg-${status.emailEnabled ? 'success' : 'danger'}`;
    document.getElementById('instagramStatus').textContent = status.instagramEnabled ? 'Enabled' : 'Disabled';
    document.getElementById('instagramStatus').className = `badge bg-${status.instagramEnabled ? 'success' : 'danger'}`;
    document.getElementById('emailAddress').textContent = status.email || 'Not set';
  } catch (e) {
    document.getElementById('emailStatus').textContent = 'Error';
    document.getElementById('instagramStatus').textContent = 'Error';
  }
}

// ---- Signal Generation ----
document.getElementById('getSignalBtn').addEventListener('click', async function() {
  const pair = document.getElementById('signalPair').value.trim();
  const strategy = document.getElementById('signalStrategy')?.value || 'sma';
  if (!pair) return;
  const resultDiv = document.getElementById('signalResult');
  resultDiv.innerHTML = '<p class="text-muted">Fetching signal...</p>';
  try {
    const signal = await fetchJson(`${CONFIG.API_BASE}/api/signal?pair=${pair}&strategy=${strategy}`);
    if (!signal || !signal.side) {
      resultDiv.innerHTML = `<p class="text-warning">No signal for ${pair} at this time.</p>`;
      return;
    }
    let details = `<div class="alert alert-${signal.side === 'BUY' ? 'success' : 'danger'}">
      <h5><strong>${signal.side}</strong> ${signal.pair}</h5>
      <p>Entry: ${formatPrice(signal.entryPrice)} | SL: ${formatPrice(signal.stopLoss)} | TP: ${formatPrice(signal.takeProfit)}</p>
      <p>Confidence: ${signal.confidence || 75}%</p>`;
    if (signal.strategy) details += `<p>Strategy: ${signal.strategy}</p>`;
    if (signal.reason) details += `<p>Reason: ${signal.reason}</p>`;
    if (signal.riskRating) details += `<p>Risk: ${signal.riskRating}</p>`;
    if (signal.recommendedLotSize) details += `<p>Recommended Lot: ${signal.recommendedLotSize}</p>`;
    details += `</div>
      <button class="btn btn-sm btn-outline-primary" onclick="window.fillTradeForm('${signal.pair}','${signal.side}','${signal.entryPrice}','${signal.stopLoss}','${signal.takeProfit}','${signal.recommendedLotSize || CONFIG.DEFAULT_LOT}')">
        <i class="fas fa-arrow-right"></i> Use for Trade
      </button>
    `;
    resultDiv.innerHTML = details;
    SoundManager.signal();
  } catch (e) {
    resultDiv.innerHTML = `<p class="text-danger">Error: ${e.message}</p>`;
  }
});

window.fillTradeForm = function(pair, side, entry, sl, tp, lotSize) {
  document.getElementById('tradePair').value = pair;
  document.getElementById('tradeSide').value = side;
  document.getElementById('tradeLot').value = lotSize || CONFIG.DEFAULT_LOT;
  document.getElementById('tradeSL').value = sl;
  document.getElementById('tradeTP').value = tp;
  document.querySelector('#tradeForm').scrollIntoView({ behavior: 'smooth' });
};

// ---- Manual Trade ----
document.getElementById('tradeForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  if (isSubmitting) {
    alert('Please wait, order is being processed...');
    return;
  }
  isSubmitting = true;
  const btn = this.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Placing...';

  try {
    const pair = document.getElementById('tradePair').value.trim();
    const side = document.getElementById('tradeSide').value;
    const lotSize = parseFloat(document.getElementById('tradeLot').value);
    const sl = document.getElementById('tradeSL').value ? parseFloat(document.getElementById('tradeSL').value) : null;
    const tp = document.getElementById('tradeTP').value ? parseFloat(document.getElementById('tradeTP').value) : null;
    if (!pair || !side || isNaN(lotSize) || lotSize <= 0) {
      alert('Please fill all required fields correctly.');
      return;
    }
    const result = await fetchJson(`${CONFIG.API_BASE}/api/order`, {
      method: 'POST',
      body: JSON.stringify({ pair, side, lotSize, stopLoss: sl, takeProfit: tp })
    });
    SoundManager.tradeOpen();
    alert('Order placed successfully! Trade ID: ' + (result.trade?.contractId || result.trade?.oandaTradeId || 'N/A'));
    loadOpenTrades();
    loadTradeHistory();
    loadAccount();
  } catch (e) {
    alert('Error placing order: ' + e.message);
    SoundManager.reject();
  } finally {
    isSubmitting = false;
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-paper-plane"></i> Place Order';
  }
});

// ---- Auto-Trade ----
document.getElementById('autoTradeForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  if (isAutoSubmitting) {
    alert('Please wait, auto-trade is being processed...');
    return;
  }
  isAutoSubmitting = true;
  const btn = this.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Auto-trading...';

  try {
    const pair = document.getElementById('autoPair').value.trim();
    const risk = parseFloat(document.getElementById('autoRisk').value);
    const strategy = document.getElementById('autoStrategy')?.value || 'sma';
    if (!pair || isNaN(risk) || risk <= 0) {
      alert('Please enter valid pair and risk percentage.');
      return;
    }
    const result = await fetchJson(`${CONFIG.API_BASE}/api/auto-trade`, {
      method: 'POST',
      body: JSON.stringify({ pair, riskPercent: risk, strategy })
    });
    if (result.success) {
      SoundManager.tradeOpen();
      alert(`Auto-trade executed! Trade opened.`);
      loadOpenTrades();
      loadTradeHistory();
      loadAccount();
    } else {
      SoundManager.reject();
      alert('Auto-trade: ' + (result.message || 'No signal'));
    }
  } catch (e) {
    alert('Error auto-trading: ' + e.message);
    SoundManager.reject();
  } finally {
    isAutoSubmitting = false;
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-robot"></i> Auto-Trade';
  }
});

// ---- Load Open Trades ----
let openTradesInterval = null;

async function loadOpenTrades() {
  const container = document.getElementById('openTradesContainer');
  if (!container) return;
  container.innerHTML = '<p class="text-muted">Loading open trades...</p>';
  try {
    const trades = await fetchJson(`${CONFIG.API_BASE}/api/trades`);
    if (!trades || trades.length === 0) {
      container.innerHTML = '<p class="text-muted">No open trades.</p>';
      document.getElementById('statOpenTrades').textContent = '0';
      document.getElementById('statOpenPL').textContent = '—';
      if (window.updatePositionBadge) window.updatePositionBadge(0);
      return;
    }
    let html = `<table class="table table-striped"><thead><tr><th>ID</th><th>Pair</th><th>Side</th><th>Open Price</th><th>Current Price</th><th>Units</th><th>P/L</th><th>Action</th></tr></thead><tbody>`;
    let totalPL = 0;
    for (const t of trades) {
      const pl = t.unrealizedPL ? parseFloat(t.unrealizedPL).toFixed(2) : '0.00';
      const currentPrice = t.currentPrice || t.price || 'N/A';
      totalPL += parseFloat(pl) || 0;
      html += `<tr>
        <td>${t.id}</td>
        <td>${t.instrument}</td>
        <td><span class="badge ${t.side === 'BUY' ? 'bg-success' : 'bg-danger'}">${t.side}</span></td>
        <td>${formatPrice(t.price)}</td>
        <td>${currentPrice}</td>
        <td>${t.units}</td>
        <td class="${pl >= 0 ? 'text-success' : 'text-danger'}">${pl}</td>
        <td><button class="btn btn-sm btn-danger" onclick="window.closeTrade('${t.id}')"><i class="fas fa-times"></i> Close</button></td>
      </tr>`;
    }
    html += `<tr><td colspan="6"><strong>Total Unrealized P&L</strong></td><td class="${totalPL >= 0 ? 'text-success' : 'text-danger'}"><strong>${totalPL.toFixed(2)}</strong></td><td></td></tr>`;
    html += '</tbody></table>';
    container.innerHTML = html;
    document.getElementById('statOpenTrades').textContent = trades.length;
    document.getElementById('statOpenPL').textContent = (totalPL >= 0 ? '+' : '') + totalPL.toFixed(2);
    document.getElementById('statOpenPL').className = `stat-change ${totalPL >= 0 ? 'positive' : 'negative'}`;
    if (window.updatePositionBadge) window.updatePositionBadge(trades.length);
  } catch (e) {
    container.innerHTML = `<p class="text-danger">Error loading trades: ${e.message}</p>`;
  }
}

window.closeTrade = async function(tradeId) {
  if (!confirm(`Close trade ${tradeId}?`)) return;
  try {
    await fetchJson(`${CONFIG.API_BASE}/api/close/${tradeId}`, { method: 'PUT' });
    SoundManager.tradeClose();
    alert('Trade closed successfully.');
    loadOpenTrades();
    loadTradeHistory();
    loadAccount();
    updateStatsFromHistory();
  } catch (e) {
    alert('Error closing trade: ' + e.message);
    SoundManager.reject();
  }
};

// ---- Update Win Rate and Profit Factor ----
async function updateStatsFromHistory() {
  try {
    const trades = await fetchJson(`${CONFIG.API_BASE}/api/trade-history`);
    if (trades && trades.length > 0) {
      const wins = trades.filter(t => t.pnl > 0).length;
      const total = trades.length;
      const winRate = total > 0 ? (wins / total) * 100 : 0;
      document.getElementById('statWinRate').textContent = winRate.toFixed(1) + '%';
      const totalWins = trades.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
      const totalLosses = trades.filter(t => t.pnl < 0).reduce((sum, t) => sum + Math.abs(t.pnl), 0);
      const pf = totalLosses > 0 ? (totalWins / totalLosses) : (totalWins > 0 ? Infinity : 0);
      document.getElementById('statProfitFactor').textContent = `PF: ${pf === Infinity ? '∞' : pf.toFixed(2)}`;
    } else {
      document.getElementById('statWinRate').textContent = '—';
      document.getElementById('statProfitFactor').textContent = 'PF: —';
    }
  } catch (e) {
    // ignore
  }
}

// ---- Load Trade History (with proper P&L display) ----
async function loadTradeHistory(page = 1) {
  const container = document.getElementById('historyContainer');
  if (!container) return;
  container.innerHTML = '<p class="text-muted">Loading history...</p>';

  try {
    const trades = await fetchJson(`${CONFIG.API_BASE}/api/trade-history`);
    if (!trades || trades.length === 0) {
      container.innerHTML = '<p class="text-muted">No trade history yet.</p>';
      document.getElementById('historyCount').textContent = '0';
      document.getElementById('pageStart').textContent = '0';
      document.getElementById('pageEnd').textContent = '0';
      document.getElementById('pageTotal').textContent = '0';
      historyData = [];
      historyFiltered = [];
      updateStatsFromHistory();
      // Remove any existing total P&L display
      document.getElementById('totalPnLDisplay')?.remove();
      return;
    }

    historyData = trades;
    // Filters
    const from = document.getElementById('historyFrom')?.value;
    const to = document.getElementById('historyTo')?.value;
    const symbol = document.getElementById('historySymbol')?.value.trim();
    const side = document.getElementById('historySide')?.value;
    const status = document.getElementById('historyStatus')?.value;

    historyFiltered = historyData.filter(t => {
      if (from && new Date(t.date) < new Date(from)) return false;
      if (to && new Date(t.date) > new Date(to)) return false;
      if (symbol && !t.pair?.toUpperCase().includes(symbol.toUpperCase())) return false;
      if (side && t.side !== side) return false;
      if (status && t.status !== status) return false;
      return true;
    });

    historyFiltered.sort((a, b) => new Date(b.date) - new Date(a.date));
    document.getElementById('historyCount').textContent = historyFiltered.length;

    // ---- NEW: Calculate total P&L for filtered trades ----
    const totalPnL = historyFiltered.reduce((sum, t) => sum + (t.pnl || 0), 0);
    // Remove old total P&L display
    document.getElementById('totalPnLDisplay')?.remove();

    const totalItems = historyFiltered.length;
    historyTotalPages = Math.ceil(totalItems / HISTORY_PAGE_SIZE) || 1;
    if (page < 1) page = 1;
    if (page > historyTotalPages) page = historyTotalPages;
    historyPage = page;

    const start = (historyPage - 1) * HISTORY_PAGE_SIZE;
    const end = Math.min(start + HISTORY_PAGE_SIZE, totalItems);
    const pageItems = historyFiltered.slice(start, end);

    document.getElementById('pageStart').textContent = totalItems > 0 ? start + 1 : 0;
    document.getElementById('pageEnd').textContent = end;
    document.getElementById('pageTotal').textContent = totalItems;
    document.getElementById('pageInfo').textContent = `Page ${historyPage} of ${historyTotalPages}`;
    document.getElementById('prevPage').disabled = (historyPage <= 1);
    document.getElementById('nextPage').disabled = (historyPage >= historyTotalPages);

    if (pageItems.length === 0) {
      container.innerHTML = '<p class="text-muted">No matching records.</p>';
      updateStatsFromHistory();
      return;
    }

    // Build table
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
    updateStatsFromHistory();

    // Insert total P&L above the table
    if (historyFiltered.length > 0) {
      const totalRow = document.createElement('div');
      totalRow.id = 'totalPnLDisplay';
      totalRow.className = 'fw-bold mb-2';
      totalRow.innerHTML = `Total P&L (filtered): <span class="${totalPnL >= 0 ? 'text-success' : 'text-danger'}">${totalPnL.toFixed(2)}</span>`;
      container.parentNode.insertBefore(totalRow, container);
    }

  } catch (e) {
    container.innerHTML = `<p class="text-danger">Error loading history: ${e.message}</p>`;
  }
}

// ---- Load Pending Orders ----
async function loadPendingOrders() {
  const container = document.getElementById('pendingOrdersContainer');
  if (!container) return;
  container.innerHTML = '<p class="text-muted">Loading pending orders...</p>';
  try {
    const orders = await fetchJson(`${CONFIG.API_BASE}/api/pending-orders`);
    if (!orders || orders.length === 0) {
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
  } catch (e) {
    container.innerHTML = `<p class="text-danger">Error loading pending orders: ${e.message}</p>`;
  }
}

window.cancelPending = async function(orderId) {
  if (!confirm(`Cancel order ${orderId}?`)) return;
  try {
    await fetchJson(`${CONFIG.API_BASE}/api/order/${orderId}`, { method: 'DELETE' });
    alert('Order cancelled successfully.');
    loadPendingOrders();
    loadOpenTrades();
  } catch (e) {
    alert('Error cancelling order: ' + e.message);
  }
};

// ---- Delete History ----
document.getElementById('deleteHistoryBtn')?.addEventListener('click', async function() {
  if (!confirm('Delete all closed trades from history? This cannot be undone.')) return;
  try {
    const result = await fetchJson(`${CONFIG.API_BASE}/api/history`, { method: 'DELETE' });
    alert(`Deleted ${result.deletedCount} closed trades.`);
    loadTradeHistory(1);
    updateStatsFromHistory();
  } catch (e) {
    alert('Error deleting history: ' + e.message);
  }
});

// ---- Test Notification ----
document.getElementById('testNotificationBtn')?.addEventListener('click', async function() {
  try {
    const result = await fetchJson(`${CONFIG.API_BASE}/api/test-email`, { method: 'POST' });
    alert('Test email sent! Check your inbox.');
  } catch (e) {
    alert('Error sending test email: ' + e.message);
  }
});

// ---- Refresh buttons ----
document.getElementById('refreshTrades')?.addEventListener('click', loadOpenTrades);
document.getElementById('refreshHistory')?.addEventListener('click', () => loadTradeHistory(1));
document.getElementById('refreshPending')?.addEventListener('click', loadPendingOrders);

// ---- NEW: History Filter Buttons ----
document.getElementById('applyHistoryFilter')?.addEventListener('click', function() {
  loadTradeHistory(1);
});
document.getElementById('resetHistoryFilter')?.addEventListener('click', function() {
  document.getElementById('historyFrom').value = '';
  document.getElementById('historyTo').value = '';
  document.getElementById('historySymbol').value = '';
  document.getElementById('historySide').value = '';
  document.getElementById('historyStatus').value = '';
  loadTradeHistory(1);
});

// ---- NEW: Pagination Buttons ----
document.getElementById('prevPage')?.addEventListener('click', function() {
  if (historyPage > 1) loadTradeHistory(historyPage - 1);
});
document.getElementById('nextPage')?.addEventListener('click', function() {
  if (historyPage < historyTotalPages) loadTradeHistory(historyPage + 1);
});

// ---- Start Live Updates ----
function startLiveUpdates() {
  if (openTradesInterval) clearInterval(openTradesInterval);
  openTradesInterval = setInterval(loadOpenTrades, REFRESH_INTERVAL);
}

// ---- Initialise ----
loadProductPreference();
loadAccount();
loadPrices();
loadOpenTrades();
loadTradeHistory(1);
loadPendingOrders();
loadNotificationStatus();
startLiveUpdates();
setInterval(loadPrices, CONFIG.PRICE_REFRESH_INTERVAL);
setInterval(updateStatsFromHistory, 30000);

// ---- Cleanup on page unload ----
window.addEventListener('beforeunload', function() {
  if (openTradesInterval) clearInterval(openTradesInterval);
});

// ============================================================
// EXPORT HISTORY CSV
// ============================================================
function exportHistoryCSV() {
  if (!historyFiltered || historyFiltered.length === 0) {
    alert('No data to export.');
    return;
  }
  const headers = ['Pair','Side','Entry','Exit','Lot','P/L','Status','Date'];
  const rows = historyFiltered.map(t => [
    t.pair,
    t.side,
    t.entryPrice,
    t.exitPrice,
    t.lotSize,
    t.pnl || 0,
    t.status,
    new Date(t.date).toLocaleString()
  ]);
  let csv = headers.join(',') + '\n';
  rows.forEach(row => {
    csv += row.map(v => `"${v}"`).join(',') + '\n';
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `trade_history_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
document.getElementById('exportCSVBtn')?.addEventListener('click', exportHistoryCSV);

// ============================================================
// DECISION INSPECTOR
// ============================================================
async function openDecisionInspector(decisionId) {
  if (!decisionId) {
    alert('No decision ID provided.');
    return;
  }
  const modal = document.getElementById('decisionInspectorModal');
  if (!modal) {
    try {
      const data = await fetchJson(`${CONFIG.API_BASE}/api/research/decision/${decisionId}?lookahead=5`);
      alert(`
Decision: ${data.decision.decision}
Confidence: ${data.decision.confidence}%
Expected Value: ${data.decision.expectedValue}
Probability: ${(data.decision.probability * 100).toFixed(1)}%
Similar states: ${data.similarity?.stats?.count || 0}
Win rate: ${(data.similarity?.stats?.winRate * 100).toFixed(1)}%
      `);
    } catch (e) {
      alert('Error fetching decision: ' + e.message);
    }
    return;
  }
  const body = modal.querySelector('.modal-body');
  body.innerHTML = '<p class="text-center"><i class="fas fa-spinner fa-spin"></i> Loading decision context...</p>';
  const bsModal = new bootstrap.Modal(modal);
  bsModal.show();
  try {
    const data = await fetchJson(`${CONFIG.API_BASE}/api/research/decision/${decisionId}?lookahead=5`);
    const d = data.decision;
    const sim = data.similarity;
    const stats = sim?.stats || { count: 0, winRate: 0, avgReturnR: 0, maxDrawdown: 0, profitFactor: 0 };
    const cal = data.calibration || {};
    let html = `
      <div class="row">
        <div class="col-md-6">
          <h5>Decision Summary</h5>
          <table class="table table-sm">
            <tr><td><strong>Symbol</strong></td><td>${d.symbol}</td></tr>
            <tr><td><strong>Decision</strong></td><td><span class="badge ${d.decision === 'BUY' ? 'bg-success' : d.decision === 'SELL' ? 'bg-danger' : 'bg-secondary'}">${d.decision}</span></td></tr>
            <tr><td><strong>Confidence</strong></td><td>${d.confidence}%</td></tr>
            <tr><td><strong>Expected Value</strong></td><td>${d.expectedValue?.toFixed(3) || 'N/A'}</td></tr>
            <tr><td><strong>Probability</strong></td><td>${(d.probability * 100).toFixed(1)}%</td></tr>
            <tr><td><strong>Entry Price</strong></td><td>${d.entryPrice}</td></tr>
            <tr><td><strong>Stop Loss</strong></td><td>${d.stopLoss}</td></tr>
            <tr><td><strong>Take Profit</strong></td><td>${d.takeProfit}</td></tr>
            <tr><td><strong>Generated By</strong></td><td>${d.lineage?.generatedBy || 'N/A'}</td></tr>
            <tr><td><strong>Analogues Used</strong></td><td>${d.lineage?.historicalAnalogues || 0}</td></tr>
          </table>
        </div>
        <div class="col-md-6">
          <h5>Historical Similarity</h5>
          <table class="table table-sm">
            <tr><td><strong>Similar States Found</strong></td><td>${stats.count}</td></tr>
            <tr><td><strong>Win Rate</strong></td><td>${(stats.winRate * 100).toFixed(1)}%</td></tr>
            <tr><td><strong>Avg Return (R)</strong></td><td>${stats.avgReturnR?.toFixed(3) || 'N/A'}</td></tr>
            <tr><td><strong>Max Drawdown</strong></td><td>${(stats.maxDrawdown * 100).toFixed(1)}%</td></tr>
            <tr><td><strong>Profit Factor</strong></td><td>${stats.profitFactor?.toFixed(2) || 'N/A'}</td></tr>
          </table>
          ${cal.calibratedConfidence ? `<p><strong>Calibrated Confidence:</strong> ${cal.calibratedConfidence.toFixed(1)}% (sample: ${cal.sampleSize})</p>` : ''}
        </div>
      </div>
      <hr>
      <h6>Feature Contributions</h6>
      <div class="row">
        <div class="col-md-6">
          <strong>Positive</strong>
          <ul>${(d.contributions?.positive || []).map(c => `<li>${c.name}: +${c.score.toFixed(1)}</li>`).join('') || '<li>None</li>'}</ul>
        </div>
        <div class="col-md-6">
          <strong>Negative</strong>
          <ul>${(d.contributions?.negative || []).map(c => `<li>${c.name}: -${c.score.toFixed(1)}</li>`).join('') || '<li>None</li>'}</ul>
        </div>
      </div>
      <hr>
      <h6>Top Similar States</h6>
      <div style="max-height: 200px; overflow-y: auto;">
        <table class="table table-sm">
          <thead><tr><th>Date</th><th>Distance</th><th>Outcome (R)</th><th>Win</th></tr></thead>
          <tbody>
            ${(sim?.states || []).slice(0, 10).map(s => `
              <tr>
                <td>${new Date(s.state.timestamp).toLocaleDateString()}</td>
                <td>${s.distance.toFixed(3)}</td>
                <td>${s.outcome?.returnR?.toFixed(2) || 'N/A'}</td>
                <td>${s.outcome?.win === true ? '✅' : s.outcome?.win === false ? '❌' : '?'}</td>
              </tr>
            `).join('') || '<tr><td colspan="4">No similar states found.</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
    body.innerHTML = html;
  } catch (e) {
    body.innerHTML = `<div class="alert alert-danger">Error loading decision: ${e.message}</div>`;
  }
}
window.openDecisionInspector = openDecisionInspector;

// ============================================================
// BELIEF PANEL
// ============================================================
function updateBeliefPanel(beliefData) {
  const panel = document.getElementById('beliefPanel');
  if (!panel) return;
  const { belief, beliefConfidence, edge, winProbability, similarityCount, marketQuality } = beliefData;
  const trendClass = belief === 'bullish' ? 'text-success' : belief === 'bearish' ? 'text-danger' : 'text-secondary';
  panel.innerHTML = `
    <div class="card">
      <div class="card-body">
        <h6 class="card-title">Market Belief</h6>
        <p class="${trendClass}" style="font-size: 1.2rem; font-weight: bold;">${belief.toUpperCase()} (${beliefConfidence || 50}%)</p>
        <p>Edge: ${edge?.toFixed(3) || 0} R | P(win): ${(winProbability * 100).toFixed(1)}%</p>
        <p>Similarity Sample: ${similarityCount || 0} | Market Quality: ${marketQuality || 50}/100</p>
        <p class="text-muted small">Updated: ${new Date().toLocaleTimeString()}</p>
      </div>
    </div>
  `;
}
window.updateBeliefPanel = updateBeliefPanel;

// ============================================================
// KNOWLEDGE EXPLORER
// ============================================================
async function submitKnowledgeQuery() {
  const symbol = document.getElementById('knowledgeSymbol')?.value || 'EUR_USD';
  const timeframe = document.getElementById('knowledgeTimeframe')?.value || 'M5';
  const regime = document.getElementById('knowledgeRegime')?.value || '';
  const session = document.getElementById('knowledgeSession')?.value || '';
  const lookahead = document.getElementById('knowledgeLookahead')?.value || 5;

  const params = new URLSearchParams();
  if (symbol) params.set('symbol', symbol);
  if (timeframe) params.set('timeframe', timeframe);
  if (regime) params.set('regime', regime);
  if (session) params.set('session', session);
  params.set('lookahead', lookahead);
  params.set('limit', 100);

  const container = document.getElementById('knowledgeResults');
  if (!container) return;
  container.innerHTML = '<p class="text-muted">Searching...</p>';

  try {
    const response = await fetchJson(`${CONFIG.API_BASE}/api/research/knowledge?${params.toString()}`);
    const data = response;
    let html = `<p><strong>Found ${data.count} states</strong>`;
    if (data.stats) {
      html += ` | Win Rate: ${(data.stats.winRate * 100).toFixed(1)}% | Avg Return: ${data.stats.avgReturnR?.toFixed(3)}R | PF: ${data.stats.profitFactor?.toFixed(2)}</p>`;
    }
    html += `<div style="max-height: 300px; overflow-y: auto;"><table class="table table-sm table-striped">
      <thead><tr><th>Date</th><th>Symbol</th><th>Regime</th><th>ADX</th><th>RSI</th><th>Liquidity</th><th>Outcome (R)</th></tr></thead><tbody>`;
    (data.states || []).forEach(s => {
      const out = s[`outcome${lookahead}`] || {};
      html += `<tr>
        <td>${new Date(s.timestamp).toLocaleDateString()}</td>
        <td>${s.symbol}</td>
        <td>${s.regime?.code || 'N/A'}</td>
        <td>${s.trend?.adx?.toFixed(1) || 'N/A'}</td>
        <td>${s.momentum?.rsi?.toFixed(1) || 'N/A'}</td>
        <td>${s.liquidity?.score?.toFixed(2) || 'N/A'}</td>
        <td>${out.returnR?.toFixed(2) || 'N/A'}</td>
      </tr>`;
    });
    html += '</tbody></table></div>';
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div class="alert alert-danger">Error: ${e.message}</div>`;
  }
}
window.submitKnowledgeQuery = submitKnowledgeQuery;

document.addEventListener('DOMContentLoaded', function() {
  const btn = document.getElementById('knowledgeSearchBtn');
  if (btn) btn.addEventListener('click', submitKnowledgeQuery);
});

// ============================================================
// REPORT GENERATION
// ============================================================
async function generateReport() {
  const from = document.getElementById('reportFrom')?.value || '';
  const to = document.getElementById('reportTo')?.value || '';
  const includeTrades = document.getElementById('reportIncludeTrades')?.checked !== false;

  const btn = document.getElementById('generateReportBtn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating...';
  }

  try {
    const response = await fetch(`${CONFIG.API_BASE}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, includeTrades })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Report generation failed');
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `RTS_Report_${new Date().toISOString().slice(0,10)}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('Report generation error: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-file-pdf"></i> Generate Report';
    }
  }
}
window.generateReport = generateReport;

document.addEventListener('DOMContentLoaded', function() {
  const reportBtn = document.getElementById('generateReportBtn');
  if (reportBtn) {
    reportBtn.addEventListener('click', generateReport);
  }
});

// ---- Expose for live.js ----
window.loadOpenTrades = loadOpenTrades;
window.loadTradeHistory = loadTradeHistory;
window.loadAccount = loadAccount;
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
window.updateAccountBadge = updateAccountBadge; // expose for live.js

// ---- Listen for danger signals (from live.js) ----
window.addEventListener('dangerSignal', function() {
  SoundManager.danger();
});

console.log('✅ App.js loaded with all fixes.');
