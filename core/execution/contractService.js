// core/execution/contractService.js
// Generic contract placement for all Deriv contract classes:
//   • Multiplier (MULTUP / MULTDOWN)         — FX pairs
//   • Digital (DIGITEVEN/ODD/OVER/UNDER/...) — Synthetic indices
//   • Binary (CALL/PUT/ONETOUCH/NOTOUCH)     — Synthetic indices
//   • Touch/No Touch (ONETOUCH/NOTOUCH)      — [FIX-HIGH-PAYOUT]
//   • Vanilla (VANILLALONGCALL/PUT)          — [FIX-HIGH-PAYOUT]
//   • Turbo (TURBOSLONG/SHORT)               — [FIX-HIGH-PAYOUT]
//   • Accumulator (ACCU)                     — [FIX-HIGH-PAYOUT]
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
//
// [FIX-HIGH-PAYOUT] **Four new contract classes for high-payout bots.**
//             Adds placement functions for the four Deriv contract types
//             that pay significantly more than fixed-payout digit/CALL-PUT
//             contracts:
//
//               • Touch/No Touch (ONETOUCH / NOTOUCH)
//                   Payout = fixed, but barrier-dependent. Far barriers
//                   (2 ATR+) pay 200–350%+. Used by touch_hunter bot.
//                   Requires: barrier (relative string "+X.XX" / "-X.XX")
//
//               • Vanilla (VANILLALONGCALL / VANILLALONGPUT)
//                   Payout = payout_per_point × (final − strike). Uncapped.
//                   Used by vanilla_trend bot. Requires: barrier (strike,
//                   relative string; "+0.00" = at-the-money).
//
//               • Turbo (TURBOSLONG / TURBOSSHORT)
//                   Payout = payout_per_point × distance from barrier.
//                   Knockout if barrier breached. Used by turbo_breakout.
//                   Requires: barrier (relative), optional take_profit.
//
//               • Accumulator (ACCU)
//                   Payout compounds at growth_rate per tick while price
//                   stays in range. 5% × 30 ticks ≈ 4.3× stake.
//                   Used by accumulator_scalper. Requires: growth_rate
//                   (0.01–0.05), duration in ticks.
//
//             All four reuse _buyProposal (reconcile) and _persist (Order +
//             Trade docs). The new metadata fields (payoutPerPoint, growthRate,
//             strikePrice, touchBarrier, touchDirection) are returned in the
//             result object so runner._persistBotRun can record them on
//             BotRun. Mongoose silently ignores unknown fields on Trade/Order
//             schemas, so _persist needs no schema migration.
//
//             _checkContractAvailability caches contracts_for per symbol for
//             5 minutes and throws a clear error if the requested type is
//             not offered on that symbol (e.g. Vanilla on EURUSD requires
//             1-day minimum duration in some regions).

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

// [FIX-HIGH-PAYOUT] Contract availability cache (5 min TTL per symbol).
const CONTRACT_AVAILABILITY_TTL_MS = 5 * 60_000;
const _contractAvailabilityCache = new Map();  // symbol → { types, at }

const SIDE_BUY_TYPES = new Set([
  'MULTUP', 'CALL',
  'DIGITEVEN', 'DIGITOVER', 'DIGITMATCH',
  'ONETOUCH',
  'VANILLALONGCALL',
  'TURBOSLONG',
  'ACCU',
]);
const SIDE_SELL_TYPES = new Set([
  'MULTDOWN', 'PUT',
  'DIGITODD', 'DIGITUNDER', 'DIGITDIFF',
  'NOTOUCH',
  'VANILLALONGPUT',
  'TURBOSSHORT',
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
// [FIX-HIGH-PAYOUT] Contract availability check
// ============================================================
/**
 * Query contracts_for once per symbol (5-min cache) and confirm the
 * requested contract type is available.
 *
 * Throws a clear error if not available — the runner will surface it
 * as instance.lastReason and skip the entry cleanly.
 */
async function _checkContractAvailability(broker, derivSymbol, contractType) {
  const now = Date.now();
  const cached = _contractAvailabilityCache.get(derivSymbol);

  if (cached && (now - cached.at) < CONTRACT_AVAILABILITY_TTL_MS) {
    if (!cached.types.has(contractType)) {
      throw new Error(
        `Contract type ${contractType} not available on ${derivSymbol} ` +
        `(cached). Available: ${Array.from(cached.types).slice(0, 8).join(', ')}...`
      );
    }
    return true;
  }

  let resp;
  try {
    resp = await broker._sendPublicRequest({ contracts_for: derivSymbol }, 10000);
  } catch (err) {
    logger.warn(
      `[contractService] contracts_for(${derivSymbol}) failed: ${err.message} — ` +
      `skipping availability check for ${contractType}`
    );
    return true;  // fail-open: let proposal surface the real error
  }

  const contracts = (resp && resp.contracts_for && resp.contracts_for.available) || [];
  const types = new Set();
  for (const c of contracts) {
    if (c.contract_type) types.add(c.contract_type);
    // Some entries list contract_category; check both
    if (c.contract_category) types.add(c.contract_category);
  }

  _contractAvailabilityCache.set(derivSymbol, { types, at: now });

  if (!types.has(contractType)) {
    throw new Error(
      `Contract type ${contractType} not available on ${derivSymbol}. ` +
      `Available: ${Array.from(types).slice(0, 12).join(', ')}` +
      (types.size > 12 ? '...' : '')
    );
  }

  return true;
}

// ============================================================
// [FIX-CS-C3] Buy + reconcile
// ============================================================
async function _reconcileBuy(broker, context, submittedAt) {
  _reconcileMetrics.attempts++;

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

  candidates.sort((a, b) => (b.openTime || 0) - (a.openTime || 0));
  const match = candidates[0];

  _reconcileMetrics.recovered++;
  _reconcileMetrics.lastRecoveredAt = new Date().toISOString();

  logger.warn(
    `[contractService] _reconcileBuy: RECOVERED contract ${match.id} ` +
    `for ${context.symbol} ${expectedSide} stake=${stakeNum} ` +
    `(original error: ${_reconcileMetrics.lastOriginalError || 'unknown'})`
  );

  return {
    contract_id: match.id,
    buy_price: match.purchasePrice,
    entry_spot: match.entryPrice,
    _reconciled: true,
  };
}

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

    throw buyErr;
  }
}

// ============================================================
// [FIX-CS-C1] Multiplier limit_order conversion
// ============================================================
async function _resolveReferenceEntry(broker, derivSymbol, baseProposalParams) {
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
    // [FIX-HIGH-PAYOUT] new metadata fields
    payoutPerPoint, growthRate, strikePrice, touchBarrier, touchDirection,
  } = params;

  const normalizedSide = _normalizeSide(side);
  const orderSide = normalizedSide;
  const tradeSide = normalizedSide.toLowerCase();

  const stakeNum = Number(stake) || 0;
  const purchasePriceNum = Number(purchasePrice) || null;

  const thesisSnapshot = entryThesis && typeof entryThesis === 'object'
    ? entryThesis
    : null;

  // Mongoose silently ignores fields not in the Order/Trade schemas, so
  // passing the new fields is safe (they're preserved in the return object).
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

  // [FIX-HIGH-PAYOUT] Return the raw metadata so the caller (runner) can
  // pass it to BotRun. Mongoose ignores unknown fields above, so we
  // re-include them here explicitly.
  return {
    order: orderDoc,
    trade: tradeDoc,
    _metadata: {
      payoutPerPoint: payoutPerPoint != null ? Number(payoutPerPoint) : null,
      growthRate: growthRate != null ? Number(growthRate) : null,
      strikePrice: strikePrice != null ? Number(strikePrice) : null,
      touchBarrier: touchBarrier != null ? Number(touchBarrier) : null,
      touchDirection: touchDirection || null,
    },
  };
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

  const koRounded = roundPrice(symbol, knockoutLevel);
  const tpRounded = roundPrice(symbol, takeProfitLevel);

  const baseProposalParams = {
    amount: stakeNum,
    basis: 'stake',
    contract_type: contractType,
    currency: broker.accountCurrency || 'USD',
    underlying_symbol: derivSymbol,
    multiplier: multNum,
  };

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

  const proposalParams = { ...baseProposalParams };
  if (Object.keys(limitOrderAmounts).length > 0) {
    proposalParams.limit_order = limitOrderAmounts;
  }

  const proposal = await _fetchProposal(broker, proposalParams);

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

// ============================================================
// [FIX-HIGH-PAYOUT] Touch/No Touch contract
// ============================================================
async function placeTouchContract(params) {
  const {
    symbol, touchDirection, barrier, stake,
    duration, durationUnit = 'm',
    strategy = null, regimeCode = null, entryThesis = null,
  } = params;

  if (!symbol) throw new Error('symbol required');
  if (touchDirection !== 'TOUCH' && touchDirection !== 'NO_TOUCH') {
    throw new Error(`touchDirection must be TOUCH or NO_TOUCH (got ${touchDirection})`);
  }
  if (!barrier || typeof barrier !== 'string' || !/^[+-]/.test(barrier)) {
    throw new Error(
      `barrier must be a relative string starting with +/- (e.g. "+12.50"). Got: ${barrier}`
    );
  }
  const stakeNum = Number(stake);
  if (!Number.isFinite(stakeNum) || stakeNum <= 0) throw new Error('stake must be positive');
  const durNum = parseInt(duration, 10);
  if (!Number.isFinite(durNum) || durNum <= 0) throw new Error('duration must be positive');

  const broker = getBroker('deriv_cfd');
  if (!broker.isConnected()) await broker.connect();

  const derivSymbol = toDerivSymbol(symbol, broker);
  const contractType = touchDirection === 'TOUCH' ? 'ONETOUCH' : 'NOTOUCH';

  await _checkContractAvailability(broker, derivSymbol, contractType);

  const proposalParams = {
    amount: stakeNum,
    basis: 'stake',
    contract_type: contractType,
    currency: broker.accountCurrency || 'USD',
    underlying_symbol: derivSymbol,
    barrier: String(barrier),
    duration: durNum,
    duration_unit: durationUnit,
  };

  const proposal = await _fetchProposal(broker, proposalParams);

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
  // Barrier is relative; compute the absolute touch price for logging/BotRun.
  const touchBarrierAbs = roundPrice(symbol, entryPrice + Number(barrier));

  logger.info(
    `[contractService] ${symbol} ${contractType} placed: ` +
    `entry=${entryPrice} barrier=${barrier} (abs=${touchBarrierAbs}) ` +
    `stake=$${stakeNum} dur=${durNum}${durationUnit} ` +
    `payout=${proposal.payout || '?'}`
  );

  const persisted = await _persist({
    contractId, symbol, side: contractType, stake: stakeNum, multiplier: null,
    duration: durNum, durationUnit, entryPrice, purchasePrice,
    knockoutLevel: null, takeProfitLevel: null,
    barrier, contractType, product: 'deriv_touch',
    strategy, regimeCode,
    entryThesis: { ...(entryThesis || {}), contractType, barrier, touchDirection },
    touchBarrier: touchBarrierAbs,
    touchDirection: touchDirection === 'TOUCH' ? 'TOUCH' : 'NO_TOUCH',
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
    metadata: {
      touchBarrier: touchBarrierAbs,
      touchDirection,
      barrier,
    },
  };
}

// ============================================================
// [FIX-HIGH-PAYOUT] Vanilla Call/Put contract
// ============================================================
async function placeVanillaContract(params) {
  const {
    symbol, direction, barrier = '+0.00', stake,
    duration, durationUnit = 'm',
    strategy = null, regimeCode = null, entryThesis = null,
  } = params;

  if (!symbol) throw new Error('symbol required');
  if (!direction || (direction !== 'BUY' && direction !== 'SELL')) {
    throw new Error(`direction must be BUY or SELL (got ${direction})`);
  }
  if (typeof barrier !== 'string' || !/^[+-]/.test(barrier)) {
    throw new Error(
      `barrier must be a relative string starting with +/- (e.g. "+0.00" for ATM). Got: ${barrier}`
    );
  }
  const stakeNum = Number(stake);
  if (!Number.isFinite(stakeNum) || stakeNum <= 0) throw new Error('stake must be positive');
  const durNum = parseInt(duration, 10);
  if (!Number.isFinite(durNum) || durNum <= 0) throw new Error('duration must be positive');

  const broker = getBroker('deriv_cfd');
  if (!broker.isConnected()) await broker.connect();

  const derivSymbol = toDerivSymbol(symbol, broker);
  const contractType = direction === 'BUY' ? 'VANILLALONGCALL' : 'VANILLALONGPUT';

  await _checkContractAvailability(broker, derivSymbol, contractType);

  const proposalParams = {
    amount: stakeNum,
    basis: 'stake',
    contract_type: contractType,
    currency: broker.accountCurrency || 'USD',
    underlying_symbol: derivSymbol,
    barrier: String(barrier),
    duration: durNum,
    duration_unit: durationUnit,
  };

  const proposal = await _fetchProposal(broker, proposalParams);

  const buy = await _buyProposal(broker, proposal, {
    symbol, direction, stake: stakeNum,
  });
  const contractId = String(buy.contract_id);
  if (!contractId || contractId === 'undefined') {
    throw new Error(`Buy returned no contract_id: ${JSON.stringify(buy)}`);
  }

  broker._subscribeOpenContract(contractId).catch(() => {});

  const entryPrice = Number(buy.entry_spot || proposal.spot || 0);
  const purchasePrice = Number(buy.buy_price || proposal.ask_price);
  const strikeAbs = roundPrice(symbol, entryPrice + Number(barrier));
  const payoutPerPoint = Number(proposal.payout_per_point || 0) || null;

  logger.info(
    `[contractService] ${symbol} ${contractType} placed: ` +
    `entry=${entryPrice} strike=${barrier} (abs=${strikeAbs}) ` +
    `stake=$${stakeNum} dur=${durNum}${durationUnit} ` +
    `payout_per_point=${payoutPerPoint || '?'}`
  );

  const persisted = await _persist({
    contractId, symbol, side: direction, stake: stakeNum, multiplier: null,
    duration: durNum, durationUnit, entryPrice, purchasePrice,
    knockoutLevel: null, takeProfitLevel: null,
    barrier, contractType, product: 'deriv_vanilla',
    strategy, regimeCode,
    entryThesis: { ...(entryThesis || {}), contractType, barrier },
    strikePrice: strikeAbs,
    payoutPerPoint,
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
    metadata: {
      strikePrice: strikeAbs,
      barrier,
      payoutPerPoint,
    },
  };
}

// ============================================================
// [FIX-HIGH-PAYOUT] Turbo Long/Short contract
// ============================================================
async function placeTurboContract(params) {
  const {
    symbol, direction, barrier, stake,
    duration, durationUnit = 'm',
    takeProfit = null,     // optional currency amount (e.g. 150 = $150 TP)
    strategy = null, regimeCode = null, entryThesis = null,
  } = params;

  if (!symbol) throw new Error('symbol required');
  if (!direction || (direction !== 'BUY' && direction !== 'SELL')) {
    throw new Error(`direction must be BUY or SELL (got ${direction})`);
  }
  if (typeof barrier !== 'string' || !/^[+-]/.test(barrier)) {
    throw new Error(
      `barrier must be a relative string starting with +/-. Got: ${barrier}`
    );
  }
  const stakeNum = Number(stake);
  if (!Number.isFinite(stakeNum) || stakeNum <= 0) throw new Error('stake must be positive');
  const durNum = parseInt(duration, 10);
  if (!Number.isFinite(durNum) || durNum <= 0) throw new Error('duration must be positive');

  const broker = getBroker('deriv_cfd');
  if (!broker.isConnected()) await broker.connect();

  const derivSymbol = toDerivSymbol(symbol, broker);
  const contractType = direction === 'BUY' ? 'TURBOSLONG' : 'TURBOSSHORT';

  await _checkContractAvailability(broker, derivSymbol, contractType);

  const proposalParams = {
    amount: stakeNum,
    basis: 'stake',
    contract_type: contractType,
    currency: broker.accountCurrency || 'USD',
    underlying_symbol: derivSymbol,
    barrier: String(barrier),
    duration: durNum,
    duration_unit: durationUnit,
  };

  if (takeProfit != null && Number(takeProfit) > 0) {
    proposalParams.limit_order = { take_profit: Number(takeProfit) };
  }

  const proposal = await _fetchProposal(broker, proposalParams);

  const buy = await _buyProposal(broker, proposal, {
    symbol, direction, stake: stakeNum,
  });
  const contractId = String(buy.contract_id);
  if (!contractId || contractId === 'undefined') {
    throw new Error(`Buy returned no contract_id: ${JSON.stringify(buy)}`);
  }

  broker._subscribeOpenContract(contractId).catch(() => {});

  const entryPrice = Number(buy.entry_spot || proposal.spot || 0);
  const purchasePrice = Number(buy.buy_price || proposal.ask_price);
  const strikeAbs = roundPrice(symbol, entryPrice + Number(barrier));
  const payoutPerPoint = Number(proposal.payout_per_point || 0) || null;

  logger.info(
    `[contractService] ${symbol} ${contractType} placed: ` +
    `entry=${entryPrice} barrier=${barrier} (abs=${strikeAbs}) ` +
    `stake=$${stakeNum} dur=${durNum}${durationUnit} ` +
    `payout_per_point=${payoutPerPoint || '?'}` +
    (takeProfit != null ? ` TP=$${takeProfit}` : '')
  );

  const persisted = await _persist({
    contractId, symbol, side: direction, stake: stakeNum, multiplier: null,
    duration: durNum, durationUnit, entryPrice, purchasePrice,
    knockoutLevel: strikeAbs, takeProfitLevel: null,
    barrier, contractType, product: 'deriv_turbo',
    strategy, regimeCode,
    entryThesis: { ...(entryThesis || {}), contractType, barrier },
    strikePrice: strikeAbs,
    payoutPerPoint,
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
    metadata: {
      strikePrice: strikeAbs,
      barrier,
      payoutPerPoint,
    },
  };
}

// ============================================================
// [FIX-HIGH-PAYOUT] Accumulator contract
// ============================================================
async function placeAccumulatorContract(params) {
  const {
    symbol, stake,
    growthRate = 0.03,     // 0.01–0.05 (1%–5%)
    duration = 30,         // ticks
    takeProfit = null,     // optional currency amount
    strategy = null, regimeCode = null, entryThesis = null,
  } = params;

  if (!symbol) throw new Error('symbol required');
  const stakeNum = Number(stake);
  if (!Number.isFinite(stakeNum) || stakeNum <= 0) throw new Error('stake must be positive');
  const gr = Number(growthRate);
  if (!Number.isFinite(gr) || gr < 0.01 || gr > 0.05) {
    throw new Error(
      `growthRate must be between 0.01 (1%) and 0.05 (5%). Got: ${growthRate}`
    );
  }
  const durNum = parseInt(duration, 10);
  if (!Number.isFinite(durNum) || durNum <= 0) throw new Error('duration (ticks) must be positive');

  const broker = getBroker('deriv_cfd');
  if (!broker.isConnected()) await broker.connect();

  const derivSymbol = toDerivSymbol(symbol, broker);
  const contractType = 'ACCU';

  await _checkContractAvailability(broker, derivSymbol, contractType);

  const proposalParams = {
    amount: stakeNum,
    basis: 'stake',
    contract_type: contractType,
    currency: broker.accountCurrency || 'USD',
    underlying_symbol: derivSymbol,
    growth_rate: gr,
    duration: durNum,
    duration_unit: 't',
  };

  if (takeProfit != null && Number(takeProfit) > 0) {
    proposalParams.limit_order = { take_profit: Number(takeProfit) };
  }

  const proposal = await _fetchProposal(broker, proposalParams);

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

  logger.info(
    `[contractService] ${symbol} ACCU placed: ` +
    `entry=${entryPrice} stake=$${stakeNum} ` +
    `growth=${(gr * 100).toFixed(1)}% dur=${durNum}t` +
    (takeProfit != null ? ` TP=$${takeProfit}` : '') +
    ` (max payout at full run ≈ $${(stakeNum * Math.pow(1 + gr, durNum)).toFixed(2)})`
  );

  const persisted = await _persist({
    contractId, symbol, side: 'ACCU', stake: stakeNum, multiplier: null,
    duration: durNum, durationUnit: 't', entryPrice, purchasePrice,
    knockoutLevel: null, takeProfitLevel: takeProfit != null ? Number(takeProfit) : null,
    barrier: null, contractType, product: 'deriv_accumulator',
    strategy, regimeCode,
    entryThesis: { ...(entryThesis || {}), contractType, growthRate: gr },
    growthRate: gr,
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
    metadata: {
      growthRate: gr,
      durationTicks: durNum,
    },
  };
}

// ============================================================
// Router
// ============================================================
async function placeContract(params) {
  // [FIX-HIGH-PAYOUT] New contract classes — checked BEFORE placeDigitOrBinary
  // so ONETOUCH/NOTOUCH/VANILLA/TURBO/ACCU don't fall through to the digit
  // handler (which would reject them as unknown CONTRACT_TYPES).
  const ct = String(params.contractType || '').toUpperCase();

  if (params.contractClass === 'touch' || ct === 'ONETOUCH' || ct === 'NOTOUCH') {
    return placeTouchContract(params);
  }
  if (params.contractClass === 'vanilla' || ct === 'VANILLALONGCALL' || ct === 'VANILLALONGPUT') {
    return placeVanillaContract(params);
  }
  if (params.contractClass === 'turbo' || ct === 'TURBOSLONG' || ct === 'TURBOSSHORT') {
    return placeTurboContract(params);
  }
  if (params.contractClass === 'accumulator' || ct === 'ACCU') {
    return placeAccumulatorContract(params);
  }

  // Existing classes — unchanged
  if (params.multiplier != null) return placeMultiplier(params);
  if (params.contractType) return placeDigitOrBinary(params);
  throw new Error('placeContract requires multiplier, contractType, or contractClass');
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
    contractAvailabilityCacheSize: _contractAvailabilityCache.size,
  };
}

module.exports = {
  CONTRACT_TYPES,
  ACCEPTED_MULTIPLIERS,
  DEFAULT_MULTIPLIER,
  placeContract,
  placeMultiplier,
  placeDigitOrBinary,
  // [FIX-HIGH-PAYOUT] new placement functions
  placeTouchContract,
  placeVanillaContract,
  placeTurboContract,
  placeAccumulatorContract,
  roundPrice,
  getStats,
  _fetchProposal,
  _buyProposal,
  _buildMultiplierLimitOrder,
  _resolveReferenceEntry,
  _reconcileBuy,
  // [FIX-HIGH-PAYOUT] exposed for tests
  _checkContractAvailability,
};
