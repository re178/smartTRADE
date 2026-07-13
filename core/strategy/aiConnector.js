// src/core/strategy/aiConnector.js – AI Connector for Trading Signals
// Uses the AI provider from src/shared/aiProvider.js

const { generateSmart } = require('../../shared/aiProvider');
const logger = require('../../infrastructure/logger') || console;

/**
 * Build a prompt for AI based on market data.
 * The prompt includes candles, indicators, and context.
 * @param {string} instrument – e.g., 'EUR_USD'
 * @param {Array} candles – array of candle objects
 * @param {Object} indicators – computed indicators
 * @returns {string} Prompt string.
 */
function buildAIPrompt(instrument, candles, indicators) {
  // Get the last 30 candles for context (reduce token usage)
  const lastCandles = candles.slice(-30).map(c => ({
    time: new Date(c.time * 1000).toISOString(),
    open: parseFloat(c.mid.o).toFixed(5),
    high: parseFloat(c.mid.h).toFixed(5),
    low: parseFloat(c.mid.l).toFixed(5),
    close: parseFloat(c.mid.c).toFixed(5),
  }));

  // Format indicators with clear labels
  const indStr = Object.entries(indicators)
    .filter(([_, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toFixed(4) : v}`)
    .join('\n');

  return `
You are a professional trading analyst. Based on the following market data for ${instrument}, generate a trading signal.

Recent OHLC candles (last 30, most recent last):
${JSON.stringify(lastCandles, null, 2)}

Technical indicators (latest values):
${indStr}

Return ONLY a JSON object with the following fields:
{
  "signal": "BUY" | "SELL" | "HOLD",
  "confidence": number (0-100),
  "reason": "brief explanation (max 50 words)",
  "stopLoss": number (optional, recommended stop loss price),
  "takeProfit": number (optional, recommended take profit price)
}

If you are uncertain, return HOLD with a low confidence.
`;
}

/**
 * Get AI trading signal.
 * @param {string} instrument – e.g., 'EUR_USD'
 * @param {Array} candles – full candle array
 * @param {Object} indicators – computed indicators
 * @returns {Promise<Object|null>} Signal object or null.
 */
async function getAISignal(instrument, candles, indicators) {
  try {
    const prompt = buildAIPrompt(instrument, candles, indicators);
    logger.debug('[AI] Sending prompt (truncated):', prompt.substring(0, 500) + '...');

    const rawResponse = await generateSmart(prompt);
    logger.debug('[AI] Raw response:', rawResponse);

    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = rawResponse;
    const jsonMatch = rawResponse.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    } else {
      // Try to find raw JSON
      const rawMatch = rawResponse.match(/\{[\s\S]*\}/);
      if (rawMatch) jsonStr = rawMatch[0];
    }

    // Clean and parse
    jsonStr = jsonStr.replace(/,\s*}/g, '}').replace(/,\s*\]/g, ']');
    const parsed = JSON.parse(jsonStr);

    // Validate required fields
    if (!parsed.signal || !['BUY', 'SELL', 'HOLD'].includes(parsed.signal)) {
      logger.warn('[AI] Invalid signal from AI:', parsed.signal);
      return null;
    }

    // If HOLD, return null (no trade)
    if (parsed.signal === 'HOLD') {
      logger.info('[AI] AI returned HOLD signal.');
      return null;
    }

    // Confidence must be between 0-100
    const confidence = Math.min(100, Math.max(0, parsed.confidence || 50));

    return {
      side: parsed.signal,
      confidence,
      reason: parsed.reason || 'AI analysis',
      stopLoss: parsed.stopLoss || null,
      takeProfit: parsed.takeProfit || null,
    };
  } catch (error) {
    logger.error('[AI] Failed to get signal:', error.message);
    logger.debug('[AI] Raw response that caused error:', rawResponse);
    return null;
  }
}

module.exports = {
  getAISignal,
};
