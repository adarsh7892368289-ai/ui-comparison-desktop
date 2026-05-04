
const BROWSER_CAPABILITY_PROFILES = Object.freeze({
  chromium: Object.freeze({
    cdpAvailable: true,
    screenshotMethod: 'cdp-webp',
    screenshotMimeType: 'image/webp',
    freezeMethod: 'cdp-script-disable',
    metricsOverrideAvailable: true,
    viewportOverrideMethod: 'cdp-emulation',
    deviceScaleFactorOverride: true,
    bringToFront: 'cdp',
    expectedScrollbarGutterPx: 15,
    subPixelScrollAccurate: true,
    requiresLayoutWarmup: false
  }),
  firefox: Object.freeze({
    cdpAvailable: false,
    screenshotMethod: 'playwright-png',
    screenshotMimeType: 'image/png',
    freezeMethod: 'js-shim',
    metricsOverrideAvailable: false,
    viewportOverrideMethod: 'playwright-set-viewport',
    deviceScaleFactorOverride: false,
    bringToFront: 'playwright',
    expectedScrollbarGutterPx: 17,
    subPixelScrollAccurate: true,
    requiresLayoutWarmup: false
  }),
  webkit: Object.freeze({
    cdpAvailable: false,
    screenshotMethod: 'playwright-png',
    screenshotMimeType: 'image/png',
    freezeMethod: 'js-shim',
    metricsOverrideAvailable: false,
    viewportOverrideMethod: 'playwright-set-viewport',
    deviceScaleFactorOverride: false,
    bringToFront: 'playwright',
    expectedScrollbarGutterPx: 0,
    subPixelScrollAccurate: true,
    requiresLayoutWarmup: true
  })
});

const BROWSER_NORMALIZATION_PROFILES = Object.freeze({
  chromium: Object.freeze({
    requiresFontFamilyDequote: false,
    requiresLineHeightNormalize: true,
    requiresBoxShadowReorder: false,
    requiresFontWeightCanonicalize: true
  }),
  firefox: Object.freeze({
    requiresFontFamilyDequote: true,
    requiresLineHeightNormalize: true,
    requiresBoxShadowReorder: false,
    requiresFontWeightCanonicalize: true
  }),
  webkit: Object.freeze({
    requiresFontFamilyDequote: true,
    requiresLineHeightNormalize: true,
    requiresBoxShadowReorder: true,
    requiresFontWeightCanonicalize: true
  })
});

export { BROWSER_CAPABILITY_PROFILES, BROWSER_NORMALIZATION_PROFILES };