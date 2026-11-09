// public/js/reports.js
// Reports & Security dashboard integration.
//
// [FIX-REPORTS-UI] **Self-injecting Reports + Security tabs.**
//
//   On DOMContentLoaded, this file:
//     1. Injects 2 sidebar nav buttons ("Reports", "Security")
//     2. Injects 2 <section-content> panels into .main-content
//     3. Wires up nav handlers that respect the existing sections map
//     4. Auto-refreshes status every 30s when the section is visible
//     5. Cleanup on tab switch (no background polling of hidden tabs)
//
//   Reports panel:
//     • Scheduler status (next daily/weekly, last sent, recipient, catchup caps)
//     • "Send Daily Now" / "Send Weekly Now" trigger buttons
//     • "Send Custom Report" form with from/to date pickers
//     • Recent failures list (if any)
//
//   Security panel:
//     • Monitor status (running, thresholds, alerts sent/failed/suppressed)
//     • Filterable event log (severity, event type, time window)
//     • Paginated table (100 events per page)
//     • Auto-refresh every 30s while visible
//
//   Endpoints consumed (all protected by server.js auth middleware):
//     GET  /api/reports/status
//     POST /api/reports/send-now       { type, from?, to? }
//     GET  /api/security/status
//     GET  /api/security/events        ?since&eventType&severity&limit&skip
//
//   Failures degrade gracefully — every fetch is try/catch wrapped and
//   shows an inline error state rather than crashing the whole panel.

(function () {
  'use strict';

  // ── Config ────────────────────────────────────────────────
  const REFRESH_MS = 30_000;       // auto-refresh cadence when visible
  const PAGE_SIZE = 100;

  // ── State ────────────────────────────────────────────────
  let _visible = false;
  let _reportsRefreshTimer = null;
  let _securityRefreshTimer = null;
  let _securityFilters = {
    severity: '',
    eventType: '',
    windowMs: 24 * 60 * 60 * 1000,   // default: last 24h
  };
  let _securityPage = 0;
  let _inFlight = { reports: false, security: false };
  let _initialized = false;

  // ── Helpers ──────────────────────────────────────────────

  function _el(tag, attrs, html) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('data-')) el.setAttribute(k, v);
      else el.setAttribute(k, v);
    }
    if (html != null) el.innerHTML = html;
    return el;
  }

  function _escape(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _formatTime(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('en-GB', {
        year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
    } catch (_) { return '—'; }
  }

  function _formatRelative(iso) {
    if (!iso) return '—';
    try {
      const ms = Date.now() - new Date(iso).getTime();
      if (ms < 0) return 'in ' + _formatDuration(-ms);
      if (ms < 1000) return 'just now';
      return _formatDuration(ms) + ' ago';
    } catch (_) { return '—'; }
  }

  function _formatDuration(ms) {
    if (ms < 60_000) return Math.round(ms / 1000) + 's';
    if (ms < 3_600_000) return Math.round(ms / 60_000) + 'm';
    if (ms < 86_400_000) {
      const h = Math.floor(ms / 3_600_000);
      const m = Math.round((ms % 3_600_000) / 60_000);
      return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    const d = Math.floor(ms / 86_400_000);
    const h = Math.round((ms % 86_400_000) / 3_600_000);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }

  function _formatMsUntil(ms) {
    if (ms == null || ms < 0) return '—';
    return _formatDuration(ms);
  }

  // Lightweight inline toast (does not depend on window.SoundManager)
  function _toast(message, kind) {
    const palette = {
      success: { bg: '#ecfdf5', fg: '#065f46', bd: '#a7f3d0' },
      warn:    { bg: '#fef3c7', fg: '#92400e', bd: '#fde68a' },
      error:   { bg: '#fef2f2', fg: '#991b1b', bd: '#fecaca' },
      info:    { bg: '#eff6ff', fg: '#1e40af', bd: '#bfdbfe' },
    };
    const p = palette[kind] || palette.info;
    const containerId = 'rtsReportsToast';
    let container = document.getElementById(containerId);
    if (!container) {
      container = _el('div', {
        id: containerId,
        style: 'position:fixed; top:16px; left:16px; z-index:99999; display:flex; flex-direction:column; gap:8px; max-width:420px; pointer-events:none;',
      });
      document.body.appendChild(container);
    }
    const div = _el('div', {
      style: `background:${p.bg}; color:${p.fg}; border:1px solid ${p.bd}; ` +
             `padding:10px 14px; border-radius:8px; font-size:0.85rem; ` +
             `font-weight:500; box-shadow:0 4px 12px rgba(0,0,0,0.1); ` +
             `pointer-events:auto; opacity:0; transition:opacity 0.2s ease; ` +
             `white-space:pre-wrap;`,
    });
    div.textContent = message;
    container.appendChild(div);
    requestAnimationFrame(() => { div.style.opacity = '1'; });
    setTimeout(() => {
      div.style.opacity = '0';
      setTimeout(() => div.remove(), 250);
    }, 6000);
  }

  // ── API helpers ─────────────────────────────────────────

  async function _getJson(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (res.status === 401) { window.location.href = '/login'; throw new Error('Unauthorized'); }
    let body = {};
    try { body = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  }

  async function _postJson(url, payload) {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    if (res.status === 401) { window.location.href = '/login'; throw new Error('Unauthorized'); }
    let body = {};
    try { body = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  }

  // ── Sidebar injection ────────────────────────────────────

  function _injectSidebarButtons() {
    const navContainer = document.querySelector('.sidebar-nav');
    if (!navContainer) return;

    // Insert Reports + Security after the "Edge Results" nav item
    const edgeBtn = navContainer.querySelector('.nav-item[data-section="edge"]');
    if (!edgeBtn) return;

    if (!navContainer.querySelector('.nav-item[data-section="reports"]')) {
      const reportsBtn = _el('button', {
        class: 'nav-item',
        'data-section': 'reports',
      }, '<i class="fas fa-envelope-open-text"></i> Reports');
      edgeBtn.parentNode.insertBefore(reportsBtn, edgeBtn.nextSibling);
    }

    if (!navContainer.querySelector('.nav-item[data-section="security"]')) {
      const securityBtn = _el('button', {
        class: 'nav-item',
        'data-section': 'security',
      }, '<i class="fas fa-shield-halved"></i> Security');
      const reportsBtn = navContainer.querySelector('.nav-item[data-section="reports"]');
      reportsBtn.parentNode.insertBefore(securityBtn, reportsBtn.nextSibling);
    }
  }

  // ── Section injection ────────────────────────────────────

  function _injectSections() {
    const mainContent = document.querySelector('.main-content');
    if (!mainContent) return;

    // Anchor: insert after #section-edge (or at the end of main-content)
    const anchor = document.getElementById('section-edge') || mainContent.lastElementChild;

    if (!document.getElementById('section-reports')) {
      const reportsSection = _el('div', {
        id: 'section-reports',
        class: 'section-content',
        style: 'display:none;',
      }, `
        <div class="card mb-3">
          <div class="card-header">
            <span class="card-title"><i class="fas fa-envelope-open-text"></i> Reports & Scheduling</span>
            <button class="btn btn-sm btn-outline-primary" id="rptRefreshBtn">
              <i class="fas fa-sync-alt"></i> Refresh
            </button>
          </div>
          <div class="card-body" id="rptStatusBody">
            <p class="text-muted">Loading...</p>
          </div>
        </div>

        <div class="card mb-3">
          <div class="card-header">
            <span class="card-title"><i class="fas fa-paper-plane"></i> Manual Trigger</span>
          </div>
          <div class="card-body">
            <div class="row g-2 mb-3">
              <div class="col-md-6 d-grid">
                <button class="btn btn-success" id="rptSendDailyBtn">
                  <i class="fas fa-calendar-day"></i> Send Daily Report Now
                </button>
              </div>
              <div class="col-md-6 d-grid">
                <button class="btn btn-primary" id="rptSendWeeklyBtn">
                  <i class="fas fa-calendar-week"></i> Send Weekly Report Now
                </button>
              </div>
            </div>
            <hr/>
            <div class="row g-2 align-items-end">
              <div class="col-md-4">
                <label class="form-label small text-muted mb-1">From</label>
                <input type="datetime-local" class="form-control form-control-sm" id="rptCustomFrom" />
              </div>
              <div class="col-md-4">
                <label class="form-label small text-muted mb-1">To</label>
                <input type="datetime-local" class="form-control form-control-sm" id="rptCustomTo" />
              </div>
              <div class="col-md-4 d-grid">
                <button class="btn btn-outline-primary btn-sm" id="rptSendCustomBtn">
                  <i class="fas fa-paper-plane"></i> Send Custom Report
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="card" id="rptFailuresCard" style="display:none;">
          <div class="card-header">
            <span class="card-title"><i class="fas fa-exclamation-triangle" style="color:#e74c5e;"></i> Recent Failures</span>
          </div>
          <div class="card-body p-0">
            <div id="rptFailuresBody"></div>
          </div>
        </div>
      `);
      anchor.parentNode.insertBefore(reportsSection, anchor.nextSibling);
    }

    if (!document.getElementById('section-security')) {
      const securitySection = _el('div', {
        id: 'section-security',
        class: 'section-content',
        style: 'display:none;',
      }, `
        <div class="card mb-3">
          <div class="card-header">
            <span class="card-title"><i class="fas fa-shield-halved"></i> Security Monitor</span>
            <button class="btn btn-sm btn-outline-primary" id="secRefreshBtn">
              <i class="fas fa-sync-alt"></i> Refresh
            </button>
          </div>
          <div class="card-body" id="secStatusBody">
            <p class="text-muted">Loading...</p>
          </div>
        </div>

        <div class="card">
          <div class="card-header" style="flex-wrap:wrap; gap:8px;">
            <span class="card-title"><i class="fas fa-list"></i> Security Events</span>
            <div class="d-flex gap-2 flex-wrap">
              <select class="form-select form-select-sm" id="secFilterSeverity" style="width:auto;">
                <option value="">All Severities</option>
                <option value="critical">Critical</option>
                <option value="warning">Warning</option>
                <option value="info">Info</option>
              </select>
              <select class="form-select form-select-sm" id="secFilterType" style="width:auto;">
                <option value="">All Event Types</option>
                <option value="login_success">Login Success</option>
                <option value="login_failure">Login Failure</option>
                <option value="login_rate_limited">Rate Limited</option>
                <option value="logout">Logout</option>
                <option value="new_ip_login">New IP Login</option>
                <option value="concurrent_sessions">Concurrent Sessions</option>
                <option value="failure_storm">Failure Storm</option>
                <option value="distributed_attack">Distributed Attack</option>
                <option value="after_hours_login">After-Hours Login</option>
                <option value="rapid_login_logout">Rapid Login/Logout</option>
                <option value="account_switch">Account Switch</option>
                <option value="account_switch_failed">Account Switch Failed</option>
                <option value="account_switch_spam">Account Switch Spam</option>
                <option value="ip_trusted">IP Trusted</option>
                <option value="ip_untrusted">IP Untrusted</option>
              </select>
              <select class="form-select form-select-sm" id="secFilterWindow" style="width:auto;">
                <option value="3600000">Last 1h</option>
                <option value="21600000">Last 6h</option>
                <option value="86400000" selected>Last 24h</option>
                <option value="604800000">Last 7d</option>
                <option value="2592000000">Last 30d</option>
              </select>
            </div>
          </div>
          <div class="card-body p-0">
            <div id="secEventsBody" class="table-responsive">
              <p class="text-muted p-3">Loading...</p>
            </div>
            <div class="d-flex justify-content-between align-items-center p-3 border-top">
              <div class="small text-muted">
                <span id="secEventCount">0</span> events · Page <span id="secPageNum">1</span>
              </div>
              <div>
                <button class="btn btn-sm btn-outline-secondary" id="secPrevPage">
                  <i class="fas fa-chevron-left"></i>
                </button>
                <button class="btn btn-sm btn-outline-secondary" id="secNextPage">
                  <i class="fas fa-chevron-right"></i>
                </button>
              </div>
            </div>
          </div>
        </div>
      `);
      const reportsSection = document.getElementById('section-reports');
      reportsSection.parentNode.insertBefore(securitySection, reportsSection.nextSibling);
    }
  }

  // ── Navigation ──────────────────────────────────────────

  function _wireNavigation() {
    const navItems = document.querySelectorAll('.sidebar-nav .nav-item[data-section]');
    const mainContent = document.querySelector('.main-content');
    if (!mainContent) return;

    navItems.forEach(item => {
      // Avoid double-wiring pre-existing items — clone node to remove old listeners?
      // No. Instead, only wire our own if not already marked.
      if (item.dataset.rtsReportsWired === '1') return;
      item.dataset.rtsReportsWired = '1';

      // We add an ADDITIONAL listener that runs on click. The existing
      // listener (from inline index.html) still fires and hides all
      // `.section-content` elements it knows about; we then show ours.
      // This works because hide-then-show is safe.
      item.addEventListener('click', () => {
        const sec = item.dataset.section;
        if (sec !== 'reports' && sec !== 'security') return;

        // Hide ALL section-content
        document.querySelectorAll('.section-content').forEach(el => {
          el.style.display = 'none';
        });
        const target = document.getElementById('section-' + sec);
        if (target) target.style.display = 'block';

        const pageTitle = document.getElementById('pageTitle');
        if (pageTitle) pageTitle.textContent = sec === 'reports' ? 'Reports' : 'Security';

        window.scrollTo({ top: 0, behavior: 'smooth' });

        _visible = true;
        if (sec === 'reports') {
          _startReportsRefresh();
          _stopSecurityRefresh();
        } else if (sec === 'security') {
          _startSecurityRefresh();
          _stopReportsRefresh();
        }
      });
    });

    // Detect when leaving our sections (any other nav item gets clicked)
    navItems.forEach(item => {
      const sec = item.dataset.section;
      if (sec === 'reports' || sec === 'security') return;
      if (item.dataset.rtsReportsLeaveWired === '1') return;
      item.dataset.rtsReportsLeaveWired = '1';
      item.addEventListener('click', () => {
        _visible = false;
        _stopReportsRefresh();
        _stopSecurityRefresh();
      });
    });
  }

  // ── Reports panel ───────────────────────────────────────

  function _startReportsRefresh() {
    if (_reportsRefreshTimer) return;
    _reportsRefreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && _isSectionVisible('reports')) {
        _refreshReports();
      }
    }, REFRESH_MS);
    _refreshReports();
  }

  function _stopReportsRefresh() {
    if (_reportsRefreshTimer) { clearInterval(_reportsRefreshTimer); _reportsRefreshTimer = null; }
  }

  function _startSecurityRefresh() {
    if (_securityRefreshTimer) return;
    _securityRefreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && _isSectionVisible('security')) {
        _refreshSecurity();
      }
    }, REFRESH_MS);
    _refreshSecurity();
  }

  function _stopSecurityRefresh() {
    if (_securityRefreshTimer) { clearInterval(_securityRefreshTimer); _securityRefreshTimer = null; }
  }

  function _isSectionVisible(sec) {
    const el = document.getElementById('section-' + sec);
    return el && el.style.display !== 'none';
  }

  async function _refreshReports() {
    if (_inFlight.reports) return;
    _inFlight.reports = true;
    try {
      const data = await _getJson('/api/reports/status');
      _renderReportsStatus(data);
      _renderReportsFailures(data.recentFailures || []);
    } catch (err) {
      const body = document.getElementById('rptStatusBody');
      if (body) body.innerHTML = `<div class="alert alert-danger mb-0">Failed to load report status: ${_escape(err.message)}</div>`;
    } finally {
      _inFlight.reports = false;
    }
  }

  function _renderReportsStatus(data) {
    const body = document.getElementById('rptStatusBody');
    if (!body) return;

    const s = data.scheduler || {};
    const cfg = s.config || {};
    const lastDaily = data.lastDaily;
    const lastWeekly = data.lastWeekly;

    const runningBadge = s.running
      ? '<span class="badge bg-success">RUNNING</span>'
      : '<span class="badge bg-danger">STOPPED</span>';

    const cfgPills = `
      <span class="badge bg-light text-dark me-1" title="Daily backfill cap">Daily catch-up: ${cfg.dailyCatchupDays ?? '?'}d</span>
      <span class="badge bg-light text-dark me-1" title="Weekly backfill cap">Weekly catch-up: ${cfg.weeklyCatchupWeeks ?? '?'}w</span>
      <span class="badge bg-light text-dark me-1" title="Max attempts per period">Max attempts: ${cfg.maxAttempts ?? '?'}</span>
    `;

    body.innerHTML = `
      <div class="row g-3">
        <div class="col-md-3">
          <div class="stat-card">
            <div class="stat-label">Scheduler</div>
            <div class="stat-value">${runningBadge}</div>
            <div class="small text-muted mt-1">TZ: ${_escape(s.timezone || 'Africa/Nairobi')}</div>
          </div>
        </div>
        <div class="col-md-3">
          <div class="stat-card">
            <div class="stat-label">Next Daily</div>
            <div class="stat-value">${_formatMsUntil(s.nextDailyInMs)}</div>
            <div class="small text-muted mt-1">
              ${lastDaily ? `Last sent ${_formatRelative(lastDaily.sentAt)}` : 'Never sent'}
            </div>
          </div>
        </div>
        <div class="col-md-3">
          <div class="stat-card">
            <div class="stat-label">Next Weekly</div>
            <div class="stat-value">${_formatMsUntil(s.nextWeeklyInMs)}</div>
            <div class="small text-muted mt-1">
              ${lastWeekly ? `Last sent ${_formatRelative(lastWeekly.sentAt)}` : 'Never sent'}
            </div>
          </div>
        </div>
        <div class="col-md-3">
          <div class="stat-card">
            <div class="stat-label">Recipient</div>
            <div class="stat-value" style="font-size:0.95rem; word-break:break-all;">
              ${cfg.recipientResolved ? _escape(cfg.recipientResolved) : '<span class="text-danger">NOT CONFIGURED</span>'}
            </div>
            <div class="small text-muted mt-1">
              Set <code>REPORT_EMAIL</code>
            </div>
          </div>
        </div>
      </div>

      <div class="mt-3">${cfgPills}</div>

      ${s.lastDailyError ? `<div class="alert alert-warning mt-3 mb-0 py-2 small"><strong>Last daily error:</strong> ${_escape(s.lastDailyError)}</div>` : ''}
      ${s.lastWeeklyError ? `<div class="alert alert-warning mt-2 mb-0 py-2 small"><strong>Last weekly error:</strong> ${_escape(s.lastWeeklyError)}</div>` : ''}

      ${lastDaily ? `
        <div class="small text-muted mt-3">
          <strong>Last daily period:</strong>
          ${_formatTime(lastDaily.periodStart)} → ${_formatTime(lastDaily.periodEnd)}
        </div>
      ` : ''}
      ${lastWeekly ? `
        <div class="small text-muted mt-1">
          <strong>Last weekly period:</strong>
          ${_formatTime(lastWeekly.periodStart)} → ${_formatTime(lastWeekly.periodEnd)}
        </div>
      ` : ''}
    `;
  }

  function _renderReportsFailures(failures) {
    const card = document.getElementById('rptFailuresCard');
    const body = document.getElementById('rptFailuresBody');
    if (!card || !body) return;

    if (!Array.isArray(failures) || failures.length === 0) {
      card.style.display = 'none';
      return;
    }

    card.style.display = 'block';
    body.innerHTML = `
      <table class="table table-sm table-striped mb-0">
        <thead>
          <tr>
            <th>Type</th>
            <th>Period</th>
            <th>Error</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          ${failures.map(f => `
            <tr>
              <td><span class="badge bg-secondary">${_escape(f.type)}</span></td>
              <td class="small">${_formatTime(f.periodStart)} → ${_formatTime(f.periodEnd)}</td>
              <td class="small text-danger">${_escape(f.error)}</td>
              <td class="small text-muted">${_formatRelative(f.at)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  async function _triggerReport(type) {
    const btn = document.getElementById(
      type === 'daily' ? 'rptSendDailyBtn'
      : type === 'weekly' ? 'rptSendWeeklyBtn'
      : 'rptSendCustomBtn'
    );
    if (!btn) return;

    let payload = { type };
    if (type === 'custom') {
      const fromEl = document.getElementById('rptCustomFrom');
      const toEl = document.getElementById('rptCustomTo');
      const from = fromEl && fromEl.value ? new Date(fromEl.value) : null;
      const to = toEl && toEl.value ? new Date(toEl.value) : null;
      if (!from || !to) { _toast('Please select both From and To dates', 'warn'); return; }
      if (to <= from) { _toast('"To" must be after "From"', 'warn'); return; }
      payload.from = from.toISOString();
      payload.to = to.toISOString();
    }

    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';

    try {
      const res = await _postJson('/api/reports/send-now', payload);
      const result = res.result || {};
      if (result.skipped) {
        _toast(`Report skipped: ${result.reason || 'already sent'}`, 'warn');
      } else if (result.success) {
        _toast(`✅ ${type} report sent`, 'success');
        _refreshReports();
      } else {
        _toast(`Failed: ${result.error || 'unknown'}`, 'error');
      }
    } catch (err) {
      _toast(`Failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }

  function _wireReportsHandlers() {
    document.getElementById('rptRefreshBtn')?.addEventListener('click', _refreshReports);
    document.getElementById('rptSendDailyBtn')?.addEventListener('click', () => _triggerReport('daily'));
    document.getElementById('rptSendWeeklyBtn')?.addEventListener('click', () => _triggerReport('weekly'));
    document.getElementById('rptSendCustomBtn')?.addEventListener('click', () => _triggerReport('custom'));
  }

  // ── Security panel ──────────────────────────────────────

  async function _refreshSecurity() {
    if (_inFlight.security) return;
    _inFlight.security = true;
    try {
      const statusData = await _getJson('/api/security/status');
      _renderSecurityStatus(statusData);

      const params = new URLSearchParams();
      if (_securityFilters.severity) params.set('severity', _securityFilters.severity);
      if (_securityFilters.eventType) params.set('eventType', _securityFilters.eventType);
      params.set('since', new Date(Date.now() - _securityFilters.windowMs).toISOString());
      params.set('limit', String(PAGE_SIZE));
      params.set('skip', String(_securityPage * PAGE_SIZE));

      const eventsData = await _getJson('/api/security/events?' + params.toString());
      _renderSecurityEvents(eventsData);
    } catch (err) {
      const body = document.getElementById('secStatusBody');
      if (body) body.innerHTML = `<div class="alert alert-danger mb-0">Failed to load security status: ${_escape(err.message)}</div>`;
    } finally {
      _inFlight.security = false;
    }
  }

  function _renderSecurityStatus(data) {
    const body = document.getElementById('secStatusBody');
    if (!body) return;

    const runningBadge = data.running
      ? '<span class="badge bg-success">RUNNING</span>'
      : '<span class="badge bg-danger">STOPPED</span>';
    const afterHoursBadge = data.isAfterHoursNow
      ? '<span class="badge bg-warning text-dark">AFTER-HOURS</span>'
      : '<span class="badge bg-light text-muted">BUSINESS HOURS</span>';

    const t = data.thresholds || {};
    const a = data.alerts || {};

    body.innerHTML = `
      <div class="row g-3">
        <div class="col-md-3">
          <div class="stat-card">
            <div class="stat-label">Monitor</div>
            <div class="stat-value">${runningBadge}</div>
            <div class="small text-muted mt-1">TZ: ${_escape(data.timezone || 'Africa/Nairobi')}</div>
          </div>
        </div>
        <div class="col-md-3">
          <div class="stat-card">
            <div class="stat-label">Current Hour EAT</div>
            <div class="stat-value">${data.currentHourEat ?? '?'}:00</div>
            <div class="small text-muted mt-1">${afterHoursBadge}</div>
          </div>
        </div>
        <div class="col-md-3">
          <div class="stat-card">
            <div class="stat-label">Alerts Sent</div>
            <div class="stat-value text-success">${a.sent ?? 0}</div>
            <div class="small text-muted mt-1">
              Failed: ${a.failed ?? 0} · Suppressed: ${a.suppressed ?? 0}
            </div>
          </div>
        </div>
        <div class="col-md-3">
          <div class="stat-card">
            <div class="stat-label">Recipient</div>
            <div class="stat-value" style="font-size:0.95rem;">
              ${data.recipientConfigured ? '<span class="text-success">CONFIGURED</span>' : '<span class="text-danger">NOT CONFIGURED</span>'}
            </div>
            <div class="small text-muted mt-1">
              ${a.lastAlertAt ? `Last: ${_formatRelative(a.lastAlertAt)}` : 'No alerts yet'}
            </div>
          </div>
        </div>
      </div>

      <div class="mt-3 d-flex flex-wrap gap-2">
        <span class="badge bg-light text-dark" title="Successful logins before IP is trusted">
          Trust threshold: ${t.trustThreshold ?? '?'}
        </span>
        <span class="badge bg-light text-dark" title="After-hours login detection window">
          After-hours: ${_escape(t.afterHoursWindowEat || '?')}
        </span>
        <span class="badge bg-light text-dark" title="Failures from same IP">
          Failure storm: ${_escape(t.failureStorm || '?')}
        </span>
        <span class="badge bg-light text-dark" title="Distinct IPs failing">
          Distributed: ${_escape(t.distributedAttack || '?')}
        </span>
        <span class="badge bg-light text-dark" title="Account switch spam">
          Switch spam: ${_escape(t.accountSwitchSpam || '?')}
        </span>
        <span class="badge bg-light text-dark" title="IPs tracked for rapid login/logout">
          Tracked IPs: ${data.tracking?.ipsTrackedForRapidLogout ?? 0}
        </span>
      </div>
    `;
  }

  function _severityBadge(sev) {
    if (sev === 'critical') return '<span class="badge bg-danger">CRITICAL</span>';
    if (sev === 'warning')  return '<span class="badge bg-warning text-dark">WARNING</span>';
    return '<span class="badge bg-info text-dark">INFO</span>';
  }

  function _renderSecurityEvents(data) {
    const body = document.getElementById('secEventsBody');
    const countEl = document.getElementById('secEventCount');
    const pageEl = document.getElementById('secPageNum');
    if (!body) return;

    if (countEl) countEl.textContent = String(data.total || 0);
    if (pageEl) pageEl.textContent = String(_securityPage + 1);

    const events = data.events || [];
    if (events.length === 0) {
      body.innerHTML = '<p class="text-muted p-3">No events in this range.</p>';
      return;
    }

    body.innerHTML = `
      <table class="table table-sm table-striped mb-0">
        <thead>
          <tr>
            <th>Time</th>
            <th>Severity</th>
            <th>Type</th>
            <th>IP</th>
            <th>Message</th>
            <th class="text-center">Alerted</th>
          </tr>
        </thead>
        <tbody>
          ${events.map(e => `
            <tr>
              <td class="small text-muted" title="${_escape(e.at)}">
                ${_formatRelative(e.at)}
              </td>
              <td>${_severityBadge(e.severity)}</td>
              <td class="small"><code>${_escape(e.eventType)}</code></td>
              <td class="small" style="font-family:monospace;">${_escape(e.ip || '—')}</td>
              <td class="small">${_escape(e.message || '')}</td>
              <td class="text-center">
                ${e.alerted
                  ? '<i class="fas fa-check-circle text-success" title="Alert email sent"></i>'
                  : '<span class="text-muted">—</span>'}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function _wireSecurityHandlers() {
    document.getElementById('secRefreshBtn')?.addEventListener('click', _refreshSecurity);

    document.getElementById('secFilterSeverity')?.addEventListener('change', (e) => {
      _securityFilters.severity = e.target.value;
      _securityPage = 0;
      _refreshSecurity();
    });
    document.getElementById('secFilterType')?.addEventListener('change', (e) => {
      _securityFilters.eventType = e.target.value;
      _securityPage = 0;
      _refreshSecurity();
    });
    document.getElementById('secFilterWindow')?.addEventListener('change', (e) => {
      _securityFilters.windowMs = parseInt(e.target.value, 10) || 24 * 60 * 60 * 1000;
      _securityPage = 0;
      _refreshSecurity();
    });

    document.getElementById('secPrevPage')?.addEventListener('click', () => {
      if (_securityPage > 0) { _securityPage--; _refreshSecurity(); }
    });
    document.getElementById('secNextPage')?.addEventListener('click', () => {
      _securityPage++; _refreshSecurity();
    });
  }

  // ── Init ─────────────────────────────────────────────────

  function _init() {
    if (_initialized) return;
    _initialized = true;

    _injectSidebarButtons();
    _injectSections();
    _wireNavigation();
    _wireReportsHandlers();
    _wireSecurityHandlers();

    console.log('[Reports] Reports + Security tabs injected');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    // DOM already ready (script loaded async) — init immediately
    _init();
  }
})();
