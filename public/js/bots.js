// public/js/bots.js
// Bot catalog, config form, running list, run receipts.
// Event-driven (via window.onBotEvent from live.js) + 8s polling fallback.
// Includes EXPORT and CLEAR functionality for recent runs.
//
// v3 changes:
//   • Boolean config fields (flipEnabled, requireConsensus, etc.) render as
//     checkboxes, not text inputs. Previously the form sent "true"/"false"
//     as strings, so runner's `if (!c.flipEnabled)` treated "false" as truthy
//     — toggling flip OFF from the form had no effect.
//   • Flip-related fields grouped visually with a section header.
//   • Checkbox state submitted as real booleans on Start.
//   • Running-bot cards show current flip state (NORMAL / FLIPPED) and
//     phase PnL so you can watch the flip decision evolve live.
//
// [FIX-SHADOW-UI] Shadow trading display:
//   • `shadowWinsRequired` grouped under its own form section with a
//     help header explaining 0=off, 3=default, 10=max-gate.
//   • Running-bot cards show a shadow badge + gate detail line +
//     last-10 W/L sequence for Rise/Fall & Volatility bots.
//   • Runs table gets a "Shadow" column showing gate-at-entry per trade.
//   • Bot summaries from runner expose `shadow` block; this file renders
//     it defensively — non-shadow bots show nothing extra.

'use strict';

(function () {
  let _bots = [];
  let _selectedBot = null;
  let _running = [];

  // Fields that belong to the "flip" group — displayed together under a header
  const FLIP_FIELDS = ['flipEnabled', 'flipBelowPct', 'flipMinTrades', 'flipStableTrades'];

  // [FIX-SHADOW-UI] Fields that belong to the "shadow" group
  const SHADOW_FIELDS = ['shadowWinsRequired'];

  // ============================================================
  // 1. FETCHERS
  // ============================================================

  async function fetchBots() {
    const container = document.getElementById('botListContainer');
    if (container) container.innerHTML = '<p class="text-muted">Loading bots...</p>';
    console.log('[Bots] Fetching /api/bots...');
    try {
      const res = await fetch('/api/bots');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      _bots = await res.json();
      if (!Array.isArray(_bots)) throw new Error('Expected array from /api/bots');
      console.log('[Bots] ✓ Loaded ' + _bots.length + ' bots');
      renderBotList();
    } catch (err) {
      if (container) container.innerHTML = `<div class="alert alert-danger m-3">Error loading bots: ${err.message}</div>`;
      console.error('[Bots] fetch failed:', err);
    }
  }

  async function fetchRunning() {
    try {
      const res = await fetch('/api/bots/running');
      if (!res.ok) return;
      _running = await res.json();
      if (!Array.isArray(_running)) _running = [];
      renderRunningBots();
      const el = document.getElementById('runningBotCount');
      if (el) el.textContent = _running.length;
    } catch (err) {
      console.warn('[Bots] running failed:', err.message);
    }
  }

  async function fetchRuns() {
    if (_bots.length === 0) return;
    try {
      const all = [];
      for (const bot of _bots) {
        try {
          const runs = await (await fetch(`/api/bots/${bot.id}/runs?limit=10`)).json();
          if (Array.isArray(runs)) all.push(...runs);
        } catch (_) {}
      }
      all.sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt));
      renderRuns(all.slice(0, 50));
    } catch (err) {
      console.warn('[Bots] runs failed:', err.message);
    }
  }

  // ============================================================
  // 2. RENDERERS
  // ============================================================

  function renderBotList() {
    const container = document.getElementById('botListContainer');
    if (!container) return;
    if (_bots.length === 0) { container.innerHTML = '<p class="text-muted">No bots available</p>'; return; }

    const groups = {
      fx: { label: 'FX Multiplier Bots', color: '#1a73e8', bots: [] },
      synthetic_digit: { label: 'Synthetic Digit Bots (Even/Odd, Over/Under, Match/Differs)', color: '#9333ea', bots: [] },
      synthetic_binary: { label: 'Synthetic Rise/Fall & Volatility Bots', color: '#d97706', bots: [] },
    };
    for (const b of _bots) if (groups[b.assetClass]) groups[b.assetClass].bots.push(b);

    container.innerHTML = Object.entries(groups).map(([key, group]) => {
      if (group.bots.length === 0) return '';
      return `<div class="mb-4">
        <h6 style="color:${group.color}; border-bottom:2px solid ${group.color}; padding-bottom:6px;">
          ${group.label} <span class="badge bg-secondary">${group.bots.length}</span>
        </h6>
        <div class="row g-2">
          ${group.bots.map(bot => `
            <div class="col-md-6 col-lg-4">
              <div class="card h-100" style="border-left:3px solid ${group.color};">
                <div class="card-body p-3">
                  <h6 class="mb-1">${bot.name}</h6>
                  <p class="small text-muted mb-2" style="min-height:2.5em;">${bot.description}</p>
                  <button class="btn btn-sm btn-primary w-100" data-bot="${bot.id}">
                    <i class="fas fa-play"></i> Configure & Start
                  </button>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>`;
    }).join('');

    container.querySelectorAll('button[data-bot]').forEach(btn => {
      btn.addEventListener('click', () => selectBot(btn.dataset.bot));
    });
  }

  // [FIX-SHADOW-UI] buildField now accepts an optional `extras` object of
  // extra HTML attributes for the input — used to give shadowWinsRequired
  // min=0 / max=10 / step=1 (backward-compatible: undefined = no extras).
  function buildField(key, val, extras) {
    const extrasAttr = extras
      ? Object.entries(extras).map(([k, v]) => `${k}="${v}"`).join(' ')
      : '';

    // Checkbox
    if (typeof val === 'boolean') {
      const id = `botfield_${key}`;
      return `<div class="col-6 col-md-4">
        <div class="form-check mt-3">
          <input class="form-check-input" type="checkbox" name="${key}" id="${id}" ${val ? 'checked' : ''}>
          <label class="form-check-label small" for="${id}">${key}</label>
        </div>
      </div>`;
    }
    // Number
    if (typeof val === 'number') {
      return `<div class="col-6 col-md-4">
        <label class="form-label small text-muted mb-1">${key}</label>
        <input class="form-control form-control-sm" name="${key}" value="${val}" type="number" step="any" ${extrasAttr} />
      </div>`;
    }
    // String (or null — filtered out before this function is called)
    return `<div class="col-6 col-md-4">
      <label class="form-label small text-muted mb-1">${key}</label>
      <input class="form-control form-control-sm" name="${key}" value="${val}" type="text" ${extrasAttr} />
    </div>`;
  }

  function selectBot(botId) {
    _selectedBot = _bots.find(b => b.id === botId);
    if (!_selectedBot) { alert('Bot not found'); return; }

    const form = document.getElementById('botStartForm');
    const name = document.getElementById('botStartName');
    const fields = document.getElementById('botConfigFields');

    if (name) name.textContent = `${_selectedBot.name} (${_selectedBot.assetClass})`;

    if (fields) {
      const cfg = _selectedBot.defaultConfig || {};
      // Partition config into: shadow fields, flip fields, main fields
      const shadowEntries = [];
      const flipEntries = [];
      const mainEntries = [];
      for (const [key, val] of Object.entries(cfg)) {
        if (val === null || val === undefined) continue;
        if (SHADOW_FIELDS.indexOf(key) >= 0) shadowEntries.push([key, val]);
        else if (FLIP_FIELDS.indexOf(key) >= 0) flipEntries.push([key, val]);
        else mainEntries.push([key, val]);
      }

      let html = mainEntries.map(([key, val]) => buildField(key, val)).join('');

      // [FIX-SHADOW-UI] Shadow group — only render if the bot has shadow fields
      if (shadowEntries.length > 0) {
        html += `<div class="col-12 mt-3 mb-1">
          <hr class="mt-1 mb-2"/>
          <div class="small fw-bold text-uppercase text-muted" style="letter-spacing:0.05em;">
            <i class="fas fa-user-secret me-1"></i> Shadow Trading (paper-trade gate)
          </div>
          <div class="small text-muted mb-2">
            Requires <strong>N consecutive shadow wins</strong> before the first real trade fires.
            After a real <span class="text-success">WIN</span>, continues trading directly while rules hold.
            After a real <span class="text-danger">LOSS</span>, gate tightens by +1 (max 10) and re-accumulates.
            <br><strong>0 = disabled (fires immediately)</strong> · 3 = default · up to 10.
          </div>
        </div>`;
        html += shadowEntries.map(([key, val]) =>
          buildField(key, val, { min: 0, max: 10, step: 1 })
        ).join('');
      }

      // Group flip fields with a header
      if (flipEntries.length > 0) {
        html += `<div class="col-12 mt-3 mb-1">
          <hr class="mt-1 mb-2"/>
          <div class="small fw-bold text-uppercase text-muted" style="letter-spacing:0.05em;">
            <i class="fas fa-exchange-alt me-1"></i> Adaptive Flip (bot reverses entry direction if losing)
          </div>
          <div class="small text-muted mb-2">
            Enabled: flips when normal-phase win rate drops below threshold.
            Unflips when flipped-phase PnL goes negative.
          </div>
        </div>`;
        html += flipEntries.map(([key, val]) => buildField(key, val)).join('');
      }

      fields.innerHTML = html;
    }
    if (form) { form.style.display = 'block'; form.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }

  // [FIX-SHADOW-UI] Helpers for shadow rendering
  function hasShadow(inst) {
    return !!(inst && inst.shadow && inst.shadow.enabled);
  }

  function renderShadowBadge(shadow) {
    if (!shadow) return '';
    if (shadow.pending > 0) {
      return `<span class="badge bg-info text-dark ms-1" title="A shadow trade is awaiting resolution">SHADOW (pending)</span>`;
    }
    if (shadow.shadowRequired === false) {
      return `<span class="badge bg-success ms-1" title="Post-win: firing directly while rules hold">LIVE</span>`;
    }
    if (shadow.consecutiveShadowWins >= shadow.currentGate) {
      return `<span class="badge bg-success ms-1" title="Shadow gate met — will fire on next rules hit">GATE MET</span>`;
    }
    return `<span class="badge bg-secondary ms-1" title="Accumulating shadow wins">SHADOW ${shadow.consecutiveShadowWins}/${shadow.currentGate}</span>`;
  }

  function renderShadowDetailLine(shadow) {
    if (!shadow) return '';
    const parts = [];
    const gate = Number(shadow.currentGate) || 0;
    const origGate = Number(shadow.originalGate) || 0;
    const tightens = Number(shadow.gateTightenCount) || 0;

    if (tightens > 0) {
      parts.push(`gate <strong>${gate}</strong> (from ${origGate}, ${tightens} tighten${tightens === 1 ? '' : 's'})`);
    } else {
      parts.push(`gate <strong>${gate}</strong>`);
    }

    const stats = shadow.stats || { wins: 0, losses: 0, total: 0, winRate: 0 };
    if (stats.total > 0) {
      const wr = Number(stats.winRate * 100).toFixed(0);
      parts.push(`${stats.wins}W/${stats.losses}L shadows (${wr}%)`);
    } else {
      parts.push('no shadow history yet');
    }

    if (shadow.pending > 0) {
      parts.push(`<span class="text-info">${shadow.pending} pending</span>`);
    }

    return `<div class="small text-muted mt-1" style="font-size:0.72rem;">
      <i class="fas fa-user-secret me-1"></i>${parts.join(' · ')}
    </div>`;
  }

  function renderShadowSequence(shadow) {
    if (!shadow || !Array.isArray(shadow.sequence) || shadow.sequence.length === 0) return '';
    const badges = shadow.sequence.slice(-10).map(o => {
      const cls = o === 'W' ? 'bg-success' : 'bg-danger';
      return `<span class="badge ${cls}" style="font-size:0.6em; padding:2px 5px;">${o}</span>`;
    }).join(' ');
    return `<div class="mt-1" style="font-size:0.7rem;" title="Last ${shadow.sequence.length} shadow outcomes (oldest → newest)">
      <span class="text-muted">Sequence:</span> ${badges}
    </div>`;
  }

  function renderRunningBots() {
    const container = document.getElementById('runningBotsContainer');
    if (!container) return;
    if (_running.length === 0) { container.innerHTML = '<p class="text-muted p-3">No bots running.</p>'; return; }

    container.innerHTML = _running.map(inst => {
      const s = inst.stats || { runs: 0, entries: 0, wins: 0, losses: 0, pnl: 0, peakPnl: 0 };
      const pnlClass = s.pnl >= 0 ? 'text-success' : 'text-danger';
      const cfg = inst.config || {};
      const tp = Number(cfg.botTakeProfit) || 0;
      const sl = Math.abs(Number(cfg.botStopLoss) || 0);
      const trail = Number(cfg.trailingDrawdownPct) || 0;
      const maxLoss = Number(cfg.stopAfterLosses) || 0;
      const peak = Number(s.peakPnl) || 0;
      const riskLine = [
        tp > 0 ? `TP +$${tp}` : null,
        sl > 0 ? `SL -$${sl}` : null,
        trail > 0 ? `Trail ${trail}%` : null,
        maxLoss > 0 ? `Stop@${maxLoss}L` : null,
        peak > 0 ? `Peak +$${peak.toFixed(2)}` : null,
      ].filter(Boolean).join(' · ');

      // Flip status: shown only if flip is enabled on this bot
      const flipEnabled = !!cfg.flipEnabled;
      const flipped = !!s.flipped;
      const flipBadge = flipEnabled
        ? (flipped
            ? `<span class="badge bg-warning text-dark ms-1" title="Bot is betting the opposite direction">FLIPPED</span>`
            : `<span class="badge bg-light text-muted ms-1" title="Bot is betting normal direction">NORMAL</span>`)
        : '';
      const phaseLine = flipEnabled
        ? `<div class="small text-muted mt-1" style="font-size:0.72rem;">
             <i class="fas fa-exchange-alt me-1"></i>
             phase ${s.phaseTrades || 0} trades · $${Number(s.phasePnl || 0).toFixed(2)}
             ${s.normalTrades > 0 ? ` · normal ${s.normalTrades}t $${Number(s.normalPnl || 0).toFixed(2)}` : ''}
             ${s.flippedTrades > 0 ? ` · flipped ${s.flippedTrades}t $${Number(s.flippedPnl || 0).toFixed(2)}` : ''}
             ${s.flipCount > 0 ? ` · flips ${s.flipCount}` : ''}
           </div>`
        : '';

      // [FIX-SHADOW-UI] Shadow state for eligible bots
      const shadowEnabled = hasShadow(inst);
      const shadowBadge = shadowEnabled ? renderShadowBadge(inst.shadow) : '';
      const shadowDetail = shadowEnabled ? renderShadowDetailLine(inst.shadow) : '';
      const shadowSeq = shadowEnabled ? renderShadowSequence(inst.shadow) : '';

      return `<div class="card mb-2" style="border-left:3px solid #00b894;">
        <div class="card-body p-3">
          <div class="d-flex justify-content-between align-items-start">
            <div style="flex:1;">
              <h6 class="mb-1">${inst.name} ${flipBadge}${shadowBadge} <span class="badge bg-success ms-2">RUNNING</span></h6>
              <div class="small text-muted">${inst.symbol} · ${inst.instanceId}</div>
              <div class="small mt-1">
                Runs <strong>${s.runs}</strong> · Entries <strong>${s.entries}</strong> ·
                <span class="text-success">${s.wins}W</span>/<span class="text-danger">${s.losses}L</span> ·
                P/L <strong class="${pnlClass}">${s.pnl >= 0 ? '+' : ''}${s.pnl.toFixed(2)}</strong>
              </div>
              <div class="small text-muted mt-1" style="font-size:0.72rem;">
                <i class="fas fa-shield-halved me-1"></i>${riskLine || 'no risk limits'}
              </div>
              ${phaseLine}
              ${shadowDetail}
              ${shadowSeq}
              <div class="small text-muted mt-1 fw-bold" style="font-size:0.75rem;">${inst.lastReason || ''}</div>
            </div>
            <button class="btn btn-sm btn-danger" data-stop="${inst.instanceId}">
              <i class="fas fa-stop"></i> Stop
            </button>
          </div>
        </div>
      </div>`;
    }).join('');

    container.querySelectorAll('button[data-stop]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Stop this bot? Open positions remain under OTIE management.')) return;
        await fetch(`/api/bots/instance/${btn.dataset.stop}/stop`, { method: 'POST' });
        fetchRunning();
      });
    });
  }

  // [FIX-SHADOW-UI] Runs table gains a Shadow column.
  function renderRuns(runs) {
    const container = document.getElementById('botRunsContainer');
    if (!container) return;
    if (!runs || runs.length === 0) { container.innerHTML = '<p class="text-muted p-3">No runs yet.</p>'; return; }

    const rows = runs.map(r => {
      const pnlClass = r.pnl >= 0 ? 'text-success fw-bold' : 'text-danger fw-bold';
      const badge = r.result === 'WIN' ? '<span class="badge bg-success">WIN</span>'
                  : r.result === 'LOSS' ? '<span class="badge bg-danger">LOSS</span>'
                  : `<span class="badge bg-warning">${r.status || 'OPEN'}</span>`;

      const flipLabel = r.entryThesis && r.entryThesis.flip === 'FLIPPED'
        ? '<span class="badge bg-warning text-dark">F</span>'
        : '<span class="text-muted small">N</span>';

      // [FIX-SHADOW-UI] Shadow gate-at-entry indicator
      let shadowLabel = '<span class="text-muted small">—</span>';
      if (r.shadowEnabled) {
        const gate = Number(r.gateAtEntry) || 0;
        const origGate = Number(r.originalGate) || gate;
        const tightens = Number(r.gateTightenCount) || 0;
        const title = tightens > 0
          ? `Shadow gate ${gate} (started at ${origGate}, ${tightens} tighten${tightens === 1 ? '' : 's'})`
          : `Shadow gate ${gate}`;
        shadowLabel = `<span class="badge bg-secondary" title="${title}" style="font-size:0.75em;">G${gate}</span>`;
      }

      return `<tr>
        <td>${new Date(r.openedAt).toLocaleString()}</td>
        <td><strong>${r.botId}</strong></td>
        <td>${r.symbol}</td>
        <td>${r.side}</td>
        <td class="text-center">${flipLabel}</td>
        <td class="text-center">${shadowLabel}</td>
        <td>$${(r.stake || 0).toFixed(2)}</td>
        <td>${r.multiplier ? r.multiplier + 'x' : (r.duration ? r.duration + 't' : '—')}</td>
        <td>${r.entryPrice ? r.entryPrice.toFixed(5) : '—'}</td>
        <td class="${pnlClass}">${r.pnl >= 0 ? '+' : ''}${(r.pnl || 0).toFixed(2)}</td>
        <td>${badge}</td>
      </tr>`;
    }).join('');

    container.innerHTML = `<table class="table table-sm table-striped mb-0">
      <thead style="position:sticky; top:0; background:#fff; z-index:2;">
        <tr><th>Opened</th><th>Bot</th><th>Symbol</th><th>Side</th><th>Flip</th>
            <th title="Shadow gate at entry (— for non-shadow bots)">Shadow</th>
            <th>Stake</th><th>Mult</th><th>Entry</th><th>P/L</th><th>Result</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // ============================================================
  // 3. ACTIONS
  // ============================================================

  async function startSelectedBot() {
    if (!_selectedBot) return;
    const form = document.getElementById('botConfigForm');
    const config = {};

    // Read all fields — handle checkboxes separately so we send real booleans
    form.querySelectorAll('input[name]').forEach(f => {
      const name = f.name;
      const type = f.type;

      if (type === 'checkbox') {
        config[name] = !!f.checked;
        return;
      }

      const raw = f.value.trim();
      if (raw === '') return;  // let default win on empty fields
      const n = Number(raw);
      config[name] = Number.isFinite(n) ? n : raw;
    });

    const res = await fetch(`/api/bots/${_selectedBot.id}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    const data = await res.json();

    if (data.success) {
      document.getElementById('botStartForm').style.display = 'none';
      _selectedBot = null;
      fetchRunning();
      fetchRuns();
    } else {
      alert('Start failed: ' + (data.error || 'unknown'));
    }
  }

  async function exportRunsToCSV() {
    try {
      const res = await fetch('/api/bots/runs/export');
      const runs = await res.json();
      if (!runs || runs.length === 0) { alert('No runs to export.'); return; }

      let csv = 'Date,Bot,Symbol,Type,Stake,Entry,PnL,Result,Reason\n';
      runs.forEach(r => {
        const reason = (r.reasons || []).join(' | ').replace(/,/g, ';');
        csv += `${new Date(r.openedAt).toISOString()},${r.botId},${r.symbol},${r.side},${r.stake},${r.entryPrice || ''},${r.pnl || 0},${r.result || 'OPEN'},"${reason}"\n`;
      });

      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `bot_runs_${new Date().toISOString().slice(0,10)}.csv`;
      a.click(); URL.revokeObjectURL(a.href);
    } catch (e) { alert('Export failed: ' + e.message); }
  }

  async function clearRuns() {
    if (!confirm('Are you sure you want to delete ALL bot runs? This cannot be undone.')) return;
    try {
      const res = await fetch('/api/bots/runs', { method: 'DELETE' });
      if (res.ok) { alert('All runs cleared.'); fetchRuns(); }
      else alert('Failed to clear runs.');
    } catch (e) { alert('Clear failed: ' + e.message); }
  }

  // ============================================================
  // 4. EVENT WIRING
  // ============================================================

  window.onBotEvent = function () { fetchRunning(); fetchRuns(); };

  document.addEventListener('DOMContentLoaded', function () {
    fetchBots();
    fetchRunning();
    fetchRuns();

    setInterval(() => {
      if (document.getElementById('section-bots')?.style.display !== 'none') fetchRunning();
    }, 8000);

    document.getElementById('botConfigForm')?.addEventListener('submit', e => {
      e.preventDefault();
      startSelectedBot();
    });

    document.getElementById('cancelBotStart')?.addEventListener('click', () => {
      document.getElementById('botStartForm').style.display = 'none';
      _selectedBot = null;
    });

    document.getElementById('botsReload')?.addEventListener('click', () => {
      fetchBots(); fetchRunning(); fetchRuns();
    });

    document.getElementById('stopAllBots')?.addEventListener('click', async () => {
      if (!confirm('Stop all running bots?')) return;
      await fetch('/api/bots/stop-all', { method: 'POST' });
      fetchRunning();
    });

    document.getElementById('exportRunsBtn')?.addEventListener('click', exportRunsToCSV);
    document.getElementById('clearRunsBtn')?.addEventListener('click', clearRuns);
  });
})();
