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

const _CHROMIUM_RESOLUTIONS = Object.freeze([
  '1024x768', '1280x800', '1280x1024', '1440x900',
  '1600x1200', '1680x1050', '1920x1080', '1920x1200', '2560x1600'
]);

const SAUCE_RESOLUTIONS_BY_ENGINE = Object.freeze({
  chromium: _CHROMIUM_RESOLUTIONS,
  chrome:   _CHROMIUM_RESOLUTIONS,
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
  chrome:   '1920x1080',
  firefox:  '1920x1080',
  webkit:   '1440x900'
});

const SAUCE_DEFAULT_VIEWPORT = SAUCE_DEFAULT_RESOLUTION_BY_ENGINE.chromium;

const MOBILE_DEVICES = Object.freeze([
  { name: 'iPhone 13',         label: 'iPhone 13',         os: 'iOS',     browserEngine: 'webkit',   viewportLabel: SAUCE_DEFAULT_RESOLUTION_BY_ENGINE.webkit, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 },
  { name: 'iPhone 14',         label: 'iPhone 14',         os: 'iOS',     browserEngine: 'webkit',   viewportLabel: SAUCE_DEFAULT_RESOLUTION_BY_ENGINE.webkit, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 },
  { name: 'iPhone 14 Pro Max', label: 'iPhone 14 Pro Max', os: 'iOS',     browserEngine: 'webkit',   viewportLabel: SAUCE_DEFAULT_RESOLUTION_BY_ENGINE.webkit, viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 },
  { name: 'iPad Pro 11',       label: 'iPad Pro 11"',      os: 'iPadOS',  browserEngine: 'webkit',   viewportLabel: SAUCE_DEFAULT_RESOLUTION_BY_ENGINE.webkit, viewport: { width: 834, height: 1194 }, deviceScaleFactor: 2 },
  { name: 'Pixel 5',           label: 'Pixel 5',           os: 'Android', browserEngine: 'chromium', viewportLabel: SAUCE_DEFAULT_RESOLUTION_BY_ENGINE.chromium, viewport: { width: 393, height: 851 }, deviceScaleFactor: 2.75 },
  { name: 'Pixel 7',           label: 'Pixel 7',           os: 'Android', browserEngine: 'chromium', viewportLabel: SAUCE_DEFAULT_RESOLUTION_BY_ENGINE.chromium, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625 },
  { name: 'Galaxy S9+',        label: 'Galaxy S9+',        os: 'Android', browserEngine: 'chromium', viewportLabel: SAUCE_DEFAULT_RESOLUTION_BY_ENGINE.chromium, viewport: { width: 320, height: 658 }, deviceScaleFactor: 4.5 },
  { name: 'Galaxy S24',        label: 'Galaxy S24',        os: 'Android', browserEngine: 'chromium', viewportLabel: SAUCE_DEFAULT_RESOLUTION_BY_ENGINE.chromium, viewport: { width: 384, height: 854 }, deviceScaleFactor: 2.8125 }
]);

const SAUCE_SUPPORTED_VIEWPORTS = Object.freeze([
  '1024x768', '1152x864', '1280x800', '1280x960', '1280x1024',
  '1376x1032', '1440x900', '1600x1200', '1680x1050',
  '1920x1080', '1920x1200', '1920x1440', '2048x1536', '2560x1600'
]);

function resolutionsForEngine(engine) {
  return SAUCE_RESOLUTIONS_BY_ENGINE[engine] ?? SAUCE_RESOLUTIONS_BY_ENGINE.chromium;
}

const SAUCE_SUPPORTED_PLAYWRIGHT_VERSIONS = Object.freeze([
  '1.58.2', '1.58.1', '1.57.0', '1.56.1', '1.55.1', '1.54.1', '1.52.0', '1.50.1', '1.49.1'
]);

const SAUCE_SUPPORTED_BROWSERS = Object.freeze(['chromium', 'chrome', 'firefox', 'webkit']);

const SAUCE_COMPATIBILITY_MATRIX = Object.freeze({
  '1.58.2': { platforms: Object.freeze(['Windows 10', 'Windows 11', 'macOS 14', 'macOS 15']), browsers: Object.freeze(['chromium', 'chrome', 'firefox', 'webkit']), exclusions: Object.freeze([{ platform: 'macOS 15', browser: 'firefox' }]) },
  '1.58.1': { platforms: Object.freeze(['Windows 10', 'Windows 11', 'macOS 14', 'macOS 15']), browsers: Object.freeze(['chromium', 'chrome', 'firefox', 'webkit']), exclusions: Object.freeze([{ platform: 'macOS 15', browser: 'firefox' }]) },
  '1.57.0': { platforms: Object.freeze(['Windows 10', 'Windows 11', 'macOS 12', 'macOS 13']), browsers: Object.freeze(['chromium', 'chrome', 'firefox', 'webkit']), exclusions: Object.freeze([{ platform: 'macOS 12', browser: 'webkit' }]) },
  '1.56.1': { platforms: Object.freeze(['Windows 10', 'Windows 11', 'macOS 12', 'macOS 13']), browsers: Object.freeze(['chromium', 'chrome', 'firefox']), exclusions: Object.freeze([]) },
  '1.55.1': { platforms: Object.freeze(['Windows 10', 'Windows 11', 'macOS 12', 'macOS 13']), browsers: Object.freeze(['chromium', 'chrome', 'firefox']), exclusions: Object.freeze([]) },
  '1.54.1': { platforms: Object.freeze(['Windows 10', 'Windows 11', 'macOS 12', 'macOS 13']), browsers: Object.freeze(['chromium', 'chrome', 'firefox', 'webkit']), exclusions: Object.freeze([{ platform: 'macOS 12', browser: 'webkit' }]) },
  '1.52.0': { platforms: Object.freeze(['Windows 10', 'Windows 11', 'macOS 12', 'macOS 13']), browsers: Object.freeze(['chromium', 'chrome', 'firefox', 'webkit']), exclusions: Object.freeze([{ platform: 'macOS 12', browser: 'webkit' }]) },
  '1.50.1': { platforms: Object.freeze(['Windows 10', 'Windows 11', 'macOS 12', 'macOS 13']), browsers: Object.freeze(['chromium', 'chrome', 'firefox', 'webkit']), exclusions: Object.freeze([{ platform: 'macOS 12', browser: 'webkit' }]) },
  '1.49.1': { platforms: Object.freeze(['Windows 10', 'Windows 11', 'macOS 12', 'macOS 13']), browsers: Object.freeze(['chromium', 'chrome', 'firefox', 'webkit']), exclusions: Object.freeze([{ platform: 'macOS 12', browser: 'webkit' }]) },
});

const SAUCE_SUPPORTED_VISIBILITIES = Object.freeze(['private', 'team', 'share', 'public restricted', 'public']);

const SAUCE_SUPPORTED_REGIONS = Object.freeze(['us-west-1', 'eu-central-1', 'us-east-4']);

const SAUCE_PLATFORMS_BY_ENGINE = Object.freeze({
  chromium: Object.freeze(['Windows 10', 'Windows 11', 'macOS 12', 'macOS 13']),
  chrome:   Object.freeze(['Windows 10', 'Windows 11', 'macOS 12', 'macOS 13']),
  firefox:  Object.freeze(['Windows 10', 'Windows 11', 'macOS 12', 'macOS 13']),
  webkit:   Object.freeze(['macOS 12', 'macOS 13'])
});

const SAUCE_DEFAULT_PLATFORM_BY_ENGINE = Object.freeze({
  chromium: 'Windows 11',
  chrome:   'Windows 11',
  firefox:  'Windows 11',
  webkit:   'macOS 13'
});

function platformsForEngine(engine) {
  return SAUCE_PLATFORMS_BY_ENGINE[engine] ?? SAUCE_PLATFORMS_BY_ENGINE.chromium;
}

function isValidCombination(playwrightVersion, platform, browserName) {
  const entry = SAUCE_COMPATIBILITY_MATRIX[playwrightVersion];
  if (!entry) return false;
  if (!entry.platforms.includes(platform)) return false;
  if (!entry.browsers.includes(browserName)) return false;
  if (entry.exclusions.some(e => e.platform === platform && e.browser === browserName)) return false;
  return true;
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
  SAUCE_SUPPORTED_PLAYWRIGHT_VERSIONS,
  SAUCE_SUPPORTED_BROWSERS,
  SAUCE_COMPATIBILITY_MATRIX,
  SAUCE_SUPPORTED_VISIBILITIES,
  SAUCE_SUPPORTED_REGIONS,
  isValidCombination,
  isSide,
  oppositeSide,
  isFormFactor,
  isKnownMobileDevice,
  findMobileDevice
};
