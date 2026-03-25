/**
 * Classifies DOM elements into extraction tiers (T0–T3) and evaluates visibility.
 * Tier assignment drives which elements are extracted, compared, and exported.
 *
 * Execution context: content script.
 * Invariant: T0 tags are pruned by the TreeWalker before any other processing —
 * `isTierZero` and `getT0Tags` must stay in sync with dom-traversal's node filter.
 *
 * Direct callers: dom-traversal.js, extractor.js
 */

import { get } from '../../config/defaults.js';

/**
 * T3 — Interactive elements: receive user input or trigger actions.
 * These get the highest extraction priority for UI regression detection.
 */
const T3_TAGS = new Set([
  'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'A', 'DIALOG',
  'DETAILS', 'OUTPUT', 'METER', 'PROGRESS', 'OPTION', 'OPTGROUP'
]);

/**
 * T3 via ARIA role: custom components that behave like interactive elements
 * but use non-semantic host tags (e.g. `<div role="button">`).
 */
const T3_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'textbox', 'combobox',
  'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab',
  'treeitem', 'gridcell'
]);

/**
 * T2 — Content elements: carry visible text, media, or semantic meaning
 * but are not directly interactive.
 */
const T2_TAGS = new Set([
  'P', 'SPAN', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'IMG', 'SVG',
  'CANVAS', 'VIDEO', 'AUDIO', 'PICTURE', 'BLOCKQUOTE', 'PRE', 'CODE',
  'STRONG', 'EM', 'FIGURE', 'FIGCAPTION', 'TIME', 'ADDRESS', 'Q',
  'MARK', 'INS', 'DEL', 'ABBR', 'CITE', 'DFN', 'KBD', 'SAMP', 'VAR',
  'SMALL', 'SUB', 'SUP', 'DL', 'DT', 'DD', 'IFRAME'
]);

/** Lazily initialised set of T0 (opaque/irrelevant) tag names loaded from config. */
let t0TagsCache = null;

/**
 * Returns the cached set of T0 tag names (e.g. SCRIPT, STYLE, META).
 * These are pruned entirely from the TreeWalker — their subtrees are never visited.
 *
 * @returns {Set<string>} Uppercase tag names to skip during traversal.
 */
function getT0Tags() {
  if (!t0TagsCache) {
    t0TagsCache = new Set(get('extraction.irrelevantTags'));
  }
  return t0TagsCache;
}

/**
 * Quick check for whether an element's tag is in the T0 (prune) set.
 * Used as a fast path before the full `classifyTier` call.
 *
 * @param {Element} element - Element to test.
 * @returns {boolean} True if the element should be excluded from extraction entirely.
 */
function isTierZero(element) {
  return getT0Tags().has(element.tagName);
}

/**
 * Assigns an extraction tier to an element based on its tag and ARIA role.
 * Order of precedence: T0 → T3 (tag) → T3 (role) → T2 → T1 (fallback layout elements).
 *
 * @param {Element} element - Element to classify.
 * @returns {'T0'|'T1'|'T2'|'T3'} Tier string.
 */
function classifyTier(element) {
  const { tagName } = element;

  if (getT0Tags().has(tagName)) {return 'T0';}
  if (T3_TAGS.has(tagName))    {return 'T3';}

  const role = element.getAttribute('role');
  if (role && T3_ROLES.has(role)) {return 'T3';}
  if (T2_TAGS.has(tagName))       {return 'T2';}
  return 'T1';
}

/**
 * Returns true when an element occupies non-zero layout space and is not hidden by CSS.
 * Uses pre-computed style and rect to avoid redundant `getComputedStyle` / `getBoundingClientRect` calls.
 *
 * @param {CSSStyleDeclaration|null} computedStyle - Result of `getComputedStyle(element)`.
 * @param {DOMRect} rect - Result of `element.getBoundingClientRect()`.
 * @returns {boolean} True if the element is visible to the user.
 */
function isVisible(computedStyle, rect) {
  if (!computedStyle) {return false;}
  return (
    computedStyle.display     !== 'none'   &&
    computedStyle.visibility  !== 'hidden' &&
    parseFloat(computedStyle.opacity) > 0  &&
    rect.width  > 0 &&
    rect.height > 0
  );
}

export { isTierZero, classifyTier, isVisible, getT0Tags };