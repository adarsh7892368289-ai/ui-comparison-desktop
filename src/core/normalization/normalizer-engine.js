/**
 * Orchestrates CSS value normalization: shorthand expansion, color/unit/font conversion,
 * and two-tier LRU caching. Exports a singleton for use by the extraction pipeline.
 * Runs in the content-script context; no async I/O.
 * Invariant: every public method returns the original value on failure — never throws to callers.
 * Called by: extractor.js after per-element style collection.
 */
import { get } from '../../config/defaults.js';
import { NormalizationCache } from './cache.js';
import { normalizeColor } from './color-normalizer.js';
import { normalizeUnit, isContextDependent } from './unit-normalizer.js';
import { normalizeFont } from './font-normalizer.js';
import { expandShorthands } from './shorthand-expander.js';

// Property sets determine which normalizer each CSS property is routed to.
const COLOR_PROPERTIES = new Set([
  'color', 'background-color', 'border-color',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'outline-color', 'text-decoration-color', 'column-rule-color', 'caret-color'
]);

const SIZE_PROPERTIES = new Set([
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'top', 'right', 'bottom', 'left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-width', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-radius', 'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-right-radius', 'border-bottom-left-radius',
  'font-size', 'line-height', 'letter-spacing', 'word-spacing',
  'gap', 'row-gap', 'column-gap', 'grid-gap',
  'outline-width', 'outline-offset', 'text-indent'
]);

/**
 * Routes CSS properties to the correct normalizer and caches results.
 * Does NOT own property collection or DOM access — only value transformation.
 * Invariant: callers must not mutate the `styles` object passed to `normalize`.
 */
class NormalizerEngine {
  /** @type {NormalizationCache|null} Null when caching is disabled in config. */
  #cache;

  /** Reads cache config once at construction; cache on/off cannot be toggled at runtime. */
  constructor() {
    const cacheEnabled = get('normalization.cache.enabled');
    const maxEntries = get('normalization.cache.maxEntries');
    this.#cache = cacheEnabled ? new NormalizationCache(maxEntries) : null;
  }

  /**
   * Expands shorthand properties then normalises every value in the resulting map.
   * Returns the original `styles` object unchanged on any error.
   *
   * @param {Record<string, string>} styles - Raw computed-style map from the content script.
   * @param {object|null} contextSnapshot - Viewport/font context required for relative units.
   * @returns {Record<string, string>} New object with normalised values; never throws.
   */
  normalize(styles, contextSnapshot = null) {
    if (!styles || typeof styles !== 'object') {
      return styles;
    }
    try {
      const expanded = expandShorthands(styles);
      const normalized = {};
      for (const [property, value] of Object.entries(expanded)) {
        normalized[property] = this.normalizeProperty(property, value, contextSnapshot);
      }
      return normalized;
    } catch {
      return styles;
    }
  }

  /**
   * Normalises a single CSS property value by routing it to the right normalizer.
   * Properties not in COLOR_PROPERTIES, SIZE_PROPERTIES, or `font-family` pass through unchanged.
   *
   * @param {string} property - CSS property name (e.g. `'color'`, `'font-size'`).
   * @param {string|*} value - Raw CSS value string.
   * @param {object|null} contextSnapshot - Required for relative-unit size properties.
   * @returns {string} Normalised value, or the original on failure.
   */
  normalizeProperty(property, value, contextSnapshot = null) {
    if (!value || typeof value !== 'string') {
      return value;
    }
    try {
      if (COLOR_PROPERTIES.has(property)) {
        return this.#cached(property, value, false, null, () => normalizeColor(value));
      }
      if (SIZE_PROPERTIES.has(property)) {
        const ctxDependent = isContextDependent(value);
        const context = ctxDependent ? contextSnapshot : null;
        return this.#cached(
          property, value, ctxDependent, context,
          () => normalizeUnit(value, property, contextSnapshot)
        );
      }
      if (property === 'font-family') {
        return this.#cached(property, value, false, null, () => normalizeFont(value));
      }
      return value;
    } catch {
      return value;
    }
  }

  /**
   * Cache read-through helper. Calls `fn` only on a cache miss and stores the result.
   * When cache is disabled, calls `fn` directly every time.
   *
   * @param {string} property
   * @param {string} value
   * @param {boolean} ctxDependent - Routes to the relative-unit tier when true.
   * @param {object|null} context
   * @param {() => string} fn - Must not catch its own errors.
   * @returns {string}
   */
  #cached(property, value, ctxDependent, context, fn) {
    if (!this.#cache) {
      return fn();
    }
    const hit = this.#cache.get(property, value, ctxDependent, context);
    if (hit !== undefined) {
      return hit;
    }
    const result = fn();
    this.#cache.set(property, value, result, ctxDependent, context);
    return result;
  }

  /** Returns hit-rate and utilisation metrics, or `{ cacheEnabled: false }` when disabled. */
  getCacheStats() {
    return this.#cache
      ? { cacheEnabled: true, ...this.#cache.getStats() }
      : { cacheEnabled: false };
  }

  /** Flushes both cache tiers without resetting config. Safe to call at any time. */
  clearCache() {
    this.#cache?.clear();
  }
}

// Shared singleton — instantiated once so the LRU cache persists across all extraction calls.
const normalizerEngine = new NormalizerEngine();

export { NormalizerEngine, normalizerEngine };