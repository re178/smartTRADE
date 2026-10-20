// public/js/live.js – WebSocket dispatcher
// All state updates go through window.updateDashboardState (app.js renders).
// Only contractUpdate, price, positions, and account bypass full-rerender
// for performance — they call targeted render functions from app.js.
//
// [FIX-1] case 'contractUpdate' — the missing handler that was keeping
//   the dashboard frozen. Merges live tick into dashboardState.positions,
//   stores state in dashboardState.contractStates, then repaints only the
//   positions widget and the monitor line (not all 16 widgets).
// [FIX-2] Removed local updatePositions() / updateAccount() renderers.
//   app.js is the single renderer.
// [FIX-3] Removed displayAwareness / displayRegime / displayMetrics /
//   displayFusion — app.js renders those panels via its widget functions.
// [FIX-4] Removed executeSignalFromCard — app.js owns it.
// [FIX-5] init case no longer writes msg.data.trades into history (that
//   field is OPEN trades on the server; history comes from /api/trade-history).
// [FIX-6] Auto-execute block honours the new controller response shape and
//   never retries on BROKER_ERROR.

(function () {
  'use strict';

  const WS_RECONNECT_DELAY = 2000;
  const WS_MAX_RECONNECT_DELAY = 30000;
  const HEARTBEAT_INTERVAL = 25000;

  let reconnectAttempts = 0;
  let ws = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let _autoExecuting = false;

  function updateWsStatus(connected) {
    const el = document.getElementById('wsStatus');
    if (el) {
      el.textContent = connected ? '🟢 Live' : '🔴 Disconnected';
      el.className = connected ? 'badge bg-success' : 'badge bg-danger';
    }
    if (window.updateApiStatus) window.updateApiStatus(connected);
  }

  function playSound(type) {
    if (window.SoundManager && typeof window.SoundManager[type] === 'function') {
      window.SoundManager[type]();
    }
  }

  function formatSymbol(s) {
    if (!s || typeof s !== 'string') return s;
    const u = s.toUpperCase().trim();
    return (u.length === 6 && /^[A-Z]{6}$/.test(u)) ? u.slice(0, 3) + '_' + u.slice(3) : u;
  }
  function formatPrice(p) {
    if (p === undefined || p === null) return 'N/A';
    return parseFloat(p).toFixed(5);
  }

  function state() { return window.dashboardState || null; }

  function connectWebSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    const wsUrl = CONFIG.WS_URL;
    console.log('[Live] Connecting:', wsUrl);
    try { ws = new WebSocket(wsUrl); }
    catch (e) { console.error('[Live] Creation failed:', e); scheduleReconnect(); return; }

    ws.onopen = function () {
      console.log('[Live] Connected.');
      reconnectAttempts = 0;
      updateWsStatus(true);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, HEARTBEAT_INTERVAL);
    };

    ws.onmessage = function (event) {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
        handleMessage(msg);
      } catch (e) { console.error('[Live] Parse error:', e); }
    };

    ws.onclose = function (event) {
      console.warn('[Live] Closed.', event.code);
      updateWsStatus(false);
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (event.code !== 1000) scheduleReconnect();
    };

    ws.onerror = function (err) { console.error('[Live] Error:', err); };
  }

  function scheduleReconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const delay = Math.min(WS_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts), WS_MAX_RECONNECT_DELAY);
    reconnectAttempts++;
    reconnectTimer = setTimeout(connectWebSocket, delay);
  }

  // ============================================================
  //  [FIX-1] Per-contract live tick
  // ============================================================
  function handleContractUpdate(cu) {
    const s = state();
    if (!s || !cu) return;
    const contractId = String(cu.contractId || '');
    if (!contractId) return;

    // Store latest state
    if (!s.contractStates) s.contractStates = {};
    s.contractStates[contractId] = cu;
    s.lastContractUpdateAt = cu.receivedAt || Date.now();

    const positions = s.positions || [];
    const idx = positions.findIndex(p => String(p.id ?? p.contractId) === contractId);
    const isClosed = !!(cu.isSold || cu.isExpired);

    if (idx >= 0) {
      if (isClosed) {
        // Settlement arrived — drop from positions
        positions.splice(idx, 1);
      } else {
        // Merge latest values in place
        positions[idx] = {
          ...positions[idx],
          currentPrice: cu.currentSpot != null ? cu.currentSpot : positions[idx].currentPrice,
          unrealizedPL: cu.currentProfit != null ? cu.currentProfit : positions[idx].unrealizedPL,
          isValidToSell: cu.isValidToSell,
          contractStatus: cu.status,
          lastUpdate: cu.receivedAt,
        };
      }
    } else if (!isClosed) {
      // First tick before a positions snapshot — synthesize an entry
      const ct = String(cu.contractType || '').toUpperCase();
      positions.push({
        id: contractId,
        contractId,
        instrument: cu.symbol || 'UNKNOWN',
        side: ct.includes('UP') ? 'BUY' : (ct.includes('DOWN') ? 'SELL' : 'UNKNOWN'),
        price: cu.entrySpot ?? 0,
        entryPrice: cu.entrySpot ?? null,
        purchasePrice: cu.buyPrice ?? null,
        currentPrice: cu.currentSpot ?? 0,
        unrealizedPL: cu.currentProfit ?? 0,
        units: cu.buyPrice ?? 0,
        status: 'OPEN',
        isValidToSell: cu.isValidToSell,
        lastUpdate: cu.receivedAt,
      });
    } else {
      // Closed contract we never saw open — nothing to do
      return;
    }

    s.positions = positions;

    // [FIX-1] Targeted repaint — do NOT call updateDashboardState (would
    // rerender all 16 widgets every tick). app.js exposes these on window.
    if (typeof window.renderPositionsWidget === 'function') window.renderPositionsWidget();
    if (typeof window.renderLiveMonitorStatus === 'function') window.renderLiveMonitorStatus();
  }

  // ============================================================
  //  Main dispatch
  // ============================================================
  function handleMessage(msg) {
    switch (msg.type) {

      // ============================================================
      // [FIX-1] Live per-contract tick — the missing handler
      // ============================================================
      case 'contractUpdate':
        handleContractUpdate(msg.data || {});
        break;

      // ============================================================
      // Prediction / Opportunity
      // ============================================================
      case 'prediction':
        if (window.updateDashboardState) window.updateDashboardState({ prediction: msg.data });
        break;

      case 'opportunity':
        if (window.updateDashboardState) window.updateDashboardState({ opportunity: msg.data });
        maybeAutoExecute(msg.data);
        break;

      // ============================================================
      // Intelligence feeds — dispatched to updateDashboardState;
      // app.js render*Widget functions paint them.
      // ============================================================
      case 'marketAwareness':
        if (window.updateDashboardState) window.updateDashboardState({ awareness: msg.data });
        break;
      case 'regime':
        if (window.updateDashboardState) window.updateDashboardState({ regime: msg.data });
        break;
      case 'fusion':
        if (window.updateDashboardState) window.updateDashboardState({ fusion: msg.data });
        break;
      case 'metrics':
        if (window.updateDashboardState) window.updateDashboardState({ metrics: msg.data });
        break;
      case 'decision':
        displayDecision(msg.data);
        if (window.updateDashboardState) window.updateDashboardState({ liveSignal: msg.data });
        break;

      // ============================================================
      // OTIE — app.js has no render widget for #otieContent, so
      // live.js owns these two.
      // ============================================================
      case 'otieV5State':
        displayOTIEState(msg.data);
        break;
      case 'otieV5Action':
        displayOTIEAction(msg.data);
        break;

      // ============================================================
      // Order / trade events
      // ============================================================
      case 'tradeClosed': {
        const s = state();
        if (s && s.positions) {
          const cid = String(msg.data.contractId);
          s.positions = s.positions.filter(p => String(p.id ?? p.contractId) !== cid);
          if (typeof window.renderPositionsWidget === 'function') window.renderPositionsWidget();
        }
        playSound('tradeClose');
        break;
      }
      case 'trade.placed':
        playSound('tradeOpen');
        break;

      // ============================================================
      // [FIX-5] init — do NOT touch history
      // ============================================================
      case 'init': {
        const s = state();
        if (!s) break;
        s.account = msg.data.account || s.account;
        if (Array.isArray(msg.data.positions)) s.positions = msg.data.positions;
        // history intentionally untouched — /api/trade-history owns it
        if (typeof window.renderAccountWidget === 'function') window.renderAccountWidget();
        if (typeof window.renderPositionsWidget === 'function') window.renderPositionsWidget();
        break;
      }

      case 'positions': {
        const s = state();
        if (!s) break;
        s.positions = Array.isArray(msg.data) ? msg.data : [];
        if (typeof window.renderPositionsWidget === 'function') window.renderPositionsWidget();
        break;
      }

      case 'account': {
        const s = state();
        if (!s) break;
        s.account = msg.data;
        if (typeof window.renderAccountWidget === 'function') window.renderAccountWidget();
        break;
      }

      case 'price': {
        const s = state();
        if (!s || !msg.data) break;
        if (!s.prices) s.prices = {};
        s.prices[msg.data.symbol] = msg.data;
        if (typeof window.renderPriceWidgets === 'function') window.renderPriceWidgets();
        break;
      }

      case 'positionUpdated':
        // No-op — 'positions' and 'contractUpdate' handle position state
        break;

      default:
        console.debug('[Live] Unhandled:', msg.type);
    }
  }

  // ============================================================
  // [FIX-6] Auto-execute — status-aware, never retries on error
  // ============================================================
  function maybeAutoExecute(opp) {
    if (!opp || !opp.tradable) return;
    const toggle = document.getElementById('autoExecuteToggle');
    if (!toggle || !toggle.checked) return;
    if (_autoExecuting) return;

    _autoExecuting = true;
    console.log('[Live] Auto-executing opportunity:', opp.direction, opp.prediction?.symbol);

    fetch((CONFIG.API_BASE || '') + '/api/trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pair: opp.prediction?.symbol || 'EUR_USD',
        side: opp.direction,
        stake: opp.stake,
        multiplier: opp.multiplier,
        duration: opp.duration,
        knockoutLevel: opp.knockoutLevel,
        takeProfitLevel: opp.takeProfitLevel,
        product: 'deriv_cfd',
      }),
    })
      .then(r => r.json().then(b => ({ status: r.status, body: b })).catch(() => ({ status: r.status, body: {} })))
      .then(({ status, body }) => {
        if (body.status === 'FILLED') {
          playSound('tradeOpen');
          console.log('[Live] Auto-trade placed:', body.contractId);
        } else if (body.status === 'CONFIRMED_RECORD_FAILED') {
          console.warn('[Live] Auto-trade confirmed but not recorded:', body.contractId, '— DO NOT retry');
        } else if (body.status === 'REJECTED') {
          playSound('reject');
          console.log('[Live] Auto-trade rejected:', body.error);
        } else {
          // BROKER_ERROR or network — do NOT retry
          console.error('[Live] Auto-trade broker error — do not retry:', body.error || status);
        }
      })
      .catch(err => {
        console.error('[Live] Auto-trade network error — do not retry:', err);
        playSound('reject');
      })
      .finally(() => { _autoExecuting = false; });
  }

  // ============================================================
  // Display functions owned by live.js (panels app.js doesn't render)
  // ============================================================
  function displayDecision(d) {
    const panel = document.getElementById('liveSignalPanel');
    if (!panel) return;
    const decisionId = d.decisionId || d._id || d.id;
    playSound('signal');

    if (!d.decision || d.decision === 'NO_TRADE') {
      panel.innerHTML = `<div class="alert alert-secondary">
        <h5>No Trade</h5>
        <p>${d.reason || 'No opportunity.'}</p>
        <p class="text-muted small">${d.timestamp ? new Date(d.timestamp).toLocaleString() : ''}</p>
      </div>`;
      return;
    }

    const side = d.decision;
    const sym = formatSymbol(d.symbol);
    panel.innerHTML = `<div class="live-signal-card ${side.toLowerCase()}"
        data-symbol="${sym}"
        data-side="${side}"
        data-entry="${d.entryPrice}"
        data-sl="${d.stopLoss}"
        data-tp="${d.takeProfit}"
        data-decision-id="${decisionId}">
      <h5><strong>${side}</strong> ${sym} (${d.confidence}% confidence)</h5>
      <p>Entry: ${formatPrice(d.entryPrice)} | SL: ${formatPrice(d.stopLoss)} | TP: ${formatPrice(d.takeProfit)}</p>
      <p><small>${d.reason || ''}</small></p>
      <button class="btn btn-sm btn-primary" onclick="window.executeSignalFromCard(this)">
        <i class="fas fa-rocket"></i> Execute Trade
      </button>
      <p class="text-muted small mt-2">${d.timestamp ? new Date(d.timestamp).toLocaleString() : ''}</p>
    </div>`;
  }

  function displayOTIEState(data) {
    const content = document.getElementById('otieContent');
    if (!content || !data) return;
    const div = document.createElement('div');
    div.className = 'alert alert-info alert-dismissible fade show';
    div.innerHTML = `<strong>OTIE:</strong> ${data.symbol || '?'} (${data.tradeId || '?'}) — profit ${data.profitR?.toFixed(2) ?? '?'}R, action ${data.bestAction || '?'}
      <button type="button" class="btn-close" data-bs-dismiss="alert"></button>`;
    content.prepend(div);
    setTimeout(() => div.remove(), 8000);
  }

  function displayOTIEAction(data) {
    const content = document.getElementById('otieContent');
    if (!content || !data) return;
    const div = document.createElement('div');
    div.className = 'alert alert-warning alert-dismissible fade show';
    div.innerHTML = `<strong>OTIE Action:</strong> ${data.action} on ${data.tradeId}
      <button type="button" class="btn-close" data-bs-dismiss="alert"></button>`;
    content.prepend(div);
    setTimeout(() => div.remove(), 8000);
  }

  connectWebSocket();

  window.reconnectLive = function () {
    if (ws) ws.close();
    reconnectAttempts = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    connectWebSocket();
  };
})();
