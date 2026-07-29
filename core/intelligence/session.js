// core/intelligence/session.js
// Market session detection – Asian, London, New York, Sydney.
// Provides session name, liquidity multiplier, overlap detection, and weekend check.

/**
 * Get the current market session based on UTC time.
 * @returns {Object} { name: string, liquidityMultiplier: number, startHour: number, endHour: number }
 */
function getSession() {
  const hour = new Date().getUTCHours();

  // Sydney: 22:00 – 06:00 UTC (10pm – 6am)
  if (hour >= 22 || hour < 6) {
    return { name: 'Sydney', liquidityMultiplier: 0.7, startHour: 22, endHour: 6 };
  }
  // Asia/Tokyo: 00:00 – 08:00 UTC (midnight – 8am)
  if (hour >= 0 && hour < 8) {
    return { name: 'Asia', liquidityMultiplier: 0.8, startHour: 0, endHour: 8 };
  }
  // London: 07:00 – 15:00 UTC (7am – 3pm)
  if (hour >= 7 && hour < 15) {
    return { name: 'London', liquidityMultiplier: 1.5, startHour: 7, endHour: 15 };
  }
  // New York: 12:00 – 20:00 UTC (noon – 8pm)
  if (hour >= 12 && hour < 20) {
    return { name: 'New York', liquidityMultiplier: 1.5, startHour: 12, endHour: 20 };
  }
  // Fallback: Other (e.g., late NY, early Sydney gap)
  return { name: 'Other', liquidityMultiplier: 0.6, startHour: null, endHour: null };
}

/**
 * Check if London or New York session is active (high liquidity overlap).
 * @returns {boolean} true if London or New York is active.
 */
function isHighLiquiditySession() {
  const session = getSession();
  return session.name === 'London' || session.name === 'New York';
}

/**
 * Check if London and New York overlap (12:00 – 15:00 UTC).
 * @returns {boolean} true if overlap is active.
 */
function isLondonNYOverlap() {
  const hour = new Date().getUTCHours();
  return hour >= 12 && hour < 15;
}

/**
 * Check if the market is open (not weekend).
 * @returns {boolean} true if weekday (Mon–Fri).
 */
function isWeekday() {
  const day = new Date().getUTCDay();
  return day >= 1 && day <= 5; // Monday = 1, Friday = 5
}

/**
 * Check if it's weekend (Saturday or Sunday).
 * @returns {boolean} true if weekend.
 */
function isWeekend() {
  return !isWeekday();
}

/**
 * Get a human‑readable session description.
 * @param {string} sessionName - Optional session name (if omitted, uses current).
 * @returns {string} Description of the session.
 */
function getSessionDescription(sessionName = null) {
  const session = sessionName ? { name: sessionName } : getSession();
  const descriptions = {
    'Sydney': 'Sydney session – low liquidity, often ranging.',
    'Asia': 'Asian session – moderate liquidity, range‑bound.',
    'London': 'London session – high liquidity, strong trends.',
    'New York': 'New York session – high liquidity, volatile.',
    'Other': 'Between sessions – thin liquidity, unpredictable.',
  };
  return descriptions[session.name] || 'Unknown session.';
}

module.exports = {
  getSession,
  isHighLiquiditySession,
  isLondonNYOverlap,
  isWeekday,
  isWeekend,
  getSessionDescription,
};
