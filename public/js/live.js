// public/js/live.js – WebSocket dispatcher
// All state updates flow through window.updateDashboardState (app.js).
// contractUpdate / otieState / price / positions / account use targeted
// repaint hooks so live ticks don't rerender every widget.

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
  //  Per-contract live tick
  // ============================================================
  function handleContractUpdate(cu) {
    const s = state();
    if (!s || !cu) return;
    const contractId = String(cu.contractId || '');
    if (!contractId) return;

    if (!s.contractStates) s.contractStates = {};
    s.contractStates[contractId] = cu;
    s.lastContractUpdateAt = cu.receivedAt || Date.now();

    const positions = s.positions || [];
    const idx = positions.findIndex(p => String(p.id ?? p.contractId) === contractId);
    const isClosed = !!(cu.isSold || cu.isExpired);

    if (idx >= 0) {
      if (isClosed) {
        positions.splice(idx, 1);
      } else {
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
    }

    // If contract closed, also clear any OTIE state for it
    if (isClosed && s.otieStates && s.otieStates[contractId]) {
      delete s.otieStates[contractId];
      if (typeof window.renderOTIEPanel === 'function') window.renderOTIEPanel();
    }

    s.positions = positions;

    if (typeof window.renderPositionsWidget === 'function') window.renderPositionsWidget();
    if (typeof window.renderLiveMonitorStatus === 'function') window.renderLiveMonitorStatus();
  }

  // ============================================================
  //  OTIE trajectory update
  // ============================================================
  function handleOtieState(payload) {
    if (!payload || !payload.tradeId) return;
    if (typeof window.onOtieState === 'function') {
      window.onOtieState(payload);
    } else {
      const s = state();
      if (!s) return;
      if (!s.otieStates) s.otieStates = {};
      if (payload.action === 'RELEASED') {
        delete s.otieStates[payload.tradeId];
      } else {
        s.otieStates[payload.tradeId] = payload;
      }
      if (typeof window.renderOTIEPanel === 'function') window.renderOTIEPanel();
      if (typeof window.renderPositionsWidget === 'function') window.renderPositionsWidget();
    }
  }

  // ============================================================
  //  Main dispatch
  // ============================================================
  function handleMessage(msg) {
    switch (msg.type) {

      case 'contractUpdate':
        handleContractUpdate(msg.data || {});
        break;

      case 'otieState':
        handleOtieState(msg.data);
        break;

      case 'strategyConsensus':
        if (typeof window.onStrategyConsensus === 'function') window.onStrategyConsensus(msg.data);
        break;

      case 'prediction':
        if (typeof window.onPredictionUpdate === 'function') window.onPredictionUpdate(msg.data);
        if (typeof window.onPredictionUpdate_tv === 'function') window.onPredictionUpdate_tv(msg.data);
        if (window.updateDashboardState) window.updateDashboardState({ prediction: msg.data });
        break;

      case 'opportunity':
        if (typeof window.onOpportunityUpdate === 'function') window.onOpportunityUpdate(msg.data);
        if (window.updateDashboardState) window.updateDashboardState({ opportunity: msg.data });
        maybeAutoExecute(msg.data);
        break;

      case 'digitUpdate':
        if (typeof window.onDigitUpdate === 'function') window.onDigitUpdate(msg.data);
        break;

      case 'digitSignal':
        // Silent — digit bots handle their own entries
        break;

      case 'botStarted':
      case 'botStopped':
      case 'botEntry':
      case 'botResult':
      case 'botError':
      case 'botCycle':
        if (typeof window.onBotEvent === 'function') window.onBotEvent(msg.type, msg.data);
        break;

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

      case 'otieV5State':
        displayOTIEState(msg.data);
        break;

      case 'otieV5Action':
        displayOTIEAction(msg.data);
        break;

      case 'tradeClosed': {
        const s = state();
        if (s) {
          const cid = String(msg.data?.contractId || '');
          if (s.positions) {
            s.positions = s.positions.filter(p => String(p.id ?? p.contractId) !== cid);
          }
          if (s.otieStates && s.otieStates[cid]) {
            delete s.otieStates[cid];
          }
          if (typeof window.renderPositionsWidget === 'function') window.renderPositionsWidget();
          if (typeof window.renderOTIEPanel === 'function') window.renderOTIEPanel();
        }
        playSound('tradeClose');
        break;
      }

      case 'trade.placed':
        playSound('tradeOpen');
        break;

      case 'init': {
        const s = state();
        if (!s) break;
        s.account = msg.data.account || s.account;
        if (Array.isArray(msg.data.positions)) s.positions = msg.data.positions;

        if (msg.data.otieStates && typeof msg.data.otieStates === 'object') {
          if (!s.otieStates) s.otieStates = {};
          for (const [cid, st] of Object.entries(msg.data.otieStates)) {
            s.otieStates[cid] = st;
          }
        }

        if (msg.data.strategyConsensus) Object.assign(s.strategyConsensus, msg.data.strategyConsensus);
        if (msg.data.runningBots) s.runningBots = msg.data.runningBots;
        if (msg.data.digitViews) Object.assign(s.digitViews, msg.data.digitViews);

        if (typeof window.renderAllWidgets === 'function') window.renderAllWidgets();
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
        if (typeof window.onPriceTick === 'function') window.onPriceTick(msg.data);
        break;
      }

      case 'history': {
        const s = state();
        if (s) {
          s.history = Array.isArray(msg.data) ? msg.data : [];
          if (typeof window.renderHistoryWidget === 'function') window.renderHistoryWidget();
        }
        break;
      }

      case 'order.rejected': {
        playSound('reject');
        console.log('[Live] Order rejected:', msg.data?.reason || msg.data);
        break;
      }

      case 'positionUpdated':
        break;

      default:
        console.debug('[Live] Unhandled:', msg.type);
    }
  }

  // ============================================================
  //  Auto-execute — status-aware, never retries on error
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
        strategy: opp.strategyInfo?.anchorStrategy || null,
        regimeCode: opp.prediction?.regime || null,
      }),
    })
      .then(r => r.json().then(b => ({ status: r.status, body: b })).catch(() => ({ status: r.status, body: {} })))
      .then(({ status, body }) => {
        if (body.status === 'FILLED') {
          playSound('tradeOpen');
          console.log('[Live] Auto-trade placed:', body.contractId);
        } else if (body.status === 'CONFIRMED_RECORD_FAILED') {
          console.warn('[Live] Auto-trade confirmed but not recorded:', body.contractId);
        } else if (body.status === 'REJECTED') {
          playSound('reject');
          console.log('[Live] Auto-trade rejected:', body.error);
        } else {
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
  //  Legacy display functions
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
    div.innerHTML = `<strong>OTIE Action:</strong> ${data.action} on ${data.tradeId}` +
      (data.reason ? ` — ${data.reason}` : '') +
      `<button type="button" class="btn-close" data-bs-dismiss="alert"></button>`;
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
