// core/bots/runner.js
// Bot lifecycle manager. Runs each bot on its own timer, gathers context,
// calls bot.evaluate(), places contracts via contractService, records BotRun.
//
// Key behaviors:
//   • Each instance has its own timer (15s for FX, 5s for digit/binary)
//   • Cycle skips if broker disconnected or same-symbol position exists
//   • Circuit breaker: stops instance after N consecutive losses
//   • Stops are safe — they do NOT close open positions (OTIE handles those)
//   • trade.closed events update BotRun + instance stats

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

function normalizeSymbol(s) {
  return String(s || '').replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
}

class BotRunner extends EventEmitter {
  constructor() {
    super();
    this._instances = new Map();   // instanceId -> instance object
    this._nextInstanceId = 1;
  }

  /**
   * Start a bot instance.
   * @param {string} botId
   * @param {Object} config — overrides for bot.defaultConfig
   * @returns {Object} summarized instance
   */
  start(botId, config = {}) {
    const bot = getBot(botId);
    if (!bot) throw new Error(`Unknown bot: ${botId}`);

    const instanceId = `bot-${this._nextInstanceId++}-${Date.now()}`;
    const finalConfig = Object.assign({}, bot.defaultConfig, config || {});
    const symbol = normalizeSymbol(finalConfig.symbol);

    const instance = {
      instanceId,
      botId,
      name: bot.name,
      assetClass: bot.assetClass,
      contractClass: bot.contractClass,
      symbol,
      config: finalConfig,
      status: 'RUNNING',
      startedAt: new Date(),
      lastRunAt: null,
      lastReason: null,
      timer: null,
      _running: false,                 // in-flight cycle guard
      stats: {
        runs: 0,
        entries: 0,
        wins: 0,
        losses: 0,
        pnl: 0,
        consecutiveLosses: 0,
      },
    };

    // Tick interval: faster for digit/binary (they care about tick flow)
    const intervalMs = bot.assetClass === 'fx' ? 15000 : 5000;
    instance.timer = setInterval(() => {
      this._runCycle(instance).catch(err => {
        logger.error(`[BotRunner] ${instanceId} cycle error: ${err.message}`);
      });
    }, intervalMs);
    if (typeof instance.timer.unref === 'function') instance.timer.unref();

    this._instances.set(instanceId, instance);
    logger.info(`[BotRunner] Started ${bot.name} (${instanceId}) on ${symbol} @ ${intervalMs}ms`);

    const summary = this._summarize(instance);
    this.emit('botStarted', summary);

    // Immediate first run after 1s
    setTimeout(() => {
      this._runCycle(instance).catch(() => {});
    }, 1000);

    return summary;
  }

  stop(instanceId) {
    const instance = this._instances.get(instanceId);
    if (!instance) return null;
    if (instance.timer) clearInterval(instance.timer);
    instance.status = 'STOPPED';
    instance.stoppedAt = new Date();
    this._instances.delete(instanceId);
    logger.info(
      `[BotRunner] Stopped ${instance.name} (${instanceId}) — ` +
      `${instance.stats.entries} entries, P/L=${instance.stats.pnl.toFixed(2)}`
    );
    const summary = this._summarize(instance);
    this.emit('botStopped', summary);
    return summary;
  }

  stopAll() {
    const ids = Array.from(this._instances.keys());
    for (const id of ids) this.stop(id);
    return ids.length;
  }

  list() {
    return Array.from(this._instances.values()).map(i => this._summarize(i));
  }

  get(instanceId) {
    const i = this._instances.get(instanceId);
    return i ? this._summarize(i) : null;
  }

  // ==============================================================
  // Run cycle
  // ==============================================================
  async _runCycle(instance) {
    if (instance.status !== 'RUNNING') return;
    if (instance._running) return;              // skip if previous cycle still in flight
    instance._running = true;

    try {
      // ---- Circuit breaker ----
      const maxLosses = instance.config.stopAfterLosses || 3;
      if (instance.stats.consecutiveLosses >= maxLosses) {
        logger.warn(`[BotRunner] ${instance.instanceId} — ${instance.stats.consecutiveLosses} consecutive losses, auto-stopping`);
        this.stop(instance.instanceId);
        return;
      }

      instance.lastRunAt = new Date();

      // ---- Broker check ----
      const broker = getBroker('deriv_cfd');
      if (!broker.isConnected()) {
        instance.lastReason = 'broker disconnected';
        return;
      }

      // ---- Duplicate position guard: skip if we already have this symbol open ----
      const positions = await broker.getOpenTrades().catch(() => []);
      const hasPosition = positions.some(p => normalizeSymbol(p.instrument) === instance.symbol);
      if (hasPosition) {
        instance.lastReason = 'already have position on symbol';
        return;
      }

      // ---- Gather context ----
      const bot = getBot(instance.botId);
      const timeframe = instance.config.timeframe || 'M5';
      const ctx = { config: instance.config };

      if (bot.assetClass === 'fx') {
        const state = await deepMarketState.compute(instance.symbol, timeframe, 200).catch(() => null);
        if (!state) { instance.lastReason = 'no deep state'; return; }
        ctx.state = state;

        const consensus = await ranker.rank(state, instance.symbol, { timeframe }).catch(() => null);
        ctx.consensus = consensus;

        const prediction = await predictor.predict(instance.symbol, state, consensus, { timeframe }).catch(() => null);
        ctx.prediction = prediction;

        const candles = await candleHistory.getHistory(instance.symbol, timeframe, 100).catch(() => []);
        ctx.candles = candles || [];
      } else {
        // Digit / binary — pull digit view
        const digitView = digitAnalyzer.getView(instance.symbol);
        if (!digitView) { instance.lastReason = 'no digit data'; return; }
        ctx.digitView = digitView;
      }

      instance.stats.runs++;

      // ---- Evaluate ----
      let result;
      try {
        result = bot.evaluate(ctx);
      } catch (evalErr) {
        logger.error(`[BotRunner] ${instance.instanceId} evaluate threw: ${evalErr.message}`);
        instance.lastReason = `evaluate error: ${evalErr.message}`;
        return;
      }

      if (!result || result.action === 'WAIT') {
        instance.lastReason = (result && result.reasons && result.reasons[0]) || 'WAIT';
        this.emit('botCycle', {
          instanceId: instance.instanceId,
          botId: instance.botId,
          action: 'WAIT',
          reasons: (result && result.reasons) || [],
          symbol: instance.symbol,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (result.action === 'ENTER') {
        instance.lastReason = 'ENTERED';
        await this._execute(instance, result);
      }
    } catch (err) {
      logger.error(`[BotRunner] ${instance.instanceId} cycle exception: ${err.message}`);
      instance.lastReason = `cycle error: ${err.message}`;
    } finally {
      instance._running = false;
    }
  }

  // ==============================================================
  // Execute entry
  // ==============================================================
  async _execute(instance, signal) {
    const { tradeParams, direction, reasons } = signal;
    try {
      let result;

      if (tradeParams.contractClass === 'multiplier') {
        result = await contractService.placeContract({
          symbol: tradeParams.symbol,
          direction: tradeParams.direction || direction,
          stake: tradeParams.stake,
          multiplier: tradeParams.multiplier,
          duration: tradeParams.duration,
          durationUnit: tradeParams.durationUnit || 's',
          knockoutLevel: tradeParams.knockoutLevel,
          takeProfitLevel: tradeParams.takeProfitLevel,
          strategy: instance.botId,
          regimeCode: instance.config.regimeCode || 'NEUTRAL',
          entryThesis: {
            botId: instance.botId,
            instanceId: instance.instanceId,
            reasons: reasons || [],
          },
        });
      } else if (tradeParams.contractClass === 'digit' || tradeParams.contractClass === 'binary') {
        result = await contractService.placeContract({
          symbol: tradeParams.symbol,
          contractType: tradeParams.contractType,
          barrier: tradeParams.barrier,
          stake: tradeParams.stake,
          duration: tradeParams.duration,
          durationUnit: tradeParams.durationUnit || 't',
          strategy: instance.botId,
          regimeCode: instance.config.regimeCode || 'NEUTRAL',
          entryThesis: {
            botId: instance.botId,
            instanceId: instance.instanceId,
            reasons: reasons || [],
          },
        });
      } else {
        throw new Error(`Unknown contractClass: ${tradeParams.contractClass}`);
      }

      instance.stats.entries++;

      // Record BotRun
      const run = await BotRun.create({
        botId: instance.botId,
        instanceId: instance.instanceId,
        contractId: String(result.contractId),
        symbol: normalizeSymbol(instance.config.symbol),
        side: tradeParams.contractType || direction,
        contractType: tradeParams.contractType || null,
        stake: Number(tradeParams.stake),
        multiplier: tradeParams.multiplier || null,
        duration: tradeParams.duration || null,
        durationUnit: tradeParams.durationUnit || null,
        barrier: tradeParams.barrier != null ? String(tradeParams.barrier) : null,
        entryPrice: result.entryPrice,
        takeProfitLevel: tradeParams.takeProfitLevel != null ? Number(tradeParams.takeProfitLevel) : null,
        knockoutLevel: tradeParams.knockoutLevel != null ? Number(tradeParams.knockoutLevel) : null,
        reasons: reasons || [],
        openedAt: new Date(),
        status: 'OPEN',
      }).catch(err => {
        logger.error(`[BotRunner] BotRun persist failed for ${result.contractId}: ${err.message}`);
        return null;
      });

      logger.info(
        `[BotRunner] ${instance.botId}/${instance.instanceId} ENTERED ` +
        `${tradeParams.contractType || direction} ${instance.config.symbol} ` +
        `contract=${result.contractId}`
      );

      this.emit('botEntry', {
        instanceId: instance.instanceId,
        botId: instance.botId,
        contractId: String(result.contractId),
        symbol: instance.config.symbol,
        side: tradeParams.contractType || direction,
        entryPrice: result.entryPrice,
        stake: tradeParams.stake,
        multiplier: tradeParams.multiplier,
        reasons: reasons || [],
        runId: run ? String(run._id) : null,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.error(`[BotRunner] ${instance.botId}/${instance.instanceId} entry failed: ${err.message}`);
      this.emit('botError', {
        instanceId: instance.instanceId,
        botId: instance.botId,
        error: err.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ==============================================================
  // Called by eventBus 'trade.closed' listener
  // ==============================================================
  async _onTradeClosed(data) {
    try {
      const contractId = String(data && data.contractId || '');
      if (!contractId) return;
      const run = await BotRun.findOne({ contractId, status: 'OPEN' });
      if (!run) return;   // this trade wasn't from a bot

      const realizedProfit = Number(data.realizedProfit || 0);
      run.pnl = realizedProfit;
      run.realizedProfit = realizedProfit;
      run.result = realizedProfit > 0 ? 'WIN' : realizedProfit < 0 ? 'LOSS' : 'BREAKEVEN';
      run.closePrice = (data.result && data.result.closePrice) || null;
      run.closedAt = new Date();
      run.status = 'CLOSED';
      await run.save();

      // Update live instance stats
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
        this.emit('botResult', {
          instanceId: run.instanceId,
          botId: run.botId,
          contractId,
          result: run.result,
          pnl: realizedProfit,
          totalPnl: instance.stats.pnl,
          wins: instance.stats.wins,
          losses: instance.stats.losses,
          timestamp: new Date().toISOString(),
        });
      }

      logger.info(
        `[BotRunner] ${run.botId}/${run.instanceId} CLOSED ${contractId} ` +
        `result=${run.result} pnl=${realizedProfit.toFixed(2)}`
      );
    } catch (err) {
      logger.error(`[BotRunner] _onTradeClosed failed: ${err.message}`);
    }
  }

  _summarize(instance) {
    return {
      instanceId: instance.instanceId,
      botId: instance.botId,
      name: instance.name,
      assetClass: instance.assetClass,
      contractClass: instance.contractClass,
      symbol: instance.symbol,
      status: instance.status,
      startedAt: instance.startedAt,
      lastRunAt: instance.lastRunAt,
      lastReason: instance.lastReason,
      config: instance.config,
      stats: Object.assign({}, instance.stats),
    };
  }
}

// ---- Singleton ----
const botRunner = new BotRunner();

// Wire trade.closed → update BotRun + instance stats
eventBus.on('trade.closed', (data) => {
  botRunner._onTradeClosed(data).catch(() => {});
});

module.exports = botRunner;
