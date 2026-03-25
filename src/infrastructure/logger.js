import { get } from '../config/defaults.js';
import { app } from 'electron';
import log from 'electron-log';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

class FileTransport {
  write(entry) {
    log[entry.level]?.('[StoredLog]', entry.message, entry.data ?? {});
  }
}

class ConsoleTransport {
  write(logEntry) {
    const { level, message, timestamp, ...meta } = logEntry;
    const consoleFn  = console[level] ?? console.log;
    const prefix     = `[${timestamp}] ${level.toUpperCase()}:`;
    const hasMetadata = Object.keys(meta).length > 0;

    if (hasMetadata) {
      consoleFn(prefix, message, JSON.stringify(meta, null, 2));
    } else {
      consoleFn(prefix, message);
    }
  }
}

class Logger {
  constructor() {
    this.transports   = [];
    this.level        = 'info';
    this.context      = {};
    this.initialized  = false;
  }

  init() {
    if (this.initialized) {
      return this;
    }

    this.level = get('logging.level', 'info');
    this.transports.push(new ConsoleTransport());
    this.initialized = true;

    return this;
  }

  addTransport(transport) {
    if (!transport || typeof transport.write !== 'function') {
      throw new Error('Transport must have a write method');
    }
    this.transports.push(transport);
    return this;
  }

  removeTransport(transport) {
    this.transports = this.transports.filter(t => t !== transport);
    return this;
  }

  setContext(context) {
    this.context = { ...this.context, ...context };
    return this;
  }

  clearContext() {
    this.context = {};
    return this;
  }

  debug(message, meta = {}) {
    this.emitLog('debug', message, meta);
  }

  info(message, meta = {}) {
    this.emitLog('info', message, meta);
  }

  warn(message, meta = {}) {
    this.emitLog('warn', message, meta);
  }

  error(message, meta = {}) {
    this.emitLog('error', message, meta);
  }

  perf(operation, durationMs, data = {}) {
    const threshold = get('logging.slowOperationThreshold', 500);
    if (durationMs > threshold) {
      this.warn(`Slow operation: ${operation}`, { duration: durationMs, threshold, ...data });
    } else {
      this.debug(`Performance: ${operation}`, { duration: durationMs, ...data });
    }
  }

  emitLog(level, message, meta) {
    if (this.isLevelSuppressed(level)) {
      return;
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...this.context,
      ...meta
    };

    if (level === 'error') {
      logEntry.stack = new Error().stack;
    }

    for (const transport of this.transports) {
      try {
        transport.write(logEntry);
      } catch (transportError) {
        console.error('[Logger] Transport write failed:', transportError);
      }
    }
  }

  isLevelSuppressed(level) {
    const configLevel   = LEVELS[this.level]   ?? 1;
    const messageLevel  = LEVELS[level]        ?? 1;
    return messageLevel < configLevel;
  }

  async flush() {
    for (const transport of this.transports) {
      if (typeof transport.flush === 'function') {
        await transport.flush();
      }
    }
  }

  getLogs() {
    for (const transport of this.transports) {
      if (typeof transport.getLogs === 'function') {
        return transport.getLogs();
      }
    }
    return [];
  }

  clear() {
    for (const transport of this.transports) {
      if (typeof transport.clear === 'function') {
        transport.clear();
      }
    }
  }
}

const logger = new Logger();

export default logger;
export { Logger, ConsoleTransport, FileTransport };
