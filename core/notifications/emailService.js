// src/core/notifications/emailService.js – Email Service for RTS (consistent)

const { sendEmail } = require('../../shared/emailProvider');
const logger = require('../../infrastructure/logger') || console;

/**
 * Send a trade notification email.
 * @param {string} to – recipient email address
 * @param {string} type – 'OPENED' or 'CLOSED'
 * @param {Object} trade – trade details
 * @param {Object} account – account info (optional)
 */
async function sendTradeNotification(to, type, trade, account = {}) {
  const subject = `[RTS] Trade ${type} – ${trade.pair}`;
  const content = `
    <h2>Trade ${type}</h2>
    <table style="border-collapse: collapse; width: 100%;">
      <tr><td><strong>Pair</strong></td><td>${trade.pair}</td></tr>
      <tr><td><strong>Side</strong></td><td>${trade.side}</td></tr>
      <tr><td><strong>Entry Price</strong></td><td>${trade.entryPrice}</td></tr>
      ${trade.closePrice ? `<tr><td><strong>Exit Price</strong></td><td>${trade.closePrice}</td></tr>` : ''}
      ${trade.pnl ? `<tr><td><strong>P/L</strong></td><td>${trade.pnl}</td></tr>` : ''}
      <tr><td><strong>Lot Size</strong></td><td>${trade.lotSize}</td></tr>
      <tr><td><strong>Stop Loss</strong></td><td>${trade.stopLoss || 'N/A'}</td></tr>
      <tr><td><strong>Take Profit</strong></td><td>${trade.takeProfit || 'N/A'}</td></tr>
      <tr><td><strong>Status</strong></td><td>${trade.status}</td></tr>
      <tr><td><strong>Time</strong></td><td>${new Date().toLocaleString()}</td></tr>
    </table>
    <p>Account: ${account.id || 'N/A'} (Balance: ${account.balance || 'N/A'})</p>
    <p style="font-size: 12px; color: #888;">This is an automated message from your RTS platform.</p>
  `;

  try {
    const result = await sendEmail(to, subject, content);
    logger.info(`[Email] Trade notification sent to ${to} for ${trade.pair} (${type})`);
    return result;
  } catch (err) {
    logger.error('[Email] Failed to send trade notification:', err.message);
    throw err;
  }
}

/**
 * Send a test email.
 */
async function sendTestEmail(to) {
  const subject = '[RTS] Test Email';
  const content = `<h2>Test Email</h2><p>Your RTS email system is working correctly.</p>`;
  return sendEmail(to, subject, content);
}

module.exports = {
  sendTradeNotification,
  sendTestEmail,
};
