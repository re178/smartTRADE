// public/js/app.js – Dashboard Logic (with sound & faster refresh)

// ---- Configuration ----
const REFRESH_INTERVAL = 3000; // 3 seconds – faster for real‑time feel
let isSubmitting = false;
let isAutoSubmitting = false;

// ---- Sound Helper (fallback if audio files missing) ----
function playSound(type) {
  try {
    const audio = new Audio();
    if (type === 'open') {
      audio.src = '/sounds/trade-open.mp3';
    } else if (type === 'close') {
      audio.src = '/sounds/trade-close.mp3';
    } else if (type === 'alert') {
      audio.src = '/sounds/alert.mp3';
    } else {
      return;
    }
    audio.play().catch(() => {
      // Fallback: generate beep using Web Audio API
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = type === 'alert' ? 800 : 600;
      gain.gain.value = 0.3;
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
    });
  } catch (e) {
    // Silently fail if sound not supported
  }
}

// ---- API helper (unchanged) ----
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

// ---- Load Product Preference (unchanged) ----
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

// ---- Handle Product Toggle (unchanged) ----
async function handleProductChange(e) {
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
}
window.handleProductChange = handleProductChange;

// ---- Load Account (with createdTime fix) ----
async function loadAccount() {
  try {
    const acc = await fetchJson(`${CONFIG.API_BASE}/api/account`);
    const created = acc.createdTime || acc.createdAt || acc.updatedAt || null;
    document.getElementById('accountInfo').innerHTML = `
      <p><strong>ID:</strong> ${acc.id}</p>
      <p><strong>Currency:</strong> ${acc.currency}</p>
      <p><strong>Created:</strong> ${created ? new Date(created).toLocaleDateString() : 'N/A'}</p>
    `;
    document.getElementById('balanceInfo').innerHTML = `
      <p><strong>Balance:</strong> ${acc.balance} ${acc.currency}</p>
      <p><strong>Equity:</strong> ${acc.equity} ${acc.currency}</p>
      <p><strong>Margin Used:</strong> ${acc.marginUsed} ${acc.currency}</p>
      <p><strong>Margin Available:</strong> ${acc.marginAvailable} ${acc.currency}</p>
    `;
  } catch (e) {
    document.getElementById('accountInfo').innerHTML = `<p class="text-danger">Error: ${e.message}</p>`;
    document.getElementById('balanceInfo').innerHTML = `<p class="text-danger">Error: ${e.message}</p>`;
  }
}

// ---- Load Prices (unchanged) ----
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

// ---- Load Notification Status (unchanged) ----
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

// ---- Signal Generation (unchanged) ----
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

// ---- Manual Trade (with sound) ----
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
    playSound('open'); // <-- Sound on open
    alert('Order placed successfully! Trade ID: ' + (result.trade?.contractId || result.trade?.oandaTradeId || 'N/A'));
    loadOpenTrades();
    loadTradeHistory();
    loadAccount();
  } catch (e) {
    alert('Error placing order: ' + e.message);
  } finally {
    isSubmitting = false;
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-paper-plane"></i> Place Order';
  }
});

// ---- Auto-Trade (with sound) ----
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
      playSound('open');
      alert(`Auto-trade executed! Trade opened.`);
      loadOpenTrades();
      loadTradeHistory();
      loadAccount();
    } else {
      alert('Auto-trade: ' + (result.message || 'No signal'));
    }
  } catch (e) {
    alert('Error auto-trading: ' + e.message);
  } finally {
    isAutoSubmitting = false;
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-robot"></i> Auto-Trade';
  }
});

// ---- Load Open Trades (unchanged) ----
let openTradesInterval = null;

async function loadOpenTrades() {
  const container = document.getElementById('openTradesContainer');
  container.innerHTML = '<p class="text-muted">Loading open trades...</p>';
  try {
    const trades = await fetchJson(`${CONFIG.API_BASE}/api/trades`);
    if (!trades || trades.length === 0) {
      container.innerHTML = '<p class="text-muted">No open trades.</p>';
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
  } catch (e) {
    container.innerHTML = `<p class="text-danger">Error loading trades: ${e.message}</p>`;
  }
}

// ---- Close Trade (with sound) ----
window.closeTrade = async function(tradeId) {
  if (!confirm(`Close trade ${tradeId}?`)) return;
  try {
    await fetchJson(`${CONFIG.API_BASE}/api/close/${tradeId}`, { method: 'PUT' });
    playSound('close');
    alert('Trade closed successfully.');
    loadOpenTrades();
    loadTradeHistory();
    loadAccount();
  } catch (e) {
    alert('Error closing trade: ' + e.message);
  }
};

// ---- Load Trade History (unchanged) ----
async function loadTradeHistory() {
  const container = document.getElementById('historyContainer');
  container.innerHTML = '<p class="text-muted">Loading history...</p>';
  try {
    const trades = await fetchJson(`${CONFIG.API_BASE}/api/trade-history`);
    if (!trades || trades.length === 0) {
      container.innerHTML = '<p class="text-muted">No trade history yet.</p>';
      return;
    }
    let html = `<table class="table table-striped table-sm"><thead><tr><th>Pair</th><th>Side</th><th>Entry</th><th>Exit</th><th>Lot</th><th>P/L</th><th>Status</th><th>Date</th></tr></thead><tbody>`;
    trades.forEach(t => {
      const pl = t.pnl ? parseFloat(t.pnl).toFixed(2) : '0.00';
      const statusClass = t.status === 'OPEN' ? 'bg-primary' : (t.pnl >= 0 ? 'bg-success' : 'bg-danger');
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
    container.innerHTML = `<p class="text-danger">Error loading history: ${e.message}</p>`;
  }
}

// ---- Load Pending Orders (unchanged) ----
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

// ---- Cancel Pending Order (unchanged) ----
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

// ---- Delete History (unchanged) ----
document.getElementById('deleteHistoryBtn')?.addEventListener('click', async function() {
  if (!confirm('Delete all closed trades from history? This cannot be undone.')) return;
  try {
    const result = await fetchJson(`${CONFIG.API_BASE}/api/history`, { method: 'DELETE' });
    alert(`Deleted ${result.deletedCount} closed trades.`);
    loadTradeHistory();
  } catch (e) {
    alert('Error deleting history: ' + e.message);
  }
});

// ---- Test Notification (unchanged) ----
document.getElementById('testNotificationBtn')?.addEventListener('click', async function() {
  try {
    const result = await fetchJson(`${CONFIG.API_BASE}/api/test-email`, { method: 'POST' });
    alert('Test email sent! Check your inbox.');
  } catch (e) {
    alert('Error sending test email: ' + e.message);
  }
});

// ---- Refresh buttons (unchanged) ----
document.getElementById('refreshTrades')?.addEventListener('click', loadOpenTrades);
document.getElementById('refreshHistory')?.addEventListener('click', loadTradeHistory);
document.getElementById('refreshPending')?.addEventListener('click', loadPendingOrders);

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
loadTradeHistory();
loadPendingOrders();
loadNotificationStatus();
startLiveUpdates();

// Auto-refresh prices (already in config)
setInterval(loadPrices, CONFIG.PRICE_REFRESH_INTERVAL);

// ---- Cleanup on page unload ----
window.addEventListener('beforeunload', function() {
  if (openTradesInterval) clearInterval(openTradesInterval);
});
