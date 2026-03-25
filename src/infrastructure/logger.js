/**
 * Structured logger with pluggable transports. Runs in all three extension contexts.
 * Failure mode contained here: a transport that throws on write — each transport is
 * wrapped in try/catch so one failing transport never silences the others.
 * Callers: every module in the extension imports the exported singleton.
 */
import { get } from '../config/defaults.js';
import { app } from 'electron';
import log from 'electron-log';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

class FileTransport {
  write(entry) {
    log[entry.level]?.('[StoredLog]', entry.message, entry.data ?? {});
  }
}

/**
 * Writes log entries to the browser console. Stateless — no buffering or storage.
 */
class ConsoleTransport {
  /**
   * Prints to the matching `console[level]` method, falling back to `console.log`
   * for any level string not natively on the console object.
   */
  write(logEntry) {
    const { level, message, timestamp, ...meta } = logEntry;
    const consoleFn  = console[level] ?? console.log; // eslint-disable-line no-console
    const prefix     = `[${timestamp}] ${level.toUpperCase()}:`;
    const hasMetadata = Object.keys(meta).length > 0;

    if (hasMetadata) {
      consoleFn(prefix, message, JSON.stringify(meta, null, 2));
    } else {
      consoleFn(prefix, message);
    }
  }
}

/**
 * Fan-out logger that writes each entry to all registered transports.
 * Does not own storage or console I/O — those belong to the transports.
 * Invariant: call init() before the first log call — ConsoleTransport is only
 * registered there, so an uninitialised logger silently drops all output.
 */
class Logger {
  constructor() {
    this.transports   = [];
    this.level        = 'info';
    this.context      = {};
    this.initialized  = false;
  }

  /** Registers ConsoleTransport and reads the log level from config. Idempotent. */
  init() {
    if (this.initialized) {
      return this;
    }

    this.level = get('logging.level', 'info');
    this.transports.push(new ConsoleTransport());
    this.initialized = true;

    return this;
  }

  /**
   * Registers a transport. Returns `this` for chaining.
   * @param {{ write: Function }} transport
   * @throws {Error} If the transport is missing a `write` method.
   */
  addTransport(transport) {
    if (!transport || typeof transport.write !== 'function') {
      throw new Error('Transport must have a write method');
    }
    this.transports.push(transport);
    return this;
  }

  /** Removes a transport by reference. Returns `this` for chaining. */
  removeTransport(transport) {
    this.transports = this.transports.filter(t => t !== transport);
    return this;
  }

  /**
   * Merges additional fields into the persistent context object. Fields are
   * included in every subsequent log entry until clearContext() is called.
   * Merges into existing context — does not replace it.
   */
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

  /**
   * Logs a performance measurement. Emits a `warn` if `durationMs` exceeds the
   * configured slow-operation threshold; otherwise emits a `debug`.
   */
  perf(operation, durationMs, data = {}) {
    const threshold = get('logging.slowOperationThreshold', 500);
    if (durationMs > threshold) {
      this.warn(`Slow operation: ${operation}`, { duration: durationMs, threshold, ...data });
    } else {
      this.debug(`Performance: ${operation}`, { duration: durationMs, ...data });
    }
  }

  /**
   * Builds the log entry and fans it out to all transports.
   * Error-level entries automatically include a stack trace — callers do not need to pass one.
   */
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
        console.error('[Logger] Transport write failed:', transportError); // eslint-disable-line no-console
      }
    }
  }

  /** Returns true if the message level is below the configured minimum level. */
  isLevelSuppressed(level) {
    const configLevel   = LEVELS[this.level]   ?? 1;
    const messageLevel  = LEVELS[level]        ?? 1;
    return messageLevel < configLevel;
  }

  /** Calls flush() on every transport that supports it, in registration order. */
  async flush() {
    for (const transport of this.transports) {
      if (typeof transport.flush === 'function') {
        await transport.flush();
      }
    }
  }

  /** Returns logs from the first transport that supports getLogs(), or [] if none do. */
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
