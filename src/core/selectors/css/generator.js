/**
 * Generates a stable CSS selector for a DOM element by trying tiered strategies in order.
 * Falls back to a positional path when no semantic strategy succeeds.
 * Runs in the content-script context.
 * Invariant: always returns a result object — never throws or resolves to null.
 * Called by: selector-engine.js via `generateCSS(element)`.
 */
import { get } from '../../../config/defaults.js';
import logger from '../../../infrastructure/logger.js';
import { isStableId } from '../selector-utils.js';
import { getAllStrategies, TIER_ROBUSTNESS } from './strategies.js';
import { isUniqueCssSelector, isValidCssSelector, escapeCss } from './validator.js';

// Test-automation attributes checked when anchoring a non-unique selector to an ancestor.
const TEST_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-automation-id'];

/**
 * Entry point: runs all strategies grouped into three tier bands (1–4, 5–8, 9–11).
 * Each band races in parallel; if any strategy in the current band succeeds, later bands
 * are skipped. This keeps low-tier (high-confidence) selectors cheap by avoiding
 * expensive positional strategies when a test-attribute match is available.
 *
 * @param {Element} element
 * @returns {Promise<{css: string, confidence: number, strategy: string}>} Never rejects.
 */
async function generateCSS(element) {
  if (!element || !element.tagName) {return _buildFallback(element);}

  const tag = element.tagName.toLowerCase();
  const perStrategyTimeout = get('selectors.css.perStrategyTimeout', 50);
  const strategies = getAllStrategies();

  const tierGroups = [
    strategies.filter(s => s.tier <= 4),
    strategies.filter(s => s.tier >= 5 && s.tier <= 8),
    strategies.filter(s => s.tier >= 9 && s.tier <= 11)
  ];

  for (const group of tierGroups) {
    const result = await _tryGroup(element, tag, group, perStrategyTimeout);
    if (result) {
      logger.debug('CSS generated', {
        css: result.selector,
        strategy: result.strategy,
        tier: result.tier
      });
      return {
        css:        result.selector,
        confidence: TIER_ROBUSTNESS[result.tier] || 50,
        strategy:   result.strategy
      };
    }
  }

  logger.debug('CSS: all semantic strategies exhausted, using positional fallback', {
    tag: element.tagName
  });
  return _buildFallback(element);
}

/**
 * Runs all strategies in a tier group in parallel, collects successes, and returns
 * the one with the lowest (best) tier number.
 *
 * @param {Element} element
 * @param {string} tag - Lowercase tag name.
 * @param {Array<{tier: number, fn: Function, name: string}>} strategies
 * @param {number} timeout - Per-strategy timeout in ms.
 * @returns {Promise<object|null>} Best result or null if no strategy succeeded.
 */
async function _tryGroup(element, tag, strategies, timeout) {
  const settled = await Promise.allSettled(
    strategies.map(({ tier, fn, name }) =>
      _runStrategy(element, tag, tier, fn, name, timeout)
    )
  );

  const successes = settled
    .filter(s => s.status === 'fulfilled' && s.value !== null)
    .map(s => s.value);

  if (successes.length === 0) {return null;}
  successes.sort((a, b) => a.tier - b.tier);
  return successes[0];
}

/**
 * Runs a single strategy function inside a per-strategy timeout guard.
 * For each candidate selector, tries it bare first, then anchored to a stable ancestor.
 * Resolves to null on timeout, error, or when no candidate is unique.
 *
 * @param {Element} element
 * @param {string} tag
 * @param {number} tier
 * @param {Function} fn - Strategy function returning candidate selectors.
 * @param {string} name - Strategy name for logging.
 * @param {number} timeout - Max ms before resolving null.
 * @returns {Promise<object|null>}
 */
function _runStrategy(element, tag, tier, fn, name, timeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);

    try {
      const candidates = fn(element, tag);

      if (!candidates || candidates.length === 0) {
        clearTimeout(timer);
        resolve(null);
        return;
      }

      for (const candidate of candidates) {
        if (!candidate || !candidate.selector) {continue;}
        if (!isValidCssSelector(candidate.selector)) {continue;}

        if (isUniqueCssSelector(candidate.selector, element)) {
          clearTimeout(timer);
          resolve({ selector: candidate.selector, strategy: name, tier, robustness: TIER_ROBUSTNESS[tier] || 50 });
          return;
        }

        // Bare selector not unique — try prepending a stable ancestor scope.
        const anchored = _anchorToStableAncestor(candidate.selector, element);
        if (anchored && isValidCssSelector(anchored) && isUniqueCssSelector(anchored, element)) {
          clearTimeout(timer);
          resolve({ selector: anchored, strategy: `${name}+ancestor`, tier, robustness: TIER_ROBUSTNESS[tier] || 50 });
          return;
        }
      }

      clearTimeout(timer);
      resolve(null);
    } catch (_) {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/**
 * Walks up the ancestor chain (max 6 levels) looking for a stable ID or test attribute
 * to prepend to `selector` so it becomes unique within that scope.
 *
 * @param {string} selector - The non-unique candidate selector.
 * @param {Element} element
 * @returns {string|null} Scoped selector string, or null if no stable ancestor found.
 */
function _anchorToStableAncestor(selector, element) {
  let ancestor = element.parentElement;
  let depth = 0;

  while (ancestor && depth < 6) {
    if (ancestor.id && isStableId(ancestor.id)) {
      const escaped = CSS.escape ? CSS.escape(ancestor.id) : escapeCss(ancestor.id);
      return `#${escaped} ${selector}`;
    }

    for (const attr of TEST_ATTRS) {
      const val = ancestor.getAttribute(attr);
      if (val) {return `[${attr}="${escapeCss(val)}"] ${selector}`;}
    }

    ancestor = ancestor.parentElement;
    depth++;
  }

  return null;
}

/**
 * Returns a low-confidence positional fallback result — used when all semantic
 * strategies fail. Confidence is 30 to signal fragility to the comparison engine.
 *
 * @param {Element} element
 * @returns {{css: string, confidence: number, strategy: string}}
 */
function _buildFallback(element) {
  return {
    css:        _buildPositionPath(element),
    confidence: 30,
    strategy:   'fallback-position'
  };
}

/**
 * Constructs a `>` separated positional CSS path from the element to its nearest
 * stable ID or the document root. Prefers stable classes over `nth-of-type` when
 * they uniquely identify the element.
 *
 * @param {Element} element
 * @returns {string} CSS selector string, never empty (falls back to `'html'`).
 */
function _buildPositionPath(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {return 'html';}

  const path = [];
  let current = element;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    const parent = current.parentElement;
    const tag = current.tagName.toLowerCase();

    if (!parent) {
      path.unshift(tag);
      break;
    }

    if (current.id && isStableId(current.id)) {
      const escaped = CSS.escape ? CSS.escape(current.id) : escapeCss(current.id);
      path.unshift(`#${escaped}`);
      break;
    }

    const stableClasses = Array.from(current.classList)
      .filter(c => c.length >= 2 && !/^(Mui|makeStyles-|css-[a-z0-9]+$|jss\d+$|sc-|emotion-|lwc-)/.test(c))
      .slice(0, 2);

    if (stableClasses.length > 0) {
      const classSel = `${tag}.${stableClasses.map(c => CSS.escape ? CSS.escape(c) : escapeCss(c)).join('.')}`;
      // Only short-circuit on class if the selector is already unique in the document.
      if (document.querySelectorAll(classSel).length === 1) {
        path.unshift(classSel);
        break;
      }
    }

    const sameTag = Array.from(parent.children).filter(c => c.tagName === current.tagName);
    if (sameTag.length === 1) {
      path.unshift(tag);
    } else {
      const idx = sameTag.indexOf(current) + 1;
      path.unshift(`${tag}:nth-of-type(${idx})`);
    }

    current = parent;
  }

  return path.join(' > ');
}

export { generateCSS };