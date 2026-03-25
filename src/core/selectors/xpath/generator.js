import { get } from '../../../config/defaults.js';
import logger from '../../../infrastructure/logger.js';
import { getUniversalTag, isStableId } from '../selector-utils.js';
import { getAllStrategies, TIER_ROBUSTNESS } from './strategies.js';
import { countXPathMatches, ensureUniqueness, isUniqueXPath, escapeXPath } from './validator.js';

const TEST_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-automation-id'];

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

function _extractPredicate(xpath) {
  const match = xpath.match(/\/\/[a-zA-Z*][a-zA-Z0-9_:-]*(\[[\s\S]*\])?$/);
  if (!match) {return null;}
  const segment = match[0];
  const tagMatch = segment.match(/^\/\/[a-zA-Z*][a-zA-Z0-9_:-]*/);
  if (!tagMatch) {return null;}
  return segment.slice(tagMatch[0].length);
}

function _buildFallback(element) {
  return {
    xpath:      _buildPositionPath(element),
    confidence: 30,
    strategy:   'fallback-position'
  };
}

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