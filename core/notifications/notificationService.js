// src/core/notifications/notificationService.js – Unified notification service

const emailService = require('./emailService');
const logger = require('../../infrastructure/logger') || console;

// Instagram placeholder (future)
const instagramService = {
  sendPost: async (message) => {
    logger.info('[Instagram] Would post:', message);
    // In the future, implement actual Instagram API integration.
    return { success: true, message: 'Instagram placeholder' };
  },
};

/**
 * Send a trade notification via all enabled channels.
 * @param {string} type – 'OPENED' or 'CLOSED'
 * @param {Object} trade – trade object
 * @param {Object} account – account info (optional)
 */
async function notifyTrade(type, trade, account = {}) {
  const emailEnabled = process.env.ENABLE_EMAIL_NOTIFICATIONS === 'true';
  const instagramEnabled = process.env.ENABLE_INSTAGRAM_NOTIFICATIONS === 'true';

  if (emailEnabled) {
    const email = process.env.NOTIFICATION_EMAIL;
    if (!email) {
      logger.warn('[Notification] Email notification enabled but NOTIFICATION_EMAIL not set.');
    } else {
      await emailService.sendTradeNotification(email, type, trade, account).catch(err => {
        logger.error('[Notification] Email failed:', err.message);
      });
    }
  }

  if (instagramEnabled) {
    const message = `Trade ${type}: ${trade.pair} ${trade.side} at ${trade.entryPrice}`;
    await instagramService.sendPost(message).catch(err => {
      logger.error('[Notification] Instagram failed:', err.message);
    });
  }
}

/**
 * Send a test notification (email only for now).
 */
async function sendTestNotification(email) {
  return emailService.sendTestEmail(email);
}

module.exports = {
  notifyTrade,
  sendTestNotification,
};
