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
//              and entryThesis on BOTH Order and Trade. All five fields now
//              exist in the schemas (Files 2 & 3), and populating them means
//              digit/binary trades can be fully reconstructed from the DB
//              without depending on the running bot instance.

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

// Deriv's current allowed multiplier set.
const ACCEPTED_MULTIPLIERS = [200, 400, 600, 800];
const DEFAULT_MULTIPLIER = 200;

// [FIX-DIGIT-PERSIST] Map a Deriv contract type to its semantic direction.
// "Positive bet" contracts profit when the underlying goes UP or when a
// statistical event (EVEN/MATCH/OVER/ONETOUCH) occurs.
// "Negative bet" contracts profit when the underlying goes DOWN or when the
// complementary event (ODD/DIFF/UNDER/NOTOUCH) occurs.
//
// This mapping lets us store a clean buy/sell side while keeping the
// specific contract type in the contractType field.
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

function _normalizeSide(contractTypeOrSide) {
  if (!contractTypeOrSide) return 'BUY';
  const upper = String(contractTypeOrSide).toUpperCase();
  if (upper === 'BUY' || upper === 'SELL') return upper;
  if (SIDE_BUY_TYPES.has(upper)) return 'BUY';
  if (SIDE_SELL_TYPES.has(upper)) return 'SELL';
  // Unknown contract type — default to BUY so save doesn't fail.
  return 'BUY';
}

function normalizeSymbol(s) {
  if (!s) return '';
  return String(s).replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
}

// ── Per-symbol price precision (mirrors core/bots/registry.js) ──
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

async function _buyProposal(broker, proposal) {
  const askPrice = Number(proposal.ask_price);
  if (!Number.isFinite(askPrice) || askPrice <= 0) {
    throw new Error(`Invalid ask price: ${proposal.ask_price}`);
  }
  const resp = await broker._sendAuthRequest({ buy: proposal.id, price: askPrice }, 15000);
  const buy = resp && resp.buy;
  if (!buy || !buy.contract_id) {
    throw new Error(`Buy failed: ${JSON.stringify(resp && resp.error || resp)}`);
  }
  return buy;
}

/**
 * [FIX-DIGIT-PERSIST] Persist Order + Trade documents for a confirmed contract.
 * Both sides populated with all fields required by their schemas.
 * Errors on either write are logged but never re-thrown — the contract is
 * already live at Deriv; the caller's job is to confirm the buy, not the DB.
 */
async function _persist(params) {
  const {
    contractId, symbol, side, stake, multiplier, duration, durationUnit,
    entryPrice, purchasePrice, knockoutLevel, takeProfitLevel, barrier,
    contractType, product, strategy, regimeCode, entryThesis,
  } = params;

  // [FIX-DIGIT-PERSIST] Normalize side once for both schemas.
  // Order.side = 'BUY'|'SELL' (uppercase enum).
  // Trade.side = 'buy'|'sell' (lowercase enum).
  const normalizedSide = _normalizeSide(side);
  const orderSide = normalizedSide;                       // 'BUY' | 'SELL'
  const tradeSide = normalizedSide.toLowerCase();          // 'buy' | 'sell'

  const stakeNum = Number(stake) || 0;
  const purchasePriceNum = Number(purchasePrice) || null;

  // [FIX-DIGIT-PERSIST] Build the entryThesis snapshot ONCE, reused by both.
  const thesisSnapshot = entryThesis && typeof entryThesis === 'object'
    ? entryThesis
    : null;

  // ── Order document ─────────────────────────────────────────
  const orderDoc = await Order.create({
    // Required fields the schema enforces
    clientOrderId: String(contractId),           // Order.clientOrderId is required + unique
    instrument: normalizeSymbol(symbol),
    side: orderSide,
    units: stakeNum,                             // Order.units is required
    status: 'FILLED',
    contractId: String(contractId),

    // Cost / price
    entryPrice: Number(entryPrice) || null,
    purchasePrice: purchasePriceNum,
    filledPrice: purchasePriceNum,               // pre-save hook keeps them in sync

    // Timing
    placedAt: new Date(),
    filledAt: new Date(),
    duration: duration != null ? parseInt(duration, 10) : null,
    durationUnit: durationUnit || null,

    // Levels
    knockoutLevel: knockoutLevel != null ? Number(knockoutLevel) : null,
    takeProfitLevel: takeProfitLevel != null ? Number(takeProfitLevel) : null,

    // Multiplier / digit specific
    stake: stakeNum,
    multiplier: multiplier != null ? Number(multiplier) : null,
    contractType: contractType || null,
    barrier: barrier != null ? String(barrier) : null,
    product: product || null,

    // Metadata / thesis
    metadata: {
      strategy: strategy || null,
      regimeCode: regimeCode || null,
    },
    entryThesis: thesisSnapshot,
  }).catch(err => {
    logger.error(`[contractService] Order save failed for ${contractId}: ${err.message}`);
    return null;
  });

  // ── Trade document ─────────────────────────────────────────
  const tradeDoc = await Trade.create({
    // Required fields the schema enforces
    contractId: String(contractId),
    instrument: normalizeSymbol(symbol),
    side: tradeSide,
    lotSize: stakeNum,                           // Trade.lotSize is required
    openPrice: Number(entryPrice) || 0,          // Trade.openPrice is required
    status: 'OPEN',
    openTime: new Date(),

    // Cost / price
    purchasePrice: purchasePriceNum,
    currentPrice: Number(entryPrice) || null,
    floatingProfit: 0,
    product: product || null,

    // Linkage
    strategy: strategy || null,

    // Multiplier / digit specific
    stake: stakeNum,
    multiplier: multiplier != null ? Number(multiplier) : null,
    duration: duration != null ? parseInt(duration, 10) : null,
    durationUnit: durationUnit || null,
    knockoutLevel: knockoutLevel != null ? Number(knockoutLevel) : null,
    takeProfitLevel: takeProfitLevel != null ? Number(takeProfitLevel) : null,
    contractType: contractType || null,
    barrier: barrier != null ? String(barrier) : null,

    // Full thesis snapshot (now Mixed in the schema — File 2)
    entryThesis: thesisSnapshot,
  }).catch(err => {
    logger.error(`[contractService] Trade save failed for ${contractId}: ${err.message}`);
    return null;
  });

  return { order: orderDoc, trade: tradeDoc };
}

/**
 * Place a Multiplier contract (MULTUP / MULTDOWN).
 * FX trades use this.
 */
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

  const proposalParams = {
    amount: stakeNum,
    basis: 'stake',
    contract_type: contractType,
    currency: broker.accountCurrency || 'USD',
    underlying_symbol: derivSymbol,
    multiplier: multNum,
  };

  if (koRounded != null || tpRounded != null) {
    proposalParams.limit_order = {};
    if (koRounded != null) proposalParams.limit_order.stop_loss = koRounded;
    if (tpRounded != null) proposalParams.limit_order.take_profit = tpRounded;
  }

  const proposal = await _fetchProposal(broker, proposalParams);
  const buy = await _buyProposal(broker, proposal);
  const contractId = String(buy.contract_id);

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

/**
 * Place a Digital or Rise/Fall or Touch contract. Synthetics only.
 */
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
  const buy = await _buyProposal(broker, proposal);
  const contractId = String(buy.contract_id);

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

module.exports = {
  CONTRACT_TYPES,
  ACCEPTED_MULTIPLIERS,
  DEFAULT_MULTIPLIER,
  placeContract,
  placeMultiplier,
  placeDigitOrBinary,
  roundPrice,
  _fetchProposal,
  _buyProposal,
};
