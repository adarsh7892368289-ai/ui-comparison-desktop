/**
 * In-process operation timer and stats aggregator. Runs in the MV3 service worker.
 * Failure mode contained here: none — all methods are pure in-memory and never throw.
 * Callers: any workflow that wraps operations with start()/end() or wrap().
 */

/**
 * Tracks timing metrics per named operation: count, total, min, max, stdDev,
 * and percentiles over the last 100 samples.
 * Does not own logging — callers decide what to do with the returned stats.
 * Invariant: always call end() with the handle returned by start(), even on error —
 * an unended handle silently leaks that sample from the operation's history.
 */
class PerformanceMonitor {
  constructor() {
    this.metrics = {};
    this.enabled = true;
  }

  /**
   * Begins timing an operation and returns an opaque handle to pass to end().
   * Returns undefined when disabled — end() guards against this, so the pair
   * is always safe to call unconditionally.
   *
   * @param {string} operation
   * @returns {{operation: string, startTime: number, startMark: string} | undefined}
   */
  start(operation) {
    if (!this.enabled) {return;}
    
    if (!this.metrics[operation]) {
      this.metrics[operation] = {
        count: 0,
        totalTime: 0,
        minTime: Infinity,
        maxTime: -Infinity,
        samples: []
      };
    }
    
    return {
      operation,
      startTime: performance.now(),
      startMark: `${operation}-start-${Date.now()}`
    };
  }

  /**
   * Stops timing and records the sample. Raw float durations are stored in the
   * metric for precision; only the returned summary values are rounded.
   * The sample window is capped at 100 — stdDev and percentiles from getStats()
   * are approximate once count exceeds that.
   *
   * @param {{operation: string, startTime: number} | undefined} handle
   * @returns {{operation: string, duration: number, average: number} | null}
   */
  end(handle) {
    if (!this.enabled || !handle) {return null;}

    const duration = performance.now() - handle.startTime;
    const metric = this.metrics[handle.operation];

    metric.count++;
    metric.totalTime += duration;
    metric.minTime = Math.min(metric.minTime, duration);
    metric.maxTime = Math.max(metric.maxTime, duration);

    // Capped at 100 samples — percentiles and stdDev in getStats() are approximate beyond this.
    metric.samples.push(duration);
    if (metric.samples.length > 100) {
      metric.samples.shift();
    }
    
    return {
      operation: handle.operation,
      duration: Math.round(duration),
      average: Math.round(metric.totalTime / metric.count)
    };
  }

  /**
   * Returns an async wrapper around fn that records timing via start()/end().
   * Always returns an async function — a synchronous throw from fn becomes a
   * rejected Promise rather than a thrown error.
   *
   * @param {string} operation
   * @param {Function} fn
   * @returns {(...args: any[]) => Promise<any>}
   */
  wrap(operation, fn) {
    return async (...args) => {
      const handle = this.start(operation);
      try {
        const result = await fn(...args);
        this.end(handle);
        return result;
      } catch (error) {
        this.end(handle);
        throw error;
      }
    };
  }

  /**
   * Returns aggregated stats for a named operation, including stdDev and percentiles
   * computed over the last 100 samples. Returns null if the operation has no recorded samples.
   *
   * @param {string} operation
   * @returns {{operation, count, total, average, min, max, stdDev, p50, p95, p99} | null}
   */
  getStats(operation) {
    const metric = this.metrics[operation];
    if (!metric || metric.count === 0) {return null;}
    
    const avg = metric.totalTime / metric.count;
    const variance = metric.samples.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / metric.samples.length;
    const stdDev = Math.sqrt(variance);
    
    return {
      operation,
      count:     metric.count,
      total:     Math.round(metric.totalTime),
      average:   Math.round(avg),
      min:       Math.round(metric.minTime),
      max:       Math.round(metric.maxTime),
      stdDev:    Math.round(stdDev),
      p50:       this._percentile(metric.samples, 0.5),
      p95:       this._percentile(metric.samples, 0.95),
      p99:       this._percentile(metric.samples, 0.99)
    };
  }

  /** Returns stats for every tracked operation as a keyed object. */
  getAllStats() {
    const stats = {};
    for (const op of Object.keys(this.metrics)) {
      stats[op] = this.getStats(op);
    }
    return stats;
  }

  /**
   * Computes a percentile over an array of duration samples using the nearest-rank method.
   * Spreads before sorting to avoid mutating the live samples array.
   *
   * @param {number[]} samples
   * @param {number} p - Fraction in [0, 1], e.g. 0.95 for p95.
   * @returns {number}
   */
  _percentile(samples, p) {
    if (samples.length === 0) {return 0;}
    const sorted = [...samples].sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * p) - 1;
    return Math.round(sorted[Math.max(0, index)]);
  }

  /**
   * Clears metrics. Pass an operation name to reset only that operation;
   * omit the argument (or pass null) to clear all tracked operations.
   *
   * @param {string|null} [operation=null]
   */
  reset(operation = null) {
    if (operation) {
      delete this.metrics[operation];
    } else {
      this.metrics = {};
    }
  }

}

const performanceMonitor = new PerformanceMonitor();

export { PerformanceMonitor, performanceMonitor };