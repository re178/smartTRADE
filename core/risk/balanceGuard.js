// core/risk/balanceGuard.js
// Portfolio-level risk guard. Watches the account BALANCE (not individual
// trades) and triggers a protective response when balance drops too far
// from its peak.
//
// Behavior:
//   • Tracks a high-water mark (HWM) of balance since session start
//   • Sets a floor = HWM * (1 - maxDDPct). Default maxDDPct = 10%.
//   • The floor TRAILS UPWARD: every new balance high raises the floor.
//     Example: $1000 → $1200 (floor $1080) → $1100 still OK, floor stays $1080.
//     If balance drops to $1080, guard fires BEFORE giving back the $200 profit.
//   • On trigger: stop all running bots, close all open trades (optional),
//     enter cooldown. Cooldown does NOT auto-resume — user must manually
//     restart bots after reviewing.
//
// Env vars:
//   BALANCE_GUARD_ENABLED=true
//   BALANCE_GUARD_MAX_DD_PCT=0.10
//   BALANCE_GUARD_CLOSE_TRADES=true
//   BALANCE_GUARD_COOLDOWN_MIN=120
//   BALANCE_GUARD_MIN_BALANCE=1

'use strict';

const EventEmitter = require('events');
const eventBus = require('../../infrastructure/eventBus');
const logger = require('../../infrastructure/logger') || console;

function _readConfig() {
  return {
    enabled: process.env.BALANCE_GUARD_ENABLED !== 'false',
    maxDDPct: parseFloat(process.env.BALANCE_GUARD_MAX_DD_PCT) || 0.10,
    closeTradesOnTrigger: process.env.BALANCE_GUARD_CLOSE_TRADES !== 'false',
    cooldownMin: parseInt(process.env.BALANCE_GUARD_COOLDOWN_MIN) || 120,
    minBalance: parseFloat(process.env.BALANCE_GUARD_MIN_BALANCE) || 1,
  };
}

class BalanceGuard extends EventEmitter {
  constructor() {
    super();
    this.config = _readConfig();
    this._subscribed = false;
    this._baseline = null;
    this._hwm = 0;
    this._floor = null;
    this._currentBalance = null;
    this._triggeredAt = null;
    this._coolingDownUntil = null;
    this._triggerCount = 0;
  }

  start() {
    if (this._subscribed) return;
    if (!this.config.enabled) {
      logger.info('[BalanceGuard] Disabled via BALANCE_GUARD_ENABLED=false');
      return;
    }

    try {
      const { getBroker } = require('../execution/brokerFactory');
      const broker = getBroker('deriv_cfd');
      broker.on('accountUpdate', (account) => this._onBalance(account));
      logger.info('[BalanceGuard] Subscribed to broker.accountUpdate');
    } catch (err) {
      logger.warn(`[BalanceGuard] Broker subscribe failed: ${err.message}`);
    }

    eventBus.on('account.fetched', (account) => this._onBalance(account));

    this._subscribed = true;
    logger.info(
      `[BalanceGuard] Started — maxDD=${(this.config.maxDDPct * 100).toFixed(1)}% ` +
      `closeTrades=${this.config.closeTradesOnTrigger} cooldown=${this.config.cooldownMin}min`
    );
  }

  _onBalance(account) {
    if (!this.config.enabled) return;
    const bal = Number(account && (account.balance ?? account.equity));
    if (!Number.isFinite(bal) || bal < this.config.minBalance) return;

    this._currentBalance = bal;

    if (this._baseline === null) {
      this._baseline = bal;
      this._hwm = bal;
      this._floor = bal * (1 - this.config.maxDDPct);
      logger.info(
        `[BalanceGuard] Baseline: $${bal.toFixed(2)} · floor $${this._floor.toFixed(2)} ` +
        `(max DD ${(this.config.maxDDPct * 100).toFixed(0)}% from peak)`
      );
      return;
    }

    if (bal > this._hwm) {
      const oldHwm = this._hwm;
      const oldFloor = this._floor;
      this._hwm = bal;
      const newFloor = bal * (1 - this.config.maxDDPct);
      if (newFloor > this._floor) {
        this._floor = newFloor;
        logger.info(
          `[BalanceGuard] NEW HIGH $${bal.toFixed(2)} (was $${oldHwm.toFixed(2)}) — ` +
          `floor raised $${oldFloor.toFixed(2)} → $${this._floor.toFixed(2)}`
        );
      }
    }

    if (this._coolingDownUntil && Date.now() < this._coolingDownUntil) {
      return;
    }

    if (this._floor != null && bal <= this._floor) {
      this._trigger(bal);
    }
  }

  async _trigger(currentBalance) {
    if (this._triggeredAt && Date.now() - this._triggeredAt < 60000) return;

    this._triggeredAt = Date.now();
    this._triggerCount++;
    this._coolingDownUntil = Date.now() + this.config.cooldownMin * 60000;

    const giveback = this._hwm - currentBalance;
    const givebackPct = this._hwm > 0 ? (giveback / this._hwm) : 0;

    logger.warn(
      `[BalanceGuard] TRIGGERED (event #${this._triggerCount}) — ` +
      `balance $${currentBalance.toFixed(2)} <= floor $${this._floor.toFixed(2)} ` +
      `(peak $${this._hwm.toFixed(2)}, giveback $${giveback.toFixed(2)} = ${(givebackPct * 100).toFixed(1)}%)`
    );

    let stoppedCount = 0;
    try {
      const botRunner = require('../bots/runner');
      stoppedCount = botRunner.stopAll();
      logger.warn(`[BalanceGuard] Stopped ${stoppedCount} running bot(s).`);
    } catch (err) {
      logger.error(`[BalanceGuard] Failed to stop bots: ${err.message}`);
    }

    let closedCount = 0;
    if (this.config.closeTradesOnTrigger) {
      try {
        const { getBroker } = require('../execution/brokerFactory');
        const broker = getBroker('deriv_cfd');
        const positions = await broker.getOpenTrades();
        for (const pos of positions) {
          try {
            await broker.closeTrade(pos.id);
            closedCount++;
          } catch (closeErr) {
            logger.warn(`[BalanceGuard] Failed to close ${pos.id}: ${closeErr.message}`);
          }
        }
        logger.warn(`[BalanceGuard] Closed ${closedCount}/${positions.length} open trade(s).`);
      } catch (err) {
        logger.error(`[BalanceGuard] Close-all failed: ${err.message}`);
      }
    }

    const state = this.getState();
    try {
      eventBus.emit('balanceGuard.triggered', {
        ...state,
        giveback,
        givebackPct,
        stoppedBots: stoppedCount,
        closedTrades: closedCount,
        triggeredAt: new Date().toISOString(),
      });
    } catch (_) {}

    logger.warn(
      `[BalanceGuard] PROTECTED — Account is now LOCKED. ` +
      `Cooldown active until ${new Date(this._coolingDownUntil).toISOString()}.`
    );
  }

  isCoolingDown() {
    return this._coolingDownUntil != null && Date.now() < this._coolingDownUntil;
  }

  reset() {
    this._baseline = this._currentBalance;
    this._hwm = this._currentBalance;
    this._floor = this._currentBalance * (1 - this.config.maxDDPct);
    this._coolingDownUntil = null;
    logger.info(`[BalanceGuard] Reset — baseline=$${this._baseline.toFixed(2)} floor=$${this._floor.toFixed(2)}`);
  }

  getState() {
    const cooling = this.isCoolingDown();
    return {
      enabled: this.config.enabled,
      baseline: this._baseline != null ? Number(this._baseline.toFixed(2)) : null,
      hwm: this._hwm > 0 ? Number(this._hwm.toFixed(2)) : null,
      floor: this._floor != null ? Number(this._floor.toFixed(2)) : null,
      currentBalance: this._currentBalance != null ? Number(this._currentBalance.toFixed(2)) : null,
      maxDDPct: this.config.maxDDPct,
      closeTradesOnTrigger: this.config.closeTradesOnTrigger,
      cooldownMin: this.config.cooldownMin,
      coolingDown: cooling,
      coolingDownUntil: cooling ? new Date(this._coolingDownUntil).toISOString() : null,
      lastTriggerAt: this._triggeredAt ? new Date(this._triggeredAt).toISOString() : null,
      triggerCount: this._triggerCount,
    };
  }
}

const balanceGuard = new BalanceGuard();
module.exports = balanceGuard;
