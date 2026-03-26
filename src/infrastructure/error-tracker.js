import logger from './logger.js';

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

class ErrorTracker {
  constructor() {
    this.errors = new Map();
    this.maxErrors = 100;
    this.initialized = false;
  }

  init() {
    if (this.initialized) { return this; }
    this.initialized = true;
    return this;
  }

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