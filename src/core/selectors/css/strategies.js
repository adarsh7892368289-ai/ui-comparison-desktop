/**
 * Ordered CSS selector strategies organised into 12 tiers by stability.
 * Lower tier = more stable (test attributes > semantic > positional).
 * Runs in the content-script context; all methods are synchronous.
 * Invariant: every static method returns an array — never null or undefined.
 * Called by: css/generator.js via `getAllStrategies()`.
 */
import { isStableId, isStableValue, isStableClass } from '../selector-utils.js';
import { escapeCss } from './validator.js';

/**
 * Confidence score per tier. Lower tier = higher score.
 * Exported so generator.js can attach confidence to the returned selector object.
 */
const TIER_ROBUSTNESS = {
  1: 100, 2: 91, 3: 88, 4: 85, 5: 82, 6: 78, 7: 72, 8: 68,
  9: 64, 10: 58, 11: 46, 12: 37, 13: 28
};

// Ordered list of test-automation attributes to probe before generic data-* attributes.
const TEST_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-automation-id'];

/**
 * Collection of static CSS selector strategy methods, one per tier.
 * Each method receives the target element and its lowercase tag name,
 * and returns an array of candidate `{ selector, strategy, tier }` objects.
 * The generator picks the first candidate that is unique in the document.
 */
class CSSStrategies {

  /** Tier 1 — stable ID: most reliable; filtered by `isStableId` to exclude generated IDs. */
  static tier1Id(element, tag) {
    const {id} = element;
    if (!id || !isStableId(id)) {return [];}
    const escaped = CSS.escape ? CSS.escape(id) : escapeCss(id);
    return [{ selector: `${tag}#${escaped}`, strategy: 'id', tier: 1 }];
  }

  /** Tier 2 — test-automation attributes (data-testid, data-qa, etc.); intended to be stable by convention. */
  static tier2TestAttributes(element, tag) {
    const results = [];
    for (const attr of TEST_ATTRS) {
      const value = element.getAttribute(attr);
      if (value && isStableValue(value)) {
        results.push({ selector: `${tag}[${attr}="${escapeCss(value)}"]`, strategy: 'test-attr', tier: 2 });
      }
    }
    return results;
  }

  /** Tier 3 — non-test `data-*` attributes with stable values; excludes test attrs already covered by tier 2. */
  static tier3DataAttributes(element, tag) {
    const results = [];
    for (const { name, value } of Array.from(element.attributes)) {
      if (!name.startsWith('data-') || TEST_ATTRS.includes(name)) {continue;}
      if (value && isStableValue(value) && value.length < 100) {
        results.push({ selector: `${tag}[${name}="${escapeCss(value)}"]`, strategy: 'data-attr', tier: 3 });
      }
    }
    return results;
  }

  /** Tier 4 — `[type][name]` combination; reliable for form inputs where both attributes are meaningful. */
  static tier4TypeName(element, tag) {
    const type = element.getAttribute('type');
    const name = element.getAttribute('name');
    if (type && name && isStableValue(name)) {
      return [{ selector: `${tag}[type="${escapeCss(type)}"][name="${escapeCss(name)}"]`, strategy: 'type-name', tier: 4 }];
    }
    return [];
  }

  /** Tier 5 — ARIA label / labelledby; stable for accessible components but can change with i18n. */
  static tier5AriaLabel(element, tag) {
    const results = [];
    const ariaLabel = element.getAttribute('aria-label');
    const ariaLabelledBy = element.getAttribute('aria-labelledby');
    if (ariaLabel && ariaLabel.length > 0 && ariaLabel.length < 120) {
      results.push({ selector: `${tag}[aria-label="${escapeCss(ariaLabel)}"]`, strategy: 'aria-label', tier: 5 });
    }
    if (ariaLabelledBy && isStableValue(ariaLabelledBy)) {
      results.push({ selector: `${tag}[aria-labelledby="${escapeCss(ariaLabelledBy)}"]`, strategy: 'aria-labelledby', tier: 5 });
    }
    return results;
  }

  /** Tier 6 — semantic HTML attributes (placeholder, alt, title, name, value, for); less stable across locales. */
  static tier6SemanticAttributes(element, tag) {
    const results = [];
    const checks = [
      ['placeholder', element.getAttribute('placeholder')],
      ['alt',         element.getAttribute('alt')],
      ['title',       element.getAttribute('title')],
      ['name',        element.getAttribute('name')],
      ['value',       element.getAttribute('value')],
      ['for',         element.getAttribute('for')]
    ];
    for (const [attr, value] of checks) {
      if (value && isStableValue(value) && value.length > 0 && value.length < 120) {
        results.push({ selector: `${tag}[${attr}="${escapeCss(value)}"]`, strategy: `attr-${attr}`, tier: 6 });
      }
    }
    return results;
  }

  /**
   * Tier 7 — class names; prefers two-class combos over single classes for uniqueness.
   * Only includes classes that pass `isStableClass` to exclude CSS-in-JS generated names.
   */
  static tier7Classes(element, tag) {
    const results = [];
    const classList = Array.from(element.classList).filter(isStableClass);
    if (classList.length === 0) {return results;}

    const escape = c => CSS.escape ? CSS.escape(c) : escapeCss(c);

    if (classList.length >= 2) {
      results.push({
        selector: `${tag}.${escape(classList[0])}.${escape(classList[1])}`,
        strategy: 'class-combo',
        tier: 7
      });
    }
    results.push({
      selector: `${tag}.${escape(classList[0])}`,
      strategy: 'class-single',
      tier: 7
    });
    return results;
  }

  /**
   * Tier 8 — scopes the tag under a stable ancestor's ID or test attribute.
   * Walks up to 5 levels; stops at the first stable anchor found.
   */
  static tier8ParentContextual(element, tag) {
    const results = [];
    let ancestor = element.parentElement;
    let depth = 0;

    while (ancestor && depth < 5) {
      if (ancestor.id && isStableId(ancestor.id)) {
        const escaped = CSS.escape ? CSS.escape(ancestor.id) : escapeCss(ancestor.id);
        results.push({ selector: `#${escaped} > ${tag}`, strategy: 'parent-id-direct', tier: 8 });
        results.push({ selector: `#${escaped} ${tag}`, strategy: 'parent-id-descendant', tier: 8 });
        break;
      }

      for (const attr of TEST_ATTRS) {
        const val = ancestor.getAttribute(attr);
        if (val) {
          results.push({ selector: `[${attr}="${escapeCss(val)}"] ${tag}`, strategy: 'parent-testid', tier: 8 });
          break;
        }
      }

      ancestor = ancestor.parentElement;
      depth++;
    }

    return results;
  }

  /** Tier 9 — state pseudo-classes (disabled, required, checked, read-only); fragile if state changes between captures. */
  static tier9Pseudo(element, tag) {
    const pseudos = [];
    if (element.disabled) {pseudos.push(':disabled');}
    if (element.required) {pseudos.push(':required');}
    if (element.checked)  {pseudos.push(':checked');}
    if (element.readOnly) {pseudos.push(':read-only');}
    if (pseudos.length === 0) {return [];}
    return [{ selector: `${tag}${pseudos.join('')}`, strategy: 'pseudo', tier: 9 }];
  }

  /** Tier 10 — href / src attribute; length-capped and `javascript:` links excluded. */
  static tier10HrefSrc(element, tag) {
    const results = [];
    const href = element.getAttribute('href');
    const src = element.getAttribute('src');
    if (href && href.length > 0 && href.length < 200 && !href.startsWith('javascript:')) {
      results.push({ selector: `${tag}[href="${escapeCss(href)}"]`, strategy: 'href', tier: 10 });
    }
    if (src && src.length > 0 && src.length < 200) {
      results.push({ selector: `${tag}[src="${escapeCss(src)}"]`, strategy: 'src', tier: 10 });
    }
    return results;
  }

  /** Tier 11 — `nth-child` scoped under the nearest stable ancestor; positional but anchored. */
  static tier11NthChildScoped(element, tag) {
    const parent = element.parentElement;
    if (!parent) {return [];}

    const siblings = Array.from(parent.children);
    const index = siblings.indexOf(element);
    if (index === -1) {return [];}

    const nthSelector = `${tag}:nth-child(${index + 1})`;
    const ancestor = _findStableAncestor(element);

    if (ancestor) {
      const ancSelector = _buildAncestorSelector(ancestor);
      return [{ selector: `${ancSelector} ${nthSelector}`, strategy: 'nth-child-scoped', tier: 11 }];
    }

    return [{ selector: nthSelector, strategy: 'nth-child', tier: 11 }];
  }

  /** Tier 12 — `nth-of-type` scoped under the nearest stable ancestor; last resort before positional fallback. */
  static tier12NthTypeScoped(element, tag) {
    const parent = element.parentElement;
    if (!parent) {return [];}

    const siblings = Array.from(parent.children).filter(el => el.tagName.toLowerCase() === tag);
    const index = siblings.indexOf(element);
    if (index === -1) {return [];}

    const nthSelector = `${tag}:nth-of-type(${index + 1})`;
    const ancestor = _findStableAncestor(element);

    if (ancestor) {
      const ancSelector = _buildAncestorSelector(ancestor);
      return [{ selector: `${ancSelector} ${nthSelector}`, strategy: 'nth-type-scoped', tier: 12 }];
    }

    return [{ selector: nthSelector, strategy: 'nth-type', tier: 12 }];
  }
}

/**
 * Walks the ancestor chain (max 6 levels) returning the first element with a stable
 * ID or test attribute — used to scope positional selectors.
 *
 * @param {Element} element
 * @returns {Element|null}
 */
function _findStableAncestor(element) {
  let current = element.parentElement;
  let depth = 0;
  while (current && depth < 6) {
    if (current.id && isStableId(current.id)) {return current;}
    for (const attr of TEST_ATTRS) {
      if (current.getAttribute(attr)) {return current;}
    }
    current = current.parentElement;
    depth++;
  }
  return null;
}

/**
 * Converts a stable ancestor element into the shortest reliable CSS selector for it.
 * Prefers ID over test attribute over tag name.
 *
 * @param {Element} ancestor
 * @returns {string}
 */
function _buildAncestorSelector(ancestor) {
  if (ancestor.id && isStableId(ancestor.id)) {
    const escaped = CSS.escape ? CSS.escape(ancestor.id) : escapeCss(ancestor.id);
    return `#${escaped}`;
  }
  for (const attr of TEST_ATTRS) {
    const val = ancestor.getAttribute(attr);
    if (val) {return `[${attr}="${escapeCss(val)}"]`;}
  }
  return ancestor.tagName.toLowerCase();
}

/**
 * Returns the full ordered strategy list for use by the generator.
 * Each entry wraps the static method in an arrow function to preserve the call signature.
 *
 * @returns {Array<{tier: number, fn: Function, name: string}>}
 */
function getAllStrategies() {
  return [
    { tier: 1,  fn: (el, tag) => CSSStrategies.tier1Id(el, tag),               name: 'id' },
    { tier: 2,  fn: (el, tag) => CSSStrategies.tier2TestAttributes(el, tag),    name: 'test-attr' },
    { tier: 3,  fn: (el, tag) => CSSStrategies.tier3DataAttributes(el, tag),    name: 'data-attr' },
    { tier: 4,  fn: (el, tag) => CSSStrategies.tier4TypeName(el, tag),          name: 'type-name' },
    { tier: 5,  fn: (el, tag) => CSSStrategies.tier5AriaLabel(el, tag),         name: 'aria-label' },
    { tier: 6,  fn: (el, tag) => CSSStrategies.tier6SemanticAttributes(el, tag),name: 'semantic-attr' },
    { tier: 7,  fn: (el, tag) => CSSStrategies.tier7Classes(el, tag),           name: 'classes' },
    { tier: 8,  fn: (el, tag) => CSSStrategies.tier8ParentContextual(el, tag),  name: 'parent-ctx' },
    { tier: 9,  fn: (el, tag) => CSSStrategies.tier9Pseudo(el, tag),            name: 'pseudo' },
    { tier: 10, fn: (el, tag) => CSSStrategies.tier10HrefSrc(el, tag),          name: 'href-src' },
    { tier: 11, fn: (el, tag) => CSSStrategies.tier11NthChildScoped(el, tag),   name: 'nth-child' },
    { tier: 12, fn: (el, tag) => CSSStrategies.tier12NthTypeScoped(el, tag),    name: 'nth-type' }
  ];
}

export { CSSStrategies, getAllStrategies, TIER_ROBUSTNESS };