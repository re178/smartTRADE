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

const SESSION_RANGES = [
  { code: 'ASIAN',               start: 0,  end: 7  },
  { code: 'LONDON',              start: 7,  end: 12 },
  { code: 'LONDON_NY_OVERLAP',   start: 12, end: 16 },
  { code: 'NEW_YORK',            start: 16, end: 21 },
  { code: 'AFTER_HOURS',         start: 21, end: 24 },
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

const RECONCILE_POSITION_GRACE_MS = 2500;
const RECONCILE_POSITION_LOOKBACK_MS = 60_000;

const BUY_CONTRACT_TYPES = new Set([
  'MULTUP', 'CALL', 'DIGITEVEN', 'DIGITOVER', 'DIGITMATCH', 'ONETOUCH',
  'VANILLALONGCALL', 'TURBOSLONG',
]);
const SELL_CONTRACT_TYPES = new Set([
  'MULTDOWN', 'PUT', 'DIGITODD', 'DIGITUNDER', 'DIGITDIFF', 'NOTOUCH',
  'VANILLALONGPUT', 'TURBOSSHORT',
]);

const ESTIMATED_TICK_MS = 1000;
const SHADOW_MAX_PENDING_AGE_MS = 60_000;
const SHADOW_SEQUENCE_MAX = 20;

// [FIX-HIGH-PAYOUT] Contract classes that route to the new placement functions
// and are eligible for exit trailing.
const HIGH_PAYOUT_CLASSES = new Set(['touch', 'vanilla', 'turbo', 'accumulator']);
const TRAIL_ELIGIBLE_CLASSES = new Set(['vanilla', 'turbo']);

class BotRunner extends EventEmitter {
  constructor() {
    super();
    this._instances = new Map();
    this._nextInstanceId = 1;
    this._symbolLocks = new Map();
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
    };
  }

  start(botId, config = {}) {
    const bot = getBot(botId);
    if (!bot) throw new Error(`Unknown bot: ${botId}`);

    const instanceId = `bot-${this._nextInstanceId++}-${Date.now()}`;
    const finalConfig = Object.assign({}, bot.defaultConfig, config || {});
    const symbol = normalizeSymbol(finalConfig.symbol);

    const shadowWinsRequired = Number(finalConfig.shadowWinsRequired) || 0;
    const shadowEligible =
      shadowWinsRequired > 0 &&
      bot.assetClass === 'synthetic_binary' &&
      !finalConfig._edgeTest;

    const shadow = shadowEligible ? {
      enabled: true,
      originalGate: shadowWinsRequired,
      currentGate: shadowWinsRequired,
      shadowRequired: true,
      consecutiveShadowWins: 0,
      gateTightenCount: 0,
      sequence: [],
      stats: { wins: 0, losses: 0, total: 0, winRate: 0 },
      pending: [],
    } : null;

    const instance = {
      instanceId, botId, name: bot.name, assetClass: bot.assetClass, contractClass: bot.contractClass,
      symbol, config: finalConfig, status: 'RUNNING', startedAt: new Date(), lastRunAt: null, lastReason: null,
      timer: null, _running: false, _lastEntryTime: 0,
      _entryFailureBackoffUntil: 0,
      shadow,
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

    const intervalMs = bot.assetClass === 'fx' ? 15000 : 5000;
    instance.timer = setInterval(() => { this._runCycle(instance).catch(() => {}); }, intervalMs);
    if (typeof instance.timer.unref === 'function') instance.timer.unref();

    this._instances.set(instanceId, instance);
    logger.info(
      `[BotRunner] Started ${bot.name} (${instanceId}) on ${symbol}` +
      (finalConfig._edgeTest ? ' [EDGE TEST]' : '') +
      (shadowEligible ? ` [SHADOW gate=${shadowWinsRequired}]` : '') +
      (TRAIL_ELIGIBLE_CLASSES.has(bot.contractClass) && finalConfig.trailingEnabled ? ' [TRAILING]' : '')
    );
    const summary = this._summarize(instance);
    this.emit('botStarted', summary);
    setTimeout(() => { this._runCycle(instance).catch(() => {}); }, 1000);
    return summary;
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
      runningInstances: this._instances.size,
      symbolLocks: this._symbolLocks.size,
    };
  }

  // ─────────────────────────────────────────────────────────────
  //  Symbol locks
  // ─────────────────────────────────────────────────────────────
  _tryAcquireSymbolLock(symbol, instanceId, ttlMs = SYMBOL_LOCK_TTL_MS) {
    const now = Date.now();
    const existing = this._symbolLocks.get(symbol);
    if (existing && existing.expiresAt > now && existing.instanceId !== instanceId) {
      return false;
    }
    this._symbolLocks.set(symbol, { instanceId, acquiredAt: now, expiresAt: now + ttlMs });
    return true;
  }

  _releaseSymbolLock(symbol, instanceId) {
    const lock = this._symbolLocks.get(symbol);
    if (lock && lock.instanceId === instanceId) {
      this._symbolLocks.delete(symbol);
    }
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

  // ─────────────────────────────────────────────────────────────
  //  Trailing exits for Vanilla/Turbo bots
  // ─────────────────────────────────────────────────────────────
  async _manageTrailingExits(instance) {
    if (!instance.config.trailingEnabled) return;
    if (instance.config._edgeTest) return;
    if (!TRAIL_ELIGIBLE_CLASSES.has(instance.contractClass)) return;

    const broker = getBroker('deriv_cfd');
    let positions;
    try { positions = await broker.getOpenTrades(); }
    catch (_) { return; }
    if (!Array.isArray(positions) || positions.length === 0) {
      if (instance._trailingPeaks.size > 0) instance._trailingPeaks.clear();
      return;
    }

    const activateAfter = Number(instance.config.trailingActivateAfterUSD) || 2.0;
    const retracePct = Number(instance.config.trailingRetracePct) || 30;

    const liveIds = new Set();
    for (const pos of positions) {
      if (normalizeSymbol(pos.instrument) === instance.symbol) {
        liveIds.add(String(pos.id));
      }
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
        tracking = {
          peakProfit: currentProfit,
          entryPrice: Number(pos.entryPrice || 0),
          activatedAt: null,
        };
        instance._trailingPeaks.set(contractId, tracking);
      }

      if (currentProfit > tracking.peakProfit) {
        tracking.peakProfit = currentProfit;
      }

      if (tracking.peakProfit < activateAfter) continue;

      if (tracking.activatedAt == null) {
        tracking.activatedAt = Date.now();
        logger.info(
          `[BotRunner] ${instance.instanceId}: trailing activated on ${contractId} ` +
          `(peak=$${tracking.peakProfit.toFixed(2)} ≥ $${activateAfter})`
        );
      }

      const closeBelow = tracking.peakProfit * (1 - retracePct / 100);

      if (currentProfit <= closeBelow) {
        logger.info(
          `[BotRunner] ${instance.instanceId}: trailing EXIT on ${contractId} ` +
          `(peak=$${tracking.peakProfit.toFixed(2)} current=$${currentProfit.toFixed(2)} ` +
          `retrace=$${(tracking.peakProfit - currentProfit).toFixed(2)} ≥ ${retracePct}% of peak)`
        );
        try {
          await broker.closeTrade(contractId);
          this._metrics.trailingExits++;
          instance._trailingPeaks.delete(contractId);
          instance.lastReason = `Trailing exit ${contractId} (peak $${tracking.peakProfit.toFixed(2)})`;
          this.emit('botTrailingExit', {
            instanceId: instance.instanceId,
            botId: instance.botId,
            contractId,
            peakProfit: Number(tracking.peakProfit.toFixed(2)),
            currentProfit: Number(currentProfit.toFixed(2)),
            retracePct,
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          logger.warn(
            `[BotRunner] ${instance.instanceId}: trailing close FAILED for ${contractId}: ${err.message}`
          );
          this._metrics.trailingSkipped++;
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  //  Shadow trade lifecycle
  // ─────────────────────────────────────────────────────────────
  _shadowEligible(instance) {
    return !!(
      instance.shadow &&
      instance.shadow.enabled &&
      instance.assetClass === 'synthetic_binary' &&
      Number(instance.config.shadowWinsRequired) > 0 &&
      !instance.config._edgeTest
    );
  }

  _resolvePendingShadows(instance) {
    if (!instance.shadow || instance.shadow.pending.length === 0) return;

    const dv = digitAnalyzer.getView(instance.symbol);
    if (!dv) return;

    const now = Date.now();
    const remaining = [];

    for (const shadow of instance.shadow.pending) {
      const ticksElapsed = Number(dv.sampleSize) - shadow.entryTickNum;
      const timeElapsed = now - shadow.startedAt;
      const expectedTimeMs = shadow.durationTicks * ESTIMATED_TICK_MS;

      const forceResolve = timeElapsed > SHADOW_MAX_PENDING_AGE_MS;
      const readyToResolve =
        forceResolve ||
        timeElapsed >= expectedTimeMs ||
        ticksElapsed >= shadow.durationTicks;

      if (!readyToResolve) {
        remaining.push(shadow);
        continue;
      }

      const exitPrice = Number(dv.price);
      let outcome;
      if (shadow.prediction === 'CALL') {
        outcome = exitPrice > shadow.entryPrice ? 'W' : 'L';
      } else if (shadow.prediction === 'PUT') {
        outcome = exitPrice < shadow.entryPrice ? 'W' : 'L';
      } else {
        logger.warn(
          `[BotRunner] ${instance.instanceId}: shadow with unknown prediction ` +
          `"${shadow.prediction}" — treating as loss`
        );
        outcome = 'L';
      }

      instance.shadow.sequence.push(outcome);
      if (instance.shadow.sequence.length > SHADOW_SEQUENCE_MAX) {
        instance.shadow.sequence.shift();
      }

      instance.shadow.stats.total++;
      if (outcome === 'W') {
        instance.shadow.consecutiveShadowWins++;
        instance.shadow.stats.wins++;
        this._metrics.shadowWins++;
      } else {
        instance.shadow.consecutiveShadowWins = 0;
        instance.shadow.stats.losses++;
        this._metrics.shadowLosses++;
      }
      instance.shadow.stats.winRate = instance.shadow.stats.total > 0
        ? Number((instance.shadow.stats.wins / instance.shadow.stats.total).toFixed(3))
        : 0;

      this._metrics.shadowResolved++;

      logger.info(
        `[BotRunner] ${instance.instanceId}: shadow ${shadow.prediction} RESOLVED ${outcome} ` +
        `(entry=${shadow.entryPrice} exit=${exitPrice}, ticks=${ticksElapsed}) — ` +
        `consecutive=${instance.shadow.consecutiveShadowWins}/${instance.shadow.currentGate}`
      );

      try {
        this.emit('botShadowResolved', {
          instanceId: instance.instanceId,
          botId: instance.botId,
          outcome,
          prediction: shadow.prediction,
          entryPrice: shadow.entryPrice,
          exitPrice,
          ticksElapsed,
          consecutiveShadowWins: instance.shadow.consecutiveShadowWins,
          currentGate: instance.shadow.currentGate,
          timestamp: new Date().toISOString(),
        });
      } catch (_) {}
    }

    instance.shadow.pending = remaining;
  }

  _recordShadowTrade(instance, signal, ctx) {
    const { tradeParams } = signal;
    const dv = ctx && ctx.digitView;
    if (!dv) {
      instance.lastReason = 'Shadow skipped: no digit view';
      return;
    }

    const prediction = tradeParams.contractType;
    if (prediction !== 'CALL' && prediction !== 'PUT') {
      instance.lastReason = `Shadow skipped: unsupported contractType ${prediction}`;
      logger.warn(
        `[BotRunner] ${instance.instanceId}: shadow cannot track ${prediction} ` +
        `(only CALL/PUT supported). Firing without shadow.`
      );
      return this._execute(instance, signal, ctx);
    }

    const entryPrice = Number(dv.price);
    const entryTickNum = Number(dv.sampleSize);
    const durationTicks = Number(tradeParams.duration) || 5;

    instance.shadow.pending.push({
      prediction,
      entryPrice,
      entryTickNum,
      durationTicks,
      startedAt: Date.now(),
    });

    this._metrics.shadowPlaced++;

    instance.lastReason =
      `Shadow ${prediction} placed (${instance.shadow.consecutiveShadowWins}/${instance.shadow.currentGate})`;

    logger.info(
      `[BotRunner] ${instance.instanceId}: shadow ${prediction} placed ` +
      `price=${entryPrice} tick#${entryTickNum} dur=${durationTicks} ` +
      `(need ${instance.shadow.currentGate - instance.shadow.consecutiveShadowWins} more)`
    );

    try {
      this.emit('botShadowPlaced', {
        instanceId: instance.instanceId,
        botId: instance.botId,
        prediction,
        entryPrice,
        entryTickNum,
        durationTicks,
        consecutiveShadowWins: instance.shadow.consecutiveShadowWins,
        currentGate: instance.shadow.currentGate,
        timestamp: new Date().toISOString(),
      });
    } catch (_) {}
  }

  _adaptGateAfterReal(instance, result) {
    if (!instance.shadow || !instance.shadow.enabled) return;

    instance.shadow.consecutiveShadowWins = 0;

    if (result === 'WIN') {
      instance.shadow.shadowRequired = false;
      logger.info(
        `[BotRunner] ${instance.instanceId}: real WIN → continue trading ` +
        `(gate stays at ${instance.shadow.currentGate})`
      );
    } else if (result === 'LOSS') {
      instance.shadow.shadowRequired = true;
      const oldGate = instance.shadow.currentGate;
      instance.shadow.currentGate = Math.min(10, oldGate + 1);
      instance.shadow.gateTightenCount++;
      logger.info(
        `[BotRunner] ${instance.instanceId}: real LOSS → gate tightened ` +
        `${oldGate} → ${instance.shadow.currentGate} ` +
        `(total tightens=${instance.shadow.gateTightenCount})`
      );
    }
  }

  // ─────────────────────────────────────────────────────────────
  //  Flip state
  // ─────────────────────────────────────────────────────────────
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
        s.phaseTrades = 0;
        s.phaseWins = 0;
        s.phasePnl = 0;
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
      s.phaseTrades = 0;
      s.phaseWins = 0;
      s.phasePnl = 0;
      logger.info(`[BotRunner] ${instance.botId}/${instance.instanceId} FLIP ON — normal phase ${phaseTradesAtToggle} trades, WR ${normalWinRate.toFixed(1)}%`);
      this.emit('botFlip', { instanceId: instance.instanceId, botId: instance.botId, flipped: true, reason: 'normal_phase_low_winrate' });
    }
  }

  _capFlipHistory(s) {
    if (s.flipHistory.length > FLIP_HISTORY_MAX) {
      s.flipHistory = s.flipHistory.slice(-FLIP_HISTORY_MAX);
    }
  }

  async _runCycle(instance) {
    if (instance.status !== 'RUNNING') return;
    if (instance._running) return;
    instance._running = true;

    try {
      this._updateFlipState(instance);

      this._resolvePendingShadows(instance);

      try { await this._manageTrailingExits(instance); }
      catch (trErr) {
        logger.warn(`[BotRunner] ${instance.instanceId}: trailing check failed: ${trErr.message}`);
      }

      this._cleanupExpiredLocks();

      if (instance._entryFailureBackoffUntil && Date.now() < instance._entryFailureBackoffUntil) {
        const remaining = Math.ceil((instance._entryFailureBackoffUntil - Date.now()) / 1000);
        instance.lastReason = `Entry failure backoff (${remaining}s)`;
        return;
      }

      if (instance._lastEntryTime && Date.now() - instance._lastEntryTime < 15000) {
        instance.lastReason = 'Awaiting trade settlement...';
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
          instance.lastReason =
            `Stopped: Trailing drawdown (${s.pnl.toFixed(2)} <= ${trailFloor.toFixed(2)}, peak +$${s.peakPnl.toFixed(2)})`;
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

      const positions = await broker.getOpenTrades().catch(() => []);
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

      // ─────────────────────────────────────────────────────────────
      // Context building — three branches
      // ─────────────────────────────────────────────────────────────
      if (bot.assetClass === 'fx') {
        // FX bots: full deep-market pipeline (state, consensus, prediction, candles)
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

      // [FIX-HIGH-PAYOUT-CTX] High-payout bots (touch/vanilla/turbo/accumulator)
      // reference ctx.state.regime, ctx.state.volatility, ctx.consensus, and
      // ctx.prediction — exactly like FX bots. Without this branch they fell
      // into the digit-only else below, got only ctx.digitView, and always
      // returned "No market state" / "No state/prediction" before reaching
      // the proposal call.
      //
      // The `deepMarketState.compute` call needs candle history for R_100.
      // The first 1–2 cycles after start may return null while candles load
      // (shown as "no deep state (candle history loading)" — self-heals).
      //
      // We ALSO populate digitView (for accumulator_scalper's tight-range
      // check that reads ctx.digitView.recentPrices). Harmless for the other
      // three bots (they don't read digitView).
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

        // Populate digitView too — accumulator_scalper needs recentPrices
        // for its tight-range check. Other three bots ignore it.
        const dv = digitAnalyzer.getView(instance.symbol);
        if (dv) ctx.digitView = dv;

      } else {
        // Digit bots: digitView only (existing behavior, unchanged)
        const digitView = digitAnalyzer.getView(instance.symbol);
        if (!digitView) { instance.lastReason = 'no digit data'; return; }
        ctx.digitView = digitView;
      }

      instance.stats.runs++;

      let result;
      try { result = await bot.evaluate(ctx); }
      catch (evalErr) { instance.lastReason = `evaluate error: ${evalErr.message}`; return; }

      if (!result || result.action === 'WAIT') {
        instance.lastReason = (result && result.reasons && result.reasons[0]) || 'WAIT';
        this.emit('botCycle', { instanceId: instance.instanceId, botId: instance.botId, action: 'WAIT', reasons: result.reasons || [], symbol: instance.symbol });
        return;
      }

      if (result.action === 'ENTER') {
        if (this._shadowEligible(instance) && instance.shadow.shadowRequired) {
          if (instance.shadow.pending.length > 0) {
            instance.lastReason = 'Shadow pending (waiting for resolution)';
            return;
          }
          if (instance.shadow.consecutiveShadowWins < instance.shadow.currentGate) {
            this._recordShadowTrade(instance, result, ctx);
            return;
          }
          logger.info(
            `[BotRunner] ${instance.instanceId}: shadow gate MET ` +
            `(${instance.shadow.consecutiveShadowWins}/${instance.shadow.currentGate}) → real fire`
          );
        }
        await this._execute(instance, result, ctx);
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
    if (!Number.isFinite(requested) || requested <= 0) {
      return { ok: false, reason: `Invalid stake: ${stake}` };
    }
    const rawMax = instance.config.maxStake;
    if (rawMax == null || rawMax === '') return { ok: true, stake: requested };
    const cap = Number(rawMax);
    if (cap === 0) {
      logger.warn(
        `[BotRunner] ${instance.instanceId}: maxStake=0 treated as "no cap" — verify this is intended`
      );
      return { ok: true, stake: requested };
    }
    if (!Number.isFinite(cap) || cap < 0) {
      return { ok: false, reason: `Invalid maxStake config: ${rawMax}` };
    }
    if (requested > cap) {
      return { ok: false, reason: `Stake ${requested} exceeds maxStake ${cap}` };
    }
    return { ok: true, stake: requested };
  }

  _validateRiskReward(instance, tradeParams, ctx, direction) {
    if (tradeParams.contractClass !== 'multiplier') return { ok: true };

    const entryPrice =
      (ctx && ctx.state && ctx.state.price && ctx.state.price.current) ||
      Number(tradeParams.entryPrice) || null;
    const ko = Number(tradeParams.knockoutLevel);
    const tp = Number(tradeParams.takeProfitLevel);
    const dir = tradeParams.direction || direction || null;

    if (Number.isFinite(entryPrice) && entryPrice > 0 && dir) {
      const isBuy = dir === 'BUY' || dir === 'MULTUP';
      if (Number.isFinite(ko)) {
        const wrongSide = isBuy ? ko >= entryPrice : ko <= entryPrice;
        if (wrongSide) {
          return { ok: false, reason: `KO ${ko} on wrong side of entry ${entryPrice} for ${dir}` };
        }
      }
      if (Number.isFinite(tp)) {
        const wrongSide = isBuy ? tp <= entryPrice : tp >= entryPrice;
        if (wrongSide) {
          return { ok: false, reason: `TP ${tp} on wrong side of entry ${entryPrice} for ${dir}` };
        }
      }
    }

    const minRR = Number(instance.config.minRiskReward) || 0;
    if (minRR <= 0) return { ok: true };
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return { ok: true };
    if (!Number.isFinite(ko) || !Number.isFinite(tp)) return { ok: true };

    const slDist = Math.abs(entryPrice - ko);
    const tpDist = Math.abs(tp - entryPrice);

    if (slDist <= 0) {
      return { ok: false, reason: 'SL distance is zero (invalid levels)' };
    }

    const rr = tpDist / slDist;
    if (rr < minRR) {
      return { ok: false, reason: `RR ${rr.toFixed(2)} < minRiskReward ${minRR}`, rr };
    }
    return { ok: true, rr };
  }

  _buildEntryThesis(instance, reasons, ctx) {
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
        botId: instance.botId,
        instanceId: instance.instanceId,
        reasons: reasons || [],
        edgeTest: isEdgeTest,
        session,
        flip: flipLabel,
        phaseStats,
        confidence: pred ? pred.calibratedConfidence : null,
        direction: pred ? pred.direction : null,
        pattern: pred && pred.pattern ? {
          bias: pred.pattern.bias,
          confidence: pred.pattern.confidence,
          patterns: pred.pattern.patterns,
        } : null,
        momentum: pred ? pred.momentum : null,
        volatility: pred ? pred.volatility : null,
        regime: st && st.regime ? st.regime.code : null,
        regimeConfidence: st && st.regime ? st.regime.confidence : null,
        strategyConsensus: cons ? {
          action: cons.action,
          direction: cons.direction,
          confidence: cons.confidence,
          agreeing: cons.agreeing,
        } : null,
      };
    }

    const dv = ctx && ctx.digitView;
    return {
      botId: instance.botId,
      instanceId: instance.instanceId,
      reasons: reasons || [],
      edgeTest: isEdgeTest,
      session,
      flip: flipLabel,
      phaseStats,
      digitView: dv ? {
        sampleSize: dv.sampleSize,
        precision: dv.precision,
        evenPct: dv.evenPct,
        oddPct: dv.oddPct,
        risePct: dv.risePct,
        fallPct: dv.fallPct,
        evenStreak: dv.evenStreak,
        oddStreak: dv.oddStreak,
      } : null,
    };
  }

  _isAmbiguousError(err) {
    if (!err || !err.message) return false;
    const msg = String(err.message);
    return (
      msg.includes('InvalidContractProposal') ||
      msg.includes('timeout') ||
      msg.includes('Timeout') ||
      msg.includes('Auth closed') ||
      msg.includes('Public closed') ||
      msg.includes('Buy failed') ||
      msg.includes('Request cancelled') ||
      msg.includes('WebSocket')
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

    logger.warn(
      `[BotRunner] _reconcileOrphanPosition: RECOVERED contract ${candidates[0].id} ` +
      `for ${instance.botId}/${instance.instanceId} — treating entry as success`
    );

    return candidates[0];
  }

  async _persistBotRun(instance, result, tradeParams, direction, stakeCheck, reasons, entryThesis, currentRegime, currentSession) {
    const shadowSnapshot = instance.shadow && instance.shadow.enabled ? {
      shadowEnabled: true,
      shadowSequence: instance.shadow.sequence.slice(-SHADOW_SEQUENCE_MAX),
      shadowStats: { ...instance.shadow.stats },
      gateAtEntry: instance.shadow.currentGate,
      originalGate: instance.shadow.originalGate,
      gateTightenCount: instance.shadow.gateTightenCount,
    } : {
      shadowEnabled: false,
      shadowSequence: [],
      shadowStats: null,
      gateAtEntry: null,
      originalGate: null,
      gateTightenCount: 0,
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
        regimeCode: currentRegime,
        session: currentSession,
        entryThesis,
        ...shadowSnapshot,
        payoutPerPoint: md.payoutPerPoint != null ? Number(md.payoutPerPoint) : null,
        growthRate: md.growthRate != null ? Number(md.growthRate) : null,
        strikePrice: md.strikePrice != null ? Number(md.strikePrice) : null,
        touchBarrier: md.touchBarrier != null ? Number(md.touchBarrier) : null,
        touchDirection: md.touchDirection || null,
      });
    } catch (persistErr) {
      logger.error(
        `[BotRunner] BotRun persist failed for ${result.contractId} ` +
        `(${instance.botId}/${instance.instanceId}): ${persistErr.message}`
      );
    }
  }

  async _execute(instance, signal, ctx) {
    const { tradeParams, direction, reasons } = signal;
    const lockSymbol = normalizeSymbol(tradeParams.symbol || instance.symbol);

    const configStake = instance.config.stake;
    const hasConfigStake =
      configStake != null && configStake !== '' &&
      Number.isFinite(Number(configStake)) && Number(configStake) > 0;
    const effectiveStake = hasConfigStake ? Number(configStake) : tradeParams.stake;

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

    const entryThesis = this._buildEntryThesis(instance, reasons, ctx);
    const isEdgeTest = !!instance.config._edgeTest;
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
      const broker = getBroker('deriv_cfd');
      const freshPositions = await broker.getOpenTrades().catch(() => []);
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
          ...tradeParams,
          stake: stakeCheck.stake,
          strategy: instance.botId,
          regimeCode: instance.config.regimeCode || 'NEUTRAL',
          entryThesis,
        });
      } else {
        throw new Error(`Unknown contractClass: ${tradeParams.contractClass}`);
      }

      instance.stats.entries++;
      instance._lastEntryTime = Date.now();
      instance.lastReason = 'TRADE PLACED';
      instance._entryFailureBackoffUntil = 0;

      await this._persistBotRun(instance, result, tradeParams, direction, stakeCheck, reasons, entryThesis, currentRegime, currentSession);

      this.emit('botEntry', {
        instanceId: instance.instanceId, botId: instance.botId,
        contractId: String(result.contractId), symbol: instance.config.symbol,
        side: tradeParams.contractType || direction, entryPrice: result.entryPrice,
        stake: stakeCheck.stake, reasons, flipped: instance.stats.flipped,
        timestamp: new Date().toISOString(),
      });

      this._shortenSymbolLock(lockSymbol, instance.instanceId, SYMBOL_LOCK_TAIL_MS);
    } catch (err) {
      if (this._isAmbiguousError(err)) {
        this._metrics.lastOriginalError = err.message;
        logger.warn(
          `[BotRunner] ${instance.botId}/${instance.instanceId} entry threw ` +
          `"${err.message}" — attempting recovery before declaring failure`
        );

        let recovered = null;
        try {
          recovered = await this._reconcileOrphanPosition(
            instance, lockSymbol, expectedSide, stakeCheck.stake
          );
        } catch (recErr) {
          logger.warn(`[BotRunner] Recovery attempt failed: ${recErr.message}`);
        }

        if (recovered) {
          logger.warn(
            `[BotRunner] ${instance.botId}/${instance.instanceId}: RECOVERED ` +
            `contract ${recovered.id} — treating as SUCCESS (no retry).`
          );
          instance.stats.entries++;
          instance._lastEntryTime = Date.now();
          instance.lastReason = 'TRADE PLACED (recovered)';
          instance._entryFailureBackoffUntil = 0;

          const broker = getBroker('deriv_cfd');
          broker._subscribeOpenContract(recovered.id).catch(() => {});

          await this._persistBotRun(
            instance,
            {
              contractId: recovered.id,
              entryPrice: recovered.entryPrice,
              purchasePrice: recovered.purchasePrice,
            },
            tradeParams, direction, stakeCheck, reasons, entryThesis,
            currentRegime, currentSession
          );

          this.emit('botEntry', {
            instanceId: instance.instanceId, botId: instance.botId,
            contractId: String(recovered.id), symbol: instance.config.symbol,
            side: recovered.side || expectedSide || direction,
            entryPrice: recovered.entryPrice,
            stake: stakeCheck.stake, reasons, flipped: instance.stats.flipped,
            reconciled: true,
            originalError: err.message,
            timestamp: new Date().toISOString(),
          });

          this._shortenSymbolLock(lockSymbol, instance.instanceId, SYMBOL_LOCK_TAIL_MS);
          return;
        }

        logger.warn(
          `[BotRunner] ${instance.botId}/${instance.instanceId}: recovery ` +
          `found no matching contract — treating as genuine failure`
        );
      }

      instance._entryFailureBackoffUntil = Date.now() + ENTRY_FAILURE_BACKOFF_MS;
      logger.error(`[BotRunner] ${instance.botId}/${instance.instanceId} entry failed: ${err.message}`);
      instance.lastReason = `Execution failed: ${err.message}`;
      this.emit('botError', { instanceId: instance.instanceId, botId: instance.botId, error: err.message });
      this._releaseSymbolLock(lockSymbol, instance.instanceId);
    }
  }

  async _onTradeClosed(data) {
    try {
      const contractId = String(data && data.contractId || '');
      if (!contractId) return;
      const run = await BotRun.findOne({ contractId, status: 'OPEN' });
      if (!run) {
        logger.warn(
          `[BotRunner] _onTradeClosed: no OPEN BotRun for contract ${contractId} ` +
          `(entry persist may have failed)`
        );
        return;
      }

      const realizedProfit = Number(data.realizedProfit || 0);
      run.pnl = realizedProfit; run.realizedProfit = realizedProfit;
      run.result = realizedProfit > 0 ? 'WIN' : realizedProfit < 0 ? 'LOSS' : 'BREAKEVEN';
      run.closePrice = (data.result && data.result.closePrice) || null;
      run.closedAt = new Date(); run.status = 'CLOSED';
      await run.save();

      const instance = this._instances.get(run.instanceId);
      if (instance) {
        const tradeWasFlipped = run.entryThesis && run.entryThesis.flip === 'FLIPPED';

        instance.stats.pnl += realizedProfit;
        instance.stats.closedTrades++;

        if (run.result === 'WIN') {
          instance.stats.wins++;
          instance.stats.consecutiveLosses = 0;
        } else if (run.result === 'LOSS') {
          instance.stats.losses++;
          instance.stats.consecutiveLosses++;
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

        this._adaptGateAfterReal(instance, run.result);

        this.emit('botResult', {
          instanceId: run.instanceId, botId: run.botId, contractId,
          result: run.result, pnl: realizedProfit, totalPnl: instance.stats.pnl,
          flipped: instance.stats.flipped, tradeWasFlipped,
          phaseTrades: instance.stats.phaseTrades,
          phasePnl: Number(instance.stats.phasePnl.toFixed(2)),
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
      currentGate: instance.shadow.currentGate,
      originalGate: instance.shadow.originalGate,
      shadowRequired: instance.shadow.shadowRequired,
      consecutiveShadowWins: instance.shadow.consecutiveShadowWins,
      gateTightenCount: instance.shadow.gateTightenCount,
      pending: instance.shadow.pending.length,
      sequence: instance.shadow.sequence.slice(-10),
      stats: instance.shadow.stats,
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
          ? Number(Math.max(...tracked.map(t => t.peakProfit || 0)).toFixed(2))
          : 0,
      };
    }

    return {
      instanceId: instance.instanceId, botId: instance.botId, name: instance.name, assetClass: instance.assetClass,
      contractClass: instance.contractClass, symbol: instance.symbol, status: instance.status, startedAt: instance.startedAt,
      lastRunAt: instance.lastRunAt, lastReason: instance.lastReason, config: instance.config,
      stats: statsForSummary,
      shadow: shadowForSummary,
      trailing: trailingForSummary,
    };
  }
}

const botRunner = new BotRunner();
eventBus.on('trade.closed', (data) => { botRunner._onTradeClosed(data).catch(() => {}); });
module.exports = botRunner;
