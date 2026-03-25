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

const CURRENT_COLOR_PROPS = new Set([
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'
]);

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

function sizeWithinTolerance(baseValue, compareValue, tolerance) {
  const basePx    = parsePx(baseValue);
  const comparePx = parsePx(compareValue);
  if (basePx === null || comparePx === null) { return baseValue === compareValue; }
  return Math.abs(basePx - comparePx) <= tolerance;
}

function opacityWithinTolerance(baseValue, compareValue, tolerance) {
  const base    = parseFloat(baseValue);
  const compare = parseFloat(compareValue);
  return !isNaN(base) && !isNaN(compare) && Math.abs(base - compare) <= tolerance;
}

function isColorProperty(prop, cats) {
  return cats.visual.has(prop) || prop.includes('color');
}

function isSizeProperty(prop, cats) {
  return (
    cats.layout.has(prop)   ||
    cats.spacing.has(prop)  ||
    cats.position.has(prop) ||
    DIMENSIONAL_KEYWORDS.some(k => prop.includes(k))
  );
}

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

class PropertyDiffer {
  #normalizer;
  #categories;
  #categoryRegistry;

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

  #dedupeCurrentColor(differences) {
    const colorDiff = differences.find(d => d.property === 'color');
    if (!colorDiff) { return differences; }

    return differences.filter(d => {
      if (!CURRENT_COLOR_PROPS.has(d.property)) { return true; }
      return !(d.baseValue === colorDiff.baseValue && d.compareValue === colorDiff.compareValue);
    });
  }

  #getDiffType(baseValue, compareValue) {
    if (baseValue === undefined && compareValue !== undefined) { return DIFF_TYPES.ADDED; }
    if (baseValue !== undefined && compareValue === undefined) { return DIFF_TYPES.REMOVED; }
    if (baseValue === compareValue)                            { return DIFF_TYPES.UNCHANGED; }
    return DIFF_TYPES.MODIFIED;
  }

  #withinTolerance(property, baseValue, compareValue, tolerances) {
    if (baseValue === undefined || compareValue === undefined) { return false; }
    const strategy = TOLERANCE_STRATEGIES.find(s => s.matches(property, this.#categories));
    return strategy ? strategy.check(baseValue, compareValue, tolerances) : false;
  }

  #categorizeProperty(property) {
    const entry = this.#categoryRegistry.find(([set]) => set.has(property));
    return entry ? entry[1] : PROPERTY_CATEGORIES.OTHER;
  }
}

export { PropertyDiffer, DIFF_TYPES, PROPERTY_CATEGORIES };
