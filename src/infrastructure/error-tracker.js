/**
 * In-memory error aggregator for the extension. Runs in the MV3 service worker.
 * Deduplicates errors by code+message so repeated failures increment a counter
 * rather than flood the log. Oldest entry is evicted when the 100-entry cap is reached.
 * Callers: idb-repository.js, and any module that calls errorTracker.track() directly.
 */
import logger from './logger.js';

/** Stable string constants used as error codes throughout the extension. */
const ERROR_CODES = {
  EXTRACTION_TIMEOUT: 'EXTRACTION_TIMEOUT',
  EXTRACTION_ELEMENT_DETACHED: 'EXTRACTION_ELEMENT_DETACHED',
  EXTRACTION_INVALID_ELEMENT: 'EXTRACTION_INVALID_ELEMENT',
  XPATH_GENERATION_FAILED: 'XPATH_GENERATION_FAILED',
  XPATH_VALIDATION_FAILED: 'XPATH_VALIDATION_FAILED',
  XPATH_TIMEOUT: 'XPATH_TIMEOUT',
  CSS_GENERATION_FAILED: 'CSS_GENERATION_FAILED',
  CSS_VALIDATION_FAILED: 'CSS_VALIDATION_FAILED',
  COMPARISON_NO_XPATH: 'COMPARISON_NO_XPATH',
  COMPARISON_INVALID_REPORT: 'COMPARISON_INVALID_REPORT',
  STORAGE_QUOTA_EXCEEDED: 'STORAGE_QUOTA_EXCEEDED',
  STORAGE_WRITE_FAILED: 'STORAGE_WRITE_FAILED',
  STORAGE_READ_FAILED: 'STORAGE_READ_FAILED',
  STORAGE_VERSION_CONFLICT: 'STORAGE_VERSION_CONFLICT',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR'
};

/**
 * Collects and deduplicates runtime errors in a capped in-memory Map.
 * Does not persist errors across service worker restarts.
 * Invariant: `logger.error` fires only on the first occurrence of each unique
 * code+message pair — repeat calls increment a counter silently.
 */
class ErrorTracker {
  constructor() {
    this.errors = new Map();
    this.maxErrors = 100;
    this.initialized = false;
  }

  /** Idempotent — safe to call multiple times; subsequent calls return `this` immediately. */
  init() {
    if (this.initialized) {return this;}
    this.initialized = true;
    return this;
  }

  /**
   * Records an error, deduplicating by `code:message` key. Repeated errors update
   * the count and `lastSeen` timestamp rather than creating new entries.
   * The Map delete-then-set keeps the entry at the tail so the oldest entry
   * (Map insertion order) is always the one evicted when the cap is hit.
   *
   * @param {{code: string, message: string, context?: Object}} error
   */
  track(error) {
    const key = `${error.code}:${error.message}`;
    
    if (this.errors.has(key)) {
      const existing = this.errors.get(key);
      existing.count++;
      existing.lastSeen = new Date().toISOString();
      this.errors.delete(key);
      this.errors.set(key, existing);
    } else {
      const entry = {
        code: error.code,
        message: error.message,
        context: error.context || {},
        count: 1,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString()
      };
      
      this.errors.set(key, entry);
      logger.error(`New error type: ${error.code}`, { message: error.message });
      
      if (this.errors.size > this.maxErrors) {
        const firstKey = this.errors.keys().next().value;
        this.errors.delete(firstKey);
      }
    }
  }
}

const errorTracker = new ErrorTracker();

export { errorTracker, ERROR_CODES };
export default errorTracker;