// models/TradeManagementDecision.js
const mongoose = require('mongoose');

const TradeManagementDecisionSchema = new mongoose.Schema(
  {
    tradeId: {
      type: String, // or Number (contractId)
      required: true,
      index: true,
      description: 'Reference to the trade (contractId)',
    },
    symbol: {
      type: String,
      required: true,
      index: true,
      description: 'Instrument symbol',
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
      description: 'Time of decision',
    },

    // ---- Market state snapshot ----
    marketState: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      description: 'Full market state at decision time (price, trend, momentum, etc.)',
    },

    // ---- Trade state probabilities ----
    tradeStateProbs: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      description: 'Probabilities of each trade state (e.g., ACCELERATING: 0.68)',
    },

    // ---- Prediction ----
    prediction: {
      continuationProbability: Number,
      reversalProbability: Number,
      confidence: Number,
      expectedDirection: Number,
    },

    // ---- Historical analogue summary ----
    analogueSummary: {
      sampleSize: Number,
      winRate: Number,
      avgReturnR: Number,
      survivalProb: Number,
      // other fields as needed
    },

    // ---- Candidate actions ----
    candidateActions: [
      {
        type: { type: String, enum: ['HOLD', 'MODIFY', 'PARTIAL', 'CLOSE', 'OPEN'] },
        ev: Number, // expected value
        confidence: Number,
        reason: String,
        proposedParams: {
          stopLoss: Number,
          takeProfit: Number,
          volume: Number,
        },
      },
    ],

    // ---- Chosen action ----
    chosenAction: {
      type: { type: String, enum: ['HOLD', 'MODIFY', 'PARTIAL', 'CLOSE', 'OPEN'] },
      ev: Number,
      confidence: Number,
      reason: String,
      executedParams: {
        stopLoss: Number,
        takeProfit: Number,
        volume: Number,
      },
      executed: { type: Boolean, default: false },
    },

    // ---- Scores (Continuous Trade Scores) ----
    scores: {
      health: Number,
      trendStrength: Number,
      momentum: Number,
      liquidity: Number,
      historicalEdge: Number,
      opportunity: Number,
      risk: Number,
      confidence: Number,
      holdProb: Number,
      exitProb: Number,
      scaleProb: Number,
      tradeAge: Number,
      sessionRemaining: Number,
      isFriday: Number,
    },

    // ---- Cost model output ----
    cost: {
      spreadCost: Number,
      commission: Number,
      swap: Number,
      totalCost: Number,
      costR: Number,
    },

    // ---- Outcome (filled later) ----
    outcome: {
      profitR: Number,
      maxProfitR: Number,
      pce: Number, // Profit Capture Efficiency
      success: Boolean,
    },

    // ---- Regret (counterfactual) ----
    regret: {
      actualProfit: Number,
      potentialProfit: Number,
      missedProfit: Number,
      efficiency: Number,
    },
  },
  {
    timestamps: true,
  }
);

// ---- Indexes ----
TradeManagementDecisionSchema.index({ tradeId: 1, timestamp: -1 });
TradeManagementDecisionSchema.index({ symbol: 1, timestamp: -1 });
TradeManagementDecisionSchema.index({ 'chosenAction.type': 1 });

module.exports = mongoose.model('TradeManagementDecision', TradeManagementDecisionSchema);
