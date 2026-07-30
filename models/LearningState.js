// models/LearningState.js – Persistence for Self‑Learner weights and biases

const mongoose = require('mongoose');

const LearningStateSchema = new mongoose.Schema(
  {
    strategy: {
      type: String,
      required: true,
      unique: true,
      trim: true,
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
      min: 0,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true, // adds createdAt and updatedAt automatically
  }
);

// Compound index for fast lookups
LearningStateSchema.index({ strategy: 1 });

module.exports = mongoose.model('LearningState', LearningStateSchema);
