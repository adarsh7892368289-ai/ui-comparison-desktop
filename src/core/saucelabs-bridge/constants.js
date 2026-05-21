'use strict';

// Shared constants for the SauceLabs feature. Replaces magic-string spread
// across main + renderer + bridge modules. Keep this module dependency-free
// so it can be imported from any context (main, renderer, runner spec, tests).

const SIDE = Object.freeze({
  BASELINE: 'baseline',
  COMPARE: 'compare'
});

const SIDES = Object.freeze([SIDE.BASELINE, SIDE.COMPARE]);

function isSide(v) {
  return v === SIDE.BASELINE || v === SIDE.COMPARE;
}

function oppositeSide(side) {
  if (side === SIDE.BASELINE) return SIDE.COMPARE;
  if (side === SIDE.COMPARE) return SIDE.BASELINE;
  throw new Error(`Unknown side: ${String(side)}`);
}

// Comparison modes are owned by the comparator; SauceLabs currently only
// runs dynamic mode. Centralized here so a future static-mode option doesn't
// require sprinkling another magic string across the bridge.
const COMPARISON_MODE = Object.freeze({
  DYNAMIC: 'dynamic',
  STATIC: 'static'
});

const DEFAULT_SAUCE_COMPARISON_MODE = COMPARISON_MODE.DYNAMIC;

export {
  SIDE,
  SIDES,
  COMPARISON_MODE,
  DEFAULT_SAUCE_COMPARISON_MODE,
  isSide,
  oppositeSide
};
