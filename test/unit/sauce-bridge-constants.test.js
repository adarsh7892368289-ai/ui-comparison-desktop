import { describe, it, expect } from 'vitest';
import {
  SIDE,
  SIDES,
  COMPARISON_MODE,
  DEFAULT_SAUCE_COMPARISON_MODE,
  isSide,
  oppositeSide
} from '@core/saucelabs-bridge/constants.js';

describe('SIDE / SIDES', () => {
  it('exposes baseline and compare', () => {
    expect(SIDE.BASELINE).toBe('baseline');
    expect(SIDE.COMPARE).toBe('compare');
  });

  it('SIDES contains both, in baseline-then-compare order', () => {
    expect(SIDES).toEqual(['baseline', 'compare']);
  });

  it('SIDE and SIDES are frozen', () => {
    expect(Object.isFrozen(SIDE)).toBe(true);
    expect(Object.isFrozen(SIDES)).toBe(true);
  });
});

describe('isSide', () => {
  it('returns true for valid sides', () => {
    expect(isSide('baseline')).toBe(true);
    expect(isSide('compare')).toBe(true);
    expect(isSide(SIDE.BASELINE)).toBe(true);
  });

  it('returns false for everything else', () => {
    expect(isSide('Baseline')).toBe(false); // case-sensitive
    expect(isSide('')).toBe(false);
    expect(isSide(null)).toBe(false);
    expect(isSide(undefined)).toBe(false);
    expect(isSide(0)).toBe(false);
    expect(isSide({ side: 'baseline' })).toBe(false);
  });
});

describe('oppositeSide', () => {
  it('flips baseline ↔ compare', () => {
    expect(oppositeSide(SIDE.BASELINE)).toBe(SIDE.COMPARE);
    expect(oppositeSide(SIDE.COMPARE)).toBe(SIDE.BASELINE);
  });

  it('throws on unknown input (programmer error)', () => {
    expect(() => oppositeSide('left')).toThrow(/Unknown side/);
    expect(() => oppositeSide(null)).toThrow(/Unknown side/);
    expect(() => oppositeSide(undefined)).toThrow(/Unknown side/);
  });

  it('is its own inverse', () => {
    expect(oppositeSide(oppositeSide(SIDE.BASELINE))).toBe(SIDE.BASELINE);
    expect(oppositeSide(oppositeSide(SIDE.COMPARE))).toBe(SIDE.COMPARE);
  });
});

describe('COMPARISON_MODE / DEFAULT_SAUCE_COMPARISON_MODE', () => {
  it('exposes dynamic and static', () => {
    expect(COMPARISON_MODE.DYNAMIC).toBe('dynamic');
    expect(COMPARISON_MODE.STATIC).toBe('static');
  });

  it('default is dynamic', () => {
    expect(DEFAULT_SAUCE_COMPARISON_MODE).toBe('dynamic');
  });

  it('COMPARISON_MODE is frozen', () => {
    expect(Object.isFrozen(COMPARISON_MODE)).toBe(true);
  });
});
