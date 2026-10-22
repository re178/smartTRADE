// core/risk/riskEngine.js – Risk Gate for Multiplier Trade Execution
//
// [FILE-7A] validateTrade(params) → { approved, reason, message }
//   Exact interface match with opportunityEngine.evaluate(). Old
//   interface mismatch returned { allowed } instead of { approved },
//   which caused every trade to be rejected because
//   `!riskCheck.approved` is always true when approved is undefined.
// [FILE-7B] Real daily P&L from Trade collection (cached 60s).
// [FILE-7C] Correlation groups for FX pairs.
// [FILE-7D] Duplicate trade detection (5min window).
// [FILE-7E] Exposure cap (20% total, 5% single trade).
// [FILE-7F] Max concurrent positions (3).
// [FILE-7G] Structural sanity checks on knockout/take-profit levels.
// [FILE-7H] Every limit configurable via env.
// [FILE-7I] canOpenTrade() alias for backward compatibility.
// [FILE-7J] getState() for dashboards.

const Trade = require('../../models/Trade');
const logger = require('../../infrastructure/logger') || console;

// ---- Configuration ----
const CONFIG = {
  maxOpenPositions: parseInt(process.env.RISK_MAX_OPEN_POSITIONS) || 3,
  maxStakeRatio: parseFloat(process.env.RISK_MAX_STAKE_RATIO) || 0.05,     // 5% of balance per trade
  maxTotalExposureRatio: parseFloat(process.env.RISK_MAX_EXPOSURE_RATIO) || 0.20, // 20% of balance total
  minStake: parseFloat(process.env.RISK_MIN_STAKE) || 0.50,
  dailyLossLimitRatio: parseFloat(process.env.RISK_DAILY_LOSS_RATIO) || 0.05, // 5% of balance
  duplicateWindowMs: parseInt(process.env.RISK_DUPLICATE_WINDOW_MS) || 5 * 60 * 1000,
  minRiskRewardRatio: parseFloat(process.env.RISK_MIN_RR) || 0.5,
  maxPipsSpread: parseFloat(process.env.RISK_MAX_SPREAD_PIPS) || 3.0,
};

// ---- Correlation groups ----
// Pairs in the same group are considered correlated; only one open at a time.
const CORRELATION_GROUPS = [
  // USD majors — highly correlated
  ['EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD'],
  // USD on the other side
  ['USDJPY', 'USDCHF', 'USDCAD'],
  // EUR crosses
  ['EURUSD', 'EURJPY', 'EURGBP'],
  // GBP crosses
  ['GBPUSD', 'GBPJPY', 'EURGBP'],
  // JPY crosses
  ['USDJPY', 'EURJPY', 'GBPJPY'],
];

// ---- Symbol normalization ----
function norm(sym) {
  if (!sym) return '';
  return sym.replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
}

function pipSize(sym) {
  const clean = norm(sym);
  const map = {
    EURUSD: 0.0001, GBPUSD: 0.0001, AUDUSD: 0.0001, NZDUSD: 0.0001,
    USDCHF: 0.0001, USDCAD: 0.0001,
    USDJPY: 0.01, EURJPY: 0.01, GBPJPY: 0.01, AUDJPY: 0.01,
    XAUUSD: 0.01, XAGUSD: 0.001,
    BTCUSD: 0.1, ETHUSD: 0.01,
  };
  return map[clean] || 0.0001;
}

// ---- Daily P&L cache ----
let _dailyPnLCache = { value: 0, fetchedAt: 0 };

async function _getDailyPnL() {
  const now = Date.now();
  if (now - _dailyPnLCache.fetchedAt < 60_000) {
    return _dailyPnLCache.value;
  }
  try {
    const since = new Date(now - 24 * 60 * 60 * 1000);
    const closed = await Trade.find({
      status: 'CLOSED',
      closeTime: { $gte: since },
    }).select('realizedProfit pnl').lean();

    const pnl = closed.reduce((sum, t) => {
      const v = Number.isFinite(t.realizedProfit) && t.realizedProfit !== 0
        ? t.realizedProfit
        : (Number.isFinite(t.pnl) ? t.pnl : 0);
      return sum + v;
    }, 0);

    _dailyPnLCache = { value: pnl, fetchedAt: now };
    return pnl;
  } catch (err) {
    logger.warn(`[RiskEngine] Daily P&L fetch failed: ${err.message}`);
    return _dailyPnLCache.value;   // stale is better than zero
  }
}

// ---- Open position normalization ----
function _normalizePositions(openPositions) {
  if (!Array.isArray(openPositions)) return [];
  return openPositions.map(p => ({
    symbol: norm(p.symbol || p.instrument || ''),
    side: String(p.side || p.direction || '').toUpperCase(),
    stake: Number(p.stake || p.units || p.amount || 0) || 0,
    openTime: p.openTime || p.startTime || null,
    contractId: String(p.id || p.contractId || p.contract_id || ''),
  }));
}

// ---- Duplicate detection ----
function _findDuplicate(symbol, direction, positions) {
  const now = Date.now();
  const cutoff = now - CONFIG.duplicateWindowMs;
  const wantSymbol = norm(symbol);
  const wantSide = String(direction).toUpperCase();

  for (const p of positions) {
    if (p.symbol !== wantSymbol) continue;
    if (p.side !== wantSide) continue;
    if (!p.openTime) continue;
    const openedAt = new Date(p.openTime).getTime();
    if (openedAt >= cutoff) {
      return p;
    }
  }
  return null;
}

// ---- Correlation check ----
function _findCorrelated(symbol, positions) {
  const wantSymbol = norm(symbol);
  const openSymbols = new Set(positions.map(p => p.symbol));

  for (const group of CORRELATION_GROUPS) {
    if (!group.includes(wantSymbol)) continue;
    // Any other symbol in the same group is already open?
    for (const groupSymbol of group) {
      if (groupSymbol === wantSymbol) continue;
      if (openSymbols.has(groupSymbol)) {
        return { correlatedWith: groupSymbol, group };
      }
    }
  }
  return null;
}

// ---- Structural sanity on price levels ----
function _validatePriceLevels(params) {
  const { direction, entryPrice, knockoutLevel, takeProfitLevel } = params;

  if (!entryPrice || entryPrice <= 0) {
    return { valid: false, reason: 'MISSING_ENTRY_PRICE', message: 'Entry price is required for risk validation.' };
  }

  if (direction === 'BUY') {
    if (knockoutLevel != null && knockoutLevel >= entryPrice) {
      return { valid: false, reason: 'INVALID_KNOCKOUT', message: 'Knockout must be below entry for BUY.' };
    }
    if (takeProfitLevel != null && takeProfitLevel <= entryPrice) {
      return { valid: false, reason: 'INVALID_TAKE_PROFIT', message: 'Take-profit must be above entry for BUY.' };
    }
  } else if (direction === 'SELL') {
    if (knockoutLevel != null && knockoutLevel <= entryPrice) {
      return { valid: false, reason: 'INVALID_KNOCKOUT', message: 'Knockout must be above entry for SELL.' };
    }
    if (takeProfitLevel != null && takeProfitLevel >= entryPrice) {
      return { valid: false, reason: 'INVALID_TAKE_PROFIT', message: 'Take-profit must be below entry for SELL.' };
    }
  }

  return { valid: true };
}

// ---- Main entry point ----
async function validateTrade(params) {
  const {
    symbol,
    direction,
    stake,
    multiplier,
    duration,
    knockoutLevel = null,
    takeProfitLevel = null,
    account,
    openPositions = [],
    marketData = {},
  } = params || {};

  // ---- 1. Basic input validation ----
  if (!symbol) {
    return _reject('MISSING_SYMBOL', 'Symbol is required.');
  }
  const cleanDir = String(direction || '').toUpperCase();
  if (cleanDir !== 'BUY' && cleanDir !== 'SELL') {
    return _reject('INVALID_DIRECTION', `Direction must be BUY or SELL (got ${direction}).`);
  }
  const stakeNum = Number(stake);
  if (!Number.isFinite(stakeNum) || stakeNum < CONFIG.minStake) {
    return _reject('INVALID_STAKE', `Stake must be ≥ ${CONFIG.minStake} (got ${stake}).`);
  }
  const multNum = Number(multiplier);
  if (![100, 200, 300, 500, 800].includes(multNum)) {
    return _reject('INVALID_MULTIPLIER', `Multiplier must be one of 100,200,300,500,800 (got ${multiplier}).`);
  }

  // ---- 2. Account validation ----
  const balance = account && Number(account.balance);
  if (!Number.isFinite(balance) || balance <= 0) {
    return _reject('INVALID_BALANCE', 'Account balance not available.');
  }

  const positions = _normalizePositions(openPositions);

  // ---- 3. Structural sanity (needs entryPrice) ----
  const entryPrice = Number(marketData.currentPrice) || Number(account?.currentPrice) || 0;
  const structural = _validatePriceLevels({ direction: cleanDir, entryPrice, knockoutLevel, takeProfitLevel });
  if (!structural.valid) {
    return _reject(structural.reason, structural.message);
  }

  // ---- 4. Single stake vs balance ----
  const maxStake = balance * CONFIG.maxStakeRatio;
  if (stakeNum > maxStake) {
    return _reject(
      'STAKE_TOO_LARGE',
      `Stake ${stakeNum.toFixed(2)} exceeds single-trade max ${maxStake.toFixed(2)} (${(CONFIG.maxStakeRatio * 100).toFixed(0)}% of balance).`
    );
  }

  // ---- 5. Concurrent positions ----
  if (positions.length >= CONFIG.maxOpenPositions) {
    return _reject(
      'MAX_POSITIONS',
      `Already at max concurrent positions (${positions.length}/${CONFIG.maxOpenPositions}).`
    );
  }

  // ---- 6. Duplicate detection ----
  const dup = _findDuplicate(symbol, cleanDir, positions);
  if (dup) {
    const ageSec = dup.openTime ? Math.round((Date.now() - new Date(dup.openTime).getTime()) / 1000) : 0;
    return _reject(
      'DUPLICATE_TRADE',
      `${cleanDir} ${symbol} already open ${ageSec}s ago (contract ${dup.contractId || 'unknown'}).`
    );
  }

  // ---- 7. Correlation ----
  const corr = _findCorrelated(symbol, positions);
  if (corr) {
    return _reject(
      'CORRELATED',
      `${symbol} correlated with open ${corr.correlatedWith}. Same-group exposure blocked.`
    );
  }

  // ---- 8. Total exposure ----
  const currentExposure = positions.reduce((sum, p) => sum + p.stake, 0);
  const newExposure = currentExposure + stakeNum;
  const maxExposure = balance * CONFIG.maxTotalExposureRatio;
  if (newExposure > maxExposure) {
    return _reject(
      'EXPOSURE_LIMIT',
      `Total exposure ${newExposure.toFixed(2)} would exceed ${maxExposure.toFixed(2)} (${(CONFIG.maxTotalExposureRatio * 100).toFixed(0)}% of balance).`
    );
  }

  // ---- 9. Daily loss ----
  const dailyPnL = await _getDailyPnL();
  const dailyLossLimit = balance * CONFIG.dailyLossLimitRatio;
  if (dailyPnL < -dailyLossLimit) {
    return _reject(
      'DAILY_LOSS_LIMIT',
      `Daily P&L ${dailyPnL.toFixed(2)} below limit -${dailyLossLimit.toFixed(2)} (${(CONFIG.dailyLossLimitRatio * 100).toFixed(0)}% of balance).`
    );
  }

  // ---- 10. Spread gate ----
  const spread = Number(marketData?.spread);
  if (Number.isFinite(spread) && spread > 0) {
    const spreadPips = spread / pipSize(symbol);
    if (spreadPips > CONFIG.maxPipsSpread) {
      return _reject(
        'SPREAD_TOO_WIDE',
        `Spread ${spreadPips.toFixed(2)} pips exceeds max ${CONFIG.maxPipsSpread}.`
      );
    }
  }

  // ---- 11. Risk/reward ----
  if (entryPrice > 0 && knockoutLevel != null && takeProfitLevel != null) {
    const slDist = Math.abs(entryPrice - knockoutLevel);
    const tpDist = Math.abs(takeProfitLevel - entryPrice);
    if (slDist > 0) {
      const rr = tpDist / slDist;
      if (rr < CONFIG.minRiskRewardRatio) {
        return _reject(
          'LOW_RR',
          `R:R ${rr.toFixed(2)} below minimum ${CONFIG.minRiskRewardRatio}.`
        );
      }
    }
  }

  // ---- All checks passed ----
  logger.info(
    `[RiskEngine] APPROVED ${cleanDir} ${symbol} ${multNum}x stake=${stakeNum.toFixed(2)} ` +
    `positions=${positions.length} exposure=${newExposure.toFixed(2)}/${maxExposure.toFixed(2)} ` +
    `dailyPnL=${dailyPnL.toFixed(2)}`
  );

  return {
    approved: true,
    reason: 'OK',
    message: 'Trade passed all risk checks.',
    // Extra context for callers that want to log or display
    state: {
      openPositions: positions.length,
      exposure: newExposure,
      maxExposure,
      dailyPnL,
      dailyLossLimit,
      balance,
    },
  };
}

// ---- [FILE-7I] Backward-compatible alias ----
async function canOpenTrade(params) {
  return validateTrade(params);
}

// ---- [FILE-7J] State for dashboards ----
async function getState(account = null) {
  const balance = account && Number(account.balance);
  const dailyPnL = await _getDailyPnL();
  return {
    dailyPnL,
    dailyLossLimit: Number.isFinite(balance) ? balance * CONFIG.dailyLossLimitRatio : null,
    maxOpenPositions: CONFIG.maxOpenPositions,
    maxStakeRatio: CONFIG.maxStakeRatio,
    maxTotalExposureRatio: CONFIG.maxTotalExposureRatio,
    config: { ...CONFIG },
  };
}

// ---- Rejection helper ----
function _reject(reason, message) {
  logger.info(`[RiskEngine] REJECTED ${reason} — ${message}`);
  return {
    approved: false,
    reason,
    message,
  };
}

// ---- Reset caches (for tests / admin) ----
function resetDailyPnLCache() {
  _dailyPnLCache = { value: 0, fetchedAt: 0 };
}

module.exports = {
  validateTrade,
  canOpenTrade,
  getState,
  resetDailyPnLCache,
  CONFIG,
};
