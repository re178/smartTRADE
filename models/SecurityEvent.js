// models/SecurityEvent.js
// Audit trail + detection primitives for security monitoring.
//
// [FIX-SECURITY-EVENT] **Single event store for all security-relevant
// activity.** Every login attempt (success or failure), logout, account
// switch, rate-limit trigger, and detected anomaly is persisted here.
//
// The monitor uses the static helpers below to make decisions:
//   • "is this IP new?"                      → wasIpEverSeenBefore(ip)
//   • "how many failures from this IP?"      → recentFailureCount(ip, 15min)
//   • "is this a distributed attack?"        → distinctFailureIps(15min)
//   • "how many IPs for this user recently?" → activeIpsForUser(userId, 1h)
//   • "did we already alert for this?"       → lastAlertFor(kind, ip, 6h)
//
// Event types (enum):
//   ── Authentication ──────────────────────
//   login_success      — successful login
//   login_failure      — bad credentials
//   login_rate_limited — blocked by rate limiter (before credential check)
//   logout             — explicit logout
//   ── Account state ───────────────────────
//   account_switch     — POST /api/account/switch succeeded
//   account_switch_failed — switch rejected (positions/bots open)
//   ── Detected anomalies (written by the monitor, not the route) ──
//   new_ip_login       — login from never-before-seen IP
//   concurrent_sessions — 2+ IPs for same user in last hour
//   failure_storm      — ≥3 failures from same IP in 15 min
//   distributed_attack — ≥5 distinct IPs failing in 15 min
//   after_hours_login  — login outside configured business hours
//   rapid_login_logout — login → logout in <10s
//   account_switch_spam — ≥3 switches in 5 min
//   ── State changes ───────────────────────
//   ip_trusted         — IP crossed the trusted threshold (2 logins)
//   ip_untrusted       — IP removed from trust (manual or via cleanup)
//
// Severity:
//   info     — routine, recorded for audit but not alerted
//   warning  — anomalous, non-blocking (concurrent sessions, after-hours)
//   critical — strong signal of attack (distributed, failure storm, new IP)
//
// Alert tracking:
//   Every event has `alerted` + `alertedAt`. If the monitor sends an email
//   for this event, it sets alerted=true. This lets us query "which events
//   were alerted?" and prevents double-alerts if the monitor re-runs.

'use strict';

const mongoose = require('mongoose');

const EVENT_TYPES = [
  'login_success',
  'login_failure',
  'login_rate_limited',
  'logout',
  'account_switch',
  'account_switch_failed',
  'new_ip_login',
  'concurrent_sessions',
  'failure_storm',
  'distributed_attack',
  'after_hours_login',
  'rapid_login_logout',
  'account_switch_spam',
  'ip_trusted',
  'ip_untrusted',
];

const SEVERITIES = ['info', 'warning', 'critical'];

// Alert cooldown configuration.
// Prevents flooding the user's inbox if an attacker retries continuously.
// Keyed by (kind, identifier) where identifier is typically the IP or userId.
const ALERT_COOLDOWNS_MS = {
  new_ip_login:          30 * 60 * 1000,      // 30 min per IP
  concurrent_sessions:   60 * 60 * 1000,      // 60 min per user
  failure_storm:         30 * 60 * 1000,      // 30 min per IP
  distributed_attack:    60 * 60 * 1000,      // 60 min globally
  after_hours_login:     60 * 60 * 1000,      // 60 min per user
  rapid_login_logout:    30 * 60 * 1000,      // 30 min per IP
  account_switch_spam:   60 * 60 * 1000,      // 60 min per user
};

const SecurityEventSchema = new mongoose.Schema({
  // ── Who ────────────────────────────────────────────────────
  userId: {
    type: String,
    default: 'admin',                         // single-user dashboard today
    index: true,
  },
  username: {
    type: String,
    default: null,                            // may be provided even on failure
  },

  // ── From where ─────────────────────────────────────────────
  // Trusted forwarded-for resolution happens in server.js —
  // we record whatever the caller passed so the audit trail matches
  // what the HTTP layer actually saw.
  ip: {
    type: String,
    required: true,
    index: true,
  },
  userAgent: {
    type: String,
    default: null,
  },

  // ── What ───────────────────────────────────────────────────
  eventType: {
    type: String,
    required: true,
    enum: EVENT_TYPES,
    index: true,
  },
  severity: {
    type: String,
    required: true,
    enum: SEVERITIES,
    default: 'info',
    index: true,
  },
  message: {
    type: String,
    default: null,
  },

  // ── Context (small, always populated) ─────────────────────
  // Any extra fields the caller wants to attach — the specific reason
  // for a failure, the old/new account type for a switch, the number of
  // failures in a storm, etc. Kept small: never store full request bodies.
  context: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },

  // ── Alert tracking ────────────────────────────────────────
  // `alerted=true` means the monitor sent an email for THIS event.
  // Queried by lastAlertFor() to enforce cooldowns.
  alerted: {
    type: Boolean,
    default: false,
    index: true,
  },
  alertedAt: {
    type: Date,
    default: null,
    index: true,
  },
  alertError: {
    type: String,
    default: null,
  },

  // ── Resolution (for "trusted IP" tracking) ────────────────
  // When a login_success event occurs from an IP that has reached the
  // trusted threshold, we emit a companion ip_trusted event. This lets
  // the audit trail record the transition without mutating history.
  relatedIpTrustedAt: {
    type: Date,
    default: null,
  },
}, { timestamps: true });

// ── Indexes ────────────────────────────────────────────────
// Primary query patterns:
SecurityEventSchema.index({ ip: 1, createdAt: -1 });
SecurityEventSchema.index({ eventType: 1, createdAt: -1 });
SecurityEventSchema.index({ severity: 1, createdAt: -1 });
SecurityEventSchema.index({ alerted: 1, createdAt: -1 });
SecurityEventSchema.index({ userId: 1, createdAt: -1 });

// Composite for cooldown queries: "when did we last alert for kind X on identifier Y?"
SecurityEventSchema.index({ eventType: 1, alerted: 1, ip: 1, alertedAt: -1 });
SecurityEventSchema.index({ eventType: 1, alerted: 1, userId: 1, alertedAt: -1 });

// Fast window scan: "how many failures from this IP in last N minutes?"
SecurityEventSchema.index({ ip: 1, eventType: 1, createdAt: -1 });
SecurityEventSchema.index({ userId: 1, eventType: 1, createdAt: -1 });

// ── Static helpers ─────────────────────────────────────────

/**
 * Record an event. Non-throwing — logging an audit entry should never
 * break the caller's primary flow (login, switch, etc.).
 *
 * @param {Object} params
 * @returns {Promise<SecurityEvent|null>}
 */
SecurityEventSchema.statics.record = async function (params) {
  try {
    return await this.create({
      userId: params.userId || 'admin',
      username: params.username || null,
      ip: params.ip || 'unknown',
      userAgent: params.userAgent || null,
      eventType: params.eventType,
      severity: params.severity || 'info',
      message: params.message || null,
      context: params.context || null,
    });
  } catch (err) {
    // Never let a security audit write break the caller.
    // Log to stderr so an operator sees it in Render logs.
    try {
      console.error(`[SecurityEvent] Failed to record ${params.eventType}: ${err.message}`);
    } catch (_) {}
    return null;
  }
};

/**
 * Has this IP ever produced a login_success event?
 * Used to decide whether a fresh login is "from a new IP".
 */
SecurityEventSchema.statics.wasIpEverSeenBefore = async function (ip) {
  if (!ip) return false;
  const doc = await this.findOne({ ip, eventType: 'login_success' })
    .select({ _id: 1 })
    .lean();
  return !!doc;
};

/**
 * How many successful logins has this IP accumulated?
 * Used to decide when an IP crosses the "trusted" threshold.
 */
SecurityEventSchema.statics.successCountForIp = async function (ip) {
  if (!ip) return 0;
  return this.countDocuments({ ip, eventType: 'login_success' });
};

/**
 * Is this IP currently trusted?
 * An IP is trusted when it has >= 2 successful logins AND has not been
 * explicitly untrusted (via ip_untrusted event).
 */
SecurityEventSchema.statics.isIpTrusted = async function (ip, threshold = 2) {
  if (!ip) return false;
  const [successes, untrusted] = await Promise.all([
    this.countDocuments({ ip, eventType: 'login_success' }),
    this.countDocuments({ ip, eventType: 'ip_untrusted' }),
  ]);
  return successes >= threshold && untrusted === 0;
};

/**
 * Count failures from a specific IP within a rolling window.
 */
SecurityEventSchema.statics.recentFailureCount = async function (ip, windowMs = 15 * 60 * 1000) {
  if (!ip) return 0;
  const since = new Date(Date.now() - windowMs);
  return this.countDocuments({
    ip,
    eventType: 'login_failure',
    createdAt: { $gte: since },
  });
};

/**
 * Count distinct IPs that have produced login_failure events in the window.
 * Feeds the distributed-attack detector.
 */
SecurityEventSchema.statics.distinctFailureIps = async function (windowMs = 15 * 60 * 1000) {
  const since = new Date(Date.now() - windowMs);
  const rows = await this.aggregate([
    { $match: { eventType: 'login_failure', createdAt: { $gte: since } } },
    { $group: { _id: '$ip' } },
    { $count: 'count' },
  ]);
  return rows.length > 0 ? rows[0].count : 0;
};

/**
 * How many distinct IPs has a user logged in from in the last N ms?
 * Feeds the concurrent-session detector.
 */
SecurityEventSchema.statics.activeIpsForUser = async function (userId, windowMs = 60 * 60 * 1000) {
  if (!userId) return [];
  const since = new Date(Date.now() - windowMs);
  const rows = await this.aggregate([
    {
      $match: {
        userId,
        eventType: 'login_success',
        createdAt: { $gte: since },
      },
    },
    {
      $group: {
        _id: '$ip',
        lastSeen: { $max: '$createdAt' },
      },
    },
    { $sort: { lastSeen: -1 } },
  ]);
  return rows.map(r => ({ ip: r._id, lastSeen: r.lastSeen }));
};

/**
 * When was the last alert sent for a given (eventType, ip-or-userId) pair?
 * Returns a Date or null.
 *
 * Cooldown check: if lastAlert < (now - cooldown), we can alert again.
 */
SecurityEventSchema.statics.lastAlertFor = async function (eventType, identifier, identifierField = 'ip') {
  if (!eventType || !identifier) return null;
  const query = {
    eventType,
    alerted: true,
    alertedAt: { $ne: null },
  };
  if (identifierField === 'userId') query.userId = identifier;
  else query.ip = identifier;

  const doc = await this.findOne(query)
    .sort({ alertedAt: -1 })
    .select({ alertedAt: 1 })
    .lean();
  return doc ? doc.alertedAt : null;
};

/**
 * Should we alert for this (eventType, identifier) now?
 * Returns true if no alert has been sent in the cooldown window.
 */
SecurityEventSchema.statics.canAlert = async function (eventType, identifier, identifierField = 'ip') {
  const cooldownMs = ALERT_COOLDOWNS_MS[eventType];
  if (!cooldownMs) return true;    // no cooldown configured — always allow
  const lastAlert = await this.lastAlertFor(eventType, identifier, identifierField);
  if (!lastAlert) return true;
  return (Date.now() - new Date(lastAlert).getTime()) >= cooldownMs;
};

/**
 * Mark an event as alerted (email sent successfully).
 */
SecurityEventSchema.statics.markAlerted = async function (eventId, { error = null } = {}) {
  if (!eventId) return null;
  try {
    return await this.findByIdAndUpdate(
      eventId,
      {
        $set: {
          alerted: !error,
          alertedAt: new Date(),
          alertError: error ? String(error).slice(0, 500) : null,
        },
      },
      { new: true }
    ).lean();
  } catch (_) {
    return null;
  }
};

/**
 * Retrieve recent events for the dashboard/audit view.
 *
 * @param {Object} opts
 * @param {Date}   [opts.since]     default: 7 days ago
 * @param {string} [opts.eventType] filter by one type
 * @param {string} [opts.severity]  filter by severity
 * @param {string} [opts.ip]        filter by IP
 * @param {number} [opts.limit]     default 200, capped at 1000
 * @returns {Promise<Array>}
 */
SecurityEventSchema.statics.recent = async function (opts = {}) {
  const {
    since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    eventType,
    severity,
    ip,
    limit = 200,
  } = opts;
  const q = { createdAt: { $gte: since } };
  if (eventType) q.eventType = eventType;
  if (severity) q.severity = severity;
  if (ip) q.ip = ip;
  return this.find(q)
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(1, Number(limit) || 200), 1000))
    .lean();
};

// ── Constants exposed ──────────────────────────────────────
SecurityEventSchema.statics.EVENT_TYPES = EVENT_TYPES;
SecurityEventSchema.statics.SEVERITIES = SEVERITIES;
SecurityEventSchema.statics.ALERT_COOLDOWNS_MS = ALERT_COOLDOWNS_MS;

module.exports = mongoose.model('SecurityEvent', SecurityEventSchema);
module.exports.EVENT_TYPES = EVENT_TYPES;
module.exports.SEVERITIES = SEVERITIES;
module.exports.ALERT_COOLDOWNS_MS = ALERT_COOLDOWNS_MS;
