// core/intelligence/deep/marketState.js
// Deep Market State – incremental cache, correct mapping for engine indicators.
// Now publishes to DataOrchestrator for persistence and research.
// Fully compatible with stateStore.js – all required fields are computed.
// Handles symbol variants (with/without underscores, with/without frx prefix) via internal normalization.
//
// [FILE-2A] Regime classification is now computed inside compute() from the
//   state's own trend/momentum/volatility/structure fields, using the same
//   logic as regime.js._classifyRegime. Previously hardcoded NEUTRAL.
//   This unblocks regime-conditioned historical-edge matching in stateStore.
// [FILE-2B] _calculateConfidence is a real implementation (was a stub).
//   state.confidence is now a 0-100 number consumed by OTIE and decisionEngine.
// [FILE-2C] _volatilityRegime is a real implementation (was a stub).
//   Compares current ATR% to trailing 20-candle average.
// [FILE-2D] summary.marketQuality formula fixed. Was producing 0 for every
//   symbol because spread × 1e6 dominated the calculation. New formula
//   scales spread by pip size and normalizes to 0-100 across all pairs.
// [FILE-2E] _trendConfidence and _suggestRegime are real implementations.
// [FILE-2F] _buildReason is a real implementation.
// [FILE-2G] _getSymbolVariants strips 'frx' prefix before generating variants.
// [FILE-2H] _ensureBuffer canonicalizes the symbol before getHistory lookup.
//
// [FIX-MS1] historicalState publishes are now throttled. Previously every
//           compute() call published a doc — and compute() is called from
//           runner.js (per bot per 15s), server.js (per symbol per 30s), and
//           any diagnostic caller. That produced 20+ publishes/min/symbol,
//           flooding the _appendQueue and generating 20+ [Orchestrator]
//           Coerced-regime log lines per minute (each historicalState publish
//           is validated through _sanitizeHistoricalState). Now:
//             • Immediate publish on meaningful change (regime or trend flips)
//             • Otherwise at most once per 60s per symbol+timeframe
//           Research/backtest quality is preserved (state flips are captured)
//           while the queue load drops ~20× on quiet markets.
// [FIX-MS2] _lastState and publish symbol keys use the canonical form
//           (uppercase, no separators, no 'frx' prefix). Previously if
//           runner.js passed 'EURUSD' and another caller passed 'EUR_USD',
//           they stored under different keys and the getLastState() reader
//           could miss. Both paths now share the canonical key.
// [FIX-MS3] state.price.open now falls back to previous close (or current
//           close) when the candle has no valid `open`. Buffer validation
//           only checks high/low/close, so `open` could be undefined for
//           some candleHistory sources.
// [FIX-MS4] _addCandleToBuffer logs a throttled DEBUG when a candle arrives
//           for a buffer that has never been initialized (i.e., before the
//           first compute()). Previously these were dropped silently —
//           made "why is my buffer stale?" undiagnosable.
// [FIX-MS5] _classifyRegime is wrapped in try/catch so a malformed state
//           (e.g. NaN in trend.strength) falls back to NEUTRAL with a
//           WARN log instead of throwing and making compute() silently
//           return null. Fixes an invisible failure mode.
// [FIX-MS6] Buffer validity filter is applied consistently — the initial
//           load, the incremental candle-close handler, and compute() all
//           use the same _isValidCandle() predicate. Previously the
//           incremental path had slightly different checks.
// [FIX-MS7] state.price.open is now explicitly typed as a number. If it
//           was undefined, downstream JSON serialization to historicalState
//           could produce `{ open: undefined }` which Mongo would store as
//           a missing field (OK) OR fail with strict mode (not OK).
// [FIX-MS8] getDiagnostics() exposes per-symbol publish counters and last
//           publish times — useful for /debug/market-state endpoints.
// [FIX-MS9] Removed redundant `symbol, ...state` publish where `state.symbol`
//           already covered it. Now publishes with a single canonical symbol
//           at top level, `...state` (whose `symbol` field is also canonical).

const EventEmitter = require('events');
const candleStore = require('../../data/candleStore');
const candleHistory = require('../../data/candleHistory');
const marketStateCache = require('../../data/marketStateCache');
const session = require('../session');
const { dataOrchestrator, DATA_CLASSES } = require('../../data/dataOrchestrator');
const logger = require('../../../infrastructure/logger') || console;
const {
  ADX,
  ATR,
  RSI,
  MACD,
  BollingerBands,
  findSupportResistance,
} = require('../../strategy/engine');

// ---- Valid regime codes ----
const VALID_REGIME_CODES = [
  'STRONG_TREND_BULL',
  'STRONG_TREND_BEAR',
  'WEAK_TREND',
  'RANGING',
  'BREAKOUT',
  'REVERSAL',
  'HIGH_VOLATILITY',
  'LOW_VOLATILITY',
  'NEUTRAL',
];

const REGIME_NAMES = {
  STRONG_TREND_BULL: 'Strong Bullish Trend',
  STRONG_TREND_BEAR: 'Strong Bearish Trend',
  WEAK_TREND: 'Weak Trend',
  RANGING: 'Ranging Market',
  HIGH_VOLATILITY: 'High Volatility',
  LOW_VOLATILITY: 'Low Volatility',
  BREAKOUT: 'Breakout',
  REVERSAL: 'Reversal Zone',
  NEUTRAL: 'Neutral / Mixed',
};

// [FIX-MS1] historicalState publish throttle.
//   FLIP_TRIGGERS = state changes that force an immediate publish regardless
//   of interval (regime code change or trend direction change).
//   INTERVAL_MS = maximum quiet-period interval between publishes.
const HISTORICAL_STATE_PUBLISH_INTERVAL_MS = 60_000;

// [FIX-MS4] Throttle window for "buffer not initialized" debug logs.
const BUFFER_MISS_LOG_THROTTLE_MS = 5 * 60_000;

// [FIX-MS6] Shared candle validity predicate used by all three call sites.
function _isValidCandle(c) {
  return (
    c && typeof c === 'object' &&
    typeof c.high === 'number' && Number.isFinite(c.high) &&
    typeof c.low === 'number' && Number.isFinite(c.low) &&
    typeof c.close === 'number' && Number.isFinite(c.close)
  );
}

class DeepMarketState extends EventEmitter {
  constructor() {
    super();
    this.indicators = {
      adxPeriod: 14,
      atrPeriod: 14,
      rsiPeriod: 14,
      macdFast: 12,
      macdSlow: 26,
      macdSignal: 9,
      bbPeriod: 20,
      bbStd: 2,
      supportResistanceLookback: 30,
    };

    // In-memory buffers: key = `${normalizedSymbol}:${timeframe}` -> array of candles (oldest first)
    this._buffers = new Map();
    // Last computed state per symbol (canonical symbol)
    this._lastState = new Map();

    // [FIX-MS1] Track last historicalState publish per symbol+timeframe.
    //   { at: number, regimeCode: string, trendDirection: string }
    this._lastHistoricalPublish = new Map();
    // [FIX-MS4] Per-key throttling for buffer-miss debug logs.
    this._bufferMissLoggedAt = new Map();
    // [FIX-MS8] Diagnostics counters.
    this._publishStats = {
      marketState: { published: 0, skipped: 0 },
      historicalState: { published: 0, skipped: 0, throttled: 0, flipped: 0 },
    };

    // Subscribe to new candle closes – update the buffer incrementally
    candleStore.on('candleClosed', (candle) => {
      this._addCandleToBuffer(candle);
    });

    // Register with DataOrchestrator
    dataOrchestrator.register('marketState', DATA_CLASSES.RECOVERABLE, {
      collection: 'marketstate',
      snapshotInterval: 5000,
    });
    dataOrchestrator.register('historicalState', DATA_CLASSES.RESEARCH, {
      collection: 'historicalstates',
      batchSize: 50,
    });
    dataOrchestrator.register('regimeChange', DATA_CLASSES.RESEARCH, {
      collection: 'historicalstates',
    });
  }

  // ---- Canonical symbol: strip frx prefix and separators, uppercase ----
  _normalizeSymbol(symbol) {
    if (!symbol) return '';
    return symbol.replace(/^frx/i, '').replace(/[/\-_]/g, '').toUpperCase();
  }

  _addCandleToBuffer(candle) {
    if (!candle || !candle.symbol || !candle.timeframe) return;
    const normSymbol = this._normalizeSymbol(candle.symbol);
    const key = this._getKey(normSymbol, candle.timeframe);
    if (!this._buffers.has(key)) {
      // [FIX-MS4] Throttled diagnostic — buffer was never loaded.
      // Not an error: _ensureBuffer initializes from candleHistory on
      // first compute(). But if this fires repeatedly after compute() has
      // run, something is wrong (e.g. timeframe mismatch).
      const now = Date.now();
      const last = this._bufferMissLoggedAt.get(key) || 0;
      if (now - last >= BUFFER_MISS_LOG_THROTTLE_MS) {
        this._bufferMissLoggedAt.set(key, now);
        logger.debug(
          `[DeepMarketState] Dropped candleClosed for uninitialized buffer ${key} ` +
          `(compute() has not yet run for this symbol+timeframe)`
        );
      }
      return;
    }
    // [FIX-MS6] Same validity predicate as elsewhere.
    if (_isValidCandle(candle)) {
      const buffer = this._buffers.get(key);
      buffer.push(candle);
      if (buffer.length > 200) buffer.shift();
    }
  }

  /**
   * Ensure the buffer for a symbol+timeframe is loaded from DB.
   * [FILE-2H] Canonicalize symbol before first DB lookup.
   * [FILE-2G] Variant generation strips 'frx' properly.
   */
  async _ensureBuffer(symbol, timeframe, candleCount = 200) {
    const normSymbol = this._normalizeSymbol(symbol);
    const key = this._getKey(normSymbol, timeframe);
    if (this._buffers.has(key)) {
      return this._buffers.get(key);
    }

    // Try canonical form first
    let candles = await candleHistory.getHistory(normSymbol, timeframe, candleCount);

    // Fallback to variants
    if (!candles || candles.length === 0) {
      const variants = this._getSymbolVariants(normSymbol);
      for (const variant of variants) {
        if (variant === normSymbol) continue;
        candles = await candleHistory.getHistory(variant, timeframe, candleCount);
        if (candles && candles.length > 0) break;
      }
    }

    if (!candles || candles.length < 50) {
      return null;
    }

    // [FIX-MS6] Same validity predicate as the incremental path.
    const valid = candles.filter(_isValidCandle);
    if (valid.length < 50) {
      return null;
    }

    this._buffers.set(key, valid);
    return valid;
  }

  _getKey(normalizedSymbol, timeframe) {
    return `${normalizedSymbol}:${timeframe}`;
  }

  // [FILE-2G] Strip 'frx' prefix before generating variants. Idempotent.
  _getSymbolVariants(symbol) {
    if (!symbol) return [];
    const stripped = symbol.replace(/^frx/i, '');
    const clean = stripped.replace(/[/\-_]/g, '').toUpperCase();
    const variants = new Set();
    variants.add(clean);
    if (clean.length === 6) {
      const withUnderscore = clean.slice(0, 3) + '_' + clean.slice(3);
      variants.add(withUnderscore);
      variants.add('frx' + withUnderscore);
    }
    variants.add('frx' + clean);
    variants.add(symbol.toUpperCase());
    return Array.from(variants);
  }

  // [FIX-MS1] Determine whether the current state warrants a historicalState
  // publish. Returns { publish: boolean, reason: 'first'|'flip'|'interval'|'throttled' }.
  _shouldPublishHistorical(canonicalSymbol, timeframe, state) {
    const key = `${canonicalSymbol}:${timeframe}`;
    const last = this._lastHistoricalPublish.get(key);

    if (!last) {
      return { publish: true, reason: 'first' };
    }

    const regimeCode = state.regime?.code || 'NEUTRAL';
    const trendDirection = state.trend?.direction || 'neutral';

    // Meaningful flips → immediate publish
    if (last.regimeCode !== regimeCode) {
      return { publish: true, reason: 'flip' };
    }
    if (last.trendDirection !== trendDirection) {
      return { publish: true, reason: 'flip' };
    }

    // Quiet period → interval-gated
    if (Date.now() - last.at >= HISTORICAL_STATE_PUBLISH_INTERVAL_MS) {
      return { publish: true, reason: 'interval' };
    }

    return { publish: false, reason: 'throttled' };
  }

  _recordHistoricalPublish(canonicalSymbol, timeframe, state) {
    const key = `${canonicalSymbol}:${timeframe}`;
    this._lastHistoricalPublish.set(key, {
      at: Date.now(),
      regimeCode: state.regime?.code || 'NEUTRAL',
      trendDirection: state.trend?.direction || 'neutral',
    });
  }

  async compute(symbol, timeframe = 'M5', candleCount = 200) {
    try {
      const candles = await this._ensureBuffer(symbol, timeframe, candleCount);
      if (!candles) {
        return null;
      }

      // [FIX-MS6] Shared validity predicate.
      const validCandles = candles.filter(_isValidCandle);
      if (validCandles.length < 50) {
        return null;
      }

      const closes = validCandles.map(c => c.close);
      const highs = validCandles.map(c => c.high);
      const lows = validCandles.map(c => c.low);
      const lastIdx = closes.length - 1;
      const currentPrice = closes[lastIdx];

      const candlesForIndicators = validCandles
        .map(c => ({ mid: { h: c.high, l: c.low, c: c.close } }))
        .filter(item => item && item.mid && typeof item.mid.h === 'number');

      if (candlesForIndicators.length < 50) {
        return null;
      }

      let adxData = null, atrArray = null, rsi = null, macd = null, bb = null, sr = null;

      try { adxData = ADX(candlesForIndicators, this.indicators.adxPeriod); } catch (err) { adxData = null; }
      try { atrArray = ATR(candlesForIndicators, this.indicators.atrPeriod); } catch (err) { atrArray = null; }
      try { rsi = RSI(closes, this.indicators.rsiPeriod); } catch (err) { rsi = null; }
      try { macd = MACD(closes, this.indicators.macdFast, this.indicators.macdSlow, this.indicators.macdSignal); } catch (err) { macd = null; }
      try { bb = BollingerBands(closes, this.indicators.bbPeriod, this.indicators.bbStd); } catch (err) { bb = null; }

      try {
        if (candlesForIndicators.length >= 30) {
          sr = findSupportResistance(candlesForIndicators, this.indicators.supportResistanceLookback, 0.001);
        } else {
          sr = null;
        }
      } catch (srErr) {
        const previous = this._lastState.get(symbol);
        sr = {
          support: previous?.structure?.support ? { price: previous.structure.support } : null,
          resistance: previous?.structure?.resistance ? { price: previous.structure.resistance } : null,
        };
      }

      const atr = atrArray ? atrArray[atrArray.length - 1] : 0;
      const rsiVal = rsi || 50;
      const macdHist = macd ? macd.histogram[macd.histogram.length - 1] : 0;
      const bbWidth = bb ? (bb.upper[bb.upper.length - 1] - bb.lower[bb.lower.length - 1]) / bb.middle[bb.middle.length - 1] : 0;
      const support = sr && sr.support ? sr.support.price : null;
      const resistance = sr && sr.resistance ? sr.resistance.price : null;
      const pricePosition = (support && resistance) ? (currentPrice - support) / (resistance - support) : 0.5;
      const isAtSupport = support ? Math.abs(currentPrice - support) / currentPrice < 0.001 : false;
      const isAtResistance = resistance ? Math.abs(currentPrice - resistance) / currentPrice < 0.001 : false;

      const currentSession = session.getSession();
      const trendLookback = Math.min(50, closes.length - 1);

      // [FILE-2C] Real volatility regime
      const volatilityRegime = this._volatilityRegime(atr, validCandles, currentPrice);

      // [FIX-MS3] / [FIX-MS7] Safe open extraction.
      const rawOpen = validCandles[lastIdx].open;
      const openPrice = Number.isFinite(rawOpen)
        ? rawOpen
        : (lastIdx > 0 ? closes[lastIdx - 1] : closes[lastIdx]);

      const state = {
        symbol,
        timeframe,
        time: new Date().toISOString(),
        price: {
          current: currentPrice,
          open: openPrice,
          high: highs[lastIdx],
          low: lows[lastIdx],
          close: closes[lastIdx],
        },
        trend: {
          strength: adxData ? adxData.adx : 0,
          direction: closes[lastIdx] > closes[lastIdx - trendLookback] ? 'bullish' : 'bearish',
          adx: adxData ? adxData.adx : 0,
          plusDI: adxData ? adxData.plusDI : 0,
          minusDI: adxData ? adxData.minusDI : 0,
          slope: (closes[lastIdx] - closes[0]) / (closes[0] || 0.0001),
        },
        momentum: {
          rsi: rsiVal,
          macdHist: macdHist,
          macdLine: macd ? macd.macd[macd.macd.length - 1] : 0,
          macdSignal: macd ? macd.signal[macd.signal.length - 1] : 0,
          velocity: 0,
          acceleration: 0,
        },
        volatility: {
          atr,
          atrPercent: atr / (currentPrice || 0.0001),
          bbWidth,
          regime: volatilityRegime,
        },
        structure: {
          support,
          resistance,
          pricePosition,
          isAtSupport,
          isAtResistance,
        },
        session: {
          name: currentSession.name,
          liquidityMultiplier: currentSession.liquidityMultiplier,
          isWeekday: session.isWeekday ? session.isWeekday() : true,
        },
        summary: {
          trendConfidence: 0,
          volatilityScore: Math.min(1, atr / (currentPrice * 0.01 || 0.0001)),
          liquidityScore: 0.5,
          regimeSuggestion: 'neutral',
          marketQuality: 50,
          noiseLevel: 'medium',
        },
        confidence: 0,
        reason: '',
        status: 'confirmed',
        regime: {
          code: 'NEUTRAL',
          name: REGIME_NAMES.NEUTRAL,
          confidence: 50,
          description: '',
        },
        awareness: {
          unusualEvents: [],
          pressure: 'neutral',
        },
      };

      // ---- Incorporate awareness data if available ----
      const awareness = marketStateCache.get(this._normalizeSymbol(symbol));
      if (awareness) {
        state.awareness = {
          velocity: awareness.velocity || 0,
          acceleration: awareness.acceleration || 0,
          liquidity: awareness.liquidity || 0.5,
          spread: awareness.spread || 0,
          unusualEvents: awareness.unusual || awareness.unusualEvents || [],
          pressure: awareness.velocity > 0.0001 ? 'buying' : (awareness.velocity < -0.0001 ? 'selling' : 'neutral'),
        };
        state.momentum.velocity = awareness.velocity || 0;
        state.momentum.acceleration = awareness.acceleration || 0;
        state.summary.liquidityScore = awareness.liquidity || 0.5;

        const liq = awareness.liquidity || 0.5;
        const spread = awareness.spread || 0;
        const pipSize = this._pipSizeForSymbol(symbol);
        const spreadPenalty = Math.min(60, (spread / pipSize) * 2);
        const quality = (liq * 100) - spreadPenalty;
        state.summary.marketQuality = Math.max(0, Math.min(100, quality + 20));
        state.summary.noiseLevel = state.summary.marketQuality > 70 ? 'low' : (state.summary.marketQuality > 40 ? 'medium' : 'high');
      }

      // [FILE-2E]
      state.summary.trendConfidence = this._trendConfidence(adxData, rsiVal, macdHist);
      state.summary.regimeSuggestion = this._suggestRegime(adxData, rsiVal, bbWidth, atr);

      // [FILE-2A] + [FIX-MS5] Regime classification with defensive fallback.
      try {
        state.regime = this._classifyRegime(state);
      } catch (classifyErr) {
        logger.warn(
          `[DeepMarketState] _classifyRegime failed for ${symbol}/${timeframe}: ` +
          `${classifyErr.message} — defaulting to NEUTRAL`
        );
        state.regime = {
          code: 'NEUTRAL',
          name: REGIME_NAMES.NEUTRAL,
          confidence: 50,
          description: 'Classification error — neutral fallback',
        };
      }

      // [FILE-2B]
      state.confidence = this._calculateConfidence(state);

      // [FILE-2F]
      state.reason = this._buildReason(state);

      // [FIX-MS2] Canonical symbol for persistence keys.
      const canonicalSymbol = this._normalizeSymbol(symbol);

      // ---- PUBLISH TO DATAORCHESTRATOR ----
      // [FIX-MS9] Single canonical symbol; ...state also carries canonical.
      dataOrchestrator.publish('marketState', {
        ...state,
        symbol: canonicalSymbol,
        lastUpdated: new Date(),
      }, { source: 'deepMarketState' });
      this._publishStats.marketState.published++;

      // [FIX-MS1] Throttled historicalState publish.
      const shouldPublish = this._shouldPublishHistorical(canonicalSymbol, timeframe, state);
      if (shouldPublish.publish) {
        dataOrchestrator.publish('historicalState', {
          symbol: canonicalSymbol,
          timeframe,
          timestamp: state.time,
          price: state.price,
          trend: state.trend,
          momentum: state.momentum,
          volatility: state.volatility,
          liquidity: {
            score: state.summary.liquidityScore,
            spread: state.awareness?.spread || 0,
            tickFrequency: 0,
          },
          structure: state.structure,
          session: state.session,
          regime: state.regime,
          awareness: state.awareness,
          summary: state.summary,
          confidence: state.confidence,
          reason: state.reason,
          source: 'live',
          version: '2.0',
        }, {});
        this._recordHistoricalPublish(canonicalSymbol, timeframe, state);
        this._publishStats.historicalState.published++;
        if (shouldPublish.reason === 'flip') this._publishStats.historicalState.flipped++;
      } else {
        this._publishStats.historicalState.skipped++;
        this._publishStats.historicalState.throttled++;
      }

      // [FIX-MS2] Canonical key for _lastState too.
      this._lastState.set(canonicalSymbol, state);

      return state;
    } catch (err) {
      return null;
    }
  }

  // ---------- Helper implementations ----------

  _volatilityRegime(atr, candles, currentPrice) {
    if (!candles || candles.length < 20 || !currentPrice || currentPrice <= 0) {
      return 'normal';
    }
    const atrPercent = atr / currentPrice;

    const recent = [];
    for (let i = Math.max(0, candles.length - 20); i < candles.length; i++) {
      const c = candles[i];
      if (c.high == null || c.low == null || !c.close) continue;
      recent.push((c.high - c.low) / c.close);
    }
    if (recent.length === 0) return 'normal';

    const avgAtrPercent = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (avgAtrPercent <= 0) return 'normal';

    if (atrPercent > avgAtrPercent * 1.5) return 'high';
    if (atrPercent < avgAtrPercent * 0.6) return 'low';
    return 'normal';
  }

  _trendConfidence(adxData, rsi, macdHist) {
    const adx = adxData?.adx || 0;
    let conf = 50;
    if (adx > 30) conf += 20;
    else if (adx > 20) conf += 10;
    else if (adx < 15) conf -= 10;

    if (rsi > 55 && macdHist > 0) conf += 15;
    else if (rsi < 45 && macdHist < 0) conf += 15;
    else if ((rsi > 60 && macdHist < 0) || (rsi < 40 && macdHist > 0)) conf -= 15;

    return Math.max(0, Math.min(100, conf));
  }

  _suggestRegime(adxData, rsi, bbWidth, atr) {
    const adx = adxData?.adx || 0;
    if (adx > 30) return 'trending';
    if (adx < 20 && bbWidth < 0.15) return 'ranging';
    if (adx < 20) return 'choppy';
    if (rsi > 70 || rsi < 30) return 'reversal_watch';
    return 'weak_trend';
  }

  _classifyRegime(state) {
    const { trend, momentum, volatility, structure } = state;
    const adx = trend.strength;
    const rsi = momentum.rsi;
    const bbWidth = volatility.bbWidth;
    const atrPercent = volatility.atrPercent;
    const isAtSupport = structure.isAtSupport;
    const isAtResistance = structure.isAtResistance;

    if (adx > 30 && trend.direction === 'bullish') {
      return {
        code: 'STRONG_TREND_BULL',
        name: REGIME_NAMES.STRONG_TREND_BULL,
        confidence: Math.min(100, 70 + Math.min(30, adx - 30) * 0.5),
        description: 'Strong bullish trend with high ADX.',
      };
    }
    if (adx > 30 && trend.direction === 'bearish') {
      return {
        code: 'STRONG_TREND_BEAR',
        name: REGIME_NAMES.STRONG_TREND_BEAR,
        confidence: Math.min(100, 70 + Math.min(30, adx - 30) * 0.5),
        description: 'Strong bearish trend with high ADX.',
      };
    }

    if ((isAtSupport || isAtResistance) && bbWidth > 0.1) {
      return {
        code: 'BREAKOUT',
        name: REGIME_NAMES.BREAKOUT,
        confidence: Math.min(100, 65 + bbWidth * 10),
        description: 'Price near key level with expanding volatility.',
      };
    }

    if (volatility.regime === 'high' && atrPercent > 0.005) {
      return {
        code: 'HIGH_VOLATILITY',
        name: REGIME_NAMES.HIGH_VOLATILITY,
        confidence: Math.min(100, 65 + atrPercent * 10),
        description: 'Elevated volatility with large price swings.',
      };
    }

    if (volatility.regime === 'low' && atrPercent < 0.001) {
      return {
        code: 'LOW_VOLATILITY',
        name: REGIME_NAMES.LOW_VOLATILITY,
        confidence: Math.min(100, 60 + (1 - atrPercent * 10)),
        description: 'Compressed volatility, tight price action.',
      };
    }

    if (adx < 20 && bbWidth < 0.15) {
      return {
        code: 'RANGING',
        name: REGIME_NAMES.RANGING,
        confidence: Math.min(100, 60 + (100 - adx) * 0.3),
        description: 'Sideways market with low ADX and narrow Bollinger bands.',
      };
    }

    if ((rsi > 70 || rsi < 30) && (isAtSupport || isAtResistance)) {
      return {
        code: 'REVERSAL',
        name: REGIME_NAMES.REVERSAL,
        confidence: Math.min(100, 60 + Math.abs(rsi - 50) / 50 * 20),
        description: 'Overbought/oversold RSI at support/resistance.',
      };
    }

    if (adx >= 20 && adx < 30) {
      return {
        code: 'WEAK_TREND',
        name: REGIME_NAMES.WEAK_TREND,
        confidence: Math.min(100, 55 + (adx - 20) * 0.5),
        description: 'Moderate trend strength, choppy price action.',
      };
    }

    return {
      code: 'NEUTRAL',
      name: REGIME_NAMES.NEUTRAL,
      confidence: 50,
      description: 'Mixed signals, no clear regime.',
    };
  }

  _calculateConfidence(state) {
    let conf = 50;
    const { trend, momentum, volatility, structure, summary } = state;

    if (trend.strength > 30) conf += 15;
    else if (trend.strength > 20) conf += 8;
    else if (trend.strength < 15) conf -= 10;

    if (momentum.rsi > 40 && momentum.rsi < 60) conf += 5;
    else if (momentum.rsi > 70 || momentum.rsi < 30) conf -= 5;

    if (volatility.regime === 'high') conf -= 5;
    else if (volatility.regime === 'low') conf += 5;

    if (structure.isAtSupport || structure.isAtResistance) conf += 10;

    conf += ((summary.marketQuality || 50) - 50) * 0.2;

    return Math.round(Math.max(0, Math.min(100, conf)));
  }

  _buildReason(state) {
    const parts = [];
    const { trend, momentum, volatility, structure, session: sess, regime } = state;

    parts.push(`ADX ${trend.strength.toFixed(1)} (${trend.direction})`);
    parts.push(`RSI ${momentum.rsi.toFixed(1)}`);
    if (volatility.regime && volatility.regime !== 'normal') parts.push(`Vol ${volatility.regime}`);
    if (structure.isAtSupport) parts.push('at support');
    if (structure.isAtResistance) parts.push('at resistance');
    if (sess?.name && sess.name !== 'Other') parts.push(`session ${sess.name}`);
    if (regime?.code) parts.push(`regime ${regime.code}`);
    return parts.join(' | ');
  }

  _pipSizeForSymbol(symbol) {
    const clean = this._normalizeSymbol(symbol);
    const mapping = {
      EURUSD: 0.0001, GBPUSD: 0.0001, AUDUSD: 0.0001, NZDUSD: 0.0001,
      USDCHF: 0.0001, USDCAD: 0.0001,
      USDJPY: 0.01, EURJPY: 0.01, GBPJPY: 0.01,
      XAUUSD: 0.01, XAGUSD: 0.001,
      BTCUSD: 0.1, ETHUSD: 0.01,
    };
    return mapping[clean] || 0.0001;
  }

  // ---------- Public API ----------
  updateIncremental(tick) {
    // Reserved for future use — currently no-op.
  }

  // [FIX-MS2] Normalize the symbol for getLastState so callers passing
  // 'EUR_USD' and callers passing 'EURUSD' hit the same entry.
  getLastState(symbol) {
    const canonical = this._normalizeSymbol(symbol);
    return this._lastState.get(canonical) || this._lastState.get(symbol) || null;
  }

  // [FIX-MS8] Diagnostic counters for /debug/market-state endpoints.
  getDiagnostics() {
    const entries = [];
    for (const [key, val] of this._lastHistoricalPublish) {
      entries.push({
        key,
        lastPublishAt: val.at,
        ageMs: Date.now() - val.at,
        regimeCode: val.regimeCode,
        trendDirection: val.trendDirection,
      });
    }
    return {
      buffers: Array.from(this._buffers.entries()).map(([key, buf]) => ({
        key,
        candles: buf.length,
      })),
      lastState: Array.from(this._lastState.keys()),
      historicalPublish: entries,
      counters: { ...this._publishStats },
    };
  }
}

module.exports = new DeepMarketState();
