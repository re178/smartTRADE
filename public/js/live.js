// public/js/live.js – Updated for CTOS Real-time Events with Sound Alerts and Fusion
// Added OTIE V5 state and action display

(function() {
  'use strict';

  const WS_RECONNECT_DELAY = 2000;
  const WS_MAX_RECONNECT_DELAY = 30000;
  let reconnectAttempts = 0;
  let ws = null;

  // DOM elements
  const awarenessPanel = document.getElementById('awarenessPanel');
  const hypothesisPanel = document.getElementById('hypothesisPanel');
  const knowledgePanel = document.getElementById('knowledgePanel');
  const liveSignalPanel = document.getElementById('liveSignalPanel');
  const regimePanel = document.getElementById('regimePanel');
  const metricsPanel = document.getElementById('metricsPanel');
  const fusionPanel = document.getElementById('fusionPanel');
  const wsStatus = document.getElementById('wsStatus');
  // OTIE V5 panel
  const otieContent = document.getElementById('otieContent');

  // ---- SoundManager (global from app.js) ----
  function playSound(type) {
    if (window.SoundManager && typeof window.SoundManager[type] === 'function') {
      window.SoundManager[type]();
    } else {
      // Fallback: play simple beep
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = type === 'tradeOpen' ? 600 : (type === 'reject' ? 300 : 800);
        gain.gain.value = 0.3;
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
      } catch (e) {}
    }
  }

  // ---- Helper: formatSymbol ----
  function formatSymbol(symbol) {
    if (!symbol || typeof symbol !== 'string') return symbol;
    const upper = symbol.toUpperCase().trim();
    if (upper.length === 6 && /^[A-Z]{6}$/.test(upper)) {
      return upper.slice(0, 3) + '_' + upper.slice(3);
    }
    return upper;
  }

  function updateWsStatus(connected) {
    if (wsStatus) {
      wsStatus.textContent = connected ? '🟢 Live' : '🔴 Disconnected';
      wsStatus.className = connected ? 'badge bg-success' : 'badge bg-danger';
    }
    if (window.updateApiStatus) {
      window.updateApiStatus(connected);
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
      case 'fusion':
        displayFusion(msg.data);
        break;
      case 'marketClosed':
        displayMarketClosed(msg.data);
        break;
      case 'metrics':
        displayMetrics(msg.data);
        break;
      // ---- OTIE V5 events ----
      case 'otieV5State':
        displayOTIEState(msg.data);
        break;
      case 'otieV5Action':
        displayOTIEAction(msg.data);
        break;
      case 'tradeClosed':
        if (typeof loadOpenTrades === 'function') loadOpenTrades();
        if (typeof loadTradeHistory === 'function') loadTradeHistory();
        if (typeof addNotification === 'function') addNotification('Trade closed', 'info');
        playSound('tradeClose');
        break;
      case 'trade.placed':
        if (typeof loadOpenTrades === 'function') loadOpenTrades();
        if (typeof loadTradeHistory === 'function') loadTradeHistory();
        playSound('tradeOpen');
        if (typeof addNotification === 'function') addNotification('Trade opened', 'success');
        break;
      case 'order.rejected':
        playSound('reject');
        if (typeof addNotification === 'function') addNotification('Order rejected: ' + (msg.data.reason || ''), 'danger');
        break;
      default:
        console.debug('[Live] Unknown message type:', msg.type);
    }
  }

  // ---- Display functions (existing) ----
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

  // ----- UPDATED: displayDecision with correct decisionId ----
  function displayDecision(decision) {
    if (!liveSignalPanel) return;
    // Extract decisionId from the payload (sent by selfLearner.recordDecision)
    const decisionId = decision.decisionId || decision._id || decision.id;
    const { symbol, decision: side, confidence, entryPrice, stopLoss, takeProfit, recommendedLotSize, reason, timestamp } = decision;

    // Play signal sound
    playSound('signal');

    if (!side || side === 'NO_TRADE') {
      liveSignalPanel.innerHTML = `
        <div class="alert alert-secondary">
          <h5>No Trade</h5>
          <p>${reason || 'No trading opportunity at this time.'}</p>
          <p class="text-muted small">${new Date(timestamp).toLocaleString()}</p>
        </div>
      `;
      return;
    }

    const alertClass = side === 'BUY' ? 'success' : 'danger';
    const sideLabel = side || 'NO TRADE';
    const formattedSymbol = formatSymbol(symbol);

    let html = `<div class="alert alert-${alertClass} live-signal-card" data-symbol="${formattedSymbol}" data-side="${side}" data-entry="${entryPrice}" data-sl="${stopLoss}" data-tp="${takeProfit}" data-lot="${recommendedLotSize || 0.01}" data-decision-id="${decisionId}">`;
    html += `<h5><strong>${sideLabel}</strong> ${formattedSymbol} (${confidence}% confidence)</h5>`;
    if (side && side !== 'NO_TRADE') {
      html += `<p>Entry: ${formatPrice(entryPrice)} | SL: ${formatPrice(stopLoss)} | TP: ${formatPrice(takeProfit)}</p>`;
      html += `<p>Lot: ${recommendedLotSize || 'N/A'}</p>`;
      html += `<p><small>${reason || ''}</small></p>`;
      html += `<button class="btn btn-sm btn-primary execute-signal-btn" onclick="window.executeSignalFromCard(this)">`;
      html += `<i class="fas fa-rocket"></i> Execute Trade</button>`;
      // ---- Explain button: only if decisionId is valid ----
      if (decisionId) {
        html += `<button class="btn btn-sm btn-outline-info ms-2 explain-signal-btn" onclick="window.openDecisionInspector('${decisionId}')">`;
        html += `<i class="fas fa-info-circle"></i> Explain</button>`;
      }
    }
    html += `<p class="text-muted small mt-2">${new Date(timestamp).toLocaleString()}</p>`;
    html += `</div>`;
    liveSignalPanel.innerHTML = html;

    // ---- Auto‑execute: if toggle is ON, send to /execute-signal ----
    const toggle = document.getElementById('autoExecuteToggle');
    if (toggle && toggle.checked && side && side !== 'NO_TRADE') {
      console.log('[Live] Auto‑executing signal for', formattedSymbol, side);
      fetch('/api/execute-signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pair: formattedSymbol,
          side: side,
          entryPrice: entryPrice,
          stopLoss: stopLoss,
          takeProfit: takeProfit,
          lotSize: recommendedLotSize || 0.01
        })
      })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          console.log('[Live] Auto‑executed trade:', data);
          if (typeof loadOpenTrades === 'function') loadOpenTrades();
          if (typeof loadTradeHistory === 'function') loadTradeHistory();
          if (typeof loadAccount === 'function') loadAccount();
          playSound('tradeOpen');
        } else {
          console.error('[Live] Auto‑execute failed:', data.error);
          playSound('reject');
        }
      })
      .catch(err => {
        console.error('[Live] Auto‑execute error:', err);
        playSound('reject');
      });
    }
  }

  // ---- Fusion display ----
  function displayFusion(fusion) {
    if (!fusionPanel) return;
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
      <div class="mt-2">
        <button class="btn btn-sm btn-outline-secondary" onclick="window.showTimeframeDetails('${symbol}')">
          <i class="fas fa-table"></i> Show Timeframe Details
        </button>
      </div>
    `;
    fusionPanel.innerHTML = html;
  }

  // ---- Placeholder for timeframe details (can be extended) ----
  window.showTimeframeDetails = function(symbol) {
    console.log('Fetch details for', symbol);
    alert('Timeframe details will be displayed here (to be implemented).');
  };

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

  // ---- OTIE V5 Display Functions ----
  function displayOTIEState(data) {
    if (!otieContent) return;
    const { tradeId, symbol, profitR, scores, prediction, stateProbs, bestAction, actions, timestamp } = data;

    let html = `
      <div class="card mb-2">
        <div class="card-header">
          <strong>${symbol} (${tradeId})</strong>
          <span class="badge bg-info float-end">Profit: ${profitR.toFixed(2)}R</span>
        </div>
        <div class="card-body">
          <div class="row">
            <div class="col-md-6">
              <h6>Trade State Probabilities</h6>
              <ul class="list-unstyled small">
                ${Object.entries(stateProbs).map(([state, prob]) => `
                  <li><span class="badge bg-secondary">${state}</span> ${(prob * 100).toFixed(1)}%</li>
                `).join('')}
              </ul>
            </div>
            <div class="col-md-6">
              <h6>Continuous Scores</h6>
              <ul class="list-unstyled small">
                <li>Health: ${scores.health?.toFixed(0) || 'N/A'}</li>
                <li>Trend Strength: ${scores.trendStrength?.toFixed(0) || 'N/A'}</li>
                <li>Momentum: ${scores.momentum?.toFixed(0) || 'N/A'}</li>
                <li>Liquidity: ${scores.liquidity?.toFixed(0) || 'N/A'}</li>
                <li>Opportunity: ${scores.opportunity?.toFixed(0) || 'N/A'}</li>
                <li>Risk: ${scores.risk?.toFixed(0) || 'N/A'}</li>
                <li>Confidence: ${scores.confidence?.toFixed(0) || 'N/A'}</li>
              </ul>
            </div>
          </div>
          <div class="row">
            <div class="col-12">
              <h6>Prediction</h6>
              <p class="small">Continuation: ${(prediction.continuationProbability * 100).toFixed(1)}% | Reversal: ${(prediction.reversalProbability * 100).toFixed(1)}% | Confidence: ${prediction.confidence.toFixed(0)}%</p>
            </div>
          </div>
          <div class="row">
            <div class="col-12">
              <h6>Best Action: <span class="badge bg-success">${bestAction}</span></h6>
              <ul class="list-unstyled small">
                ${(actions || []).map(a => `<li>${a.type}: EV ${a.ev.toFixed(3)} (conf ${a.confidence.toFixed(0)}%)</li>`).join('')}
              </ul>
            </div>
          </div>
          <p class="text-muted small">${new Date(timestamp).toLocaleString()}</p>
        </div>
      </div>
    `;

    // Prepend to keep latest on top
    otieContent.innerHTML = html + otieContent.innerHTML;
    // Limit to last 10 items to avoid clutter
    const items = otieContent.querySelectorAll('.card');
    if (items.length > 10) {
      items[items.length - 1].remove();
    }
  }

  function displayOTIEAction(data) {
    if (!otieContent) return;
    const { tradeId, action, details, timestamp } = data;
    // We can append a small notification or update the existing state card.
    // Since we already display the state, we can add a small badge or just log.
    // For simplicity, we'll add a small alert at the top of the OTIE panel.
    const alertDiv = document.createElement('div');
    alertDiv.className = 'alert alert-info alert-dismissible fade show';
    alertDiv.innerHTML = `
      <strong>Action Executed:</strong> ${action} on trade ${tradeId} - ${details.reason || ''}
      <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;
    otieContent.prepend(alertDiv);
    // Auto-dismiss after 5 seconds
    setTimeout(() => {
      if (alertDiv) alertDiv.remove();
    }, 5000);
  }

  function formatPrice(p) {
    if (p === undefined || p === null) return 'N/A';
    return parseFloat(p).toFixed(5);
  }

  window.executeSignalFromCard = function(btn) {
    const card = btn.closest('.live-signal-card');
    if (!card) return;
    const symbol = formatSymbol(card.dataset.symbol);
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

  // ---- Auto‑execute toggle: save state in localStorage ----
  document.addEventListener('DOMContentLoaded', function() {
    const toggle = document.getElementById('autoExecuteToggle');
    if (toggle) {
      const saved = localStorage.getItem('autoExecuteToggle');
      if (saved === 'true') toggle.checked = true;
      toggle.addEventListener('change', function() {
        localStorage.setItem('autoExecuteToggle', this.checked);
        console.log('[Live] Auto‑execute toggle:', this.checked ? 'ON' : 'OFF');
      });
    }
  });

  // Start WebSocket connection
  connectWebSocket();

  window.reconnectLive = function() {
    if (ws) ws.close();
    reconnectAttempts = 0;
    connectWebSocket();
  };
})();
