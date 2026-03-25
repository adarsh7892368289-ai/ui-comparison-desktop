import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';

const CAPTURE_QUALITY = Object.freeze({
  OPTIMAL:  'OPTIMAL',
  STABLE:   'STABLE',
  DEGRADED: 'DEGRADED'
});
const SKELETON_CSS =
  '[class*="skeleton"],[class*="shimmer"],[class*="placeholder"],[class*="loading"],[class*="spinner"]';
const NOISE_TAG_PREFIXES = Object.freeze([
  'atomic-', 'coveo-', 'dyn-', 'gtm-', 'analytics-', 'beacon-'
]);
const NOISE_ATTR_NAMES = Object.freeze([
  'data-analytics', 'data-tracking', 'data-gtm', 'data-layer', 'aria-live'
]);
const NOISE_CLASS_FRAGMENTS = Object.freeze([
  'analytics', 'tracking', 'beacon', 'telemetry', 'coveo', 'atomic'
]);
function isNoiseTag(tagName) {
  const lower = tagName.toLowerCase();
  return NOISE_TAG_PREFIXES.some(prefix => lower.startsWith(prefix));
}

function isNoiseAttrMutation(record) {
  return record.type === 'attributes' &&
    NOISE_ATTR_NAMES.some(attr => record.attributeName === attr);
}

function isNoiseClassMutation(record) {
  if (record.type !== 'attributes' || record.attributeName !== 'class') {
    return false;
  }
  const { target } = record;
  const cls = target instanceof Element ? (target.getAttribute('class') ?? '').toLowerCase() : '';
  return NOISE_CLASS_FRAGMENTS.some(frag => cls.includes(frag));
}

function isOffscreenElement(el) {
  if (!(el instanceof Element)) {
    return false;
  }
  try {
    const rect = el.getBoundingClientRect();
    return rect.width === 0 && rect.height === 0;
  } catch {
    return false;
  }
}

function classifyMutation(record) {
  const { target } = record;
  const tagName = target instanceof Element ? target.tagName : '';

  if (isNoiseTag(tagName)) {
    return 'noise';
  }
  if (isNoiseAttrMutation(record)) {
    return 'noise';
  }
  if (isNoiseClassMutation(record)) {
    return 'noise';
  }
  if (isOffscreenElement(target)) {
    return 'noise';
  }
  if (record.type === 'childList') {
    const allNoise = [...record.addedNodes, ...record.removedNodes].every(node => {
      if (!(node instanceof Element)) {
        return true;
      }
      return isNoiseTag(node.tagName) || isOffscreenElement(node);
    });
    if (allNoise) {
      return 'noise';
    }
  }
  return 'visual';
}

function hasVisualMutations(records) {
  return records.some(r => classifyMutation(r) === 'visual');
}

function hasUnloadedImages() {
  const vH = window.innerHeight;
  const vW = window.innerWidth;
  for (const img of document.querySelectorAll('img')) {
    if (img.complete) {continue;}
    const r = img.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {continue;}
    if (r.bottom < 0 || r.top > vH || r.right < 0 || r.left > vW) {continue;}
    return true;
  }
  return false;
}

function hasSkeletonElements() {
  return document.querySelector(SKELETON_CSS) !== null;
}

function isDocumentReady() {
  return !hasUnloadedImages() && !hasSkeletonElements();
}

function waitForReadiness() {
  return new Promise(resolve => {
    const stabilityWindowMs = get('extraction.stabilityWindowMs');
    const hardTimeoutMs     = get('extraction.hardTimeoutMs');

    let stabilityTimer = null;
    let hardTimer      = null;
    let observer       = null;
    let noiseOnlyCount = 0;

    function cleanup() {
      clearTimeout(hardTimer);
      clearTimeout(stabilityTimer);
      if (observer) {
        observer.disconnect();
      }
    }

    function settle(quality) {
      cleanup();
      resolve(quality);
    }

    function checkAndSettle() {
      if (!isDocumentReady()) {
        return;
      }
      const quality = noiseOnlyCount === 0 ? CAPTURE_QUALITY.OPTIMAL : CAPTURE_QUALITY.STABLE;
      logger.debug('Readiness gate cleared', { quality, noiseMutations: noiseOnlyCount });
      settle(quality);
    }

    function onMutations(records) {
      if (!hasVisualMutations(records)) {
        noiseOnlyCount += records.length;
        return;
      }
      clearTimeout(stabilityTimer);
      stabilityTimer = setTimeout(checkAndSettle, stabilityWindowMs);
    }

    hardTimer = setTimeout(() => {
      logger.debug('Readiness gate hard timeout', { quality: CAPTURE_QUALITY.DEGRADED, noiseMutations: noiseOnlyCount });
      settle(CAPTURE_QUALITY.DEGRADED);
    }, hardTimeoutMs);

    observer = new MutationObserver(onMutations);

    observer.observe(document.documentElement, {
      childList:       true,
      subtree:         true,
      attributes:      true,
      attributeFilter: [...NOISE_ATTR_NAMES, 'class'],
      characterData:   false
    });

    stabilityTimer = setTimeout(checkAndSettle, stabilityWindowMs);
  });
}

export { waitForReadiness };