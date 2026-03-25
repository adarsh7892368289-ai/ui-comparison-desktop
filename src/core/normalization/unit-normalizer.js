/**
 * Converts CSS dimension values from any unit into a canonical `px` or `%` string.
 * Runs in the content-script context; pure synchronous math, no DOM access.
 * Invariant: always returns a string — unrecognised values are passed through unchanged.
 * Called by: normalizer-engine.js for every property in SIZE_PROPERTIES.
 */
import { get } from '../../config/defaults.js';

// Decimal places used when rounding converted pixel values.
const DECIMALS = get('normalization.rounding.decimals', 2);

/** Formats a number as a `px` string rounded to the configured decimal places. */
function px(value) {
  return `${value.toFixed(DECIMALS)}px`;
}

/** Formats a number as a `%` string — used when a percentage cannot be resolved to px. */
function pct(value) {
  return `${value.toFixed(DECIMALS)}%`;
}

// Units whose resolved pixel value depends on the element's surrounding context.
const CONTEXT_DEPENDENT_UNITS = ['em', 'rem', '%', 'vw', 'vh', 'vmin', 'vmax'];

/**
 * Returns true when `value` contains any context-dependent CSS unit.
 * Used by the engine to decide which cache tier to route the value to.
 *
 * @param {string|*} value - Raw CSS value string.
 * @returns {boolean}
 */
function isContextDependent(value) {
  if (!value || typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim().toLowerCase();
  return CONTEXT_DEPENDENT_UNITS.some(unit => trimmed.includes(unit));
}

/**
 * Parses a numeric CSS value into its magnitude and unit suffix.
 * Only handles simple values — compound values like `1px 2em` will not match.
 *
 * @param {string} trimmed - Lowercased, trimmed CSS value string.
 * @returns {{num: number, unit: string}|null} Null when the value is not a simple dimension.
 */
function parseNumAndUnit(trimmed) {
  const match = trimmed.match(/^([-+]?\d*\.?\d+)([a-z%]+)?$/);
  if (!match) {
    return null;
  }
  return { num: parseFloat(match[1]), unit: match[2] || '' };
}

// CSS keywords that should be returned as-is without unit conversion.
const CSS_KEYWORDS = new Set(['auto', 'none', 'initial', 'inherit', 'unset', 'normal']);

// Maps CSS property name patterns to the context snapshot key used for % resolution.
// Order matters: first matching resolver wins.
const DIMENSION_RESOLVERS = [
  {
    matches: (p) => p.includes('width') || p.includes('left') || p.includes('right') || p.includes('column'),
    snapshotKey: 'parentWidth',
    fallback: '0px'
  },
  {
    matches: (p) => p.includes('height') || p.includes('top') || p.includes('bottom') || p.includes('row'),
    snapshotKey: 'parentHeight',
    fallback: '0px'
  },
  {
    matches: (p) => p.includes('font') || p === 'line-height',
    snapshotKey: 'parentFontSize',
    fallback: '16px'
  }
];

/**
 * Looks up the parent reference dimension for percentage resolution based on property name.
 * Returns null when no matching resolver exists or when contextSnapshot is absent.
 *
 * @param {string} property - CSS property name.
 * @param {object|null} contextSnapshot - Snapshot containing parentWidth, parentHeight, etc.
 * @returns {number|null}
 */
function getParentDimension(property, contextSnapshot) {
  if (!contextSnapshot) {
    return null;
  }
  const resolver = DIMENSION_RESOLVERS.find(r => r.matches(property));
  return resolver ? parseFloat(contextSnapshot[resolver.snapshotKey] ?? resolver.fallback) : null;
}

/**
 * Resolves a percentage value to px using the parent reference dimension.
 * Falls back to `%` format when the reference dimension is unavailable.
 *
 * @param {number} value - Numeric percentage (e.g. 50 for `50%`).
 * @param {string} property
 * @param {object|null} contextSnapshot
 * @returns {string}
 */
function percentToPx(value, property, contextSnapshot) {
  const ref = getParentDimension(property, contextSnapshot);
  if (ref === null || isNaN(ref)) {
    return pct(value);
  }
  return px((value / 100) * ref);
}

/**
 * Extracts viewport width and height from the context snapshot.
 * Falls back to common desktop defaults (1024×768) when snapshot is absent.
 *
 * @param {object|null} contextSnapshot
 * @returns {{w: number, h: number}}
 */
function resolveViewport(contextSnapshot) {
  return {
    w: contextSnapshot?.viewportWidth ?? 1024,
    h: contextSnapshot?.viewportHeight ?? 768
  };
}

// Converter map: each entry takes (num, property, contextSnapshot) and returns a px/% string.
const UNIT_CONVERTERS = new Map([
  ['px',   (num) => px(num)],
  ['em',   (num, _p, ctx) => {
    const base = parseFloat(ctx?.parentFontSize ?? '16px');
    return px(num * (isNaN(base) ? 16 : base));
  }],
  ['rem',  (num, _p, ctx) => {
    const base = parseFloat(ctx?.rootFontSize ?? '16px');
    return px(num * (isNaN(base) ? 16 : base));
  }],
  ['%',    (num, prop, ctx) => percentToPx(num, prop, ctx)],
  ['vw',   (num, _p, ctx) => px(num * (resolveViewport(ctx).w / 100))],
  ['vh',   (num, _p, ctx) => px(num * (resolveViewport(ctx).h / 100))],
  ['vmin', (num, _p, ctx) => {
    const { w, h } = resolveViewport(ctx);
    return px(num * (Math.min(w, h) / 100));
  }],
  ['vmax', (num, _p, ctx) => {
    const { w, h } = resolveViewport(ctx);
    return px(num * (Math.max(w, h) / 100));
  }],
  ['pt',   (num) => px(num * 1.333333)],
  ['pc',   (num) => px(num * 16)],
  ['in',   (num) => px(num * 96)],
  ['cm',   (num) => px(num * 37.7952755906)],
  ['mm',   (num) => px(num * 3.77952755906)],
  ['q',    (num) => px(num * 0.94488188976)]
]);

/**
 * Dispatches to the appropriate unit converter, or returns null for unknown units.
 *
 * @param {number} num - Parsed numeric magnitude.
 * @param {string} unit - Lowercase unit suffix (e.g. `'em'`, `'px'`).
 * @param {string} property
 * @param {object|null} contextSnapshot
 * @returns {string|null} Null when no converter is registered for `unit`.
 */
function convertUnit(num, unit, property, contextSnapshot) {
  const converter = UNIT_CONVERTERS.get(unit);
  return converter ? converter(num, property, contextSnapshot) : null;
}

/**
 * Returns the canonical form of CSS keywords and the unitless-zero special case.
 *
 * @param {string} trimmed - Lowercased, trimmed CSS value string.
 * @returns {string|null} Null when the value is not a static keyword.
 */
function resolveStaticValue(trimmed) {
  if (CSS_KEYWORDS.has(trimmed)) {
    return trimmed;
  }
  if (trimmed === '0' || trimmed === '0px') {
    return '0px';
  }
  return null;
}

/**
 * Public entry point: normalises a single CSS dimension value to `px` or `%`.
 * Handles keywords first, then numeric parsing, then unit conversion.
 * Returns the original value unchanged for compound values, calc(), or unknown units.
 *
 * @param {string|*} value - Raw CSS dimension value.
 * @param {string} property - CSS property name; required for % and em resolution.
 * @param {object|null} contextSnapshot - Element/viewport context for relative units.
 * @returns {string} Normalised value; never throws.
 */
function normalizeUnit(value, property, contextSnapshot) {
  if (!value || typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim().toLowerCase();
  const staticResult = resolveStaticValue(trimmed);
  if (staticResult !== null) {
    return staticResult;
  }

  const parsed = parseNumAndUnit(trimmed);
  if (!parsed) {
    return value;
  }

  if (!parsed.unit) {
    return px(parsed.num);
  }

  return convertUnit(parsed.num, parsed.unit, property, contextSnapshot) ?? value;
}

export { normalizeUnit, isContextDependent };