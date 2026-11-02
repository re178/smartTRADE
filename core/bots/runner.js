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

// [FIX-M4] Symbol lock TTL — held during _execute + a short tail so the
// newly-opened position is visible to other bots' position checks.
const SYMBOL_LOCK_TTL_MS = 30_000;
const SYMBOL_LOCK_TAIL_MS = 5_000;

// [FIX-R2] Entry-failure backoff so a persistent failure doesn't
// retry every cycle (FX bots cycle every 15s, synthetics every 5s).
const ENTRY_FAILURE_BACKOFF_MS = 30_000;

class BotRunner extends EventEmitter {
  constructor() {
    super();
    this._instances = new Map();
    this._nextInstanceId = 1;
    // [FIX-M4] symbol → { instanceId, acquiredAt, expiresAt }
    this._symbolLocks = new Map();
  }

  start(botId, config = {}) {
    const bot = getBot(botId);
    if (!bot) throw new Error(`Unknown bot: ${botId}`);

    const instanceId = `bot-${this._nextInstanceId++}-${Date.now()}`;
    const finalConfig = Object.assign({}, bot.defaultConfig, config || {});
    const symbol = normalizeSymbol(finalConfig.symbol);

    const instance = {
      instanceId, botId, name: bot.name, assetClass: bot.assetClass, contractClass: bot.contractClass,
      symbol, config: finalConfig, status: 'RUNNING', startedAt: new Date(), lastRunAt: null, lastReason: null,
      timer: null, _running: false, _lastEntryTime: 0,
      // [FIX-R2] When > Date.now(), skip cycles to avoid rapid entry retry
      _entryFailureBackoffUntil: 0,
      stats: {
        runs: 0, entries: 0, wins: 0, losses: 0, pnl: 0, peakPnl: 0, consecutiveLosses: 0,
        closedTrades: 0,

        // Cumulative phase counters (never reset — for reporting/CSV)
        normalTrades: 0, normalWins: 0, normalPnl: 0,
        flippedTrades: 0, flippedWins: 0, flippedPnl: 0,

        // Phase-local counters (reset on every flip toggle — for flip decision)
        phaseTrades: 0, phaseWins: 0, phasePnl: 0,

        // Current flip state + audit
        flipped: false,
        flipHistory: [],       // [{atTrade, from, to, reason, phaseTrades, phasePnl}]
        flipCount: 0,
      },
    };

    const intervalMs = bot.assetClass === 'fx' ? 15000 : 5000;
    instance.timer = setInterval(() => { this._runCycle(instance).catch(() => {}); }, intervalMs);
    if (typeof instance.timer.unref === 'function') instance.timer.unref();

    this._instances.set(instanceId, instance);
    logger.info(`[BotRunner] Started ${bot.name} (${instanceId}) on ${symbol}${finalConfig._edgeTest ? ' [EDGE TEST]' : ''}`);
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
    // [FIX-M4] Release any symbol lock this instance still holds.
    for (const [sym, lock] of this._symbolLocks) {
      if (lock.instanceId === instanceId) this._symbolLocks.delete(sym);
    }
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

  // ─────────────────────────────────────────────────────────────
  //  [FIX-M4] SYMBOL LOCK — prevents two bots opening positions on
  //  the same instrument simultaneously. Without this, three bots
  //  targeting frxEURUSD could all pass their position check within
  //  the same 5-10s evaluation window, then all submit entries.
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

  // [FIX-M4] Shorten the lock's TTL after a successful entry so other
  // bots aren't blocked longer than the position-propagation window.
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
  //  FLIP STATE — phase-based decision
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
      // ── Currently FLIPPED — decide if we should un-flip ──
      if (s.phaseTrades < stableTrades) return;

      if (s.phasePnl < 0) {
        // [FIX-R1] Capture phase values BEFORE reset so the log is accurate.
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

    // ── Currently NORMAL — decide if we should flip ──
    if (s.phaseTrades < minTrades) return;

    const normalWinRate = (s.phaseWins / s.phaseTrades) * 100;
    if (normalWinRate < flipThreshold) {
      // [FIX-R1] Capture before reset so the log reflects the triggering phase.
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

      // [FIX-M4] Garbage-collect expired symbol locks each cycle.
      this._cleanupExpiredLocks();

      // [FIX-R2] Entry failure backoff — if the last entry attempt failed,
      // wait before retrying so we don't spam the broker / log.
      if (instance._entryFailureBackoffUntil && Date.now() < instance._entryFailureBackoffUntil) {
        const remaining = Math.ceil((instance._entryFailureBackoffUntil - Date.now()) / 1000);
        instance.lastReason = `Entry failure backoff (${remaining}s)`;
        return;
      }

      // 1. SETTLEMENT COOLDOWN
      if (instance._lastEntryTime && Date.now() - instance._lastEntryTime < 15000) {
        instance.lastReason = 'Awaiting trade settlement...';
        return;
      }

      // 2a. Consecutive-loss circuit breaker
      const maxLosses = Number(instance.config.stopAfterLosses) || 0;
      if (maxLosses > 0 && instance.stats.consecutiveLosses >= maxLosses) {
        instance.lastReason = `Stopped: ${instance.stats.consecutiveLosses} consecutive losses (limit ${maxLosses})`;
        logger.warn(`[BotRunner] ${instance.instanceId} — ${instance.lastReason}`);
        this.stop(instance.instanceId);
        return;
      }

      // 2b. Session PnL rules
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

      // 2c. Session gate
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

      // [FIX-M4] If another instance holds the lock for this symbol, wait.
      // (Belt-and-suspenders: the position check above misses concurrent
      // entries where neither has filled yet.)
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
      } else {
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
    if (rawMax != null && rawMax !== '' && Number(rawMax) !== 0) {
      const cap = Number(rawMax);
      if (!Number.isFinite(cap) || cap <= 0) {
        return { ok: false, reason: `Invalid maxStake config: ${rawMax}` };
      }
      if (requested > cap) {
        return { ok: false, reason: `Stake ${requested} exceeds maxStake ${cap}` };
      }
    }
    return { ok: true, stake: requested };
  }

  // [FIX-M4c] Extend validation to reject SL/TP on the wrong side of entry.
  // Previous code used Math.abs() which hid direction — a TP below entry for
  // a BUY would pass as a valid "distance" and reach broker where the C1
  // fix would then silently omit the field (trade proceeds with no TP).
  // Rejecting here is safer.
  _validateRiskReward(instance, tradeParams, ctx, direction) {
    // Only multiplier contracts use knockoutLevel / takeProfitLevel.
    if (tradeParams.contractClass !== 'multiplier') return { ok: true };

    const entryPrice =
      (ctx && ctx.state && ctx.state.price && ctx.state.price.current) ||
      Number(tradeParams.entryPrice) || null;
    const ko = Number(tradeParams.knockoutLevel);
    const tp = Number(tradeParams.takeProfitLevel);
    const dir = tradeParams.direction || direction || null;

    // [FIX-M4c] Side validation — independent of minRR config.
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

    if (instance.assetClass === 'fx') {
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

  async _execute(instance, signal, ctx) {
    const { tradeParams, direction, reasons } = signal;
    // [FIX-M4] Lock key — falls back to the instance's configured symbol if
    // the bot's tradeParams doesn't specify one.
    const lockSymbol = normalizeSymbol(tradeParams.symbol || instance.symbol);

    const stakeCheck = this._validateStake(instance, tradeParams.stake);
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

    // [FIX-M4] Acquire the symbol lock. Only one bot per symbol can be
    // between "decided to enter" and "position is visible in portfolio".
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

    try {
      // [FIX-M4] Re-check positions now that we hold the lock. This catches
      // the window between the cycle-start check and this entry attempt,
      // where another bot may have filled a trade.
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
      } else {
        throw new Error(`Unknown contractClass: ${tradeParams.contractClass}`);
      }

      instance.stats.entries++;
      instance._lastEntryTime = Date.now();
      instance.lastReason = 'TRADE PLACED';
      // [FIX-R2] Successful entry clears any pending failure backoff.
      instance._entryFailureBackoffUntil = 0;

      // [FIX-R3] Persist BotRun with proper error handling. If persist fails
      // we log at ERROR (not swallow) because _onTradeClosed won't find it.
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
          isEdgeTest,
          regimeCode: currentRegime,
          session: currentSession,
          entryThesis,
        });
      } catch (persistErr) {
        logger.error(
          `[BotRunner] BotRun persist failed for ${result.contractId} ` +
          `(${instance.botId}/${instance.instanceId}): ${persistErr.message}`
        );
        // Trade is live — don't abort. _onTradeClosed will warn if it can't match.
      }

      this.emit('botEntry', { instanceId: instance.instanceId, botId: instance.botId, contractId: String(result.contractId), symbol: instance.config.symbol, side: tradeParams.contractType || direction, entryPrice: result.entryPrice, stake: stakeCheck.stake, reasons, flipped: instance.stats.flipped, timestamp: new Date().toISOString() });

      // [FIX-M4] Success → shorten the lock TTL. After ~5s the position is
      // visible in portfolio, so other bots can rely on the position check.
      this._shortenSymbolLock(lockSymbol, instance.instanceId, SYMBOL_LOCK_TAIL_MS);
    } catch (err) {
      // [FIX-R2] Set failure backoff so the bot doesn't retry immediately
      // next cycle with the same bad payload / network condition.
      instance._entryFailureBackoffUntil = Date.now() + ENTRY_FAILURE_BACKOFF_MS;
      logger.error(`[BotRunner] ${instance.botId}/${instance.instanceId} entry failed: ${err.message}`);
      instance.lastReason = `Execution failed: ${err.message}`;
      this.emit('botError', { instanceId: instance.instanceId, botId: instance.botId, error: err.message });
      // [FIX-M4] Failure → release lock immediately so other bots can try.
      this._releaseSymbolLock(lockSymbol, instance.instanceId);
    }
  }

  async _onTradeClosed(data) {
    try {
      const contractId = String(data && data.contractId || '');
      if (!contractId) return;
      const run = await BotRun.findOne({ contractId, status: 'OPEN' });
      if (!run) {
        // [FIX-R3] Surface missing BotRun at WARN — indicates a persist failure
        // during entry. Stats won't update for this contract.
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

    return {
      instanceId: instance.instanceId, botId: instance.botId, name: instance.name, assetClass: instance.assetClass,
      contractClass: instance.contractClass, symbol: instance.symbol, status: instance.status, startedAt: instance.startedAt,
      lastRunAt: instance.lastRunAt, lastReason: instance.lastReason, config: instance.config,
      stats: statsForSummary,
    };
  }
}

const botRunner = new BotRunner();
eventBus.on('trade.closed', (data) => { botRunner._onTradeClosed(data).catch(() => {}); });
module.exports = botRunner;
