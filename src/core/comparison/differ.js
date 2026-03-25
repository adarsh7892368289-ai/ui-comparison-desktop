/**
 * Normalises and diffs the computed CSS properties of two matched elements.
 * Runs in the MV3 service worker context.
 * Invariant: never throws — all parse failures fall back to strict string equality.
 * Called by: comparison-modes.js → BaseComparisonMode.compareChunked().
 */
import { get } from '../../config/defaults.js';
import { normalizerEngine } from '../normalization/normalizer-engine.js';
import { parseRgba, parsePx } from './color-utils.js';

const DIFF_TYPES = {
  UNCHANGED: 'unchanged',
  MODIFIED:  'modified',
  ADDED:     'added',
  REMOVED:   'removed'
};

const PROPERTY_CATEGORIES = {
  LAYOUT:     'layout',
  VISUAL:     'visual',
  TYPOGRAPHY: 'typography',
  SPACING:    'spacing',
  POSITION:   'position',
  OTHER:      'other'
};

const DIMENSIONAL_KEYWORDS = ['width', 'height', 'size'];

/** Border-side color properties that inherit from `color` via `currentColor`. */
const CURRENT_COLOR_PROPS = new Set([
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'
]);

/**
 * Returns true when both RGBA values parse successfully and all channels are within tolerance.
 * Falls back to strict string equality when either value is not a parseable color string —
 * avoids false negatives on keyword colors like `transparent` or `inherit`.
 */
function colorWithinTolerance(baseValue, compareValue, tolerance) {
  const baseRgba    = parseRgba(baseValue);
  const compareRgba = parseRgba(compareValue);
  if (!baseRgba || !compareRgba) { return baseValue === compareValue; }
  return (
    Math.abs(baseRgba.r - compareRgba.r) <= tolerance &&
    Math.abs(baseRgba.g - compareRgba.g) <= tolerance &&
    Math.abs(baseRgba.b - compareRgba.b) <= tolerance &&
    Math.abs(baseRgba.a - compareRgba.a) <= 0.01
  );
}

/**
 * Returns true when both values parse to a pixel number and are within tolerance.
 * Falls back to strict string equality when either value is not a `px` string — e.g. `auto`.
 */
function sizeWithinTolerance(baseValue, compareValue, tolerance) {
  const basePx    = parsePx(baseValue);
  const comparePx = parsePx(compareValue);
  if (basePx === null || comparePx === null) { return baseValue === compareValue; }
  return Math.abs(basePx - comparePx) <= tolerance;
}

/** Returns true when both values are valid floats and their difference is within tolerance. */
function opacityWithinTolerance(baseValue, compareValue, tolerance) {
  const base    = parseFloat(baseValue);
  const compare = parseFloat(compareValue);
  return !isNaN(base) && !isNaN(compare) && Math.abs(base - compare) <= tolerance;
}

/** Returns true when the property belongs to the visual category or contains the word "color". */
function isColorProperty(prop, cats) {
  return cats.visual.has(prop) || prop.includes('color');
}

/** Returns true when the property belongs to layout, spacing, or position, or contains a dimensional keyword. */
function isSizeProperty(prop, cats) {
  return (
    cats.layout.has(prop)   ||
    cats.spacing.has(prop)  ||
    cats.position.has(prop) ||
    DIMENSIONAL_KEYWORDS.some(k => prop.includes(k))
  );
}

/**
 * Priority-ordered list of tolerance strategies.
 * The first strategy whose `matches` predicate returns true is used; others are skipped.
 */
const TOLERANCE_STRATEGIES = [
  {
    matches: isColorProperty,
    check:   (base, compare, tolerances) => colorWithinTolerance(base, compare, tolerances.color ?? 5)
  },
  {
    matches: isSizeProperty,
    check:   (base, compare, tolerances) => sizeWithinTolerance(base, compare, tolerances.size ?? 3)
  },
  {
    matches: (prop) => prop === 'opacity',
    check:   (base, compare, tolerances) => opacityWithinTolerance(base, compare, tolerances.opacity ?? 0.01)
  }
];

/**
 * Computes the property-level diff between two matched elements.
 * Does not own element matching, severity assignment, or inherited-cascade suppression —
 * those are handled by comparison-modes.js and severity-analyzer.js respectively.
 * Invariant: callers must not mutate the returned `differences` array.
 */
class PropertyDiffer {
  #normalizer;
  #categories;
  #categoryRegistry;

  /** Reads property-category sets from config once at construction time. */
  constructor() {
    this.#normalizer = normalizerEngine;
    this.#categories = {
      layout:     new Set(get('comparison.propertyCategories.layout')),
      visual:     new Set(get('comparison.propertyCategories.visual')),
      typography: new Set(get('comparison.propertyCategories.typography')),
      spacing:    new Set(get('comparison.propertyCategories.spacing')),
      position:   new Set(get('comparison.propertyCategories.position'))
    };
    this.#categoryRegistry = [
      [this.#categories.layout,     PROPERTY_CATEGORIES.LAYOUT],
      [this.#categories.visual,     PROPERTY_CATEGORIES.VISUAL],
      [this.#categories.typography, PROPERTY_CATEGORIES.TYPOGRAPHY],
      [this.#categories.spacing,    PROPERTY_CATEGORIES.SPACING],
      [this.#categories.position,   PROPERTY_CATEGORIES.POSITION]
    ];
  }

  /**
   * Normalises both elements' styles then returns all property-level differences.
   * Pass `compareProperties` to restrict diffing to a specific property list (dynamic mode).
   * @param {object} baselineElement - Extracted element with `.styles` and optional `.contextSnapshot`.
   * @param {object} compareElement  - Matching extracted element from the compare capture.
   * @param {object} [options]
   * @param {string[]|Set<string>|null} [options.compareProperties] - Property allowlist; null means diff all.
   * @param {object} [options.tolerances] - Override for color/size/opacity tolerances.
   * @returns {{ elementId: string, tagName: string, totalDifferences: number, differences: object[] }}
   */
  compareElements(baselineElement, compareElement, options = {}) {
    const compareProperties = options.compareProperties ?? null;
    const tolerances        = options.tolerances ?? get('comparison.modes.static.tolerances');

    const baseNorm    = this.#normalizer.normalize(
      baselineElement.styles || {},
      baselineElement.contextSnapshot ?? null
    );
    const compareNorm = this.#normalizer.normalize(
      compareElement.styles || {},
      compareElement.contextSnapshot ?? null
    );

    const allProperties = compareProperties !== null
      ? compareProperties
      : new Set([...Object.keys(baseNorm), ...Object.keys(compareNorm)]);
    const rawDifferences = [];

    for (const property of allProperties) {
      const baseValue    = baseNorm[property];
      const compareValue = compareNorm[property];
      const diffType     = this.#getDiffType(baseValue, compareValue);

      if (diffType === DIFF_TYPES.UNCHANGED) { continue; }
      if (this.#withinTolerance(property, baseValue, compareValue, tolerances)) { continue; }

      rawDifferences.push({
        property,
        baseValue,
        compareValue,
        type:     diffType,
        category: this.#categorizeProperty(property)
      });
    }

    const differences = this.#dedupeCurrentColor(rawDifferences);

    return {
      elementId:        baselineElement.id,
      tagName:          baselineElement.tagName,
      totalDifferences: differences.length,
      differences
    };
  }

  /**
   * Removes border-side color diffs that are identical to an existing `color` diff.
   * These properties inherit via `currentColor`; reporting them separately doubles noise
   * without adding information — the root cause is the `color` change on the parent.
   */
  #dedupeCurrentColor(differences) {
    const colorDiff = differences.find(d => d.property === 'color');
    if (!colorDiff) { return differences; }

    return differences.filter(d => {
      if (!CURRENT_COLOR_PROPS.has(d.property)) { return true; }
      return !(d.baseValue === colorDiff.baseValue && d.compareValue === colorDiff.compareValue);
    });
  }

  /** Maps a (baseValue, compareValue) pair to one of the four DIFF_TYPES constants. */
  #getDiffType(baseValue, compareValue) {
    if (baseValue === undefined && compareValue !== undefined) { return DIFF_TYPES.ADDED; }
    if (baseValue !== undefined && compareValue === undefined) { return DIFF_TYPES.REMOVED; }
    if (baseValue === compareValue)                            { return DIFF_TYPES.UNCHANGED; }
    return DIFF_TYPES.MODIFIED;
  }

  /**
   * Returns true when the value delta is small enough to suppress the diff.
   * Always returns false for ADDED/REMOVED pairs (one value undefined) — tolerance
   * only applies when both sides have a value to compare numerically.
   */
  #withinTolerance(property, baseValue, compareValue, tolerances) {
    if (baseValue === undefined || compareValue === undefined) { return false; }
    const strategy = TOLERANCE_STRATEGIES.find(s => s.matches(property, this.#categories));
    return strategy ? strategy.check(baseValue, compareValue, tolerances) : false;
  }

  /** Returns the PROPERTY_CATEGORIES bucket for a CSS property name, defaulting to OTHER. */
  #categorizeProperty(property) {
    const entry = this.#categoryRegistry.find(([set]) => set.has(property));
    return entry ? entry[1] : PROPERTY_CATEGORIES.OTHER;
  }
}

export { PropertyDiffer, DIFF_TYPES, PROPERTY_CATEGORIES };