import { get } from '../../config/defaults.js';
import { NormalizationCache } from './cache.js';
import { normalizeColor } from './color-normalizer.js';
import { normalizeUnit, isContextDependent } from './unit-normalizer.js';
import { normalizeFont } from './font-normalizer.js';
import { expandShorthands } from './shorthand-expander.js';

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

class NormalizerEngine {
  #cache;

  constructor() {
    const cacheEnabled = get('normalization.cache.enabled');
    const maxEntries = get('normalization.cache.maxEntries');
    this.#cache = cacheEnabled ? new NormalizationCache(maxEntries) : null;
  }

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

  getCacheStats() {
    return this.#cache
      ? { cacheEnabled: true, ...this.#cache.getStats() }
      : { cacheEnabled: false };
  }

  clearCache() {
    this.#cache?.clear();
  }
}

const normalizerEngine = new NormalizerEngine();

export { NormalizerEngine, normalizerEngine };