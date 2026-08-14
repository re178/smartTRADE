// models/LearningState.js
// Persists learned weights, biases, and calibration data for the SelfLearner.
// EXTENDED: Added prediction calibration and threshold adjustment fields.

const mongoose = require('mongoose');

const LearningStateSchema = new mongoose.Schema(
  {
    // ---- Strategy weights (legacy) ----
    strategy: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    weight: {
      type: Number,
      default: 0.1,
      min: 0,
      max: 1,
    },
    bias: {
      type: Number,
      default: 0,
    },
    winRate: {
      type: Number,
      default: 0,
      min: 0,
      max: 1,
    },
    totalTrades: {
      type: Number,
      default: 0,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },

    // =============================================================
    //  NEW FIELDS FOR PREDICTION CALIBRATION
    // =============================================================
    // ---- Calibration curve data ----
    // Stores calibration buckets: e.g., [ { bucket: 60, predicted: 0.60, actual: 0.55, sampleSize: 120 } ]
    predictionCalibration: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
      description: 'Array of calibration buckets with predicted vs actual win rates',
    },

    // ---- Adaptive thresholds ----
    // Minimum probability required for a trade (adjusts based on calibration)
    minProbabilityThreshold: {
      type: Number,
      default: 0.55,
      min: 0,
      max: 1,
    },
    // Minimum expected value (EV) required
    minEVThreshold: {
      type: Number,
      default: 0.0,
    },
    // Minimum sample size required for a prediction to be considered
    minSampleSizeThreshold: {
      type: Number,
      default: 20,
    },
    // Maximum allowed MAE (as a fraction of expected move)
    maxMAEThreshold: {
      type: Number,
      default: 0.5,
    },
    // Minimum market quality score
    minMarketQualityThreshold: {
      type: Number,
      default: 40,
    },

    // ---- Feature distance weights (learned) ----
    // Dynamically adjusted based on feature importance
    featureWeights: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      description: 'Per-feature weights for similarity distance (learned from outcomes)',
    },

    // ---- Last calibration run ----
    lastCalibrationRun: {
      type: Date,
      default: null,
      description: 'Timestamp of the last full calibration update',
    },

    // ---- Metadata ----
    version: {
      type: String,
      default: '2.0',
    },
  },
  {
    timestamps: true,
  }
);

// ---- Indexes ----
LearningStateSchema.index({ strategy: 1 });
LearningStateSchema.index({ updatedAt: -1 });
LearningStateSchema.index({ lastCalibrationRun: -1 });

module.exports = mongoose.model('LearningState', LearningStateSchema);
