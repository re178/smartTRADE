// public/js/live.js
// RTS Live WebSocket Client – Real‑time signals, regime, metrics, and market closure status.

(function() {
  'use strict';

  // ---- Configuration ----
  const WS_RECONNECT_DELAY = 2000;
  const WS_MAX_RECONNECT_DELAY = 30000;
  let reconnectAttempts = 0;
  let ws = null;
  let wsConnected = false;

  // ---- DOM references ----
  const liveSignalPanel = document.getElementById('liveSignalPanel');
  const regimePanel = document.getElementById('regimePanel');
  const metricsPanel = document.getElementById('metricsPanel');
  const wsStatus = document.getElementById('wsStatus');

  // ---- Helper: update WebSocket status indicator ----
  function updateWsStatus(connected) {
    wsConnected = connected;
    if (wsStatus) {
      wsStatus.textContent = connected ? '🟢 Live' : '🔴 Disconnected';
      wsStatus.className = connected ? 'badge bg-success' : 'badge bg-danger';
    }
  }

  // ---- WebSocket connection ----
  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      console.error('[Live] WebSocket creation failed:', e);
      scheduleReconnect();
      return;
    }

    ws.onopen = function() {
      console.log('[Live] WebSocket connected.');
      reconnectAttempts = 0;
      updateWsStatus(true);
    };

    ws.onmessage = function(event) {
      try {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch (e) {
        console.error('[Live] Message parse error:', e);
      }
    };

    ws.onclose = function() {
      console.warn('[Live] WebSocket closed.');
      updateWsStatus(false);
      scheduleReconnect();
    };

    ws.onerror = function(err) {
      console.error('[Live] WebSocket error:', err);
      // Will close automatically; we handle reconnect in onclose.
    };
  }

  // ---- Reconnection logic (exponential backoff) ----
  function scheduleReconnect() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    const delay = Math.min(WS_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts), WS_MAX_RECONNECT_DELAY);
    reconnectAttempts++;
    console.log(`[Live] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
    setTimeout(connectWebSocket, delay);
  }

  // ---- Message handler ----
  function handleMessage(msg) {
    // msg format: { type: 'decision'|'regime'|'metrics'|'marketClosed', data: ... }
    switch (msg.type) {
      case 'decision':
        displayDecision(msg.data);
        break;
      case 'regime':
        displayRegime(msg.data);
        break;
      case 'metrics':
        displayMetrics(msg.data);
        break;
      case 'marketClosed':
        displayMarketClosed(msg.data);
        break;
      default:
        console.debug('[Live] Unknown message type:', msg.type);
    }
  }

  // ---- Display a live decision (signal) ----
  function displayDecision(decision) {
    if (!liveSignalPanel) return;

    const { symbol, decision: side, confidence, entryPrice, stopLoss, takeProfit, recommendedLotSize, reason, timestamp } = decision;
    const alertClass = side === 'BUY' ? 'success' : side === 'SELL' ? 'danger' : 'secondary';
    const sideLabel = side || 'NO TRADE';

    let html = `<div class="alert alert-${alertClass} live-signal-card" data-symbol="${symbol}" data-side="${side}" data-entry="${entryPrice}" data-sl="${stopLoss}" data-tp="${takeProfit}" data-lot="${recommendedLotSize || 0.01}">`;
    html += `<h5><strong>${sideLabel}</strong> ${symbol} (${confidence}% confidence)</h5>`;
    if (side && side !== 'NO_TRADE') {
      html += `<p>Entry: ${formatPrice(entryPrice)} | SL: ${formatPrice(stopLoss)} | TP: ${formatPrice(takeProfit)}</p>`;
      html += `<p>Lot: ${recommendedLotSize || 'N/A'}</p>`;
      html += `<p><small>${reason || ''}</small></p>`;
      html += `<button class="btn btn-sm btn-primary execute-signal-btn" onclick="window.executeSignalFromCard(this)">`;
      html += `<i class="fas fa-rocket"></i> Execute Trade</button>`;
    } else {
      html += `<p><em>No trade recommended.</em></p>`;
    }
    html += `<p class="text-muted small mt-2">${new Date(timestamp).toLocaleString()}</p>`;
    html += `</div>`;

    liveSignalPanel.innerHTML = html;
    // Play sound for new signal if it's a BUY/SELL and the sound function exists
    if (side && side !== 'NO_TRADE' && typeof window.playSound === 'function') {
      window.playSound('signal');
    }
  }

  // ---- Display market closed status ----
  function displayMarketClosed(data) {
    if (!liveSignalPanel) return;
    const { symbol, reason, nextOpen } = data;
    liveSignalPanel.innerHTML = `
      <div class="alert alert-warning">
        <h5><i class="fas fa-hourglass-end"></i> Market Closed</h5>
        <p><strong>${symbol}</strong></p>
        <p>${reason}</p>
        <p><strong>Next open:</strong> ${nextOpen ? new Date(nextOpen).toLocaleString() : 'Unknown'}</p>
      </div>
    `;
  }

  // ---- Display regime ----
  function displayRegime(regime) {
    if (!regimePanel) return;
    const { name, confidence, description, symbol, timestamp } = regime;
    regimePanel.innerHTML = `
      <div class="card">
        <div class="card-body">
          <h6 class="card-title">Current Regime</h6>
          <p class="card-text"><strong>${name}</strong> (${confidence}%)</p>
          <p class="small">${description || ''}</p>
          <p class="small text-muted">${symbol} | ${new Date(timestamp).toLocaleString()}</p>
        </div>
      </div>
    `;
  }

  // ---- Display performance metrics ----
  function displayMetrics(metrics) {
    if (!metricsPanel) return;
    const { winRate, profitFactor, sharpe, maxDrawdown, expectancy, totalTrades, dailyPnL, currentDrawdown, timestamp } = metrics;
    metricsPanel.innerHTML = `
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

  // ---- Global function: Execute trade from the signal card (called by button click) ----
  window.executeSignalFromCard = function(btn) {
    const card = btn.closest('.live-signal-card');
    if (!card) return;
    const symbol = card.dataset.symbol;
    const side = card.dataset.side;
    const entry = parseFloat(card.dataset.entry);
    const sl = parseFloat(card.dataset.sl) || null;
    const tp = parseFloat(card.dataset.tp) || null;
    const lot = parseFloat(card.dataset.lot) || 0.01;

    // Use the existing window.fillTradeForm (from app.js) to fill the form
    if (typeof window.fillTradeForm === 'function') {
      window.fillTradeForm(symbol, side, entry, sl, tp, lot);
      // Optionally auto-submit: uncomment the next line if you want one-click execution
      // document.getElementById('tradeForm')?.dispatchEvent(new Event('submit'));
    } else {
      alert('Trade form fill function not available.');
    }
  };

  // ---- Helper: formatPrice (reuse from app.js) ----
  function formatPrice(p) {
    if (p === undefined || p === null) return 'N/A';
    return parseFloat(p).toFixed(5);
  }

  // ---- Start the WebSocket connection ----
  connectWebSocket();

  // ---- Expose reconnect for manual reset (optional) ----
  window.reconnectLive = function() {
    if (ws) {
      ws.close();
    }
    reconnectAttempts = 0;
    connectWebSocket();
  };

  // ---- Cleanup on page unload ----
  window.addEventListener('beforeunload', function() {
    if (ws) {
      ws.close();
    }
  });

})();
