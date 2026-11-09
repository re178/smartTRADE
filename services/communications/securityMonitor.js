// services/communications/securityMonitor.js
// [v2.0.1] Hardened status + load-time sentinel.
// (Detection logic identical to v2.0.0)

'use strict';

const { sendEmail } = require('../../shared/emailProvider');
const SecurityEvent = require('../../models/SecurityEvent');
const logger = require('../../infrastructure/logger') || console;

const _VERSION = '2.0.1';

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────
const TZ_OFFSET_MS = 3 * 60 * 60 * 1000;
const TIMEZONE = 'Africa/Nairobi';
const TRUST_THRESHOLD = 2;
const AFTER_HOURS_START_EAT = 22;
const AFTER_HOURS_END_EAT = 6;
const FAILURE_STORM_COUNT = 3;
const FAILURE_STORM_WINDOW_MS = 15 * 60 * 1000;
const DISTRIBUTED_ATTACK_IPS = 5;
const DISTRIBUTED_ATTACK_WINDOW_MS = 15 * 60 * 1000;
const CONCURRENT_SESSION_WINDOW_MS = 60 * 60 * 1000;
const RAPID_LOGIN_LOGOUT_WINDOW_MS = 10 * 1000;
const ACCOUNT_SWITCH_SPAM_COUNT = 3;
const ACCOUNT_SWITCH_SPAM_WINDOW_MS = 5 * 60 * 1000;

const MAX_TRACKED_IPS = 100;
const _lastLoginByIp = new Map();

const SEV_COLORS = {
  critical: { bg: '#fef2f2', border: '#fecaca', text: '#991b1b', icon: '🚨' },
  warning:  { bg: '#fef3c7', border: '#fde68a', text: '#92400e', icon: '⚠️' },
  info:     { bg: '#eff6ff', border: '#bfdbfe', text: '#1e40af', icon: 'ℹ️' },
};

function _resolveAlertRecipient() {
  return (
    process.env.RTS_NOTIFY_EMAIL ||
    process.env.ALERT_EMAIL ||
    process.env.SUPPORT_EMAIL ||
    null
  );
}

function _currentHourEat() {
  const eat = new Date(Date.now() + TZ_OFFSET_MS);
  return eat.getUTCHours();
}

function _isAfterHours() {
  const h = _currentHourEat();
  return h >= AFTER_HOURS_START_EAT || h < AFTER_HOURS_END_EAT;
}

function _formatDateTimeEat(date = new Date()) {
  try {
    return new Date(date).toLocaleString('en-GB', {
      timeZone: TIMEZONE,
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch (_) { return new Date(date).toISOString(); }
}

function _formatTimeAgo(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)} min`;
  return `${Math.round(ms / 3600000)}h`;
}

function _escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _trackLoginForRapidLogout(ip) {
  if (!ip) return;
  _lastLoginByIp.set(ip, Date.now());
  if (_lastLoginByIp.size > MAX_TRACKED_IPS) {
    const entries = Array.from(_lastLoginByIp.entries()).sort((a, b) => a[1] - b[1]);
    for (const [oldIp] of entries.slice(0, _lastLoginByIp.size - MAX_TRACKED_IPS)) {
      _lastLoginByIp.delete(oldIp);
    }
  }
}

function _buildAlertEmail({ eventType, severity, title, summary, context }) {
  const colors = SEV_COLORS[severity] || SEV_COLORS.info;
  const ts = _formatDateTimeEat();
  let contextHtml = '';
  if (context && typeof context === 'object') {
    const rows = Object.entries(context)
      .filter(([k, v]) => v != null && k !== 'relatedEventId')
      .map(([k, v]) => {
        let val = v;
        if (Array.isArray(v)) val = v.join(', ');
        else if (typeof v === 'object') val = JSON.stringify(v);
        return `<tr><td style="padding:6px 12px 6px 0; color:#6b7a8f; font-size:12px; font-weight:500; white-space:nowrap; vertical-align:top;">${_escapeHtml(k)}</td><td style="padding:6px 0; font-size:12px; color:#1e2a41; font-family:monospace; word-break:break-all;">${_escapeHtml(String(val))}</td></tr>`;
      });
    if (rows.length > 0) {
      contextHtml = `<div style="margin-top:20px;"><div style="font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:#6b7a8f; font-weight:700; margin-bottom:8px;">Context</div><table style="width:100%; border-collapse:collapse;">${rows.join('')}</table></div>`;
    }
  }
  return `
    <div style="max-width:600px; margin:0 auto; padding:24px; font-family:-apple-system,BlinkMacSystemFont,'Inter',Arial,sans-serif; color:#1e2a41; background:#fff;">
      <div style="background:${colors.bg}; border:1px solid ${colors.border}; border-radius:10px; padding:20px; margin-bottom:20px;">
        <div style="display:flex; align-items:center; gap:10px;">
          <span style="font-size:28px;">${colors.icon}</span>
          <div>
            <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:${colors.text}; font-weight:700;">${_escapeHtml(severity)} · RTS Security Alert</div>
            <h1 style="margin:4px 0 0; font-size:20px; color:${colors.text};">${_escapeHtml(title)}</h1>
          </div>
        </div>
      </div>
      <p style="font-size:14px; line-height:1.6; color:#1e2a41; margin:0 0 16px;">${_escapeHtml(summary)}</p>
      <div style="background:#f8fafc; border:1px solid #e9edf2; border-radius:8px; padding:14px 18px; margin:16px 0;">
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
          <tr><td style="padding:4px 12px 4px 0; color:#6b7a8f; font-weight:500;">Event Type</td><td style="padding:4px 0; font-weight:600; font-family:monospace;">${_escapeHtml(eventType)}</td></tr>
          <tr><td style="padding:4px 12px 4px 0; color:#6b7a8f; font-weight:500;">Severity</td><td style="padding:4px 0; font-weight:700; color:${colors.text}; text-transform:uppercase;">${_escapeHtml(severity)}</td></tr>
          <tr><td style="padding:4px 12px 4px 0; color:#6b7a8f; font-weight:500;">Detected</td><td style="padding:4px 0; font-weight:600;">${_escapeHtml(ts)} EAT</td></tr>
        </table>
      </div>
      ${contextHtml}
      <div style="margin-top:24px; padding:14px 18px; background:#fef3c7; border:1px solid #fde68a; border-radius:8px; font-size:12px; color:#92400e; line-height:1.6;">
        <strong>⚠️ If this wasn't you:</strong><br>
        1. Change your dashboard password immediately<br>
        2. Review recent trades and open positions<br>
        3. Check that no unauthorized account switches occurred<br>
        4. Verify all bot configurations are still correct
      </div>
      <p style="margin-top:24px; font-size:11px; color:#94a3b8; text-align:center;">RTS Security Monitor v${_VERSION} · ${_escapeHtml(ts)} EAT</p>
    </div>
  `;
}

class SecurityMonitor {
  constructor() {
    this._started = false;
    this._alertsSent = 0;
    this._alertsFailed = 0;
    this._alertsSuppressed = 0;
    this._lastAlertAt = null;
  }

  start() {
    if (this._started) return;
    this._started = true;
    const recipient = _resolveAlertRecipient();
    if (!recipient) {
      logger.warn(`[SecurityMonitor] v${_VERSION} Started but NO ALERT RECIPIENT configured`);
      logger.warn('[SecurityMonitor] Set RTS_NOTIFY_EMAIL or ALERT_EMAIL to receive alerts');
    } else {
      logger.info(`[SecurityMonitor] v${_VERSION} Started (recipient configured)`);
      logger.info(
        `[SecurityMonitor] Thresholds: trust=${TRUST_THRESHOLD} logins, ` +
        `failure-storm=${FAILURE_STORM_COUNT}/${FAILURE_STORM_WINDOW_MS/60000}min, ` +
        `distributed=${DISTRIBUTED_ATTACK_IPS}IPs/${DISTRIBUTED_ATTACK_WINDOW_MS/60000}min, ` +
        `after-hours=${AFTER_HOURS_START_EAT}:00–${AFTER_HOURS_END_EAT}:00 EAT`
      );
    }
  }

  stop() {
    this._started = false;
    _lastLoginByIp.clear();
    logger.info('[SecurityMonitor] Stopped');
  }

  async onLoginSuccess(ip, userAgent, username) {
    try {
      const event = await SecurityEvent.record({
        ip, userAgent, username, userId: 'admin',
        eventType: 'login_success', severity: 'info',
        message: 'Successful login',
      });
      _trackLoginForRapidLogout(ip);
      await this._detectNewIpLogin(ip, event);
      await this._detectConcurrentSessions('admin', ip);
      await this._detectAfterHours(ip, event);
      await this._maybeMarkIpTrusted(ip);
      return event;
    } catch (err) {
      logger.error(`[SecurityMonitor] onLoginSuccess failed: ${err.message}`);
      return null;
    }
  }

  async onLoginFailure(ip, userAgent, reason, username) {
    try {
      const event = await SecurityEvent.record({
        ip, userAgent, username, userId: 'admin',
        eventType: 'login_failure', severity: 'warning',
        message: reason || 'Login failed',
        context: { reason: reason || 'unknown' },
      });
      await this._detectFailureStorm(ip, event);
      await this._detectDistributedAttack();
      return event;
    } catch (err) {
      logger.error(`[SecurityMonitor] onLoginFailure failed: ${err.message}`);
      return null;
    }
  }

  async onLoginRateLimited(ip, userAgent, username) {
    try {
      return await SecurityEvent.record({
        ip, userAgent, username, userId: 'admin',
        eventType: 'login_rate_limited', severity: 'warning',
        message: 'Login blocked by rate limiter',
      });
    } catch (err) {
      logger.error(`[SecurityMonitor] onLoginRateLimited failed: ${err.message}`);
      return null;
    }
  }

  async onLogout(ip) {
    try {
      const event = await SecurityEvent.record({
        ip, userId: 'admin', eventType: 'logout', severity: 'info',
        message: 'Explicit logout',
      });
      await this._detectRapidLoginLogout(ip, event);
      _lastLoginByIp.delete(ip);
      return event;
    } catch (err) {
      logger.error(`[SecurityMonitor] onLogout failed: ${err.message}`);
      return null;
    }
  }

  async onAccountSwitch(ip, fromType, toType, success) {
    try {
      const event = await SecurityEvent.record({
        ip, userId: 'admin',
        eventType: success ? 'account_switch' : 'account_switch_failed',
        severity: success ? 'info' : 'warning',
        message: success ? `Account switch ${fromType} → ${toType}` : `Account switch rejected: ${fromType} → ${toType}`,
        context: { fromType, toType, success: !!success },
      });
      if (success) await this._detectAccountSwitchSpam(ip);
      return event;
    } catch (err) {
      logger.error(`[SecurityMonitor] onAccountSwitch failed: ${err.message}`);
      return null;
    }
  }

  async _detectNewIpLogin(ip, sourceEvent) {
    try {
      if (!ip) return;
      const seenBefore = await SecurityEvent.wasIpEverSeenBefore(ip);
      if (seenBefore) return;
      const newEvent = await SecurityEvent.record({
        ip, userId: 'admin', eventType: 'new_ip_login', severity: 'critical',
        message: `First successful login from IP ${ip}`,
        context: { ip, firstLogin: true, relatedEventId: sourceEvent?._id ? String(sourceEvent._id) : null },
      });
      await this._sendAlert({
        eventType: 'new_ip_login', severity: 'critical',
        title: 'New IP Login Detected',
        summary: `A successful login was detected from an IP address (${ip}) that has never logged into your dashboard before. If this wasn't you, your password may be compromised.`,
        context: { ip, username: sourceEvent?.username || 'admin' },
        relatedEventId: newEvent?._id,
        identifier: ip, identifierField: 'ip',
      });
    } catch (err) {
      logger.warn(`[SecurityMonitor] new-IP detection failed: ${err.message}`);
    }
  }

  async _detectConcurrentSessions(userId, currentIp) {
    try {
      const activeIps = await SecurityEvent.activeIpsForUser(userId, CONCURRENT_SESSION_WINDOW_MS);
      if (!Array.isArray(activeIps) || activeIps.length < 2) return;
      let hasUntrusted = false;
      for (const rec of activeIps) {
        const trusted = await SecurityEvent.isIpTrusted(rec.ip, TRUST_THRESHOLD);
        if (!trusted) { hasUntrusted = true; break; }
      }
      if (!hasUntrusted) return;
      const ips = activeIps.map(r => r.ip);
      const newEvent = await SecurityEvent.record({
        ip: currentIp, userId, eventType: 'concurrent_sessions', severity: 'warning',
        message: `Concurrent sessions from ${activeIps.length} IPs in last hour`,
        context: { ips, count: activeIps.length },
      });
      await this._sendAlert({
        eventType: 'concurrent_sessions', severity: 'warning',
        title: 'Multiple Concurrent Sessions',
        summary: `Your account is active from ${activeIps.length} different IP addresses in the last hour, including at least one that has not been used enough times to be trusted. This may indicate someone else is using your credentials.`,
        context: { userId, activeIps: ips, window: `${CONCURRENT_SESSION_WINDOW_MS / 60000} min` },
        relatedEventId: newEvent?._id,
        identifier: userId, identifierField: 'userId',
      });
    } catch (err) {
      logger.warn(`[SecurityMonitor] concurrent-session detection failed: ${err.message}`);
    }
  }

  async _detectFailureStorm(ip, sourceEvent) {
    try {
      if (!ip) return;
      const count = await SecurityEvent.recentFailureCount(ip, FAILURE_STORM_WINDOW_MS);
      if (count < FAILURE_STORM_COUNT) return;
      const newEvent = await SecurityEvent.record({
        ip, userId: 'admin', eventType: 'failure_storm', severity: 'critical',
        message: `${count} login failures from IP ${ip} in last ${FAILURE_STORM_WINDOW_MS / 60000} min`,
        context: { ip, count, windowMs: FAILURE_STORM_WINDOW_MS },
      });
      await this._sendAlert({
        eventType: 'failure_storm', severity: 'critical',
        title: 'Repeated Login Failures',
        summary: `${count} failed login attempts have been detected from a single IP address (${ip}) within the last ${FAILURE_STORM_WINDOW_MS / 60000} minutes. This pattern strongly suggests a brute-force password attack.`,
        context: { ip, failureCount: count, window: `${FAILURE_STORM_WINDOW_MS / 60000} min`, lastFailureReason: sourceEvent?.context?.reason || null },
        relatedEventId: newEvent?._id,
        identifier: ip, identifierField: 'ip',
      });
    } catch (err) {
      logger.warn(`[SecurityMonitor] failure-storm detection failed: ${err.message}`);
    }
  }

  async _detectDistributedAttack() {
    try {
      const count = await SecurityEvent.distinctFailureIps(DISTRIBUTED_ATTACK_WINDOW_MS);
      if (count < DISTRIBUTED_ATTACK_IPS) return;
      const newEvent = await SecurityEvent.record({
        ip: 'distributed', userId: 'admin', eventType: 'distributed_attack', severity: 'critical',
        message: `Login failures from ${count} distinct IPs in last ${DISTRIBUTED_ATTACK_WINDOW_MS / 60000} min`,
        context: { distinctIps: count, windowMs: DISTRIBUTED_ATTACK_WINDOW_MS },
      });
      await this._sendAlert({
        eventType: 'distributed_attack', severity: 'critical',
        title: 'Distributed Attack Detected',
        summary: `Login failures have been observed from ${count} different IP addresses within the last ${DISTRIBUTED_ATTACK_WINDOW_MS / 60000} minutes. This suggests a coordinated distributed attack targeting your dashboard.`,
        context: { distinctIps: count, window: `${DISTRIBUTED_ATTACK_WINDOW_MS / 60000} min` },
        relatedEventId: newEvent?._id,
        identifier: 'admin', identifierField: 'userId',
      });
    } catch (err) {
      logger.warn(`[SecurityMonitor] distributed-attack detection failed: ${err.message}`);
    }
  }

  async _detectAfterHours(ip, sourceEvent) {
    try {
      if (!_isAfterHours()) return;
      const hour = _currentHourEat();
      const newEvent = await SecurityEvent.record({
        ip, userId: 'admin', eventType: 'after_hours_login', severity: 'info',
        message: `Login at ${hour}:00 EAT (after-hours window ${AFTER_HOURS_START_EAT}:00–${AFTER_HOURS_END_EAT}:00 EAT)`,
        context: { ip, hourEat: hour },
      });
      await this._sendAlert({
        eventType: 'after_hours_login', severity: 'info',
        title: 'After-Hours Login',
        summary: `A login was detected at ${hour}:00 EAT, which is outside your typical usage window (${AFTER_HOURS_START_EAT}:00–${AFTER_HOURS_END_EAT}:00 EAT). This is informational — no action needed if this was you.`,
        context: { ip, hourEat: hour, username: sourceEvent?.username || 'admin' },
        relatedEventId: newEvent?._id,
        identifier: 'admin', identifierField: 'userId',
      });
    } catch (err) {
      logger.warn(`[SecurityMonitor] after-hours detection failed: ${err.message}`);
    }
  }

  async _detectRapidLoginLogout(ip, sourceEvent) {
    try {
      if (!ip) return;
      const lastLoginAt = _lastLoginByIp.get(ip);
      if (!lastLoginAt) return;
      const delta = Date.now() - lastLoginAt;
      if (delta > RAPID_LOGIN_LOGOUT_WINDOW_MS) return;
      const newEvent = await SecurityEvent.record({
        ip, userId: 'admin', eventType: 'rapid_login_logout', severity: 'warning',
        message: `Login → logout within ${_formatTimeAgo(delta)} from ${ip}`,
        context: { ip, deltaMs: delta },
      });
      await this._sendAlert({
        eventType: 'rapid_login_logout', severity: 'warning',
        title: 'Rapid Login/Logout Pattern',
        summary: `A login followed by an immediate logout was detected within ${_formatTimeAgo(delta)} from IP ${ip}. This may indicate a probing session, automated credential check, or someone testing access.`,
        context: { ip, secondsSinceLogin: Math.round(delta / 1000), relatedLogoutEvent: sourceEvent?._id ? String(sourceEvent._id) : null },
        relatedEventId: newEvent?._id,
        identifier: ip, identifierField: 'ip',
      });
    } catch (err) {
      logger.warn(`[SecurityMonitor] rapid-login-logout detection failed: ${err.message}`);
    }
  }

  async _detectAccountSwitchSpam(ip) {
    try {
      const since = new Date(Date.now() - ACCOUNT_SWITCH_SPAM_WINDOW_MS);
      const count = await SecurityEvent.countDocuments({
        userId: 'admin', eventType: 'account_switch', createdAt: { $gte: since },
      });
      if (count < ACCOUNT_SWITCH_SPAM_COUNT) return;
      const newEvent = await SecurityEvent.record({
        ip, userId: 'admin', eventType: 'account_switch_spam', severity: 'warning',
        message: `${count} account switches in last ${ACCOUNT_SWITCH_SPAM_WINDOW_MS / 60000} min`,
        context: { ip, count, windowMs: ACCOUNT_SWITCH_SPAM_WINDOW_MS },
      });
      await this._sendAlert({
        eventType: 'account_switch_spam', severity: 'warning',
        title: 'Repeated Account Switching',
        summary: `${count} account switches have been detected within ${ACCOUNT_SWITCH_SPAM_WINDOW_MS / 60000} minutes. This may indicate automated probing or a compromised session rapidly toggling between demo and real.`,
        context: { switchCount: count, window: `${ACCOUNT_SWITCH_SPAM_WINDOW_MS / 60000} min`, lastIp: ip },
        relatedEventId: newEvent?._id,
        identifier: 'admin', identifierField: 'userId',
      });
    } catch (err) {
      logger.warn(`[SecurityMonitor] account-switch-spam detection failed: ${err.message}`);
    }
  }

  async _maybeMarkIpTrusted(ip) {
    try {
      if (!ip) return;
      const successCount = await SecurityEvent.successCountForIp(ip);
      if (successCount < TRUST_THRESHOLD) return;
      const already = await SecurityEvent.countDocuments({ ip, eventType: 'ip_trusted' });
      if (already > 0) return;
      await SecurityEvent.record({
        ip, userId: 'admin', eventType: 'ip_trusted', severity: 'info',
        message: `IP ${ip} trusted after ${successCount} successful logins`,
        context: { ip, successCount, threshold: TRUST_THRESHOLD },
      });
      logger.info(`[SecurityMonitor] IP ${ip} → trusted (${successCount} logins, threshold ${TRUST_THRESHOLD})`);
    } catch (err) {
      logger.warn(`[SecurityMonitor] trust-marking failed: ${err.message}`);
    }
  }

  async _sendAlert({ eventType, severity, title, summary, context, relatedEventId, identifier, identifierField }) {
    const recipient = _resolveAlertRecipient();
    if (!recipient) {
      logger.warn(`[SecurityMonitor] No alert recipient — ${eventType} alert not sent`);
      this._alertsFailed++;
      return false;
    }
    try {
      const canAlert = await SecurityEvent.canAlert(eventType, identifier, identifierField || 'ip');
      if (!canAlert) {
        this._alertsSuppressed++;
        logger.info(`[SecurityMonitor] ${eventType} alert suppressed (cooldown active for ${identifier})`);
        return false;
      }
    } catch (err) {
      logger.warn(`[SecurityMonitor] cooldown check failed: ${err.message}`);
    }
    const prefix = severity === 'critical' ? '🚨 [RTS ALERT]'
                 : severity === 'warning'  ? '⚠️ [RTS WARN]'
                 : 'ℹ️ [RTS INFO]';
    const subject = `${prefix} ${title}`;
    const html = _buildAlertEmail({ eventType, severity, title, summary, context });
    let result;
    try { result = await sendEmail(recipient, subject, html); }
    catch (err) {
      logger.error(`[SecurityMonitor] sendEmail threw for ${eventType}: ${err.message}`);
      this._alertsFailed++;
      return false;
    }
    if (result && result.success) {
      this._alertsSent++;
      this._lastAlertAt = new Date().toISOString();
      logger.info(`[SecurityMonitor] ✅ ${eventType} alert sent (msgId=${result.messageId || 'n/a'})`);
      if (relatedEventId) {
        try { await SecurityEvent.markAlerted(relatedEventId); } catch (_) {}
      }
      return true;
    }
    this._alertsFailed++;
    logger.error(`[SecurityMonitor] ❌ ${eventType} alert failed: ${result?.error || 'unknown'}`);
    if (relatedEventId) {
      try { await SecurityEvent.markAlerted(relatedEventId, { error: result?.error || 'unknown' }); } catch (_) {}
    }
    return false;
  }

  // [v2.0.1] Defensive getStatus — never throws, always includes `alerts`.
  getStatus() {
    try {
      const recipient = (typeof _resolveAlertRecipient === 'function')
        ? _resolveAlertRecipient() : null;
      return {
        version: _VERSION,
        running: this._started,
        timezone: TIMEZONE,
        recipientConfigured: !!recipient,
        currentHourEat: _currentHourEat(),
        isAfterHoursNow: _isAfterHours(),
        thresholds: {
          trustThreshold: TRUST_THRESHOLD,
          afterHoursWindowEat: `${AFTER_HOURS_START_EAT}:00–${AFTER_HOURS_END_EAT}:00`,
          failureStorm: `${FAILURE_STORM_COUNT} failures / ${FAILURE_STORM_WINDOW_MS / 60000} min`,
          distributedAttack: `${DISTRIBUTED_ATTACK_IPS} IPs / ${DISTRIBUTED_ATTACK_WINDOW_MS / 60000} min`,
          concurrentSessions: `${CONCURRENT_SESSION_WINDOW_MS / 60000} min window`,
          rapidLoginLogout: `${RAPID_LOGIN_LOGOUT_WINDOW_MS / 1000}s window`,
          accountSwitchSpam: `${ACCOUNT_SWITCH_SPAM_COUNT} switches / ${ACCOUNT_SWITCH_SPAM_WINDOW_MS / 60000} min`,
        },
        alerts: {
          sent: this._alertsSent ?? 0,
          failed: this._alertsFailed ?? 0,
          suppressed: this._alertsSuppressed ?? 0,
          lastAlertAt: this._lastAlertAt ?? null,
        },
        tracking: {
          ipsTrackedForRapidLogout: _lastLoginByIp.size,
        },
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      return {
        version: _VERSION,
        running: !!this._started,
        error: err.message,
        alerts: { sent: this._alertsSent ?? 0, failed: this._alertsFailed ?? 0, suppressed: this._alertsSuppressed ?? 0, lastAlertAt: this._lastAlertAt ?? null },
        timestamp: new Date().toISOString(),
      };
    }
  }
}

const securityMonitor = new SecurityMonitor();

// [v2.0.1] Load-time sentinel — proves the file loaded.
try {
  logger.info(`[SecurityMonitor] v${_VERSION} module loaded`);
} catch (_) {
  console.log(`[SecurityMonitor] v${_VERSION} module loaded`);
}

module.exports = securityMonitor;
module.exports.SecurityMonitor = SecurityMonitor;
module.exports._isAfterHours = _isAfterHours;
module.exports._currentHourEat = _currentHourEat;
module.exports._resolveAlertRecipient = _resolveAlertRecipient;
module.exports.TRUST_THRESHOLD = TRUST_THRESHOLD;
module.exports.VERSION = _VERSION;
