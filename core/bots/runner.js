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

// Trading session detection by UTC hour. Used by allowedSessions gate
// and as a tag on every BotRun for regime × session edge analysis.
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

class BotRunner extends EventEmitter {
  constructor() {
    super();
    this._instances = new Map();
    this._nextInstanceId = 1;
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
      stats: { runs: 0, entries: 0, wins: 0, losses: 0, pnl: 0, peakPnl: 0, consecutiveLosses: 0 },
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

  async _runCycle(instance) {
    if (instance.status !== 'RUNNING') return;
    if (instance._running) return;
    instance._running = true;

    try {
      // 1. SETTLEMENT COOLDOWN: Prevent firing before the last trade settles
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

      // 2b. Session PnL rules — take-profit / stop-loss / trailing drawdown
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

      // 2c. Session gate — skip if current session not in allowedSessions
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

      const bot = getBot(instance.botId);
      const timeframe = instance.config.timeframe || 'M5';
      
      // Pass stats so bot can adapt thresholds based on consecutive losses
      const ctx = { config: instance.config, stats: instance.stats };

      if (bot.assetClass === 'fx') {
        const state = await deepMarketState.compute(instance.symbol, timeframe, 200).catch(() => null);
        if (!state) { instance.lastReason = 'no deep state'; return; }
        ctx.state = state;

        // 2d. Regime gate — FX only (synthetics don't have regime)
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

  _validateRiskReward(instance, tradeParams, ctx) {
    const minRR = Number(instance.config.minRiskReward) || 0;
    if (minRR <= 0) return { ok: true };
    if (tradeParams.contractClass !== 'multiplier') return { ok: true };

    const entryPrice = ctx && ctx.state && ctx.state.price && ctx.state.price.current;
    const ko = Number(tradeParams.knockoutLevel);
    const tp = Number(tradeParams.takeProfitLevel);

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
      digitView: dv ? {
        sampleSize: dv.sampleSize,
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

    // ── Stake validation (reject, do not clamp) ─────────────
    const stakeCheck = this._validateStake(instance, tradeParams.stake);
    if (!stakeCheck.ok) {
      instance.lastReason = `Execution blocked: ${stakeCheck.reason}`;
      logger.warn(`[BotRunner] ${instance.instanceId} — ${instance.lastReason}`);
      this.emit('botError', { instanceId: instance.instanceId, botId: instance.botId, error: stakeCheck.reason });
      return;
    }

    // ── Risk-reward gate (FX multiplier only) ───────────────
    const rrCheck = this._validateRiskReward(instance, tradeParams, ctx);
    if (!rrCheck.ok) {
      instance.lastReason = `Execution blocked: ${rrCheck.reason}`;
      logger.warn(`[BotRunner] ${instance.instanceId} — ${instance.lastReason}`);
      this.emit('botError', { instanceId: instance.instanceId, botId: instance.botId, error: rrCheck.reason });
      return;
    }

    const entryThesis = this._buildEntryThesis(instance, reasons, ctx);
    const isEdgeTest = !!instance.config._edgeTest;
    const currentSession = detectSession();
    const currentRegime = ctx && ctx.state && ctx.state.regime ? ctx.state.regime.code : null;

    try {
      let result;
      if (tradeParams.contractClass === 'multiplier') {
        result = await contractService.placeContract({
          symbol: tradeParams.symbol, direction: tradeParams.direction || direction, stake: stakeCheck.stake,
          multiplier: tradeParams.multiplier, duration: tradeParams.duration, durationUnit: tradeParams.durationUnit || 's',
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

      // Only mark as entered if the contract actually went through
      instance.stats.entries++;
      instance._lastEntryTime = Date.now(); // Triggers 15-second cooldown
      instance.lastReason = 'TRADE PLACED';

      await BotRun.create({
        botId: instance.botId, instanceId: instance.instanceId, contractId: String(result.contractId),
        symbol: normalizeSymbol(instance.config.symbol), side: tradeParams.contractType || direction,
        contractType: tradeParams.contractType || null, stake: Number(stakeCheck.stake),
        multiplier: tradeParams.multiplier || null, duration: tradeParams.duration || null,
        durationUnit: tradeParams.durationUnit || null, barrier: tradeParams.barrier != null ? String(tradeParams.barrier) : null,
        entryPrice: result.entryPrice, takeProfitLevel: tradeParams.takeProfitLevel != null ? Number(tradeParams.takeProfitLevel) : null,
        knockoutLevel: tradeParams.knockoutLevel != null ? Number(tradeParams.knockoutLevel) : null,
        reasons: reasons || [], openedAt: new Date(), status: 'OPEN',
        // New fields for edge analytics (schema must accept these — see note above)
        isEdgeTest,
        regimeCode: currentRegime,
        session: currentSession,
      }).catch(err => logger.error(`[BotRunner] BotRun persist failed: ${err.message}`));

      this.emit('botEntry', { instanceId: instance.instanceId, botId: instance.botId, contractId: String(result.contractId), symbol: instance.config.symbol, side: tradeParams.contractType || direction, entryPrice: result.entryPrice, stake: stakeCheck.stake, reasons, timestamp: new Date().toISOString() });
    } catch (err) {
      // If it fails, print the actual error, not "ENTERED"
      logger.error(`[BotRunner] ${instance.botId}/${instance.instanceId} entry failed: ${err.message}`);
      instance.lastReason = `Execution failed: ${err.message}`;
      this.emit('botError', { instanceId: instance.instanceId, botId: instance.botId, error: err.message });
    }
  }

  async _onTradeClosed(data) {
    try {
      const contractId = String(data && data.contractId || '');
      if (!contractId) return;
      const run = await BotRun.findOne({ contractId, status: 'OPEN' });
      if (!run) return;

      const realizedProfit = Number(data.realizedProfit || 0);
      run.pnl = realizedProfit; run.realizedProfit = realizedProfit;
      run.result = realizedProfit > 0 ? 'WIN' : realizedProfit < 0 ? 'LOSS' : 'BREAKEVEN';
      run.closePrice = (data.result && data.result.closePrice) || null;
      run.closedAt = new Date(); run.status = 'CLOSED';
      await run.save();

      const instance = this._instances.get(run.instanceId);
      if (instance) {
        instance.stats.pnl += realizedProfit;
        if (run.result === 'WIN') { 
          instance.stats.wins++; 
          instance.stats.consecutiveLosses = 0; 
        } else if (run.result === 'LOSS') {
          instance.stats.losses++; 
          instance.stats.consecutiveLosses++;
        }
        this.emit('botResult', { instanceId: run.instanceId, botId: run.botId, contractId, result: run.result, pnl: realizedProfit, totalPnl: instance.stats.pnl, timestamp: new Date().toISOString() });
      }
    } catch (err) { logger.error(`[BotRunner] _onTradeClosed failed: ${err.message}`); }
  }

  _summarize(instance) {
    return {
      instanceId: instance.instanceId, botId: instance.botId, name: instance.name, assetClass: instance.assetClass,
      contractClass: instance.contractClass, symbol: instance.symbol, status: instance.status, startedAt: instance.startedAt,
      lastRunAt: instance.lastRunAt, lastReason: instance.lastReason, config: instance.config, stats: Object.assign({}, instance.stats),
    };
  }
}

const botRunner = new BotRunner();
eventBus.on('trade.closed', (data) => { botRunner._onTradeClosed(data).catch(() => {}); });
module.exports = botRunner;
