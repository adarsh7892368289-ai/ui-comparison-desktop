/**
 * Builds structural context descriptors (neighbours, class hierarchy) for extracted elements.
 * This enrichment data is attached to each node so the matcher can disambiguate elements
 * that share the same HPID after dynamic list reordering.
 *
 * Execution context: content script.
 * Invariant: all functions are pure — they read the live DOM but never mutate it.
 *
 * Direct callers: extractor.js
 */

import { get } from '../../config/defaults.js';

/**
 * Produces a compact CSS-like reference string for an element (e.g. `div#hero.card.active`).
 * Class count is capped by config to keep neighbour strings scannable in reports.
 *
 * @param {Element} element - The DOM element to describe.
 * @returns {string} Shortened identifier combining tag, id, and leading classes.
 */
function formatElementRef(element) {
  let ref = element.tagName.toLowerCase();

  if (element.id) {
    ref += `#${element.id}`;
  }

  if (element.className && typeof element.className === 'string') {
    const maxClasses = get('schema.enrichment.neighbours.maxParentClasses', 3);
    const classes    = element.className.trim().split(/\s+/).slice(0, maxClasses);
    if (classes.length > 0 && classes[0]) {
      ref += `.${classes.join('.')}`;
    }
  }

  return ref;
}

/**
 * Summarises direct child elements as a frequency-annotated tag list (e.g. `['li(5)', 'span']`).
 * Count annotation is omitted for singleton tags to reduce noise.
 *
 * @param {HTMLCollection} children - Live children collection from the parent element.
 * @returns {string[]} Tag names with optional repeat counts, capped by config.
 */
function getChildrenTypes(children) {
  const maxTypes  = get('schema.enrichment.neighbours.maxChildrenTypes', 10);
  const typeCounts = {};

  for (const child of children) {
    const type = child.tagName.toLowerCase();
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  }

  return Object.entries(typeCounts)
    .map(([type, count]) => count > 1 ? `${type}(${count})` : type)
    .slice(0, maxTypes);
}

/**
 * Collects immediate structural neighbours of an element (parent, siblings, children summary).
 * Null is returned for absent neighbours rather than omitting the key, so callers can
 * distinguish "no sibling" from "sibling not yet computed".
 *
 * @param {Element} element - Target element whose neighbourhood to describe.
 * @returns {{ parent: string|null, previousSibling: string|null, nextSibling: string|null, childrenCount: number, childrenTypes: string[] }}
 */
function getNeighbours(element) {
  const parent          = element.parentElement;
  const previousSibling = element.previousElementSibling;
  const nextSibling     = element.nextElementSibling;
  const { children }    = element;

  return {
    parent:          parent          ? formatElementRef(parent)          : null,
    previousSibling: previousSibling ? formatElementRef(previousSibling) : null,
    nextSibling:     nextSibling     ? formatElementRef(nextSibling)     : null,
    childrenCount:   children ? children.length : 0,
    childrenTypes:   children ? getChildrenTypes(children) : []
  };
}

/**
 * Walks ancestor chain (up to `maxParentDepth`) and samples child classes to give the matcher
 * a scoped view of the element's CSS context without serialising the entire subtree.
 * Classless ancestors and children are silently skipped.
 *
 * @param {Element} element - Target element.
 * @returns {{ parentClasses: Array<{tag: string, classes: string[]}>, childClasses: Array<{tag: string, classes: string[]}>}}
 */
function getClassHierarchy(element) {
  const maxParentDepth = get('schema.enrichment.classHierarchy.maxParentDepth', 3);
  const maxChildCount  = get('schema.enrichment.classHierarchy.maxChildCount',  10);
  const maxClassSlice  = get('schema.enrichment.classHierarchy.maxClassSlice',  2);
  const hierarchy      = { parentClasses: [], childClasses: [] };

  let current = element.parentElement;
  let depth   = 0;

  while (current && depth < maxParentDepth) {
    if (current.className && typeof current.className === 'string') {
      const classes = current.className.trim().split(/\s+/);
      if (classes.length > 0 && classes[0]) {
        hierarchy.parentClasses.push({
          tag:     current.tagName.toLowerCase(),
          classes: classes.slice(0, maxClassSlice)
        });
      }
    }
    current = current.parentElement;
    depth++;
  }

  let counted = 0;
  for (const child of element.children) {
    if (counted >= maxChildCount) {break;}
    if (child.className && typeof child.className === 'string') {
      const classes = child.className.trim().split(/\s+/);
      if (classes.length > 0 && classes[0]) {
        hierarchy.childClasses.push({
          tag:     child.tagName.toLowerCase(),
          classes: classes.slice(0, maxClassSlice)
        });
        counted++;
      }
    }
  }

  return hierarchy;
}

export { getNeighbours, getClassHierarchy, formatElementRef };