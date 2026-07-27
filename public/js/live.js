// public/js/live.js – Updated for CTOS Real-time Events

(function() {
  'use strict';

  const WS_RECONNECT_DELAY = 2000;
  const WS_MAX_RECONNECT_DELAY = 30000;
  let reconnectAttempts = 0;
  let ws = null;

  // DOM elements (new panels)
  const awarenessPanel = document.getElementById('awarenessPanel');
  const hypothesisPanel = document.getElementById('hypothesisPanel');
  const knowledgePanel = document.getElementById('knowledgePanel');
  const liveSignalPanel = document.getElementById('liveSignalPanel');
  const regimePanel = document.getElementById('regimePanel');
  const metricsPanel = document.getElementById('metricsPanel');
  const wsStatus = document.getElementById('wsStatus');

  function updateWsStatus(connected) {
    if (wsStatus) {
      wsStatus.textContent = connected ? '🟢 Live' : '🔴 Disconnected';
      wsStatus.className = connected ? 'badge bg-success' : 'badge bg-danger';
    }
  }

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
    };
  }

  function scheduleReconnect() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    const delay = Math.min(WS_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts), WS_MAX_RECONNECT_DELAY);
    reconnectAttempts++;
    console.log(`[Live] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
    setTimeout(connectWebSocket, delay);
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'marketAwareness':
        displayAwareness(msg.data);
        break;
      case 'regime':
        displayRegime(msg.data);
        break;
      case 'hypothesisCreated':
        addHypothesis(msg.data);
        break;
      case 'hypothesisResolved':
        updateHypothesis(msg.data);
        break;
      case 'knowledge':
        displayKnowledge(msg.data);
        break;
      case 'decision':
        displayDecision(msg.data);
        break;
      case 'marketClosed':
        displayMarketClosed(msg.data);
        break;
      case 'metrics':
        displayMetrics(msg.data);
        break;
      case 'tradeClosed':
        // Optionally refresh trades
        if (typeof loadOpenTrades === 'function') loadOpenTrades();
        if (typeof loadTradeHistory === 'function') loadTradeHistory();
        break;
      default:
        console.debug('[Live] Unknown message type:', msg.type);
    }
  }

  function displayAwareness(data) {
    if (!awarenessPanel) return;
    const { symbol, spread, velocity, acceleration, liquidity, unusualEvents, lastUpdated } = data;
    const events = unusualEvents ? unusualEvents.join(', ') : 'None';
    awarenessPanel.innerHTML = `
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

  function addHypothesis(hypothesis) {
    if (!hypothesisPanel) return;
    const { id, symbol, type, status, createdAt } = hypothesis;
    const el = document.createElement('div');
    el.className = 'alert alert-info hypothesis-item';
    el.dataset.id = id;
    el.innerHTML = `
      <strong>Hypothesis #${id}</strong> (${symbol})<br>
      Type: ${type}<br>
      Status: ${status}<br>
      Created: ${new Date(createdAt).toLocaleString()}
    `;
    hypothesisPanel.prepend(el);
    // Keep only last 10 hypotheses
    while (hypothesisPanel.children.length > 10) {
      hypothesisPanel.removeChild(hypothesisPanel.lastChild);
    }
  }

  function updateHypothesis(hypothesis) {
    if (!hypothesisPanel) return;
    const { id, status, outcome, resolvedAt } = hypothesis;
    const items = hypothesisPanel.querySelectorAll(`.hypothesis-item[data-id="${id}"]`);
    if (items.length > 0) {
      const el = items[0];
      const statusClass = status === 'confirmed' ? 'success' : (status === 'rejected' ? 'danger' : 'secondary');
      el.className = `alert alert-${statusClass} hypothesis-item`;
      el.innerHTML = `
        <strong>Hypothesis #${id}</strong> (${hypothesis.symbol})<br>
        Type: ${hypothesis.type}<br>
        Status: <strong>${status}</strong> (conf: ${outcome?.confidence || 0}%)<br>
        Resolved: ${new Date(resolvedAt).toLocaleString()}
      `;
    }
  }

  function displayKnowledge(knowledge) {
    if (!knowledgePanel) return;
    const { symbol, indicator, valueRange, outcome, confidence, lastUpdated } = knowledge;
    knowledgePanel.innerHTML = `
      <div class="card">
        <div class="card-body">
          <h6 class="card-title">Knowledge (${symbol})</h6>
          <p>${indicator} ${valueRange} → ${outcome}</p>
          <p>Confidence: ${(confidence * 100).toFixed(0)}%</p>
          <p class="small text-muted">${new Date(lastUpdated).toLocaleString()}</p>
        </div>
      </div>
    `;
  }

  // Display decision (from fusion or future decision engine)
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
    if (side && side !== 'NO_TRADE') {
      if (typeof playSound === 'function') playSound('signal');
    }
  }

  function displayMarketClosed(data) {
    if (!liveSignalPanel) return;
    liveSignalPanel.innerHTML = `
      <div class="alert alert-warning">
        <h5><i class="fas fa-hourglass-end"></i> Market Closed</h5>
        <p>${data.reason}</p>
        <p><strong>Next open:</strong> ${data.nextOpen ? new Date(data.nextOpen).toLocaleString() : 'Unknown'}</p>
      </div>
    `;
  }

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

  function formatPrice(p) {
    if (p === undefined || p === null) return 'N/A';
    return parseFloat(p).toFixed(5);
  }

  // Global execute trade function (same as before)
  window.executeSignalFromCard = function(btn) {
    const card = btn.closest('.live-signal-card');
    if (!card) return;
    const symbol = card.dataset.symbol;
    const side = card.dataset.side;
    const entry = parseFloat(card.dataset.entry);
    const sl = parseFloat(card.dataset.sl) || null;
    const tp = parseFloat(card.dataset.tp) || null;
    const lot = parseFloat(card.dataset.lot) || 0.01;
    if (typeof window.fillTradeForm === 'function') {
      window.fillTradeForm(symbol, side, entry, sl, tp, lot);
    } else {
      alert('Trade form fill function not available.');
    }
  };

  connectWebSocket();
  window.reconnectLive = function() {
    if (ws) ws.close();
    reconnectAttempts = 0;
    connectWebSocket();
  };
})();
