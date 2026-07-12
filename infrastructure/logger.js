// src/infrastructure/logger.js – Centralised Logger for RTS Platform

/**
 * Simple logger with timestamp and log levels.
 * Can be replaced with Winston or Pino later without changing the rest of the code.
 */
class Logger {
  constructor(options = {}) {
    this.level = options.level || process.env.LOG_LEVEL || 'info';
    this.prefix = options.prefix || '[RTS]';
    this.levels = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3,
      trace: 4,
    };
  }

  _log(level, message, ...args) {
    if (this.levels[level] > this.levels[this.level]) return;
    const timestamp = new Date().toISOString();
    const prefix = `${this.prefix} ${timestamp} ${level.toUpperCase()}`;
    if (args.length > 0) {
      console.log(prefix, message, ...args);
    } else {
      console.log(prefix, message);
    }
  }

  error(message, ...args) {
    this._log('error', message, ...args);
  }

  warn(message, ...args) {
    this._log('warn', message, ...args);
  }

  info(message, ...args) {
    this._log('info', message, ...args);
  }

  debug(message, ...args) {
    this._log('debug', message, ...args);
  }

  trace(message, ...args) {
    this._log('trace', message, ...args);
  }
}

// Export a singleton instance
module.exports = new Logger();
