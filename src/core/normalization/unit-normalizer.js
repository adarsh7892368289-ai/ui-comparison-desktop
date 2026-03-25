import { get } from '../../config/defaults.js';

const DECIMALS = get('normalization.rounding.decimals', 2);

function px(value) {
  return `${value.toFixed(DECIMALS)}px`;
}

function pct(value) {
  return `${value.toFixed(DECIMALS)}%`;
}

const CONTEXT_DEPENDENT_UNITS = ['em', 'rem', '%', 'vw', 'vh', 'vmin', 'vmax'];

function isContextDependent(value) {
  if (!value || typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim().toLowerCase();
  return CONTEXT_DEPENDENT_UNITS.some(unit => trimmed.includes(unit));
}

function parseNumAndUnit(trimmed) {
  const match = trimmed.match(/^([-+]?\d*\.?\d+)([a-z%]+)?$/);
  if (!match) {
    return null;
  }
  return { num: parseFloat(match[1]), unit: match[2] || '' };
}

const CSS_KEYWORDS = new Set(['auto', 'none', 'initial', 'inherit', 'unset', 'normal']);

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

function getParentDimension(property, contextSnapshot) {
  if (!contextSnapshot) {
    return null;
  }
  const resolver = DIMENSION_RESOLVERS.find(r => r.matches(property));
  return resolver ? parseFloat(contextSnapshot[resolver.snapshotKey] ?? resolver.fallback) : null;
}

function percentToPx(value, property, contextSnapshot) {
  const ref = getParentDimension(property, contextSnapshot);
  if (ref === null || isNaN(ref)) {
    return pct(value);
  }
  return px((value / 100) * ref);
}

function resolveViewport(contextSnapshot) {
  return {
    w: contextSnapshot?.viewportWidth ?? 1024,
    h: contextSnapshot?.viewportHeight ?? 768
  };
}

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

function convertUnit(num, unit, property, contextSnapshot) {
  const converter = UNIT_CONVERTERS.get(unit);
  return converter ? converter(num, property, contextSnapshot) : null;
}

function resolveStaticValue(trimmed) {
  if (CSS_KEYWORDS.has(trimmed)) {
    return trimmed;
  }
  if (trimmed === '0' || trimmed === '0px') {
    return '0px';
  }
  return null;
}

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