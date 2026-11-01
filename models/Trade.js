// models/Trade.js
// Trade schema for tracking open and closed trades.
// EXTENDED: Added Multiplier-specific fields.
//
// [CHANGE-3A] contractId is now a String. Deriv contract IDs are opaque
//   identifiers, not numeric quantities. Existing documents were written
//   under the old Number type; run the Number→String migration (see
//   deploy notes) before this schema goes live. All code that queries by
//   contractId should pass String(contractId) for compatibility.
// [CHANGE-3B] Added purchasePrice — the amount actually paid to Deriv
//   for the contract. Distinct from openPrice (the underlying market
//   entry spot). Populated for Multiplier trades; null for CFD.
//
// [FIX-DIGIT-PERSIST] contractService.placeDigitOrBinary was failing to save
//   both Order and Trade documents for every digit/binary contract
//   (CALL/PUT/DIGITEVEN/DIGITODD/DIGITOVER/DIGITUNDER/DIGITMATCH/DIGITDIFF/
//   ONETOUCH/NOTOUCH). Two root causes:
//     1. side was sent as 'call'/'digiteven'/etc. — not in the enum.
//        contractService now normalizes side to 'buy'/'sell' and stores the
//        specific contract in contractType (added below).
//     2. entryThesis was a rigid subobject that rejected the rich prediction
//        snapshot the runner sends (pattern/momentum/volatility/digitView/
//        flip/phaseStats/edgeTest/session/strategyConsensus/botId/instanceId/
//        reasons) — plus rejected direction values 'BUY'/'SELL' vs. the old
//        enum ['up','down','neutral']. Now Mixed, preserves everything.
//   Also added contractType, barrier, durationUnit so digit/binary trades
//   can be fully reconstructed from the Trade record alone.

const mongoose = require('mongoose');

const TradeSchema = new mongoose.Schema(
  {
    // ---- Contract identity ----
    // [CHANGE-3A] String, not Number. Treat as an opaque identifier.
    contractId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      description: 'Deriv contract ID (unique per trade; opaque identifier)',
    },
    instrument: {
      type: String,
      required: true,
      index: true,
      description: 'Symbol, e.g., EURUSD or R_100',
    },
    side: {
      type: String,
      enum: ['buy', 'sell'],
      required: true,
      description: 'Direction: buy (price up / positive bet) or sell (price down / negative bet)',
    },
    // [FIX-DIGIT-PERSIST] Specific Deriv contract type. null for legacy CFD.
    contractType: {
      type: String,
      default: null,
      index: true,
      description: 'MULTUP / MULTDOWN / CALL / PUT / DIGITEVEN / DIGITODD / DIGITOVER / DIGITUNDER / DIGITMATCH / DIGITDIFF / ONETOUCH / NOTOUCH',
    },
    // [FIX-DIGIT-PERSIST] Digit/touch barrier (e.g. '5' for DIGITMATCH,
    // '8' for DIGITOVER, '0' for DIGITUNDER). null when not applicable.
    barrier: {
      type: String,
      default: null,
      description: 'Barrier used for digit/touch contracts (0-9 for digits)',
    },
    lotSize: {
      type: Number,
      required: true,
      min: 0,
      description: 'Trade volume in lots (or stake for multiplier/digit contracts)',
    },
    openPrice: {
      type: Number,
      required: true,
      description: 'Underlying market entry price when the trade was opened',
    },
    closePrice: {
      type: Number,
      default: null,
      description: 'Price at which the trade was closed (null if still open)',
    },
    status: {
      type: String,
      enum: ['OPEN', 'CLOSED', 'PENDING', 'CANCELLED'],
      default: 'OPEN',
      required: true,
      index: true,
      description: 'Current trade status',
    },
    openTime: {
      type: Date,
      required: true,
      description: 'Timestamp when the trade was opened',
    },
    closeTime: {
      type: Date,
      default: null,
      description: 'Timestamp when the trade was closed (null if still open)',
    },

    // ---- P&L ----
    floatingProfit: {
      type: Number,
      default: 0,
      description: 'Current unrealised profit/loss',
    },
    realizedProfit: {
      type: Number,
      default: 0,
      description: 'Final realised profit/loss after close',
    },
    pnl: {
      type: Number,
      default: 0,
      description: 'Alias for realised profit (used by orderService)',
    },

    // ---- MT5 extra fields ----
    stopLoss: { type: Number, default: 0 },
    takeProfit: { type: Number, default: 0 },
    swap: { type: Number, default: 0 },
    commission: { type: Number, default: 0 },
    margin: { type: Number, default: 0 },
    magic: { type: Number, default: 0 },
    comment: { type: String, default: '' },
    dealId: {
      type: Number,
      default: null,
      description: 'MT5 deal ID for the closing transaction',
    },

    // ---- Strategy & decision lineage ----
    decisionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'HistoricalDecision',
      default: null,
      index: true,
      description: 'Reference to the decision that generated this trade',
    },
    strategy: {
      type: String,
      default: null,
      description: 'Strategy or bot ID that opened this trade (e.g. "trend_rider")',
    },
    product: {
      type: String,
      default: 'FX',
      description: 'Product type: deriv_multiplier / deriv_digital / FX',
    },

    // ---- Internal sync state ----
    pendingClose: {
      type: Boolean,
      default: false,
      index: true,
      description: 'True if the trade is no longer reported by MT5 but not yet closed in DB',
    },

    // ---- Account linkage ----
    login: {
      type: Number,
      index: true,
      description: 'MT5 login number for filtering',
    },

    // ---- Current price (convenience) ----
    currentPrice: {
      type: Number,
      default: null,
      description: 'Last known current price from the live contract stream',
    },

    // ---- MAE/MFE (optional, for analytics) ----
    mae: { type: Number, default: 0 },
    mfe: { type: Number, default: 0 },

    // ---- OTIE V5 fields ----
    atrAtEntry: {
      type: Number,
      default: null,
      description: 'ATR value at the time the trade was opened (used for R calculation)',
    },
    riskAmount: {
      type: Number,
      default: null,
      description: 'Risk amount in account currency (used for R calculation)',
    },
    maxFloatingProfit: {
      type: Number,
      default: 0,
      description: 'Maximum unrealized profit reached (in account currency)',
    },

    // =============================================================
    //  MULTIPLIER & DIGIT TRADING FIELDS
    // =============================================================
    stake: {
      type: Number,
      default: null,
      description: 'Stake amount in account currency',
    },
    multiplier: {
      type: Number,
      default: null,
      description: 'Multiplier applied to the stake (null for digit/binary)',
    },
    duration: {
      type: Number,
      default: null,
      description: 'Contract duration (value in units of durationUnit)',
    },
    // [FIX-DIGIT-PERSIST] 's' for seconds (multiplier) or 't' for ticks
    // (digit/binary). Was previously missing from the schema — silently
    // dropped on every save.
    durationUnit: {
      type: String,
      default: null,
      description: "Duration unit: 's' (seconds) or 't' (ticks)",
    },
    knockoutLevel: {
      type: Number,
      default: null,
      description: 'Knockout price level (for Multiplier trades)',
    },
    takeProfitLevel: {
      type: Number,
      default: null,
      description: 'Take-profit price level (for Multiplier trades)',
    },

    // ---- [CHANGE-3B] Contract purchase cost ----
    purchasePrice: {
      type: Number,
      default: null,
      min: 0,
      description: 'Amount paid to purchase the Deriv contract',
    },

    // ---- [FIX-DIGIT-PERSIST] Entry Thesis (free-form snapshot) ----
    // Populated by contractService._persist with the runner's full snapshot:
    //   FX bots:   { botId, instanceId, reasons, edgeTest, session, flip,
    //                phaseStats, confidence, direction, pattern, momentum,
    //                volatility, regime, regimeConfidence, strategyConsensus }
    //   Digit bots: { botId, instanceId, reasons, edgeTest, session, flip,
    //                 phaseStats, digitView }
    // Previously typed as a rigid subobject that rejected everything except
    // 6 legacy fields and failed on direction='BUY'/'SELL' (enum only
    // allowed 'up'/'down'/'neutral'). Now Mixed — full snapshot preserved.
    entryThesis: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    // ---- Trade Economics (snapshot at entry) ----
    tradeEconomicsAtEntry: {
      expectedValue: { type: Number, default: null },
      evOverStake: { type: Number, default: null },
      probabilityOfProfit: { type: Number, default: null },
      probabilityOfLoss: { type: Number, default: null },
    },

    // ---- Thesis Monitor State ----
    thesisMonitorState: {
      lastEvaluation: { type: Date, default: null },
      thesisValid: { type: Boolean, default: true },
      reason: { type: String, default: '' },
    },
  },
  {
    timestamps: true,
  }
);

// ---- Indexes ----
TradeSchema.index({ login: 1, status: 1 });
TradeSchema.index({ contractId: 1, status: 1 });
TradeSchema.index({ decisionId: 1 });
TradeSchema.index({ openTime: -1 });
TradeSchema.index({ closeTime: -1 });
TradeSchema.index({ stake: 1, multiplier: 1 });
TradeSchema.index({ knockoutLevel: 1 });
TradeSchema.index({ 'thesisMonitorState.thesisValid': 1 });
// [FIX-DIGIT-PERSIST] New index for digit-specific queries (e.g. per-bot
// per-contract-type analytics, reconciliation filters).
TradeSchema.index({ contractType: 1, status: 1 });

module.exports = mongoose.model('Trade', TradeSchema);
