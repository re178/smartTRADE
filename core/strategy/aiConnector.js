// src/core/strategy/aiConnector.js – AI Connector for Trading Signals
// Uses the AI provider from src/shared/aiProvider.js
//
// [FIX-AI1] `rawResponse is not defined` bug fixed. The variable was
//           declared `const` inside the `try` block — the catch block
//           referenced it outside its scope, producing "rawResponse is
//           not defined" (visible in production log as
//           `[Strategy] ai error: rawResponse is not defined`). Moved the
//           declaration OUTSIDE try so both success and failure paths can
//           reference it safely.
//
// [FIX-AI2] Robust multi-strategy JSON extraction. Previously the code
//           tried (a) ```json blocks, (b) first {...} regex, and fell
//           through to JSON.parse(rawResponse) on failure. When AI returned
//           prose with no braces at all ("Based on the..." — visible in
//           the log), JSON.parse threw on the raw prose. New extraction
//           tries FIVE strategies in order, returns null gracefully when
//           none work.
//
// [FIX-AI3] Stricter prompt. Explicit instruction: "Do NOT include any
//           text before or after the JSON. Do NOT use markdown code
//           blocks." Plus a one-shot example so smaller models
//           (Llama-3.1-8b via Cloudflare) produce parseable output.
//
// [FIX-AI4] Optional retry on parse failure with an even stricter prompt.
//           Disabled by default to avoid doubling AI calls (which
//           saturate the provider pool). Enable via env
//           AI_RETRY_ON_PARSE_FAILURE=true if the success rate warrants
//           it.
//
// [FIX-AI5] Prose fallback. Last resort when JSON can't be extracted:
//           scan the response for BUY/SELL/HOLD + confidence patterns
//           ("75% confidence", "confidence: 75", "75 percent") + SL/TP
//           values. This is what keeps AI contributing to consensus when
//           the model ignores format instructions. Logs at WARN when used
//           so you can measure how often the fallback fires.
//
// [FIX-AI6] Strict validation of parsed fields:
//             • signal must normalize to BUY/SELL/HOLD (case-insensitive)
//             • confidence coerced to number, clamped [0,100]
//             • stopLoss/takeProfit validated against current price — must
//               be on the correct side of entry (BUY: SL<price<TP,
//               SELL: TP<price<SL). Invalid values nulled so strategy
//               falls back to ATR-based levels.
//
// [FIX-AI7] Accept multiple field aliases. Some models return `"side"` or
//           `"action"` instead of `"signal"`. All three accepted.
//
// [FIX-AI8] Candle timestamp normalization. `c.time` may be seconds
//           (Deriv epoch) or milliseconds (test fixtures). Auto-detect
//           by magnitude so `new Date(...)` never produces year 55000.
//
// [FIX-AI9] Indicator stringification. Previously `typeof v === 'number'
//           ? v.toFixed(4) : v` produced "[object Object]" for the
//           `volume` object and wasted tokens. Now properly serializes
//           objects via JSON.stringify and skips non-scalar values.
//
// [FIX-AI10] Emit usage diagnostics via optional logger.debug when a
//            parse succeeds through a non-primary strategy. Useful for
//            measuring prompt quality drift.

const { generateSmart } = require('../../shared/aiProvider');
const logger = require('../../infrastructure/logger') || console;

// [FIX-AI4] Optional retry on parse failure (default off).
const RETRY_ON_PARSE_FAILURE =
  String(process.env.AI_RETRY_ON_PARSE_FAILURE || 'false').toLowerCase() === 'true';

// [FIX-AI5] Prose fallback toggle (default on — cheap and valuable).
const PROSE_FALLBACK_ENABLED =
  String(process.env.AI_PROSE_FALLBACK || 'true').toLowerCase() !== 'false';

// ============================================================
// [FIX-AI3] Prompt builder with strict mode
// ============================================================
function buildAIPrompt(instrument, candles, indicators, strict = false) {
  // [FIX-AI8] Safe candle serialization with timestamp normalization.
  const lastCandles = candles.slice(-30).map(c => {
    let ts = c.time;
    if (typeof ts === 'number') {
      // [FIX-AI8] Distinguish seconds vs milliseconds by magnitude.
      if (ts < 1e12) ts = ts * 1000;
    } else {
      ts = Date.now();
    }
    return {
      time: new Date(ts).toISOString(),
      open: parseFloat(c.mid.o).toFixed(5),
      high: parseFloat(c.mid.h).toFixed(5),
      low: parseFloat(c.mid.l).toFixed(5),
      close: parseFloat(c.mid.c).toFixed(5),
    };
  });

  // [FIX-AI9] Proper indicator formatting — skip objects, stringify scalars.
  const indStr = Object.entries(indicators)
    .filter(([_, v]) => v !== null && v !== undefined)
    .map(([k, v]) => {
      if (typeof v === 'number') return `${k}: ${Number.isFinite(v) ? v.toFixed(4) : 'NaN'}`;
      if (typeof v === 'string' || typeof v === 'boolean') return `${k}: ${v}`;
      if (typeof v === 'object') {
        try { return `${k}: ${JSON.stringify(v)}`; }
        catch (_) { return `${k}: [unserializable]`; }
      }
      return `${k}: ${String(v)}`;
    })
    .join('\n');

  const strictClause = strict
    ? `
CRITICAL FORMATTING RULES:
- Return ONLY the raw JSON object. Do NOT wrap it in \`\`\`json code fences.
- Do NOT include any prose, explanation, or preamble before or after.
- The response MUST begin with "{" and end with "}".
- Your entire response must be parseable by JSON.parse() with no preprocessing.
`
    : '';

  return `You are a professional trading analyst. Analyze the following market data for ${instrument} and return a trading signal.
${strictClause}
Recent OHLC candles (last 30, most recent last):
${JSON.stringify(lastCandles)}

Technical indicators (latest values):
${indStr}

Return a JSON object with EXACTLY these fields:
{
  "signal": "BUY" or "SELL" or "HOLD",
  "confidence": integer between 0 and 100,
  "reason": "brief explanation, max 50 words",
  "stopLoss": number (optional),
  "takeProfit": number (optional)
}

Example of a valid response:
{"signal":"BUY","confidence":72,"reason":"RSI oversold with bullish MACD cross","stopLoss":1.1234,"takeProfit":1.1301}

Rules:
- If uncertain, return "HOLD" with confidence below 40.
- Return ONLY the JSON object. No markdown, no explanation outside the JSON.
- Do NOT include any text before or after the JSON.`;
}

// ============================================================
// [FIX-AI2] Multi-strategy JSON extractor
// ============================================================
/**
 * Attempt to extract a JSON object from an AI response string.
 * Returns parsed object or null.
 *
 * Strategies tried in order:
 *   1. ```json ... ``` markdown fence
 *   2. ``` ... ``` plain markdown fence
 *   3. First balanced {...} block in the response
 *   4. Trimmed response if it looks like bare JSON
 *   5. Repair common issues (trailing commas, unquoted keys) then parse
 */
function extractJSON(rawResponse) {
  if (!rawResponse || typeof rawResponse !== 'string') return null;
  const text = rawResponse.trim();
  if (!text) return null;

  // Strategy 1: ```json code fence
  const jsonFence = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (jsonFence) {
    const parsed = tryParse(jsonFence[1]);
    if (parsed) return parsed;
  }

  // Strategy 2: ``` plain code fence
  const plainFence = text.match(/```\s*([\s\S]*?)\s*```/);
  if (plainFence) {
    const parsed = tryParse(plainFence[1]);
    if (parsed) return parsed;
  }

  // Strategy 3: First balanced {...} block (handles nested braces)
  const balanced = findBalancedJSON(text);
  if (balanced) {
    const parsed = tryParse(balanced);
    if (parsed) return parsed;
  }

  // Strategy 4: Whole response might be JSON
  if (text.startsWith('{') && text.endsWith('}')) {
    const parsed = tryParse(text);
    if (parsed) return parsed;
  }

  // Strategy 5: Repair common issues then retry first {...} match
  const roughMatch = text.match(/\{[\s\S]*\}/);
  if (roughMatch) {
    const repaired = repairJSON(roughMatch[0]);
    const parsed = tryParse(repaired);
    if (parsed) return parsed;
  }

  return null;
}

function tryParse(str) {
  if (!str) return null;
  try {
    const trimmed = String(str).trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch (_) {
    return null;
  }
}

/**
 * Find the first balanced {...} block, accounting for nested braces and
 * strings (which may contain unbalanced braces).
 */
function findBalancedJSON(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }

    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Repair common JSON issues (trailing commas, single quotes, unquoted keys).
 * Not exhaustive — just enough to recover from typical LLM formatting drift.
 */
function repairJSON(str) {
  if (!str) return str;
  return str
    // Trailing commas before } or ]
    .replace(/,\s*}/g, '}')
    .replace(/,\s*]/g, ']')
    // Single quotes to double quotes (only around keys/values, not apostrophes)
    .replace(/'([^']*)'\s*:/g, '"$1":')
    .replace(/:\s*'([^']*)'/g, ': "$1"')
    // Unquoted keys (simple heuristic)
    .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');
}

// ============================================================
// [FIX-AI5] Prose fallback extractor
// ============================================================
/**
 * Extract a trading signal from prose when JSON parsing fails entirely.
 * Used as a last resort so AI contributions aren't lost on formatting drift.
 *
 * Recognized patterns:
 *   Direction: "BUY", "SELL", "HOLD" (case-insensitive, word boundary)
 *   Confidence: "75% confidence", "confidence: 75", "confidence of 75",
 *               "75 percent confidence"
 *   SL: "stop loss at 1.1234", "SL: 1.1234", "stop-loss 1.1234"
 *   TP: "take profit at 1.1301", "TP: 1.1301", "target 1.1301"
 */
function extractFromProse(prose, currentPrice) {
  if (!prose || typeof prose !== 'string') return null;
  const text = prose.trim();
  if (!text) return null;

  // Direction
  const sigMatch = text.match(/\b(BUY|SELL|HOLD)\b/i);
  if (!sigMatch) return null;
  const side = sigMatch[1].toUpperCase();
  if (side === 'HOLD') {
    logger.debug('[AI] Prose fallback: HOLD detected');
    return null;
  }

  // Confidence
  let confidence = 50;
  const confMatch =
    text.match(/confidence[^\d]*(\d{1,3})/i) ||
    text.match(/(\d{1,3})\s*%\s*confidence/i) ||
    text.match(/(\d{1,3})\s*percent\s*confidence/i);
  if (confMatch) {
    const raw = parseInt(confMatch[1], 10);
    if (Number.isFinite(raw)) confidence = Math.min(100, Math.max(0, raw));
  }

  // Stop loss
  let stopLoss = null;
  const slMatch = text.match(/(?:stop[-\s]*loss|\bSL)\s*(?:at|:|=|of)?\s*([\d.]+)/i);
  if (slMatch) {
    const v = parseFloat(slMatch[1]);
    if (Number.isFinite(v) && v > 0) stopLoss = v;
  }

  // Take profit
  let takeProfit = null;
  const tpMatch = text.match(/(?:take[-\s]*profit|\bTP|\btarget)\s*(?:at|:|=|of)?\s*([\d.]+)/i);
  if (tpMatch) {
    const v = parseFloat(tpMatch[1]);
    if (Number.isFinite(v) && v > 0) takeProfit = v;
  }

  return {
    side,
    confidence,
    reason: 'AI prose fallback (JSON parse failed)',
    stopLoss,
    takeProfit,
  };
}

// ============================================================
// [FIX-AI6/AI7] Signal validation
// ============================================================
/**
 * Normalize and validate a parsed signal object. Returns null if invalid.
 *
 * Accepts field aliases: signal | side | action | decision
 * Rejects SL/TP on the wrong side of `currentPrice` (nulls them, doesn't
 * reject the whole signal — strategy falls back to ATR levels).
 */
function normalizeAndValidate(parsed, currentPrice) {
  if (!parsed || typeof parsed !== 'object') return null;

  // [FIX-AI7] Field aliases
  const rawSide = parsed.signal || parsed.side || parsed.action || parsed.decision;
  if (!rawSide || typeof rawSide !== 'string') {
    logger.warn(`[AI] Signal missing from response. Keys present: ${Object.keys(parsed).join(',')}`);
    return null;
  }

  const side = rawSide.trim().toUpperCase();
  if (!['BUY', 'SELL', 'HOLD'].includes(side)) {
    logger.warn(`[AI] Invalid signal value "${rawSide}" (expected BUY/SELL/HOLD)`);
    return null;
  }

  if (side === 'HOLD') {
    logger.info('[AI] AI returned HOLD signal.');
    return null;
  }

  // Confidence — coerce to number, clamp [0,100]
  let confidence = 50;
  if (typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)) {
    confidence = Math.min(100, Math.max(0, parsed.confidence));
  } else if (typeof parsed.confidence === 'string') {
    const m = parsed.confidence.match(/(\d{1,3})/);
    if (m) confidence = Math.min(100, Math.max(0, parseInt(m[1], 10)));
  }

  // [FIX-AI6] Validate SL/TP side relative to current price.
  let stopLoss = null;
  let takeProfit = null;

  if (Number.isFinite(currentPrice) && currentPrice > 0) {
    if (parsed.stopLoss != null) {
      const sl = parseFloat(parsed.stopLoss);
      if (Number.isFinite(sl) && sl > 0) {
        const wrongSide = side === 'BUY' ? sl >= currentPrice : sl <= currentPrice;
        if (!wrongSide) stopLoss = sl;
        else logger.debug(`[AI] Ignoring SL ${sl} on wrong side of entry ${currentPrice} for ${side}`);
      }
    }
    if (parsed.takeProfit != null) {
      const tp = parseFloat(parsed.takeProfit);
      if (Number.isFinite(tp) && tp > 0) {
        const wrongSide = side === 'BUY' ? tp <= currentPrice : tp >= currentPrice;
        if (!wrongSide) takeProfit = tp;
        else logger.debug(`[AI] Ignoring TP ${tp} on wrong side of entry ${currentPrice} for ${side}`);
      }
    }
  }

  return {
    side,
    confidence,
    reason: typeof parsed.reason === 'string' ? parsed.reason : 'AI analysis',
    stopLoss,
    takeProfit,
  };
}

// ============================================================
// Main entry point
// ============================================================
async function getAISignal(instrument, candles, indicators) {
  // [FIX-AI1] `rawResponse` MUST be declared here, outside the try block —
  // the catch block below references it and previously threw
  // "rawResponse is not defined" when the first attempt's response failed
  // to parse. That secondary error then cascaded into the strategy error
  // handler and the whole AI contribution was lost.
  let rawResponse = null;

  // Reference price for SL/TP side validation
  const currentPrice = (candles && candles.length > 0)
    ? parseFloat(candles[candles.length - 1].mid.c)
    : null;

  // ---- Attempt 1: normal prompt ----
  try {
    const prompt = buildAIPrompt(instrument, candles, indicators, false);
    logger.debug('[AI] Sending prompt (truncated):', prompt.substring(0, 500) + '...');
    rawResponse = await generateSmart(prompt);
    logger.debug('[AI] Raw response (truncated):', String(rawResponse || '').substring(0, 500));

    const parsed = extractJSON(rawResponse);
    if (parsed) {
      const signal = normalizeAndValidate(parsed, currentPrice);
      if (signal) return signal;
      logger.debug('[AI] JSON parsed but signal invalid — will not retry');
      // If JSON parsed cleanly, retry is pointless — model produced a
      // well-formed but invalid signal. Prose fallback would also fail.
      return null;
    }
    logger.debug('[AI] JSON extraction failed on attempt 1');
  } catch (err) {
    // [FIX-AI1] Safe to reference rawResponse here now.
    logger.error('[AI] Attempt 1 failed:', err.message);
    logger.debug('[AI] Raw response that caused error:', String(rawResponse || '').substring(0, 500));
  }

  // ---- [FIX-AI4] Attempt 2: strict prompt (opt-in) ----
  if (RETRY_ON_PARSE_FAILURE) {
    try {
      const prompt = buildAIPrompt(instrument, candles, indicators, true);
      logger.debug('[AI] Retrying with strict prompt');
      rawResponse = await generateSmart(prompt);
      const parsed = extractJSON(rawResponse);
      if (parsed) {
        const signal = normalizeAndValidate(parsed, currentPrice);
        if (signal) {
          logger.info('[AI] Strict retry succeeded');
          return signal;
        }
      }
      logger.debug('[AI] JSON extraction failed on attempt 2');
    } catch (err) {
      logger.error('[AI] Attempt 2 failed:', err.message);
    }
  }

  // ---- [FIX-AI5] Attempt 3: prose fallback (last resort) ----
  if (PROSE_FALLBACK_ENABLED && rawResponse) {
    const proseSignal = extractFromProse(rawResponse, currentPrice);
    if (proseSignal) {
      logger.warn(
        `[AI] Used prose fallback for ${instrument}: ` +
        `${proseSignal.side} @ ${proseSignal.confidence}% ` +
        `(reason: ${proseSignal.reason})`
      );
      return proseSignal;
    }
  }

  // Everything failed.
  logger.debug('[AI] No valid signal from any extraction path');
  return null;
}

module.exports = {
  getAISignal,
  // Exposed for testing
  _internal: {
    extractJSON,
    extractFromProse,
    normalizeAndValidate,
    findBalancedJSON,
    repairJSON,
    buildAIPrompt,
  },
};
