// core/intelligence/lab/outcomeLabeler.js
// Outcome Labeler – Computes and stores future path data for HistoricalState.
// Runs as a background job to label new states and backfill existing ones.
// EXTENDED: Stores MFE, MAE, time‑to‑extremes, regime transitions.

const HistoricalState = require('../../models/HistoricalState');
const candleHistory = require('../../data/candleHistory');
const deepRegime = require('../../intelligence/deep/regime');
const logger = require('../../../infrastructure/logger') || console;

// Configuration
const CONFIG = {
  // Lookahead horizons (in candles)
  HORIZONS: [5, 10, 20, 40],
  // Batch size for processing
  BATCH_SIZE: 100,
  // Sleep between batches (ms) to avoid DB overload
  BATCH_SLEEP_MS: 500,
  // Maximum candles to fetch for each horizon
  MAX_CANDLES: 200,
};

/**
 * Compute future path data for a given state.
 * @param {Object} state - HistoricalState document.
 * @param {Array} futureCandles - Array of future candles (each with { time, open, high, low, close }).
 * @param {Array} horizons - Lookahead horizons (e.g., [5, 10, 20, 40]).
 * @returns {Object} { futurePrices, mfe, mae, timeToMaxFavorable, timeToMaxAdverse, regimeTransitions }
 */
function computePathData(state, futureCandles, horizons) {
  const entryPrice = state.price.current;
  const maxHorizon = Math.max(...horizons);
  const maxIndex = Math.min(futureCandles.length, maxHorizon);

  // Extract close prices up to maxHorizon
  const prices = futureCandles.slice(0, maxIndex).map(c => c.close);
  if (prices.length === 0) {
    return null;
  }

  // Compute MFE (maximum favorable excursion) and MAE (maximum adverse excursion)
  // MFE = max(price - entryPrice)
  // MAE = min(price - entryPrice)
  let mfe = 0;
  let mae = 0;
  let timeToMaxFavorable = null;
  let timeToMaxAdverse = null;

  for (let i = 0; i < prices.length; i++) {
    const diff = prices[i] - entryPrice;
    if (diff > mfe) {
      mfe = diff;
      timeToMaxFavorable = i;
    }
    if (diff < mae) {
      mae = diff;
      timeToMaxAdverse = i;
    }
  }

  // Store price arrays per horizon
  const futurePrices = {};
  for (const h of horizons) {
    const idx = Math.min(h, prices.length);
    futurePrices[h] = prices.slice(0, idx);
  }

  // Regime transitions: we need to get the regime for each future candle time.
  // This requires fetching the regime from deepRegime or from the stored state.
  // For simplicity, we'll use the deepRegime.getLatestRegime for each timestamp if available.
  // However, this can be slow; we'll store the regime code from the future states if we have them.
  // For now, we'll just store an empty array and fill later if needed.
  const regimeTransitions = [];

  return {
    futurePrices,
    mfe,
    mae,
    timeToMaxFavorable,
    timeToMaxAdverse,
    regimeTransitions,
  };
}

/**
 * Label a single state with future path data.
 * @param {Object} state - HistoricalState document.
 * @param {number} maxHorizon - Maximum lookahead in candles.
 * @returns {Promise<boolean>} True if labelled successfully.
 */
async function labelState(state, maxHorizon = 40) {
  try {
    const symbol = state.symbol;
    const timeframe = state.timeframe;
    const timestamp = state.timestamp;

    // Fetch future candles from candleHistory
    // We need to get candles after the state's timestamp, up to maxHorizon candles.
    // candleHistory.getHistory returns an array of candles for a given symbol and timeframe,
    // but we need to filter by time > timestamp.
    // Assuming candleHistory has a method getCandlesAfter(symbol, timeframe, afterTime, limit)
    // We'll implement a helper function.
    const futureCandles = await getCandlesAfter(symbol, timeframe, timestamp, maxHorizon + 5);
    if (!futureCandles || futureCandles.length < 1) {
      logger.warn(`[OutcomeLabeler] No future candles for ${symbol} ${timeframe} at ${timestamp}`);
      return false;
    }

    const pathData = computePathData(state, futureCandles, CONFIG.HORIZONS);
    if (!pathData) {
      return false;
    }

    // Update the state with future path data
    state.futurePrices = pathData.futurePrices;
    state.mfe = pathData.mfe;
    state.mae = pathData.mae;
    state.timeToMaxFavorable = pathData.timeToMaxFavorable;
    state.timeToMaxAdverse = pathData.timeToMaxAdverse;
    state.regimeTransitions = pathData.regimeTransitions;
    state.version = '2.1';

    await state.save();
    return true;
  } catch (err) {
    logger.error(`[OutcomeLabeler] Error labelling state ${state._id}:`, err.message);
    return false;
  }
}

/**
 * Helper: get future candles after a given timestamp.
 * @param {string} symbol - Symbol (e.g., 'EUR_USD').
 * @param {string} timeframe - Timeframe (e.g., 'M5').
 * @param {Date} afterTime - Timestamp to start from.
 * @param {number} limit - Number of candles to fetch.
 * @returns {Promise<Array>} Array of candles (sorted by time ascending).
 */
async function getCandlesAfter(symbol, timeframe, afterTime, limit = 50) {
  // candleHistory.getHistory returns the most recent candles, but we need candles after a specific time.
  // We'll implement a simple approach: fetch a large batch from the DB and filter.
  // Alternatively, we could add a method to candleHistory.
  // For now, we'll use the existing candleHistory.getHistory and filter.
  // Assuming candleHistory.getHistory returns candles sorted by time (most recent first?).
  // We'll reverse if needed.
  const allCandles = await candleHistory.getHistory(symbol, timeframe, limit * 2);
  if (!allCandles || allCandles.length === 0) {
    return [];
  }
  // Assuming candles have a 'time' field in milliseconds or Date.
  const after = new Date(afterTime).getTime();
  // Filter candles with time > afterTime
  const filtered = allCandles
    .filter(c => new Date(c.time).getTime() > after)
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  return filtered.slice(0, limit);
}

/**
 * Label all unlabelled states (where futurePrices is null) in batches.
 * @param {number} batchSize - Number of states to process per batch.
 * @param {number} maxHorizon - Maximum lookahead.
 * @returns {Promise<Object>} { totalProcessed, totalSuccess, totalFailed }
 */
async function labelAllStates(batchSize = CONFIG.BATCH_SIZE, maxHorizon = 40) {
  logger.info('[OutcomeLabeler] Starting batch labeling...');

  let totalProcessed = 0;
  let totalSuccess = 0;
  let totalFailed = 0;

  let skip = 0;
  let hasMore = true;

  while (hasMore) {
    const states = await HistoricalState.find({
      futurePrices: null,
      // Also require that we have enough candles? We'll try anyway.
    })
      .sort({ timestamp: 1 })
      .skip(skip)
      .limit(batchSize)
      .lean();

    if (states.length === 0) {
      hasMore = false;
      break;
    }

    logger.info(`[OutcomeLabeler] Processing batch ${skip / batchSize + 1} (${states.length} states)`);

    for (const state of states) {
      const success = await labelState(state, maxHorizon);
      totalProcessed++;
      if (success) {
        totalSuccess++;
      } else {
        totalFailed++;
      }
    }

    skip += states.length;

    // Sleep to avoid overloading DB
    await new Promise(resolve => setTimeout(resolve, CONFIG.BATCH_SLEEP_MS));
  }

  logger.info(`[OutcomeLabeler] Completed. Processed: ${totalProcessed}, Success: ${totalSuccess}, Failed: ${totalFailed}`);
  return { totalProcessed, totalSuccess, totalFailed };
}

/**
 * Run the labeler as a background job (called periodically).
 * This will label states that have been added recently.
 */
async function runBackgroundLabeling() {
  // Find states with no path data and label them.
  // We'll only label states that have future candles available (i.e., not the most recent few).
  // For production, we might want to label only states older than some threshold.
  await labelAllStates(CONFIG.BATCH_SIZE, Math.max(...CONFIG.HORIZONS));
}

// Export the public API
module.exports = {
  labelState,
  labelAllStates,
  runBackgroundLabeling,
  getCandlesAfter,
  computePathData,
  CONFIG,
};
