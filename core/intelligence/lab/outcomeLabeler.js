// core/intelligence/lab/outcomeLabeler.js
// Background job to label outcomes for unlabelled HistoricalState records.
// Runs periodically and updates states with outcomes.

const HistoricalState = require('../../../models/HistoricalState');
const HistoricalOutcome = require('../../../models/HistoricalOutcome');
const candleHistory = require('../../data/candleHistory');
const logger = require('../../../infrastructure/logger') || console;

const LOOKAHEADS = [5, 10, 20, 40];
const MAX_CANDLES = 5000; // enough for up to 40 candles ahead
const TOLERANCE_MS = 60000; // 1 minute

let isRunning = false;

/**
 * Label outcomes for unlabelled states.
 * @param {number} limit - Max number of states to process in one run (to avoid overload).
 * @returns {Promise<{ labelled: number, skipped: number, errors: number }>}
 */
async function labelOutcomes(limit = 200) {
  if (isRunning) {
    logger.warn('[OutcomeLabeler] Already running, skipping this run.');
    return { labelled: 0, skipped: 0, errors: 0, message: 'Already running' };
  }
  isRunning = true;
  let labelled = 0, skipped = 0, errors = 0;

  try {
    logger.info('[OutcomeLabeler] Starting outcome labelling...');

    // Find states that are unlabelled (outcome5.return is null)
    const states = await HistoricalState.find({ 'outcome5.return': null }).limit(limit).lean();
    if (states.length === 0) {
      logger.info('[OutcomeLabeler] No unlabelled states found.');
      isRunning = false;
      return { labelled: 0, skipped: 0, errors: 0 };
    }

    logger.info(`[OutcomeLabeler] Found ${states.length} unlabelled states to process.`);

    for (const state of states) {
      try {
        const { symbol, timeframe, timestamp } = state;

        // Fetch candles for this symbol and timeframe
        let candles = await candleHistory.getHistory(symbol, timeframe, MAX_CANDLES);
        if (!candles || candles.length === 0) {
          // Try alternative symbol format (with/without underscore)
          const altSymbol = symbol.includes('_') ? symbol.replace('_', '') : symbol.slice(0, 3) + '_' + symbol.slice(3);
          candles = await candleHistory.getHistory(altSymbol, timeframe, MAX_CANDLES);
        }

        if (!candles || candles.length < 50) {
          logger.warn(`[OutcomeLabeler] No candles for ${symbol} ${timeframe}, skipping state ${state._id}`);
          skipped++;
          continue;
        }

        // Find the index of the candle matching the state's timestamp
        const stateTime = new Date(timestamp).getTime();
        let startIdx = -1;
        for (let i = 0; i < candles.length; i++) {
          const candleTime = new Date(candles[i].time).getTime();
          if (Math.abs(candleTime - stateTime) <= TOLERANCE_MS) {
            startIdx = i;
            break;
          }
        }
        if (startIdx === -1) {
          // Fallback: find first candle after state time
          for (let i = 0; i < candles.length; i++) {
            if (new Date(candles[i].time).getTime() >= stateTime) {
              startIdx = i;
              break;
            }
          }
        }

        if (startIdx === -1) {
          logger.warn(`[OutcomeLabeler] No matching candle for state ${state._id} (${symbol} ${timeframe})`);
          skipped++;
          continue;
        }

        const startPrice = candles[startIdx].close;
        const atr = state.volatility?.atr || 0.001;

        let anyLabelled = false;
        const outcomes = {};

        for (const lookahead of LOOKAHEADS) {
          const endIdx = startIdx + lookahead;
          if (endIdx >= candles.length) {
            // Not enough future candles – skip this lookahead
            continue;
          }

          const endPrice = candles[endIdx].close;
          const returnVal = endPrice - startPrice;
          const returnR = returnVal / atr;
          const win = returnVal > 0;

          // Max drawdown during the period
          let maxDrawdown = 0;
          for (let k = startIdx; k <= endIdx; k++) {
            const drawdown = (candles[k].low - startPrice) / startPrice;
            if (drawdown < maxDrawdown) maxDrawdown = drawdown;
          }

          outcomes[`outcome${lookahead}`] = {
            return: returnVal,
            returnR: returnR,
            win: win,
            maxDrawdown: maxDrawdown,
            volatility: atr,
            filledAt: new Date(),
          };

          // Also create a separate HistoricalOutcome record
          try {
            await HistoricalOutcome.create({
              stateId: state._id,
              symbol,
              timeframe,
              lookahead,
              outcome: {
                return: returnVal,
                returnR,
                win,
                maxDrawdown,
                volatility: atr,
                startPrice,
                endPrice,
              },
              featuresSnapshot: state.getFeatureVector ? state.getFeatureVector() : {},
              source: 'backfill',
              filledAt: new Date(),
            });
          } catch (outcomeErr) {
            // Ignore duplicate errors (if already exists)
            if (outcomeErr.code !== 11000) {
              logger.error(`[OutcomeLabeler] Error creating HistoricalOutcome for state ${state._id}:`, outcomeErr.message);
            }
          }

          anyLabelled = true;
        }

        if (anyLabelled) {
          // Update the state with all outcome fields
          await HistoricalState.updateOne(
            { _id: state._id },
            {
              $set: {
                ...outcomes,
                confidence: state.confidence, // keep original
              }
            }
          );
          labelled++;
          if (labelled % 10 === 0) logger.info(`[OutcomeLabeler] Labelled ${labelled} states...`);
        } else {
          skipped++;
        }
      } catch (err) {
        logger.error(`[OutcomeLabeler] Error processing state ${state._id}:`, err.message);
        errors++;
      }
    }

    logger.info(`[OutcomeLabeler] Done. Labelled ${labelled} states, skipped ${skipped}, errors ${errors}.`);
    return { labelled, skipped, errors };
  } catch (err) {
    logger.error('[OutcomeLabeler] Fatal error:', err.message);
    return { labelled: 0, skipped: 0, errors: 0 };
  } finally {
    isRunning = false;
  }
}

/**
 * Start a scheduler that runs labelOutcomes periodically.
 * @param {number} intervalMs - Interval in milliseconds (default 1 hour).
 * @returns {NodeJS.Timer} Timer reference.
 */
function startScheduler(intervalMs = 60 * 60 * 1000) {
  // Run immediately once
  labelOutcomes().catch(err => logger.error('[OutcomeLabeler] Initial run failed:', err.message));
  // Schedule periodic runs
  const timer = setInterval(() => {
    labelOutcomes().catch(err => logger.error('[OutcomeLabeler] Scheduled run failed:', err.message));
  }, intervalMs);
  logger.info(`[OutcomeLabeler] Scheduler started with interval ${intervalMs}ms`);
  return timer;
}

module.exports = {
  labelOutcomes,
  startScheduler,
};
