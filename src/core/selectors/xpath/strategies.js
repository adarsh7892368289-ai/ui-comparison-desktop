/**
 * Ordered XPath selector strategies organised into 23 tiers (0–22) by stability.
 * Lower tier = higher confidence (exact text > test attributes > positional index).
 * Runs in the content-script context; all methods are synchronous.
 * Invariant: every static method returns an array — never null or undefined.
 * Called by: xpath/generator.js via `getAllStrategies()`.
 */
import {
  cleanText,
  isStableId,
  isStableValue,
  isStaticText,
  getDataAttributes,
  collectStableAttributes,
  getStableAncestorChain,
  findBestSemanticAncestor,
  getUniversalTag
} from '../selector-utils.js';
import { escapeXPath } from './validator.js';

/**
 * Confidence score per tier. Exported for the generator to attach to results.
 * Note: tier 6 (semantic ancestor) outscores tier 5 (data-*) because an ancestor
 * landmark with an ID is a very strong anchor — intentional.
 */
const TIER_ROBUSTNESS = {
  0: 99, 1: 98, 2: 95, 3: 94, 4: 88, 5: 85, 6: 93, 7: 80, 8: 82, 9: 75,
  10: 76, 11: 80, 12: 72, 13: 74, 14: 68, 15: 64, 16: 64, 17: 60, 18: 58,
  19: 90, 20: 80, 21: 65, 22: 30
};

/**
 * Collection of static XPath strategy methods covering 23 tiers.
 * Each method returns an array of `{ xpath, strategy, tier }` candidates.
 * The generator tries candidates in tier order and accepts the first unique one.
 */
class XPathStrategies {

  /** Tier 0 — exact visible text; highest confidence but fragile to i18n/copy changes. */
  static tier0ExactText(element, tag) {
    const results = [];
    const text = cleanText(element.textContent);
    if (!text || text.length === 0 || text.length > 150) {return results;}
    if (!isStaticText(text)) {return results;}
    results.push({ xpath: `//${tag}[text()=${escapeXPath(text)}]`, strategy: 'exact-text', tier: 0 });
    return results;
  }

  /** Tier 1 — test-automation attributes; stable by engineering convention. */
  static tier1TestAttributes(element, tag) {
    const results = [];
    const testAttrs = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-automation-id'];
    for (const attr of testAttrs) {
      const value = element.getAttribute(attr);
      if (value && isStableValue(value)) {
        results.push({ xpath: `//${tag}[@${attr}=${escapeXPath(value)}]`, strategy: 'test-attr', tier: 1 });
      }
    }
    return results;
  }

  /** Tier 2 — stable `id` attribute; filtered by `isStableId` to exclude generated values. */
  static tier2StableId(element, tag) {
    const results = [];
    const {id} = element;
    if (id && isStableId(id)) {
      results.push({ xpath: `//${tag}[@id=${escapeXPath(id)}]`, strategy: 'stable-id', tier: 2 });
    }
    return results;
  }

  /**
   * Tier 3 — `normalize-space(.)` text match; more forgiving than `text()` for mixed-content nodes
   * where whitespace-only text nodes would break an exact match.
   */
  static tier3NormalizedText(element, tag) {
    const results = [];
    const text = cleanText(element.textContent);
    if (!text || text.length === 0 || text.length > 150) {return results;}
    if (!isStaticText(text)) {return results;}
    results.push({ xpath: `//${tag}[normalize-space(.)=${escapeXPath(text)}]`, strategy: 'normalized-text', tier: 3 });
    return results;
  }

  /** Tier 4 — highest-priority stable attributes from `collectStableAttributes`; capped at 3 candidates. */
  static tier4StableAttributes(element, tag) {
    const results = [];
    const stableAttrs = collectStableAttributes(element);
    for (const attr of stableAttrs.slice(0, 3)) {
      if (attr && attr.name && attr.value && isStableValue(attr.value)) {
        results.push({ xpath: `//${tag}[@${attr.name}=${escapeXPath(attr.value)}]`, strategy: 'stable-attr', tier: 4 });
      }
    }
    return results;
  }

  /** Tier 5 — `data-*` attributes; capped at 3 to avoid runaway candidate generation. */
  static tier5DataAttributes(element, tag) {
    const results = [];
    const dataAttrs = getDataAttributes(element);
    for (const [name, value] of Object.entries(dataAttrs).slice(0, 3)) {
      if (name && value && isStableValue(value)) {
        results.push({ xpath: `//${tag}[@${name}=${escapeXPath(value)}]`, strategy: 'data-attr', tier: 5 });
      }
    }
    return results;
  }

  /**
   * Tier 6 — scopes the tag under the nearest semantic landmark ancestor (form, nav, etc.)
   * that has a stable ID. A landmark with a stable ID is a very reliable anchor.
   */
  static tier6SemanticAncestor(element, tag) {
    const results = [];
    const ancestor = findBestSemanticAncestor(element);
    if (!ancestor) {return results;}
    const ancestorTag = getUniversalTag(ancestor);
    const ancestorId = ancestor.id;
    if (ancestorId && isStableId(ancestorId)) {
      results.push({ xpath: `//${ancestorTag}[@id=${escapeXPath(ancestorId)}]//${tag}`, strategy: 'semantic-ancestor', tier: 6 });
    }
    return results;
  }

  /** Tier 7 — nearby text anchor (reserved, not yet implemented). */
  static tier7NearbyText() {
    return [];
  }

  /** Tier 8 — anchors the element relative to an immediately adjacent sibling with a stable ID. */
  static tier8SiblingContext(element, tag) {
    const results = [];
    const prev = element.previousElementSibling;
    const next = element.nextElementSibling;
    if (prev && prev.id && isStableId(prev.id)) {
      const prevTag = getUniversalTag(prev);
      results.push({ xpath: `//${prevTag}[@id=${escapeXPath(prev.id)}]/following-sibling::${tag}[1]`, strategy: 'sibling-context', tier: 8 });
    }
    if (next && next.id && isStableId(next.id)) {
      const nextTag = getUniversalTag(next);
      results.push({ xpath: `//${nextTag}[@id=${escapeXPath(next.id)}]/preceding-sibling::${tag}[1]`, strategy: 'sibling-context', tier: 8 });
    }
    return results;
  }

  /**
   * Tier 9 — scopes the tag under the closest stable-attribute ancestor.
   * Uses the first entry from `getStableAncestorChain` (closest ancestor).
   */
  static tier9AncestorChain(element, tag) {
    const results = [];
    const chain = getStableAncestorChain(element, 3);
    if (chain.length === 0) {return results;}
    const ancestor = chain[0];
    const ancTag = getUniversalTag(ancestor.element);
    if (ancestor.element.id && isStableId(ancestor.element.id)) {
      results.push({ xpath: `//${ancTag}[@id=${escapeXPath(ancestor.element.id)}]//${tag}`, strategy: 'ancestor-chain', tier: 9 });
    } else if (ancestor.attr && ancestor.attr.name && ancestor.attr.value) {
      results.push({ xpath: `//${ancTag}[@${ancestor.attr.name}=${escapeXPath(ancestor.attr.value)}]//${tag}`, strategy: 'ancestor-chain', tier: 9 });
    }
    return results;
  }

  /** Tier 10 — `[type][name]` compound predicate; reliable for named form inputs. */
  static tier10TypeAndName(element, tag) {
    const results = [];
    const type = element.getAttribute('type');
    const name = element.getAttribute('name');
    if (type && name && isStableValue(name)) {
      results.push({ xpath: `//${tag}[@type=${escapeXPath(type)} and @name=${escapeXPath(name)}]`, strategy: 'type-name', tier: 10 });
    }
    return results;
  }

  /** Tier 11 — `aria-label`; accessible but may change with i18n. */
  static tier11AriaLabel(element, tag) {
    const results = [];
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.length > 0 && ariaLabel.length < 100) {
      results.push({ xpath: `//${tag}[@aria-label=${escapeXPath(ariaLabel)}]`, strategy: 'aria-label', tier: 11 });
    }
    return results;
  }

  /**
   * Tier 12 — `contains(normalize-space(.),…)` with the first 4 words of text.
   * More resilient than exact text for elements with trailing whitespace or punctuation.
   */
  static tier12PartialText(element, tag) {
    const results = [];
    const text = cleanText(element.textContent);
    if (!text || text.length < 5 || text.length > 200) {return results;}
    if (!isStaticText(text)) {return results;}
    const words = text.split(/\s+/).filter(w => w.length > 0);
    if (words.length >= 2) {
      const partial = words.slice(0, Math.min(4, words.length)).join(' ');
      if (partial.length >= 5) {
        results.push({ xpath: `//${tag}[contains(normalize-space(.), ${escapeXPath(partial)})]`, strategy: 'partial-text', tier: 12 });
      }
    }
    return results;
  }

  /**
   * Tier 13 — parent element with a stable ID plus an optional positional index.
   * Uses same-tag sibling count (not all children) for position predicates — XPath
   * `tag[N]` selects the Nth element of that specific tag type, not the Nth child.
   */
  static tier13ParentWithId(element, tag) {
    const results = [];
    const parent = element.parentElement;
    if (!parent) {return results;}
    const parentTag = getUniversalTag(parent);
    const parentId = parent.id;
    if (parentId && isStableId(parentId)) {
      const sameTagSiblings = Array.from(parent.children).filter(c => c.tagName === element.tagName);
      if (sameTagSiblings.length === 1) {
        results.push({ xpath: `//${parentTag}[@id=${escapeXPath(parentId)}]/${tag}`, strategy: 'parent-id', tier: 13 });
      } else {
        const idx = sameTagSiblings.indexOf(element) + 1;
        results.push({ xpath: `//${parentTag}[@id=${escapeXPath(parentId)}]/${tag}[${idx}]`, strategy: 'parent-id-indexed', tier: 13 });
      }
    }
    return results;
  }

  /** Tier 14 — class name containment; excludes CSS-in-JS generated class names. */
  static tier14ClassCombination(element, tag) {
    const results = [];
    const classAttr = element.getAttribute('class');
    if (!classAttr || !classAttr.trim()) {return results;}
    const unstablePatterns = [/^Mui[A-Z]/, /^makeStyles-/, /^css-[a-z0-9]+$/i, /^jss\d+$/, /^sc-/, /^emotion-/, /lwc-/i, /^_[a-z0-9]{5,}$/i];
    const stable = classAttr.trim().split(/\s+/).filter(c => c.length >= 2 && !unstablePatterns.some(p => p.test(c)));
    if (stable.length === 0) {return results;}
    results.push({ xpath: `//${tag}[contains(@class,${escapeXPath(stable[0])})]`, strategy: 'class-single', tier: 14 });
    if (stable.length >= 2) {
      results.push({ xpath: `//${tag}[contains(@class,${escapeXPath(stable[0])}) and contains(@class,${escapeXPath(stable[1])})]`, strategy: 'class-combo', tier: 14 });
    }
    return results;
  }

  /** Tier 15 — walks up to 5 ancestors looking for any stable attribute to scope the tag under. */
  static tier15AncestorAttributePath(element, tag) {
    const results = [];
    let current = element.parentElement;
    let depth = 0;
    while (current && depth < 5) {
      const currTag = getUniversalTag(current);
      const attrs = collectStableAttributes(current);
      if (attrs.length > 0) {
        const attr = attrs[0];
        results.push({ xpath: `//${currTag}[@${attr.name}=${escapeXPath(attr.value)}]//${tag}`, strategy: 'ancestor-attr-path', tier: 15 });
        break;
      }
      current = current.parentElement;
      depth++;
    }
    return results;
  }

  /** Tier 16 — `role` attribute; common on custom components but not always unique. */
  static tier16RoleAttribute(element, tag) {
    const results = [];
    const role = element.getAttribute('role');
    if (role) {
      results.push({ xpath: `//${tag}[@role=${escapeXPath(role)}]`, strategy: 'role', tier: 16 });
    }
    return results;
  }

  /** Tier 17 — `href` / `src` attribute; length-capped and `javascript:` URIs excluded. */
  static tier17HrefOrSrc(element, tag) {
    const results = [];
    const href = element.getAttribute('href');
    const src = element.getAttribute('src');
    if (href && href.length > 0 && href.length < 200 && !href.startsWith('javascript:')) {
      results.push({ xpath: `//${tag}[@href=${escapeXPath(href)}]`, strategy: 'href', tier: 17 });
    }
    if (src && src.length > 0 && src.length < 200) {
      results.push({ xpath: `//${tag}[@src=${escapeXPath(src)}]`, strategy: 'src', tier: 17 });
    }
    return results;
  }

  /** Tier 18 — `alt` / `title` attribute; useful for images and icon buttons. */
  static tier18AltOrTitle(element, tag) {
    const results = [];
    const alt = element.getAttribute('alt');
    const title = element.getAttribute('title');
    if (alt && alt.length > 0 && alt.length < 150) {
      results.push({ xpath: `//${tag}[@alt=${escapeXPath(alt)}]`, strategy: 'alt', tier: 18 });
    }
    if (title && title.length > 0 && title.length < 150) {
      results.push({ xpath: `//${tag}[@title=${escapeXPath(title)}]`, strategy: 'title', tier: 18 });
    }
    return results;
  }

  /**
   * Tier 19 — absolute positional path from document root; breaks on DOM reorders
   * but is always unique. Uses same-tag sibling count for position predicates, not
   * all-children count — XPath `tag[N]` is type-specific, not child-position-specific.
   */
  static tier19AbsolutePath(element) {
    const results = [];
    let current = element;
    const path = [];
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const parent = current.parentElement;
      if (!parent) {
        path.unshift(getUniversalTag(current));
        break;
      }
      const currTag = getUniversalTag(current);
      const sameTag = Array.from(parent.children).filter(c => c.tagName === current.tagName);
      if (sameTag.length === 1) {
        path.unshift(currTag);
      } else {
        const idx = sameTag.indexOf(current) + 1;
        path.unshift(`${currTag}[${idx}]`);
      }
      current = parent;
    }
    if (path.length > 0) {
      results.push({ xpath: `/${path.join('/')}`, strategy: 'absolute-path', tier: 19 });
    }
    return results;
  }

  /**
   * Tier 20 — tag position within direct parent only.
   * Uses `parent.children` (direct children) not `querySelectorAll` (deep descendants)
   * so the position index is accurate for direct-child XPath axes.
   */
  static tier20TagWithPosition(element, tag) {
    const results = [];
    const parent = element.parentElement;
    if (!parent) {return results;}
    const directSameTag = Array.from(parent.children).filter(c => c.tagName === element.tagName);
    const index = directSameTag.indexOf(element);
    if (index !== -1) {
      const parentTag = getUniversalTag(parent);
      results.push({ xpath: `//${parentTag}/${tag}[${index + 1}]`, strategy: 'tag-position', tier: 20 });
    }
    return results;
  }

  /** Tier 21 — tag position scoped under grandparent › parent context; more specific than tier 20. */
  static tier21TypePosition(element, tag) {
    const results = [];
    const parent = element.parentElement;
    if (!parent || !parent.parentElement) {return results;}
    const sameTag = Array.from(parent.children).filter(el => el.tagName === element.tagName);
    const index = sameTag.indexOf(element);
    if (index !== -1) {
      const parentTag = getUniversalTag(parent);
      const grandparentTag = getUniversalTag(parent.parentElement);
      results.push({ xpath: `//${grandparentTag}//${parentTag}/${tag}[${index + 1}]`, strategy: 'type-position', tier: 21 });
    }
    return results;
  }

  /**
   * Tier 22 — global document position index; O(n) over all DOM elements.
   * Last resort — always unique but breaks on any DOM insertion before this element.
   */
  static tier22FallbackIndex(element) {
    const results = [];
    const allElements = Array.from(document.querySelectorAll('*'));
    const index = allElements.indexOf(element);
    if (index !== -1) {
      results.push({ xpath: `(//*)[${index + 1}]`, strategy: 'fallback-index', tier: 22 });
    }
    return results;
  }
}

/**
 * Returns the full ordered strategy list for use by the generator.
 * @returns {Array<{tier: number, fn: Function, name: string}>}
 */
function getAllStrategies() {
  return [
    { tier: 0,  fn: (el, tag) => XPathStrategies.tier0ExactText(el, tag),             name: 'exact-text' },
    { tier: 1,  fn: (el, tag) => XPathStrategies.tier1TestAttributes(el, tag),         name: 'test-attr' },
    { tier: 2,  fn: (el, tag) => XPathStrategies.tier2StableId(el, tag),               name: 'stable-id' },
    { tier: 3,  fn: (el, tag) => XPathStrategies.tier3NormalizedText(el, tag),         name: 'normalized-text' },
    { tier: 4,  fn: (el, tag) => XPathStrategies.tier4StableAttributes(el, tag),       name: 'stable-attr' },
    { tier: 5,  fn: (el, tag) => XPathStrategies.tier5DataAttributes(el, tag),         name: 'data-attr' },
    { tier: 6,  fn: (el, tag) => XPathStrategies.tier6SemanticAncestor(el, tag),       name: 'semantic-ancestor' },
    { tier: 7,  fn: (el, tag) => XPathStrategies.tier7NearbyText(el, tag),             name: 'nearby-text' },
    { tier: 8,  fn: (el, tag) => XPathStrategies.tier8SiblingContext(el, tag),         name: 'sibling-context' },
    { tier: 9,  fn: (el, tag) => XPathStrategies.tier9AncestorChain(el, tag),          name: 'ancestor-chain' },
    { tier: 10, fn: (el, tag) => XPathStrategies.tier10TypeAndName(el, tag),           name: 'type-name' },
    { tier: 11, fn: (el, tag) => XPathStrategies.tier11AriaLabel(el, tag),             name: 'aria-label' },
    { tier: 12, fn: (el, tag) => XPathStrategies.tier12PartialText(el, tag),           name: 'partial-text' },
    { tier: 13, fn: (el, tag) => XPathStrategies.tier13ParentWithId(el, tag),          name: 'parent-id' },
    { tier: 14, fn: (el, tag) => XPathStrategies.tier14ClassCombination(el, tag),      name: 'class-combo' },
    { tier: 15, fn: (el, tag) => XPathStrategies.tier15AncestorAttributePath(el, tag), name: 'ancestor-attr' },
    { tier: 16, fn: (el, tag) => XPathStrategies.tier16RoleAttribute(el, tag),         name: 'role' },
    { tier: 17, fn: (el, tag) => XPathStrategies.tier17HrefOrSrc(el, tag),             name: 'href-src' },
    { tier: 18, fn: (el, tag) => XPathStrategies.tier18AltOrTitle(el, tag),            name: 'alt-title' },
    { tier: 19, fn: (el, tag) => XPathStrategies.tier19AbsolutePath(el, tag),          name: 'absolute-path' },
    { tier: 20, fn: (el, tag) => XPathStrategies.tier20TagWithPosition(el, tag),       name: 'tag-position' },
    { tier: 21, fn: (el, tag) => XPathStrategies.tier21TypePosition(el, tag),          name: 'type-position' },
    { tier: 22, fn: (el)      => XPathStrategies.tier22FallbackIndex(el),              name: 'fallback-index' }
  ];
}

export { XPathStrategies, getAllStrategies, TIER_ROBUSTNESS };