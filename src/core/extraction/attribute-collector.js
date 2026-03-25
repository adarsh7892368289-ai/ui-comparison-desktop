/**
 * Collects semantic HTML attributes from DOM elements, stripping framework noise
 * (data-v-*, ng-*, x-*, etc.) so downstream comparisons see only stable attributes.
 *
 * Execution context: content script.
 * Invariant: never throws — returns an empty object on any DOM error so the
 * extraction pipeline always receives a valid (possibly empty) attribute map.
 *
 * Direct callers: dom-enrichment.js
 */

import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';

/** Module-level cache so RegExp objects are compiled once per content-script lifetime. */
let frameworkPatternsCache = null;

/**
 * Lazily compiles and caches the configured framework-attribute filter patterns.
 * String entries in config are promoted to RegExp; RegExp entries pass through unchanged.
 *
 * @returns {RegExp[]} Compiled patterns used to discard framework-generated attribute names.
 */
function getFrameworkPatterns() {
  if (!frameworkPatternsCache) {
    frameworkPatternsCache = get('attributes.frameworkPatterns').map(p =>
      typeof p === 'string' ? new RegExp(p, 'u') : p
    );
  }
  return frameworkPatternsCache;
}

/**
 * Returns a null-prototype object mapping attribute name → value for every
 * attribute on `element` that does not match a framework-noise pattern.
 *
 * Uses `Object.create(null)` so callers can safely iterate with `for...in`
 * without hitting inherited properties from `Object.prototype`.
 *
 * @param {Element} element - The DOM element to inspect.
 * @returns {Record<string, string>} Filtered attribute map; empty on error — never throws.
 */
function collectAttributes(element) {
  try {
    const result   = Object.create(null);
    const patterns = getFrameworkPatterns();

    for (const { name, value } of element.attributes) {
      if (!patterns.some(p => p.test(name))) {
        result[name] = value;
      }
    }

    return result;
  } catch (err) {
    logger.error('Attribute collection failed', { tagName: element.tagName, error: err.message });
    return Object.create(null);
  }
}

export { collectAttributes };