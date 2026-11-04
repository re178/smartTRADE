// core/execution/contractService.js
// Generic contract placement for all Deriv contract classes:
//   • Multiplier (MULTUP / MULTDOWN)         — FX pairs
//   • Digital (DIGITEVEN/ODD/OVER/UNDER/...) — Synthetic indices
//   • Binary (CALL/PUT/ONETOUCH/NOTOUCH)     — Synthetic indices
//
// Uses broker._sendAuthRequest — does NOT modify broker.js.
// Callers: bots/runner.js (bot entries), api/controllers.js (manual orders).
//
// [FIX-1] Multiplier contracts on Deriv do NOT accept duration_unit: 's'.
//         They exit on limit_order barrier hit (or manual close).
//         Sending duration/duration_unit caused InvalidExpiry on every
//         FX bot entry — all FX bots have been blocked until this fix.
//
// [FIX-2] Deriv deprecated multipliers 100, 300, 500. Only [200, 400, 600, 800]
//         are accepted now. Any attempt with an invalid multiplier is rejected.
//
// [FIX-3] roundPrice() applies per-symbol decimal precision to
//         knockoutLevel / takeProfitLevel before they hit Deriv's proposal API.
//         Prevents USDJPY InputValidationFailed on float noise.
//
// [FIX-DIGIT-PERSIST] _persist() was failing to save Order and Trade docs
//         for every digit/binary contract. Three root causes:
//           1. side was stored as 'CALL'/'call'/'DIGITEVEN'/'digiteven'/etc.
//              which violated both enums (Order: BUY/SELL; Trade: buy/sell).
//              Now normalized: BUY for "positive bet" contracts (CALL, MULTUP,
//              DIGITEVEN/OVER/MATCH, ONETOUCH), SELL for "negative bet"
//              contracts (PUT, MULTDOWN, DIGITODD/UNDER/DIFF, NOTOUCH).
//              The specific contract type is stored in contractType.
//           2. Order.units and Order.clientOrderId were required but never
//              populated. Now set from stake and contractId respectively.
//           3. Trade.side was lowercased from an already-invalid value.
//              Now normalized once via _normalizeSide() and reused.
//
// [FIX-DIGIT-PERSIST-2] Persist contractType, barrier, durationUnit, product,
//              and entryThesis on BOTH Order and Trade.
//
// [FIX-CS-C1] **ROOT CAUSE FIX for ContractBuyValidationError on FX multipliers.**
//             Deriv's Multiplier contracts expect `limit_order.stop_loss` and
//             `limit_order.take_profit` as CURRENCY AMOUNTS (2 decimals), NOT
//             PRICE LEVELS. The previous code sent `1.12044` / `1.12249` as
//             if they were prices — Deriv interprets them as $1.12 / $1.12
//             and rejects with "Only 2 decimal places allowed."
//
//             Now placeMultiplier() does:
//               1. Resolves a reference entry price (streaming cache if fresh,
//                  otherwise a base proposal without limit_order).
//               2. Converts price levels to amounts:
//                    notional   = stake × multiplier
//                    priceDiff  = |level - entry|
//                    amount     = notional × priceDiff / entry
//                  Result rounded to 2 decimals.
//               3. Sends the AMOUNT to Deriv, but persists the original
//                  PRICE LEVELS in Order.knockoutLevel / Trade.knockoutLevel
//                  (schemas expect prices, and this preserves intent).
//
//             This is the fix that unblocks FX bot entries. The C1 fix in
//             broker.js still applies for callers that use broker.placeMarketOrder
//             (e.g. modifySLTP, closeTrade), but bot entries go through
//             contractService directly and needed their own conversion.
//
// [FIX-CS-C2] Defensive guards on the SL/TP conversion:
//               • Skips SL/TP amounts below $0.01 (stake too small / SL too tight)
//               • Caps SL amount at stake (can't lose more than stake on Multiplier)
//               • Skips SL/TP on wrong side of entry (with WARN — the runner's
//                 [FIX-M4c] should have already rejected, but double-check here)
//               • If base proposal fails (rate limit), proceeds without limit_order
//                 and logs WARN — OTIE watchdog is the backstop
//             All conversions log at INFO so the amount values are visible.
//
// [FIX-CS-C3] **Bot-path buy recovery.** Bots bypass broker.placeMarketOrder
//             and call broker._sendAuthRequest({ buy }) directly, so the
//             recovery logic added to broker.placeMarketOrder in FIX-RECON-BUY
//             does not protect them. This file now wraps _buyProposal:
//               1. On any thrown error (timeout, InvalidContractProposal,
//                  network drop), waits RECONCILE_BUY_GRACE_MS then fetches
//                  the portfolio.
//               2. Matches a contract created within the lookback window
//                  against the intended symbol, side, stake, and open time.
//               3. On match, returns a synthetic `buy` object so the caller
//                  sees success and no retry is attempted.
//               4. On no match, re-throws the original error.
//             This makes bot entries as resilient to the buy-timeout problem
//             as manual/live-signal entries are after FIX-RECON-BUY in
//             broker.js. Metrics tracked and exposed via getStats().

'use strict';

const { getBroker } = require('./brokerFactory');
const Order = require('../../models/Order');
const Trade = require('../../models/Trade');
const eventBus = require('../../infrastructure/eventBus');
const logger = require('../../infrastructure/logger') || console;

const CONTRACT_TYPES = {
  MULTUP: 'MULTUP',
  MULTDOWN: 'MULTDOWN',
  CALL: 'CALL',
  PUT: 'PUT',
  DIGITEVEN: 'DIGITEVEN',
  DIGITODD: 'DIGITODD',
  DIGITOVER: 'DIGITOVER',
  DIGITUNDER: 'DIGITUNDER',
  DIGITMATCH: 'DIGITMATCH',
  DIGITDIFF: 'DIGITDIFF',
  ONETOUCH: 'ONETOUCH',
  NOTOUCH: 'NOTOUCH',
};

const ACCEPTED_MULTIPLIERS = [200, 400, 600, 800];
const DEFAULT_MULTIPLIER = 200;

// [FIX-CS-C1] Minimum amount for a limit_order field (Deriv rejects 0.00).
const MIN_LIMIT_ORDER_AMOUNT = 0.01;

// [FIX-CS-C1] Max age of streaming-cache price before we prefer a fresh
// base proposal. 5s is well within any normal market-data subscription gap.
const CACHE_PRICE_MAX_AGE_MS = 5000;

// [FIX-CS-C3] Reconcile-buy parameters — must match broker.js.
// Grace period lets Deriv settle a possibly-succeeded buy before we check.
const RECONCILE_BUY_GRACE_MS = 2000;
// How far back in portfolio history to look for a matching contract.
const RECONCILE_BUY_LOOKBACK_MS = 60_000;

const SIDE_BUY_TYPES = new Set([
  'MULTUP', 'CALL',
  'DIGITEVEN', 'DIGITOVER', 'DIGITMATCH',
  'ONETOUCH',
]);
const SIDE_SELL_TYPES = new Set([
  'MULTDOWN', 'PUT',
  'DIGITODD', 'DIGITUNDER', 'DIGITDIFF',
  'NOTOUCH',
]);

// [FIX-CS-C3] Reconcile metrics — surfaced via getStats().
const _reconcileMetrics = {
  attempts: 0,
  recovered: 0,
  lastRecoveredAt: null,
  lastOriginalError: null,
};

function _normalizeSide(contractTypeOrSide) {
  if (!contractTypeOrSide) return 'BUY';
  const upper = String(contractTypeOrSide).toUpperCase();
  if (upper === 'BUY' || upper === 'SELL') return upper;
  if (SIDE_BUY_TYPES.has(upper)) return 'BUY';
  if (SIDE_SELL_TYPES.has(upper)) return 'SELL';
  return 'BUY';
}

function normalizeSymbol(s) {
  if (!s) return '';
  return String(s).replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
}

function getPricePrecision(symbol) {
  const clean = normalizeSymbol(symbol);
  const map = {
    EURUSD: 5, GBPUSD: 5, AUDUSD: 5, NZDUSD: 5, USDCHF: 5, USDCAD: 5,
    USDJPY: 3, EURJPY: 3, GBPJPY: 3, AUDJPY: 3,
    XAUUSD: 2, XAGUSD: 3, BTCUSD: 2, ETHUSD: 2,
  };
  return map[clean] != null ? map[clean] : 5;
}

function roundPrice(symbol, price) {
  if (price == null || !Number.isFinite(Number(price))) return null;
  const p = getPricePrecision(symbol);
  const f = Math.pow(10, p);
  return Math.round(Number(price) * f) / f;
}

function toDerivSymbol(symbol, broker) {
  if (!symbol) return '';
  if (/^(R_|1HZ)/i.test(symbol)) return symbol;
  const clean = normalizeSymbol(symbol);
  const map = broker.symbolMap || {};
  if (map[clean]) return map[clean];
  const fxMap = {
    EURUSD: 'frxEURUSD', GBPUSD: 'frxGBPUSD', USDJPY: 'frxUSDJPY',
    AUDUSD: 'frxAUDUSD', USDCAD: 'frxUSDCAD', USDCHF: 'frxUSDCHF',
    NZDUSD: 'frxNZDUSD', EURGBP: 'frxEURGBP', EURJPY: 'frxEURJPY',
    GBPJPY: 'frxGBPJPY',
  };
  return fxMap[clean] || symbol;
}

async function _fetchProposal(broker, params) {
  const resp = await broker._sendAuthRequest({ proposal: 1, ...params }, 15000);
  const proposal = resp && resp.proposal;
  if (!proposal || !proposal.id) {
    throw new Error(`Proposal failed: ${JSON.stringify(resp && resp.error || resp)}`);
  }
  return proposal;
}

// ============================================================
// [FIX-CS-C3] Buy + reconcile
// ============================================================

/**
 * Reconcile a failed buy against the live portfolio.
 *
 * Matches the same criteria as broker._reconcileOrphanBuy so the two
 * recovery paths stay consistent:
 *   • same underlying_symbol as the intended trade
 *   • same side (BUY/SELL) as the intended direction
 *   • purchase_price within $0.01 of the intended stake
 *   • openTime >= (submittedAt - RECONCILE_BUY_LOOKBACK_MS)
 *
 * Returns a synthetic `buy` object or null if no match.
 */
async function _reconcileBuy(broker, context, submittedAt) {
  _reconcileMetrics.attempts++;

  // Give Deriv a beat to settle the (possibly-succeeded) buy.
  await new Promise(r => setTimeout(r, RECONCILE_BUY_GRACE_MS));

  const derivSymbol = toDerivSymbol(context.symbol, broker);
  const expectedSide = _normalizeSide(context.direction || context.contractType);
  const stakeNum = Math.abs(Number(context.stake));
  const minOpenTime = submittedAt - RECONCILE_BUY_LOOKBACK_MS;

  let positions;
  try {
    positions = await broker.getOpenTrades();
  } catch (err) {
    logger.warn(`[contractService] _reconcileBuy: portfolio fetch failed: ${err.message}`);
    return null;
  }

  const candidates = [];
  for (const p of positions) {
    const raw = p.raw || {};
    const pSymbol = raw.underlying_symbol || raw.underlying || '';
    if (pSymbol !== derivSymbol) continue;
    if (expectedSide && p.side && p.side !== 'UNKNOWN' && p.side !== expectedSide) continue;

    const pPrice = Number(p.purchasePrice || raw.buy_price || 0);
    if (Number.isFinite(pPrice) && Number.isFinite(stakeNum) && stakeNum > 0) {
      if (Math.abs(pPrice - stakeNum) > 0.01) continue;
    }

    const openTime = Number(p.openTime || 0);
    if (openTime && openTime < minOpenTime) continue;

    candidates.push(p);
  }

  if (candidates.length === 0) return null;

  // Prefer the most recently opened candidate.
  candidates.sort((a, b) => (b.openTime || 0) - (a.openTime || 0));
  const match = candidates[0];

  _reconcileMetrics.recovered++;
  _reconcileMetrics.lastRecoveredAt = new Date().toISOString();

  logger.warn(
    `[contractService] _reconcileBuy: RECOVERED contract ${match.id} ` +
    `for ${context.symbol} ${expectedSide} stake=${stakeNum} ` +
    `(original error: ${_reconcileMetrics.lastOriginalError || 'unknown'})`
  );

  // Return a buy-shaped object so callers see it as a successful buy.
  return {
    contract_id: match.id,
    buy_price: match.purchasePrice,
    entry_spot: match.entryPrice,
    _reconciled: true,
  };
}

/**
 * Wrapped buy. On any thrown error, attempts portfolio reconciliation
 * before re-throwing.
 *
 * `context` should contain { symbol, direction?, contractType?, stake }.
 * If context is missing, no reconciliation is attempted (same behaviour
 * as before FIX-CS-C3).
 */
async function _buyProposal(broker, proposal, context) {
  const askPrice = Number(proposal.ask_price);
  if (!Number.isFinite(askPrice) || askPrice <= 0) {
    throw new Error(`Invalid ask price: ${proposal.ask_price}`);
  }

  const submittedAt = Date.now();
  try {
    const resp = await broker._sendAuthRequest({ buy: proposal.id, price: askPrice }, 15000);
    const buy = resp && resp.buy;
    if (!buy || !buy.contract_id) {
      throw new Error(`Buy failed: ${JSON.stringify(resp && resp.error || resp)}`);
    }
    return buy;
  } catch (buyErr) {
    // [FIX-CS-C3] Attempt recovery if context was supplied.
    if (context && context.symbol && context.stake) {
      _reconcileMetrics.lastOriginalError = buyErr.message;
      logger.warn(
        `[contractService] _buyProposal failed for ${context.symbol} ` +
        `(${context.direction || context.contractType || '?'}) ` +
        `stake=${context.stake}: ${buyErr.message}. Reconciling against portfolio...`
      );

      let recovered = null;
      try {
        recovered = await _reconcileBuy(broker, context, submittedAt);
      } catch (recErr) {
        logger.warn(`[contractService] _reconcileBuy threw: ${recErr.message}`);
      }

      if (recovered) return recovered;
    }

    // No recovery — propagate the original error.
    throw buyErr;
  }
}

// ============================================================
// [FIX-CS-C1] Multiplier limit_order conversion
// ============================================================

/**
 * Resolve a reference entry price for computing limit_order AMOUNTS.
 *
 * Order of preference:
 *   1. Streaming cache — free, but only if < CACHE_PRICE_MAX_AGE_MS old
 *   2. Base proposal (no limit_order) — one API call, authoritative
 *
 * Returns null if neither path produces a usable price.
 */
async function _resolveReferenceEntry(broker, derivSymbol, baseProposalParams) {
  // 1. Streaming cache
  try {
    const cached = broker.streaming && typeof broker.streaming.getPrice === 'function'
      ? broker.streaming.getPrice(derivSymbol)
      : null;
    if (cached && Number.isFinite(cached.mid) && cached.mid > 0) {
      const age = Date.now() - (cached.time || 0);
      if (age <= CACHE_PRICE_MAX_AGE_MS) {
        logger.debug(
          `[contractService] Reference entry from cache: ${cached.mid} ` +
          `(age ${age}ms) for ${derivSymbol}`
        );
        return cached.mid;
      }
    }
  } catch (_) { /* cache miss is fine */ }

  // 2. Base proposal
  try {
    const baseProposal = await _fetchProposal(broker, baseProposalParams);
    const spot = Number(baseProposal.spot);
    if (Number.isFinite(spot) && spot > 0) {
      logger.debug(
        `[contractService] Reference entry from base proposal: ${spot} for ${derivSymbol}`
      );
      return spot;
    }
  } catch (err) {
    logger.warn(
      `[contractService] Base proposal for ${derivSymbol} failed: ${err.message} — ` +
      `will proceed without limit_order`
    );
  }

  return null;
}

/**
 * [FIX-CS-C1] Convert SL/TP PRICE LEVELS to currency AMOUNTS for Deriv
 * Multiplier `limit_order`.
 *
 * Deriv's Multiplier contracts size stop-loss / take-profit by the LOSS or
 * PROFIT they should trigger at, expressed in account currency. A caller
 * that has SL=1.11969 / TP=1.12249 (price levels) must convert to amounts:
 *
 *   notional   = stake × multiplier
 *   priceDiff  = |level - entry|
 *   amount     = notional × priceDiff / entry
 *
 * @returns {{ stop_loss?: number, take_profit?: number }}
 */
function _buildMultiplierLimitOrder(stake, multiplier, direction, entryPrice, stopLossPrice, takeProfitPrice) {
  const limitOrder = {};
  const notional = Number(stake) * Number(multiplier);
  if (!Number.isFinite(notional) || notional <= 0) return limitOrder;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return limitOrder;

  if (stopLossPrice != null) {
    const sl = Number(stopLossPrice);
    if (Number.isFinite(sl) && sl > 0) {
      const priceDiff = direction === 'BUY' ? (entryPrice - sl) : (sl - entryPrice);
      if (priceDiff > 0) {
        const lossAmount = notional * priceDiff / entryPrice;
        let rounded = Math.round(lossAmount * 100) / 100;
        // [FIX-CS-C2] Multiplier loss cannot exceed the stake — cap it.
        const stakeNum = Number(stake) || 0;
        if (stakeNum > 0 && rounded > stakeNum) rounded = Math.floor(stakeNum * 100) / 100;
        if (rounded >= MIN_LIMIT_ORDER_AMOUNT) {
          limitOrder.stop_loss = rounded;
        }
      } else {
        logger.warn(
          `[contractService] stop_loss ${sl} is on the wrong side of ` +
          `entry ${entryPrice} for ${direction} — omitting`
        );
      }
    }
  }

  if (takeProfitPrice != null) {
    const tp = Number(takeProfitPrice);
    if (Number.isFinite(tp) && tp > 0) {
      const priceDiff = direction === 'BUY' ? (tp - entryPrice) : (entryPrice - tp);
      if (priceDiff > 0) {
        const profitAmount = notional * priceDiff / entryPrice;
        const rounded = Math.round(profitAmount * 100) / 100;
        if (rounded >= MIN_LIMIT_ORDER_AMOUNT) {
          limitOrder.take_profit = rounded;
        }
      } else {
        logger.warn(
          `[contractService] take_profit ${tp} is on the wrong side of ` +
          `entry ${entryPrice} for ${direction} — omitting`
        );
      }
    }
  }

  return limitOrder;
}

// ============================================================
// Persistence
// ============================================================

async function _persist(params) {
  const {
    contractId, symbol, side, stake, multiplier, duration, durationUnit,
    entryPrice, purchasePrice, knockoutLevel, takeProfitLevel, barrier,
    contractType, product, strategy, regimeCode, entryThesis,
  } = params;

  const normalizedSide = _normalizeSide(side);
  const orderSide = normalizedSide;
  const tradeSide = normalizedSide.toLowerCase();

  const stakeNum = Number(stake) || 0;
  const purchasePriceNum = Number(purchasePrice) || null;

  const thesisSnapshot = entryThesis && typeof entryThesis === 'object'
    ? entryThesis
    : null;

  const orderDoc = await Order.create({
    clientOrderId: String(contractId),
    instrument: normalizeSymbol(symbol),
    side: orderSide,
    units: stakeNum,
    status: 'FILLED',
    contractId: String(contractId),

    entryPrice: Number(entryPrice) || null,
    purchasePrice: purchasePriceNum,
    filledPrice: purchasePriceNum,

    placedAt: new Date(),
    filledAt: new Date(),
    duration: duration != null ? parseInt(duration, 10) : null,
    durationUnit: durationUnit || null,

    knockoutLevel: knockoutLevel != null ? Number(knockoutLevel) : null,
    takeProfitLevel: takeProfitLevel != null ? Number(takeProfitLevel) : null,

    stake: stakeNum,
    multiplier: multiplier != null ? Number(multiplier) : null,
    contractType: contractType || null,
    barrier: barrier != null ? String(barrier) : null,
    product: product || null,

    metadata: {
      strategy: strategy || null,
      regimeCode: regimeCode || null,
    },
    entryThesis: thesisSnapshot,
  }).catch(err => {
    logger.error(`[contractService] Order save failed for ${contractId}: ${err.message}`);
    return null;
  });

  const tradeDoc = await Trade.create({
    contractId: String(contractId),
    instrument: normalizeSymbol(symbol),
    side: tradeSide,
    lotSize: stakeNum,
    openPrice: Number(entryPrice) || 0,
    status: 'OPEN',
    openTime: new Date(),

    purchasePrice: purchasePriceNum,
    currentPrice: Number(entryPrice) || null,
    floatingProfit: 0,
    product: product || null,

    strategy: strategy || null,

    stake: stakeNum,
    multiplier: multiplier != null ? Number(multiplier) : null,
    duration: duration != null ? parseInt(duration, 10) : null,
    durationUnit: durationUnit || null,
    knockoutLevel: knockoutLevel != null ? Number(knockoutLevel) : null,
    takeProfitLevel: takeProfitLevel != null ? Number(takeProfitLevel) : null,
    contractType: contractType || null,
    barrier: barrier != null ? String(barrier) : null,

    entryThesis: thesisSnapshot,
  }).catch(err => {
    logger.error(`[contractService] Trade save failed for ${contractId}: ${err.message}`);
    return null;
  });

  return { order: orderDoc, trade: tradeDoc };
}

// ============================================================
// Multiplier contract (FX)
// ============================================================

async function placeMultiplier(params) {
  const {
    symbol, direction, stake, multiplier,
    knockoutLevel = null, takeProfitLevel = null,
    strategy = null, regimeCode = null, entryThesis = null,
  } = params;

  if (!symbol) throw new Error('symbol required');
  if (!direction || (direction !== 'BUY' && direction !== 'SELL')) {
    throw new Error(`direction must be BUY or SELL (got ${direction})`);
  }
  const stakeNum = Number(stake);
  const multNum = Math.floor(Number(multiplier));
  if (!Number.isFinite(stakeNum) || stakeNum <= 0) throw new Error('stake must be positive');
  if (!ACCEPTED_MULTIPLIERS.includes(multNum)) {
    throw new Error(
      `multiplier must be one of ${ACCEPTED_MULTIPLIERS.join(',')} (got ${multiplier})`
    );
  }

  const broker = getBroker('deriv_cfd');
  if (!broker.isConnected()) await broker.connect();

  const derivSymbol = toDerivSymbol(symbol, broker);
  const contractType = direction === 'BUY' ? 'MULTUP' : 'MULTDOWN';

  // Rounded PRICE levels — these are what we persist in the DB.
  const koRounded = roundPrice(symbol, knockoutLevel);
  const tpRounded = roundPrice(symbol, takeProfitLevel);

  // Base proposal params (no limit_order yet)
  const baseProposalParams = {
    amount: stakeNum,
    basis: 'stake',
    contract_type: contractType,
    currency: broker.accountCurrency || 'USD',
    underlying_symbol: derivSymbol,
    multiplier: multNum,
  };

  // [FIX-CS-C1] Convert price levels → currency amounts for Deriv.
  const needLimitOrder = (koRounded != null || tpRounded != null);
  let limitOrderAmounts = {};

  if (needLimitOrder) {
    const referenceEntry = await _resolveReferenceEntry(broker, derivSymbol, baseProposalParams);
    if (referenceEntry != null) {
      limitOrderAmounts = _buildMultiplierLimitOrder(
        stakeNum, multNum, direction, referenceEntry, koRounded, tpRounded
      );
      if (Object.keys(limitOrderAmounts).length > 0) {
        logger.info(
          `[contractService] ${symbol} ${direction}: ` +
          `entry=${referenceEntry} SL=${koRounded}→$${limitOrderAmounts.stop_loss ?? '-'} ` +
          `TP=${tpRounded}→$${limitOrderAmounts.take_profit ?? '-'}`
        );
      } else {
        logger.warn(
          `[contractService] ${symbol} ${direction}: limit_order conversion produced no valid amounts ` +
          `(entry=${referenceEntry}, SL=${koRounded}, TP=${tpRounded}) — proceeding without SL/TP`
        );
      }
    } else {
      logger.warn(
        `[contractService] ${symbol} ${direction}: could not resolve reference entry price ` +
        `— proceeding without SL/TP (OTIE watchdog is the backstop)`
      );
    }
  }

  // Final proposal — with amounts if we have them, without if we don't
  const proposalParams = { ...baseProposalParams };
  if (Object.keys(limitOrderAmounts).length > 0) {
    proposalParams.limit_order = limitOrderAmounts;
  }

  const proposal = await _fetchProposal(broker, proposalParams);

  // [FIX-CS-C3] Pass context so _buyProposal can reconcile on failure.
  const buy = await _buyProposal(broker, proposal, {
    symbol, direction, stake: stakeNum,
  });
  const contractId = String(buy.contract_id);
  if (!contractId || contractId === 'undefined') {
    throw new Error(`Buy returned no contract_id: ${JSON.stringify(buy)}`);
  }

  broker._subscribeOpenContract(contractId).catch(err => {
    logger.warn(`[contractService] Subscribe failed for ${contractId}: ${err.message}`);
  });

  const entryPrice = Number(buy.entry_spot || proposal.spot || 0);
  const purchasePrice = Number(buy.buy_price || proposal.ask_price);

  // Persist: PRICE LEVELS in DB (not the converted amounts)
  const persisted = await _persist({
    contractId, symbol, side: direction, stake: stakeNum, multiplier: multNum,
    duration: null, durationUnit: null,
    entryPrice, purchasePrice,
    knockoutLevel: koRounded, takeProfitLevel: tpRounded,
    contractType, product: 'deriv_multiplier',
    strategy, regimeCode, entryThesis,
  });

  eventBus.emit('order.placed', { contractId, symbol, direction, stake: stakeNum, multiplier: multNum, strategy });
  eventBus.emit('trade.placed', { contractId, symbol, strategy });

  return {
    contractId,
    entryPrice,
    purchasePrice,
    raw: buy,
    order: persisted.order,
    trade: persisted.trade,
  };
}

// ============================================================
// Digital / binary contract (synthetics)
// ============================================================

async function placeDigitOrBinary(params) {
  const {
    symbol, contractType, stake,
    duration, durationUnit = 't',
    barrier = null,
    strategy = null, regimeCode = null, entryThesis = null,
  } = params;

  if (!symbol) throw new Error('symbol required');
  if (!CONTRACT_TYPES[contractType]) {
    throw new Error(`Unknown contract type: ${contractType}. Allowed: ${Object.keys(CONTRACT_TYPES).join(',')}`);
  }
  const stakeNum = Number(stake);
  if (!Number.isFinite(stakeNum) || stakeNum <= 0) throw new Error('stake must be positive');
  const durNum = parseInt(duration, 10);
  if (!Number.isFinite(durNum) || durNum <= 0) throw new Error('duration must be positive');

  const broker = getBroker('deriv_cfd');
  if (!broker.isConnected()) await broker.connect();

  const derivSymbol = toDerivSymbol(symbol, broker);

  const proposalParams = {
    amount: stakeNum,
    basis: 'stake',
    contract_type: contractType,
    currency: broker.accountCurrency || 'USD',
    underlying_symbol: derivSymbol,
    duration: durNum,
    duration_unit: durationUnit,
  };

  if (barrier != null) proposalParams.barrier = String(barrier);

  const proposal = await _fetchProposal(broker, proposalParams);

  // [FIX-CS-C3] Pass context so _buyProposal can reconcile on failure.
  // Side is derived from contractType inside _reconcileBuy.
  const buy = await _buyProposal(broker, proposal, {
    symbol, contractType, stake: stakeNum,
  });
  const contractId = String(buy.contract_id);
  if (!contractId || contractId === 'undefined') {
    throw new Error(`Buy returned no contract_id: ${JSON.stringify(buy)}`);
  }

  broker._subscribeOpenContract(contractId).catch(() => {});

  const entryPrice = Number(buy.entry_spot || proposal.spot || 0);
  const purchasePrice = Number(buy.buy_price || proposal.ask_price);

  const persisted = await _persist({
    contractId, symbol, side: contractType, stake: stakeNum, multiplier: null,
    duration: durNum, durationUnit, entryPrice, purchasePrice,
    knockoutLevel: null, takeProfitLevel: null,
    barrier, contractType, product: 'deriv_digital',
    strategy, regimeCode,
    entryThesis: { ...(entryThesis || {}), contractType, barrier },
  });

  eventBus.emit('order.placed', { contractId, symbol, contractType, stake: stakeNum, strategy });
  eventBus.emit('trade.placed', { contractId, symbol, strategy });

  return {
    contractId,
    entryPrice,
    purchasePrice,
    raw: buy,
    order: persisted.order,
    trade: persisted.trade,
  };
}

async function placeContract(params) {
  if (params.multiplier != null) return placeMultiplier(params);
  if (params.contractType) return placeDigitOrBinary(params);
  throw new Error('placeContract requires either multiplier or contractType');
}

// [FIX-CS-C3] Expose reconcile metrics for health checks / dashboards.
function getStats() {
  return {
    reconcile: {
      attempts: _reconcileMetrics.attempts,
      recovered: _reconcileMetrics.recovered,
      lastRecoveredAt: _reconcileMetrics.lastRecoveredAt,
      lastOriginalError: _reconcileMetrics.lastOriginalError,
    },
  };
}

module.exports = {
  CONTRACT_TYPES,
  ACCEPTED_MULTIPLIERS,
  DEFAULT_MULTIPLIER,
  placeContract,
  placeMultiplier,
  placeDigitOrBinary,
  roundPrice,
  getStats,
  _fetchProposal,
  _buyProposal,
  // [FIX-CS-C1] exposed for testing
  _buildMultiplierLimitOrder,
  _resolveReferenceEntry,
  // [FIX-CS-C3] exposed for testing
  _reconcileBuy,
};
