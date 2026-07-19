// core/explainability/reason.js
// RTS Explainability Engine
// Purpose: Generate human‑readable explanations for every decision.
// Answers: "Why did the system make this decision? What factors influenced it?"

const EventEmitter = require('events');
const logger = require('../../infrastructure/logger') || console;

class ExplainabilityEngine extends EventEmitter {
  constructor() {
    super();
    // Templates for different scenarios
    this._templates = {
      BUY: {
        summary: "Buy signal generated based on {reasons}.",
        detail: "The system identified a {regime} market with {confidence}% confidence. Key drivers: {drivers}. Risk assessment: {risk}.",
        risk: "Stop-loss placed at {stopLoss}, take-profit at {takeProfit}, risk-reward ratio {rr}.",
      },
      SELL: {
        summary: "Sell signal generated based on {reasons}.",
        detail: "The system identified a {regime} market with {confidence}% confidence. Key drivers: {drivers}. Risk assessment: {risk}.",
        risk: "Stop-loss placed at {stopLoss}, take-profit at {takeProfit}, risk-reward ratio {rr}.",
      },
      NO_TRADE: {
        summary: "No trade signal generated.",
        detail: "The system did not find sufficient evidence to enter a trade. {reasons}",
      },
    };
    logger.info('[ExplainabilityEngine] Initialized.');
  }

  /**
   * Generate a full explanation for a decision.
   * @param {Object} decision - The decision object from the Fusion Engine.
   * @param {Object} context - Additional context: regime, probabilities, risk assessment, contributing strategies, etc.
   * @returns {Object} { summary, detailedReason, factors, riskStatement, timestamp }
   */
  generateExplanation(decision, context = {}) {
    try {
      const { symbol, decision: side, confidence, entryPrice, stopLoss, takeProfit, recommendedLotSize } = decision;
      const {
        regime,
        probabilities,
        riskAssessment,
        contributingStrategies,
        dissentingStrategies,
        marketState,
      } = context;

      // Build the factors list
      const factors = this._buildFactors(decision, context);

      // Build the detailed reason
      const detailedReason = this._buildDetailedReason(side, factors, regime, confidence);

      // Build the risk statement
      const riskStatement = this._buildRiskStatement(stopLoss, takeProfit, entryPrice, recommendedLotSize, riskAssessment);

      // Build the summary
      const summary = this._buildSummary(side, factors, regime, confidence);

      // Assemble the full explanation
      return {
        summary,
        detailedReason,
        factors,
        riskStatement,
        timestamp: new Date().toISOString(),
        symbol,
        decision: side,
        confidence,
        entryPrice,
        stopLoss,
        takeProfit,
        recommendedLotSize,
        regime: regime ? regime.regime : 'unknown',
        contributingStrategies: contributingStrategies || [],
        dissentingStrategies: dissentingStrategies || [],
      };
    } catch (err) {
      logger.error('[ExplainabilityEngine] Error generating explanation:', err.message);
      return {
        summary: 'Explanation generation failed.',
        detailedReason: `Error: ${err.message}`,
        factors: [],
        riskStatement: 'Risk information unavailable.',
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Build the list of factors that influenced the decision.
   */
  _buildFactors(decision, context) {
    const factors = [];
    const { contributingStrategies, regime, probabilities, riskAssessment, marketState } = context;

    // Strategy contributions
    if (contributingStrategies && contributingStrategies.length > 0) {
      const topStrategies = contributingStrategies.slice(0, 3);
      for (const s of topStrategies) {
        factors.push({
          type: 'strategy',
          name: s.strategy,
          side: s.side,
          confidence: s.confidence,
          description: `${s.strategy} voted ${s.side} with ${s.confidence}% confidence.`,
        });
      }
    }

    // Market regime
    if (regime) {
      factors.push({
        type: 'regime',
        name: regime.regime,
        confidence: regime.confidence,
        description: `Market regime identified as ${regime.name} (${regime.confidence}% confidence). ${regime.description}`,
      });
    }

    // Probability
    if (probabilities) {
      factors.push({
        type: 'probability',
        name: 'Directional Probability',
        confidence: probabilities.confidence,
        description: `Probability of price moving up: ${(probabilities.pUp * 100).toFixed(1)}%, down: ${(probabilities.pDown * 100).toFixed(1)}%. Expected move: ${probabilities.expectedMove}. Win probability: ${(probabilities.winProbability * 100).toFixed(1)}%.`,
      });
    }

    // Market state (volatility, liquidity)
    if (marketState) {
      const { volatility, liquidity, session } = marketState;
      if (volatility) {
        factors.push({
          type: 'volatility',
          name: 'Volatility Regime',
          confidence: 100,
          description: `Volatility is ${volatility.regime} (ATR: ${volatility.atr.toFixed(5)}).`,
        });
      }
      if (liquidity) {
        factors.push({
          type: 'liquidity',
          name: 'Liquidity',
          confidence: 100,
          description: `Liquidity quality: ${liquidity.quality}.`,
        });
      }
      if (session) {
        factors.push({
          type: 'session',
          name: 'Session',
          confidence: 100,
          description: `Trading session: ${session.name} (liquidity multiplier: ${session.liquidityMultiplier}).`,
        });
      }
    }

    // Risk assessment
    if (riskAssessment && riskAssessment.allowed) {
      factors.push({
        type: 'risk',
        name: 'Risk Assessment',
        confidence: 100,
        description: `Risk assessment passed. Adjusted lot size: ${riskAssessment.adjustedLotSize || decision.recommendedLotSize}. Confidence multiplier: ${riskAssessment.confidenceMultiplier || 1.0}.`,
      });
    }

    // Dissenting strategies
    if (context.dissentingStrategies && context.dissentingStrategies.length > 0) {
      for (const d of context.dissentingStrategies) {
        factors.push({
          type: 'dissenting',
          name: d.strategy,
          side: d.side,
          confidence: d.confidence,
          description: `${d.strategy} dissented, voting ${d.side} with ${d.confidence}% confidence.`,
        });
      }
    }

    return factors;
  }

  /**
   * Build the detailed reason string.
   */
  _buildDetailedReason(side, factors, regime, confidence) {
    const regimeStr = regime ? regime.regime : 'unknown';
    const drivers = factors
      .filter(f => f.type === 'strategy' || f.type === 'probability')
      .map(f => f.description)
      .join('; ');

    const template = side === 'BUY' || side === 'SELL' ? this._templates[side] : this._templates.NO_TRADE;
    let reason = template.detail
      .replace(/{reasons}/g, drivers || 'no specific drivers')
      .replace(/{regime}/g, regimeStr)
      .replace(/{confidence}/g, confidence)
      .replace(/{drivers}/g, drivers)
      .replace(/{risk}/g, 'see risk statement');

    return reason;
  }

  /**
   * Build the risk statement.
   */
  _buildRiskStatement(stopLoss, takeProfit, entryPrice, lotSize, riskAssessment) {
    const stopDistance = Math.abs(entryPrice - stopLoss);
    const takeDistance = Math.abs(takeProfit - entryPrice);
    const rr = stopDistance > 0 ? (takeDistance / stopDistance).toFixed(2) : 'N/A';
    const riskAmount = lotSize * stopDistance; // approximate
    const rewardAmount = lotSize * takeDistance;

    let statement = `Stop-loss at ${stopLoss.toFixed(5)}, take-profit at ${takeProfit.toFixed(5)}. ` +
      `Risk-reward ratio: ${rr}. ` +
      `Estimated risk: ${riskAmount.toFixed(2)} units, reward: ${rewardAmount.toFixed(2)} units. ` +
      `Lot size: ${lotSize.toFixed(2)}.`;

    if (riskAssessment) {
      statement += ` Risk assessment: ${riskAssessment.reason}`;
    }

    return statement;
  }

  /**
   * Build the summary.
   */
  _buildSummary(side, factors, regime, confidence) {
    const topFactors = factors
      .filter(f => f.type === 'strategy')
      .slice(0, 2)
      .map(f => f.name)
      .join(' and ');

    const regimeStr = regime ? regime.regime : 'unknown';

    if (side === 'BUY' || side === 'SELL') {
      return `${side} signal for ${regimeStr} market (${confidence}% confidence). ` +
        `Key strategies: ${topFactors || 'none'}. ` +
        `Confidence supported by ${factors.length} factors.`;
    } else {
      return `No trade. Insufficient evidence or conflicting signals. ` +
        `Factors: ${factors.length} factors considered. ` +
        `Regime: ${regimeStr}.`;
    }
  }

  /**
   * Generate a short alert message for notifications.
   */
  generateAlert(explanation) {
    const { symbol, decision, confidence, entryPrice, stopLoss, takeProfit } = explanation;
    if (decision === 'BUY' || decision === 'SELL') {
      return `${decision} ${symbol} (${confidence}%) @ ${entryPrice.toFixed(5)} | SL: ${stopLoss.toFixed(5)} | TP: ${takeProfit.toFixed(5)}`;
    } else {
      return `No trade signal for ${symbol}.`;
    }
  }
}

// Singleton
const explainabilityEngine = new ExplainabilityEngine();
module.exports = explainabilityEngine;
