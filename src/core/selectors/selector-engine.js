import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';
import { generateCSS } from './css/generator.js';
import { generateXPath } from './xpath/generator.js';
const SHADOW_TEST_ATTRS = Object.freeze([
  'data-testid', 'data-test', 'data-qa', 'data-cy', 'data-automation-id'
]);

class BoundedQueue {
  #concurrency;
  #queue;
  #active;
  constructor(concurrency) {
    this.#concurrency = concurrency;
    this.#queue       = [];
    this.#active      = 0;
  }

  enqueue(task) {
    return new Promise((resolve, reject) => {
      this.#queue.push({ task, resolve, reject });
      this.#drain();
    });
  }

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

  get size() {
    return this.#queue.length;
  }

  get activeCount() {
    return this.#active;
  }

  get pendingCount() {
    return this.#queue.length + this.#active;
  }
}

const NULL_SELECTORS = Object.freeze({
  xpath:           null,
  css:             null,
  shadowPath:      null,
  xpathConfidence: 0,
  cssConfidence:   0,
  xpathStrategy:   null,
  cssStrategy:     null
});

function buildHostSelector(host) {
  for (const attr of SHADOW_TEST_ATTRS) {
    const val = host.getAttribute(attr);
    if (val) {
      return `[${attr}="${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
    }
  }

  if (host.id) {
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(host.id) : host.id;
    return `#${escaped}`;
  }

  return host.tagName.toLowerCase();
}

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