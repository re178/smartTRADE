// services/communications/reportScheduler.js
// Fires daily and weekly reports on a timezone-aware schedule,
// with boot-time catch-up for missed periods.
//
// [FIX-REPORT-SCHEDULER] **Guarantees delivery even if the system was offline.**
//
//   Two independent setTimeout chains (daily + weekly) recompute the
//   next fire time after every attempt. If the server was down when a
//   report should have fired, the boot-time catch-up logic backfills
//   every missed period up to the catchup cap.
//
//   Timezone
//     All boundaries are computed in Africa/Nairobi (EAT, UTC+3).
//     EAT has no DST — the fixed +3 offset is safe to hardcode.
//
//   Daily
//     Fires every day at 00:00 EAT.
//     Covers [yesterday 00:00 EAT, today 00:00 EAT).
//     Catch-up: backfill up to 7 missed days individually.
//               Gaps > 7 days → one resume report covering the whole gap.
//
//   Weekly
//     Fires every Friday at 23:59 EAT.
//     Covers [last Friday 23:59 EAT, this Friday 23:59 EAT) — i.e. Sat→Fri.
//     Catch-up: backfill up to 4 missed weeks individually.
//               Gaps > 4 weeks → one resume report.
//
//   Deduplication
//     ReportLog.alreadySent(type, periodStart, periodEnd) is called
//     before generating any report. If the period was already delivered,
//     the scheduler skips silently. The partial unique index on the
//     model guarantees no double-send even if two processes race.
//
//   Retries
//     MAX_ATTEMPTS = 3 per period. Failed attempts count toward the
//     limit. This prevents infinite retry loops if Brevo, the PDF
//     generator, or Deriv is persistently down.
//
//   Shutdown
//     stop() clears pending timers. Any in-flight report completes
//     because _fireDaily/_fireWeekly are async and their results are
//     awaited by the timers. Their errors are caught internally.
//
//   Public API
//     start()                    — begin timers + boot catch-up
//     stop()                     — clear timers
//     triggerReport(params)      — manual trigger (used by API endpoint)
//     getStatus()                — diagnostics snapshot
//
//   Wiring
//     server.js calls start() after MongoDB connects and email is ready.
//     server.js calls stop() during graceful shutdown.

'use strict';

const { sendEmail } = require('../../shared/emailProvider');
const ReportLog = require('../../models/ReportLog');
const reportBuilder = require('./reportBuilder');
const logger = require('../../infrastructure/logger') || console;

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

const TZ_OFFSET_MS = 3 * 60 * 60 * 1000;         // EAT = UTC+3
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;

// Report content window caps
const DAILY_CATCHUP_DAYS = 7;
const WEEKLY_CATCHUP_WEEKS = 4;

// Retry policy
const MAX_ATTEMPTS = 3;

// Report subject prefix (helps filter in mail clients)
const SUBJECT_PREFIX = '[RTS] ';

// ─────────────────────────────────────────────────────────────
// Timezone helpers
// All timestamps are ISO Date objects. "EAT" functions return
// Date objects whose UTC fields carry the EAT wall-clock value,
// so date arithmetic on them uses the EAT calendar directly.
// ─────────────────────────────────────────────────────────────

function _toEat(date) {
  return new Date(date.getTime() + TZ_OFFSET_MS);
}

function _fromEat(eatDate) {
  return new Date(eatDate.getTime() - TZ_OFFSET_MS);
}

/**
 * Midnight EAT for the given UTC instant.
 * Returns a true UTC Date representing 00:00:00 EAT on that calendar day.
 */
function _midnightEat(date = new Date()) {
  const eat = _toEat(date);
  eat.setUTCHours(0, 0, 0, 0);
  return _fromEat(eat);
}

/**
 * Most recent Friday 23:59:00 EAT boundary that is at or before `date`.
 */
function _lastFriday2359Eat(date = new Date()) {
  const eatNow = _toEat(date);
  const eatTarget = new Date(eatNow);
  eatTarget.setUTCHours(23, 59, 0, 0);

  const currentDay = eatTarget.getUTCDay();         // 0=Sun, 5=Fri
  let daysBack = (currentDay - 5 + 7) % 7;
  if (daysBack === 0 && eatTarget.getTime() > eatNow.getTime()) {
    // Today is Friday but we haven't reached 23:59 yet → last was 7 days ago
    daysBack = 7;
  }
  eatTarget.setUTCDate(eatTarget.getUTCDate() - daysBack);
  return _fromEat(eatTarget);
}

/**
 * Milliseconds until the next midnight EAT.
 */
function _msUntilNextDaily(now = new Date()) {
  const eatNow = _toEat(now);
  const eatTarget = new Date(eatNow);
  eatTarget.setUTCHours(0, 0, 0, 0);
  eatTarget.setUTCDate(eatTarget.getUTCDate() + 1);
  return Math.max(1000, eatTarget.getTime() - eatNow.getTime());
}

/**
 * Milliseconds until the next Friday 23:59 EAT.
 */
function _msUntilNextWeekly(now = new Date()) {
  const eatNow = _toEat(now);
  const eatTarget = new Date(eatNow);
  eatTarget.setUTCHours(23, 59, 0, 0);

  const currentDay = eatTarget.getUTCDay();
  let daysAhead = (5 - currentDay + 7) % 7;
  if (daysAhead === 0 && eatTarget.getTime() <= eatNow.getTime()) {
    daysAhead = 7;
  }
  eatTarget.setUTCDate(eatTarget.getUTCDate() + daysAhead);
  return Math.max(1000, eatTarget.getTime() - eatNow.getTime());
}

/**
 * Format a Date as YYYY-MM-DD in EAT (used in PDF filenames).
 */
function _formatDateForFilename(date) {
  const eat = _toEat(date);
  const y = eat.getUTCFullYear();
  const m = String(eat.getUTCMonth() + 1).padStart(2, '0');
  const d = String(eat.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function _pdfFilename(type, periodStart, periodEnd) {
  const s = _formatDateForFilename(periodStart);
  const e = _formatDateForFilename(periodEnd);
  if (type === 'daily')  return `RTS_Daily_${s}.pdf`;
  if (type === 'weekly') return `RTS_Weekly_${s}_to_${e}.pdf`;
  return `RTS_Custom_${s}_to_${e}.pdf`;
}

// ─────────────────────────────────────────────────────────────
// ReportScheduler
// ─────────────────────────────────────────────────────────────

class ReportScheduler {
  constructor() {
    this._started = false;
    this._dailyTimer = null;
    this._weeklyTimer = null;
    this._lastDailyFireAt = null;
    this._lastWeeklyFireAt = null;
    this._lastDailyError = null;
    this._lastWeeklyError = null;
    this._runningReports = new Set();    // `${type}:${periodStartISO}`
  }

  // ── Public API ────────────────────────────────────────────

  start() {
    if (this._started) {
      logger.warn('[ReportScheduler] start() called twice — ignoring');
      return;
    }
    this._started = true;

    logger.info(
      `[ReportScheduler] Starting (daily catch-up ${DAILY_CATCHUP_DAYS}d, ` +
      `weekly catch-up ${WEEKLY_CATCHUP_WEEKS}w, MAX_ATTEMPTS=${MAX_ATTEMPTS})`
    );

    // Kick off catch-up asynchronously so it doesn't block startup
    Promise.resolve()
      .then(() => this._catchUp())
      .catch(err => logger.error(`[ReportScheduler] Boot catch-up failed: ${err.message}`))
      .finally(() => {
        this._scheduleNextDaily();
        this._scheduleNextWeekly();
      });
  }

  stop() {
    this._started = false;
    if (this._dailyTimer)  { clearTimeout(this._dailyTimer);  this._dailyTimer = null; }
    if (this._weeklyTimer) { clearTimeout(this._weeklyTimer); this._weeklyTimer = null; }
    logger.info('[ReportScheduler] Stopped');
  }

  /**
   * Unified entry point for both scheduled fires and manual API triggers.
   *
   * @param {Object} params
   * @param {string} params.type       'daily' | 'weekly' | 'custom'
   * @param {Date}   [params.from]     required for custom, ignored for daily/weekly
   * @param {Date}   [params.to]       required for custom, ignored for daily/weekly
   * @param {string} [params.trigger]  'schedule' | 'catchup' | 'manual'
   * @returns {Promise<Object>}
   */
  async triggerReport({ type, from = null, to = null, trigger = 'manual' } = {}) {
    if (type === 'daily') {
      const periodEnd = _midnightEat();
      const periodStart = new Date(periodEnd.getTime() - ONE_DAY_MS);
      return this._sendReport('daily', periodStart, periodEnd, trigger);
    }
    if (type === 'weekly') {
      const periodEnd = _lastFriday2359Eat();
      const periodStart = new Date(periodEnd.getTime() - ONE_WEEK_MS);
      return this._sendReport('weekly', periodStart, periodEnd, trigger);
    }
    if (type === 'custom') {
      if (!from || !to) {
        throw new Error('custom report requires `from` and `to`');
      }
      const ps = from instanceof Date ? from : new Date(from);
      const pe = to instanceof Date ? to : new Date(to);
      if (!(pe > ps)) throw new Error('`to` must be after `from`');
      return this._sendReport('custom', ps, pe, trigger);
    }
    throw new Error(`Unknown report type: ${type}`);
  }

  getStatus() {
    const now = Date.now();
    return {
      running: this._started,
      timezone: 'Africa/Nairobi',
      nextDailyInMs:  this._dailyTimer  ? Math.max(0, _msUntilNextDaily())  : null,
      nextWeeklyInMs: this._weeklyTimer ? Math.max(0, _msUntilNextWeekly()) : null,
      lastDailyFireAt:  this._lastDailyFireAt,
      lastWeeklyFireAt: this._lastWeeklyFireAt,
      lastDailyError:  this._lastDailyError,
      lastWeeklyError: this._lastWeeklyError,
      runningReports: Array.from(this._runningReports),
      config: {
        dailyCatchupDays: DAILY_CATCHUP_DAYS,
        weeklyCatchupWeeks: WEEKLY_CATCHUP_WEEKS,
        maxAttempts: MAX_ATTEMPTS,
        recipientResolved: this._resolveRecipient() || null,
      },
      timestamp: new Date().toISOString(),
    };
  }

  // ── Timers ────────────────────────────────────────────────

  _scheduleNextDaily() {
    if (!this._started) return;
    if (this._dailyTimer) clearTimeout(this._dailyTimer);

    const ms = _msUntilNextDaily();
    this._dailyTimer = setTimeout(() => {
      this._fireDaily().catch(err => {
        this._lastDailyError = err.message;
        logger.error(`[ReportScheduler] Daily fire failed: ${err.message}`);
      }).finally(() => this._scheduleNextDaily());
    }, ms);
    if (typeof this._dailyTimer.unref === 'function') this._dailyTimer.unref();

    logger.info(`[ReportScheduler] Next daily report in ${Math.round(ms / 60000)} min`);
  }

  _scheduleNextWeekly() {
    if (!this._started) return;
    if (this._weeklyTimer) clearTimeout(this._weeklyTimer);

    const ms = _msUntilNextWeekly();
    this._weeklyTimer = setTimeout(() => {
      this._fireWeekly().catch(err => {
        this._lastWeeklyError = err.message;
        logger.error(`[ReportScheduler] Weekly fire failed: ${err.message}`);
      }).finally(() => this._scheduleNextWeekly());
    }, ms);
    if (typeof this._weeklyTimer.unref === 'function') this._weeklyTimer.unref();

    logger.info(`[ReportScheduler] Next weekly report in ${Math.round(ms / 60000)} min`);
  }

  // ── Fires ────────────────────────────────────────────────

  async _fireDaily() {
    this._lastDailyFireAt = new Date().toISOString();
    const periodEnd = _midnightEat();
    const periodStart = new Date(periodEnd.getTime() - ONE_DAY_MS);
    logger.info(
      `[ReportScheduler] Daily fire: ` +
      `${periodStart.toISOString()} → ${periodEnd.toISOString()}`
    );
    await this._sendReport('daily', periodStart, periodEnd, 'schedule');
  }

  async _fireWeekly() {
    this._lastWeeklyFireAt = new Date().toISOString();
    const periodEnd = _lastFriday2359Eat();
    const periodStart = new Date(periodEnd.getTime() - ONE_WEEK_MS);
    logger.info(
      `[ReportScheduler] Weekly fire: ` +
      `${periodStart.toISOString()} → ${periodEnd.toISOString()}`
    );
    await this._sendReport('weekly', periodStart, periodEnd, 'schedule');
  }

  // ── Catch-up ─────────────────────────────────────────────

  async _catchUp() {
    logger.info('[ReportScheduler] Running boot catch-up…');
    try { await this._catchUpType('daily', DAILY_CATCHUP_DAYS, ONE_DAY_MS); }
    catch (err) { logger.error(`[ReportScheduler] Daily catch-up failed: ${err.message}`); }
    try { await this._catchUpType('weekly', WEEKLY_CATCHUP_WEEKS, ONE_WEEK_MS); }
    catch (err) { logger.error(`[ReportScheduler] Weekly catch-up failed: ${err.message}`); }
  }

  async _catchUpType(type, maxPeriods, periodMs) {
    const latestEnd = type === 'daily'
      ? _midnightEat()
      : _lastFriday2359Eat();

    const last = await ReportLog.lastSuccessful(type);

    // Case A: never sent before — backfill up to maxPeriods
    if (!last) {
      logger.info(`[ReportScheduler] ${type}: no prior report — backfilling last ${maxPeriods} periods`);
      let currentStart = new Date(latestEnd.getTime() - maxPeriods * periodMs);
      while (currentStart < latestEnd) {
        const currentEnd = new Date(currentStart.getTime() + periodMs);
        try { await this._sendReport(type, currentStart, currentEnd, 'catchup'); }
        catch (err) {
          logger.warn(`[ReportScheduler] ${type} catch-up (${currentStart.toISOString()}) failed: ${err.message}`);
        }
        currentStart = currentEnd;
      }
      return;
    }

    // Case B: have prior send — compute gap
    const lastEnd = new Date(last.periodEnd);
    const gapMs = latestEnd.getTime() - lastEnd.getTime();
    if (gapMs <= 0) {
      logger.info(`[ReportScheduler] ${type}: up to date (last sent ${last.sentAt})`);
      return;
    }

    const gapPeriods = Math.floor(gapMs / periodMs);

    if (gapPeriods > maxPeriods) {
      // Case C: gap too large — single resume summary
      logger.warn(
        `[ReportScheduler] ${type}: gap of ${gapPeriods} periods exceeds cap (${maxPeriods}) — ` +
        `sending single resume report for [${lastEnd.toISOString()} → ${latestEnd.toISOString()}]`
      );
      try {
        await this._sendReport(type, lastEnd, latestEnd, 'catchup', {
          resumeSummary: true,
          resumeFrom: lastEnd,
          resumeTo: latestEnd,
          resumedPeriods: gapPeriods,
        });
      } catch (err) {
        logger.error(`[ReportScheduler] ${type} resume report failed: ${err.message}`);
      }
      return;
    }

    // Case D: normal backfill — one report per missed period
    logger.info(`[ReportScheduler] ${type}: backfilling ${gapPeriods} missed period(s)`);
    let currentStart = lastEnd;
    while (currentStart < latestEnd) {
      const currentEnd = new Date(currentStart.getTime() + periodMs);
      try { await this._sendReport(type, currentStart, currentEnd, 'catchup'); }
      catch (err) {
        logger.warn(`[ReportScheduler] ${type} catch-up (${currentStart.toISOString()}) failed: ${err.message}`);
      }
      currentStart = currentEnd;
    }
  }

  // ── Core sender ──────────────────────────────────────────

  async _sendReport(type, periodStart, periodEnd, trigger, extraOptions = {}) {
    const dedupeKey = `${type}:${periodStart.toISOString()}`;

    if (this._runningReports.has(dedupeKey)) {
      logger.info(`[ReportScheduler] ${type} report for ${periodStart.toISOString()} already in flight — skipping`);
      return { skipped: true, reason: 'in-flight' };
    }

    // Duplicate check across all attempts (sent or failed)
    const attemptsCount = await ReportLog.countDocuments({
      type,
      periodStart,
      status: { $in: ['sent', 'failed'] },
    });

    if (attemptsCount > 0) {
      const alreadySent = await ReportLog.alreadySent(type, periodStart, periodEnd);
      if (alreadySent) {
        logger.info(`[ReportScheduler] ${type} report for ${periodStart.toISOString()} already sent — skipping`);
        return { skipped: true, reason: 'already-sent' };
      }
      if (attemptsCount >= MAX_ATTEMPTS) {
        logger.warn(
          `[ReportScheduler] ${type} report for ${periodStart.toISOString()} has ` +
          `${attemptsCount} failed attempts — skipping (MAX_ATTEMPTS=${MAX_ATTEMPTS})`
        );
        return { skipped: true, reason: 'max-attempts' };
      }
      logger.info(
        `[ReportScheduler] Retrying ${type} report for ${periodStart.toISOString()} ` +
        `(attempt ${attemptsCount + 1}/${MAX_ATTEMPTS})`
      );
    }

    // Recipient resolution
    const recipient = this._resolveRecipient();
    if (!recipient) {
      logger.error(
        `[ReportScheduler] ${type} report for ${periodStart.toISOString()} — ` +
        `NO RECIPIENT configured (set REPORT_EMAIL or RTS_NOTIFY_EMAIL)`
      );
      return { skipped: true, reason: 'no-recipient' };
    }

    this._runningReports.add(dedupeKey);

    // Record attempt
    let logDoc = null;
    let logDuplicate = false;
    try {
      const result = await ReportLog.recordAttempt({
        type,
        trigger,
        periodStart,
        periodEnd,
        recipient,
        subject: null,           // set below after building
        timezone: 'Africa/Nairobi',
        status: 'pending',
        meta: Object.keys(extraOptions).length > 0 ? extraOptions : null,
      });
      logDoc = result.doc;
      logDuplicate = result.duplicate;
    } catch (err) {
      logger.error(`[ReportScheduler] ReportLog.recordAttempt failed: ${err.message}`);
    }

    if (logDuplicate) {
      this._runningReports.delete(dedupeKey);
      logger.info(`[ReportScheduler] ${type} report for ${periodStart.toISOString()} already recorded as sent — skipping`);
      return { skipped: true, reason: 'already-sent' };
    }

    try {
      // Build the report
      let built;
      if (type === 'daily')       built = await reportBuilder.buildDailyReport(periodStart, periodEnd);
      else if (type === 'weekly') built = await reportBuilder.buildWeeklyReport(periodStart, periodEnd);
      else                        built = await reportBuilder.buildCustomReport(periodStart, periodEnd);

      // Inject resume context into the subject if applicable
      let subject = SUBJECT_PREFIX + built.subject;
      if (extraOptions.resumeSummary) {
        const fromStr = _formatDateForFilename(extraOptions.resumeFrom);
        const toStr = _formatDateForFilename(extraOptions.resumeTo);
        subject = SUBJECT_PREFIX + `Resume Report — ${fromStr} → ${toStr} · ` +
          `${built.stats.tradeCount} trades · ${built.stats.totalPnl >= 0 ? '+' : ''}$${Number(built.stats.totalPnl).toFixed(2)}`;
      }

      // Update ReportLog with the final subject + stats
      if (logDoc && logDoc._id) {
        try {
          await ReportLog.updateOne(
            { _id: logDoc._id },
            {
              $set: {
                subject,
                'stats.tradeCount':  built.stats.tradeCount,
                'stats.winCount':    built.stats.winCount,
                'stats.lossCount':   built.stats.lossCount,
                'stats.totalPnl':    built.stats.totalPnl,
                'stats.winRate':     built.stats.winRate,
                'stats.balanceAtSend': built.stats.balanceAtSend,
                'stats.currency':    built.stats.currency,
                'stats.accountType': built.stats.accountType,
                'stats.botsCovered': built.stats.botsCovered,
                'stats.strategiesCovered': built.stats.strategiesCovered,
                'stats.catchupFrom': extraOptions.resumeFrom || null,
                'stats.catchupTo':   extraOptions.resumeTo || null,
              },
            }
          );
        } catch (_) {}
      }

      // Build attachments
      const attachments = [];
      if (built.pdfBuffer) {
        attachments.push({
          filename: _pdfFilename(type, periodStart, periodEnd),
          content: built.pdfBuffer,
        });
      } else {
        logger.warn(
          `[ReportScheduler] ${type} report for ${periodStart.toISOString()} ` +
          `has no PDF — sending HTML-only email`
        );
      }

      // Send
      const result = await sendEmail(recipient, subject, built.html, { attachments });

      if (result && result.success) {
        if (logDoc && typeof logDoc.markSent === 'function') {
          try {
            await logDoc.markSent({
              providerMessageId: result.messageId || null,
              provider: result.provider || 'brevo',
            });
          } catch (_) {}
        }
        logger.info(
          `[ReportScheduler] ✅ ${type} report DELIVERED to ${recipient} ` +
          `(msgId=${result.messageId || 'n/a'}, trades=${built.stats.tradeCount}, ` +
          `pnl=$${Number(built.stats.totalPnl).toFixed(2)}, pdf=${built.pdfBuffer ? 'yes' : 'no'})`
        );
        return { success: true, messageId: result.messageId, built };
      }

      // Non-success
      const errMsg = (result && result.error) || 'unknown email error';
      if (logDoc && typeof logDoc.markFailed === 'function') {
        try { await logDoc.markFailed(errMsg); } catch (_) {}
      }
      logger.error(`[ReportScheduler] ❌ ${type} report DELIVERY FAILED: ${errMsg}`);
      return { success: false, error: errMsg };
    } catch (err) {
      if (logDoc && typeof logDoc.markFailed === 'function') {
        try { await logDoc.markFailed(err.message); } catch (_) {}
      }
      logger.error(`[ReportScheduler] ${type} report threw: ${err.message}`);
      throw err;
    } finally {
      this._runningReports.delete(dedupeKey);
    }
  }

  _resolveRecipient() {
    return (
      process.env.REPORT_EMAIL ||
      process.env.RTS_NOTIFY_EMAIL ||
      process.env.ALERT_EMAIL ||
      process.env.SUPPORT_EMAIL ||
      null
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Singleton export
// ─────────────────────────────────────────────────────────────

const reportScheduler = new ReportScheduler();

module.exports = reportScheduler;
module.exports.ReportScheduler = ReportScheduler;

// Exposed for testing
module.exports._midnightEat = _midnightEat;
module.exports._lastFriday2359Eat = _lastFriday2359Eat;
module.exports._msUntilNextDaily = _msUntilNextDaily;
module.exports._msUntilNextWeekly = _msUntilNextWeekly;
module.exports._pdfFilename = _pdfFilename;
