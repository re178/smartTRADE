// public/js/live.js – WebSocket client with stable connection and heartbeat
// Real‑time events: marketAwareness, regime, decision, fusion, otieV5State, otieV5Action, init, account, positions, price, etc.
// No API key required – connects directly to the server.

(function() {
  'use strict';

  const WS_RECONNECT_DELAY = 2000;
  const WS_MAX_RECONNECT_DELAY = 30000;
  const HEARTBEAT_INTERVAL = 25000; // send ping every 25s

  let reconnectAttempts = 0;
  let ws = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;

  // DOM elements (these exist in index.html)
  const awarenessPanel = document.getElementById('awarenessPanel');
  const hypothesisPanel = document.getElementById('hypothesisPanel');
  const knowledgePanel = document.getElementById('knowledgePanel');
  const liveSignalPanel = document.getElementById('liveSignalPanel');
  const regimePanel = document.getElementById('regimePanel');
  const metricsPanel = document.getElementById('metricsPanel');
  const fusionPanel = document.getElementById('fusionPanel');
  const wsStatus = document.getElementById('wsStatus');
  const otieContent = document.getElementById('otieContent');

  // ---- SoundManager (global from app.js) ----
  function playSound(type) {
    if (window.SoundManager && typeof window.SoundManager[type] === 'function') {
      window.SoundManager[type]();
    } else {
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

  function formatPrice(p) {
    if (p === undefined || p === null) return 'N/A';
    return parseFloat(p).toFixed(5);
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
    // If there's an existing connection, close it first
    if (ws && ws.readyState === WebSocket.OPEN) {
      return;
    }

    // Use the WebSocket URL from config (auto-detected)
    const wsUrl = CONFIG.WS_URL;
    console.log('[Live] Connecting to WebSocket:', wsUrl);

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
      // Start heartbeat
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
    };

    ws.onmessage = function(event) {
      try {
        const msg = JSON.parse(event.data);
        // Respond to server ping with pong (if needed)
        if (msg.type === 'ping') {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
          return;
        }
        handleMessage(msg);
      } catch (e) {
        console.error('[Live] Message parse error:', e);
      }
    };

    ws.onclose = function(event) {
      console.warn('[Live] WebSocket closed.', event.code, event.reason);
      updateWsStatus(false);
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      // Only reconnect if the close was not intentional (no reconnect if code 1000)
      if (event.code !== 1000) {
        scheduleReconnect();
      }
    };

    ws.onerror = function(err) {
      console.error('[Live] WebSocket error:', err);
      // ws will close after error, so onclose will handle reconnect
    };
  }

  function sendHeartbeat() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const delay = Math.min(WS_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts), WS_MAX_RECONNECT_DELAY);
    reconnectAttempts++;
    console.log(`[Live] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
    reconnectTimer = setTimeout(function() {
      connectWebSocket();
    }, delay);
  }

  // ============================================================
  //  MAIN MESSAGE HANDLER – UPDATED WITH STATE STORE
  // ============================================================
  function handleMessage(msg) {
    // Update state store and render all widgets
    switch (msg.type) {
      case 'marketAwareness':
        displayAwareness(msg.data);
        if (window.updateDashboardState) {
          window.updateDashboardState({ awareness: msg.data });
        }
        break;

      case 'regime':
        displayRegime(msg.data);
        if (window.updateDashboardState) {
          window.updateDashboardState({ regime: msg.data });
        }
        break;

      case 'decision':
        displayDecision(msg.data);
        if (window.updateDashboardState) {
          window.updateDashboardState({ liveSignal: msg.data });
        }
        break;

      case 'fusion':
        displayFusion(msg.data);
        if (window.updateDashboardState) {
          window.updateDashboardState({ fusion: msg.data });
        }
        break;

      case 'metrics':
        displayMetrics(msg.data);
        if (window.updateDashboardState) {
          window.updateDashboardState({ metrics: msg.data });
        }
        break;

      case 'otieV5State':
        displayOTIEState(msg.data);
        if (window.updateDashboardState) {
          const currentOTIE = (window.dashboardState?.otieDecisions) || [];
          currentOTIE.unshift(msg.data);
          if (currentOTIE.length > 20) currentOTIE.pop();
          window.updateDashboardState({ otieDecisions: currentOTIE });
        }
        break;

      case 'otieV5Action':
        displayOTIEAction(msg.data);
        if (window.updateDashboardState) {
          const currentActions = (window.dashboardState?.otieActions) || [];
          currentActions.unshift(msg.data);
          if (currentActions.length > 20) currentActions.pop();
          window.updateDashboardState({ otieActions: currentActions });
        }
        break;

      case 'tradeClosed': {
        if (window.updateDashboardState) {
          const closedId = msg.data.contractId;
          const currentPositions = (window.dashboardState?.positions) || [];
          const updatedPositions = currentPositions.filter(p => p.id !== closedId);
          window.updateDashboardState({ positions: updatedPositions });
        }
        // Show notification if available
        if (typeof addNotification === 'function') addNotification('Trade closed', 'info');
        playSound('tradeClose');
        break;
      }

      case 'trade.placed': {
        playSound('tradeOpen');
        if (typeof addNotification === 'function') addNotification('Trade opened', 'success');
        break;
      }

      case 'order.rejected':
        playSound('reject');
        if (typeof addNotification === 'function') addNotification('Order rejected: ' + (msg.data.reason || ''), 'danger');
        break;

      case 'init': {
        if (window.updateDashboardState) {
          window.updateDashboardState({
            account: msg.data.account,
            positions: msg.data.positions,
            history: msg.data.trades || [],
          });
        }
        if (msg.data.account) updateAccount(msg.data.account);
        if (msg.data.positions) updatePositions(msg.data.positions);
        if (msg.data.trades && typeof renderHistoryTable === 'function') renderHistoryTable();
        break;
      }

      case 'positions': {
        updatePositions(msg.data);
        if (window.updateDashboardState) {
          window.updateDashboardState({ positions: msg.data });
        }
        break;
      }

      case 'account': {
        updateAccount(msg.data);
        if (window.updateDashboardState) {
          window.updateDashboardState({ account: msg.data });
        }
        break;
      }

      case 'price': {
        if (window.updateDashboardState) {
          const symbol = msg.data.symbol;
          const currentPrices = (window.dashboardState?.prices) || {};
          currentPrices[symbol] = msg.data;
          window.updateDashboardState({ prices: currentPrices });
        }
        break;
      }

      case 'positionUpdated':
        // Could update positions if needed – currently handled by 'positions'
        break;

      default:
        console.debug('[Live] Unknown message type:', msg.type);
    }
  }

  // ============================================================
  //  DISPLAY FUNCTIONS (Direct DOM updates)
  // ============================================================

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

  function displayDecision(decision) {
    if (!liveSignalPanel) return;
    const decisionId = decision.decisionId || decision._id || decision.id;
    const { symbol, decision: side, confidence, entryPrice, stopLoss, takeProfit, recommendedLotSize, reason, timestamp } = decision;

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

    let html = `<div class="live-signal-card ${side.toLowerCase()}" data-symbol="${formattedSymbol}" data-side="${side}" data-entry="${entryPrice}" data-sl="${stopLoss}" data-tp="${takeProfit}" data-lot="${recommendedLotSize || 0.01}" data-decision-id="${decisionId}">`;
    html += `<h5><strong>${sideLabel}</strong> ${formattedSymbol} (${confidence}% confidence)</h5>`;
    if (side && side !== 'NO_TRADE') {
      html += `<p>Entry: ${formatPrice(entryPrice)} | SL: ${formatPrice(stopLoss)} | TP: ${formatPrice(takeProfit)}</p>`;
      html += `<p>Lot: ${recommendedLotSize || 'N/A'}</p>`;
      html += `<p><small>${reason || ''}</small></p>`;
      html += `<button class="btn btn-sm btn-primary execute-signal-btn" onclick="window.executeSignalFromCard(this)">`;
      html += `<i class="fas fa-rocket"></i> Execute Trade</button>`;
      if (decisionId) {
        html += `<button class="btn btn-sm btn-outline-info ms-2 explain-signal-btn" onclick="window.openDecisionInspector('${decisionId}')">`;
        html += `<i class="fas fa-info-circle"></i> Explain</button>`;
      }
    }
    html += `<p class="text-muted small mt-2">${new Date(timestamp).toLocaleString()}</p>`;
    html += `</div>`;
    liveSignalPanel.innerHTML = html;

    // Auto‑execute if toggle is on
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
    `;
    fusionPanel.innerHTML = html;
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

    otieContent.innerHTML = html + otieContent.innerHTML;
    const items = otieContent.querySelectorAll('.card');
    if (items.length > 10) {
      items[items.length - 1].remove();
    }
  }

  function displayOTIEAction(data) {
    if (!otieContent) return;
    const { tradeId, action, details, timestamp } = data;
    const alertDiv = document.createElement('div');
    alertDiv.className = 'alert alert-info alert-dismissible fade show';
    alertDiv.innerHTML = `
      <strong>Action Executed:</strong> ${action} on trade ${tradeId} - ${details.reason || ''}
      <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;
    otieContent.prepend(alertDiv);
    setTimeout(() => {
      if (alertDiv) alertDiv.remove();
    }, 5000);
  }

  // ---- Update functions for positions and account ----
  function updatePositions(positions) {
    console.log('[Live] Positions update:', positions);
    const badge = document.getElementById('positionCount');
    if (badge) badge.textContent = positions ? positions.length : 0;

    const container = document.getElementById('openTradesContainer');
    if (container) {
      if (!positions || positions.length === 0) {
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
  }

  function updateAccount(account) {
    console.log('[Live] Account update:', account);
    if (!account) return;
    const balance = typeof account.balance === 'number' ? account.balance : parseFloat(account.balance) || 0;
    const equity = typeof account.equity === 'number' ? account.equity : parseFloat(account.equity) || 0;
    const currency = account.currency || 'USD';

    document.getElementById('statBalance').textContent = `${balance} ${currency}`;
    document.getElementById('statEquity').textContent = `${equity} ${currency}`;

    if (window.updateAccountBadge) {
      window.updateAccountBadge(account);
    } else {
      const idEl = document.getElementById('accountId');
      const typeEl = document.getElementById('accountTypeLabel');
      const currencyEl = document.getElementById('accountCurrency');
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

  // ---- Execute signal from card ----
  window.executeSignalFromCard = function(btn) {
    const card = btn.closest('.live-signal-card');
    if (!card) return;
    const symbol = formatSymbol(card.dataset.symbol);
    const side = card.dataset.side;
    const entry = parseFloat(card.dataset.entry);
    const sl = parseFloat(card.dataset.sl) || null;
    const tp = parseFloat(card.dataset.tp) || null;
    const lot = parseFloat(card.dataset.lot) || 0.01;
    // Fill the trade form if available
    const pairInput = document.getElementById('tradePair');
    const sideSelect = document.getElementById('tradeSide');
    const lotInput = document.getElementById('tradeLot');
    const slInput = document.getElementById('tradeSL');
    const tpInput = document.getElementById('tradeTP');
    if (pairInput && sideSelect && lotInput) {
      pairInput.value = symbol;
      sideSelect.value = side;
      lotInput.value = lot;
      if (slInput) slInput.value = sl;
      if (tpInput) tpInput.value = tp;
      // Switch to trading tab
      const tradingTab = document.querySelector('.sidebar-nav .nav-item[data-section="trading"]');
      if (tradingTab) tradingTab.click();
    } else {
      alert('Trade form not available.');
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

  // Expose reconnect function
  window.reconnectLive = function() {
    if (ws) ws.close();
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connectWebSocket();
  };

})();
