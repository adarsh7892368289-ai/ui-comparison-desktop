class LRUCache {
  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) {
      return undefined;
    }

    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);

    return value;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    this.cache.set(key, value);

    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  has(key) {
    return this.cache.has(key);
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }

  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      utilizationPercent: (this.cache.size / this.maxSize * 100).toFixed(1)
    };
  }
}

class NormalizationCache {
  constructor(maxSize = 1000) {
    this.absoluteCache = new LRUCache(maxSize);
    this.relativeCache = new LRUCache(Math.floor(maxSize / 2));

    this.stats = {
      absoluteHits: 0,
      absoluteMisses: 0,
      relativeHits: 0,
      relativeMisses: 0
    };
  }

  getCacheKey(property, value, context = null) {
    if (context) {
      const ctxKey = `${context.fontSize}|${context.rootFontSize}|${context.viewportWidth}|${context.viewportHeight}`;
      return `${property}:${value}:${ctxKey}`;
    }
    return `${property}:${value}`;
  }

  get(property, value, isContextDependent = false, context = null) {
    const key = this.getCacheKey(property, value, context);
    const cache = isContextDependent ? this.relativeCache : this.absoluteCache;

    const result = cache.get(key);

    if (result !== undefined) {
      if (isContextDependent) {
        this.stats.relativeHits++;
      } else {
        this.stats.absoluteHits++;
      }
      return result;
    }

    if (isContextDependent) {
      this.stats.relativeMisses++;
    } else {
      this.stats.absoluteMisses++;
    }

    return undefined;
  }

  set(property, value, normalizedValue, isContextDependent = false, context = null) {
    const key = this.getCacheKey(property, value, context);
    const cache = isContextDependent ? this.relativeCache : this.absoluteCache;

    cache.set(key, normalizedValue);
  }

  clear() {
    this.absoluteCache.clear();
    this.relativeCache.clear();
    this.stats = {
      absoluteHits: 0,
      absoluteMisses: 0,
      relativeHits: 0,
      relativeMisses: 0
    };
  }

  getStats() {
    const absoluteTotal = this.stats.absoluteHits + this.stats.absoluteMisses;
    const relativeTotal = this.stats.relativeHits + this.stats.relativeMisses;

    const absoluteHitRate = absoluteTotal > 0
      ? (this.stats.absoluteHits / absoluteTotal * 100).toFixed(1)
      : '0.0';

    const relativeHitRate = relativeTotal > 0
      ? (this.stats.relativeHits / relativeTotal * 100).toFixed(1)
      : '0.0';

    return {
      absolute: {
        hits: this.stats.absoluteHits,
        misses: this.stats.absoluteMisses,
        hitRate: `${absoluteHitRate}%`,
        ...this.absoluteCache.getStats()
      },
      relative: {
        hits: this.stats.relativeHits,
        misses: this.stats.relativeMisses,
        hitRate: `${relativeHitRate}%`,
        ...this.relativeCache.getStats()
      }
    };
  }
}

export { LRUCache, NormalizationCache };