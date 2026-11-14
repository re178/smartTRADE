// core/bots/runner.js
'use strict';

const EventEmitter = require('events');
const BotRun = require('../../models/BotRun');
const contractService = require('../execution/contractService');
const { getBroker } = require('../execution/brokerFactory');
const { getBot } = require('./registry');
const ranker = require('../strategy/ranker');
const predictor = require('../intelligence/patterns/predictor');
const deepMarketState = require('../intelligence/deep/marketState');
const digitAnalyzer = require('../intelligence/digit/analyzer');
const candleHistory = require('../data/candleHistory');
const eventBus = require('../../infrastructure/eventBus');
const logger = require('../../infrastructure/logger') || console;

function normalizeSymbol(s) { return String(s || '').replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase(); }

function round2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}
function toCents(n) {
  return Math.round(Number(n) * 100);
}

const SESSION_RANGES = [
  { code: 'ASIAN',             start: 0,  end: 7  },
  { code: 'LONDON',            start: 7,  end: 12 },
  { code: 'LONDON_NY_OVERLAP', start: 12, end: 16 },
  { code: 'NEW_YORK',          start: 16, end: 21 },
  { code: 'AFTER_HOURS',       start: 21, end: 24 },
];

function detectSession(date = new Date()) {
  const h = date.getUTCHours();
  for (const s of SESSION_RANGES) {
    if (h >= s.start && h < s.end) return s.code;
  }
  return 'AFTER_HOURS';
}

const FLIP_HISTORY_MAX = 50;

const SYMBOL_LOCK_TTL_MS = 30_000;
const SYMBOL_LOCK_TAIL_MS = 5_000;

const ENTRY_FAILURE_BACKOFF_MS = 30_000;
const OPEN_POSITION_BACKOFF_MS = 60_000;

const RECONCILE_POSITION_GRACE_MS = 2500;
const RECONCILE_POSITION_LOOKBACK_MS = 60_000;

// Settlement-aware re-entry guards (replaces the old blind 15s cooldown).
//  • MIN_REENTRY_MS: a small safety net to prevent stutter-fire.
//  • POST_CLOSE_BUFFER_MS: brief pause after a trade settles so the broker
//    portfolio cache can reflect the closure before the next evaluation.
//  The open-position check is the PRIMARY guard; these are secondary.
const MIN_REENTRY_MS = 3_000;
const POST_CLOSE_BUFFER_MS = 1_000;

// Short-TTL positions cache — prevents duplicated getOpenTrades() calls
// inside a single cycle without ever skipping the pre-order freshness check.
const POSITIONS_CACHE_TTL_MS = 1_500;

const BUY_CONTRACT_TYPES = new Set([
  'MULTUP', 'CALL', 'DIGITEVEN', 'DIGITOVER', 'DIGITMATCH', 'ONETOUCH',
  'VANILLALONGCALL', 'TURBOSLONG',
]);
const SELL_CONTRACT_TYPES = new Set([
  'MULTDOWN', 'PUT', 'DIGITODD', 'DIGITUNDER', 'DIGITDIFF', 'NOTOUCH',
  'VANILLALONGPUT', 'TURBOSHORT',
]);

const SHADOW_STALL_TIMEOUT_MS = 30_000;
const SHADOW_SEQUENCE_MAX = 20;

const HIGH_PAYOUT_CLASSES = new Set(['touch', 'vanilla', 'turbo', 'accumulator']);
const TRAIL_ELIGIBLE_CLASSES = new Set(['vanilla', 'turbo']);

class BotRunner extends EventEmitter {
  constructor() {
    super();
    this._instances = new Map();
    this._nextInstanceId = 1;
    this._symbolLocks = new Map();
    this._positionsCache = { at: 0, data: null, ttl: POSITIONS_CACHE_TTL_MS };
    this._metrics = {
      reconcilePositionAttempts: 0,
      reconcilePositionRecovered: 0,
      lastReconciledAt: null,
      lastOriginalError: null,
      shadowPlaced: 0,
      shadowResolved: 0,
      shadowWins: 0,
      shadowLosses: 0,
      trailingExits: 0,
      trailingSkipped: 0,
      openPositionRejections: 0,
      compoundGrowths: 0,
      compoundResets: 0,
    };
  }

  start(botId, config = {}) {
    const bot = getBot(botId);
    if (!bot) throw new Error(`Unknown bot: ${botId}`);

    const instanceId = `bot-${this._nextInstanceId++}-${Date.now()}`;
    const finalConfig = Object.assign({}, bot.defaultConfig, config || {});
    const symbol = normalizeSymbol(finalConfig.symbol);

    const mode = this._shadowModeForConfig(finalConfig, bot);
    const shadow = mode !== 'off' ? {
      enabled: true,
      mode,
      originalGate: Number(finalConfig.shadowWinsRequired) || 0,
      currentGate: Number(finalConfig.shadowWinsRequired) || 0,
      shadowRequired: mode === 'gated',
      consecutiveShadowWins: 0,
      gateTightenCount: 0,
      sequence: [],
      stats: { wins: 0, losses: 0, total: 0, winRate: 0 },
      pending: [],
    } : null;

    const compound = this._buildCompoundState(finalConfig, bot);

    const instance = {
      instanceId, botId, name: bot.name, assetClass: bot.assetClass, contractClass: bot.contractClass,
      symbol, config: finalConfig, status: 'RUNNING', startedAt: new Date(), lastRunAt: null, lastReason: null,
      timer: null, _running: false, _lastEntryTime: 0,
      _lastCloseTime: 0,
      _lastEvaluatedSampleSize: 0,
      _entryFailureBackoffUntil: 0,
      shadow,
      compound,
      _trailingPeaks: new Map(),
      stats: {
        runs: 0, entries: 0, wins: 0, losses: 0, pnl: 0, peakPnl: 0, consecutiveLosses: 0,
        closedTrades: 0,

        normalTrades: 0, normalWins: 0, normalPnl: 0,
        flippedTrades: 0, flippedWins: 0, flippedPnl: 0,

        phaseTrades: 0, phaseWins: 0, phasePnl: 0,

        flipped: false,
        flipHistory: [],
        flipCount: 0,
      },
    };

    // Faster cadence for non-FX — combats the old "up to 5s of stale signal"
    // problem. The per-cycle tick short-circuit prevents busy-spinning.
    const intervalMs = bot.assetClass === 'fx' ? 15000 : 1000;
    instance.timer = setInterval(() => { this._runCycle(instance).catch(() => {}); }, intervalMs);
    if (typeof instance.timer.unref === 'function') instance.timer.unref();

    this._instances.set(instanceId, instance);
    logger.info(
      `[BotRunner] Started ${bot.name} (${instanceId}) on ${symbol}` +
      (finalConfig._edgeTest ? ' [EDGE TEST]' : '') +
      (mode !== 'off' ? ` [SHADOW ${mode.toUpperCase()}${mode === 'gated' ? ` gate=${shadow.currentGate} stake=$${finalConfig.shadowStake}` : ''}]` : '') +
      (TRAIL_ELIGIBLE_CLASSES.has(bot.contractClass) && finalConfig.trailingEnabled ? ' [TRAILING]' : '') +
      (compound ? ` [COMPOUND base=$${compound.baseStake} max=$${compound.maxStake} rate=${compound.growthRatePct}%]` : '')
    );
    const summary = this._summarize(instance);
    this.emit('botStarted', summary);
    setTimeout(() => { this._runCycle(instance).catch(() => {}); }, 500);
    return summary;
  }

  _buildCompoundState(config, bot) {
    if (!bot || bot.assetClass !== 'synthetic_binary') return null;
    if (!config.compoundEnabled) return null;

    const baseStake = Math.max(0.01, round2(Number(config.stake) || 1));
    const maxStake = Math.max(baseStake, round2(Number(config.compoundMaxStake) || 10));
    const growthRatePct = Math.max(0, Number(config.compoundGrowthRatePct) || 0);

    return {
      enabled: true,
      baseStake,
      currentStake: Math.min(baseStake, maxStake),
      maxStake,
      startAfterWins: Math.max(0, Number(config.compoundStartAfterWins) || 0),
      growthRatePct,
      stopAfterWins: Math.max(0, Number(config.compoundStopAfterWins) || 0),
      resetAfterWins: Math.max(0, Number(config.compoundResetAfterWins) || 0),
      winsSinceReset: 0,
      growthCount: 0,
      resetCount: 0,
      lastGrowthAt: null,
      lastResetAt: null,
    };
  }

  // ─────────────────────────────────────────────────────────────
  //  Shadow mode resolution.
  //
  //  [FIX-SHADOW-LOWPAYOUT] Binary contracts (~0.88× payout) cannot
  //  sustain real-money shadow validation. They are forced into
  //  'observational' mode (mirror real trade result) regardless of the
  //  legacy shadowWinsRequired flag — prevents the costly real-money
  //  gate on rise/fall and vol bots.
  // ─────────────────────────────────────────────────────────────
  _shadowModeForConfig(config, bot) {
    if (!bot || bot.assetClass !== 'synthetic_binary') return 'off';
    if (config._edgeTest) return 'off';

    if (bot.contractClass === 'binary') {
      const obs = !!config.shadowObservational;
      const wins = Number(config.shadowWinsRequired) || 0;
      // Even a legacy config with wins > 0 is downgraded to observational.
      if (wins > 0 || obs) return 'observational';
      return 'off';
    }

    const wins = Number(config.shadowWinsRequired) || 0;
    if (wins > 0) return 'gated';
    if (!!config.shadowObservational) return 'observational';
    return 'off';
  }

  _shadowConfig(instance) {
    if (!instance.shadow) return { gating: false, tracking: false, mode: 'off' };
    const wins = Number(instance.config.shadowWinsRequired) || 0;
    const obs = !!instance.config.shadowObservational;
    return {
      mode: instance.shadow.mode,
      gating: wins > 0 && instance.shadow.mode === 'gated',
      tracking: wins > 0 || obs,
    };
  }

  stop(instanceId) {
    const instance = this._instances.get(instanceId);
    if (!instance) return null;
    if (instance.timer) clearInterval(instance.timer);
    instance.status = 'STOPPED';
    instance.stoppedAt = new Date();
    for (const [sym, lock] of this._symbolLocks) {
      if (lock.instanceId === instanceId) this._symbolLocks.delete(sym);
    }
    if (instance._trailingPeaks) instance._trailingPeaks.clear();
    this._instances.delete(instanceId);
    logger.info(`[BotRunner] Stopped ${instance.name} (${instanceId})`);
    const summary = this._summarize(instance);
    this.emit('botStopped', summary);
    return summary;
  }

  stopAll() {
    const ids = Array.from(this._instances.keys());
    for (const id of ids) this.stop(id);
    return ids.length;
  }

  list() { return Array.from(this._instances.values()).map(i => this._summarize(i)); }
  get(instanceId) { const i = this._instances.get(instanceId); return i ? this._summarize(i) : null; }

  async forceRealTrade(instanceId) {
    const instance = this._instances.get(instanceId);
    if (!instance) return { success: false, error: 'Instance not found' };
    if (instance.status !== 'RUNNING') return { success: false, error: 'Bot is not running' };
    if (instance._running) return { success: false, error: 'A cycle is already in progress — try again in a moment' };
    if (instance._lastEntryTime && Date.now() - instance._lastEntryTime < MIN_REENTRY_MS) {
      return { success: false, error: `Recent entry — wait ${Math.ceil((MIN_REENTRY_MS - (Date.now() - instance._lastEntryTime)) / 1000)}s before forcing another` };
    }

    const entriesBefore = instance.stats.entries;
    instance._forceRealOnce = true;
    try {
      await this._runCycle(instance);
    } catch (err) {
      instance._forceRealOnce = false;
      return { success: false, error: `Cycle error: ${err.message}` };
    }
    instance._forceRealOnce = false;

    const fired = instance.stats.entries > entriesBefore;
    if (fired) {
      return { success: true, fired: true, reason: 'REAL trade fired (manual override)', lastReason: instance.lastReason };
    }
    return { success: false, fired: false, error: instance.lastReason || 'No ENTER signal on this cycle (WAIT)' };
  }

  getStats() {
    return {
      reconcilePosition: {
        attempts: this._metrics.reconcilePositionAttempts,
        recovered: this._metrics.reconcilePositionRecovered,
        lastReconciledAt: this._metrics.lastReconciledAt,
        lastOriginalError: this._metrics.lastOriginalError,
      },
      shadow: {
        placed: this._metrics.shadowPlaced,
        resolved: this._metrics.shadowResolved,
        wins: this._metrics.shadowWins,
        losses: this._metrics.shadowLosses,
        winRate: this._metrics.shadowResolved > 0
          ? Number((this._metrics.shadowWins / this._metrics.shadowResolved).toFixed(3))
          : 0,
      },
      trailing: {
        exits: this._metrics.trailingExits,
        skipped: this._metrics.trailingSkipped,
        instancesWithTrailing: Array.from(this._instances.values())
          .filter(i => TRAIL_ELIGIBLE_CLASSES.has(i.contractClass) && i.config.trailingEnabled)
          .length,
      },
      compound: {
        growths: this._metrics.compoundGrowths,
        resets: this._metrics.compoundResets,
        instancesWithCompound: Array.from(this._instances.values())
          .filter(i => i.compound && i.compound.enabled)
          .length,
      },
      openPositionRejections: this._metrics.openPositionRejections,
      runningInstances: this._instances.size,
      symbolLocks: this._symbolLocks.size,
    };
  }

  // ─────────────────────────────────────────────────────────────
  //  Positions cache — shared across a single cycle, short TTL.
  // ─────────────────────────────────────────────────────────────
  async _getPositions(forceFresh = false) {
    const now = Date.now();
    if (!forceFresh && this._positionsCache.data && (now - this._positionsCache.at) < this._positionsCache.ttl) {
      return this._positionsCache.data;
    }
    const broker = getBroker('deriv_cfd');
    if (forceFresh && broker._portfolioCache) broker._portfolioCache.at = 0;
    try {
      const data = await broker.getOpenTrades();
      this._positionsCache = {
        at: now,
        data: Array.isArray(data) ? data : [],
        ttl: POSITIONS_CACHE_TTL_MS,
      };
      return this._positionsCache.data;
    } catch (_) {
      return this._positionsCache.data || [];
    }
  }

  _invalidatePositions() {
    this._positionsCache = { at: 0, data: null, ttl: POSITIONS_CACHE_TTL_MS };
    const broker = getBroker('deriv_cfd');
    if (broker && broker._portfolioCache) broker._portfolioCache.at = 0;
  }

  // ─────────────────────────────────────────────────────────────
  //  Compound stake
  // ─────────────────────────────────────────────────────────────
  _getEffectiveStake(instance, tradeParams) {
    if (instance.compound && instance.compound.enabled) {
      return round2(instance.compound.currentStake);
    }
    const configStake = instance.config.stake;
    const hasConfigStake =
      configStake != null && configStake !== '' &&
      Number.isFinite(Number(configStake)) && Number(configStake) > 0;
    return hasConfigStake ? Number(configStake) : (tradeParams ? tradeParams.stake : 1);
  }

  _applyCompoundAfterWin(instance, run) {
    if (!instance.compound || !instance.compound.enabled) return;
    if (!run || run.result !== 'WIN') return;
    if (run.shadowPhase) return;

    const c = instance.compound;
    c.winsSinceReset += 1;

    if (c.resetAfterWins > 0 && c.winsSinceReset >= c.resetAfterWins) {
      const oldStake = c.currentStake;
      c.currentStake = Math.min(round2(c.baseStake), c.maxStake);
      const oldWins = c.winsSinceReset;
      c.winsSinceReset = 0;
      c.resetCount++;
      c.lastResetAt = new Date().toISOString();
      this._metrics.compoundResets++;
      logger.info(
        `[BotRunner] ${instance.instanceId}: COMPOUND RESET after ${oldWins} wins — ` +
        `stake $${oldStake.toFixed(2)} → $${c.currentStake.toFixed(2)} (base)`
      );
      this.emit('botCompoundReset', {
        instanceId: instance.instanceId, botId: instance.botId,
        winsSinceResetBeforeReset: oldWins,
        oldStake: Number(oldStake.toFixed(2)),
        newStake: Number(c.currentStake.toFixed(2)),
        resetCount: c.resetCount,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (c.winsSinceReset <= c.startAfterWins) return;
    if (c.stopAfterWins > 0 && c.winsSinceReset > c.stopAfterWins) return;

    const oldStake = round2(c.currentStake);
    const factor = 1 + c.growthRatePct / 100;
    const grownRaw = round2(oldStake * factor);
    const grown = Math.min(grownRaw, c.maxStake);

    if (toCents(grown) > toCents(oldStake)) {
      c.currentStake = grown;
      c.growthCount++;
      c.lastGrowthAt = new Date().toISOString();
      this._metrics.compoundGrowths++;
      logger.info(
        `[BotRunner] ${instance.instanceId}: COMPOUND GROW win #${c.winsSinceReset} — ` +
        `stake $${oldStake.toFixed(2)} → $${grown.toFixed(2)} ` +
        `(rate=${c.growthRatePct}%, max=$${c.maxStake})`
      );
      this.emit('botCompoundGrow', {
        instanceId: instance.instanceId, botId: instance.botId,
        winsSinceReset: c.winsSinceReset,
        oldStake: Number(oldStake.toFixed(2)),
        newStake: Number(grown.toFixed(2)),
        maxStake: c.maxStake,
        growthRatePct: c.growthRatePct,
        growthCount: c.growthCount,
        timestamp: new Date().toISOString(),
      });
    }
  }

  _tryAcquireSymbolLock(symbol, instanceId, ttlMs = SYMBOL_LOCK_TTL_MS) {
    const now = Date.now();
    const existing = this._symbolLocks.get(symbol);
    if (existing && existing.expiresAt > now && existing.instanceId !== instanceId) return false;
    this._symbolLocks.set(symbol, { instanceId, acquiredAt: now, expiresAt: now + ttlMs });
    return true;
  }

  _releaseSymbolLock(symbol, instanceId) {
    const lock = this._symbolLocks.get(symbol);
    if (lock && lock.instanceId === instanceId) this._symbolLocks.delete(symbol);
  }

  _shortenSymbolLock(symbol, instanceId, ttlMs = SYMBOL_LOCK_TAIL_MS) {
    const lock = this._symbolLocks.get(symbol);
    if (lock && lock.instanceId === instanceId) {
      this._symbolLocks.set(symbol, { ...lock, expiresAt: Date.now() + ttlMs });
    }
  }

  _cleanupExpiredLocks() {
    const now = Date.now();
    for (const [sym, lock] of this._symbolLocks) {
      if (lock.expiresAt <= now) this._symbolLocks.delete(sym);
    }
  }

  async _manageTrailingExits(instance) {
    if (!instance.config.trailingEnabled) return;
    if (instance.config._edgeTest) return;
    if (!TRAIL_ELIGIBLE_CLASSES.has(instance.contractClass)) return;

    let positions;
    try { positions = await this._getPositions(); }
    catch (_) { return; }
    if (!Array.isArray(positions) || positions.length === 0) {
      if (instance._trailingPeaks.size > 0) instance._trailingPeaks.clear();
      return;
    }

    const activateAfter = Number(instance.config.trailingActivateAfterUSD) || 2.0;
    const retracePct = Number(instance.config.trailingRetracePct) || 30;

    const liveIds = new Set();
    for (const pos of positions) {
      if (normalizeSymbol(pos.instrument) === instance.symbol) liveIds.add(String(pos.id));
    }
    for (const cid of Array.from(instance._trailingPeaks.keys())) {
      if (!liveIds.has(cid)) instance._trailingPeaks.delete(cid);
    }

    for (const pos of positions) {
      if (normalizeSymbol(pos.instrument) !== instance.symbol) continue;
      const contractId = String(pos.id);
      const currentProfit = Number(pos.unrealizedPL || 0);

      let tracking = instance._trailingPeaks.get(contractId);
      if (!tracking) {
        tracking = { peakProfit: currentProfit, entryPrice: Number(pos.entryPrice || 0), activatedAt: null };
        instance._trailingPeaks.set(contractId, tracking);
      }
      if (currentProfit > tracking.peakProfit) tracking.peakProfit = currentProfit;
      if (tracking.peakProfit < activateAfter) continue;

      if (tracking.activatedAt == null) {
        tracking.activatedAt = Date.now();
        logger.info(`[BotRunner] ${instance.instanceId}: trailing activated on ${contractId} (peak=$${tracking.peakProfit.toFixed(2)} ≥ $${activateAfter})`);
      }

      const closeBelow = tracking.peakProfit * (1 - retracePct / 100);
      if (currentProfit <= closeBelow) {
        logger.info(`[BotRunner] ${instance.instanceId}: trailing EXIT on ${contractId} (peak=$${tracking.peakProfit.toFixed(2)} current=$${currentProfit.toFixed(2)} retrace=$${(tracking.peakProfit - currentProfit).toFixed(2)} ≥ ${retracePct}% of peak)`);
        try {
          await getBroker('deriv_cfd').closeTrade(contractId);
          this._metrics.trailingExits++;
          instance._trailingPeaks.delete(contractId);
          instance.lastReason = `Trailing exit ${contractId} (peak $${tracking.peakProfit.toFixed(2)})`;
          this._invalidatePositions();
          this.emit('botTrailingExit', {
            instanceId: instance.instanceId, botId: instance.botId, contractId,
            peakProfit: Number(tracking.peakProfit.toFixed(2)),
            currentProfit: Number(currentProfit.toFixed(2)),
            retracePct, timestamp: new Date().toISOString(),
          });
        } catch (err) {
          logger.warn(`[BotRunner] ${instance.instanceId}: trailing close FAILED for ${contractId}: ${err.message}`);
          this._metrics.trailingSkipped++;
        }
      }
    }
  }

  // (Shadow reconstruction methods — kept as no-ops for safety, unchanged.)
  _resolvePendingShadows(instance) {
    if (!instance.shadow || instance.shadow.mode !== 'gated') return;
    if (instance.shadow.pending.length === 0) return;

    const dv = digitAnalyzer.getView(instance.symbol);
    if (!dv) return;

    const now = Date.now();
    const remaining = [];

    for (const shadow of instance.shadow.pending) {
      const ticksElapsed = Number(dv.sampleSize) - shadow.entryTickNum;
      const timeElapsed = now - shadow.startedAt;

      const ticksReady = ticksElapsed >= shadow.durationTicks;
      const feedStalled = timeElapsed > SHADOW_STALL_TIMEOUT_MS;

      if (!ticksReady && !feedStalled) {
        remaining.push(shadow);
        continue;
      }

      const exitPrice = Number(dv.price);
      let outcome;
      if (shadow.prediction === 'CALL') outcome = exitPrice > shadow.entryPrice ? 'W' : 'L';
      else if (shadow.prediction === 'PUT') outcome = exitPrice < shadow.entryPrice ? 'W' : 'L';
      else outcome = 'L';

      instance.shadow.sequence.push(outcome);
      if (instance.shadow.sequence.length > SHADOW_SEQUENCE_MAX) instance.shadow.sequence.shift();
      instance.shadow.stats.total++;
      if (outcome === 'W') { instance.shadow.consecutiveShadowWins++; instance.shadow.stats.wins++; this._metrics.shadowWins++; }
      else { instance.shadow.consecutiveShadowWins = 0; instance.shadow.stats.losses++; this._metrics.shadowLosses++; }
      instance.shadow.stats.winRate = instance.shadow.stats.total > 0
        ? Number((instance.shadow.stats.wins / instance.shadow.stats.total).toFixed(3))
        : 0;
      this._metrics.shadowResolved++;
    }

    instance.shadow.pending = remaining;
  }

  _recordShadowTrade(instance, signal, ctx) {
    if (!instance.shadow || !instance.shadow.enabled) return false;
    const { tradeParams } = signal;
    const dv = ctx && ctx.digitView;
    if (!dv) return false;
    const prediction = tradeParams.contractType;
    if (prediction !== 'CALL' && prediction !== 'PUT') return false;

    instance.shadow.pending.push({
      prediction,
      entryPrice: Number(dv.price),
      entryTickNum: Number(dv.sampleSize),
      durationTicks: Number(tradeParams.duration) || 5,
      startedAt: Date.now(),
    });
    this._metrics.shadowPlaced++;
    return true;
  }

  _applyObservationalShadow(instance, run) {
    if (!instance.shadow || instance.shadow.mode !== 'observational') return;
    if (!run || !run.result) return;
    if (run.result !== 'WIN' && run.result !== 'LOSS') return;

    const outcome = run.result === 'WIN' ? 'W' : 'L';

    instance.shadow.sequence.push(outcome);
    if (instance.shadow.sequence.length > SHADOW_SEQUENCE_MAX) instance.shadow.sequence.shift();
    instance.shadow.stats.total++;
    if (outcome === 'W') { instance.shadow.consecutiveShadowWins++; instance.shadow.stats.wins++; this._metrics.shadowWins++; }
    else { instance.shadow.consecutiveShadowWins = 0; instance.shadow.stats.losses++; this._metrics.shadowLosses++; }
    instance.shadow.stats.winRate = instance.shadow.stats.total > 0
      ? Number((instance.shadow.stats.wins / instance.shadow.stats.total).toFixed(3))
      : 0;
    this._metrics.shadowResolved++;

    logger.info(
      `[BotRunner] ${instance.instanceId}: SHADOW (observational) ${run.contractId} RESOLVED ${outcome} — ` +
      `${instance.shadow.stats.wins}W/${instance.shadow.stats.losses}L (${(instance.shadow.stats.winRate * 100).toFixed(0)}%)`
    );

    try {
      this.emit('botShadowResolved', {
        instanceId: instance.instanceId, botId: instance.botId,
        contractId: run.contractId, outcome,
        source: 'observational_real',
        shadowStats: { ...instance.shadow.stats },
        timestamp: new Date().toISOString(),
      });
    } catch (_) {}
  }

  _adaptGateAfterReal(instance, result) {
    if (!instance.shadow || !instance.shadow.enabled) return;
    if (instance.shadow.mode !== 'gated') return;

    if (result === 'WIN') {
      instance.shadow.consecutiveShadowWins = 0;
      instance.shadow.shadowRequired = false;
      logger.info(`[BotRunner] ${instance.instanceId}: REAL WIN → continue trading real (gate stays at ${instance.shadow.currentGate})`);
    } else if (result === 'LOSS') {
      instance.shadow.consecutiveShadowWins = 0;
      instance.shadow.shadowRequired = true;
      const oldGate = instance.shadow.currentGate;
      instance.shadow.currentGate = Math.min(10, oldGate + 1);
      instance.shadow.gateTightenCount++;
      logger.info(`[BotRunner] ${instance.instanceId}: REAL LOSS → back to shadow phase, gate ${oldGate} → ${instance.shadow.currentGate}`);
    }
  }

  _updateFlipState(instance) {
    const c = instance.config;
    const s = instance.stats;

    if (!c.flipEnabled) {
      if (s.flipped) {
        s.flipHistory.push({
          atTrade: s.closedTrades, from: true, to: false,
          reason: 'flipEnabled disabled via config',
          phaseTrades: s.phaseTrades, phasePnl: Number(s.phasePnl.toFixed(2)),
        });
        this._capFlipHistory(s);
        s.flipped = false;
        s.flipCount++;
      }
      return;
    }

    const minTrades = Number(c.flipMinTrades) || 20;
    const stableTrades = Number(c.flipStableTrades) || 20;
    const flipThreshold = Number(c.flipBelowPct) || 10;

    if (s.flipped) {
      if (s.phaseTrades < stableTrades) return;
      if (s.phasePnl < 0) {
        const phaseTradesAtToggle = s.phaseTrades;
        const phasePnlAtToggle = s.phasePnl;
        s.flipHistory.push({
          atTrade: s.closedTrades, from: true, to: false,
          reason: `flipped phase lost (${phaseTradesAtToggle} trades, $${phasePnlAtToggle.toFixed(2)})`,
          phaseTrades: phaseTradesAtToggle, phasePnl: Number(phasePnlAtToggle.toFixed(2)),
        });
        this._capFlipHistory(s);
        s.flipped = false;
        s.flipCount++;
        s.phaseTrades = 0; s.phaseWins = 0; s.phasePnl = 0;
        logger.info(`[BotRunner] ${instance.botId}/${instance.instanceId} UN-FLIP — flipped phase ${phaseTradesAtToggle} trades, PnL $${phasePnlAtToggle.toFixed(2)}`);
        this.emit('botFlip', { instanceId: instance.instanceId, botId: instance.botId, flipped: false, reason: 'flipped_phase_negative' });
      }
      return;
    }

    if (s.phaseTrades < minTrades) return;
    const normalWinRate = (s.phaseWins / s.phaseTrades) * 100;
    if (normalWinRate < flipThreshold) {
      const phaseTradesAtToggle = s.phaseTrades;
      const phasePnlAtToggle = s.phasePnl;
      s.flipHistory.push({
        atTrade: s.closedTrades, from: false, to: true,
        reason: `normal WR ${normalWinRate.toFixed(1)}% < ${flipThreshold}% (${phaseTradesAtToggle} trades)`,
        phaseTrades: phaseTradesAtToggle, phasePnl: Number(phasePnlAtToggle.toFixed(2)),
      });
      this._capFlipHistory(s);
      s.flipped = true;
      s.flipCount++;
      s.phaseTrades = 0; s.phaseWins = 0; s.phasePnl = 0;
      logger.info(`[BotRunner] ${instance.botId}/${instance.instanceId} FLIP ON — normal phase ${phaseTradesAtToggle} trades, WR ${normalWinRate.toFixed(1)}%`);
      this.emit('botFlip', { instanceId: instance.instanceId, botId: instance.botId, flipped: true, reason: 'normal_phase_low_winrate' });
    }
  }

  _capFlipHistory(s) {
    if (s.flipHistory.length > FLIP_HISTORY_MAX) s.flipHistory = s.flipHistory.slice(-FLIP_HISTORY_MAX);
  }

  async _runCycle(instance) {
    if (instance.status !== 'RUNNING') return;
    if (instance._running) return;
    instance._running = true;

    try {
      this._updateFlipState(instance);
      this._resolvePendingShadows(instance);

      try { await this._manageTrailingExits(instance); }
      catch (trErr) { logger.warn(`[BotRunner] ${instance.instanceId}: trailing check failed: ${trErr.message}`); }

      this._cleanupExpiredLocks();

      if (instance._entryFailureBackoffUntil && Date.now() < instance._entryFailureBackoffUntil) {
        const remaining = Math.ceil((instance._entryFailureBackoffUntil - Date.now()) / 1000);
        instance.lastReason = `Entry failure backoff (${remaining}s)`;
        return;
      }

      // Settlement-aware re-entry guards (replaced the old 15s blind cooldown).
      // The open-position check below is the PRIMARY guard; these are secondary.
      if (instance._lastEntryTime && Date.now() - instance._lastEntryTime < MIN_REENTRY_MS) {
        instance.lastReason = 'Reentry buffer (post-entry)';
        return;
      }
      if (instance._lastCloseTime && Date.now() - instance._lastCloseTime < POST_CLOSE_BUFFER_MS) {
        instance.lastReason = 'Awaiting settlement buffer';
        return;
      }

      const maxLosses = Number(instance.config.stopAfterLosses) || 0;
      if (maxLosses > 0 && instance.stats.consecutiveLosses >= maxLosses) {
        instance.lastReason = `Stopped: ${instance.stats.consecutiveLosses} consecutive losses (limit ${maxLosses})`;
        logger.warn(`[BotRunner] ${instance.instanceId} — ${instance.lastReason}`);
        this.stop(instance.instanceId);
        return;
      }

      const s = instance.stats;
      const tp = Number(instance.config.botTakeProfit) || 0;
      const slAmt = Math.abs(Number(instance.config.botStopLoss) || 0);
      const trailPct = Number(instance.config.trailingDrawdownPct) || 0;

      if (s.pnl > s.peakPnl) s.peakPnl = s.pnl;
      if (tp > 0 && s.pnl >= tp) {
        instance.lastReason = `Stopped: Take profit hit (+$${s.pnl.toFixed(2)} >= +$${tp})`;
        logger.info(`[BotRunner] ${instance.instanceId} — ${instance.lastReason}`);
        this.stop(instance.instanceId);
        return;
      }
      if (slAmt > 0 && s.pnl <= -slAmt) {
        instance.lastReason = `Stopped: Stop loss hit (${s.pnl.toFixed(2)} <= -$${slAmt})`;
        logger.info(`[BotRunner] ${instance.instanceId} — ${instance.lastReason}`);
        this.stop(instance.instanceId);
        return;
      }
      if (trailPct > 0 && s.peakPnl > 0) {
        const trailFloor = s.peakPnl * (1 - trailPct / 100);
        if (s.pnl <= trailFloor) {
          instance.lastReason = `Stopped: Trailing drawdown (${s.pnl.toFixed(2)} <= ${trailFloor.toFixed(2)}, peak +$${s.peakPnl.toFixed(2)})`;
          logger.info(`[BotRunner] ${instance.instanceId} — ${instance.lastReason}`);
          this.stop(instance.instanceId);
          return;
        }
      }

      const allowedSessions = instance.config.allowedSessions;
      if (Array.isArray(allowedSessions) && allowedSessions.length > 0) {
        const currentSession = detectSession();
        if (allowedSessions.indexOf(currentSession) < 0) {
          instance.lastReason = `Waiting: session ${currentSession} not in [${allowedSessions.join(',')}]`;
          return;
        }
      }

      instance.lastRunAt = new Date();
      const broker = getBroker('deriv_cfd');
      if (!broker.isConnected()) { instance.lastReason = 'broker disconnected'; return; }

      // Cached positions (short TTL) — never duplicates the pre-order freshness
      // check inside _execute (that call passes forceFresh=true).
      const positions = await this._getPositions();
      if (positions.some(p => normalizeSymbol(p.instrument) === instance.symbol)) {
        instance.lastReason = 'waiting for current trade to close';
        return;
      }

      const existingLock = this._symbolLocks.get(instance.symbol);
      if (existingLock && existingLock.expiresAt > Date.now() && existingLock.instanceId !== instance.instanceId) {
        instance.lastReason = `Symbol ${instance.symbol} locked by ${existingLock.instanceId}`;
        return;
      }

      const bot = getBot(instance.botId);
      const timeframe = instance.config.timeframe || 'M5';

      const ctx = { config: instance.config, stats: instance.stats };

      if (bot.assetClass === 'fx') {
        const state = await deepMarketState.compute(instance.symbol, timeframe, 200).catch(() => null);
        if (!state) { instance.lastReason = 'no deep state'; return; }
        ctx.state = state;
        const allowedRegimes = instance.config.allowedRegimes;
        if (Array.isArray(allowedRegimes) && allowedRegimes.length > 0) {
          const currentRegime = state.regime && state.regime.code;
          if (currentRegime && allowedRegimes.indexOf(currentRegime) < 0) {
            instance.lastReason = `Waiting: regime ${currentRegime} not in [${allowedRegimes.join(',')}]`;
            return;
          }
        }
        ctx.consensus = await ranker.rank(state, instance.symbol, { timeframe }).catch(() => null);
        ctx.prediction = await predictor.predict(instance.symbol, state, ctx.consensus, { timeframe }).catch(() => null);
        ctx.candles = await candleHistory.getHistory(instance.symbol, timeframe, 100).catch(() => []) || [];
      } else if (HIGH_PAYOUT_CLASSES.has(bot.contractClass)) {
        const state = await deepMarketState.compute(instance.symbol, timeframe, 200).catch(() => null);
        if (!state) { instance.lastReason = 'no deep state (candle history loading)'; return; }
        ctx.state = state;
        const allowedRegimes = instance.config.allowedRegimes;
        if (Array.isArray(allowedRegimes) && allowedRegimes.length > 0) {
          const currentRegime = state.regime && state.regime.code;
          if (currentRegime && allowedRegimes.indexOf(currentRegime) < 0) {
            instance.lastReason = `Waiting: regime ${currentRegime} not in [${allowedRegimes.join(',')}]`;
            return;
          }
        }
        ctx.consensus = await ranker.rank(state, instance.symbol, { timeframe }).catch(() => null);
        ctx.prediction = await predictor.predict(instance.symbol, state, ctx.consensus, { timeframe }).catch(() => null);
        ctx.candles = await candleHistory.getHistory(instance.symbol, timeframe, 100).catch(() => []) || [];
        const dv = digitAnalyzer.getView(instance.symbol);
        if (dv) ctx.digitView = dv;
      } else {
        const digitView = digitAnalyzer.getView(instance.symbol);
        if (!digitView) { instance.lastReason = 'no digit data'; return; }
        ctx.digitView = digitView;
      }

      // Tick short-circuit for lightweight digit bots: if no new tick has
      // arrived since the last evaluation, there is no new signal — skip.
      // This is what makes a 1-second polling cadence safe.
      if (bot.assetClass !== 'fx' && !HIGH_PAYOUT_CLASSES.has(bot.contractClass)) {
        if (ctx.digitView && ctx.digitView.sampleSize &&
            ctx.digitView.sampleSize === instance._lastEvaluatedSampleSize) {
          instance.lastReason = 'No new tick since last evaluation';
          return;
        }
      }

      instance.stats.runs++;

      let result;
      try { result = await bot.evaluate(ctx); }
      catch (evalErr) {
        instance.lastReason = `evaluate error: ${evalErr.message}`;
        logger.warn(`[BotRunner] ${instance.instanceId}: evaluate threw — ${evalErr.message}`);
        return;
      }

      if (ctx.digitView && ctx.digitView.sampleSize) {
        instance._lastEvaluatedSampleSize = ctx.digitView.sampleSize;
      }

      // NULL-SAFE WAIT branch — evaluate may legitimately return undefined.
      if (!result || result.action === 'WAIT') {
        instance.lastReason = (result && result.reasons && result.reasons[0]) || 'WAIT';
        this.emit('botCycle', {
          instanceId: instance.instanceId,
          botId: instance.botId,
          action: 'WAIT',
          reasons: (result && result.reasons) || [],
          symbol: instance.symbol,
        });
        return;
      }

      if (result.action === 'ENTER') {
        if (instance._forceRealOnce) {
          instance._forceRealOnce = false;
          logger.info(`[BotRunner] ${instance.instanceId}: FORCE REAL override — bypassing shadow gate`);
          instance.lastReason = 'FORCED REAL trade (manual override)';
          await this._execute(instance, result, ctx, 'real');
          return;
        }

        const shadowCfg = this._shadowConfig(instance);

        if (shadowCfg.gating) {
          const gateMet = instance.shadow.consecutiveShadowWins >= instance.shadow.currentGate;

          if (instance.shadow.shadowRequired && !gateMet) {
            instance.lastReason = `Shadow phase ${instance.shadow.consecutiveShadowWins}/${instance.shadow.currentGate} → firing $${instance.config.shadowStake}`;
            logger.info(
              `[BotRunner] ${instance.instanceId}: SHADOW-PHASE fire ` +
              `(${instance.shadow.consecutiveShadowWins}/${instance.shadow.currentGate} wins, ` +
              `stake=$${instance.config.shadowStake})`
            );
            await this._execute(instance, result, ctx, 'shadow');
            return;
          }

          if (gateMet && instance.shadow.shadowRequired) {
            logger.info(
              `[BotRunner] ${instance.instanceId}: SHADOW GATE MET ` +
              `(${instance.shadow.consecutiveShadowWins}/${instance.shadow.currentGate}) → REAL fire`
            );
            instance.lastReason = `Shadow gate met (${instance.shadow.consecutiveShadowWins}/${instance.shadow.currentGate}) → REAL trade`;
          }
          await this._execute(instance, result, ctx, 'real');
          return;
        }

        await this._execute(instance, result, ctx, 'real');
      }
    } catch (err) {
      logger.error(`[BotRunner] ${instance.instanceId} cycle exception: ${err.message}`);
      instance.lastReason = `cycle error: ${err.message}`;
    } finally {
      instance._running = false;
    }
  }

  _validateStake(instance, stake) {
    const requested = Number(stake);
    if (!Number.isFinite(requested) || requested <= 0) return { ok: false, reason: `Invalid stake: ${stake}` };
    const rawMax = instance.config.maxStake;
    if (rawMax == null || rawMax === '') return { ok: true, stake: requested };
    const cap = Number(rawMax);
    if (cap === 0) {
      logger.warn(`[BotRunner] ${instance.instanceId}: maxStake=0 treated as "no cap" — verify this is intended`);
      return { ok: true, stake: requested };
    }
    if (!Number.isFinite(cap) || cap < 0) return { ok: false, reason: `Invalid maxStake config: ${rawMax}` };
    if (requested > cap) return { ok: false, reason: `Stake ${requested} exceeds maxStake ${cap}` };
    return { ok: true, stake: requested };
  }

  _validateRiskReward(instance, tradeParams, ctx, direction) {
    if (tradeParams.contractClass !== 'multiplier') return { ok: true };
    const entryPrice = (ctx && ctx.state && ctx.state.price && ctx.state.price.current) || Number(tradeParams.entryPrice) || null;
    const ko = Number(tradeParams.knockoutLevel);
    const tp = Number(tradeParams.takeProfitLevel);
    const dir = tradeParams.direction || direction || null;

    if (Number.isFinite(entryPrice) && entryPrice > 0 && dir) {
      const isBuy = dir === 'BUY' || dir === 'MULTUP';
      if (Number.isFinite(ko)) {
        const wrongSide = isBuy ? ko >= entryPrice : ko <= entryPrice;
        if (wrongSide) return { ok: false, reason: `KO ${ko} on wrong side of entry ${entryPrice} for ${dir}` };
      }
      if (Number.isFinite(tp)) {
        const wrongSide = isBuy ? tp <= entryPrice : tp >= entryPrice;
        if (wrongSide) return { ok: false, reason: `TP ${tp} on wrong side of entry ${entryPrice} for ${dir}` };
      }
    }

    const minRR = Number(instance.config.minRiskReward) || 0;
    if (minRR <= 0) return { ok: true };
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return { ok: true };
    if (!Number.isFinite(ko) || !Number.isFinite(tp)) return { ok: true };
    const slDist = Math.abs(entryPrice - ko);
    const tpDist = Math.abs(tp - entryPrice);
    if (slDist <= 0) return { ok: false, reason: 'SL distance is zero (invalid levels)' };
    const rr = tpDist / slDist;
    if (rr < minRR) return { ok: false, reason: `RR ${rr.toFixed(2)} < minRiskReward ${minRR}`, rr };
    return { ok: true, rr };
  }

  _buildEntryThesis(instance, reasons, ctx, direction, tradeParams) {
    const isEdgeTest = !!instance.config._edgeTest;
    const session = detectSession();
    const flipLabel = instance.stats && instance.stats.flipped ? 'FLIPPED' : 'NORMAL';
    const phaseStats = instance.stats ? {
      phaseTrades: instance.stats.phaseTrades,
      phasePnl: Number(instance.stats.phasePnl.toFixed(2)),
      normalTrades: instance.stats.normalTrades,
      normalPnl: Number(instance.stats.normalPnl.toFixed(2)),
      flippedTrades: instance.stats.flippedTrades,
      flippedPnl: Number(instance.stats.flippedPnl.toFixed(2)),
      flipCount: instance.stats.flipCount,
    } : null;

    if (instance.assetClass === 'fx' || HIGH_PAYOUT_CLASSES.has(instance.contractClass)) {
      const pred = ctx && ctx.prediction;
      const st = ctx && ctx.state;
      const cons = ctx && ctx.consensus && ctx.consensus.consensus;
      return {
        botId: instance.botId, instanceId: instance.instanceId,
        reasons: reasons || [], edgeTest: isEdgeTest, session, flip: flipLabel, phaseStats,
        confidence: pred ? pred.calibratedConfidence : null,
        direction: pred ? pred.direction : (direction || null),
        predictedDirection: pred ? pred.direction : (direction || null),
        entryTickNum: null,
        expiry: tradeParams && tradeParams.duration ? {
          ticks: Number(tradeParams.duration),
          unit: tradeParams.durationUnit || null,
          at: (() => {
            const dur = Number(tradeParams.duration);
            const unit = tradeParams.durationUnit || 't';
            if (!Number.isFinite(dur) || dur <= 0) return null;
            const msPer = unit === 't' ? 2000 : unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 0;
            return msPer ? new Date(Date.now() + dur * msPer).toISOString() : null;
          })(),
        } : null,
        pattern: pred && pred.pattern ? { bias: pred.pattern.bias, confidence: pred.pattern.confidence, patterns: pred.pattern.patterns } : null,
        momentum: pred ? pred.momentum : null,
        volatility: pred ? pred.volatility : null,
        regime: st && st.regime ? st.regime.code : null,
        regimeConfidence: st && st.regime ? st.regime.confidence : null,
        strategyConsensus: cons ? { action: cons.action, direction: cons.direction, confidence: cons.confidence, agreeing: cons.agreeing } : null,
      };
    }

    const dv = ctx && ctx.digitView;
    const expiry = tradeParams ? (() => {
      const dur = Number(tradeParams.duration);
      const unit = tradeParams.durationUnit || 't';
      if (!Number.isFinite(dur) || dur <= 0) return null;
      const msPer = unit === 't' ? 2000 : unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 0;
      return {
        ticks: unit === 't' ? dur : null,
        unit,
        at: msPer ? new Date(Date.now() + dur * msPer).toISOString() : null,
      };
    })() : null;

    return {
      botId: instance.botId, instanceId: instance.instanceId,
      reasons: reasons || [], edgeTest: isEdgeTest, session, flip: flipLabel, phaseStats,
      // Backward-compatible snapshot (still consumed by existing dashboards).
      digitView: dv ? {
        sampleSize: dv.sampleSize, precision: dv.precision,
        evenPct: dv.evenPct, oddPct: dv.oddPct, risePct: dv.risePct, fallPct: dv.fallPct,
        evenStreak: dv.evenStreak, oddStreak: dv.oddStreak,
      } : null,
      // Complete measurement record — which calculation wins/loses daily.
      measurementSnapshot: dv ? {
        arrow: dv.arrow,
        directionalStreak: dv.directionalStreak,
        movement: dv.movement,
        windows: dv.windows,
        risePct: dv.risePct,
        fallPct: dv.fallPct,
        evenPct: dv.evenPct,
        oddPct: dv.oddPct,
        evenStreak: dv.evenStreak,
        oddStreak: dv.oddStreak,
        sampleSize: dv.sampleSize,
        precision: dv.precision,
      } : null,
      predictedDirection: direction || null,
      entryTickNum: dv ? dv.sampleSize : null,
      expiry,
    };
  }

  _isAmbiguousError(err) {
    if (!err || !err.message) return false;
    const msg = String(err.message);
    return (
      msg.includes('InvalidContractProposal') || msg.includes('timeout') ||
      msg.includes('Timeout') || msg.includes('Auth closed') ||
      msg.includes('Public closed') || msg.includes('Buy failed') ||
      msg.includes('Request cancelled') || msg.includes('WebSocket')
    );
  }

  async _reconcileOrphanPosition(instance, symbol, expectedSide, intendedStake) {
    this._metrics.reconcilePositionAttempts++;
    await new Promise(r => setTimeout(r, RECONCILE_POSITION_GRACE_MS));
    const broker = getBroker('deriv_cfd');
    const targetSymbol = normalizeSymbol(symbol);
    const submittedBefore = Date.now() - RECONCILE_POSITION_LOOKBACK_MS;
    const stakeNum = Math.abs(Number(intendedStake));
    if (broker._portfolioCache) broker._portfolioCache.at = 0;
    this._invalidatePositions();

    let positions;
    try { positions = await broker.getOpenTrades(); }
    catch (err) {
      logger.warn(`[BotRunner] _reconcileOrphanPosition: portfolio fetch failed: ${err.message}`);
      return null;
    }

    const candidates = positions.filter(p => {
      if (normalizeSymbol(p.instrument) !== targetSymbol) return false;
      if (expectedSide && p.side && p.side !== 'UNKNOWN' && p.side !== expectedSide) return false;
      if (Number.isFinite(stakeNum) && stakeNum > 0 && p.purchasePrice != null) {
        if (Math.abs(Number(p.purchasePrice) - stakeNum) > 0.01) return false;
      }
      if (p.openTime && p.openTime < submittedBefore) return false;
      return true;
    });

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (b.openTime || 0) - (a.openTime || 0));
    this._metrics.reconcilePositionRecovered++;
    this._metrics.lastReconciledAt = new Date().toISOString();
    logger.warn(`[BotRunner] _reconcileOrphanPosition: RECOVERED contract ${candidates[0].id} for ${instance.botId}/${instance.instanceId} — treating entry as success`);
    return candidates[0];
  }

  async _persistBotRun(instance, result, tradeParams, direction, stakeCheck, reasons, entryThesis, currentRegime, currentSession, shadowPhase = false) {
    const shadowSnapshot = instance.shadow && instance.shadow.enabled ? {
      shadowEnabled: true,
      shadowSequence: instance.shadow.sequence.slice(-SHADOW_SEQUENCE_MAX),
      shadowStats: { ...instance.shadow.stats },
      gateAtEntry: instance.shadow.currentGate,
      originalGate: instance.shadow.originalGate,
      gateTightenCount: instance.shadow.gateTightenCount,
    } : {
      shadowEnabled: false, shadowSequence: [], shadowStats: null,
      gateAtEntry: null, originalGate: null, gateTightenCount: 0,
    };

    const md = (result && result.metadata) || {};

    try {
      await BotRun.create({
        botId: instance.botId, instanceId: instance.instanceId, contractId: String(result.contractId),
        symbol: normalizeSymbol(instance.config.symbol), side: tradeParams.contractType || direction,
        contractType: tradeParams.contractType || null, stake: Number(stakeCheck.stake),
        multiplier: tradeParams.multiplier || null, duration: tradeParams.duration || null,
        durationUnit: tradeParams.durationUnit || null, barrier: tradeParams.barrier != null ? String(tradeParams.barrier) : null,
        entryPrice: result.entryPrice, takeProfitLevel: tradeParams.takeProfitLevel != null ? Number(tradeParams.takeProfitLevel) : null,
        knockoutLevel: tradeParams.knockoutLevel != null ? Number(tradeParams.knockoutLevel) : null,
        reasons: reasons || [], openedAt: new Date(), status: 'OPEN',
        isEdgeTest: !!instance.config._edgeTest,
        regimeCode: currentRegime, session: currentSession, entryThesis,
        ...shadowSnapshot,
        shadowPhase: !!shadowPhase,
        payoutPerPoint: md.payoutPerPoint != null ? Number(md.payoutPerPoint) : null,
        growthRate: md.growthRate != null ? Number(md.growthRate) : null,
        strikePrice: md.strikePrice != null ? Number(md.strikePrice) : null,
        touchBarrier: md.touchBarrier != null ? Number(md.touchBarrier) : null,
        touchDirection: md.touchDirection || null,
      });
    } catch (persistErr) {
      logger.error(`[BotRunner] BotRun persist failed for ${result.contractId} (${instance.botId}/${instance.instanceId}): ${persistErr.message}`);
    }
  }

  async _execute(instance, signal, ctx, phase = 'real') {
    const isShadowPhase = phase === 'shadow';
    const { tradeParams, direction, reasons } = signal;
    const lockSymbol = normalizeSymbol(tradeParams.symbol || instance.symbol);

    const effectiveStake = isShadowPhase
      ? Math.max(0.01, Number(instance.config.shadowStake) || 0.35)
      : this._getEffectiveStake(instance, tradeParams);

    const stakeCheck = this._validateStake(instance, effectiveStake);
    if (!stakeCheck.ok) {
      instance.lastReason = `Execution blocked: ${stakeCheck.reason}`;
      logger.warn(`[BotRunner] ${instance.instanceId} — ${instance.lastReason}`);
      this.emit('botError', { instanceId: instance.instanceId, botId: instance.botId, error: stakeCheck.reason });
      return;
    }

    const rrCheck = this._validateRiskReward(instance, tradeParams, ctx, direction);
    if (!rrCheck.ok) {
      instance.lastReason = `Execution blocked: ${rrCheck.reason}`;
      logger.warn(`[BotRunner] ${instance.instanceId} — ${instance.lastReason}`);
      this.emit('botError', { instanceId: instance.instanceId, botId: instance.botId, error: rrCheck.reason });
      return;
    }

    if (!this._tryAcquireSymbolLock(lockSymbol, instance.instanceId, SYMBOL_LOCK_TTL_MS)) {
      const holder = this._symbolLocks.get(lockSymbol);
      instance.lastReason = `Execution blocked: ${lockSymbol} locked by ${holder ? holder.instanceId : 'unknown'}`;
      logger.debug(`[BotRunner] ${instance.instanceId} — ${instance.lastReason}`);
      return;
    }

    const entryThesis = this._buildEntryThesis(instance, reasons, ctx, direction, tradeParams);
    const currentSession = detectSession();
    const currentRegime = ctx && ctx.state && ctx.state.regime ? ctx.state.regime.code : null;

    let expectedSide = direction;
    if (!expectedSide && tradeParams.direction) expectedSide = tradeParams.direction;
    if (!expectedSide && tradeParams.contractType) {
      const ct = String(tradeParams.contractType).toUpperCase();
      if (BUY_CONTRACT_TYPES.has(ct)) expectedSide = 'BUY';
      else if (SELL_CONTRACT_TYPES.has(ct)) expectedSide = 'SELL';
    }

    try {
      // Fresh portfolio check — bypasses the cache to guarantee pre-order freshness.
      const freshPositions = await this._getPositions(true);
      if (freshPositions.some(p => normalizeSymbol(p.instrument) === lockSymbol)) {
        instance.lastReason = 'Execution blocked: position opened by concurrent bot';
        this._releaseSymbolLock(lockSymbol, instance.instanceId);
        return;
      }

      let result;
      if (tradeParams.contractClass === 'multiplier') {
        result = await contractService.placeContract({
          symbol: tradeParams.symbol, direction: tradeParams.direction || direction, stake: stakeCheck.stake,
          multiplier: tradeParams.multiplier,
          knockoutLevel: tradeParams.knockoutLevel, takeProfitLevel: tradeParams.takeProfitLevel,
          strategy: instance.botId, regimeCode: instance.config.regimeCode || 'NEUTRAL',
          entryThesis,
        });
      } else if (tradeParams.contractClass === 'digit' || tradeParams.contractClass === 'binary') {
        result = await contractService.placeContract({
          symbol: tradeParams.symbol, contractType: tradeParams.contractType, barrier: tradeParams.barrier,
          stake: stakeCheck.stake, duration: tradeParams.duration, durationUnit: tradeParams.durationUnit || 't',
          strategy: instance.botId, regimeCode: instance.config.regimeCode || 'NEUTRAL',
          entryThesis,
        });
      } else if (HIGH_PAYOUT_CLASSES.has(tradeParams.contractClass)) {
        result = await contractService.placeContract({
          ...tradeParams, stake: stakeCheck.stake,
          strategy: instance.botId, regimeCode: instance.config.regimeCode || 'NEUTRAL',
          entryThesis,
        });
      } else {
        throw new Error(`Unknown contractClass: ${tradeParams.contractClass}`);
      }

      instance.stats.entries++;
      instance._lastEntryTime = Date.now();
      instance.lastReason = isShadowPhase
        ? `SHADOW-PHASE TRADE PLACED ($${stakeCheck.stake})`
        : 'TRADE PLACED (REAL)';
      instance._entryFailureBackoffUntil = 0;
      if (isShadowPhase) this._metrics.shadowPlaced++;
      this._invalidatePositions();

      await this._persistBotRun(
        instance, result, tradeParams, direction, stakeCheck, reasons, entryThesis,
        currentRegime, currentSession, isShadowPhase
      );

      this.emit('botEntry', {
        instanceId: instance.instanceId, botId: instance.botId,
        contractId: String(result.contractId), symbol: instance.config.symbol,
        side: tradeParams.contractType || direction, entryPrice: result.entryPrice,
        stake: stakeCheck.stake, reasons, flipped: instance.stats.flipped,
        shadowPhase: isShadowPhase,
        timestamp: new Date().toISOString(),
      });

      this._shortenSymbolLock(lockSymbol, instance.instanceId, SYMBOL_LOCK_TAIL_MS);
    } catch (err) {
      const errMsg = String(err && err.message || '');

      if (errMsg.includes('OpenPositionLimitExceeded')) {
        this._metrics.openPositionRejections++;
        this._invalidatePositions();
        instance._entryFailureBackoffUntil = Date.now() + OPEN_POSITION_BACKOFF_MS;
        instance.lastReason = `Symbol busy (OpenPositionLimitExceeded) — retry in ${OPEN_POSITION_BACKOFF_MS / 1000}s`;
        logger.warn(`[BotRunner] ${instance.instanceId}: OpenPositionLimitExceeded on ${lockSymbol} — another position is open. Backoff ${OPEN_POSITION_BACKOFF_MS / 1000}s.`);
        this.emit('botError', { instanceId: instance.instanceId, botId: instance.botId, error: errMsg, reason: 'open_position_limit', shadowPhase: isShadowPhase });
        this._releaseSymbolLock(lockSymbol, instance.instanceId);
        return;
      }

      if (this._isAmbiguousError(err)) {
        this._metrics.lastOriginalError = errMsg;
        logger.warn(`[BotRunner] ${instance.botId}/${instance.instanceId} ${isShadowPhase ? 'SHADOW-PHASE' : 'REAL'} entry threw "${errMsg}" — attempting recovery`);

        let recovered = null;
        try { recovered = await this._reconcileOrphanPosition(instance, lockSymbol, expectedSide, stakeCheck.stake); }
        catch (recErr) { logger.warn(`[BotRunner] Recovery attempt failed: ${recErr.message}`); }

        if (recovered) {
          logger.warn(`[BotRunner] ${instance.botId}/${instance.instanceId}: RECOVERED contract ${recovered.id} — treating as SUCCESS.`);
          instance.stats.entries++;
          instance._lastEntryTime = Date.now();
          instance.lastReason = isShadowPhase ? 'SHADOW-PHASE TRADE PLACED (recovered)' : 'TRADE PLACED (recovered)';
          instance._entryFailureBackoffUntil = 0;
          if (isShadowPhase) this._metrics.shadowPlaced++;
          this._invalidatePositions();

          const broker = getBroker('deriv_cfd');
          if (broker._subscribeOpenContract) broker._subscribeOpenContract(recovered.id).catch(() => {});

          await this._persistBotRun(
            instance,
            { contractId: recovered.id, entryPrice: recovered.entryPrice, purchasePrice: recovered.purchasePrice },
            tradeParams, direction, stakeCheck, reasons, entryThesis,
            currentRegime, currentSession, isShadowPhase
          );

          this.emit('botEntry', {
            instanceId: instance.instanceId, botId: instance.botId,
            contractId: String(recovered.id), symbol: instance.config.symbol,
            side: recovered.side || expectedSide || direction,
            entryPrice: recovered.entryPrice,
            stake: stakeCheck.stake, reasons, flipped: instance.stats.flipped,
            reconciled: true, originalError: errMsg,
            shadowPhase: isShadowPhase,
            timestamp: new Date().toISOString(),
          });

          this._shortenSymbolLock(lockSymbol, instance.instanceId, SYMBOL_LOCK_TAIL_MS);
          return;
        }

        logger.warn(`[BotRunner] ${instance.botId}/${instance.instanceId}: recovery found no matching contract — genuine failure`);
      }

      instance._entryFailureBackoffUntil = Date.now() + ENTRY_FAILURE_BACKOFF_MS;
      logger.error(`[BotRunner] ${instance.botId}/${instance.instanceId} ${isShadowPhase ? 'shadow-phase' : 'real'} entry failed: ${errMsg}`);
      instance.lastReason = `Execution failed: ${errMsg}`;
      this.emit('botError', { instanceId: instance.instanceId, botId: instance.botId, error: errMsg, shadowPhase: isShadowPhase });
      this._invalidatePositions();
      this._releaseSymbolLock(lockSymbol, instance.instanceId);
    }
  }

  async _onTradeClosed(data) {
    try {
      const contractId = String(data && data.contractId || '');
      if (!contractId) return;
      const run = await BotRun.findOne({ contractId, status: 'OPEN' });
      if (!run) {
        logger.warn(`[BotRunner] _onTradeClosed: no OPEN BotRun for contract ${contractId} (entry persist may have failed)`);
        return;
      }

      const isShadowPhase = !!run.shadowPhase;

      const realizedProfit = Number(data.realizedProfit || 0);
      run.pnl = realizedProfit; run.realizedProfit = realizedProfit;
      run.result = realizedProfit > 0 ? 'WIN' : realizedProfit < 0 ? 'LOSS' : 'BREAKEVEN';
      run.closePrice = (data.result && data.result.closePrice) || null;
      run.closedAt = new Date(); run.status = 'CLOSED';
      await run.save();

      this._invalidatePositions();

      const instance = this._instances.get(run.instanceId);
      if (instance) {
        instance._lastCloseTime = Date.now();
        const tradeWasFlipped = run.entryThesis && run.entryThesis.flip === 'FLIPPED';

        instance.stats.pnl += realizedProfit;
        instance.stats.closedTrades++;

        if (run.result === 'WIN') {
          instance.stats.wins++;
          if (!isShadowPhase) instance.stats.consecutiveLosses = 0;
        } else if (run.result === 'LOSS') {
          instance.stats.losses++;
          if (!isShadowPhase) instance.stats.consecutiveLosses++;
        }

        if (tradeWasFlipped) {
          instance.stats.flippedTrades++;
          instance.stats.flippedPnl += realizedProfit;
          if (run.result === 'WIN') instance.stats.flippedWins++;
        } else {
          instance.stats.normalTrades++;
          instance.stats.normalPnl += realizedProfit;
          if (run.result === 'WIN') instance.stats.normalWins++;
        }

        instance.stats.phaseTrades++;
        instance.stats.phasePnl += realizedProfit;
        if (run.result === 'WIN') instance.stats.phaseWins++;

        if (instance._trailingPeaks) instance._trailingPeaks.delete(contractId);

        if (isShadowPhase) {
          if (instance.shadow) {
            if (run.result === 'WIN') {
              instance.shadow.consecutiveShadowWins++;
              instance.shadow.stats.wins++;
              this._metrics.shadowWins++;
            } else if (run.result === 'LOSS') {
              instance.shadow.consecutiveShadowWins = 0;
              instance.shadow.stats.losses++;
              this._metrics.shadowLosses++;
            }
            if (run.result === 'WIN' || run.result === 'LOSS') {
              instance.shadow.stats.total++;
              instance.shadow.stats.winRate = instance.shadow.stats.total > 0
                ? Number((instance.shadow.stats.wins / instance.shadow.stats.total).toFixed(3))
                : 0;
              instance.shadow.sequence.push(run.result === 'WIN' ? 'W' : 'L');
              if (instance.shadow.sequence.length > SHADOW_SEQUENCE_MAX) {
                instance.shadow.sequence.shift();
              }
              this._metrics.shadowResolved++;

              logger.info(
                `[BotRunner] ${instance.instanceId}: SHADOW-PHASE ${run.contractId} settled ${run.result} — ` +
                `consecutive=${instance.shadow.consecutiveShadowWins}/${instance.shadow.currentGate} ` +
                `(total ${instance.shadow.stats.wins}W/${instance.shadow.stats.losses}L)`
              );

              try {
                this.emit('botShadowResolved', {
                  instanceId: instance.instanceId, botId: instance.botId,
                  contractId: run.contractId,
                  outcome: run.result === 'WIN' ? 'W' : 'L',
                  source: 'shadow_phase_real_trade',
                  consecutiveShadowWins: instance.shadow.consecutiveShadowWins,
                  currentGate: instance.shadow.currentGate,
                  shadowStats: { ...instance.shadow.stats },
                  timestamp: new Date().toISOString(),
                });
              } catch (_) {}
            }
          }
        } else {
          this._applyCompoundAfterWin(instance, run);
          this._adaptGateAfterReal(instance, run.result);
          this._applyObservationalShadow(instance, run);
        }

        this.emit('botResult', {
          instanceId: run.instanceId, botId: run.botId, contractId,
          result: run.result, pnl: realizedProfit, totalPnl: instance.stats.pnl,
          flipped: instance.stats.flipped, tradeWasFlipped,
          phaseTrades: instance.stats.phaseTrades,
          phasePnl: Number(instance.stats.phasePnl.toFixed(2)),
          shadowPhase: isShadowPhase,
          compound: instance.compound && instance.compound.enabled ? {
            currentStake: Number(instance.compound.currentStake.toFixed(2)),
            winsSinceReset: instance.compound.winsSinceReset,
            growthCount: instance.compound.growthCount,
            resetCount: instance.compound.resetCount,
          } : null,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) { logger.error(`[BotRunner] _onTradeClosed failed: ${err.message}`); }
  }

  _summarize(instance) {
    const statsForSummary = Object.assign({}, instance.stats);
    if (statsForSummary.flipHistory && statsForSummary.flipHistory.length > 5) {
      statsForSummary.flipHistory = statsForSummary.flipHistory.slice(-5);
    }

    const shadowForSummary = instance.shadow && instance.shadow.enabled ? {
      enabled: true,
      mode: instance.shadow.mode,
      currentGate: instance.shadow.currentGate,
      originalGate: instance.shadow.originalGate,
      shadowRequired: instance.shadow.shadowRequired,
      consecutiveShadowWins: instance.shadow.consecutiveShadowWins,
      gateTightenCount: instance.shadow.gateTightenCount,
      pending: instance.shadow.pending.length,
      sequence: instance.shadow.sequence.slice(-10),
      stats: instance.shadow.stats,
      shadowStake: Number(instance.config.shadowStake) || 0.35,
      outcomeSource: instance.shadow.mode === 'gated'
        ? 'real_shadow_phase_trades_100pct'
        : (instance.shadow.mode === 'observational' ? 'real_trade_result_mirrored_100pct' : null),
    } : null;

    let trailingForSummary = null;
    if (TRAIL_ELIGIBLE_CLASSES.has(instance.contractClass) && instance.config.trailingEnabled) {
      const tracked = Array.from(instance._trailingPeaks.values());
      const activePeaks = tracked.filter(t => t.activatedAt != null);
      trailingForSummary = {
        enabled: true,
        activateAfterUSD: Number(instance.config.trailingActivateAfterUSD) || 2.0,
        retracePct: Number(instance.config.trailingRetracePct) || 30,
        trackedContracts: tracked.length,
        activeTrailing: activePeaks.length,
        bestPeakProfit: tracked.length > 0
          ? Number(Math.max(...tracked.map(t => t.peakProfit || 0)).toFixed(2)) : 0,
      };
    }

    const compoundForSummary = instance.compound && instance.compound.enabled ? {
      enabled: true,
      baseStake: Number(instance.compound.baseStake.toFixed(2)),
      currentStake: Number(instance.compound.currentStake.toFixed(2)),
      maxStake: instance.compound.maxStake,
      growthRatePct: instance.compound.growthRatePct,
      startAfterWins: instance.compound.startAfterWins,
      stopAfterWins: instance.compound.stopAfterWins,
      resetAfterWins: instance.compound.resetAfterWins,
      winsSinceReset: instance.compound.winsSinceReset,
      growthCount: instance.compound.growthCount,
      resetCount: instance.compound.resetCount,
      lastGrowthAt: instance.compound.lastGrowthAt,
      lastResetAt: instance.compound.lastResetAt,
    } : null;

    return {
      instanceId: instance.instanceId, botId: instance.botId, name: instance.name,
      assetClass: instance.assetClass, contractClass: instance.contractClass,
      symbol: instance.symbol, status: instance.status, startedAt: instance.startedAt,
      lastRunAt: instance.lastRunAt, lastReason: instance.lastReason, config: instance.config,
      stats: statsForSummary,
      shadow: shadowForSummary,
      trailing: trailingForSummary,
      compound: compoundForSummary,
    };
  }
}

const botRunner = new BotRunner();
eventBus.on('trade.closed', (data) => { botRunner._onTradeClosed(data).catch(() => {}); });
module.exports = botRunner;
