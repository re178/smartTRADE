// public/js/edge.js
// Edge Validation dashboard section.
// Wires buttons from #section-edge to /api/edge-test/* endpoints.
// Polls /status every 5s while test is running, renders progress + results.
//
// v3 additions:
//   • Progress list shows flip badge, phase PnL, flip count per bot
//   • Results table adds "Flip Effect" column (normal WR → flipped WR)
//   • Summary banner mentions flip successes/failures
//   • Tooltip on flip effect cell shows recent flip history
//   • Rows sorted by verdict, then PnL (best performers first)

'use strict';

(function () {
  const POLL_INTERVAL_MS = 5000;

  let _pollTimer = null;
  let _lastStatus = null;
  let _lastResults = null;

  // ============================================================
  // Helpers
  // ============================================================
  function fmtNum(n, digits = 2) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return v.toFixed(digits);
  }
  function fmtCurrency(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2);
  }
  function pnlClass(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v === 0) return 'text-muted';
    return v > 0 ? 'text-success fw-bold' : 'text-danger fw-bold';
  }
  function verdictClass(code) {
    switch (code) {
      case 'EDGE': return 'edge-verdict edge';
      case 'NO_EDGE': return 'edge-verdict no-edge';
      case 'NEED_MORE_DATA': return 'edge-verdict need-more-data';
      default: return 'edge-verdict pending';
    }
  }
  function verdictLabel(code) {
    switch (code) {
      case 'EDGE': return '✓ EDGE';
      case 'NO_EDGE': return '✗ NO EDGE';
      case 'NEED_MORE_DATA': return '… NEED MORE DATA';
      default: return code || '—';
    }
  }
  function getStakeInput() {
    const el = document.getElementById('edgeStake');
    const v = el ? Number(el.value) : 1;
    return Number.isFinite(v) && v > 0 ? v : 1;
  }
  function getTargetInput() {
    const el = document.getElementById('edgeTargetSample');
    const v = el ? Number(el.value) : 160;
    return Number.isFinite(v) && v >= 30 ? v : 160;
  }

  // ============================================================
  // API calls
  // ============================================================
  async function api(path, opts = {}) {
    const res = await fetch('/api/edge-test' + path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j.error) detail = j.error; } catch (_) {}
      throw new Error(detail);
    }
    return res.json();
  }

  // ============================================================
  // Actions
  // ============================================================
  async function startTest() {
    const stake = getStakeInput();
    const targetSample = getTargetInput();

    if (!confirm(
      `Start Edge Validation?\n\n` +
      `• Stake per trade: $${stake}\n` +
      `• Target: ${targetSample} closed trades per bot\n` +
      `• 17 bots will start immediately (real demo trades)\n\n` +
      `This can take hours. Bots will auto-stop at target sample.`
    )) return;

    setButtonsBusy(true);
    try {
      const result = await api('/start', {
        method: 'POST',
        body: JSON.stringify({ stake, targetSample }),
      });
      if (result.ok) {
        if (result.running) {
          alert(`Edge test started.\n${result.startedBots?.length || 0} bots running.`);
        } else {
          alert(result.message || 'Nothing to start — all bots already at target.');
        }
        await loadStatus();
        await loadResults();
        startPolling();
      } else {
        alert('Start failed: ' + (result.error || result.message || 'unknown'));
      }
    } catch (err) {
      alert('Start failed: ' + err.message);
    } finally {
      setButtonsBusy(false);
    }
  }

  async function startFresh() {
    if (!confirm(
      'START FRESH?\n\n' +
      'This will:\n' +
      '• Stop any running edge test\n' +
      '• Delete ALL edge test history from the database\n' +
      '• Start a new test immediately\n\n' +
      'This cannot be undone. Continue?'
    )) return;

    const stake = getStakeInput();
    const targetSample = getTargetInput();

    setButtonsBusy(true);
    stopPolling();
    try {
      const reset = await api('/reset-all', { method: 'DELETE' });
      console.log('[Edge] Reset complete:', reset);

      const result = await api('/start', {
        method: 'POST',
        body: JSON.stringify({ stake, targetSample }),
      });

      if (result.ok && result.running) {
        alert(`Fresh test started.\n${result.startedBots?.length || 0} bots running.\nDeleted ${reset.deletedCount || 0} old trades.`);
        await loadStatus();
        await loadResults();
        startPolling();
      } else {
        alert('Reset succeeded but start failed: ' + (result.error || result.message || 'unknown'));
        await loadStatus();
        await loadResults();
      }
    } catch (err) {
      alert('Start fresh failed: ' + err.message);
    } finally {
      setButtonsBusy(false);
    }
  }

  async function stopTest() {
    if (!confirm('Stop Edge Validation? Bots will halt but collected data is preserved.')) return;
    setButtonsBusy(true);
    try {
      const result = await api('/stop', { method: 'POST' });
      if (result.ok) {
        alert(`Stopped. ${result.stoppedCount || 0} bot instances halted.`);
        stopPolling();
        await loadStatus();
        await loadResults();
      } else {
        alert('Stop failed: ' + (result.error || 'unknown'));
      }
    } catch (err) {
      alert('Stop failed: ' + err.message);
    } finally {
      setButtonsBusy(false);
    }
  }

  async function exportCSV() {
    setButtonsBusy(true);
    try {
      const res = await fetch('/api/edge-test/export');
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j.error) detail = j.error; } catch (_) {}
        alert('Export failed: ' + detail);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `rts_edge_test_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Export failed: ' + err.message);
    } finally {
      setButtonsBusy(false);
    }
  }

  async function resetData() {
    if (!confirm(
      'Reset ALL Edge Validation data?\n\n' +
      'This will:\n' +
      '• Stop the test if it is running\n' +
      '• Delete every BotRun with isEdgeTest=true\n\n' +
      'Normal bot runs are NOT affected.\n' +
      'This cannot be undone.'
    )) return;

    setButtonsBusy(true);
    stopPolling();
    try {
      const result = await api('/reset-all', { method: 'DELETE' });
      if (result.ok) {
        alert(`Reset complete. Deleted ${result.deletedCount || 0} edge test records.`);
        await loadStatus();
        await loadResults();
      } else {
        alert('Reset failed: ' + (result.error || 'unknown'));
      }
    } catch (err) {
      alert('Reset failed: ' + err.message);
    } finally {
      setButtonsBusy(false);
    }
  }

  async function deleteBot(botId) {
    if (!confirm(
      `Delete all edge history for ${botId}?\n\n` +
      `• Its running instance (if any) will be stopped\n` +
      `• Its trades will be removed from the database\n` +
      `• Other bots are unaffected\n\n` +
      `Continue?`
    )) return;

    setButtonsBusy(true);
    try {
      const result = await api(`/bot/${encodeURIComponent(botId)}`, { method: 'DELETE' });
      if (result.ok) {
        console.log(`[Edge] Deleted ${result.deletedCount} trades for ${botId}`, result);
        await loadStatus();
        await loadResults();
      } else {
        alert('Delete failed: ' + (result.error || 'unknown'));
      }
    } catch (err) {
      alert('Delete failed: ' + err.message);
    } finally {
      setButtonsBusy(false);
    }
  }

  // ============================================================
  // Loaders
  // ============================================================
  async function loadStatus() {
    try {
      const status = await api('/status');
      _lastStatus = status;
      renderStatus(status);
      updateButtonStates(status);
      const el = document.getElementById('edgeLastRefresh');
      if (el) el.textContent = new Date().toLocaleTimeString();
    } catch (err) {
      console.warn('[Edge] status load failed:', err.message);
    }
  }

  async function loadResults() {
    try {
      const results = await api('/results');
      _lastResults = results;
      renderResults(results);
      renderRecommendations(results);
    } catch (err) {
      console.warn('[Edge] results load failed:', err.message);
    }
  }

  // ============================================================
  // Flip rendering helpers
  // ============================================================

  // Badge shown next to bot name in progress list.
  // Only shown if flipEnabled is true — otherwise no badge (flip not in play).
  function renderFlipBadge(bot) {
    if (!bot.flipEnabled) return '';
    if (bot.flipped) {
      return `<span class="badge bg-warning text-dark ms-1" title="Bot is betting the opposite direction" style="font-size:0.62rem;">FLIPPED</span>`;
    }
    return `<span class="badge bg-light text-muted ms-1" style="font-size:0.62rem;">NORMAL</span>`;
  }

  // Phase info line under each bot in progress list.
  // Only shown if flipEnabled.
  function renderPhaseLine(bot) {
    if (!bot.flipEnabled) return '';
    const phaseT = Number(bot.phaseTrades) || 0;
    const phaseP = Number(bot.phasePnl) || 0;
    const nT = Number(bot.normalTrades) || 0;
    const nP = Number(bot.normalPnl) || 0;
    const fT = Number(bot.flippedTrades) || 0;
    const fP = Number(bot.flippedPnl) || 0;
    const fc = Number(bot.flipCount) || 0;

    const parts = [];
    if (phaseT > 0) parts.push(`phase ${phaseT}t $${phaseP.toFixed(2)}`);
    if (nT > 0) parts.push(`normal ${nT}t $${nP.toFixed(2)}`);
    if (fT > 0) parts.push(`flipped ${fT}t $${fP.toFixed(2)}`);
    if (fc > 0) parts.push(`flips ${fc}`);

    if (parts.length === 0) return '';
    return `<div class="small text-muted mt-1" style="font-size:0.7rem;">
      <i class="fas fa-exchange-alt me-1"></i>${parts.join(' · ')}
    </div>`;
  }

  // "Flip Effect" cell in results table.
  // Shows normal WR → flipped WR with directional indicator.
  // Returns '—' if the bot never flipped (or has no data on either side).
  function renderFlipEffect(bot) {
    const n = bot.normal || { trades: 0, winRate: 0, pnl: 0 };
    const f = bot.flipped || { trades: 0, winRate: 0, pnl: 0 };

    // Never flipped (or flipped with no data yet)
    if (!f.trades || f.trades === 0) {
      if (n.trades > 0 && bot.flipEnabled === undefined) {
        // Legacy bots without flip config — show dash
        return `<span class="text-muted small">—</span>`;
      }
      return `<span class="text-muted small">—</span>`;
    }

    // Flipped data exists — show comparison
    const nWR = (n.winRate * 100).toFixed(1);
    const fWR = (f.winRate * 100).toFixed(1);
    const nP = Number(n.pnl) || 0;
    const fP = Number(f.pnl) || 0;
    const helped = fP > nP;
    const arrow = helped ? '↑' : '↓';
    const color = helped ? 'text-success' : 'text-danger';

    // Tooltip: recent flip history
    const live = bot.liveFlipState;
    let tooltip = `${n.trades} normal trades → ${f.trades} flipped trades\n`;
    tooltip += `Normal: ${nWR}% ($${nP.toFixed(2)})\n`;
    tooltip += `Flipped: ${fWR}% ($${fP.toFixed(2)})\n`;
    tooltip += helped ? 'Flip IMPROVED performance' : 'Flip HURT performance';
    if (live && Array.isArray(live.flipHistory) && live.flipHistory.length > 0) {
      tooltip += '\n\nRecent flips:';
      for (const h of live.flipHistory.slice(-3)) {
        tooltip += `\n@${h.atTrade}t ${h.from ? 'FLIP→NORMAL' : 'NORMAL→FLIP'}: ${h.reason}`;
      }
    }

    return `<span class="${color} fw-bold" title="${escapeHtml(tooltip)}" style="cursor:help; font-size:0.85rem;">
      ${nWR}% ${arrow} ${fWR}%
    </span>`;
  }

  // ============================================================
  // Renderers
  // ============================================================
  function renderStatus(status) {
    const badge = document.getElementById('edgeStatusBadge');
    if (badge) {
      if (status.running) {
        badge.textContent = 'Running';
        badge.className = 'badge bg-success';
      } else if (status.totalClosed > 0) {
        badge.textContent = 'Complete';
        badge.className = 'badge bg-primary';
      } else {
        badge.textContent = 'Idle';
        badge.className = 'badge bg-secondary';
      }
    }

    const progressText = document.getElementById('edgeProgressText');
    if (progressText) {
      progressText.textContent = `${status.totalClosed} / ${status.totalTarget} trades`;
    }

    const overallBar = document.getElementById('edgeOverallBar');
    if (overallBar) {
      const pct = Math.round((status.overallProgress || 0) * 100);
      overallBar.style.width = pct + '%';
      overallBar.className = 'edge-progress-bar' + (pct >= 100 ? ' done' : '');
    }

    const list = document.getElementById('edgeProgressList');
    if (!list) return;

    if (!status.bots || status.bots.length === 0) {
      list.innerHTML = '<p class="text-muted small">No bots available.</p>';
      return;
    }

    list.innerHTML = status.bots.map(b => {
      const pct = Math.round((b.progress || 0) * 100);
      const barClass = 'edge-progress-bar' + (pct >= 100 ? ' done' : '');

      const statusLine = b.running
        ? `<span class="text-success"><i class="fas fa-circle" style="font-size:0.5rem;"></i> running</span>`
        : b.stopped
          ? `<span class="text-primary"><i class="fas fa-check-circle"></i> done (${b.closedTrades})</span>`
          : `<span class="text-muted">idle</span>`;

      const flipBadge = renderFlipBadge(b);
      const phaseLine = renderPhaseLine(b);

      const reasonLine = b.lastReason
        ? `<div class="bot-meta text-truncate" style="max-width: 100%;">${escapeHtml(b.lastReason)}</div>`
        : '';

      return `<div class="edge-bot-row">
        <div class="d-flex justify-content-between align-items-start mb-1">
          <div>
            <span class="bot-name">${escapeHtml(b.name)}</span>
            <span class="bot-meta ms-2">${escapeHtml(b.assetClass)}</span>
            ${flipBadge}
          </div>
          <div class="small text-end">
            <span class="fw-bold">${b.closedTrades}</span>
            <span class="text-muted">/${b.targetSample}</span>
            <span class="ms-2">${statusLine}</span>
          </div>
        </div>
        <div class="edge-progress-wrap">
          <div class="${barClass}" style="width:${pct}%;"></div>
        </div>
        ${phaseLine}
        ${reasonLine}
      </div>`;
    }).join('');
  }

  function renderResults(results) {
    const banner = document.getElementById('edgeSummaryBanner');
    if (banner && results.summary) {
      const s = results.summary;

      // Count flip outcomes: how many bots were helped vs hurt by flipping
      let flipHelped = 0, flipHurt = 0, flipNeutral = 0;
      for (const b of (results.bots || [])) {
        const n = b.normal || { trades: 0 };
        const f = b.flipped || { trades: 0, pnl: 0 };
        const nPnl = Number((b.normal || {}).pnl) || 0;
        const fPnl = Number(f.pnl) || 0;
        if (n.trades >= 20 && f.trades >= 20) {
          if (fPnl > nPnl + 0.01) flipHelped++;
          else if (fPnl < nPnl - 0.01) flipHurt++;
          else flipNeutral++;
        }
      }

      const flipLine = flipHelped > 0 || flipHurt > 0
        ? `<br><span class="small"><i class="fas fa-exchange-alt me-1"></i>` +
          `<strong class="text-success">${flipHelped}</strong> improved by flip · ` +
          `<strong class="text-danger">${flipHurt}</strong> hurt by flip · ` +
          `<strong class="text-muted">${flipNeutral}</strong> neutral</span>`
        : '';

      if (s.withEdge > 0) {
        banner.className = 'edge-summary-banner good';
        banner.innerHTML =
          `<strong>✓ ${s.withEdge} bot${s.withEdge === 1 ? '' : 's'} show statistical edge</strong> ` +
          `(z ≥ 1.96) out of ${s.totalBots}. ` +
          `${s.noEdge} show no edge, ${s.needMoreData} still collecting.${flipLine}`;
      } else if (s.needMoreData > 0 && s.totalClosedTrades > 0) {
        banner.className = 'edge-summary-banner neutral';
        banner.innerHTML =
          `<strong>Collecting data</strong> — ${s.totalClosedTrades} closed trades so far, ` +
          `${s.needMoreData} bot${s.needMoreData === 1 ? '' : 's'} still below target sample.${flipLine}`;
      } else if (s.totalClosedTrades === 0) {
        banner.className = 'edge-summary-banner neutral';
        banner.innerHTML = '<p class="mb-0 small">No edge data yet. Click <strong>Start Edge Validation</strong> to begin.</p>';
      } else {
        banner.className = 'edge-summary-banner bad';
        banner.innerHTML =
          `<strong>No edge detected</strong> — ${s.noEdge} bot${s.noEdge === 1 ? '' : 's'} tested, ` +
          `none above the statistical threshold.${flipLine}`;
      }
    }

    const tbody = document.getElementById('edgeResultsBody');
    if (!tbody) return;

    if (!results.bots || results.bots.length === 0) {
      tbody.innerHTML = '<tr><td colspan="11" class="text-muted p-3">No bots found.</td></tr>';
      return;
    }

    // Sort: EDGE first, then NEED_MORE_DATA, then NO_EDGE; within each by PnL desc
    const order = { EDGE: 0, NEED_MORE_DATA: 1, NO_EDGE: 2 };
    const sorted = [...results.bots].sort((a, b) => {
      const ao = order[a.verdict] != null ? order[a.verdict] : 9;
      const bo = order[b.verdict] != null ? order[b.verdict] : 9;
      if (ao !== bo) return ao - bo;
      // Within same verdict: by PnL (best first)
      return (Number(b.pnl) || 0) - (Number(a.pnl) || 0);
    });

    tbody.innerHTML = sorted.map(b => {
      const verdictHtml = `<span class="${verdictClass(b.verdict)}" title="${escapeHtml(b.verdictReason || '')}">${verdictLabel(b.verdict)}</span>`;
      const edgePp = b.edge != null ? (b.edge * 100) : 0;
      const edgeClass = edgePp > 0 ? 'text-success' : edgePp < 0 ? 'text-danger' : 'text-muted';
      const zClass = Math.abs(b.zScore || 0) >= 1.96 ? 'fw-bold' : '';

      const flipEffect = renderFlipEffect(b);

      const canDelete = (b.closedTrades || 0) > 0;
      const deleteBtn = canDelete
        ? `<button class="btn btn-sm btn-outline-danger py-0 px-2 edge-row-delete"
                   onclick="window.edgeDeleteBot('${escapeHtml(b.botId)}')"
                   title="Delete ${escapeHtml(b.name)}'s edge history"
                   style="font-size:0.7rem;">
             <i class="fas fa-trash"></i>
           </button>`
        : `<span class="text-muted small">—</span>`;

      return `<tr>
        <td><strong>${escapeHtml(b.name)}</strong><br><span class="small text-muted">${escapeHtml(b.botId)}</span></td>
        <td class="text-end">${b.closedTrades || 0}</td>
        <td class="text-end">${b.winRate != null ? (b.winRate * 100).toFixed(1) + '%' : '—'}</td>
        <td class="text-end text-muted">${b.baseRate != null ? (b.baseRate * 100).toFixed(0) + '%' : '—'}</td>
        <td class="text-end ${edgeClass}">${edgePp !== 0 ? (edgePp > 0 ? '+' : '') + edgePp.toFixed(1) + 'pp' : '—'}</td>
        <td class="text-end">${flipEffect}</td>
        <td class="text-end ${zClass}">${b.zScore != null ? b.zScore.toFixed(2) : '—'}</td>
        <td class="text-end">${b.rr != null ? b.rr.toFixed(2) + ':1' : '—'}</td>
        <td class="text-end ${pnlClass(b.pnl)}">${fmtCurrency(b.pnl)}</td>
        <td>${verdictHtml}</td>
        <td class="text-center">${deleteBtn}</td>
      </tr>`;
    }).join('');
  }

  function renderRecommendations(results) {
    const container = document.getElementById('edgeRecommendations');
    if (!container) return;

    const recs = results.recommendations || {};
    const regimes = Object.keys(recs).filter(r => recs[r] && recs[r].length > 0);

    if (regimes.length === 0) {
      container.innerHTML = '<p class="text-muted small">No recommendations yet — run the edge test first. Recommendations appear once at least one bot has shown an EDGE in a specific regime.</p>';
      return;
    }

    container.innerHTML = regimes.map(regime => {
      const bots = recs[regime];
      const botRows = bots.map((b, i) => `
        <div class="rec-bot">
          <div>
            <span class="badge bg-light text-dark me-2">#${i + 1}</span>
            <strong>${escapeHtml(b.name)}</strong>
            <span class="text-muted small ms-2">${b.trades} trades</span>
          </div>
          <div class="text-end">
            <span class="text-success fw-bold">${(b.winRate * 100).toFixed(1)}%</span>
            <span class="ms-2 ${pnlClass(b.pnl)}">${fmtCurrency(b.pnl)}</span>
          </div>
        </div>
      `).join('');
      return `<div class="edge-rec-card">
        <div class="regime-label"><i class="fas fa-flag"></i> ${escapeHtml(regime)}</div>
        ${botRows}
      </div>`;
    }).join('');
  }

  // ============================================================
  // Button state management
  // ============================================================
  function setButtonsBusy(busy) {
    ['edgeStartBtn', 'edgeStopBtn', 'edgeRefreshBtn', 'edgeExportBtn',
     'edgeResetBtn', 'edgeStartFreshBtn']
      .forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = busy;
      });
    document.querySelectorAll('.edge-row-delete').forEach(btn => {
      btn.disabled = busy;
    });
  }

  function updateButtonStates(status) {
    const startBtn = document.getElementById('edgeStartBtn');
    const stopBtn = document.getElementById('edgeStopBtn');
    const freshBtn = document.getElementById('edgeStartFreshBtn');
    if (startBtn) startBtn.disabled = !!status.running;
    if (stopBtn) stopBtn.disabled = !status.running;
    if (freshBtn) freshBtn.disabled = false;
  }

  // ============================================================
  // Polling
  // ============================================================
  function startPolling() {
    stopPolling();
    _pollTimer = setInterval(async () => {
      await loadStatus();
      await loadResults();
      if (!_lastStatus || !_lastStatus.running) {
        stopPolling();
      }
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (_pollTimer) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
  }

  // ============================================================
  // Utils
  // ============================================================
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ============================================================
  // Wire up
  // ============================================================
  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('edgeStartBtn')?.addEventListener('click', startTest);
    document.getElementById('edgeStartFreshBtn')?.addEventListener('click', startFresh);
    document.getElementById('edgeStopBtn')?.addEventListener('click', stopTest);
    document.getElementById('edgeRefreshBtn')?.addEventListener('click', async () => {
      await loadStatus();
      await loadResults();
    });
    document.getElementById('edgeExportBtn')?.addEventListener('click', exportCSV);
    document.getElementById('edgeResetBtn')?.addEventListener('click', resetData);

    loadStatus().then(() => {
      if (_lastStatus && _lastStatus.running) startPolling();
    });
  });

  window.loadEdgeStatus = loadStatus;
  window.loadEdgeResults = loadResults;
  window.edgeDeleteBot = deleteBot;

  window.addEventListener('beforeunload', stopPolling);
})();
