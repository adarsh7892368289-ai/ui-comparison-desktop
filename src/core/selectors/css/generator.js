import { get } from '../../../config/defaults.js';
import logger from '../../../infrastructure/logger.js';
import { isStableId } from '../selector-utils.js';
import { getAllStrategies, TIER_ROBUSTNESS } from './strategies.js';
import { isUniqueCssSelector, isValidCssSelector, escapeCss } from './validator.js';
const TEST_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-automation-id'];
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

function _buildFallback(element) {
  return {
    css:        _buildPositionPath(element),
    confidence: 30,
    strategy:   'fallback-position'
  };
}

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