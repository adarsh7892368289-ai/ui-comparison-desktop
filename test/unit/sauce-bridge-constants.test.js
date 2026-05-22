import { describe, it, expect } from 'vitest';
import {
  SIDE,
  SIDES,
  COMPARISON_MODE,
  DEFAULT_SAUCE_COMPARISON_MODE,
  FORM_FACTOR,
  FORM_FACTORS,
  MOBILE_DEVICES,
  MOBILE_DEVICE_NAMES,
  SAUCE_DEFAULT_VIEWPORT,
  SAUCE_SUPPORTED_VIEWPORTS,
  SAUCE_RESOLUTIONS_BY_ENGINE,
  SAUCE_DEFAULT_RESOLUTION_BY_ENGINE,
  resolutionsForEngine,
  SAUCE_PLATFORMS_BY_ENGINE,
  SAUCE_DEFAULT_PLATFORM_BY_ENGINE,
  platformsForEngine,
  isSide,
  oppositeSide,
  isFormFactor,
  isKnownMobileDevice,
  findMobileDevice
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
    expect(isSide('Baseline')).toBe(false);
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

describe('FORM_FACTOR', () => {
  it('exposes desktop and mobile', () => {
    expect(FORM_FACTOR.DESKTOP).toBe('desktop');
    expect(FORM_FACTOR.MOBILE).toBe('mobile');
  });

  it('FORM_FACTORS lists both', () => {
    expect(FORM_FACTORS).toEqual(['desktop', 'mobile']);
  });

  it('isFormFactor accepts only valid values', () => {
    expect(isFormFactor('desktop')).toBe(true);
    expect(isFormFactor('mobile')).toBe(true);
    expect(isFormFactor('Desktop')).toBe(false);
    expect(isFormFactor(null)).toBe(false);
    expect(isFormFactor('')).toBe(false);
  });

  it('FORM_FACTOR and FORM_FACTORS are frozen', () => {
    expect(Object.isFrozen(FORM_FACTOR)).toBe(true);
    expect(Object.isFrozen(FORM_FACTORS)).toBe(true);
  });
});

describe('MOBILE_DEVICES catalog', () => {
  it('exposes a non-empty list with the required shape', () => {
    expect(MOBILE_DEVICES.length).toBeGreaterThan(0);
    for (const d of MOBILE_DEVICES) {
      expect(d).toHaveProperty('name');
      expect(d).toHaveProperty('label');
      expect(d).toHaveProperty('os');
      expect(d).toHaveProperty('browserEngine');
      expect(d).toHaveProperty('viewportLabel');
      expect(typeof d.name).toBe('string');
      expect(d.name.length).toBeGreaterThan(0);
      expect(d.viewportLabel).toMatch(/^\d+x\d+$/);
    }
  });

  it('every viewportLabel is in SAUCE_SUPPORTED_VIEWPORTS', () => {
    for (const d of MOBILE_DEVICES) {
      expect(SAUCE_SUPPORTED_VIEWPORTS).toContain(d.viewportLabel);
    }
  });

  it('iOS/iPadOS devices use webkit; Android uses chromium', () => {
    for (const d of MOBILE_DEVICES) {
      if (d.os === 'iOS' || d.os === 'iPadOS') {
        expect(d.browserEngine).toBe('webkit');
      } else if (d.os === 'Android') {
        expect(d.browserEngine).toBe('chromium');
      }
    }
  });

  it('SAUCE_DEFAULT_VIEWPORT is itself a supported viewport', () => {
    expect(SAUCE_SUPPORTED_VIEWPORTS).toContain(SAUCE_DEFAULT_VIEWPORT);
  });

  it('SAUCE_SUPPORTED_VIEWPORTS is frozen', () => {
    expect(Object.isFrozen(SAUCE_SUPPORTED_VIEWPORTS)).toBe(true);
  });

  it('MOBILE_DEVICES and MOBILE_DEVICE_NAMES are frozen', () => {
    expect(Object.isFrozen(MOBILE_DEVICES)).toBe(true);
    expect(Object.isFrozen(MOBILE_DEVICE_NAMES)).toBe(true);
  });

  it('MOBILE_DEVICE_NAMES mirrors MOBILE_DEVICES.name', () => {
    expect(MOBILE_DEVICE_NAMES).toEqual(MOBILE_DEVICES.map((d) => d.name));
  });

  it('isKnownMobileDevice recognizes catalog entries', () => {
    for (const name of MOBILE_DEVICE_NAMES) {
      expect(isKnownMobileDevice(name)).toBe(true);
    }
    expect(isKnownMobileDevice('Nokia 3310')).toBe(false);
    expect(isKnownMobileDevice('')).toBe(false);
    expect(isKnownMobileDevice(null)).toBe(false);
  });

  it('findMobileDevice returns the metadata object or null', () => {
    const first = MOBILE_DEVICES[0];
    expect(findMobileDevice(first.name)).toBe(first);
    expect(findMobileDevice('not-real')).toBeNull();
  });

  it('catalog includes both iOS and Android entries', () => {
    const oses = new Set(MOBILE_DEVICES.map((d) => d.os));
    expect(oses.has('iOS')).toBe(true);
    expect(oses.has('Android')).toBe(true);
  });
});

describe('SAUCE_PLATFORMS_BY_ENGINE / platformsForEngine', () => {
  it('webkit is restricted to macOS (Sauce does not ship WebKit on Windows)', () => {
    const platforms = SAUCE_PLATFORMS_BY_ENGINE.webkit;
    expect(platforms.length).toBeGreaterThan(0);
    for (const p of platforms) {
      expect(p.startsWith('macOS')).toBe(true);
    }
  });

  it('chromium and firefox accept both Windows and macOS', () => {
    for (const engine of ['chromium', 'firefox']) {
      const platforms = SAUCE_PLATFORMS_BY_ENGINE[engine];
      expect(platforms.some((p) => p.startsWith('Windows'))).toBe(true);
      expect(platforms.some((p) => p.startsWith('macOS'))).toBe(true);
    }
  });

  it('SAUCE_PLATFORMS_BY_ENGINE and its lists are frozen', () => {
    expect(Object.isFrozen(SAUCE_PLATFORMS_BY_ENGINE)).toBe(true);
    for (const list of Object.values(SAUCE_PLATFORMS_BY_ENGINE)) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });

  it('SAUCE_DEFAULT_PLATFORM_BY_ENGINE has a value within the engine\'s allowed list', () => {
    for (const engine of Object.keys(SAUCE_PLATFORMS_BY_ENGINE)) {
      const def = SAUCE_DEFAULT_PLATFORM_BY_ENGINE[engine];
      expect(typeof def).toBe('string');
      expect(SAUCE_PLATFORMS_BY_ENGINE[engine]).toContain(def);
    }
  });

  it('platformsForEngine returns the matching list', () => {
    expect(platformsForEngine('chromium')).toBe(SAUCE_PLATFORMS_BY_ENGINE.chromium);
    expect(platformsForEngine('firefox')).toBe(SAUCE_PLATFORMS_BY_ENGINE.firefox);
    expect(platformsForEngine('webkit')).toBe(SAUCE_PLATFORMS_BY_ENGINE.webkit);
  });

  it('platformsForEngine falls back to chromium for unknown engines', () => {
    expect(platformsForEngine('chrome')).toBe(SAUCE_PLATFORMS_BY_ENGINE.chromium);
    expect(platformsForEngine(null)).toBe(SAUCE_PLATFORMS_BY_ENGINE.chromium);
    expect(platformsForEngine(undefined)).toBe(SAUCE_PLATFORMS_BY_ENGINE.chromium);
  });

  it('every mobile-device browserEngine has at least one allowed platform', () => {
    for (const d of MOBILE_DEVICES) {
      const platforms = platformsForEngine(d.browserEngine);
      expect(platforms.length).toBeGreaterThan(0);
    }
  });
});

describe('SAUCE_RESOLUTIONS_BY_ENGINE / resolutionsForEngine', () => {
  it('exposes a non-empty list for every engine in the platform matrix', () => {
    for (const engine of Object.keys(SAUCE_PLATFORMS_BY_ENGINE)) {
      const list = SAUCE_RESOLUTIONS_BY_ENGINE[engine];
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThan(0);
    }
  });

  it('webkit allowed list does NOT contain 1920x1080 (Sauce rejects it)', () => {
    expect(SAUCE_RESOLUTIONS_BY_ENGINE.webkit).not.toContain('1920x1080');
  });

  it('chromium and firefox allowed lists DO contain 1920x1080', () => {
    expect(SAUCE_RESOLUTIONS_BY_ENGINE.chromium).toContain('1920x1080');
    expect(SAUCE_RESOLUTIONS_BY_ENGINE.firefox).toContain('1920x1080');
  });

  it('SAUCE_RESOLUTIONS_BY_ENGINE and its lists are frozen', () => {
    expect(Object.isFrozen(SAUCE_RESOLUTIONS_BY_ENGINE)).toBe(true);
    for (const list of Object.values(SAUCE_RESOLUTIONS_BY_ENGINE)) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });

  it('SAUCE_DEFAULT_RESOLUTION_BY_ENGINE values fall within the engine allowed list', () => {
    for (const engine of Object.keys(SAUCE_RESOLUTIONS_BY_ENGINE)) {
      const def = SAUCE_DEFAULT_RESOLUTION_BY_ENGINE[engine];
      expect(typeof def).toBe('string');
      expect(SAUCE_RESOLUTIONS_BY_ENGINE[engine]).toContain(def);
    }
  });

  it('resolutionsForEngine returns the matching list', () => {
    expect(resolutionsForEngine('chromium')).toBe(SAUCE_RESOLUTIONS_BY_ENGINE.chromium);
    expect(resolutionsForEngine('firefox')).toBe(SAUCE_RESOLUTIONS_BY_ENGINE.firefox);
    expect(resolutionsForEngine('webkit')).toBe(SAUCE_RESOLUTIONS_BY_ENGINE.webkit);
  });

  it('resolutionsForEngine falls back to chromium for unknown engines', () => {
    expect(resolutionsForEngine('chrome')).toBe(SAUCE_RESOLUTIONS_BY_ENGINE.chromium);
    expect(resolutionsForEngine(null)).toBe(SAUCE_RESOLUTIONS_BY_ENGINE.chromium);
    expect(resolutionsForEngine(undefined)).toBe(SAUCE_RESOLUTIONS_BY_ENGINE.chromium);
  });

  it('every mobile-device viewportLabel is in its engine\'s allowed resolution list', () => {
    for (const d of MOBILE_DEVICES) {
      const allowed = resolutionsForEngine(d.browserEngine);
      expect(allowed).toContain(d.viewportLabel);
    }
  });

  it('SAUCE_DEFAULT_VIEWPORT remains in the chromium list (legacy export)', () => {
    expect(SAUCE_RESOLUTIONS_BY_ENGINE.chromium).toContain(SAUCE_DEFAULT_VIEWPORT);
  });
});
