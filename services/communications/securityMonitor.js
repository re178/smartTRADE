// services/communications/securityMonitor.js
'use strict';

const { sendEmail } = require('../../shared/emailProvider');
const SecurityEvent = require('../../models/SecurityEvent');
const logger = require('../../infrastructure/logger') || console;

// Constants
const TZ_OFFSET_MS = 3 * 60 * 60 * 1000;    // EAT = UTC+3
const TRUST_THRESHOLD = 2;                    // 2nd login → trusted
const AFTER_HOURS_START_HOUR_EAT = 22;
const AFTER_HOURS_END_HOUR_EAT = 6;
const FAILURE_STORM_COUNT = 3;
const FAILURE_STORM_WINDOW_MS = 15 * 60 * 1000;
const DISTRIBUTED_ATTACK_IPS = 5;
const DISTRIBUTED_ATTACK_WINDOW_MS = 15 * 60 * 1000;
const CONCURRENT_SESSION_WINDOW_MS = 60 * 60 * 1000;
const RAPID_LOGIN_LOGOUT_WINDOW_MS = 10 * 1000;
const ACCOUNT_SWITCH_SPAM_COUNT = 3;
const ACCOUNT_SWITCH_SPAM_WINDOW_MS = 5 * 60 * 1000;

class SecurityMonitor {
  constructor() {
    this._lastLoginByIp = new Map();   // ip → timestamp (for rapid logout detect)
  }
  
  // Alert recipient resolution
  _resolveAlertRecipient() {
    return (
      process.env.RTS_NOTIFY_EMAIL ||
      process.env.ALERT_EMAIL ||
      process.env.SUPPORT_EMAIL ||
      null
    );
  }
  
  // EAT hour
  _currentHourEat() {
    const eat = new Date(Date.now() + TZ_OFFSET_MS);
    return eat.getUTCHours();
  }
  
  _isAfterHours() {
    const h = this._currentHourEat();
    // 22:00 - 06:00 (wraps midnight)
    return h >= AFTER_HOURS_START_HOUR_EAT || h < AFTER_HOURS_END_HOUR_EAT;
  }
  
  // Format helpers
  _formatDateTime(date = new Date()) {
    try {
      return new Date(date).toLocaleString('en-GB', {
        timeZone: 'Africa/Nairobi',
        year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    } catch (_) { return new Date(date).toISOString(); }
  }
  
  _escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  
  // ── Alert sender ──
  async _sendAlert(eventType, severity, title, summary, context = {}, relatedEventId = null) {
    const recipient = this._resolveAlertRecipient();
    if (!recipient) {
      logger.error(`[SecurityMonitor] No alert recipient — cannot send ${eventType} alert`);
      return false;
    }
    
    // Cooldown check
    const identifier = context.ip || context.userId || 'global';
    const identifierField = context.ip ? 'ip' : 'userId';
    const canAlert = await SecurityEvent.canAlert(eventType, identifier, identifierField);
    if (!canAlert) {
      logger.info(`[SecurityMonitor] ${eventType} alert suppressed by cooldown (${identifier})`);
      return false;
    }
    
    const subject = `🚨 [RTS Security] ${title}`;
    const html = this._buildAlertEmail({ eventType, severity, title, summary, context });
    
    const result = await sendEmail(recipient, subject, html);
    
    if (result && result.success) {
      if (relatedEventId) {
        await SecurityEvent.markAlerted(relatedEventId);
      }
      logger.info(`[SecurityMonitor] ✅ Sent ${eventType} alert to ${recipient}`);
      return true;
    }
    
    logger.error(`[SecurityMonitor] ❌ Failed ${eventType} alert: ${result?.error || 'unknown'}`);
    return false;
  }
  
  _buildAlertEmail({ eventType, severity, title, summary, context }) {
    // pretty HTML
  }
  
  // ── Public API ──
  
  async onLoginSuccess(ip, userAgent, username) {
    try {
      // Always record first
      const event = await SecurityEvent.record({
        ip, userAgent, username, userId: 'admin',
        eventType: 'login_success',
        severity: 'info',
        message: 'Successful login',
      });
      
      // Track last login time for rapid-logout detection
      this._lastLoginByIp.set(ip, Date.now());
      
      // Detection chain
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
        eventType: 'login_failure',
        severity: 'warning',
        message: reason || 'Login failed',
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
        eventType: 'login_rate_limited',
        severity: 'warning',
        message: 'Login blocked by rate limiter',
      });
    } catch (_) { return null; }
  }
  
  async onLogout(ip) {
    try {
      const event = await SecurityEvent.record({
        ip, userId: 'admin',
        eventType: 'logout',
        severity: 'info',
        message: 'Explicit logout',
      });
      
      // Rapid logout detection
      await this._detectRapidLoginLogout(ip, event);
      this._lastLoginByIp.delete(ip);
      
      return event;
    } catch (_) { return null; }
  }
  
  async onAccountSwitch(ip, fromType, toType, success) {
    try {
      const event = await SecurityEvent.record({
        ip, userId: 'admin',
        eventType: success ? 'account_switch' : 'account_switch_failed',
        severity: success ? 'info' : 'warning',
        message: success
          ? `Account switch ${fromType} → ${toType}`
          : `Account switch rejected: ${fromType} → ${toType}`,
        context: { fromType, toType, success },
      });
      
      if (success) {
        await this._detectAccountSwitchSpam(ip);
      }
      
      return event;
    } catch (_) { return null; }
  }
  
  // ── Detectors ──
  
  async _detectNewIpLogin(ip, event) {
    const seenBefore = await SecurityEvent.wasIpEverSeenBefore(ip);
    if (seenBefore) return;    // not new
    
    // Record new_ip_login event
    const newEvent = await SecurityEvent.record({
      ip, userId: 'admin',
      eventType: 'new_ip_login',
      severity: 'critical',
      message: `First successful login from IP ${ip}`,
      context: { relatedEventId: event?._id },
    });
    
    // Alert (cooldown-aware)
    await this._sendAlert(
      'new_ip_login',
      'critical',
      'New IP Login Detected',
      `A successful login was detected from an IP address that has never logged in before. If this wasn't you, change your password immediately.`,
      { ip },
      newEvent?._id
    );
  }
  
  async _detectConcurrentSessions(userId, currentIp) {
    const activeIps = await SecurityEvent.activeIpsForUser(userId, CONCURRENT_SESSION_WINDOW_MS);
    if (activeIps.length < 2) return;
    
    // At least one non-trusted IP?
    let hasUntrusted = false;
    for (const rec of activeIps) {
      const trusted = await SecurityEvent.isIpTrusted(rec.ip, TRUST_THRESHOLD);
      if (!trusted) { hasUntrusted = true; break; }
    }
    if (!hasUntrusted) return;
    
    const newEvent = await SecurityEvent.record({
      ip: currentIp, userId,
      eventType: 'concurrent_sessions',
      severity: 'warning',
      message: `Concurrent sessions from ${activeIps.length} IPs in last hour`,
      context: { ips: activeIps.map(r => r.ip) },
    });
    
    await this._sendAlert(
      'concurrent_sessions',
      'warning',
      'Multiple Concurrent Sessions',
      `Your account is active from ${activeIps.length} different IP addresses in the last hour, including at least one that has not been trusted.`,
      { userId, ip: currentIp, ips: activeIps.map(r => r.ip) },
      newEvent?._id
    );
  }
  
  async _detectFailureStorm(ip, event) {
    const count = await SecurityEvent.recentFailureCount(ip, FAILURE_STORM_WINDOW_MS);
    if (count < FAILURE_STORM_COUNT) return;
    
    const newEvent = await SecurityEvent.record({
      ip, userId: 'admin',
      eventType: 'failure_storm',
      severity: 'critical',
      message: `${count} login failures from IP ${ip} in last 15 min`,
      context: { ip, count, windowMs: FAILURE_STORM_WINDOW_MS },
    });
    
    await this._sendAlert(
      'failure_storm',
      'critical',
      'Repeated Login Failures',
      `${count} failed login attempts detected from a single IP (${ip}) in the last 15 minutes. This suggests a brute-force attempt.`,
      { ip, count },
      newEvent?._id
    );
  }
  
  async _detectDistributedAttack() {
    const count = await SecurityEvent.distinctFailureIps(DISTRIBUTED_ATTACK_WINDOW_MS);
    if (count < DISTRIBUTED_ATTACK_IPS) return;
    
    const newEvent = await SecurityEvent.record({
      ip: 'distributed', userId: 'admin',
      eventType: 'distributed_attack',
      severity: 'critical',
      message: `Login failures from ${count} distinct IPs in last 15 min`,
      context: { distinctIps: count, windowMs: DISTRIBUTED_ATTACK_WINDOW_MS },
    });
    
    await this._sendAlert(
      'distributed_attack',
      'critical',
      'Distributed Attack Detected',
      `Login failures have been observed from ${count} different IP addresses within the last 15 minutes. This suggests a coordinated attack.`,
      { distinctIps: count, userId: 'admin' },
      newEvent?._id
    );
  }
  
  async _detectAfterHours(ip, event) {
    if (!this._isAfterHours()) return;
    
    const hour = this._currentHourEat();
    const newEvent = await SecurityEvent.record({
      ip, userId: 'admin',
      eventType: 'after_hours_login',
      severity: 'info',
      message: `Login at ${hour}:00 EAT (after-hours window 22:00-06:00)`,
      context: { ip, hourEat: hour },
    });
    
    await this._sendAlert(
      'after_hours_login',
      'info',
      'After-Hours Login',
      `A login was detected at ${hour}:00 EAT, outside your typical usage window (22:00-06:00). Informational — no action required if this was you.`,
      { ip, hourEat: hour },
      newEvent?._id
    );
  }
  
  async _detectRapidLoginLogout(ip, event) {
    const lastLogin = this._lastLoginByIp.get(ip);
    if (!lastLogin) return;
    const delta = Date.now() - lastLogin;
    if (delta > RAPID_LOGIN_LOGOUT_WINDOW_MS) return;
    
    const newEvent = await SecurityEvent.record({
      ip, userId: 'admin',
      eventType: 'rapid_login_logout',
      severity: 'warning',
      message: `Login → logout within ${Math.round(delta / 1000)}s from ${ip}`,
      context: { ip, deltaMs: delta },
    });
    
    await this._sendAlert(
      'rapid_login_logout',
      'warning',
      'Rapid Login/Logout Pattern',
      `A login followed by a logout within ${Math.round(delta / 1000)} seconds from IP ${ip}. This may indicate a probing session.`,
      { ip, deltaMs: delta },
      newEvent?._id
    );
  }
  
  async _detectAccountSwitchSpam(ip) {
    const since = new Date(Date.now() - ACCOUNT_SWITCH_SPAM_WINDOW_MS);
    const count = await SecurityEvent.countDocuments({
      userId: 'admin',
      eventType: 'account_switch',
      createdAt: { $gte: since },
    });
    if (count < ACCOUNT_SWITCH_SPAM_COUNT) return;
    
    const newEvent = await SecurityEvent.record({
      ip, userId: 'admin',
      eventType: 'account_switch_spam',
      severity: 'warning',
      message: `${count} account switches in last 5 min`,
      context: { ip, count, windowMs: ACCOUNT_SWITCH_SPAM_WINDOW_MS },
    });
    
    await this._sendAlert(
      'account_switch_spam',
      'warning',
      'Repeated Account Switching',
      `${count} account switches detected within 5 minutes. This may indicate automated probing or a compromised session.`,
      { userId: 'admin', ip, count },
      newEvent?._id
    );
  }
  
  async _maybeMarkIpTrusted(ip) {
    const successCount = await SecurityEvent.successCountForIp(ip);
    if (successCount < TRUST_THRESHOLD) return;
    
    // Check if already marked trusted
    const alreadyTrusted = await SecurityEvent.countDocuments({
      ip, eventType: 'ip_trusted',
    });
    if (alreadyTrusted > 0) return;
    
    // Mark trusted
    await SecurityEvent.record({
      ip, userId: 'admin',
      eventType: 'ip_trusted',
      severity: 'info',
      message: `IP ${ip} trusted after ${successCount} successful logins`,
      context: { ip, successCount },
    });
    
    logger.info(`[SecurityMonitor] IP ${ip} now trusted after ${successCount} logins`);
  }
  
  getStatus() {
    return {
      running: true,
      config: {
        trustThreshold: TRUST_THRESHOLD,
        afterHoursWindowEat: `${AFTER_HOURS_START_HOUR_EAT}:00 - ${AFTER_HOURS_END_HOUR_EAT}:00`,
        failureStormThreshold: `${FAILURE_STORM_COUNT} failures / ${FAILURE_STORM_WINDOW_MS / 60000} min`,
        distributedAttackThreshold: `${DISTRIBUTED_ATTACK_IPS} IPs / ${DISTRIBUTED_ATTACK_WINDOW_MS / 60000} min`,
        concurrentSessionWindow: `${CONCURRENT_SESSION_WINDOW_MS / 60000} min`,
        rapidLogoutWindowSec: RAPID_LOGIN_LOGOUT_WINDOW_MS / 1000,
        accountSwitchSpamThreshold: `${ACCOUNT_SWITCH_SPAM_COUNT} switches / ${ACCOUNT_SWITCH_SPAM_WINDOW_MS / 60000} min`,
      },
      alertRecipient: this._resolveAlertRecipient() ? '***configured***' : null,
      currentHourEat: this._currentHourEat(),
      isAfterHoursNow: this._isAfterHours(),
      trackedIpsForRapidLogout: this._lastLoginByIp.size,
    };
  }
}

const securityMonitor = new SecurityMonitor();

module.exports = securityMonitor;
module.exports.SecurityMonitor = SecurityMonitor;
