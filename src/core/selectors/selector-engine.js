/**
 * Orchestrates CSS and XPath selector generation for DOM elements, with concurrency control
 * and a per-element total timeout to keep extraction from stalling on complex DOMs.
 * Runs in the content-script context.
 * Invariant: always resolves — never rejects. Failed elements receive NULL_SELECTORS.
 * Called by: extractor.js batch selector pass.
 */
import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';
import { generateCSS } from './css/generator.js';
import { generateXPath } from './xpath/generator.js';

// Test-attribute names checked in priority order when building shadow-host selectors.
const SHADOW_TEST_ATTRS = Object.freeze([
  'data-testid', 'data-test', 'data-qa', 'data-cy', 'data-automation-id'
]);

/**
 * Fixed-width async concurrency limiter — allows at most `concurrency` tasks to run
 * simultaneously, queuing the rest until a slot opens.
 * Does NOT own task cancellation; callers must handle their own timeouts.
 */
class BoundedQueue {
  /** @type {number} */ #concurrency;
  /** @type {Array<{task: Function, resolve: Function, reject: Function}>} */ #queue;
  /** @type {number} */ #active;

  /** @param {number} concurrency - Maximum simultaneous in-flight tasks. */
  constructor(concurrency) {
    this.#concurrency = concurrency;
    this.#queue       = [];
    this.#active      = 0;
  }

  /**
   * Schedules `task` for execution and returns a promise that settles when the task completes.
   * @param {() => Promise<*>} task - Must not catch its own errors.
   * @returns {Promise<*>}
   */
  enqueue(task) {
    return new Promise((resolve, reject) => {
      this.#queue.push({ task, resolve, reject });
      this.#drain();
    });
  }

  /** Starts queued tasks until the concurrency ceiling is reached. */
  #drain() {
    while (this.#active < this.#concurrency && this.#queue.length > 0) {
      const entry = this.#queue.shift();
      this.#active++;
      Promise.resolve()
        .then(() => entry.task())
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.#active--;
          this.#drain();
        });
    }
  }

  /** Number of tasks waiting to start (excludes active tasks). */
  get size() {
    return this.#queue.length;
  }

  /** Number of tasks currently executing. */
  get activeCount() {
    return this.#active;
  }

  /** Total tasks not yet finished (queued + active). */
  get pendingCount() {
    return this.#queue.length + this.#active;
  }
}

// Returned verbatim when an element is invalid or all generators time out.
const NULL_SELECTORS = Object.freeze({
  xpath:           null,
  css:             null,
  shadowPath:      null,
  xpathConfidence: 0,
  cssConfidence:   0,
  xpathStrategy:   null,
  cssStrategy:     null
});

/**
 * Produces the best available CSS selector for a shadow-DOM host element.
 * Prefers test attributes over ID over tag name — test attributes are the most stable
 * across builds; tag name is the least stable and used only as a last resort.
 *
 * @param {Element} host - The shadow-host element.
 * @returns {string} A CSS selector string identifying the host.
 */
function buildHostSelector(host) {
  for (const attr of SHADOW_TEST_ATTRS) {
    const val = host.getAttribute(attr);
    if (val) {
      return `[${attr}="${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
    }
  }

  if (host.id) {
    // CSS.escape handles IDs that start with digits or contain special characters.
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(host.id) : host.id;
    return `#${escaped}`;
  }

  return host.tagName.toLowerCase();
}

/**
 * Walks up through nested shadow roots and records the host selector at each boundary.
 * Returns null when the element is not inside any shadow DOM.
 *
 * @param {Element} element
 * @returns {string[]|null} Ordered array of host selectors from outermost to innermost, or null.
 */
function buildShadowPath(element) {
  if (typeof ShadowRoot === 'undefined') {
    return null;
  }

  const hostSelectors = [];
  let current         = element;

  while (current) {
    const root = current.getRootNode({ composed: false });
    if (!(root instanceof ShadowRoot)) {
      break;
    }
    hostSelectors.unshift(buildHostSelector(root.host));
    current = root.host;
  }

  return hostSelectors.length > 0 ? hostSelectors : null;
}

/**
 * Merges XPath and CSS generator results with the shadow path into a single selector record.
 * Null-safe: missing generator output produces null fields with 0 confidence.
 *
 * @param {object|null} xpathResult
 * @param {object|null} cssResult
 * @param {string[]|null} shadowPath
 * @returns {object} Selector record matching the NULL_SELECTORS shape.
 */
function assembleSelectors(xpathResult, cssResult, shadowPath) {
  return {
    xpath:           xpathResult?.xpath ?? null,
    css:             cssResult?.css ?? null,
    shadowPath,
    xpathConfidence: xpathResult?.confidence ?? 0,
    cssConfidence:   cssResult?.confidence ?? 0,
    xpathStrategy:   xpathResult?.strategy ?? null,
    cssStrategy:     cssResult?.strategy ?? null
  };
}

/**
 * Generates CSS and XPath selectors for a single element, racing both generators against
 * a configurable total timeout. Runs them in parallel or sequentially per config.
 *
 * @param {Element} element
 * @returns {Promise<object>} Always resolves to a selector record; never rejects.
 */
async function generateSelectors(element) {
  if (!element || !element.tagName) {
    logger.debug('Invalid element for selector generation');
    return { ...NULL_SELECTORS };
  }

  const doCSS     = get('selectors.generateCSS',   true);
  const doXPath   = get('selectors.generateXPath',  true);
  const total     = get('selectors.totalTimeout',   600);
  const shadowPath = buildShadowPath(element);
  const parallel   = get('selectors.xpath.parallelExecution', true) &&
                     get('selectors.css.parallelExecution',   true);

  // Resolves to null after `total` ms — used to cap stuck generators.
  const raceTimeout = new Promise(resolve => {
    setTimeout(() => resolve(null), total);
  });

  const cssWork   = doCSS   ? generateCSS(element)   : Promise.resolve(null);
  const xpathWork = doXPath ? generateXPath(element) : Promise.resolve(null);

  const work = parallel
    ? Promise.allSettled([xpathWork, cssWork]).then(
      ([xpathOutcome, cssOutcome]) => assembleSelectors(
        xpathOutcome.status === 'fulfilled' ? xpathOutcome.value : null,
        cssOutcome.status   === 'fulfilled' ? cssOutcome.value   : null,
        shadowPath
      )
    )
    : xpathWork.then(x => cssWork.then(c => assembleSelectors(x, c, shadowPath)));

  const result = await Promise.race([work, raceTimeout]);
  return result ?? { ...NULL_SELECTORS, shadowPath };
}

/**
 * Generates selectors for a batch of elements under a shared concurrency limit.
 * Results array index matches input array index; failed elements get NULL_SELECTORS.
 *
 * @param {Element[]} elements
 * @returns {Promise<object[]>} Selector records in the same order as `elements`.
 */
async function generateSelectorsForElements(elements) {
  const concurrency = get('selectors.concurrency', 4);
  const queue       = new BoundedQueue(concurrency);
  const results     = new Array(elements.length);

  const promises = elements.map((element, i) =>
    queue.enqueue(() => generateSelectors(element))
      .then(selectors => { results[i] = selectors; })
      .catch(error => {
        logger.error('Selector generation failed', { tagName: element.tagName, error: error.message });
        results[i] = { ...NULL_SELECTORS };
      })
  );

  await Promise.all(promises);
  return results;
}

export { generateSelectors, generateSelectorsForElements, BoundedQueue };