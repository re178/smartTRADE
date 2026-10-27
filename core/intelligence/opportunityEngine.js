// core/intelligence/opportunityEngine.js – Trade Filter
// Evaluates whether a prediction is tradeable and selects the best
// multiplier. Uses ATR-based path simulation (no historical analogues).
//
// Routes by prediction.modeLabel:
//   • conflict          → NO_TRADE STRATEGY_CONFLICT
//   • no_data           → NO_TRADE NO_DATA
//   • strategy_only     → strategy-consensus gate (2+ agree, valid levels)
//   • combined / pattern_only / analogue_only → ATR path simulation
//
// Every candidate multiplier is evaluated on 500 synthetic ATR-drawn paths.
// No historical state is consulted.

'use strict';

const riskEngine = require('../risk/riskEngine');
const { getPipSize } = require('../../shared/helpers');
const logger = require('../../infrastructure
