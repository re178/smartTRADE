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

// Deriv's current allowed multiplier set. Any value outside this is rejected
// by the proposal API. Update here if Deriv changes their policy again.
const ACCEPTED_MULTIPLIERS = [200, 400, 600, 800];
const DEFAULT_MULTIPLIER = 200;

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

/**
 * Map a symbol to the Deriv symbol used in API calls.
 * Synthetic indices (R_10, 1HZ100V, etc.) are passed through unchanged.
 */
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

/**
 * Fetch a proposal from Deriv.
 */
async function _fetchProposal(broker, params) {
  const resp = await broker._sendAuthRequest({ proposal: 1, ...params }, 15000);
  const proposal = resp && resp.proposal;
  if (!proposal || !proposal.id) {
    throw new Error(`Proposal failed: ${JSON.stringify(resp && resp.error || resp)}`);
  }
  return proposal;
}

/**
 * Buy a proposal by id.
 */
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
 * Persist Order + Trade documents for a confirmed contract.
 */
async function _persist(params) {
  const {
    contractId, symbol, side, stake, multiplier, duration, durationUnit,
    entryPrice, purchasePrice, knockoutLevel, takeProfitLevel, barrier,
    contractType, product, strategy, regimeCode, entryThesis,
  } = params;

  const orderDoc = await Order.create({
    contractId,
    instrument: normalizeSymbol(symbol),
    side,
    stake: Number(stake) || 0,
    multiplier: multiplier != null ? Number(multiplier) : null,
    status: 'FILLED',
    product,
    filledPrice: Number(purchasePrice) || null,
    placedAt: new Date(),
    duration: duration != null ? parseInt(duration, 10) : null,
    durationUnit: durationUnit || null,
    knockoutLevel: knockoutLevel != null ? Number(knockoutLevel) : null,
    takeProfitLevel: takeProfitLevel != null ? Number(takeProfitLevel) : null,
    barrier: barrier != null ? String(barrier) : null,
    contractType: contractType || null,
    metadata: { strategy: strategy || null, regimeCode: regimeCode || null },
  }).catch(err => {
    logger.error(`[contractService] Order save failed for ${contractId}: ${err.message}`);
    return null;
  });

  const tradeDoc = await Trade.create({
    contractId,
    instrument: normalizeSymbol(symbol),
    side: String(side || '').toLowerCase(),
    lotSize: Number(stake) || 0,
    stake: Number(stake) || 0,
    multiplier: multiplier != null ? Number(multiplier) : null,
    status: 'OPEN',
    openTime: new Date(),
    openPrice: Number(entryPrice) || null,
    purchasePrice: Number(purchasePrice) || null,
    currentPrice: Number(entryPrice) || null,
    floatingProfit: 0,
    product,
    strategy: strategy || null,
    entryThesis: entryThesis || null,
    knockoutLevel: knockoutLevel != null ? Number(knockoutLevel) : null,
    takeProfitLevel: takeProfitLevel != null ? Number(takeProfitLevel) : null,
    duration: duration != null ? parseInt(duration, 10) : null,
    durationUnit: durationUnit || null,
    contractType: contractType || null,
    barrier: barrier != null ? String(barrier) : null,
  }).catch(err => {
    logger.error(`[contractService] Trade save failed for ${contractId}: ${err.message}`);
    return null;
  });

  return { order: orderDoc, trade: tradeDoc };
}

/**
 * Place a Multiplier contract (MULTUP / MULTDOWN).
 * FX trades use this.
 *
 * IMPORTANT: Do NOT send duration / duration_unit. Deriv multiplier contracts
 * exit on limit_order barrier hit (knockout / takeProfit) or manual close.
 * Sending duration_unit: 's' triggers InvalidExpiry — this was blocking every
 * FX bot entry since the system started.
 */
async function placeMultiplier(params) {
  const {
    symbol, direction, stake, multiplier,
    knockoutLevel = null, takeProfitLevel = null,
    // duration, durationUnit are INTENTIONALLY ignored for multipliers — see above
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

  // No duration / duration_unit — multiplier contracts do not use them.
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
 * Place a Digital or Rise/Fall or Touch contract.
 * Synthetics only. These DO use duration (in ticks or seconds).
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

/**
 * Universal entry — dispatches by contract class.
 */
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
