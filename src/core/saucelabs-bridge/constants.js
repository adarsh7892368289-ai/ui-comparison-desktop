'use strict';

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

const COMPARISON_MODE = Object.freeze({
  DYNAMIC: 'dynamic',
  STATIC: 'static'
});

const DEFAULT_SAUCE_COMPARISON_MODE = COMPARISON_MODE.DYNAMIC;

const FORM_FACTOR = Object.freeze({
  DESKTOP: 'desktop',
  MOBILE: 'mobile'
});

const FORM_FACTORS = Object.freeze([FORM_FACTOR.DESKTOP, FORM_FACTOR.MOBILE]);

function isFormFactor(v) {
  return v === FORM_FACTOR.DESKTOP || v === FORM_FACTOR.MOBILE;
}

const SAUCE_RESOLUTIONS_BY_ENGINE = Object.freeze({
  chromium: Object.freeze([
    '1024x768', '1280x800', '1280x1024', '1440x900',
    '1600x1200', '1680x1050', '1920x1080', '1920x1200', '2560x1600'
  ]),
  firefox: Object.freeze([
    '1024x768', '1280x800', '1280x1024', '1440x900',
    '1600x1200', '1680x1050', '1920x1080', '1920x1200', '2560x1600'
  ]),
  webkit: Object.freeze([
    '1024x768', '1152x864', '1280x960', '1376x1032',
    '1440x900', '1600x1200', '1920x1440', '2048x1536'
  ])
});

const SAUCE_DEFAULT_RESOLUTION_BY_ENGINE = Object.freeze({
  chromium: '1920x1080',
  firefox:  '1920x1080',
  webkit:   '1440x900'
});

const SAUCE_DEFAULT_VIEWPORT = SAUCE_DEFAULT_RESOLUTION_BY_ENGINE.chromium;

const MOBILE_DEVICES = Object.freeze([
  { name: 'iPhone 13',         label: 'iPhone 13',         os: 'iOS',     browserEngine: 'webkit',   viewportLabel: SAUCE_DEFAULT_RESOLUTION_BY_ENGINE.webkit },
  { name: 'iPhone 14',         label: 'iPhone 14',         os: 'iOS',     browserEngine: 'webkit',   viewportLabel: SAUCE_DEFAULT_RESOLUTION_BY_ENGINE.webkit },
  { name: 'iPhone 14 Pro Max', label: 'iPhone 14 Pro Max', os: 'iOS',     browserEngine: 'webkit',   viewportLabel: SAUCE_DEFAULT_RESOLUTION_BY_ENGINE.webkit },
  { name: 'iPad Pro 11',       label: 'iPad Pro 11"',      os: 'iPadOS',  browserEngine: 'webkit',   viewportLabel: SAUCE_DEFAULT_RESOLUTION_BY_ENGINE.webkit },
  { name: 'Pixel 5',           label: 'Pixel 5',           os: 'Android', browserEngine: 'chromium', viewportLabel: SAUCE_DEFAULT_RESOLUTION_BY_ENGINE.chromium },
  { name: 'Pixel 7',           label: 'Pixel 7',           os: 'Android', browserEngine: 'chromium', viewportLabel: SAUCE_DEFAULT_RESOLUTION_BY_ENGINE.chromium },
  { name: 'Galaxy S9+',        label: 'Galaxy S9+',        os: 'Android', browserEngine: 'chromium', viewportLabel: SAUCE_DEFAULT_RESOLUTION_BY_ENGINE.chromium },
  { name: 'Galaxy S24',        label: 'Galaxy S24',        os: 'Android', browserEngine: 'chromium', viewportLabel: SAUCE_DEFAULT_RESOLUTION_BY_ENGINE.chromium }
]);

const SAUCE_SUPPORTED_VIEWPORTS = Object.freeze([
  '1024x768', '1152x864', '1280x800', '1280x960', '1280x1024',
  '1376x1032', '1440x900', '1600x1200', '1680x1050',
  '1920x1080', '1920x1200', '1920x1440', '2048x1536', '2560x1600'
]);

function resolutionsForEngine(engine) {
  return SAUCE_RESOLUTIONS_BY_ENGINE[engine] ?? SAUCE_RESOLUTIONS_BY_ENGINE.chromium;
}

// Sauce's validated platform list (from saucectl validator output):
//   "macOS 11.00", "macOS 12", "macOS 13", "Windows 10", "Windows 11"
// macOS 14+ is NOT supported by saucectl's Playwright runner.
const SAUCE_PLATFORMS_BY_ENGINE = Object.freeze({
  chromium: Object.freeze(['Windows 10', 'Windows 11', 'macOS 11.00', 'macOS 12', 'macOS 13']),
  firefox:  Object.freeze(['Windows 10', 'Windows 11', 'macOS 11.00', 'macOS 12', 'macOS 13']),
  webkit:   Object.freeze(['macOS 11.00', 'macOS 12', 'macOS 13'])
});

const SAUCE_DEFAULT_PLATFORM_BY_ENGINE = Object.freeze({
  chromium: 'Windows 11',
  firefox:  'Windows 11',
  webkit:   'macOS 13'
});

function platformsForEngine(engine) {
  return SAUCE_PLATFORMS_BY_ENGINE[engine] ?? SAUCE_PLATFORMS_BY_ENGINE.chromium;
}

const MOBILE_DEVICE_NAMES = Object.freeze(MOBILE_DEVICES.map((d) => d.name));

function isKnownMobileDevice(name) {
  return MOBILE_DEVICE_NAMES.includes(name);
}

function findMobileDevice(name) {
  return MOBILE_DEVICES.find((d) => d.name === name) ?? null;
}

export {
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
};
