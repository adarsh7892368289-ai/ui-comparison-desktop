/**
 * LRU and two-tier normalization caches used by the normalizer pipeline.
 * Runs in the content-script context; no async I/O.
 * Invariant: `get` always returns `undefined` on a miss — callers must check before use.
 * Called by: normalizer-engine.js on every CSS value normalization.
 */
/**
 * Fixed-capacity LRU cache backed by insertion-ordered Map.
 * Evicts the least-recently-used entry once `maxSize` is exceeded.
 * Does NOT own persistence — entries are lost when the content script unloads.
 */
class LRUCache {
  /** @param {number} maxSize - Maximum number of entries before eviction begins. */
  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  /**
   * Returns the cached value and promotes the entry to most-recently-used.
   * @param {string} key
   * @returns {*} The stored value, or `undefined` on a miss.
   */
  get(key) {
    if (!this.cache.has(key)) {
      return undefined;
    }

    const value = this.cache.get(key);
    // Delete-then-reinsert moves the entry to the tail (most-recent position).
    this.cache.delete(key);
    this.cache.set(key, value);

    return value;
  }

  /**
   * Inserts or updates a key, evicting the oldest entry when over capacity.
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    this.cache.set(key, value);

    if (this.cache.size > this.maxSize) {
      // Map.keys() iterates in insertion order; first key is the oldest.
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  /** Returns true when the key exists, without updating recency. */
  has(key) {
    return this.cache.has(key);
  }

  /** Drops all entries and resets the cache to empty. */
  clear() {
    this.cache.clear();
  }

  /** Current number of cached entries. */
  get size() {
    return this.cache.size;
  }

  /** Returns size and utilisation metrics for diagnostics. */
  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      utilizationPercent: (this.cache.size / this.maxSize * 100).toFixed(1)
    };
  }
}

/**
 * Two-tier cache separating context-independent (absolute) values from
 * context-dependent (relative) values such as `em` or `%`.
 * Absolute cache is twice the size of relative because absolute hits are far more common.
 * Tracks hit/miss counters per tier for performance telemetry.
 */
class NormalizationCache {
  /** @param {number} maxSize - Capacity of the absolute tier; relative tier is half this. */
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

  /**
   * Builds a deterministic string key. Context fields are pipe-separated to avoid
   * collisions between values that share a prefix (e.g. "16" vs "1" + "6").
   *
   * @param {string} property - CSS property name.
   * @param {string} value - Raw CSS value string.
   * @param {{fontSize:number, rootFontSize:number, viewportWidth:number, viewportHeight:number}|null} context
   * @returns {string}
   */
  getCacheKey(property, value, context = null) {
    if (context) {
      const ctxKey = `${context.fontSize}|${context.rootFontSize}|${context.viewportWidth}|${context.viewportHeight}`;
      return `${property}:${value}:${ctxKey}`;
    }
    return `${property}:${value}`;
  }

  /**
   * Looks up a normalized value, incrementing the appropriate hit/miss counter.
   *
   * @param {string} property
   * @param {string} value
   * @param {boolean} isContextDependent - True for relative units (em, %, vh); false for absolute.
   * @param {object|null} context - Required when `isContextDependent` is true.
   * @returns {string|undefined} The cached normalized value, or `undefined` on a miss.
   */
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

  /**
   * Stores a normalized value in the appropriate tier.
   *
   * @param {string} property
   * @param {string} value
   * @param {string} normalizedValue - The resolved canonical form to cache.
   * @param {boolean} isContextDependent
   * @param {object|null} context
   */
  set(property, value, normalizedValue, isContextDependent = false, context = null) {
    const key = this.getCacheKey(property, value, context);
    const cache = isContextDependent ? this.relativeCache : this.absoluteCache;

    cache.set(key, normalizedValue);
  }

  /** Resets both tiers and all counters to zero. */
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

  /** Returns hit rates and per-tier LRU stats for performance telemetry. */
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