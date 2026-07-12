// src/infrastructure/eventBus.js – Event-Driven Architecture (In-Memory)

const EventEmitter = require('events');

/**
 * Simple in-memory event bus.
 * Later can be replaced with Redis Pub/Sub, RabbitMQ, or Kafka.
 * 
 * Usage:
 *   eventBus.on('trade.opened', (data) => { ... });
 *   eventBus.emit('trade.opened', { tradeId: '123', pair: 'EUR_USD' });
 */
class EventBus extends EventEmitter {
  constructor() {
    super();
    // Increase max listeners to avoid warnings
    this.setMaxListeners(100);
    // Keep a log of events for debugging (optional)
    this.eventLog = [];
    this.logEvents = process.env.LOG_EVENTS === 'true' || false;
  }

  /**
   * Emit an event with optional data.
   * Overridden to add logging.
   * @param {string} event - Event name.
   * @param {any} data - Event data.
   * @returns {boolean} True if there were listeners.
   */
  emit(event, data) {
    if (this.logEvents) {
      this.eventLog.push({
        event,
        data,
        timestamp: new Date().toISOString(),
      });
      // Keep log manageable
      if (this.eventLog.length > 1000) {
        this.eventLog.shift();
      }
    }
    return super.emit(event, data);
  }

  /**
   * Get the event log (for debugging).
   * @returns {Array} Array of logged events.
   */
  getEventLog() {
    return this.eventLog;
  }

  /**
   * Clear the event log.
   */
  clearEventLog() {
    this.eventLog = [];
  }
}

// Export a singleton instance
module.exports = new EventBus();
