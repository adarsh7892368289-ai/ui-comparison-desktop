class PerformanceMonitor {
  constructor() {
    this.metrics = {};
    this.enabled = true;
  }

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

  end(handle) {
    if (!this.enabled || !handle) {return null;}

    const duration = performance.now() - handle.startTime;
    const metric = this.metrics[handle.operation];

    metric.count++;
    metric.totalTime += duration;
    metric.minTime = Math.min(metric.minTime, duration);
    metric.maxTime = Math.max(metric.maxTime, duration);

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

  getAllStats() {
    const stats = {};
    for (const op of Object.keys(this.metrics)) {
      stats[op] = this.getStats(op);
    }
    return stats;
  }

  _percentile(samples, p) {
    if (samples.length === 0) {return 0;}
    const sorted = [...samples].sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * p) - 1;
    return Math.round(sorted[Math.max(0, index)]);
  }

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