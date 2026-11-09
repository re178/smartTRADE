// models/ReportLog.js
// Audit trail of every report attempt (daily, weekly, custom).
//
// [FIX-REPORT-LOG] **Report delivery tracking with duplicate prevention.**
//
//   Every scheduled (or manually triggered) report generates one
//   ReportLog doc. Multiple attempts for the same period are allowed
//   ONLY while no successful send exists — enforced via a partial
//   unique index on { type, periodStart } filtered to status='sent'.
//
//   Statuses:
//     • 'pending'  — report generated, email in flight
//     • 'sent'     — email confirmed by provider
//     • 'failed'   — email attempt failed; error stored
//     • 'skipped'  — period already covered by a prior success
//                    (used during catch-up to mark why nothing was sent)
//
//   Trigger sources:
//     • 'schedule'  — fired by the daily/weekly interval timer
//     • 'catchup'   — fired on boot to backfill missed periods
//     • 'manual'    — POST /api/reports/send-now
//
//   Metadata snapshot (field: `stats`) captures a small summary of what
//   the report contained — trade count, total PnL, win rate — so the
//   audit trail is self-documenting even if the PDF is lost. This is
//   intentionally small (not the full report payload) to keep the log
//   lightweight over years of operation.
//
//   Retention policy (handled elsewhere, e.g. a future cron):
//     • 'sent' rows older than 365 days can be archived/deleted
//     • 'failed' rows older than 30 days can be deleted
//     • 'skipped' rows older than 7 days can be deleted
//   This schema does not enforce retention — it only records events.

'use strict';

const mongoose = require('mongoose');

const REPORT_TYPES = ['daily', 'weekly', 'custom'];
const REPORT_STATUSES = ['pending', 'sent', 'failed', 'skipped'];
const REPORT_TRIGGERS = ['schedule', 'catchup', 'manual'];

const ReportLogSchema = new mongoose.Schema({
  // ── Identity ──────────────────────────────────────────────
  type: {
    type: String,
    required: true,
    enum: REPORT_TYPES,
    index: true,
  },
  trigger: {
    type: String,
    required: true,
    enum: REPORT_TRIGGERS,
    default: 'schedule',
    index: true,
  },

  // ── Period covered by the report ──────────────────────────
  // periodStart is inclusive, periodEnd is exclusive (half-open interval).
  // Using half-open intervals avoids overlap: a daily report for
  // 2025-11-09 covers [00:00:00 EAT, next-day 00:00:00 EAT).
  periodStart: { type: Date, required: true, index: true },
  periodEnd:   { type: Date, required: true, index: true },

  // Timezone used to compute the boundaries. Stored so the log is
  // self-explanatory years later ("what was the exact scheduling window?").
  timezone: { type: String, default: 'Africa/Nairobi' },

  // ── Delivery ──────────────────────────────────────────────
  status: {
    type: String,
    required: true,
    enum: REPORT_STATUSES,
    default: 'pending',
    index: true,
  },
  sentAt:      { type: Date, default: null, index: true },
  recipient:   { type: String, default: null },
  cc:          { type: [String], default: [] },
  subject:     { type: String, default: null },
  error:       { type: String, default: null },
  attempts:    { type: Number, default: 1 },
  providerMessageId: { type: String, default: null },
  provider:    { type: String, default: null },

  // ── Lightweight stats snapshot ────────────────────────────
  // NOT the full report payload — just enough to audit what the report
  // contained at a glance. Full report data is either in the PDF
  // attachment or reconstructable from Trade/BotRun queries.
  stats: {
    tradeCount:    { type: Number, default: 0 },
    winCount:      { type: Number, default: 0 },
    lossCount:     { type: Number, default: 0 },
    totalPnl:      { type: Number, default: 0 },
    winRate:       { type: Number, default: 0 },
    balanceAtSend: { type: Number, default: null },
    currency:      { type: String, default: null },
    accountType:   { type: String, default: null },    // 'demo' | 'real'
    botsCovered:   { type: Number, default: 0 },
    strategiesCovered: { type: Number, default: 0 },
    // Diagnostic — how many catch-up reports this one replaces
    catchupFrom:   { type: Date, default: null },
    catchupTo:     { type: Date, default: null },
  },

  // ── Free-form context (safe to extend) ────────────────────
  meta: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true });

// ── Indexes ─────────────────────────────────────────────────
// Prevent duplicate successful sends of the same period.
// Multiple 'failed' or 'pending' attempts for the same period are allowed
// (they're how retries work). Only the first 'sent' wins.
ReportLogSchema.index(
  { type: 1, periodStart: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'sent' },
    name: 'uniq_sent_period',
  }
);

// Fast lookup: "what was the last successful daily send?"
ReportLogSchema.index({ type: 1, status: 1, sentAt: -1 });

// Fast lookup: recent activity across all types
ReportLogSchema.index({ createdAt: -1 });

// Fast lookup: find failed attempts for retry
ReportLogSchema.index({ status: 1, createdAt: -1 });

// Fast lookup: catch-up query for a specific type + status
ReportLogSchema.index({ type: 1, status: 1, periodEnd: -1 });

// ── Static helpers ──────────────────────────────────────────

/**
 * Find the most recent successful send of a given type.
 * Returns the ReportLog doc or null.
 *
 * Used by the scheduler to compute catch-up windows:
 *   last = await ReportLog.lastSuccessful('daily')
 *   if (!last) → backfill from (now - maxCatchupDays)
 *   else       → backfill from last.periodEnd to now
 */
ReportLogSchema.statics.lastSuccessful = async function (type) {
  return this.findOne({ type, status: 'sent' })
    .sort({ periodEnd: -1 })
    .lean();
};

/**
 * List successful sends for a given type within a date range.
 * Returns array of { periodStart, periodEnd, sentAt }.
 */
ReportLogSchema.statics.successfulInRange = async function (type, from, to) {
  return this.find({
    type,
    status: 'sent',
    periodStart: { $gte: from },
    periodEnd:   { $lte: to },
  })
    .sort({ periodStart: 1 })
    .select({ periodStart: 1, periodEnd: 1, sentAt: 1, stats: 1 })
    .lean();
};

/**
 * Check whether a period has already been sent successfully.
 * Same key as the unique index. Returns true if a 'sent' row exists
 * whose [periodStart, periodEnd) matches exactly.
 */
ReportLogSchema.statics.alreadySent = async function (type, periodStart, periodEnd) {
  const doc = await this.findOne({
    type,
    status: 'sent',
    periodStart,
    periodEnd,
  }).select({ _id: 1 }).lean();
  return !!doc;
};

/**
 * Record a report attempt. Handles the duplicate-key case gracefully:
 * if another process already marked this period 'sent', we return
 * that record instead of throwing.
 *
 * @param {Object} params
 * @param {string} params.type         'daily' | 'weekly' | 'custom'
 * @param {string} params.trigger      'schedule' | 'catchup' | 'manual'
 * @param {Date}   params.periodStart
 * @param {Date}   params.periodEnd
 * @param {string} [params.status]     default 'pending'
 * @param {string} [params.recipient]
 * @param {string} [params.subject]
 * @param {string} [params.timezone]
 * @param {Object} [params.stats]
 * @param {Object} [params.meta]
 * @returns {Promise<{ doc: ReportLog, duplicate: boolean }>}
 */
ReportLogSchema.statics.recordAttempt = async function (params) {
  const {
    type,
    trigger,
    periodStart,
    periodEnd,
    status = 'pending',
    recipient = null,
    subject = null,
    timezone = 'Africa/Nairobi',
    stats = null,
    meta = null,
  } = params || {};

  if (!type || !trigger || !periodStart || !periodEnd) {
    throw new Error('recordAttempt requires type, trigger, periodStart, periodEnd');
  }

  try {
    const doc = await this.create({
      type,
      trigger,
      periodStart,
      periodEnd,
      timezone,
      status,
      recipient,
      subject,
      stats: stats || undefined,
      meta,
    });
    return { doc, duplicate: false };
  } catch (err) {
    // Duplicate key on the partial unique index — another process
    // already sent this period. Return the existing doc so the caller
    // knows it was already delivered.
    if (err && err.code === 11000) {
      const existing = await this.findOne({
        type,
        status: 'sent',
        periodStart,
        periodEnd,
      }).lean();
      return { doc: existing, duplicate: true };
    }
    throw err;
  }
};

/**
 * Mark a ReportLog as sent. Called after the email provider confirms
 * delivery. Updates the same doc in place — no new attempt row created
 * because the initial `recordAttempt` already created the 'pending' row.
 *
 * If a concurrent process already marked this period 'sent', the
 * unique index will refuse to accept our update — we catch that and
 * treat it as "someone else already sent it" (idempotent).
 */
ReportLogSchema.methods.markSent = async function ({ providerMessageId = null, provider = null } = {}) {
  this.status = 'sent';
  this.sentAt = new Date();
  if (providerMessageId) this.providerMessageId = String(providerMessageId);
  if (provider) this.provider = provider;
  this.error = null;
  try {
    await this.save();
    return true;
  } catch (err) {
    if (err && err.code === 11000) {
      // Race: another process already marked this period 'sent'.
      // Not an error — the report WAS delivered by someone.
      return false;
    }
    throw err;
  }
};

/**
 * Mark a ReportLog as failed with the given reason.
 */
ReportLogSchema.methods.markFailed = async function (reason) {
  this.status = 'failed';
  this.error = String(reason || 'unknown').slice(0, 2000);
  try {
    await this.save();
  } catch (_) {
    // If save itself fails, we still want to record the failure.
    // Fall back to a targeted update.
    await this.constructor.updateOne(
      { _id: this._id },
      { $set: { status: 'failed', error: String(reason || 'unknown').slice(0, 2000) } }
    ).catch(() => {});
  }
};

// ── Constants exposed for other modules ────────────────────
ReportLogSchema.statics.REPORT_TYPES = REPORT_TYPES;
ReportLogSchema.statics.REPORT_STATUSES = REPORT_STATUSES;
ReportLogSchema.statics.REPORT_TRIGGERS = REPORT_TRIGGERS;

module.exports = mongoose.model('ReportLog', ReportLogSchema);
module.exports.REPORT_TYPES = REPORT_TYPES;
module.exports.REPORT_STATUSES = REPORT_STATUSES;
module.exports.REPORT_TRIGGERS = REPORT_TRIGGERS;
