/**
 * Translates user-supplied filter inputs (class, id, tag) into CSS selectors
 * and resolves them against the live document to produce a de-duplicated list
 * of top-level traversal roots.
 *
 * Execution context: content script.
 * Invariant: ancestor-descendant pairs in the resolved set are collapsed to the ancestor only,
 * preventing dom-traversal from double-counting elements inside a filtered subtree.
 *
 * Direct callers: dom-traversal.js
 */

import logger from '../../infrastructure/logger.js';

/**
 * Converts a comma-separated class expression (e.g. `"card active, hero"`) into a
 * CSS selector string (e.g. `".card.active,.hero"`).
 * Leading dots are normalised and values are CSS-escaped to handle special characters.
 *
 * @param {string} raw - Raw class filter string from the popup input.
 * @returns {string|null} Valid CSS selector string, or null if input is empty/blank.
 */
function parseClassExpression(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {return null;}

  const groups = trimmed.split(',');
  const selectors = [];

  for (const group of groups) {
    const classes = group.trim().split(/\s+/).filter(Boolean);
    if (classes.length === 0) {continue;}

    const normalized = classes.map(cls => {
      const clean = cls.replace(/^\./u, '');
      return `.${CSS.escape(clean)}`;
    });

    selectors.push(normalized.join(''));
  }

  return selectors.length > 0 ? selectors.join(',') : null;
}

/**
 * Converts a comma-separated id expression (e.g. `"#hero, main"`) into a CSS id selector string.
 * Leading `#` characters are normalised and values are CSS-escaped.
 *
 * @param {string} raw - Raw id filter string from the popup input.
 * @returns {string|null} Valid CSS selector string, or null if input is empty/blank.
 */
function parseIdExpression(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {return null;}

  const ids = trimmed.split(',').map(i => i.trim()).filter(Boolean);
  if (ids.length === 0) {return null;}

  return ids.map(id => `#${CSS.escape(id.replace(/^#/u, ''))}`).join(',');
}

/**
 * Converts a whitespace/comma-separated tag expression (e.g. `"section, article"`) into
 * a lowercase CSS tag selector string.
 *
 * @param {string} raw - Raw tag filter string from the popup input.
 * @returns {string|null} Valid CSS selector string, or null if input is empty/blank.
 */
function parseTagExpression(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {return null;}

  const tags = trimmed.split(/[\s,]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
  if (tags.length === 0) {return null;}

  return tags.join(',');
}

/**
 * Merges all active filter sub-selectors into one combined CSS selector string.
 * Parts with no filter value are omitted — a class-only filter produces only the class part.
 *
 * @param {{ class?: string, id?: string, tag?: string }} filters - Active filter inputs.
 * @returns {string|null} Combined selector, or null if all filter fields are empty.
 */
function buildCombinedSelector(filters) {
  const parts = [
    filters.class ? parseClassExpression(filters.class) : null,
    filters.id    ? parseIdExpression(filters.id)        : null,
    filters.tag   ? parseTagExpression(filters.tag)      : null
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(',') : null;
}

/**
 * Removes any candidate from the list whose ancestor is also in the list.
 * Without this step, dom-traversal would visit nested matches twice — once via the ancestor
 * and once when it reaches the descendant root.
 *
 * @param {Element[]} candidates - Raw `querySelectorAll` matches.
 * @returns {Element[]} Filtered list containing only elements with no matched ancestor.
 */
function pruneToTopLevelRoots(candidates) {
  const candidateSet = new WeakSet(candidates);

  return candidates.filter(candidate => {
    let ancestor = candidate.parentElement;
    while (ancestor) {
      if (candidateSet.has(ancestor)) {return false;}
      ancestor = ancestor.parentElement;
    }
    return true;
  });
}

/**
 * Builds the combined selector from `filters`, runs it against the document, and returns
 * the pruned top-level root elements for dom-traversal.
 *
 * @param {{ class?: string, id?: string, tag?: string }} filters - Active filter inputs.
 * @returns {Element[]|null} Top-level root elements, empty array if selector matches nothing,
 *   or null if the selector could not be built or executed (caller falls back to full traversal).
 */
function resolveFilteredRoots(filters) {
  const selector = buildCombinedSelector(filters);

  if (!selector) {
    logger.debug('No valid filter selector — falling back to full document traversal');
    return null;
  }

  let candidates;
  try {
    candidates = Array.from(document.querySelectorAll(selector));
  } catch (err) {
    logger.error('Filter selector failed', { selector, error: err.message });
    return null;
  }

  if (candidates.length === 0) {
    logger.debug('Filter matched zero elements', { selector });
    return [];
  }

  const roots = pruneToTopLevelRoots(candidates);

  logger.debug('Filter roots resolved', {
    selector,
    candidates: candidates.length,
    roots:      roots.length
  });

  return roots;
}

/**
 * Returns true when at least one filter field (class, id, or tag) has a non-empty value.
 * Used by dom-traversal to decide whether to run the full-document or filtered path.
 *
 * @param {{ class?: string, id?: string, tag?: string }|null|undefined} filters - Filter config.
 * @returns {boolean}
 */
function hasActiveFilters(filters) {
  return Boolean(filters && (filters.class || filters.id || filters.tag));
}

export { resolveFilteredRoots, hasActiveFilters, buildCombinedSelector };