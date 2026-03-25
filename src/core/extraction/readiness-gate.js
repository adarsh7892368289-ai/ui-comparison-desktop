/**
 * Waits for the page to reach a visually stable state before extraction begins.
 * Uses a MutationObserver to detect layout-affecting mutations and a hard timeout
 * as a safety net, resolving with a capture quality rating.
 *
 * Execution context: content script.
 * Invariant: the promise always resolves — never rejects — so the extraction pipeline
 * never stalls. The resolved quality value (OPTIMAL / STABLE / DEGRADED) is recorded
 * in the extraction output for downstream confidence scoring.
 *
 * Direct callers: extractor.js
 */

import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';

/** Possible capture quality levels reported after the readiness gate resolves. */
const CAPTURE_QUALITY = Object.freeze({
  OPTIMAL:  'OPTIMAL',   // No visual mutations observed; page settled cleanly.
  STABLE:   'STABLE',    // Visual mutations occurred but stabilised within the window.
  DEGRADED: 'DEGRADED'   // Hard timeout fired before the page stabilised.
});

/** CSS selector matching common skeleton/loading UI patterns that indicate incomplete renders. */
const SKELETON_CSS =
  '[class*="skeleton"],[class*="shimmer"],[class*="placeholder"],[class*="loading"],[class*="spinner"]';

/**
 * Custom element tag prefixes that indicate analytics or third-party noise components.
 * Mutations on these tags are classified as noise and do not reset the stability timer.
 */
const NOISE_TAG_PREFIXES = Object.freeze([
  'atomic-', 'coveo-', 'dyn-', 'gtm-', 'analytics-', 'beacon-'
]);

/**
 * Attribute names whose changes are analytics/tracking side effects and not visual mutations.
 * Mutations on these attributes are also watched so they can be explicitly discarded.
 */
const NOISE_ATTR_NAMES = Object.freeze([
  'data-analytics', 'data-tracking', 'data-gtm', 'data-layer', 'aria-live'
]);

/**
 * Class name fragments that identify analytics or tracking elements when applied
 * to generic host tags (e.g. `<div class="analytics-beacon">`).
 */
const NOISE_CLASS_FRAGMENTS = Object.freeze([
  'analytics', 'tracking', 'beacon', 'telemetry', 'coveo', 'atomic'
]);

/**
 * Returns true if the tag name belongs to a known analytics/noise custom element.
 *
 * @param {string} tagName - Raw element tag name (case-insensitive).
 * @returns {boolean}
 */
function isNoiseTag(tagName) {
  const lower = tagName.toLowerCase();
  return NOISE_TAG_PREFIXES.some(prefix => lower.startsWith(prefix));
}

/**
 * Returns true if the mutation record is an attribute change on a known analytics attribute.
 *
 * @param {MutationRecord} record - Mutation record from MutationObserver callback.
 * @returns {boolean}
 */
function isNoiseAttrMutation(record) {
  return record.type === 'attributes' &&
    NOISE_ATTR_NAMES.some(attr => record.attributeName === attr);
}

/**
 * Returns true if the mutation is a `class` attribute change on an element whose
 * current class value contains a known analytics fragment.
 *
 * @param {MutationRecord} record - Mutation record from MutationObserver callback.
 * @returns {boolean}
 */
function isNoiseClassMutation(record) {
  if (record.type !== 'attributes' || record.attributeName !== 'class') {
    return false;
  }
  const { target } = record;
  const cls = target instanceof Element ? (target.getAttribute('class') ?? '').toLowerCase() : '';
  return NOISE_CLASS_FRAGMENTS.some(frag => cls.includes(frag));
}

/**
 * Returns true when an element has zero layout area — used to exclude off-screen
 * mutations that would never affect a visible extraction.
 *
 * @param {Node} el - Node to test.
 * @returns {boolean}
 */
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

/**
 * Classifies a single MutationRecord as `'noise'` or `'visual'`.
 * A record is noise if its target is an analytics tag, an analytics attribute changed,
 * the target is offscreen, or all affected childList nodes are noise/offscreen.
 *
 * @param {MutationRecord} record - Mutation record to classify.
 * @returns {'noise'|'visual'}
 */
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

/**
 * Returns true when at least one record in the batch is classified as a visual mutation.
 * Drives whether the stability timer should be reset.
 *
 * @param {MutationRecord[]} records - Batch of mutation records from the observer callback.
 * @returns {boolean}
 */
function hasVisualMutations(records) {
  return records.some(r => classifyMutation(r) === 'visual');
}

/**
 * Returns true when any in-viewport `<img>` has not yet finished loading.
 * Images outside the viewport are skipped because they do not affect the visible extraction.
 *
 * @returns {boolean}
 */
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

/**
 * Returns true when a known skeleton/loading placeholder element exists in the DOM,
 * indicating that content is still being server-rendered or lazily fetched.
 *
 * @returns {boolean}
 */
function hasSkeletonElements() {
  return document.querySelector(SKELETON_CSS) !== null;
}

/**
 * Returns true when the document has no pending image loads and no skeleton elements.
 *
 * @returns {boolean}
 */
function isDocumentReady() {
  return !hasUnloadedImages() && !hasSkeletonElements();
}

/**
 * Resolves when the page is visually stable or when the hard timeout fires.
 * The stability window resets on every visual mutation batch; noise-only batches
 * are counted but do not reset the timer.
 *
 * @returns {Promise<'OPTIMAL'|'STABLE'|'DEGRADED'>} Capture quality label.
 */
function waitForReadiness() {
  return new Promise(resolve => {
    const stabilityWindowMs = get('extraction.stabilityWindowMs');
    const hardTimeoutMs     = get('extraction.hardTimeoutMs');

    let stabilityTimer = null;
    let hardTimer      = null;
    let observer       = null;
    let noiseOnlyCount = 0;

    /** Tears down all timers and the observer once the gate resolves. */
    function cleanup() {
      clearTimeout(hardTimer);
      clearTimeout(stabilityTimer);
      if (observer) {
        observer.disconnect();
      }
    }

    /** Resolves the outer promise with the given quality and cleans up. */
    function settle(quality) {
      cleanup();
      resolve(quality);
    }

    /** Checks content readiness and settles if the document is ready. */
    function checkAndSettle() {
      if (!isDocumentReady()) {
        return;
      }
      const quality = noiseOnlyCount === 0 ? CAPTURE_QUALITY.OPTIMAL : CAPTURE_QUALITY.STABLE;
      logger.debug('Readiness gate cleared', { quality, noiseMutations: noiseOnlyCount });
      settle(quality);
    }

    /** Called by MutationObserver; resets the stability timer only on visual mutations. */
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
      // Watching only known noise attrs + 'class' limits the observer's callback rate
      // on analytics-heavy pages that fire hundreds of data-layer mutations per second.
      attributeFilter: [...NOISE_ATTR_NAMES, 'class'],
      characterData:   false
    });

    stabilityTimer = setTimeout(checkAndSettle, stabilityWindowMs);
  });
}

export { waitForReadiness };