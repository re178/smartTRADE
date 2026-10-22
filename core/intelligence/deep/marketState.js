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

const EventEmitter = require('events');
const candleStore = require('../../data/candleStore');
const candleHistory = require('../../data/candleHistory');
const marketStateCache = require('../../data/marketStateCache');
const session = require('../session');
const { dataOrchestrator, DATA_CLASSES } = require('../../data/dataOrchestrator');
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
    // Last computed state per symbol (uses the symbol passed to compute())
    this._lastState = new Map();

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
    const normSymbol = this._normalizeSymbol(candle.symbol);
    const key = this._getKey(normSymbol, candle.timeframe);
    if (!this._buffers.has(key)) return;
    const buffer = this._buffers.get(key);
    if (candle && typeof candle.high === 'number' && typeof candle.low === 'number' && typeof candle.close === 'number') {
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

    const valid = candles.filter(c =>
      c && typeof c === 'object' &&
      typeof c.high === 'number' && !isNaN(c.high) &&
      typeof c.low === 'number' && !isNaN(c.low) &&
      typeof c.close === 'number' && !isNaN(c.close)
    );
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

  async compute(symbol, timeframe = 'M5', candleCount = 200) {
    try {
      const candles = await this._ensureBuffer(symbol, timeframe, candleCount);
      if (!candles) {
        return null;
      }

      const validCandles = candles.filter(c =>
        c && typeof c === 'object' &&
        typeof c.high === 'number' && !isNaN(c.high) &&
        typeof c.low === 'number' && !isNaN(c.low) &&
        typeof c.close === 'number' && !isNaN(c.close)
      );
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

      const state = {
        symbol,
        timeframe,
        time: new Date().toISOString(),
        price: {
          current: currentPrice,
          open: validCandles[lastIdx].open,
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
          trendConfidence: 0,       // [FILE-2E] computed below
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
      // [FILE-1] awareness now writes under 'EURUSD' (canonical). If symbol
      // here is 'EURUSD', we get real data. If symbol is 'EUR_USD', the
      // cache lookup misses and we fall back to defaults — that's fine,
      // the pipeline always uses 'EURUSD' from candleBuilder.
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

        // [FILE-2D] Fixed market quality formula. Previous version multiplied
        // spread by 1e6 which dominated the calculation on every pair.
        // New version scales by pip-size × 2 so a "normal" spread yields
        // roughly -20 penalty, a wide spread yields -40, and liquidity
        // contributes positively up to +50.
        const liq = awareness.liquidity || 0.5;
        const spread = awareness.spread || 0;
        const pipSize = this._pipSizeForSymbol(symbol);
        const spreadPenalty = Math.min(60, (spread / pipSize) * 2);
        const quality = (liq * 100) - spreadPenalty;
        state.summary.marketQuality = Math.max(0, Math.min(100, quality + 20));
        state.summary.noiseLevel = state.summary.marketQuality > 70 ? 'low' : (state.summary.marketQuality > 40 ? 'medium' : 'high');
      }

      // [FILE-2E] Real trend confidence and regime suggestion
      state.summary.trendConfidence = this._trendConfidence(adxData, rsiVal, macdHist);
      state.summary.regimeSuggestion = this._suggestRegime(adxData, rsiVal, bbWidth, atr);

      // [FILE-2A] Classify regime inline. Same logic as regime.js but
      // computed here so state.regime is self-consistent and available
      // before any external event listeners fire.
      state.regime = this._classifyRegime(state);

      // [FILE-2B] Real confidence
      state.confidence = this._calculateConfidence(state);

      // [FILE-2F] Human-readable reason
      state.reason = this._buildReason(state);

      // ---- PUBLISH TO DATAORCHESTRATOR ----
      dataOrchestrator.publish('marketState', {
        symbol,
        ...state,
        lastUpdated: new Date(),
      }, { source: 'deepMarketState' });

      dataOrchestrator.publish('historicalState', {
        symbol,
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

      this._lastState.set(symbol, state);

      return state;
    } catch (err) {
      return null;
    }
  }

  // ---------- Helper implementations (were stubs) ----------

  // [FILE-2C] Real volatility regime classification.
  _volatilityRegime(atr, candles, currentPrice) {
    if (!candles || candles.length < 20 || !currentPrice || currentPrice <= 0) {
      return 'normal';
    }
    const atrPercent = atr / currentPrice;

    // Historical ATR% over last 20 candles
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

  // [FILE-2E] Real trend confidence from ADX + RSI + MACD alignment.
  _trendConfidence(adxData, rsi, macdHist) {
    const adx = adxData?.adx || 0;
    let conf = 50;
    if (adx > 30) conf += 20;
    else if (adx > 20) conf += 10;
    else if (adx < 15) conf -= 10;

    // Momentum alignment
    if (rsi > 55 && macdHist > 0) conf += 15;
    else if (rsi < 45 && macdHist < 0) conf += 15;
    else if ((rsi > 60 && macdHist < 0) || (rsi < 40 && macdHist > 0)) conf -= 15;

    return Math.max(0, Math.min(100, conf));
  }

  // [FILE-2E] Real regime suggestion from raw indicators.
  _suggestRegime(adxData, rsi, bbWidth, atr) {
    const adx = adxData?.adx || 0;
    if (adx > 30) return 'trending';
    if (adx < 20 && bbWidth < 0.15) return 'ranging';
    if (adx < 20) return 'choppy';
    if (rsi > 70 || rsi < 30) return 'reversal_watch';
    return 'weak_trend';
  }

  // [FILE-2A] Regime classification inline. Same decision tree as
  // regime.js._classifyRegime, kept here so state.regime is available
  // on every compute() call without waiting for a regime event.
  _classifyRegime(state) {
    const { trend, momentum, volatility, structure } = state;
    const adx = trend.strength;
    const rsi = momentum.rsi;
    const bbWidth = volatility.bbWidth;
    const atrPercent = volatility.atrPercent;
    const isAtSupport = structure.isAtSupport;
    const isAtResistance = structure.isAtResistance;

    // 1. Strong trend
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

    // 2. Breakout
    if ((isAtSupport || isAtResistance) && bbWidth > 0.1) {
      return {
        code: 'BREAKOUT',
        name: REGIME_NAMES.BREAKOUT,
        confidence: Math.min(100, 65 + bbWidth * 10),
        description: 'Price near key level with expanding volatility.',
      };
    }

    // 3. High volatility
    if (volatility.regime === 'high' && atrPercent > 0.005) {
      return {
        code: 'HIGH_VOLATILITY',
        name: REGIME_NAMES.HIGH_VOLATILITY,
        confidence: Math.min(100, 65 + atrPercent * 10),
        description: 'Elevated volatility with large price swings.',
      };
    }

    // 4. Low volatility
    if (volatility.regime === 'low' && atrPercent < 0.001) {
      return {
        code: 'LOW_VOLATILITY',
        name: REGIME_NAMES.LOW_VOLATILITY,
        confidence: Math.min(100, 60 + (1 - atrPercent * 10)),
        description: 'Compressed volatility, tight price action.',
      };
    }

    // 5. Ranging
    if (adx < 20 && bbWidth < 0.15) {
      return {
        code: 'RANGING',
        name: REGIME_NAMES.RANGING,
        confidence: Math.min(100, 60 + (100 - adx) * 0.3),
        description: 'Sideways market with low ADX and narrow Bollinger bands.',
      };
    }

    // 6. Reversal zone
    if ((rsi > 70 || rsi < 30) && (isAtSupport || isAtResistance)) {
      return {
        code: 'REVERSAL',
        name: REGIME_NAMES.REVERSAL,
        confidence: Math.min(100, 60 + Math.abs(rsi - 50) / 50 * 20),
        description: 'Overbought/oversold RSI at support/resistance.',
      };
    }

    // 7. Weak trend
    if (adx >= 20 && adx < 30) {
      return {
        code: 'WEAK_TREND',
        name: REGIME_NAMES.WEAK_TREND,
        confidence: Math.min(100, 55 + (adx - 20) * 0.5),
        description: 'Moderate trend strength, choppy price action.',
      };
    }

    // 8. Neutral
    return {
      code: 'NEUTRAL',
      name: REGIME_NAMES.NEUTRAL,
      confidence: 50,
      description: 'Mixed signals, no clear regime.',
    };
  }

  // [FILE-2B] Real confidence from multi-factor alignment.
  _calculateConfidence(state) {
    let conf = 50;
    const { trend, momentum, volatility, structure, summary } = state;

    // Trend strength
    if (trend.strength > 30) conf += 15;
    else if (trend.strength > 20) conf += 8;
    else if (trend.strength < 15) conf -= 10;

    // Momentum alignment (not overbought/oversold in trend direction)
    if (momentum.rsi > 40 && momentum.rsi < 60) conf += 5;
    else if (momentum.rsi > 70 || momentum.rsi < 30) conf -= 5;

    // Volatility normal is best
    if (volatility.regime === 'high') conf -= 5;
    else if (volatility.regime === 'low') conf += 5;

    // Structure gives extra conviction
    if (structure.isAtSupport || structure.isAtResistance) conf += 10;

    // Market quality contributes
    conf += ((summary.marketQuality || 50) - 50) * 0.2;

    return Math.round(Math.max(0, Math.min(100, conf)));
  }

  // [FILE-2F] Human-readable reason.
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

  // ---------- Pip size for spread scaling ----------
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
    // [FILE-2] Do not remove; called by any legacy code path.
  }

  getLastState(symbol) {
    return this._lastState.get(symbol) || null;
  }
}

module.exports = new DeepMarketState();
