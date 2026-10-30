// core/bots/edgeTest.js
// Edge validation orchestrator.
//
// Runs all 17 bots at equal stake with session-stops disabled, collects
// BotRun documents tagged `isEdgeTest: true`, and computes per-bot:
//   - Win rate vs base rate
//   - Binomial z-score (statistical significance)
//   - Verdict: EDGE / NO_EDGE / NEED_MORE_DATA
//
// One edge test runs at a time. Progress persists in BotRun docs, so
// stats survive server restart — but the in-memory runner instances do
// not, so a restart mid-test leaves the bots stopped and the test flagged
// as paused. Clicking Start again resumes from where it left off.
//
// v2 additions:
//   • deleteBot(botId)  — delete one bot's edge history (used by per-row
//                         delete buttons in the dashboard)
//   • resetAll()        — stop the test (if running) + delete all edge
//                         history (used by "Reset & Restart" button)
//   • exportCSV now emits a Flip column (NORMAL / FLIPPED) so the CSV
//     shows which trades were made by a flipped bot instance.

'use strict';

const BotRun = require('../../models/BotRun');
const botRunner = require('./runner');
const { getBot, listBots } = require('./registry');
const logger = require('../../infrastructure/logger') || console;

const DEFAULT_TARGET_SAMPLE = 160;
const DEFAULT_STAKE = 1;
const MONITOR_INTERVAL_MS = 10000;
// Two-tailed p < 0.05. Conservative threshold — requires stronger evidence
// than the one-tailed 1.645. Use 1.96 so a "verdict" is trustworthy.
const Z_THRESHOLD = 1.96;

let _schemaVerified = false;
async function _verifyBotRunSchema() {
  if (_schemaVerified) return;
  // Probe write — verifies Mongoose doesn't silently strip our fields.
  let probeId = null;
  try {
    const probe = await BotRun.create({
      botId: '__edge_probe__',
      instanceId: '__probe__',
      contractId: '__probe_' + Date.now(),
      symbol: 'PROBE',
      side: 'BUY',
      stake: 0,
      openedAt: new Date(),
      status: 'CLOSED',
      result: 'BREAKEVEN',
      isEdgeTest: true,
      regimeCode: 'PROBE',
      session: 'PROBE',
    });
    probeId = probe._id;
    const back = await BotRun.findById(probeId).lean();
    if (!back || back.isEdgeTest !== true || back.regimeCode !== 'PROBE' || back.session !== 'PROBE') {
      throw new Error(
        'BotRun schema does not persist required edge test fields.\n' +
        'Add to models/BotRun.js:\n' +
        '  isEdgeTest: { type: Boolean, default: false },\n' +
        '  regimeCode: { type: String, default: null },\n' +
        '  session:    { type: String, default: null },\n'
      );
    }
  } finally {
    if (probeId) {
      try { await BotRun.findByIdAndDelete(probeId); } catch (_) {}
    }
  }
  _schemaVerified = true;
}

class EdgeTest {
  constructor() {
    this.running = false;
    this.startedAt = null;
    this.targetSample = DEFAULT_TARGET_SAMPLE;
    this.stake = DEFAULT_STAKE;
    this.instances = new Map();     // botId -> instanceId
    this.stoppedBots = new Set();   // botIds that reached target this run
    this._monitorTimer = null;
  }

  // ──────────────────────────────────────────────────────────
  // START — spin up every bot in controlled edge-test mode
  // ──────────────────────────────────────────────────────────
  async start(options = {}) {
    if (this.running) {
      throw new Error('Edge test already running. Stop it first or wait for completion.');
    }
    await _verifyBotRunSchema();

    const targetSample = Number(options.targetSample) || DEFAULT_TARGET_SAMPLE;
    const stake = Number(options.stake) || DEFAULT_STAKE;
    if (stake <= 0 || !Number.isFinite(stake)) {
      throw new Error(`Invalid stake: ${options.stake}`);
    }
    if (targetSample < 30) {
      throw new Error(`Target sample too small: ${targetSample}. Minimum 30 trades for statistical meaning.`);
    }

    // Clean up any orphan edge-test instances from a prior crashed run.
    try {
      const existing = botRunner.list();
      for (const inst of existing) {
        if (inst.config && inst.config._edgeTest) {
          botRunner.stop(inst.instanceId);
        }
      }
    } catch (_) {}

    this.running = true;
    this.startedAt = new Date();
    this.targetSample = targetSample;
    this.stake = stake;
    this.instances = new Map();
    this.stoppedBots = new Set();

    const bots = listBots();
    const startedBots = [];
    const skippedBots = [];

    for (const bot of bots) {
      // Pre-check: if already at target sample, don't even start.
      let existing = 0;
      try {
        existing = await BotRun.countDocuments({
          botId: bot.id, isEdgeTest: true, status: 'CLOSED',
        });
      } catch (_) {}

      if (existing >= targetSample) {
        this.stoppedBots.add(bot.id);
        skippedBots.push({ botId: bot.id, reason: `Already ${existing} closed trades (target ${targetSample})` });
        continue;
      }

      const config = Object.assign({}, bot.defaultConfig, {
        stake: stake,
        maxStake: stake,               // hard equal stake — no exceptions
        botTakeProfit: 0,              // disabled — collect full sample
        botStopLoss: 0,                // disabled
        trailingDrawdownPct: 0,        // disabled
        stopAfterLosses: 0,            // disabled
        _edgeTest: true,
      });

      try {
        const summary = botRunner.start(bot.id, config);
        this.instances.set(bot.id, summary.instanceId);
        startedBots.push({ botId: bot.id, instanceId: summary.instanceId });
      } catch (err) {
        logger.error(`[EdgeTest] Failed to start ${bot.id}: ${err.message}`);
        skippedBots.push({ botId: bot.id, reason: err.message });
      }
    }

    // If everything was already complete, immediately declare finished
    if (this.instances.size === 0) {
      this.running = false;
      this.startedAt = null;
      return {
        ok: true,
        running: false,
        message: 'All bots already reached target sample. Nothing to start.',
        startedBots,
        skippedBots,
      };
    }

    this._monitorTimer = setInterval(() => {
      this._checkProgress().catch(err => {
        logger.warn(`[EdgeTest] monitor error: ${err.message}`);
      });
    }, MONITOR_INTERVAL_MS);
    if (typeof this._monitorTimer.unref === 'function') this._monitorTimer.unref();

    logger.info(
      `[EdgeTest] Started — ${startedBots.length} bots at $${stake} stake, ` +
      `target ${targetSample} closed trades each`
    );

    return {
      ok: true,
      running: true,
      startedAt: this.startedAt,
      targetSample: this.targetSample,
      stake: this.stake,
      startedBots,
      skippedBots,
    };
  }

  // ──────────────────────────────────────────────────────────
  // STOP — halt all edge-test instances, keep data
  // ──────────────────────────────────────────────────────────
  stop() {
    if (!this.running) {
      return { ok: true, running: false, message: 'Edge test not running.' };
    }
    if (this._monitorTimer) {
      clearInterval(this._monitorTimer);
      this._monitorTimer = null;
    }
    let stopped = 0;
    for (const [botId, instanceId] of this.instances) {
      try {
        botRunner.stop(instanceId);
        stopped++;
      } catch (err) {
        logger.warn(`[EdgeTest] Failed to stop ${botId}/${instanceId}: ${err.message}`);
      }
    }
    this.instances.clear();
    this.running = false;
    this.startedAt = null;
    logger.info(`[EdgeTest] Stopped — ${stopped} instances halted. Data preserved in BotRun.`);
    return { ok: true, running: false, stoppedCount: stopped };
  }

  // ──────────────────────────────────────────────────────────
  // MONITOR — every 10s, check which bots hit target and stop them
  // ──────────────────────────────────────────────────────────
  async _checkProgress() {
    if (!this.running) return;

    let stillRunning = 0;
    for (const [botId, instanceId] of Array.from(this.instances.entries())) {
      let closed = 0;
      try {
        closed = await BotRun.countDocuments({
          botId, isEdgeTest: true, status: 'CLOSED',
        });
      } catch (_) {}

      if (closed >= this.targetSample) {
        try {
          botRunner.stop(instanceId);
          logger.info(`[EdgeTest] ${botId} reached ${closed} trades — auto-stopped.`);
        } catch (_) {}
        this.instances.delete(botId);
        this.stoppedBots.add(botId);
      } else {
        stillRunning++;
      }
    }

    if (stillRunning === 0 && this.instances.size === 0) {
      logger.info(`[EdgeTest] All bots reached target. Test complete.`);
      if (this._monitorTimer) {
        clearInterval(this._monitorTimer);
        this._monitorTimer = null;
      }
      this.running = false;
    }
  }

  // ──────────────────────────────────────────────────────────
  // STATUS — lightweight, for progress bars in the UI
  // ──────────────────────────────────────────────────────────
  async status() {
    const bots = listBots();
    const perBot = [];

    for (const bot of bots) {
      let closed = 0;
      let wins = 0;
      try {
        closed = await BotRun.countDocuments({
          botId: bot.id, isEdgeTest: true, status: 'CLOSED',
        });
        wins = await BotRun.countDocuments({
          botId: bot.id, isEdgeTest: true, status: 'CLOSED', result: 'WIN',
        });
      } catch (_) {}

      const instanceId = this.instances.get(bot.id) || null;
      const instance = instanceId ? botRunner.get(instanceId) : null;
      const progress = this.targetSample > 0 ? Math.min(1, closed / this.targetSample) : 0;

      perBot.push({
        botId: bot.id,
        name: bot.name,
        assetClass: bot.assetClass,
        baseRate: bot.baseRate != null ? bot.baseRate : null,
        closedTrades: closed,
        wins,
        progress,
        targetSample: this.targetSample,
        running: !!instance,
        stopped: this.stoppedBots.has(bot.id),
        lastReason: instance ? instance.lastReason : null,
        pnl: instance && instance.stats ? instance.stats.pnl : null,
        flipped: instance && instance.stats ? !!instance.stats.flipped : false,
        recentWinRate: instance && instance.stats ? instance.stats.recentWinRate : null,
      });
    }

    const totalClosed = perBot.reduce((s, b) => s + b.closedTrades, 0);
    const totalTarget = this.targetSample * bots.length;
    const overallProgress = totalTarget > 0 ? totalClosed / totalTarget : 0;

    return {
      running: this.running,
      startedAt: this.startedAt,
      targetSample: this.targetSample,
      stake: this.stake,
      totalClosed,
      totalTarget,
      overallProgress,
      bots: perBot,
    };
  }

  // ──────────────────────────────────────────────────────────
  // RESULTS — full statistical analysis with verdicts
  // ──────────────────────────────────────────────────────────
  async results() {
    const bots = listBots();
    const perBot = [];

    for (const bot of bots) {
      const docs = await BotRun.find({
        botId: bot.id, isEdgeTest: true, status: 'CLOSED',
      }).lean();

      const stats = this._aggregate(docs, bot.baseRate != null ? bot.baseRate : 0.5);
      const verdict = this._verdict(stats, bot.baseRate != null ? bot.baseRate : 0.5);
      perBot.push({
        botId: bot.id,
        name: bot.name,
        assetClass: bot.assetClass,
        baseRate: bot.baseRate != null ? bot.baseRate : 0.5,
        ...stats,
        verdict: verdict.code,
        verdictReason: verdict.reason,
      });
    }

    const withEdge = perBot.filter(b => b.verdict === 'EDGE');
    const failed = perBot.filter(b => b.verdict === 'NO_EDGE');
    const pending = perBot.filter(b => b.verdict === 'NEED_MORE_DATA');

    // Recommendation: for each regime, list top 3 bots with EDGE verdict that
    // performed in that regime. Frontend can pick based on current regime.
    const recommendations = {};
    for (const b of withEdge) {
      for (const [regime, data] of Object.entries(b.byRegime || {})) {
        if (!recommendations[regime]) recommendations[regime] = [];
        if (data.trades >= 10) {
          recommendations[regime].push({
            botId: b.botId,
            name: b.name,
            trades: data.trades,
            winRate: data.winRate,
            pnl: data.pnl,
          });
        }
      }
    }
    for (const regime in recommendations) {
      recommendations[regime].sort((a, b) => b.winRate - a.winRate);
      recommendations[regime] = recommendations[regime].slice(0, 3);
    }

    return {
      running: this.running,
      startedAt: this.startedAt,
      targetSample: this.targetSample,
      stake: this.stake,
      bots: perBot,
      summary: {
        totalBots: perBot.length,
        withEdge: withEdge.length,
        noEdge: failed.length,
        needMoreData: pending.length,
        totalClosedTrades: perBot.reduce((s, b) => s + b.closedTrades, 0),
      },
      recommendations,
    };
  }

  // ──────────────────────────────────────────────────────────
  // CSV EXPORT — all edge test trades, fully enriched
  // ──────────────────────────────────────────────────────────
  async exportCSV() {
    const docs = await BotRun.find({ isEdgeTest: true })
      .sort({ openedAt: 1 })
      .lean();

    if (docs.length === 0) {
      return null; // caller returns 404
    }

    const headers = [
      'Opened', 'Closed', 'Bot', 'Symbol', 'Side', 'ContractType',
      'Stake', 'Multiplier', 'Duration', 'DurationUnit',
      'EntryPrice', 'ExitPrice', 'TakeProfit', 'Knockout',
      'PnL', 'Result', 'Status',
      'Session', 'Flip', 'RegimeCode', 'RegimeConfidence',
      'Confidence', 'PredictedDirection',
      'PatternBias', 'PatternConfidence', 'Patterns',
      'MomentumRoc', 'MomentumDir', 'MomentumConsecutive',
      'VolatilityRegime', 'VolatilityRatio',
      'StrategyAction', 'StrategyDirection', 'StrategyConfidence', 'StrategyAgreeing',
      'DigitSampleSize', 'DigitEvenPct', 'DigitOddPct', 'DigitRisePct', 'DigitFallPct',
      'RecentWinRateAtEntry',
      'Reasons',
    ];

    const rows = [headers.join(',')];

    for (const d of docs) {
      const thesis = d.entryThesis || {};
      const pattern = thesis.pattern || {};
      const momentum = thesis.momentum || {};
      const volatility = thesis.volatility || {};
      const consensus = thesis.strategyConsensus || {};
      const dv = thesis.digitView || {};

      const row = [
        this._iso(d.openedAt),
        this._iso(d.closedAt),
        this._csv(d.botId),
        this._csv(d.symbol),
        this._csv(d.side),
        this._csv(d.contractType),
        this._num(d.stake),
        this._num(d.multiplier),
        this._num(d.duration),
        this._csv(d.durationUnit),
        this._num(d.entryPrice),
        this._num(d.closePrice),
        this._num(d.takeProfitLevel),
        this._num(d.knockoutLevel),
        this._num(d.pnl),
        this._csv(d.result),
        this._csv(d.status),
        this._csv(d.session),
        this._csv(thesis.flip || 'NORMAL'),
        this._csv(d.regimeCode),
        this._num(thesis.regimeConfidence),
        this._num(thesis.confidence),
        this._csv(thesis.direction),
        this._csv(pattern.bias),
        this._num(pattern.confidence),
        this._csv((pattern.patterns || []).join('|')),
        this._num(momentum.roc),
        this._csv(momentum.direction),
        this._num(momentum.consecutive),
        this._csv(volatility.regime),
        this._num(volatility.ratio),
        this._csv(consensus.action),
        this._csv(consensus.direction),
        this._num(consensus.confidence),
        this._csv((consensus.agreeing || []).join('|')),
        this._num(dv.sampleSize),
        this._num(dv.evenPct),
        this._num(dv.oddPct),
        this._num(dv.risePct),
        this._num(dv.fallPct),
        this._num(thesis.recentWinRate),
        this._csv((d.reasons || []).join(' | ')),
      ];

      rows.push(row.join(','));
    }

    return rows.join('\n');
  }

  // ──────────────────────────────────────────────────────────
  // RESET — delete all edge test BotRun docs (requires stopped state)
  // ──────────────────────────────────────────────────────────
  async reset() {
    if (this.running) {
      throw new Error('Cannot reset while edge test is running. Stop it first.');
    }
    const result = await BotRun.deleteMany({ isEdgeTest: true });
    this.stoppedBots.clear();
    this.instances.clear();
    this.startedAt = null;
    logger.info(`[EdgeTest] Reset — deleted ${result.deletedCount} edge test BotRun docs.`);
    return { ok: true, deletedCount: result.deletedCount || 0 };
  }

  // ──────────────────────────────────────────────────────────
  // DELETE BOT — wipe one bot's edge test history
  // Stops the bot's running instance (if any) so its in-memory
  // stats are discarded — prevents stale flip state carrying over.
  // ──────────────────────────────────────────────────────────
  async deleteBot(botId) {
    if (!botId) throw new Error('botId required');

    // Stop the running instance for this bot (if any)
    const instanceId = this.instances.get(botId);
    if (instanceId) {
      try {
        botRunner.stop(instanceId);
        logger.info(`[EdgeTest] Stopped ${botId} before deleting its history.`);
      } catch (err) {
        logger.warn(`[EdgeTest] Failed to stop ${botId}: ${err.message}`);
      }
      this.instances.delete(botId);
    }
    this.stoppedBots.delete(botId);

    const result = await BotRun.deleteMany({ botId, isEdgeTest: true });
    logger.info(`[EdgeTest] Deleted ${result.deletedCount} edge trades for ${botId}`);

    return {
      ok: true,
      botId,
      deletedCount: result.deletedCount || 0,
      stoppedInstance: instanceId || null,
    };
  }

  // ──────────────────────────────────────────────────────────
  // RESET ALL — stop test if running, then wipe everything
  // This is the "Reset & Restart" flow. Safer than reset() because
  // it stops the test automatically instead of throwing.
  // ──────────────────────────────────────────────────────────
  async resetAll() {
    const wasRunning = this.running;
    if (wasRunning) {
      this.stop();
    }
    const result = await BotRun.deleteMany({ isEdgeTest: true });
    this.stoppedBots.clear();
    this.instances.clear();
    this.startedAt = null;
    this.running = false;
    logger.info(`[EdgeTest] Reset ALL — deleted ${result.deletedCount} edge trades (was running: ${wasRunning})`);
    return {
      ok: true,
      deletedCount: result.deletedCount || 0,
      wasRunning,
    };
  }

  // ──────────────────────────────────────────────────────────
  // STATS HELPERS
  // ──────────────────────────────────────────────────────────
  _aggregate(docs, baseRate) {
    const total = docs.length;
    const wins = docs.filter(d => d.result === 'WIN').length;
    const losses = docs.filter(d => d.result === 'LOSS').length;
    const breakevens = docs.filter(d => d.result === 'BREAKEVEN').length;
    const pnl = docs.reduce((s, d) => s + (Number(d.pnl) || 0), 0);
    const winPnls = docs.filter(d => d.result === 'WIN').map(d => Number(d.pnl) || 0);
    const lossPnls = docs.filter(d => d.result === 'LOSS').map(d => Math.abs(Number(d.pnl) || 0));
    const avgWin = winPnls.length ? winPnls.reduce((a, b) => a + b, 0) / winPnls.length : 0;
    const avgLoss = lossPnls.length ? lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length : 0;
    const rr = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? Infinity : 0);
    const winRate = total > 0 ? wins / total : 0;

    // Binomial z-score: (observed - expected) / sqrt(N * p * (1-p))
    const expected = total * baseRate;
    const variance = total * baseRate * (1 - baseRate);
    const zScore = variance > 0 ? (wins - expected) / Math.sqrt(variance) : 0;

    const byRegime = {};
    const bySession = {};
    for (const d of docs) {
      const r = d.regimeCode || 'UNKNOWN';
      const s = d.session || 'UNKNOWN';
      for (const [key, bucket] of [[r, byRegime], [s, bySession]]) {
        if (!bucket[key]) bucket[key] = { wins: 0, losses: 0, trades: 0, pnl: 0, winRate: 0 };
        bucket[key].trades++;
        bucket[key].pnl += Number(d.pnl) || 0;
        if (d.result === 'WIN') bucket[key].wins++;
        else if (d.result === 'LOSS') bucket[key].losses++;
      }
    }
    for (const r in byRegime) {
      byRegime[r].winRate = byRegime[r].trades > 0 ? byRegime[r].wins / byRegime[r].trades : 0;
    }
    for (const s in bySession) {
      bySession[s].winRate = bySession[s].trades > 0 ? bySession[s].wins / bySession[s].trades : 0;
    }

    return {
      closedTrades: total,
      wins, losses, breakevens,
      winRate: Number(winRate.toFixed(4)),
      baseRate,
      edge: Number((winRate - baseRate).toFixed(4)),
      pnl: Number(pnl.toFixed(2)),
      avgWin: Number(avgWin.toFixed(2)),
      avgLoss: Number(avgLoss.toFixed(2)),
      rr: Number.isFinite(rr) ? Number(rr.toFixed(2)) : null,
      zScore: Number(zScore.toFixed(2)),
      byRegime,
      bySession,
    };
  }

  _verdict(stats, baseRate) {
    if (stats.closedTrades < this.targetSample) {
      return {
        code: 'NEED_MORE_DATA',
        reason: `${stats.closedTrades} / ${this.targetSample} closed trades`,
      };
    }
    if (stats.zScore >= Z_THRESHOLD) {
      return {
        code: 'EDGE',
        reason: `Win rate ${(stats.winRate * 100).toFixed(1)}% vs base ${(baseRate * 100).toFixed(0)}%, z=${stats.zScore}`,
      };
    }
    if (stats.zScore <= -Z_THRESHOLD) {
      return {
        code: 'NO_EDGE',
        reason: `Significantly worse than base rate (z=${stats.zScore})`,
      };
    }
    return {
      code: 'NO_EDGE',
      reason: `Win rate ${(stats.winRate * 100).toFixed(1)}% not distinguishable from base ${(baseRate * 100).toFixed(0)}% (z=${stats.zScore})`,
    };
  }

  _num(v) {
    if (v == null || v === '') return '';
    const n = Number(v);
    return Number.isFinite(n) ? String(n) : '';
  }
  _csv(v) {
    if (v == null) return '';
    const s = String(v);
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  _iso(v) {
    if (!v) return '';
    try { return new Date(v).toISOString(); } catch (_) { return ''; }
  }
}

module.exports = new EdgeTest();
