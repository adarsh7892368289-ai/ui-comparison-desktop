/**
 * Generates a stable XPath selector for a DOM element by trying tiered strategies in order.
 * Falls back to a positional absolute path when no semantic strategy succeeds.
 * Runs in the content-script context.
 * Invariant: always resolves — never rejects or returns null.
 * Called by: selector-engine.js via `generateXPath(element)`.
 */
import { get } from '../../../config/defaults.js';
import logger from '../../../infrastructure/logger.js';
import { getUniversalTag, isStableId } from '../selector-utils.js';
import { getAllStrategies, TIER_ROBUSTNESS } from './strategies.js';
import { countXPathMatches, ensureUniqueness, isUniqueXPath, escapeXPath } from './validator.js';

// Test-automation attributes checked when anchoring a non-unique XPath to an ancestor.
const TEST_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-automation-id'];

/**
 * Entry point: tries four tier bands (1–5, 6–10, 11–15, 16–21) in order.
 * Each band races in parallel; the first successful tier stops the search.
 * Uses `getUniversalTag` so SVG/MathML elements get namespace-safe XPath axes.
 *
 * @param {Element} element
 * @returns {Promise<{xpath: string, confidence: number, strategy: string}>} Never rejects.
 */
async function generateXPath(element) {
  if (!element || !element.tagName) {return _buildFallback(element);}

  const tag = getUniversalTag(element);
  const perStrategyTimeout = get('selectors.xpath.perStrategyTimeout', 80);
  const strategies = getAllStrategies();

  const tierGroups = [
    strategies.filter(s => s.tier <= 5),
    strategies.filter(s => s.tier >= 6  && s.tier <= 10),
    strategies.filter(s => s.tier >= 11 && s.tier <= 15),
    strategies.filter(s => s.tier >= 16 && s.tier <= 21)
  ];

  for (const group of tierGroups) {
    const result = await _tryGroup(element, tag, group, perStrategyTimeout);
    if (result) {
      logger.debug('XPath generated', {
        xpath: result.xpath,
        strategy: result.strategy,
        tier: result.tier,
        confidence: TIER_ROBUSTNESS[result.tier] || 50
      });
      return {
        xpath:      result.xpath,
        confidence: TIER_ROBUSTNESS[result.tier] || 50,
        strategy:   result.strategy
      };
    }
  }

  logger.debug('XPath: all semantic strategies exhausted, using positional fallback', {
    tag: element.tagName
  });
  return _buildFallback(element);
}

/**
 * Races all strategies in a tier group and returns the lowest-tier success.
 *
 * @param {Element} element
 * @param {string} tag
 * @param {Array<{tier: number, fn: Function, name: string}>} strategies
 * @param {number} perStrategyTimeout
 * @returns {Promise<object|null>}
 */
async function _tryGroup(element, tag, strategies, perStrategyTimeout) {
  const settled = await Promise.allSettled(
    strategies.map(({ tier, fn, name }) =>
      _runStrategy(element, tag, tier, fn, name, perStrategyTimeout)
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
 * Runs one strategy inside a timeout guard. For each candidate XPath:
 * 1. If unique — accept as-is.
 * 2. If non-unique — try scoping under a stable ancestor.
 * 3. If still non-unique — append a positional disambiguator via `ensureUniqueness`.
 * Resolves null on timeout, error, or exhausted candidates.
 *
 * @param {Element} element
 * @param {string} tag
 * @param {number} tier
 * @param {Function} fn - Strategy function returning candidate XPaths.
 * @param {string} name
 * @param {number} timeout
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
        if (!candidate || !candidate.xpath) {continue;}

        const matchCount = countXPathMatches(candidate.xpath);
        if (matchCount === 0) {continue;}

        if (matchCount === 1) {
          if (!isUniqueXPath(candidate.xpath, element)) {continue;}
          clearTimeout(timer);
          resolve({ xpath: candidate.xpath, strategy: name, tier, robustness: TIER_ROBUSTNESS[tier] || 50 });
          return;
        }

        // Candidate matches multiple nodes — try anchoring to a stable ancestor first.
        const narrowed = _narrowByAncestor(candidate.xpath, element);
        if (narrowed) {
          const narrowedCount = countXPathMatches(narrowed);
          if (narrowedCount === 1 && isUniqueXPath(narrowed, element)) {
            clearTimeout(timer);
            resolve({ xpath: narrowed, strategy: `${name}+ancestor`, tier, robustness: TIER_ROBUSTNESS[tier] || 50 });
            return;
          }

          if (narrowedCount > 1) {
            const disambiguated = ensureUniqueness(narrowed, element);
            if (isUniqueXPath(disambiguated, element)) {
              clearTimeout(timer);
              resolve({ xpath: disambiguated, strategy: `${name}+ancestor+pos`, tier, robustness: TIER_ROBUSTNESS[tier] || 50 });
              return;
            }
          }
        }

        const disambiguated = ensureUniqueness(candidate.xpath, element);
        if (isUniqueXPath(disambiguated, element)) {
          clearTimeout(timer);
          resolve({ xpath: disambiguated, strategy: `${name}+pos`, tier, robustness: TIER_ROBUSTNESS[tier] || 50 });
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
 * Extracts the predicate portion of an XPath and rebuilds it scoped under a stable
 * ancestor's ID or test attribute, reducing false matches in repeated DOM patterns.
 *
 * @param {string} xpath - The original non-unique XPath.
 * @param {Element} element
 * @returns {string|null} Scoped XPath or null if no stable ancestor found.
 */
function _narrowByAncestor(xpath, element) {
  const elementTag = getUniversalTag(element);
  const predicate = _extractPredicate(xpath);
  if (predicate === null) {return null;}

  let ancestor = element.parentElement;
  let depth = 0;

  while (ancestor && depth < 6) {
    const ancTag = getUniversalTag(ancestor);

    if (ancestor.id && isStableId(ancestor.id)) {
      return `//${ancTag}[@id=${escapeXPath(ancestor.id)}]//${elementTag}${predicate}`;
    }

    for (const attr of TEST_ATTRS) {
      const val = ancestor.getAttribute(attr);
      if (val) {
        return `//${ancTag}[@${attr}=${escapeXPath(val)}]//${elementTag}${predicate}`;
      }
    }

    ancestor = ancestor.parentElement;
    depth++;
  }

  return null;
}

/**
 * Extracts the predicate (e.g. `[@aria-label="Submit"]`) from the last step of an XPath.
 * Returns null when the expression doesn't match the expected `//tag[predicate]` shape.
 *
 * @param {string} xpath
 * @returns {string|null}
 */
function _extractPredicate(xpath) {
  const match = xpath.match(/\/\/[a-zA-Z*][a-zA-Z0-9_:-]*(\[[\s\S]*\])?$/);
  if (!match) {return null;}
  const segment = match[0];
  const tagMatch = segment.match(/^\/\/[a-zA-Z*][a-zA-Z0-9_:-]*/);
  if (!tagMatch) {return null;}
  return segment.slice(tagMatch[0].length);
}

/**
 * Returns a low-confidence positional fallback — used when all semantic strategies fail.
 *
 * @param {Element} element
 * @returns {{xpath: string, confidence: number, strategy: string}}
 */
function _buildFallback(element) {
  return {
    xpath:      _buildPositionPath(element),
    confidence: 30,
    strategy:   'fallback-position'
  };
}

/**
 * Builds an absolute positional XPath by walking from the element to the root,
 * using stable IDs as early-exit anchors to keep the path as short as possible.
 *
 * @param {Element} element
 * @returns {string} Absolute XPath, e.g. `/html/body/div[2]/span`.
 */
function _buildPositionPath(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {return '/html';}

  const path = [];
  let current = element;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    const parent = current.parentElement;
    const currTag = getUniversalTag(current);

    if (!parent) {
      path.unshift(currTag);
      break;
    }

    if (current.id && isStableId(current.id)) {
      path.unshift(`${currTag}[@id=${escapeXPath(current.id)}]`);
      break;
    }

    const sameTag = Array.from(parent.children).filter(c => c.tagName === current.tagName);
    if (sameTag.length === 1) {
      path.unshift(currTag);
    } else {
      const idx = sameTag.indexOf(current) + 1;
      path.unshift(`${currTag}[${idx}]`);
    }

    current = parent;
  }

  return path.length > 0 ? `/${path.join('/')}` : '/html';
}

export { generateXPath };