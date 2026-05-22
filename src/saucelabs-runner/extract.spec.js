'use strict';

const { test, devices } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { groupIntoKeyframes } = require('./keyframe-grouper');
const { validateJobConfig } = require('./schemas');

const JOB_CONFIG_PATH = path.join(__dirname, 'job.json');
const EXTRACTOR_BUNDLE_PATH = path.join(__dirname, 'extractor-bundle.js');

const REMEASURE_DEADLINE_MS = 30_000;

const PSEUDO_PROPS = [
  'content', 'display', 'width', 'height', 'background-color', 'color',
  'font-size', 'font-family', 'position', 'top', 'left', 'right', 'bottom',
  'transform', 'opacity', 'border', 'padding', 'margin', 'box-shadow',
  'border-radius', 'z-index', 'visibility'
];

function loadJobConfig() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(JOB_CONFIG_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to load SauceLabs job config from ${JOB_CONFIG_PATH}: ${err.message}`);
  }
  validateJobConfig(parsed, JOB_CONFIG_PATH);
  return parsed;
}

function loadExtractorBundle() {
  try {
    return fs.readFileSync(EXTRACTOR_BUNDLE_PATH, 'utf8');
  } catch (err) {
    throw new Error(`Failed to load extractor bundle from ${EXTRACTOR_BUNDLE_PATH}: ${err.message}`);
  }
}

function buildSelectorFromFilters(filters) {
  if (!filters) return null;
  const parts = [];
  if (filters.class) {
    const groups = filters.class.trim()
      .split(/[\s,]+/).filter(Boolean)
      .map((g) => g.trim().split(/\s+/).filter(Boolean)
        .map((c) => '.' + c.replace(/^\./, '')).join(''))
      .filter(Boolean);
    if (groups.length) parts.push(groups.join(','));
  }
  if (filters.id) {
    const ids = filters.id.trim().split(/\s+/).filter(Boolean)
      .map((id) => '#' + id.replace(/^#/, ''));
    if (ids.length) parts.push(ids.join(','));
  }
  if (filters.tag) {
    const tags = filters.tag.trim().split(/\s+/).filter(Boolean);
    if (tags.length) parts.push(tags.join(','));
  }
  return parts.length > 0 ? parts.join(',') : null;
}

function writeArtifact(testInfo, name, body) {
  const outPath = path.join(testInfo.outputDir, name);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, body);
}

function inPageRemeasureRects(pairs) {
  const actualScrollY = Math.round(window.scrollY);
  const vpH = window.innerHeight;
  const vpW = window.innerWidth;
  const rects = pairs.map(({ id, selector }) => {
    const el = selector ? document.querySelector(selector) : null;
    if (!el) {
      return { id, found: false, inViewport: false, misalignReason: 'element-not-found' };
    }
    const matchCount = selector ? document.querySelectorAll(selector).length : 1;
    const r = el.getBoundingClientRect();
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    if (w === 0 && h === 0) {
      return {
        id, found: true, inViewport: false, misalignReason: 'zero-dimension',
        selectorAmbiguous: matchCount > 1, selectorMatchCount: matchCount,
        viewportX: Math.round(r.left), viewportY: Math.round(r.top),
        width: 0, height: 0
      };
    }
    const inViewport = r.bottom > 0 && r.top < vpH && r.right > 0 && r.left < vpW;
    return {
      id, found: true, inViewport,
      misalignReason: inViewport ? null : 'out-of-viewport',
      selectorAmbiguous: matchCount > 1, selectorMatchCount: matchCount,
      viewportX: Math.round(r.left), viewportY: Math.round(r.top),
      width: w, height: h
    };
  });
  return { actualScrollY, rects };
}

function inPageGetPseudoStyles(pairs, props) {
  const collect = (el, pseudo) => {
    const cs = window.getComputedStyle(el, pseudo);
    const content = cs.getPropertyValue('content');
    if (!content || content === 'none' || content === 'normal' ||
        content === '""' || content === "''") return null;
    const styles = Object.create(null);
    for (const p of props) {
      styles[p] = cs.getPropertyValue(p);
    }
    return styles;
  };
  return pairs.map(({ id, selector }) => {
    const el = selector ? document.querySelector(selector) : null;
    if (!el) return { id, before: null, after: null };
    return {
      id,
      before: collect(el, '::before'),
      after: collect(el, '::after')
    };
  });
}

const job = loadJobConfig();
const EXTRACTOR_BUNDLE = loadExtractorBundle();

test.setTimeout(job.testTimeoutMs ?? 600_000);

if (job.device && job.device.name) {
  const descriptor = devices[job.device.name];
  if (descriptor) {
    test.use(descriptor);
  } else {
    // eslint-disable-next-line no-console
    console.warn(`[saucelabs-runner] Unknown Playwright device "${job.device.name}" — running with default desktop context.`);
  }
}

test('extract', async ({ page }, testInfo) => {
  await page.goto(job.url, { waitUntil: 'load', timeout: 60_000 });

  const compoundSelector = buildSelectorFromFilters(job.filters);
  const waitSelector = compoundSelector;

  if (waitSelector) {
    await page.waitForSelector(waitSelector, { timeout: 30_000, state: 'visible' }).catch(() => {});
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

  await page.addScriptTag({ content: EXTRACTOR_BUNDLE });

  const report = await page.evaluate(
    ({ filters, cfg }) => window.__uiCompare.extractWithConfig(filters, cfg),
    { filters: compoundSelector ? job.filters : null, cfg: job.configOverrides ?? {} }
  );

  writeArtifact(testInfo, 'extraction-result.json', JSON.stringify(report));

  const elements = report.elements || [];
  if (elements.length === 0) {
    writeArtifact(testInfo, 'screenshots-manifest.json',
      JSON.stringify({ keyframes: [], elementKeyframeMap: {} }));
    return;
  }

  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    documentHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
  }));

  const selectorPairs = elements
    .filter((el) => el.cssSelector)
    .map((el) => ({ id: el.hpid, selector: el.cssSelector }));

  const initialRects = await page.evaluate((pairs) => {
    return pairs.map((p) => {
      const els = document.querySelectorAll(p.selector);
      if (els.length === 0) return { id: p.id, found: false };
      const el = els[0];
      const rect = el.getBoundingClientRect();
      const scrollY = window.scrollY;
      return {
        id: p.id,
        found: true,
        usable: rect.width > 0 && rect.height > 0,
        documentY: rect.top + scrollY,
        height: rect.height,
        width: rect.width,
        viewportX: rect.left,
        viewportY: rect.top
      };
    });
  }, selectorPairs);

  const validRects = initialRects.filter((r) => r.found && r.usable);
  if (validRects.length === 0) {
    writeArtifact(testInfo, 'screenshots-manifest.json',
      JSON.stringify({ keyframes: [], elementKeyframeMap: {} }));
    return;
  }

  let keyframes = groupIntoKeyframes(validRects, viewport.height, viewport.width, viewport.documentHeight);

  const maxKeyframes = job.maxScreenshots ?? 200;
  if (keyframes.length > maxKeyframes) {
    keyframes.sort((a, b) => b.elementIds.length - a.elementIds.length);
    keyframes = keyframes.slice(0, maxKeyframes);
    keyframes.sort((a, b) => a.scrollY - b.scrollY);
    for (let i = 0; i < keyframes.length; i++) {
      keyframes[i].id = 'kf_' + i;
    }
  }

  const elementKeyframeMap = {};
  for (const kf of keyframes) {
    for (const elId of kf.elementIds) {
      elementKeyframeMap[elId] = kf.id;
    }
  }

  const freezeStyle = '*, *::before, *::after { animation-play-state: paused !important; transition-duration: 0s !important; scroll-behavior: auto !important; }';
  await page.evaluate((css) => {
    const style = document.createElement('style');
    style.id = 'vdiff-freeze-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }, freezeStyle);

  const documentYById = {};
  for (const r of validRects) {
    documentYById[r.id] = Math.round(r.documentY);
  }

  const actualDPR = await page.evaluate(() => window.devicePixelRatio || 1);

  const remeasureDeadline = Date.now() + REMEASURE_DEADLINE_MS;
  const keyframeMeasurements = [];

  for (let i = 0; i < keyframes.length; i++) {
    const kf = keyframes[i];
    await page.evaluate((y) => window.scrollTo(0, y), kf.scrollY);
    await page.waitForTimeout(300);

    const kfPairs = selectorPairs.filter((p) => kf.elementIds.indexOf(p.id) !== -1);
    let remeasure = null;
    let pseudoStyles = null;

    if (Date.now() < remeasureDeadline) {
      try {
        remeasure = await page.evaluate(inPageRemeasureRects, kfPairs);
      } catch {
        remeasure = null;
      }
      try {
        pseudoStyles = await page.evaluate(inPageGetPseudoStyles, kfPairs, PSEUDO_PROPS);
      } catch {
        pseudoStyles = null;
      }
    }

    const screenshot = await page.screenshot({ type: 'jpeg', quality: 85, fullPage: false });
    writeArtifact(testInfo, 'keyframe-' + i + '.jpg', screenshot);

    keyframeMeasurements.push({
      keyframeId: kf.id,
      actualScrollY: remeasure ? remeasure.actualScrollY : kf.scrollY,
      rects: remeasure ? remeasure.rects : [],
      pseudoStyles: pseudoStyles || []
    });
  }

  const manifest = {
    keyframes: keyframes.map((kf, i) => ({
      id: kf.id,
      scrollY: kf.scrollY,
      viewportWidth: kf.viewportWidth,
      viewportHeight: kf.viewportHeight,
      elementIds: kf.elementIds,
      filename: 'keyframe-' + i + '.jpg'
    })),
    elementKeyframeMap,
    documentYById,
    documentHeight: viewport.documentHeight,
    viewportHeight: viewport.height,
    actualDPR,
    keyframeMeasurements
  };
  writeArtifact(testInfo, 'screenshots-manifest.json', JSON.stringify(manifest));
});
