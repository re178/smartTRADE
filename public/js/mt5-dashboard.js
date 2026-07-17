// ============================================================
//  CONFIGURATION
// ============================================================
const CONFIG = {
  API_BASE: '/api',
  PRICE_PAIRS: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'XAUUSD'],
  PRICE_REFRESH_INTERVAL: 5000,
  DEFAULT_LOT: 0.01,
  REFRESH_INTERVAL: 10000,  // for trades & pending
};

// ============================================================
//  HELPERS
// ============================================================
async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
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

// ============================================================
//  PRODUCT PREFERENCE
// ============================================================
async function loadProductPreference() {
  try {
    const data = await fetchJson(`${CONFIG.API_BASE}/user/preferences`);
    const product = data.tradingProduct || 'mt5';
    document.querySelectorAll('input[name="product"]').forEach(el => {
      el.checked = (el.value === product);
    });
    document.getElementById('currentProduct').textContent = product.toUpperCase();
  } catch (e) {
    console.error('Failed to load product preference:', e);
  }
}

async function handleProductChange(e) {
  const value = e.target.value;
  // Optimistic UI
  document.querySelectorAll('input[name="product"]').forEach(el => {
    el.checked = (el.value === value);
  });
  document.getElementById('currentProduct').textContent = value.toUpperCase();

  try {
    await fetchJson(`${CONFIG.API_BASE}/user/preferences`, {
      method: 'POST',
      body: JSON.stringify({ tradingProduct: value }),
    });
    console.log('Product switched to:', value);
    refreshAll(); // reload account, trades, etc.
  } catch (err) {
    alert('Failed to update product: ' + err.message);
    loadProductPreference(); // revert
  }
}
// make global for HTML onchange
window.handleProductChange = handleProductChange;

// ============================================================
//  ACCOUNT
// ============================================================
async function loadAccount() {
  try {
    const acc = await fetchJson(`${CONFIG.API_BASE}/account`);
    document.getElementById('accountInfo').innerHTML = `
      <p><strong>ID:</strong> ${acc.id || 'N/A'}</p>
      <p><strong>Currency:</strong> ${acc.currency || 'USD'}</p>
      <p><strong>Balance:</strong> ${acc.balance}</p>
      <p><strong>Equity:</strong> ${acc.equity}</p>
      <p><strong>Margin Used:</strong> ${acc.marginUsed}</p>
      <p><strong>Free Margin:</strong> ${acc.marginAvailable}</p>
    `;
  } catch (e) {
    document.getElementById('accountInfo').innerHTML = `<p class="text-danger">Error: ${e.message}</p>`;
  }
}

// ============================================================
//  PRICES
// ============================================================
async function loadPrices() {
  try {
    const data = await fetchJson(
      `${CONFIG.API_BASE}/prices?instruments=${CONFIG.PRICE_PAIRS.join(',')}`
    );
    let html = '';
    data.forEach(p => {
      const bid = parseFloat(p.bids[0].price);
      const ask = parseFloat(p.asks[0].price);
      const mid = (bid + ask) / 2;
      html += `<div class="d-flex justify-content-between">
        <span>${p.instrument}</span>
        <span><strong>${formatPrice(mid)}</strong> (Bid ${formatPrice(bid)} / Ask ${formatPrice(ask)})</span>
      </div>`;
    });
    document.getElementById('priceInfo').innerHTML = html;
  } catch (e) {
    document.getElementById('priceInfo').innerHTML = `<p class="text-danger">Error: ${e.message}</p>`;
  }
}

// ============================================================
//  OPEN TRADES (MT5 positions)
// ============================================================
async function loadOpenTrades() {
  const container = document.getElementById('openTradesContainer');
  container.innerHTML = '<p class="text-muted">Loading open trades...</p>';
  try {
    const trades = await fetchJson(`${CONFIG.API_BASE}/trades`);
    if (!trades || trades.length === 0) {
      container.innerHTML = '<p class="text-muted">No open trades.</p>';
      return;
    }
    let html = `<table class="table table-striped">
      <thead><tr>
        <th>ID</th><th>Pair</th><th>Side</th><th>Open Price</th><th>Current Price</th><th>Units</th><th>P/L</th><th>Action</th>
      </tr></thead><tbody>`;
    let totalPL = 0;
    for (const t of trades) {
      const pl = t.unrealizedPL ? parseFloat(t.unrealizedPL).toFixed(2) : '0.00';
      totalPL += parseFloat(pl) || 0;
      const currentPrice = t.currentPrice || t.price || 'N/A';
      html += `<tr>
        <td>${t.id}</td>
        <td>${t.instrument}</td>
        <td><span class="badge ${t.side === 'BUY' ? 'bg-success' : 'bg-danger'}">${t.side}</span></td>
        <td>${formatPrice(t.price)}</td>
        <td>${currentPrice}</td>
        <td>${t.units}</td>
        <td class="${pl >= 0 ? 'text-success' : 'text-danger'}">${pl}</td>
        <td><button class="btn btn-sm btn-danger" onclick="closeTrade('${t.id}')">Close</button></td>
      </tr>`;
    }
    html += `<tr><td colspan="6"><strong>Total Unrealized P&L</strong></td>
      <td class="${totalPL >= 0 ? 'text-success' : 'text-danger'}"><strong>${totalPL.toFixed(2)}</strong></td><td></td></tr>`;
    html += '</tbody></table>';
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<p class="text-danger">Error: ${e.message}</p>`;
  }
}

// ---- Close Trade (MT5) ----
window.closeTrade = async function(tradeId) {
  if (!confirm(`Close trade ${tradeId}?`)) return;
  try {
    await fetchJson(`${CONFIG.API_BASE}/close/${tradeId}`, { method: 'PUT' });
    alert('Trade closed.');
    refreshAll();
  } catch (e) {
    alert('Error closing trade: ' + e.message);
  }
};

// ============================================================
//  PENDING ORDERS (MT5 pending orders – if supported)
// ============================================================
async function loadPendingOrders() {
  const container = document.getElementById('pendingOrdersContainer');
  if (!container) return;
  container.innerHTML = '<p class="text-muted">Loading pending orders...</p>';
  try {
    const orders = await fetchJson(`${CONFIG.API_BASE}/pending-orders`);
    if (!orders || orders.length === 0) {
      container.innerHTML = '<p class="text-muted">No pending orders.</p>';
      return;
    }
    let html = `<table class="table table-striped">
      <thead><tr><th>ID</th><th>Pair</th><th>Side</th><th>Entry Price</th><th>Lot</th><th>Status</th><th>Action</th></tr></thead><tbody>`;
    for (const o of orders) {
      html += `<tr>
        <td>${o.contractId || o.clientOrderId || 'N/A'}</td>
        <td>${o.instrument}</td>
        <td><span class="badge ${o.side === 'BUY' ? 'bg-success' : 'bg-danger'}">${o.side}</span></td>
        <td>${o.entryPrice || '-'}</td>
        <td>${o.units || o.lotSize}</td>
        <td><span class="badge bg-warning">${o.status}</span></td>
        <td><button class="btn btn-sm btn-danger" onclick="cancelPending('${o.contractId || o.clientOrderId}')">Cancel</button></td>
      </tr>`;
    }
    html += '</tbody></table>';
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<p class="text-danger">Error: ${e.message}</p>`;
  }
}

window.cancelPending = async function(orderId) {
  if (!confirm(`Cancel order ${orderId}?`)) return;
  try {
    await fetchJson(`${CONFIG.API_BASE}/order/${orderId}`, { method: 'DELETE' });
    alert('Order cancelled.');
    refreshAll();
  } catch (e) {
    alert('Error cancelling: ' + e.message);
  }
};

// ============================================================
//  TRADE HISTORY
// ============================================================
async function loadTradeHistory() {
  const container = document.getElementById('historyContainer');
  container.innerHTML = '<p class="text-muted">Loading history...</p>';
  try {
    const trades = await fetchJson(`${CONFIG.API_BASE}/trade-history`);
    if (!trades || trades.length === 0) {
      container.innerHTML = '<p class="text-muted">No history yet.</p>';
      return;
    }
    let html = `<table class="table table-striped table-sm">
      <thead><tr><th>Pair</th><th>Side</th><th>Entry</th><th>Exit</th><th>Lot</th><th>P/L</th><th>Status</th><th>Date</th></tr></thead><tbody>`;
    trades.forEach(t => {
      const pl = t.pnl ? parseFloat(t.pnl).toFixed(2) : '0.00';
      const statusClass = t.status === 'OPEN' ? 'bg-primary' : (pl >= 0 ? 'bg-success' : 'bg-danger');
      html += `<tr>
        <td>${t.pair}</td>
        <td><span class="badge ${t.side === 'BUY' ? 'bg-success' : 'bg-danger'}">${t.side}</span></td>
        <td>${t.entryPrice}</td>
        <td>${t.closePrice || '-'}</td>
        <td>${t.lotSize}</td>
        <td class="${pl >= 0 ? 'text-success' : 'text-danger'}">${pl}</td>
        <td><span class="badge ${statusClass}">${t.status}</span></td>
        <td>${new Date(t.createdAt).toLocaleString()}</td>
      </tr>`;
    });
    html += '</tbody></table>';
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<p class="text-danger">Error: ${e.message}</p>`;
  }
}

// ---- Delete History ----
document.getElementById('deleteHistoryBtn')?.addEventListener('click', async function() {
  if (!confirm('Delete all closed trades from history?')) return;
  try {
    const result = await fetchJson(`${CONFIG.API_BASE}/history`, { method: 'DELETE' });
    alert(`Deleted ${result.deletedCount} closed trades.`);
    loadTradeHistory();
  } catch (e) {
    alert('Error: ' + e.message);
  }
});

// ============================================================
//  PLACE MARKET ORDER (MT5)
// ============================================================
let isSubmitting = false;

document.getElementById('tradeForm')?.addEventListener('submit', async function(e) {
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
    const pair = document.getElementById('tradePair').value.trim().toUpperCase();
    const side = document.getElementById('tradeSide').value;
    const lotSize = parseFloat(document.getElementById('tradeLot').value);
    const sl = document.getElementById('tradeSL').value ? parseFloat(document.getElementById('tradeSL').value) : null;
    const tp = document.getElementById('tradeTP').value ? parseFloat(document.getElementById('tradeTP').value) : null;

    if (!pair || !side || isNaN(lotSize) || lotSize <= 0) {
      alert('Please fill all required fields correctly.');
      return;
    }

    const result = await fetchJson(`${CONFIG.API_BASE}/order`, {
      method: 'POST',
      body: JSON.stringify({ pair, side, lotSize, stopLoss: sl, takeProfit: tp }),
    });
    alert('Order placed! Trade ID: ' + (result.trade?.contractId || result.trade?.oandaTradeId || 'N/A'));
    refreshAll();
  } catch (e) {
    alert('Error placing order: ' + e.message);
  } finally {
    isSubmitting = false;
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-paper-plane"></i> Place Order';
  }
});

// ============================================================
//  AUTO-TRADE (strategy-based)
// ============================================================
let isAutoSubmitting = false;

document.getElementById('autoTradeForm')?.addEventListener('submit', async function(e) {
  e.preventDefault();
  if (isAutoSubmitting) {
    alert('Please wait...');
    return;
  }
  isAutoSubmitting = true;
  const btn = this.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Auto-trading...';

  try {
    const pair = document.getElementById('autoPair').value.trim().toUpperCase();
    const risk = parseFloat(document.getElementById('autoRisk').value);
    const strategy = document.getElementById('autoStrategy')?.value || 'sma';
    if (!pair || isNaN(risk) || risk <= 0) {
      alert('Enter valid pair and risk %.');
      return;
    }
    const result = await fetchJson(`${CONFIG.API_BASE}/auto-trade`, {
      method: 'POST',
      body: JSON.stringify({ pair, riskPercent: risk, strategy }),
    });
    if (result.success) {
      alert('Auto-trade executed!');
      refreshAll();
    } else {
      alert('Auto-trade: ' + (result.message || 'No signal'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    isAutoSubmitting = false;
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-robot"></i> Auto-Trade';
  }
});

// ============================================================
//  SIGNAL GENERATION
// ============================================================
document.getElementById('getSignalBtn')?.addEventListener('click', async function() {
  const pair = document.getElementById('signalPair').value.trim().toUpperCase();
  const strategy = document.getElementById('signalStrategy')?.value || 'sma';
  if (!pair) return;
  const resultDiv = document.getElementById('signalResult');
  resultDiv.innerHTML = '<p class="text-muted">Fetching signal...</p>';
  try {
    const signal = await fetchJson(`${CONFIG.API_BASE}/signal?pair=${pair}&strategy=${strategy}`);
    if (!signal || !signal.side) {
      resultDiv.innerHTML = `<p class="text-warning">No signal for ${pair} at this time.</p>`;
      return;
    }
    let details = `<div class="alert alert-${signal.side === 'BUY' ? 'success' : 'danger'}">
      <h5><strong>${signal.side}</strong> ${signal.pair}</h5>
      <p>Entry: ${formatPrice(signal.entryPrice)} | SL: ${formatPrice(signal.stopLoss)} | TP: ${formatPrice(signal.takeProfit)}</p>
      <p>Confidence: ${signal.confidence || 75}%</p>
      ${signal.strategy ? `<p>Strategy: ${signal.strategy}</p>` : ''}
      ${signal.reason ? `<p>Reason: ${signal.reason}</p>` : ''}
      ${signal.riskRating ? `<p>Risk: ${signal.riskRating}</p>` : ''}
      ${signal.recommendedLotSize ? `<p>Recommended Lot: ${signal.recommendedLotSize}</p>` : ''}
    </div>`;
    if (signal.entryPrice && signal.stopLoss && signal.takeProfit) {
      details += `<button class="btn btn-sm btn-outline-primary" onclick="fillTradeForm('${signal.pair}','${signal.side}','${signal.entryPrice}','${signal.stopLoss}','${signal.takeProfit}','${signal.recommendedLotSize || CONFIG.DEFAULT_LOT}')">
        <i class="fas fa-arrow-right"></i> Use for Trade
      </button>`;
    }
    resultDiv.innerHTML = details;
  } catch (e) {
    resultDiv.innerHTML = `<p class="text-danger">Error: ${e.message}</p>`;
  }
});

// ---- Fill trade form from signal ----
window.fillTradeForm = function(pair, side, entry, sl, tp, lot) {
  document.getElementById('tradePair').value = pair;
  document.getElementById('tradeSide').value = side;
  document.getElementById('tradeLot').value = lot || CONFIG.DEFAULT_LOT;
  document.getElementById('tradeSL').value = sl;
  document.getElementById('tradeTP').value = tp;
  document.querySelector('#tradeForm').scrollIntoView({ behavior: 'smooth' });
};

// ============================================================
//  REFRESH ALL
// ============================================================
function refreshAll() {
  loadAccount();
  loadOpenTrades();
  loadTradeHistory();
  loadPendingOrders();
  loadPrices();
}

// ============================================================
//  LIVE UPDATES (polling)
// ============================================================
let openTradesInterval = null;
let priceInterval = null;

function startLiveUpdates() {
  if (openTradesInterval) clearInterval(openTradesInterval);
  if (priceInterval) clearInterval(priceInterval);

  openTradesInterval = setInterval(loadOpenTrades, CONFIG.REFRESH_INTERVAL);
  priceInterval = setInterval(loadPrices, CONFIG.PRICE_REFRESH_INTERVAL);
}

// ============================================================
//  INIT
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
  loadProductPreference();
  refreshAll();
  startLiveUpdates();

  // Optional: refresh buttons
  document.getElementById('refreshTrades')?.addEventListener('click', loadOpenTrades);
  document.getElementById('refreshHistory')?.addEventListener('click', loadTradeHistory);
  document.getElementById('refreshPending')?.addEventListener('click', loadPendingOrders);
});

// Cleanup intervals on page unload
window.addEventListener('beforeunload', function() {
  if (openTradesInterval) clearInterval(openTradesInterval);
  if (priceInterval) clearInterval(priceInterval);
});
