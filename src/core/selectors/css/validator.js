/**
 * CSS selector validation and DOM uniqueness checks used by the CSS generator and strategies.
 * Runs in the content-script context; all functions are synchronous and never throw.
 * Invariant: every function returns a primitive (boolean or string) — callers need no null-guard.
 * Called by: css/generator.js and css/strategies.js.
 */

/**
 * Returns true when `selector` is syntactically accepted by the browser's CSS parser.
 * Uses `querySelector` as the parser oracle — invalid selectors throw a SyntaxError.
 *
 * @param {string|*} selector
 * @returns {boolean}
 */
function isValidCssSelector(selector) {
  if (!selector || typeof selector !== 'string') {return false;}

  try {
    document.querySelector(selector);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Returns true when `selector` matches exactly one element in the document
 * and that element is `targetElement`. Both conditions must hold — a unique match
 * on the wrong element is still a failure.
 *
 * @param {string} selector
 * @param {Element} targetElement
 * @returns {boolean}
 */
function isUniqueCssSelector(selector, targetElement) {
  try {
    const matches = document.querySelectorAll(selector);

    if (matches.length !== 1) {return false;}
    return matches[0] === targetElement;
  } catch (error) {
    return false;
  }
}

/**
 * Escapes characters that have special meaning in CSS selectors so they can be
 * used safely inside attribute value strings. Prefer `CSS.escape` where available;
 * this is the manual fallback for environments that don't expose it.
 *
 * @param {string|*} str
 * @returns {string} Escaped string, or empty string when input is falsy.
 */
function escapeCss(str) {
  if (!str) {return '';}

  return str.replace(/([!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

export { isValidCssSelector, isUniqueCssSelector, escapeCss };