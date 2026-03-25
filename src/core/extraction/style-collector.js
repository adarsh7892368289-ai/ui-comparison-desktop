/**
 * Reads a configured set of CSS properties from a CSSStyleDeclaration into a plain object.
 * Runs in the content-script context during DOM extraction.
 * Invariant: always returns a non-null object — callers must never guard against null.
 * Called by: extractor.js per-element style pass.
 */
import { get }  from '../../config/defaults.js';
import logger   from '../../infrastructure/logger.js';

/**
 * Extracts the whitelisted CSS properties from a computed style object.
 * Returns an empty object (never throws) when the style object is missing or the
 * browser throws during property access — e.g. cross-origin iframes.
 *
 * @param {CSSStyleDeclaration|null} computedStyle - Result of `getComputedStyle(el)`.
 * @returns {Record<string, string>} Null-prototype map of property → value; empty on failure.
 */
function collectStylesFromComputed(computedStyle) {
  if (!computedStyle) {
    return Object.create(null);
  }

  const properties = get('extraction.cssProperties');

  try {
    const styles = Object.create(null);
    for (const prop of properties) {
      styles[prop] = computedStyle.getPropertyValue(prop);
    }
    return styles;
  } catch (err) {
    logger.error('Style collection failed', { error: err.message });
    return Object.create(null);
  }
}

export { collectStylesFromComputed };