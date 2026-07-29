// core/intelligence/fusion.js
// Intelligence Fusion Layer – combines assessments from all timeframe analyzers.
// Answers: "Is there agreement across timeframes? What is the overall market interpretation?"

const EventEmitter = require('events');
const session = require('./session');
const logger = require('../../infrastructure/logger') || console;

class IntelligenceFusion extends EventEmitter {
  constructor() {
    super();
    // Store the latest analysis per symbol per timeframe
    this._assessments = new Map(); // symbol -> Map(timeframe -> assessment)
    this._lastFusion = new Map(); // symbol -> fusion result
    this._fusionInterval = null;

    // We'll register analyzers later, but we can listen to events
    // For now, we provide a registration method.
    logger.info('[IntelligenceFusion] Initialized.');
  }

  /**
   * Register a timeframe analyzer instance.
   * @param {string} timeframe - e.g., 'M1', 'M5', etc.
   * @param {Object} analyzer - The analyzer instance (extends TimeframeAnalyzer)
   */
  registerAnalyzer(timeframe, analyzer) {
    // Listen to analysis events from this analyzer
    analyzer.on('analysis', (analysis) => {
      this._onAnalysis(timeframe, analysis);
    });
    logger.debug(`[IntelligenceFusion] Registered analyzer for ${timeframe}`);
  }

  /**
   * Handle an incoming analysis from a timeframe analyzer.
   */
  _onAnalysis(timeframe, analysis) {
    const symbol = analysis.symbol;
    if (!this._assessments.has(symbol)) {
      this._assessments.set(symbol, new Map());
    }
    const symbolAssessments = this._assessments.get(symbol);
    symbolAssessments.set(timeframe, analysis);

    // Attempt to fuse after receiving an update
    this._fuse(symbol);
  }

  /**
   * Fuse all available timeframe assessments for a symbol.
   */
  _fuse(symbol) {
    const symbolAssessments = this._assessments.get(symbol);
    if (!symbolAssessments || symbolAssessments.size === 0) return;

    const timeframes = Array.from(symbolAssessments.keys());
    if (timeframes.length < 2) {
      // Not enough data to fuse yet
      return;
    }

    // Collect assessments
    const assessments = {};
    let totalConfidence = 0;
    let bullishCount = 0, bearishCount = 0, neutralCount = 0;
    let reasons = [];

    for (const [tf, assessment] of symbolAssessments) {
      assessments[tf] = assessment;
      const direction = assessment.trend?.direction || 'neutral';
      const conf = assessment.confidence || 50;
      totalConfidence += conf;
      if (direction === 'bullish') bullishCount++;
      else if (direction === 'bearish') bearishCount++;
      else neutralCount++;

      // Collect a short reason from each timeframe
      if (assessment.reason) {
        reasons.push(`${tf}: ${assessment.reason}`);
      }
    }

    const total = timeframes.length;
    const agreement = Math.max(bullishCount, bearishCount) / total;
    const avgConfidence = totalConfidence / total;

    // Determine verdict
    let verdict = 'neutral';
    let confidence = 50;
    let reason = '';

    if (bullishCount > bearishCount && agreement > 0.5) {
      verdict = 'bullish';
      confidence = 50 + agreement * 30 + (avgConfidence - 50) * 0.3;
    } else if (bearishCount > bullishCount && agreement > 0.5) {
      verdict = 'bearish';
      confidence = 50 + agreement * 30 + (avgConfidence - 50) * 0.3;
    } else {
      verdict = 'mixed';
      confidence = 50 + (avgConfidence - 50) * 0.5;
    }

    // Apply session adjustment
    const currentSession = session.getSession();
    if (currentSession.liquidityMultiplier > 1.2 && verdict !== 'mixed') {
      confidence += 5; // higher confidence in high liquidity
    } else if (currentSession.liquidityMultiplier < 0.8) {
      confidence -= 5; // lower confidence in thin liquidity
    }

    confidence = Math.min(100, Math.max(0, confidence));

    // Build the fusion result
    const fusion = {
      symbol,
      verdict,
      confidence: Math.round(confidence),
      agreement: Math.round(agreement * 100),
      timeframeCount: total,
      timeframeBreakdown: {
        bullish: bullishCount,
        bearish: bearishCount,
        neutral: neutralCount,
      },
      timeframes: assessments, // raw assessments for debugging/dashboard
      reasons: reasons.slice(0, 5), // top 5 reasons
      session: {
        name: currentSession.name,
        liquidityMultiplier: currentSession.liquidityMultiplier,
      },
      timestamp: new Date().toISOString(),
    };

    // Store and emit
    this._lastFusion.set(symbol, fusion);
    this.emit('fusion', fusion);
  }

  /**
   * Get the latest fusion result for a symbol.
   */
  getFusion(symbol) {
    return this._lastFusion.get(symbol) || null;
  }

  /**
   * Get all current assessments for a symbol (for dashboard debugging).
   */
  getAssessments(symbol) {
    const symbolAssessments = this._assessments.get(symbol);
    if (!symbolAssessments) return {};
    const result = {};
    for (const [tf, assessment] of symbolAssessments) {
      result[tf] = assessment;
    }
    return result;
  }
}

module.exports = new IntelligenceFusion();
