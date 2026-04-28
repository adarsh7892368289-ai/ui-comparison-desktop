'use strict';

const { chromium, firefox, webkit } = require('playwright');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const log = require('electron-log');

const { mainDistributionDir } = require('./resource-paths');
const { groupIntoKeyframes } = require('../core/comparison/keyframe-grouper.js');
const { Comparator } = require('../core/comparison/comparator.js');
const { assessUrlCompatibility } = require('../core/comparison/url-compatibility.js');
const { BROWSER_CAPABILITY_PROFILES } = require('../config/browser-capability-profile.js');

const CAPTURE_SCALE_FACTOR = 2;
const CAPTURE_QUALITY = 85;
const FREEZE_STYLE_ID = 'vdiff-freeze-styles';
const SUPPRESS_ATTR = 'data-vdiff-suppress';
const SCROLL_SETTLE_TIMEOUT_MS = 800;
const SCROLL_VERIFY_RETRY_MAX = 2;
const SCROLL_VERIFY_RETRY_MS = 400;
const DEVTOOLS_HEIGHT_THRESHOLD_PX = 200;
const BROWSER_CHROME_HEIGHT_PX = 88;
const CDP_COMMAND_TIMEOUT_MS = 5_000;

function _profileFor(browserTypeName) {
  return BROWSER_CAPABILITY_PROFILES[browserTypeName] ?? BROWSER_CAPABILITY_PROFILES.chromium;
}

function getScrollTolerance(browserType) {
  switch (browserType) {
    case 'firefox':  return 5;
    case 'webkit':   return 5;
    case 'chromium': return 5;
    default:         return 5;
  }
}

const _browsers = new Map();

const _perfAccumulator = new Map();

function _recordPhase(name, startMs) {
  const duration = Date.now() - startMs;
  const arr = _perfAccumulator.get(name) ?? [];
  arr.push(duration);
  _perfAccumulator.set(name, arr);
  log.debug('[PM] phase timing', { phase: name, ms: duration });
}

function getPerformanceSnapshot() {
  const out = {};
  for (const [phase, durations] of _perfAccumulator) {
    if (!durations.length) {continue;}
    const sorted = [...durations].sort((a, b) => a - b);
    const count = durations.length;
    const p = (ratio) => count < 2 ? null : sorted[Math.floor(sorted.length * ratio)];
    out[phase] = {
      count,
      p50: p(0.50),
      p95: p(0.95),
      p99: p(0.99),
      lastMs: durations[durations.length - 1]
    };
  }
  return out;
}

let _extractorBundleSource = null;

function getExtractorBundleSource() {
  if (_extractorBundleSource !== null) {
    return _extractorBundleSource;
  }

  const distDir = mainDistributionDir();


  const candidates = [
  path.join(distDir, 'extractor-bundle.js'),
  path.join(__dirname, 'extractor-bundle.js'),
  path.join(process.cwd(), 'dist', 'extractor-bundle.js')];


  for (const candidate of candidates) {
    try {
      _extractorBundleSource = fs.readFileSync(candidate, 'utf8');
      log.info('[PM] Loaded extractor bundle', { path: candidate });
      return _extractorBundleSource;
    } catch {
      void 0;
    }
  }

  throw new Error(
    `Extractor bundle not found. Run: npm run build:extractor\nSearched:\n${candidates.map((c) => `  ${c}`).join('\n')}`
  );
}

async function getBrowser(descriptorOrType = 'chromium') {
  const descriptor = typeof descriptorOrType === 'string'
    ? { browserType: descriptorOrType, channel: null, executablePath: null }
    : (descriptorOrType ?? { browserType: 'chromium', channel: null, executablePath: null });

  const browserType = descriptor.browserType ?? 'chromium';
  const channel = descriptor.channel ?? null;
  const executablePath = descriptor.executablePath ?? null;

  const cacheKey = `${browserType}:${channel ?? executablePath ?? 'managed'}`;
  const existing = _browsers.get(cacheKey);
  if (existing && existing.isConnected()) {return existing;}

  const launcher = { chromium, firefox, webkit }[browserType];
  if (!launcher) {throw new Error(`Unknown browserType: ${browserType}`);}

  const launchOptions = { headless: true };
  if (channel) {
    launchOptions.channel = channel;
  } else if (executablePath) {
    launchOptions.executablePath = executablePath;
  }

  log.info('[PM] Launching browser', { browserType, channel, executablePath, cacheKey });
  const browser = await launcher.launch(launchOptions);
  _browsers.set(cacheKey, browser);
  return browser;
}

async function shutdownPlaywright() {
  const tasks = [];
  for (const [type, browser] of _browsers) {
    tasks.push(
      browser.close().catch((err) =>
      log.warn('[PM] Browser close error', { type, err: err.message })
      )
    );
  }
  await Promise.allSettled(tasks);
  _browsers.clear();
  log.info('[PM] All browsers closed');
}

const _sessionMap = new WeakMap();

async function attachSession(page) {
  const browserTypeName = page.context().browser().browserType().name();
  const profile = _profileFor(browserTypeName);
  const freezeStrategy = profile.cdpAvailable ? 'cdp' : 'shim';

  let cdpSession = null;
  if (freezeStrategy === 'cdp') {
    cdpSession = await page.context().newCDPSession(page);
    log.debug('[PM] CDP session attached', { browserTypeName });
  }

  const sessionHandle = {
    cdpSession,
    page,
    browserTypeName,
    freezeStrategy,
    frozen: false
  };
  _sessionMap.set(page, sessionHandle);
  return sessionHandle;
}

async function detachSession(sessionHandle) {
  if (!sessionHandle) {return;}

  if (sessionHandle.frozen) {
    await unfreezePage(sessionHandle).catch((err) =>
    log.warn('[PM] unfreeze during detach failed', { err: err.message })
    );
  }

  _sessionMap.delete(sessionHandle.page);

  if (sessionHandle.cdpSession) {
    await sessionHandle.cdpSession.detach().catch(() => {});
    log.debug('[PM] CDP session detached');
  }
}

async function sendCDP(sessionHandle, method, params = {}, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
  if (sessionHandle.freezeStrategy === 'cdp' && sessionHandle.cdpSession) {
    const sendP = sessionHandle.cdpSession.send(method, params);
    const timeoutP = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`CDP timeout: ${method} after ${timeoutMs}ms`)),
      timeoutMs
    )
    );
    return Promise.race([sendP, timeoutP]);
  }

  const { page } = sessionHandle;

  switch (method) {
    case 'Page.bringToFront':
      await page.bringToFront();
      return {};

    case 'Emulation.setDeviceMetricsOverride':
      if (params.width > 0 && params.height > 0) {
        await page.setViewportSize({ width: params.width, height: params.height });
      }
      return {};

    case 'Emulation.clearDeviceMetricsOverride':
      log.debug('[PM] clearDeviceMetricsOverride is a no-op on shim path', { method });
      return {};

    case 'Emulation.setScriptExecutionDisabled':
      if (params.value === true) {
        await freezePage(sessionHandle);
      } else {
        await unfreezePage(sessionHandle);
      }
      return {};

    case 'Page.captureScreenshot':
      return captureScreenshot(sessionHandle, params.clip ?? null, { quality: params.quality });

    default:
      throw new Error(`Unrecognised CDP method on shim path: ${method}`);
  }
}

async function freezePage(sessionHandle) {
  if (sessionHandle.frozen) {return;}

  const profile = _profileFor(sessionHandle.browserTypeName);
  if (profile.freezeMethod === 'cdp-script-disable' && sessionHandle.cdpSession) {
    await sessionHandle.cdpSession.send('Emulation.setScriptExecutionDisabled', { value: true });
    sessionHandle.frozen = true;
    return;
  }

  await sessionHandle.page.evaluate(({ styleId }) => {
    window.__vdiff_raf_orig = window.requestAnimationFrame;
    window.__vdiff_set_orig = window.setTimeout;
    window.__vdiff_int_orig = window.setInterval;

    window.requestAnimationFrame = () => -1;

    window.setInterval = () => -1;

    window.setTimeout = (fn, ms, ...args) => {
      if (ms === 0 || ms == null) {return window.__vdiff_set_orig(fn, 0, ...args);}
      return -1;
    };

    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = [
      '*, *::before, *::after {',
      '  animation-play-state: paused !important;',
      '  transition-duration: 0s !important;',
      '  scroll-behavior: auto !important;',
      '}'].
      join('\n');
      document.head.appendChild(style);
    }
  }, { styleId: FREEZE_STYLE_ID });

  await sessionHandle.page.evaluate(() =>
  new Promise((r) => window.__vdiff_raf_orig(r))
  );

  sessionHandle.frozen = true;
}

async function unfreezePage(sessionHandle) {
  if (!sessionHandle.frozen) {return;}

  const profile = _profileFor(sessionHandle.browserTypeName);
  if (profile.freezeMethod === 'cdp-script-disable' && sessionHandle.cdpSession) {
    await sessionHandle.cdpSession.send('Emulation.setScriptExecutionDisabled', { value: false });
    sessionHandle.frozen = false;
    return;
  }

  await sessionHandle.page.evaluate(() => {
    if (window.__vdiff_raf_orig) {window.requestAnimationFrame = window.__vdiff_raf_orig;}
    if (window.__vdiff_set_orig) {window.setTimeout = window.__vdiff_set_orig;}
    if (window.__vdiff_int_orig) {window.setInterval = window.__vdiff_int_orig;}
  }).catch(() => {});

  await sessionHandle.page.evaluate(({ styleId }) => {
    document.getElementById(styleId)?.remove();
  }, { styleId: FREEZE_STYLE_ID }).catch(() => {});

  sessionHandle.frozen = false;
}

async function captureScreenshot(sessionHandle, clipRect, options = {}) {
  const profile = _profileFor(sessionHandle.browserTypeName);
  const useCdpWebp = profile.screenshotMethod === 'cdp-webp' && sessionHandle.cdpSession;

  if (useCdpWebp) {
    const cdpParams = {
      format: 'webp',
      quality: options.quality ?? CAPTURE_QUALITY,
      captureBeyondViewport: false,
      optimizeForSpeed: false
    };
    if (clipRect) {
      cdpParams.clip = { ...clipRect, scale: 1 };
    }
    const { data } = await sessionHandle.cdpSession.send('Page.captureScreenshot', cdpParams);
    return {
      data: Buffer.from(data, 'base64'),
      format: 'webp',
      mimeType: profile.screenshotMimeType
    };
  }

  const screenshotOptions = { type: 'png' };
  if (clipRect) {screenshotOptions.clip = clipRect;}
  const buffer = await sessionHandle.page.screenshot(screenshotOptions);
  return {
    data: buffer,
    format: 'png',
    mimeType: profile.screenshotMimeType
  };
}

async function executeInPage(sessionHandle, fn, args) {
  return sessionHandle.page.evaluate(fn, args);
}

async function recoverFrozenSessions() {
  let recovered = 0;
  for (const [, browser] of _browsers) {
    if (!browser.isConnected()) {continue;}
    try {
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          const frozen = await page.evaluate(
            () => !!document.getElementById('vdiff-freeze-styles')
          ).catch(() => false);
          if (frozen) {
            const url = page.url();
            log.warn('[PM] Closing frozen page from prior session', { url });
            await page.close().catch(() => {});
            recovered++;
          }
        }
      }
    } catch (err) {
      log.warn('[PM] recoverFrozenSessions: error probing browser', { error: err.message });
    }
  }
  return recovered;
}

function inPageGetViewport() {
  return {
    width: Math.floor(window.innerWidth),
    height: Math.floor(window.innerHeight),
    documentHeight: document.documentElement.scrollHeight,
    outerHeight: Math.floor(window.outerHeight),
    outerWidth: Math.floor(window.outerWidth)
  };
}

function inPageGetDPR() {
  return window.devicePixelRatio;
}

function inPageLockScrollbar() {
  const before = window.innerWidth;
  document.body.style.setProperty('overflow', 'hidden', 'important');
  const scrollbarW = window.innerWidth - before;
  if (scrollbarW > 0) {
    document.body.style.setProperty('padding-right', `${scrollbarW}px`, 'important');
  }
  return { scrollbarWidth: scrollbarW };
}

function inPageUnlockScrollbar() {
  document.body.style.removeProperty('overflow');
  document.body.style.removeProperty('padding-right');
}

function inPageFreezeAnimations(styleId) {
  if (document.getElementById(styleId)) {return;}
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = [
  'html, body { scroll-behavior: auto !important; }',
  '*, *::before, *::after {',
  '  animation-duration: 0s !important;',
  '  animation-delay: 0s !important;',
  '  transition: none !important;',
  '}'].
  join(' ');
  document.head.appendChild(style);

  if (!window.__vdiffScrollPatched) {
    window.__vdiffScrollPatched = true;
    (function patchScrollAPIs() {
      function stripSmooth(args) {
        if (args.length === 1 && args[0] !== null && typeof args[0] === 'object') {
          return [Object.assign({}, args[0], { behavior: 'auto' })];
        }
        return args;
      }
      function wrap(obj, method) {
        if (!obj || typeof obj[method] !== 'function') {return;}
        const orig = obj[method];
        obj[method] = function vdiffScrollWrap() {
          return orig.apply(this, stripSmooth(Array.from(arguments)));
        };
      }
      wrap(window, 'scrollTo');
      wrap(window, 'scrollBy');
      wrap(Element.prototype, 'scrollTo');
      wrap(Element.prototype, 'scrollBy');
      wrap(Element.prototype, 'scrollIntoView');
    })();
  }
}

function inPageRestoreAnimations(styleId) {
  document.getElementById(styleId)?.remove();
}

function inPageSuppressFixed([markAttr, diffSelectors]) {
  const protectedEls = new Set();
  const protectedAncestors = new Set();
  const protectedDescendants = new Set();

  for (const sel of diffSelectors || []) {
    const el = document.querySelector(sel);
    if (!el) {continue;}
    protectedEls.add(el);
    let ancestor = el.parentElement;
    while (ancestor && ancestor !== document.documentElement) {
      protectedAncestors.add(ancestor);
      ancestor = ancestor.parentElement;
    }
    el.querySelectorAll('*').forEach((d) => protectedDescendants.add(d));
  }

  const all = document.querySelectorAll('*');
  const toHide = [];
  for (const domEl of all) {
    if (protectedEls.has(domEl) || protectedAncestors.has(domEl) || protectedDescendants.has(domEl)) {continue;}
    const { position } = getComputedStyle(domEl);
    if (position === 'fixed' || position === 'sticky') {toHide.push(domEl);}
  }
  for (const domEl of toHide) {
    domEl.setAttribute(markAttr, '1');
    domEl.style.setProperty('display', 'none', 'important');
  }
  return { suppressed: toHide.length, domSize: all.length };
}

function inPageRestoreFixed(markAttr) {
  for (const domEl of document.querySelectorAll(`[${markAttr}]`)) {
    domEl.style.removeProperty('display');
    domEl.removeAttribute(markAttr);
  }
}

function inPageScrollAndSettle([targetY, fallbackMs]) {
  window.scrollTo(0, targetY);
  const tolerance = 2;

  return new Promise(function (resolve) {
    const deadline = Date.now() + fallbackMs;
    let lastY = -1;
    let stableCount = 0;
    let done = false;

    function finish(y) {
      if (done) {return;}
      done = true;
      clearTimeout(hardTimer);
      resolve(y);
    }

    const hardTimer = setTimeout(
      function () {finish(Math.round(window.scrollY));},
      fallbackMs
    );

    function tick() {
      if (done) {return;}
      const y = Math.round(window.scrollY);
      if (y === lastY && Math.abs(y - targetY) <= tolerance) {
        stableCount++;
        if (stableCount >= 2) {finish(y);return;}
      } else {
        stableCount = 0;
      }
      lastY = y;
      if (Date.now() >= deadline) {finish(y);return;}
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

function inPageGetRects(selectorPairs) {
  const { scrollY } = window;
  return selectorPairs.map(({ id, selector }) => {
    const domEl = selector ? document.querySelector(selector) : null;
    if (!domEl) {return { id, found: false, usable: false };}
    const matchCount = selector ? document.querySelectorAll(selector).length : 1;
    const selectorAmbiguous = matchCount > 1;
    const r = domEl.getBoundingClientRect();
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    if (w === 0 && h === 0) {return { id, found: true, usable: false, selectorAmbiguous };}
    return {
      id, found: true, usable: true, selectorAmbiguous,
      selectorMatchCount: matchCount,
      documentY: Math.round(r.top + scrollY),
      height: h, width: w, left: Math.round(r.left)
    };
  });
}

function inPageRemeasureRects(selectorPairs) {
  const actualScrollY = Math.round(window.scrollY);
  const vpH = window.innerHeight;
  const vpW = window.innerWidth;

  const rects = selectorPairs.map(({ id, selector }) => {
    const el = selector ? document.querySelector(selector) : null;
    if (!el) {
      return { id, found: false, inViewport: false, misalignReason: 'element-not-found' };
    }
    const matchCount = selector ? document.querySelectorAll(selector).length : 1;
    const selectorAmbiguous = matchCount > 1;
    const r = el.getBoundingClientRect();
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    if (w === 0 && h === 0) {
      return {
        id, found: true, inViewport: false, misalignReason: 'zero-dimension',
        selectorAmbiguous, selectorMatchCount: matchCount,
        viewportX: Math.round(r.left), viewportY: Math.round(r.top),
        width: 0, height: 0
      };
    }
    const inViewport = r.bottom > 0 && r.top < vpH && r.right > 0 && r.left < vpW;
    return {
      id, found: true, inViewport,
      misalignReason: inViewport ? null : 'out-of-viewport',
      selectorAmbiguous, selectorMatchCount: matchCount,
      viewportX: Math.round(r.left), viewportY: Math.round(r.top),
      width: w, height: h
    };
  });

  return { actualScrollY, rects };
}

function inPageGetPseudoStyles(selectorPairs) {
  const PSEUDO_PROPS = [
  'content', 'display', 'width', 'height', 'background-color', 'color',
  'font-size', 'font-family', 'position', 'top', 'left', 'right', 'bottom',
  'transform', 'opacity', 'border', 'padding', 'margin', 'box-shadow',
  'border-radius', 'z-index', 'visibility'];

  function collectPseudo(el, pseudo) {
    const cs = window.getComputedStyle(el, pseudo);
    const content = cs.getPropertyValue('content');
    if (!content || content === 'none' || content === 'normal' ||
    content === '""' || content === "''") {return null;}
    const styles = Object.create(null);
    for (const p of PSEUDO_PROPS) {
      const val = cs.getPropertyValue(p);
      if (val) {styles[p] = val;}
    }
    return styles;
  }
  return selectorPairs.map(({ id, selector }) => {
    const el = selector ? document.querySelector(selector) : null;
    if (!el) {return { id, before: null, after: null };}
    return { id, before: collectPseudo(el, '::before'), after: collectPseudo(el, '::after') };
  });
}

function ms(start) {return `${Date.now() - start}ms`;}

function buildMetricsOverride(viewport, scrollbarWidth = 0, targetHeight) {
  return {
    width: Math.round(viewport.width) + Math.round(scrollbarWidth || 0),
    height: Math.round(targetHeight ?? viewport.height),
    deviceScaleFactor: CAPTURE_SCALE_FACTOR,
    mobile: false
  };
}

function prefixKeyframes(keyframes, sessionId, role) {
  return keyframes.map((kf) => ({
    ...kf,
    id: `${sessionId}_${role}_${kf.id}`,
    sessionId,
    tabRole: role
  }));
}

function buildManifestFromRemeasured(keyframes, remeasureResults, documentYById, actualDPR, documentHeight, viewportHeight) {
  const resultByKfId = new Map(remeasureResults.map((r) => [r.keyframeId, r]));
  const manifest = new Map();
  const vpH = viewportHeight > 0 ? viewportHeight : Infinity;

  for (const kf of keyframes) {
    const remeasure = resultByKfId.get(kf.id);
    if (!remeasure) {continue;}
    const { actualScrollY, rects } = remeasure;
    const measuredById = new Map(rects.map((r) => [r.id, r]));

    for (const elId of kf.elementIds) {
      const m = measuredById.get(elId);
      const docY = documentYById.get(elId) ?? null;

      if (!m || !m.found) {
        manifest.set(elId, {
          keyframeId: kf.id, actualDPR, dpr: CAPTURE_SCALE_FACTOR, kfScrollY: actualScrollY,
          documentY: docY, totalDocumentHeight: documentHeight, viewportRect: null,
          misaligned: true, misalignReason: m?.misalignReason ?? 'element-not-found',
          selectorAmbiguous: false, selectorMatchCount: null, rectClipped: false
        });
        continue;
      }

      const rawY = m.viewportY;
      const rawH = m.height;
      const clippedY = Math.max(0, rawY);
      const clippedBottom = Math.min(rawY + rawH, vpH);
      const clippedH = Math.max(1, clippedBottom - clippedY);
      const rectClipped = clippedH < rawH;

      if (clippedBottom <= 0) {
        manifest.set(elId, {
          keyframeId: kf.id, actualDPR, dpr: CAPTURE_SCALE_FACTOR, kfScrollY: actualScrollY,
          documentY: docY, totalDocumentHeight: documentHeight, viewportRect: null,
          misaligned: true, misalignReason: 'clipped-below-fold',
          selectorAmbiguous: m.selectorAmbiguous ?? false,
          selectorMatchCount: m.selectorMatchCount ?? null, rectClipped: true
        });
        continue;
      }

      manifest.set(elId, {
        keyframeId: kf.id, actualDPR, dpr: CAPTURE_SCALE_FACTOR, kfScrollY: actualScrollY,
        documentY: docY, totalDocumentHeight: documentHeight,
        viewportRect: { x: m.viewportX, y: clippedY, width: m.width, height: clippedH },
        rawViewportRect: { x: m.viewportX, y: rawY, width: m.width, height: rawH },
        misaligned: !m.inViewport || undefined,
        misalignReason: m.inViewport ? undefined : m.misalignReason,
        selectorAmbiguous: m.selectorAmbiguous ?? false,
        selectorMatchCount: m.selectorMatchCount ?? null,
        rectClipped
      });
    }
  }
  return manifest;
}

function attachPseudoDataToManifest(manifest, pseudoResults) {
  if (!pseudoResults?.length) {return;}
  for (const { id, before, after } of pseudoResults) {
    const entry = manifest.get(id);
    if (!entry) {continue;}
    if (before) {entry.pseudoBefore = { ...before, parentHpid: id, pseudoType: 'before' };}
    if (after) {entry.pseudoAfter = { ...after, parentHpid: id, pseudoType: 'after' };}
  }
}

function buildElementRectRecords(sessionId, role, manifest) {
  const records = [];
  for (const [elementKey, entry] of manifest.entries()) {
    const {
      keyframeId, viewportRect, rawViewportRect, actualDPR, documentY, totalDocumentHeight,
      pseudoBefore, pseudoAfter, misaligned, misalignReason,
      selectorAmbiguous, selectorMatchCount, rectClipped
    } = entry;
    records.push({
      id: `${sessionId}_${role}_rect_${elementKey}`,
      sessionId, elementKey, tabRole: role, keyframeId,
      rect: viewportRect,
      rawRect: rawViewportRect ?? null,
      actualDPR, documentY, totalDocumentHeight,
      pseudoBefore: pseudoBefore ?? null,
      pseudoAfter: pseudoAfter ?? null,
      misaligned: misaligned ?? false,
      misalignReason: misalignReason ?? null,
      selectorAmbiguous: selectorAmbiguous ?? false,
      selectorMatchCount: selectorMatchCount ?? null,
      rectClipped: rectClipped ?? false
    });
  }
  return records;
}

function buildDiffMap(elements, baselineManifest, compareManifest) {
  const diffs = new Map();
  for (const el of elements) {
    const hpid = el.baselineElement.hpid;
    const baselineEntry = baselineManifest.get(hpid) ?? null;
    const compareEntry = compareManifest.get(hpid) ?? null;
    if (!baselineEntry && !compareEntry) {continue;}
    diffs.set(hpid, {
      baseline: baselineEntry,
      compare: compareEntry,
      diffs: el.annotatedDifferences ?? []
    });
  }
  return diffs;
}

function extractModifiedElements(comparisonResult) {
  return comparisonResult.comparison.results.filter((r) => (r.totalDifferences ?? 0) > 0);
}

function extractSelectorPair(element, role) {
  const roleEl = role === 'baseline' ? element.baselineElement : element.compareElement;
  if (!roleEl?.cssSelector) {return null;}
  return { id: element.baselineElement.hpid, selector: roleEl.cssSelector };
}

function buildSelectorPairs(elements, role) {
  return elements.map((el) => extractSelectorPair(el, role)).filter(Boolean);
}

async function safeRestorePage(sessionHandle) {
  const sh = sessionHandle;
  await executeInPage(sh, inPageUnlockScrollbar).catch(() => {});
  await executeInPage(sh, inPageRestoreFixed, SUPPRESS_ATTR).catch(() => {});
  await executeInPage(sh, inPageRestoreAnimations, FREEZE_STYLE_ID).catch(() => {});
  await executeInPage(sh, inPageScrollAndSettle, [0, SCROLL_SETTLE_TIMEOUT_MS]).catch(() => {});
  await sendCDP(sh, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
}

async function captureKeyframe(sessionHandle, keyframe, kfSelectorPairs, sessionId, index, total, roleStart, actualDPR, documentHeight) {
  const { id, scrollY, viewportWidth, viewportHeight, tabRole } = keyframe;
  const kfTag = `[kf ${index + 1}/${total} scrollY=${scrollY}]`;

  await sendCDP(sessionHandle, 'Page.bringToFront');
  log.info(`VDIFF ${kfTag} bringToFront DONE`, { role: tabRole });

  const t0 = Date.now();
  await executeInPage(sessionHandle, inPageScrollAndSettle, [scrollY, SCROLL_SETTLE_TIMEOUT_MS]);
  log.info(`VDIFF ${kfTag} scroll+paint DONE`, { elapsed: ms(t0) });

  const browserTypeName = sessionHandle.browserTypeName;
  const scrollTolerance = getScrollTolerance(browserTypeName);
  let actualScrollY = scrollY;
  for (let attempt = 0; attempt < SCROLL_VERIFY_RETRY_MAX; attempt++) {
    const readY = await executeInPage(sessionHandle, () => Math.round(window.scrollY));
    actualScrollY = readY;
    if (Math.abs(readY - scrollY) <= scrollTolerance) {break;}
    log.warn(`VDIFF ${kfTag} scroll mismatch`, { expected: scrollY, actual: readY, attempt, tolerance: scrollTolerance, browserTypeName });
    await executeInPage(sessionHandle, inPageScrollAndSettle, [scrollY, SCROLL_VERIFY_RETRY_MS]);
  }
  const settledDrift = Math.abs(actualScrollY - scrollY);
  if (settledDrift > scrollTolerance / 2 && settledDrift <= scrollTolerance) {
    log.warn(`[SCROLL-DRIFT-CANDIDATE] ${kfTag} settled drift near tolerance`, {
      expected: scrollY, actual: actualScrollY, drift: settledDrift,
      tolerance: scrollTolerance, browserTypeName
    });
  }

  const tRemeasure = Date.now();
  const remeasureRaw = await executeInPage(sessionHandle, inPageRemeasureRects, kfSelectorPairs);
  const confirmedScrollY = remeasureRaw?.actualScrollY ?? actualScrollY;
  const remeasuredRects = remeasureRaw?.rects ?? [];
  log.info(`VDIFF ${kfTag} remeasure DONE`, {
    elapsed: ms(tRemeasure), confirmedScrollY,
    misaligned: remeasuredRects.filter((r) => !r.inViewport || !r.found).length
  });

  await freezePage(sessionHandle);
  log.info(`VDIFF ${kfTag} JS freeze DONE`);

  let imageData;
  try {
    const t1 = Date.now();
    const { data, format, mimeType } = await captureScreenshot(sessionHandle, null, { quality: CAPTURE_QUALITY });
    log.info(`VDIFF ${kfTag} captureScreenshot DONE`, { elapsed: ms(t1), format, mimeType, bytes: data.length });
    imageData = { buffer: data, mimeType };
  } finally {
    await unfreezePage(sessionHandle);
    log.info(`VDIFF ${kfTag} JS unfreeze DONE`);
  }

  log.info(`VDIFF ${kfTag} COMPLETE`, { totalElapsed: ms(roleStart) });

  return {
    keyframeId: id,
    actualScrollY: confirmedScrollY,
    rects: remeasuredRects,
    blob: imageData,
    keyframeMeta: {
      id, sessionId, tabRole,
      scrollY: confirmedScrollY,
      viewportWidth,
      viewportHeight,
      documentHeight,
      captureScaleFactor: CAPTURE_SCALE_FACTOR,
      devicePixelRatio: actualDPR,
      capturedAt: Date.now()
    }
  };
}

async function captureAllKeyframes(sessionHandle, keyframes, selectorById, sessionId, role, actualDPR, documentHeight, blobCache, comparisonId) {
  const total = keyframes.length;
  const roleStart = Date.now();
  const remeasureResults = [];
  const capturedKeyframes = [];
  log.info(`VDIFF [${role}] captureAllKeyframes START`, { keyframeCount: total });

  for (let i = 0; i < total; i++) {
    const kf = keyframes[i];
    const kfSelectorPairs = kf.elementIds.
    map((id) => selectorById.get(id)).
    filter(Boolean);

    const result = await captureKeyframe(
      sessionHandle, kf, kfSelectorPairs, sessionId, i, total, roleStart, actualDPR, documentHeight
    );

    if (blobCache && result.blob) {
      blobCache.set(`${comparisonId}:${result.keyframeId}`, result.blob);
    }

    capturedKeyframes.push(result.keyframeMeta);
    remeasureResults.push({
      keyframeId: result.keyframeId,
      actualScrollY: result.actualScrollY,
      rects: result.rects
    });
  }

  log.info(`VDIFF [${role}] captureAllKeyframes DONE`, {
    keyframeCount: total, totalElapsed: ms(roleStart)
  });

  return { remeasureResults, capturedKeyframes };
}

async function executeTabCapture(sessionHandle, selectorPairs, sessionId, role, blobCache, comparisonId) {
  const t0 = Date.now();
  log.info(`VDIFF [${role}] executeTabCapture START`, { selectorCount: selectorPairs.length });

  await sendCDP(sessionHandle, 'Page.bringToFront');

  const viewport = await executeInPage(sessionHandle, inPageGetViewport);
  if (!viewport) {throw new Error(`Failed to read viewport for [${role}]`);}

  let confirmedHeight = viewport.height;
  const heightGap = (viewport.outerHeight || 0) - viewport.height;
  const widthGap = (viewport.outerWidth || 0) - viewport.width;
  const devToolsDetected = heightGap > DEVTOOLS_HEIGHT_THRESHOLD_PX ||
  widthGap > DEVTOOLS_HEIGHT_THRESHOLD_PX;
  let devToolsWarning = null;

  if (devToolsDetected) {
    const targetHeight = Math.max(400, (viewport.outerHeight || viewport.height) - BROWSER_CHROME_HEIGHT_PX);
    log.warn(`VDIFF [${role}] DevTools detected`, { heightGap, targetHeight });
    await sendCDP(sessionHandle, 'Emulation.setDeviceMetricsOverride',
    buildMetricsOverride(viewport, 0, targetHeight));
    confirmedHeight = (await executeInPage(sessionHandle, () => Math.floor(window.innerHeight))) ?? targetHeight;
    devToolsWarning = {
      role, heightGap, widthGap,
      originalHeight: viewport.height,
      bypassHeight: confirmedHeight,
      message: `DevTools bypass on ${role} tab (${viewport.height}px → ${confirmedHeight}px)`
    };
  }

  const actualDPR = (await executeInPage(sessionHandle, inPageGetDPR)) ?? 1;
  const lockResult = await executeInPage(sessionHandle, inPageLockScrollbar);

  await sendCDP(sessionHandle, 'Emulation.setDeviceMetricsOverride',
  buildMetricsOverride(viewport, lockResult?.scrollbarWidth ?? 0,
  devToolsDetected ? confirmedHeight : undefined));

  await executeInPage(sessionHandle, inPageFreezeAnimations, FREEZE_STYLE_ID);

  const diffSelectors = selectorPairs.map((p) => p.selector).filter(Boolean);
  await executeInPage(sessionHandle, inPageSuppressFixed, [SUPPRESS_ATTR, diffSelectors]);
  await executeInPage(sessionHandle, inPageScrollAndSettle, [0, SCROLL_SETTLE_TIMEOUT_MS]);

  const raw = await executeInPage(sessionHandle, inPageGetRects, selectorPairs);
  const validRects = (raw ?? []).filter((r) => r.found && r.usable);
  log.info(`VDIFF [${role}] inPageGetRects DONE`, {
    total: selectorPairs.length, valid: validRects.length
  });

  if (validRects.length === 0) {
    log.warn(`VDIFF [${role}] 0 valid rects — aborting`, {});
    return { manifest: new Map(), keyframes: [], rectRecords: [], devToolsWarning };
  }

  const pseudoResults = await executeInPage(sessionHandle, inPageGetPseudoStyles, selectorPairs);

  const { width: vpWidth, documentHeight } = viewport;
  const rawFrames = groupIntoKeyframes(validRects, confirmedHeight, vpWidth, documentHeight);
  const keyframes = prefixKeyframes(rawFrames, sessionId, role);
  log.info(`VDIFF [${role}] keyframes grouped`, { count: keyframes.length });

  const selectorById = new Map(selectorPairs.map((p) => [p.id, p]));
  const documentYById = new Map(validRects.map((r) => [r.id, r.documentY]));

  const { remeasureResults, capturedKeyframes } = await captureAllKeyframes(
    sessionHandle, keyframes, selectorById, sessionId, role, actualDPR, documentHeight, blobCache, comparisonId
  );

  const manifest = buildManifestFromRemeasured(
    keyframes, remeasureResults, documentYById, actualDPR, documentHeight, confirmedHeight
  );

  attachPseudoDataToManifest(manifest, pseudoResults ?? []);

  const rectRecords = buildElementRectRecords(sessionId, role, manifest);
  log.info(`VDIFF [${role}] executeTabCapture COMPLETE`, {
    totalElapsed: ms(t0), manifestSize: manifest.size
  });

  return { manifest, keyframes: capturedKeyframes, rectRecords, devToolsWarning };
}

async function runTabCapture(page, selectorPairs, sessionId, role, blobCache, comparisonId) {
  const t0 = Date.now();
  let sessionHandle = null;
  log.info(`VDIFF [${role}] attach START`);

  try {
    sessionHandle = await attachSession(page);
    log.info(`VDIFF [${role}] attach DONE`, { elapsed: ms(t0) });

    return await executeTabCapture(sessionHandle, selectorPairs, sessionId, role, blobCache, comparisonId);

  } catch (err) {
    const msg = err?.message ?? String(err);
    log.error(`VDIFF [${role}] FAILED`, { error: msg, elapsed: ms(t0) });

    if (msg.includes('already attached') || msg.includes('Target closed') ||
    msg.includes('Page closed')) {
      log.warn(`VDIFF [${role}] debugger conflict — returning null for graceful degradation`);
      return null;
    }
    throw err;

  } finally {
    if (sessionHandle) {
      await safeRestorePage(sessionHandle).catch(() => {});
      await detachSession(sessionHandle);
      log.info(`VDIFF [${role}] detach DONE`);
    }
  }
}

async function captureRoleSequential(page, selectorPairs, sessionId, role, blobCache, comparisonId) {
  if (!page) {
    log.warn(`VDIFF [${role}] page is null — skipping`);
    return { manifest: new Map(), keyframes: [], rectRecords: [], devToolsWarning: null };
  }

  const result = await runTabCapture(page, selectorPairs, sessionId, role, blobCache, comparisonId);
  if (result === null) {
    return { manifest: new Map(), keyframes: [], rectRecords: [], devToolsWarning: null };
  }
  return {
    manifest: result.manifest ?? new Map(),
    keyframes: result.keyframes ?? [],
    rectRecords: result.rectRecords ?? [],
    devToolsWarning: result.devToolsWarning ?? null
  };
}

async function captureVisualDiffs(comparisonResult, pageContext, blobCache, comparisonId) {
  const sessionStart = Date.now();
  log.info('VDIFF captureVisualDiffs ENTER');

  if (!pageContext) {
    return { status: 'skipped', reason: 'No page context', diffs: new Map(),
      keyframes: [], rectRecords: [], devToolsWarnings: [] };
  }

  const modified = extractModifiedElements(comparisonResult);
  if (modified.length === 0) {
    return { status: 'skipped', reason: 'No modified elements', diffs: new Map(),
      keyframes: [], rectRecords: [], devToolsWarnings: [] };
  }

  const sessionId = crypto.randomUUID();
  const baselinePairs = buildSelectorPairs(modified, 'baseline');
  const comparePairs = buildSelectorPairs(modified, 'compare');
  const { baselinePage, comparePage } = pageContext;

  log.info('VDIFF session init', {
    sessionId, baselinePairs: baselinePairs.length, comparePairs: comparePairs.length
  });

  try {
    const baselineResult = await captureRoleSequential(baselinePage, baselinePairs, sessionId, 'baseline', blobCache, comparisonId);
    const compareResult = await captureRoleSequential(comparePage, comparePairs, sessionId, 'compare', blobCache, comparisonId);

    const baselineManifest = baselineResult.manifest;
    const compareManifest = compareResult.manifest;
    const devToolsWarnings = [baselineResult.devToolsWarning, compareResult.devToolsWarning].filter(Boolean);
    const allKeyframes = [...baselineResult.keyframes, ...compareResult.keyframes];
    const allRectRecords = [...baselineResult.rectRecords, ...compareResult.rectRecords];

    if (baselineManifest.size === 0 && compareManifest.size === 0) {
      return {
        status: 'skipped',
        reason: devToolsWarnings.length > 0 ?
        'DevTools bypass ran but produced no screenshots — close DevTools and retry.' :
        'Could not attach debugger to either page.',
        diffs: new Map(), keyframes: [], rectRecords: [], devToolsWarnings
      };
    }

    const diffs = buildDiffMap(modified, baselineManifest, compareManifest);
    log.info('VDIFF captureVisualDiffs COMPLETE', {
      sessionId, diffCount: diffs.size, totalElapsed: ms(sessionStart)
    });

    return {
      status: 'completed', reason: null, diffs, sessionId,
      keyframes: allKeyframes, rectRecords: allRectRecords, devToolsWarnings
    };

  } catch (err) {
    log.error('VDIFF captureVisualDiffs FAILED', { error: err.message });
    return { status: 'failed', reason: err.message, diffs: new Map(),
      keyframes: [], rectRecords: [], devToolsWarnings: [] };
  }
}

function buildSelectorFromFilters(filters) {
  if (!filters) {return null;}
  if (!filters.class?.trim() && !filters.id?.trim() && !filters.tag?.trim()) {return null;}
  const parts = [];
  if (filters.class) {
    const groups = filters.class.trim().split(',').
    map((g) => g.trim().split(/\s+/).filter(Boolean).map((c) => `.${c.replace(/^\./u, '')}`).join('')).
    filter(Boolean);
    if (groups.length) {parts.push(groups.join(','));}
  }
  if (filters.id) {
    const ids = filters.id.trim().split(/\s+/).filter(Boolean).map((id) => `#${id.replace(/^#/u, '')}`);
    if (ids.length) {parts.push(ids.join(','));}
  }
  if (filters.tag) {
    const tags = filters.tag.trim().split(/\s+/).filter(Boolean);
    if (tags.length) {parts.push(tags.join(','));}
  }
  return parts.length > 0 ? parts.join(',') : null;
}

function _cancelErr() {
  return Object.assign(new Error('cancelled'), { code: 'CANCELLED', name: 'CancelledError' });
}

async function runExtraction({ url, browser: browserDescriptor, browserType, filters, onProgress, isCancelled }) {
  const totalStart = Date.now();
  const navigateStart = Date.now();
  const launchTarget = browserDescriptor ?? browserType ?? 'chromium';
  const browser = await getBrowser(launchTarget);
  const context = await browser.newContext({ serviceWorkers: 'block', bypassCSP: true });
  const page = await context.newPage();

  try {
    onProgress?.('Opening page…', 10);

    await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
    if (isCancelled?.()) {throw _cancelErr();}
    onProgress?.('Waiting for content readiness…', 25);

    const compoundSelector = buildSelectorFromFilters(filters);

    let waitSelector = compoundSelector;
    if (compoundSelector && filters?.class) {
      const classes = filters.class.trim().split(/[\s,]+/).filter(Boolean);
      if (classes.length > 1) {
        let bestWaitSel = `.${classes[0].replace(/^\./u, '')}`;
        let bestWaitCount = await page.evaluate(
          (s) => document.querySelectorAll(s).length, bestWaitSel
        );
        for (let i = 1; i < classes.length; i++) {
          const sel = `.${classes[i].replace(/^\./u, '')}`;
          const cnt = await page.evaluate((s) => document.querySelectorAll(s).length, sel);
          if (cnt > bestWaitCount) {bestWaitCount = cnt;bestWaitSel = sel;}
        }
        waitSelector = bestWaitSel;
      }
    }

    if (waitSelector) {
      await page.waitForSelector(waitSelector, { timeout: 30_000, state: 'visible' }).
      catch(() => {});

      await page.waitForFunction(
        (sel) => {
          const count = document.querySelectorAll(sel + ' *').length;
          if (window.__vdiff_prev_desc_count === undefined) {
            window.__vdiff_prev_desc_count = count;
            return false;
          }
          if (window.__vdiff_prev_desc_count !== count) {
            window.__vdiff_prev_desc_count = count;
            return false;
          }
          return count > 0;
        },
        waitSelector,
        { timeout: 30_000, polling: 750 }
      ).catch(() => {});
    } else {
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

      await page.waitForFunction(
        () => document.readyState === 'complete' && document.querySelectorAll('*').length > 100,
        { timeout: 10_000 }
      ).catch(() => {});
    }

    let effectiveSelector = waitSelector;
    if (compoundSelector && waitSelector !== compoundSelector) {
      const compoundCount = await page.evaluate(
        (sel) => document.querySelectorAll(sel).length,
        compoundSelector
      );
      effectiveSelector = compoundCount >= 2 ? compoundSelector : waitSelector;
      log.info('[SELECTOR-DIAG] compound:', compoundCount, 'effective selector:', effectiveSelector);
    } else if (compoundSelector) {
      const compoundCount = await page.evaluate(
        (sel) => document.querySelectorAll(sel).length,
        compoundSelector
      );
      log.info('[SELECTOR-DIAG] compound:', compoundCount, 'effective selector:', effectiveSelector);
    }

    if (isCancelled?.()) {throw _cancelErr();}
    onProgress?.('Extracting elements…', 50);

    const diagData = await page.evaluate((sel) => {
      const containerCount = sel ? document.querySelectorAll(sel).length : 0;
      const descendantCount = sel ? document.querySelectorAll(sel + ' *').length : 0;
      return {
        readyState: document.readyState,
        totalElements: document.querySelectorAll('*').length,
        containerCount,
        descendantCount
      };
    }, effectiveSelector ?? '');
    log.info('[WAIT-DIAG]', diagData);

    _recordPhase('pm.extract.navigate', navigateStart);

    const injectStart = Date.now();
    onProgress?.('Injecting extraction engine…', 52);
    await page.addScriptTag({ content: getExtractorBundleSource() });
    if (isCancelled?.()) {throw _cancelErr();}
    _recordPhase('pm.extract.inject', injectStart);

    const configOverrides = {
      extraction: {
        batchHardCapMs: 30,
        maxElements: 10_000,
        skipInvisible: true,
        stabilityWindowMs: 500,
        hardTimeoutMs: 20_000
      }
    };

    const evaluateStart = Date.now();
    onProgress?.('Extracting elements…', 55);
    if (isCancelled?.()) {throw _cancelErr();}
    const report = await page.evaluate(
      ({ filters: f, cfg }) => window.__uiCompare.extractWithConfig(f, cfg),
      { filters: compoundSelector ? filters : null, cfg: configOverrides }
    );
    _recordPhase('pm.extract.evaluate', evaluateStart);

    try {
      const perfMarks = await page.evaluate(() => JSON.stringify(performance.getEntriesByType('measure')));
      log.debug('[PM] Extraction perf measures', { measures: JSON.parse(perfMarks) });
    } catch {
      void 0;
    }

    log.info('[EXTRACT] element count:', report?.elements?.length ?? 0);

    report.id = crypto.randomUUID();
    report.duration = Math.round(Date.now() - totalStart);
    report.engine = (typeof browserDescriptor === 'object' && browserDescriptor)
      ? (browserDescriptor.browserType ?? 'chromium')
      : (browserType ?? 'chromium');
    report.platform = process.platform;

    onProgress?.('Extraction complete', 100);
    log.info('[PM] runExtraction done', { url, elementCount: report?.totalElements ?? 0 });
    _recordPhase('pm.extract.total', totalStart);
    return report;

  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function _runScreenshotPhase({
  comparisonResult,
  baselineUrl,
  compareUrl,
  blobCache,
  comparisonId,
  send,
  isCancelled,
  browserDescriptor
}) {
  const browser = await getBrowser(browserDescriptor);
  const context = await browser.newContext({ serviceWorkers: 'block', bypassCSP: true });
  let baselinePage, comparePage;
  try {
    [baselinePage, comparePage] = await Promise.all([
    context.newPage(),
    context.newPage()]
    );

    await Promise.all([
    baselinePage.goto(baselineUrl, { waitUntil: 'load', timeout: 60_000 }),
    comparePage.goto(compareUrl, { waitUntil: 'load', timeout: 60_000 })]
    );
    if (isCancelled?.()) {throw _cancelErr();}
    await Promise.all([
    baselinePage.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {}),
    comparePage.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})]
    );

    send('Capturing screenshots…', 87);
    if (isCancelled?.()) {throw _cancelErr();}
    const visualResult = await captureVisualDiffs(
      comparisonResult,
      { baselinePage, comparePage },
      blobCache,
      comparisonId
    );

    if (visualResult.status !== 'completed') {
      log.warn('[PM] Visual capture did not complete', {
        status: visualResult.status, reason: visualResult.reason
      });
      return null;
    }

    const blobs = {};
    for (const keyframe of visualResult.keyframes) {
      const blob = blobCache?.get(`${comparisonId}:${keyframe.id}`);
      if (blob && blob.buffer) {
        blobs[keyframe.id] = {
          buffer: blob.buffer instanceof Uint8Array ? blob.buffer : new Uint8Array(blob.buffer),
          mimeType: blob.mimeType || 'image/webp'
        };
      }
    }
    return {
      sessionId: visualResult.sessionId,
      diffs: Object.fromEntries(visualResult.diffs),
      keyframes: visualResult.keyframes,
      rectRecords: visualResult.rectRecords,
      devToolsWarnings: Array.isArray(visualResult.devToolsWarnings)
        ? [...visualResult.devToolsWarnings]
        : [],
      blobs
    };
  } finally {
    await baselinePage?.close().catch(() => {});
    await comparePage?.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function runComparison({
  baselineId,
  compareId,
  mode,
  baselineUrl,
  compareUrl,
  baselineElements,
  compareElements,
  includeScreenshots,
  browser: browserDescriptor,
  onProgress,
  blobCache,
  isCancelled
}) {
  const totalStart = Date.now();
  log.info('[PM] runComparison start', { baselineId, compareId, mode, baselineCount: baselineElements?.length, compareCount: compareElements?.length });

  const comparisonId = crypto.randomUUID();
  const send = (label, pct) => onProgress?.(label, pct);

  send('Pre-flight checks…', 5);
  const urlResult = assessUrlCompatibility(baselineUrl, compareUrl);
  if (urlResult.classification === 'INCOMPATIBLE') {
    throw Object.assign(new Error('URLs are incompatible for comparison'), {
      name: 'PreFlightError', code: 'INCOMPATIBLE_URLS', compatResult: urlResult
    });
  }

  if (!baselineElements?.length) {
    throw new Error('Baseline elements array is empty — renderer failed to load from IDB');
  }
  if (!compareElements?.length) {
    throw new Error('Compare elements array is empty — renderer failed to load from IDB');
  }

  send('Running comparison…', 20);
  const comparator = new Comparator();
  const generator = comparator.compare(
    { elements: baselineElements, url: baselineUrl, id: baselineId },
    { elements: compareElements, url: compareUrl, id: compareId },
    mode
  );

  const matchStart = Date.now();
  let comparisonResult = null;
  for await (const frame of generator) {
    if (isCancelled?.()) {throw _cancelErr();}
    if (frame.type === 'progress') {
      send(`Matching: ${frame.label}…`, 20 + Math.round(frame.pct / 100 * 55));
    }
    if (frame.type === 'result') {
      comparisonResult = frame.payload;
    }
  }
  _recordPhase('pm.compare.match', matchStart);

  if (!comparisonResult) {
    throw new Error('Comparator returned no result frame');
  }

  send('Comparison complete', 80);

  if (isCancelled?.()) {throw _cancelErr();}

  let visualData = null;
  if (includeScreenshots !== false) {
    if (isCancelled?.()) {throw _cancelErr();}
    const visualStart = Date.now();
    send('Loading pages for screenshots…', 82);

    const screenshotTarget = browserDescriptor ?? { browserType: 'chromium', channel: null, executablePath: null };
    const fallbackWarnings = [];

    try {
      visualData = await _runScreenshotPhase({
        comparisonResult,
        baselineUrl,
        compareUrl,
        blobCache,
        comparisonId,
        send,
        isCancelled,
        browserDescriptor: screenshotTarget
      });
    } catch (screenshotErr) {
      const cancelled = screenshotErr?.code === 'CANCELLED';
      const isWebKit = screenshotTarget?.browserType === 'webkit';
      const isSnapshotFailure = /Page\.snapshotRect|snapshot/i.test(screenshotErr?.message ?? '');
      if (!cancelled && isWebKit && isSnapshotFailure) {
        log.warn('[PM] WebKit screenshot capture failed, falling back to Chromium', { error: screenshotErr.message });
        send('Retrying screenshots on Chromium…', 84);
        visualData = await _runScreenshotPhase({
          comparisonResult,
          baselineUrl,
          compareUrl,
          blobCache,
          comparisonId,
          send,
          isCancelled,
          browserDescriptor: { browserType: 'chromium', channel: null, executablePath: null }
        });
        fallbackWarnings.push({
          kind: 'screenshot-engine-fallback',
          from: 'webkit',
          to: 'chromium',
          reason: screenshotErr.message
        });
      } else {
        throw screenshotErr;
      }
    }

    if (visualData && fallbackWarnings.length > 0) {
      if (!Array.isArray(visualData.devToolsWarnings)) {
        visualData.devToolsWarnings = [];
      }
      visualData.devToolsWarnings.push(...fallbackWarnings);
    }

    _recordPhase('pm.compare.visual', visualStart);
  }

  send('Finalising…', 96);

  const slimResult = {
    comparisonId,
    baselineId,
    compareId,
    mode,
    urlCompatibility: urlResult,
    matching: comparisonResult.matching,
    comparison: comparisonResult.comparison,
    unmatchedElements: comparisonResult.unmatchedElements,
    duration: comparisonResult.duration,
    visualDiffs: visualData?.diffs ?? {},
    visualKeyframes: visualData?.keyframes ?? [],
    visualRectRecords: visualData?.rectRecords ?? [],
    visualBlobs: visualData?.blobs ?? {},
    visualDiffStatus: visualData ? {
      status: 'completed',
      reason: null,
      devToolsWarnings: visualData.devToolsWarnings ?? []
    } : null,
    completedAt: new Date().toISOString()
  };

  send('Done', 100);
  log.info('[PM] runComparison complete', {
    mode, modified: comparisonResult.comparison?.summary?.severityCounts
  });

  _recordPhase('pm.compare.total', totalStart);
  return slimResult;
}

module.exports = {
  runComparison,
  runExtraction,
  shutdownPlaywright,

  attachSession,
  detachSession,
  sendCDP,
  freezePage,
  unfreezePage,
  captureScreenshot,
  executeInPage,
  recoverFrozenSessions,

  getBrowser,
  getPerformanceSnapshot
};