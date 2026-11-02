// core/decision/engine.js
// Decision Engine – probability/EV based with empirical edge from StateStore.
// Enhanced with: adaptive thresholds, learning weights, confidence calibration.
//
// [FIX-D1] Extracted duplicated decision-emit logic from _onRegime and _evaluate
//          into a single _emitDecision helper. Behavior identical, no drift risk.
// [FIX-D2] Post-calibration MIN_CONFIDENCE re-check. Previously calibration
//          could reduce confidence from, say, 70 → 45 while the decision stayed
//          BUY/SELL — the emitted confidence was below threshold. Now if
//          calibration drives confidence below MIN_CONFIDENCE the decision is
//          downgraded to NO_TRADE (with an INFO log) rather than silently emitting.
// [FIX-D4] Guard `currentPrice <= 0` → return NO_TRADE. Previously if
//          marketStateCache had no price field, stopLoss/takeProfit were computed
//          as negative values and propagated to the broker.
// [FIX-D8] In-flight guard per symbol. Previously _onRegime and _evaluate could
//          run _evaluateSymbol for the same symbol concurrently, doing duplicate
//          DB/stateStore work and racing on _lastDecision.
// [FIX-D9] Regime code normalization. deepRegime.getLatestRegime() may return
//          { code: 'unknown' } (lowercase) or undefined; downstream logs treat
//          'unknown' as a valid-but-unhandled regime, causing the orchestrator's
//          "Coerced unknown regime code 'unknown' → 'NEUTRAL'" spam. Normalized
//          to { code: 'NEUTRAL' } here, with a per-symbol throttled debug log
//          so the origin remains traceable.
// [FIX-D10] Flat-vs-nested state bug. marketStateCache returns FLAT awareness
//           shape ({ trend:'bullish', momentum:50, atr, liquidity, ... }) but
//           _extractFeatures, _buildContributions, and the feature/inputs blocks
//           used NESTED access ({ trend:{adx}, momentum:{rsi}, volatility:{...} }).
//           Every access silently fell through to defaults (adx=0, rsi=50,
//           atrPercent=0.001), so rule-based scoring was operating on empty
//           features. Now these functions receive `deepState` (which is
//           guaranteed nested via the fallback) while _weightedFallbackRuleBased
//           keeps receiving the flat `state` (which it was written to expect).

const EventEmitter = require('events');
const marketStateCache = require('../data/marketStateCache');
const deepMarketState = require('../intelligence/deep/marketState');
const deepRegime = require('../intelligence/deep/regime');
const awarenessEngine = require('../awareness/engine');
const selfLearner = require('../learning/learner');
const stateStore = require('../intelligence/lab/stateStore');
const { dataOrchestrator } = require('../data/dataOrchestrator');

const logger = require('../../infrastructure/logger') || console;

const CONFIG = {
  DECISION_INTERVAL_MS: 30000,
  MIN_CONFIDENCE: 60,
  MIN_EDGE: 0.2,
  MIN_PROBABILITY: 0.52,
  DEFAULT_STOP_DISTANCE_ATR: 1.5,
  DEFAULT_TP_DISTANCE_ATR: 3.0,
  EDGE_LOOKAHEAD: 5,
  EDGE_K: 100,
};

// ---- Adaptive thresholds based on volatility ----
function getAdaptiveThresholds(volatilityRegime) {
  if (volatilityRegime === 'high') {
    return { minEdge: 0.3, minProbability: 0.55 };
  } else if (volatilityRegime === 'low') {
    return { minEdge: 0.15, minProbability: 0.50 };
  } else {
    return { minEdge: CONFIG.MIN_EDGE, minProbability: CONFIG.MIN_PROBABILITY };
  }
}

// [FIX-D9] Throttle window for the unknown-regime debug log.
const UNKNOWN_REGIME_LOG_THROTTLE_MS = 60 * 1000;

class DecisionEngine extends EventEmitter {
  constructor() {
    super();
    this._lastDecision = {};
    this._timer = null;
    this._isReady = false;
    // [FIX-D8] In-flight guard per symbol.
    this._evaluating = new Set();
    this._evaluateInFlight = false;
    // [FIX-D9] Regime normalization throttle map.
    this._unknownRegimeLogged = new Map();

    deepRegime.on('regime', (regime) => {
      this._onRegime(regime);
    });

    this._timer = setInterval(() => {
      this._evaluate();
    }, CONFIG.DECISION_INTERVAL_MS);

    if (stateStore && typeof stateStore.init === 'function') {
      stateStore.init()
        .then(() => {
          this._isReady = true;
        })
        .catch(err => {
          this._isReady = false;
        });
    } else {
      this._isReady = false;
    }
  }

  async _onRegime(regime) {
    if (!regime || !regime.symbol) return;
    const decision = await this._evaluateSymbol(regime.symbol);
    // [FIX-D1] Use shared emit helper.
    await this._emitDecision(decision);
  }

  async _evaluate() {
    // [FIX-D8] Prevent overlapping full sweeps if the previous one overran
    // the 30 s interval. Per-symbol guard also protects _onRegime races.
    if (this._evaluateInFlight) return;
    this._evaluateInFlight = true;
    try {
      const symbols = awarenessEngine._state ? Array.from(awarenessEngine._state.keys()) : [];
      if (symbols.length === 0) return;
      for (const symbol of symbols) {
        const decision = await this._evaluateSymbol(symbol);
        // [FIX-D1] Use shared emit helper.
        await this._emitDecision(decision);
      }
    } catch (err) {
      // intentional: no log spam from a transient engine error
    } finally {
      this._evaluateInFlight = false;
    }
  }

  // [FIX-D1] Shared emit logic — extracted from the two call sites.
  async _emitDecision(decision) {
    if (!decision || decision.decision === 'NO_TRADE') return;
    const prev = this._lastDecision[decision.symbol];
    if (prev && prev.decision === decision.decision && Math.abs(prev.confidence - decision.confidence) <= 5) {
      return;  // not a meaningful change
    }
    this._lastDecision[decision.symbol] = decision;
    try {
      const decisionId = await selfLearner.recordDecision(decision);
      if (decisionId) decision.decisionId = decisionId;
    } catch (_) {
      // ignore — selfLearner is best-effort
    }
    this.emit('decision', decision);
  }

  // [FIX-D8] Serialize per-symbol evaluation.
  async _evaluateSymbol(symbol) {
    if (this._evaluating.has(symbol)) return null;
    this._evaluating.add(symbol);
    try {
      return await this._doEvaluateSymbol(symbol);
    } finally {
      this._evaluating.delete(symbol);
    }
  }

  // [FIX-D9] Normalize regime returned by deepRegime. Handles null, undefined,
  // missing code, and the lowercase 'unknown' sentinel that leaks from
  // upstream regime detectors.
  _normalizeRegime(raw) {
    if (!raw || typeof raw !== 'object') {
      return { code: 'NEUTRAL', confidence: 50 };
    }
    const rawCode = String(raw.code || '').trim();
    const upper = rawCode.toUpperCase();
    if (!upper || upper === 'UNKNOWN') {
      this._logUnknownRegime(raw.symbol || '?', rawCode || '(missing)');
      return { ...raw, code: 'NEUTRAL' };
    }
    // Preserve the original object but with a canonical uppercase code.
    return { ...raw, code: upper };
  }

  // [FIX-D9] Throttled per-symbol log so we can trace the origin of 'unknown'
  // without spamming every 30 s cycle. Uses DEBUG so it doesn't compete with
  // the orchestrator's WARN-level coercion messages.
  _logUnknownRegime(symbol, rawCode) {
    const now = Date.now();
    const last = this._unknownRegimeLogged.get(symbol) || 0;
    if (now - last < UNKNOWN_REGIME_LOG_THROTTLE_MS) return;
    this._unknownRegimeLogged.set(symbol, now);
    logger.debug(
      `[DecisionEngine] Normalized regime '${rawCode}' → NEUTRAL for ${symbol} ` +
      `(deepRegime returned non-canonical code)`
    );
  }

  async _doEvaluateSymbol(symbol) {
    // 1. Get current awareness state (flat, for immediate metrics)
    const state = marketStateCache.get(symbol);
    if (!state) {
      return null;
    }

    // 2. Get deep state (full nested) for feature extraction + logging
    let deepState = deepMarketState.getLastState(symbol);
    if (!deepState) {
      deepState = {
        ...state,
        trend: { direction: state.trend || 'neutral', strength: 0, adx: 0, plusDI: 0, minusDI: 0 },
        momentum: { rsi: state.momentum || 50, macdLine: 0, macdSignal: 0, macdHist: 0, velocity: state.velocity || 0, acceleration: state.acceleration || 0 },
        volatility: { atr: state.atr || 0.001, atrPercent: 0.005, bbWidth: 0.15, regime: 'normal' },
        liquidity: { score: state.liquidity || 0.5, spread: state.spread || 0, tickFrequency: 0 },
        structure: { support: null, resistance: null, pricePosition: 0.5, isAtSupport: false, isAtResistance: false },
        session: { name: state.session || 'Other', liquidityMultiplier: 1, isWeekday: true },
        regime: { code: 'NEUTRAL', name: 'Neutral', confidence: 50, description: '' },
        summary: { marketQuality: 50, noiseLevel: 'medium', regimeSuggestion: 'neutral', trendConfidence: 50 },
        confidence: 50,
        reason: 'Fallback state',
      };
    }

    // 3. Get regime (from last regime event) — [FIX-D9] normalized
    const regimeRaw = deepRegime.getLatestRegime(symbol);
    const regime = this._normalizeRegime(regimeRaw);

    // 4. Extract flat features for StateStore
    //    [FIX-D10] Pass deepState (nested) rather than flat state
    const flatFeatures = this._extractFeatures(deepState, regime);

    // 5. Compute edge (probability and expected value) from historical analogues
    let edge = null;
    let similarity = null;
    if (this._isReady && stateStore && flatFeatures) {
      try {
        edge = await stateStore.computeEdge(
          flatFeatures,
          symbol,
          'M5',
          CONFIG.EDGE_LOOKAHEAD,
          CONFIG.EDGE_K
        );
        similarity = await stateStore.findSimilar(
          flatFeatures,
          symbol,
          'M5',
          CONFIG.EDGE_K,
          CONFIG.EDGE_LOOKAHEAD
        );
      } catch (err) {
        edge = null;
      }
    }

    // 6. Determine decision
    let decision, confidence, expectedValue, probability;

    // [FIX-D10] Use deepState.volatility.regime (nested) — flat state has no
    // volatility field, so previously this always fell back to 'normal'.
    const volatilityRegime = deepState.volatility?.regime || 'normal';
    const { minEdge, minProbability } = getAdaptiveThresholds(volatilityRegime);

    if (edge && edge.sampleSize >= 20) {
      // ---- Empirical edge ----
      const winProb = edge.winRate;
      const avgReturnR = edge.avgReturnR;
      const ev = avgReturnR;

      if (ev > minEdge && winProb > minProbability) {
        decision = 'BUY';
        confidence = Math.min(90, 50 + (winProb - 0.5) * 80);
        expectedValue = ev;
        probability = winProb;
      } else if (ev < -minEdge && (1 - winProb) > minProbability) {
        decision = 'SELL';
        confidence = Math.min(90, 50 + ((1 - winProb) - 0.5) * 80);
        expectedValue = ev;
        probability = winProb;
      } else {
        decision = 'NO_TRADE';
        confidence = 50;
        expectedValue = ev;
        probability = winProb;
      }
    } else {
      // ---- Rule-based scoring with learning weights ----
      // _weightedFallbackRuleBased expects FLAT state — keep passing `state`.
      const result = this._weightedFallbackRuleBased(symbol, state, regime);
      decision = result.decision;
      confidence = result.confidence;
      expectedValue = 0;
      probability = confidence / 100;
    }

    // ---- Confidence calibration ----
    // [FIX-D2] After calibration, re-check MIN_CONFIDENCE. If the blend drops
    // below threshold, downgrade to NO_TRADE rather than silently emitting a
    // signal below the configured floor.
    if (decision !== 'NO_TRADE' && this._isReady && stateStore) {
      try {
        const calibration = await stateStore.calibrateConfidence({
          symbol,
          features: deepState,
          confidence,
          timeframe: 'M5',
        }, CONFIG.EDGE_LOOKAHEAD, CONFIG.EDGE_K);
        if (calibration && calibration.sampleSize > 10) {
          const preCalConfidence = confidence;
          const blended = confidence * 0.6 + calibration.calibratedConfidence * 0.4;
          const calibratedRounded = Math.round(Math.min(100, Math.max(0, blended)));
          if (calibratedRounded >= CONFIG.MIN_CONFIDENCE) {
            confidence = calibratedRounded;
          } else {
            logger.info(
              `[DecisionEngine] ${symbol} calibration downgraded ${decision} ` +
              `(raw=${Math.round(preCalConfidence)} calibrated=${calibratedRounded} ` +
              `min=${CONFIG.MIN_CONFIDENCE}) → NO_TRADE`
            );
            decision = 'NO_TRADE';
            confidence = calibratedRounded;
          }
        }
      } catch (err) {
        // ignore — calibration is optional
      }
    }

    // 7. Price / ATR levels
    // [FIX-D10] Use deepState for nested access with flat fallbacks.
    const currentPrice =
      deepState.price?.current ??
      state.price?.current ??
      deepState.mid ??
      state.mid ??
      0;
    const atr =
      deepState.volatility?.atr ??
      state.atr ??
      deepState.atr ??
      0.001;

    // [FIX-D4] Guard against invalid price — otherwise SL/TP become negative
    // values that propagate to the broker where they fail with cryptic errors.
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      logger.warn(
        `[DecisionEngine] ${symbol} missing valid price (currentPrice=${currentPrice}) — no decision`
      );
      return null;
    }

    const stopDistance = atr * CONFIG.DEFAULT_STOP_DISTANCE_ATR || currentPrice * 0.005;
    const takeDistance = atr * CONFIG.DEFAULT_TP_DISTANCE_ATR || currentPrice * 0.01;
    let stopLoss = 0, takeProfit = 0;
    if (decision === 'BUY') {
      stopLoss = currentPrice - stopDistance;
      takeProfit = currentPrice + takeDistance;
    } else if (decision === 'SELL') {
      stopLoss = currentPrice + stopDistance;
      takeProfit = currentPrice - takeDistance;
    }

    // 8. Build decision object
    //    [FIX-D10] _buildContributions and inputs block use deepState.
    const decisionObj = {
      symbol,
      decision,
      confidence: Math.round(Math.min(100, Math.max(0, confidence))),
      expectedValue: expectedValue || 0,
      probability: probability || 0.5,
      entryPrice: currentPrice,
      stopLoss: Math.round(stopLoss * 100000) / 100000,
      takeProfit: Math.round(takeProfit * 100000) / 100000,
      recommendedLotSize: 0.01,
      reason: this._buildReason(decision, confidence, edge, regime),
      timestamp: new Date().toISOString(),
      timeframe: 'M5',
      features: deepState,
      contributions: this._buildContributions(deepState, regime, edge),
      inputs: {
        regime: regime.confidence / 100,
        // [FIX-D10] Use deepState.momentum.rsi (nested) — previously read
        // state.momentum.rsi where state.momentum was a flat number, so this
        // always resolved to 0.
        momentum: deepState.momentum?.rsi ? (deepState.momentum.rsi - 50) / 50 : 0,
        liquidity: deepState.liquidity?.score ?? state.liquidity ?? 0.5,
      },
      historicalAnalogues: edge?.sampleSize || 0,
      generatedBy: 'DecisionEngine v5',
      probabilityModel: 'v4.0',
      expectedValueModel: 'v2.1',
    };

    return decisionObj;
  }

  // ============================================================
  // FEATURE EXTRACTION
  // [FIX-D10] Takes deepState (nested). Uses ?? fallbacks so a flat
  // object passed here still produces reasonable output, but callers
  // now pass deepState which is guaranteed nested via the fallback.
  // ============================================================
  _extractFeatures(state, regime) {
    if (!state) return null;
    // Extract nested values with flat fallbacks for robustness.
    const rsi = (typeof state.momentum === 'number')
      ? state.momentum
      : (state.momentum?.rsi ?? state.rsi ?? 50);
    const features = {
      adx: state.trend?.adx ?? state.adx ?? 0,
      rsi,
      atrPercent: state.volatility?.atrPercent ?? state.atrPercent ?? 0.001,
      bbWidth: state.volatility?.bbWidth ?? state.bbWidth ?? 0.15,
      macdHist: state.momentum?.macdHist ?? state.macdHist ?? 0,
      liquidity: state.liquidity?.score ?? state.liquidity ?? 0.5,
      velocity: state.awareness?.velocity ?? state.velocity ?? 0,
      acceleration: state.awareness?.acceleration ?? state.acceleration ?? 0,
      pricePosition: state.structure?.pricePosition ?? state.pricePosition ?? 0.5,
      marketQuality: state.summary?.marketQuality ?? state.marketQuality ?? 50,
    };
    for (const [key, val] of Object.entries(features)) {
      if (typeof val !== 'number' || isNaN(val)) {
        features[key] = 0;
      }
    }
    return features;
  }

  // ============================================================
  // CONTRIBUTIONS
  // [FIX-D10] Takes deepState (nested). Checks for both flat and
  // nested trend shapes so the function is robust regardless of
  // which caller shape arrives.
  // ============================================================
  _buildContributions(state, regime, edge) {
    const positive = [];
    const negative = [];
    let totalScore = 0;

    // Trend direction — support both flat string and nested { direction }
    const trendDir = typeof state.trend === 'string'
      ? state.trend
      : (state.trend?.direction || 'neutral');

    // Regime contribution
    if (regime.code === 'STRONG_TREND_BULL') {
      positive.push({ name: 'Regime (Strong Bull)', score: 20, description: 'Strong bullish trend detected' });
      totalScore += 20;
    } else if (regime.code === 'STRONG_TREND_BEAR') {
      positive.push({ name: 'Regime (Strong Bear)', score: 20, description: 'Strong bearish trend detected' });
      totalScore += 20;
    } else if (regime.code === 'REVERSAL') {
      if (trendDir === 'bullish') {
        negative.push({ name: 'Reversal Risk', score: 15, description: 'Reversal zone at resistance' });
        totalScore -= 15;
      } else {
        positive.push({ name: 'Reversal Opportunity', score: 15, description: 'Reversal zone at support' });
        totalScore += 15;
      }
    }

    // Momentum (RSI) — [FIX-D10] nested-with-flat-fallback
    const rsi = (typeof state.momentum === 'number')
      ? state.momentum
      : (state.momentum?.rsi ?? state.rsi ?? 50);
    if (rsi > 70) negative.push({ name: 'Overbought RSI', score: 10, description: `RSI at ${rsi.toFixed(1)}` });
    else if (rsi < 30) positive.push({ name: 'Oversold RSI', score: 10, description: `RSI at ${rsi.toFixed(1)}` });
    else if (rsi > 60) positive.push({ name: 'Strong Momentum', score: 5, description: `RSI at ${rsi.toFixed(1)}` });
    else if (rsi < 40) negative.push({ name: 'Weak Momentum', score: 5, description: `RSI at ${rsi.toFixed(1)}` });

    // Trend strength (ADX)
    const adx = state.trend?.adx ?? state.adx ?? 0;
    if (adx > 30) positive.push({ name: 'Strong Trend (ADX)', score: 15, description: `ADX at ${adx.toFixed(1)}` });
    else if (adx > 20) positive.push({ name: 'Moderate Trend', score: 8, description: `ADX at ${adx.toFixed(1)}` });
    else negative.push({ name: 'Weak Trend', score: 8, description: `ADX at ${adx.toFixed(1)}` });

    // Volatility
    const vol = state.volatility?.regime ?? state.volatilityRegime ?? 'normal';
    if (vol === 'high') negative.push({ name: 'High Volatility', score: 5, description: 'Increased risk' });
    else if (vol === 'low') positive.push({ name: 'Low Volatility', score: 5, description: 'Stable conditions' });

    // Liquidity
    const liq = state.liquidity?.score ?? state.liquidity ?? 0.5;
    if (typeof liq === 'number') {
      if (liq > 0.6) positive.push({ name: 'Good Liquidity', score: 5, description: `Liquidity ${(liq*100).toFixed(0)}%` });
      else if (liq < 0.3) negative.push({ name: 'Low Liquidity', score: 5, description: `Liquidity ${(liq*100).toFixed(0)}%` });
    }

    // Structure
    const isAtSupport = state.structure?.isAtSupport ?? state.isAtSupport ?? false;
    const isAtResistance = state.structure?.isAtResistance ?? state.isAtResistance ?? false;
    if (isAtSupport) positive.push({ name: 'At Support', score: 10, description: 'Price at support level' });
    if (isAtResistance) negative.push({ name: 'At Resistance', score: 10, description: 'Price at resistance level' });

    // Edge (if available)
    if (edge && edge.sampleSize >= 20) {
      if (edge.winRate > 0.55) positive.push({ name: 'Historical Edge', score: Math.min(20, (edge.winRate - 0.5) * 100), description: `Win rate ${(edge.winRate*100).toFixed(0)}% over ${edge.sampleSize} analogues` });
      else if (edge.winRate < 0.45) negative.push({ name: 'Weak Historical Edge', score: Math.min(20, (0.5 - edge.winRate) * 100), description: `Win rate ${(edge.winRate*100).toFixed(0)}% over ${edge.sampleSize} analogues` });
    }

    positive.sort((a, b) => b.score - a.score);
    negative.sort((a, b) => b.score - a.score);

    return { positive, negative, totalScore };
  }

  // ============================================================
  // REASON GENERATION
  // ============================================================
  _buildReason(decision, confidence, edge, regime) {
    let reason = `${decision} signal with ${confidence}% confidence. `;
    if (edge && edge.sampleSize >= 20) {
      reason += `Historical edge: win rate ${(edge.winRate*100).toFixed(1)}%, avg return ${edge.avgReturnR.toFixed(2)}R (${edge.sampleSize} analogues). `;
    }
    if (regime && regime.code !== 'NEUTRAL') {
      reason += `Regime: ${regime.code}. `;
    }
    if (decision === 'NO_TRADE') {
      reason += 'No clear edge or insufficient confidence.';
    }
    return reason.trim();
  }

  // ============================================================
  // FALLBACK: Rule-Based Scoring with Learning Weights
  // [FIX-D10] Intentionally keeps FLAT state signature — this function was
  // written to read state.trend (string), state.awareness?.velocity,
  // state.liquidity (number). Do NOT change to deepState without rewriting
  // every accessor; that's a larger refactor. Leaving as-is preserves the
  // existing rule-based scoring path.
  // ============================================================
  _weightedFallbackRuleBased(symbol, state, regime) {
    let weights = {
      regime: 1.0,
      velocity: 1.0,
      liquidity: 1.0,
    };
    try {
      const learnerWeights = selfLearner.getWeights();
      const allWeights = Object.values(learnerWeights);
      if (allWeights.length > 0) {
        const avgWeight = allWeights.reduce((a, b) => a + b, 0) / allWeights.length;
        weights.regime = avgWeight;
        weights.velocity = avgWeight;
        weights.liquidity = avgWeight;
      }
    } catch (err) {
      // ignore
    }

    let buyScore = 0, sellScore = 0;

    if (regime.code === 'STRONG_TREND_BULL' || regime.code === 'WEAK_TREND') {
      const direction = state.trend || 'neutral';
      if (direction === 'bullish') buyScore += 30 * (regime.confidence / 100) * weights.regime;
      else if (direction === 'bearish') sellScore += 30 * (regime.confidence / 100) * weights.regime;
    } else if (regime.code === 'STRONG_TREND_BEAR') {
      sellScore += 30 * (regime.confidence / 100) * weights.regime;
    } else if (regime.code === 'REVERSAL') {
      const trendDir = state.trend || 'neutral';
      if (trendDir === 'bullish') sellScore += 20 * weights.regime;
      else if (trendDir === 'bearish') buyScore += 20 * weights.regime;
    } else if (regime.code === 'BREAKOUT') {
      const velocity = state.awareness?.velocity || state.velocity || 0;
      if (velocity > 0.0001) buyScore += 25 * weights.regime;
      else if (velocity < -0.0001) sellScore += 25 * weights.regime;
    }

    const velocity = state.awareness?.velocity || state.velocity || 0;
    const absVel = Math.abs(velocity);
    const velScore = Math.min(20, absVel / 0.0001 * 10) * weights.velocity;
    if (velocity > 0) buyScore += velScore;
    else if (velocity < 0) sellScore += velScore;

    const liquidity = state.awareness?.liquidity || state.liquidity || 0.5;
    if (liquidity > 0.6) {
      buyScore += 5 * weights.liquidity;
      sellScore += 5 * weights.liquidity;
    }

    let decision = 'NO_TRADE';
    let confidence = 0;
    if (buyScore > sellScore && buyScore > 20) {
      decision = 'BUY';
      confidence = Math.min(90, 50 + (buyScore - sellScore) / (buyScore + sellScore + 0.001) * 40);
    } else if (sellScore > buyScore && sellScore > 20) {
      decision = 'SELL';
      confidence = Math.min(90, 50 + (sellScore - buyScore) / (buyScore + sellScore + 0.001) * 40);
    }

    if (confidence < CONFIG.MIN_CONFIDENCE) {
      decision = 'NO_TRADE';
      confidence = 0;
    }

    return { decision, confidence };
  }

  getLastDecision(symbol) {
    return this._lastDecision[symbol] || null;
  }
}

module.exports = new DecisionEngine();
