/**
 * Orchestrates the full element extraction pipeline: traversal → style/geometry pass →
 * visibility filter → record assembly → selector generation → output packaging.
 *
 * Execution context: content script.
 * Invariant: DOM references (Element objects) are nulled out immediately after each record
 * is built to prevent the content-script heap from ballooning while awaiting selector generation.
 *
 * Direct callers: content.js (via chrome.runtime message handler)
 */

import { get }                                  from '../../config/defaults.js';
import logger                                   from '../../infrastructure/logger.js';
import { performanceMonitor }                   from '../../infrastructure/performance-monitor.js';
import { collectAttributes }                    from './attribute-collector.js';
import { serializeHpid, traverseDocument }      from './dom-traversal.js';
import { classifyTier, isTierZero, isVisible }  from './element-classifier.js';
import { waitForReadiness }                     from './readiness-gate.js';
import { collectStylesFromComputed }            from './style-collector.js';
import { generateSelectorsForElements }         from '../selectors/selector-engine.js';
import { detectElementSection }                 from './section-detector.js';
import { getNeighbours, getClassHierarchy }     from './dom-enrichment.js';

import { yieldToEventLoop } from '../comparison/async-utils.js';

/**
 * Reads geometry and computed styles for every visit in one synchronous sweep.
 * Batching all `getBoundingClientRect` and `getComputedStyle` calls together minimises
 * forced layout reflows — interleaving them with DOM writes would trigger one reflow per element.
 *
 * @param {Array<{ element: Element }>} visits - Ordered traversal records from dom-traversal.
 * @returns {Array<{ rect: DOMRect, computedStyle: CSSStyleDeclaration|null, isConnected: boolean, scrollX: number, scrollY: number }>}
 *   Parallel array to `visits`; disconnected elements get a zeroed rect and null style.
 */
function executePass1(visits) {
  performance.mark('pass1-start');

  const scrollX  = window.scrollX;
  const scrollY  = window.scrollY;
  const readings = new Array(visits.length);

  for (let i = 0; i < visits.length; i++) {
    const { element } = visits[i];
    try {
      readings[i] = {
        rect:          element.getBoundingClientRect(),
        computedStyle: window.getComputedStyle(element),
        isConnected:   element.isConnected,
        scrollX,
        scrollY
      };
    } catch {
      readings[i] = {
        rect:          { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0 },
        computedStyle: null,
        isConnected:   false,
        scrollX,
        scrollY
      };
    }
  }

  performance.mark('pass1-end');
  performance.measure('extraction-pass1', 'pass1-start', 'pass1-end');
  return readings;
}

/**
 * Drops disconnected and invisible elements from the visit/reading parallel arrays.
 * Skipped when `extraction.skipInvisible` is false so comparison can include off-screen elements.
 *
 * @param {object[]} visits - Traversal records.
 * @param {object[]} readings - Parallel geometry/style readings from executePass1.
 * @returns {{ filteredVisits: object[], filteredReadings: object[] }} Paired filtered arrays.
 */
function applyVisibilityFilter(visits, readings) {
  if (!get('extraction.skipInvisible')) {
    return { filteredVisits: visits, filteredReadings: readings };
  }

  const filteredVisits   = [];
  const filteredReadings = [];

  for (let i = 0; i < visits.length; i++) {
    if (!readings[i].isConnected || isTierZero(visits[i].element)) {continue;}
    if (isVisible(readings[i].computedStyle, readings[i].rect)) {
      filteredVisits.push(visits[i]);
      filteredReadings.push(readings[i]);
    }
  }

  return { filteredVisits, filteredReadings };
}

/**
 * Converts a DOMRect to a scroll-adjusted, rounded absolute bounding box.
 * DOMRect coordinates are viewport-relative; adding scroll offsets makes them page-absolute
 * so cross-capture comparisons are stable regardless of scroll position.
 *
 * @param {DOMRect|null} rect - Raw bounding rect.
 * @param {number} scrollX - Horizontal scroll offset at time of capture.
 * @param {number} scrollY - Vertical scroll offset at time of capture.
 * @returns {{ x, y, width, height, top, left }|null} Page-absolute rounded rect, or null.
 */
function buildBoundingRect(rect, scrollX, scrollY) {
  if (!rect) {return null;}
  return {
    x:      Math.round(rect.x      + scrollX),
    y:      Math.round(rect.y      + scrollY),
    width:  Math.round(rect.width),
    height: Math.round(rect.height),
    top:    Math.round(rect.top    + scrollY),
    left:   Math.round(rect.left   + scrollX)
  };
}

/**
 * Extracts direct text-node content only (not descendant element text) and truncates
 * to `maxLength`. Returns null for purely structural elements with no direct text.
 *
 * @param {Element} element - Target element.
 * @param {number} maxLength - Maximum characters before truncation with ellipsis.
 * @returns {string|null} Trimmed direct text content, or null if empty.
 */
function getTextContent(element, maxLength) {
  let text = '';
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent;
    }
  }
  text = text.trim();
  if (text.length === 0) {return null;}
  return text.length > maxLength ? `${text.substring(0, maxLength)}...` : text;
}

/**
 * Returns the element's class string, handling SVG elements where `className` is an SVGAnimatedString.
 *
 * @param {Element} element - Target element.
 * @returns {string|null} Space-separated class string, or null if no classes are present.
 */
function getClassName(element) {
  if (!element.className) {return null;}
  if (typeof element.className === 'string') {return element.className || null;}
  return element.className.baseVal || null;
}

/**
 * Counts how many elements in the visit set share the same sorted class-name signature.
 * Used downstream to flag high-occurrence class groups that are likely list items — helping
 * the matcher handle dynamic list reordering.
 *
 * @param {Array<{ element: Element }>} visits - All filtered visit records.
 * @returns {Map<string, number>} Map of sorted-class-key → occurrence count.
 */
function buildClassOccurrenceMap(visits) {
  const counts = new Map();
  for (const { element } of visits) {
    const raw = getClassName(element) ?? '';
    const key = raw.split(/\s+/).filter(Boolean).sort().join(' ');
    if (key) {counts.set(key, (counts.get(key) || 0) + 1);}
  }
  return counts;
}

/**
 * Looks up the occurrence count for a single element's sorted class key.
 * Returns 0 for classless elements (signals "not a list item").
 *
 * @param {Element} element - Target element.
 * @param {Map<string, number>} classOccurrenceMap - Pre-built map from buildClassOccurrenceMap.
 * @returns {number} Number of elements with the same class signature.
 */
function getClassOccurrenceCount(element, classOccurrenceMap) {
  const raw = getClassName(element) ?? '';
  const key = raw.split(/\s+/).filter(Boolean).sort().join(' ');
  return key ? (classOccurrenceMap.get(key) || 1) : 0;
}

/**
 * Assembles the full element record object from traversal + geometry + config flags.
 * Optional fields (styles, attributes, rect, etc.) are added only when their corresponding
 * schema flag is enabled to keep record payloads as small as possible.
 *
 * @param {{ element: Element, depth: number, hpidPath: number[], absoluteHpidPath: number[] }} visit - Traversal record.
 * @param {{ rect: DOMRect, computedStyle: CSSStyleDeclaration|null, scrollX: number, scrollY: number }} reading - Geometry/style snapshot.
 * @param {{ classOccurrenceMap: Map<string,number>, schema: object }} ctx - Shared context for this extraction run.
 * @returns {object} Assembled element record (cssSelector and xpath are null at this stage — filled in by selector pass).
 */
function buildElementRecord(visit, reading, ctx) {
  const { element, depth, hpidPath, absoluteHpidPath } = visit;
  const { rect, computedStyle, scrollX, scrollY }      = reading;
  const { classOccurrenceMap, schema }                  = ctx;

  const absoluteTop = rect ? Math.round(rect.top + scrollY) : null;

  const record = {
    hpid:         serializeHpid(hpidPath),
    absoluteHpid: serializeHpid(absoluteHpidPath),
    tagName:      element.tagName.toLowerCase(),
    elementId:    element.id || null,
    className:    getClassName(element),
    textContent:  getTextContent(element, schema.record.textContent.maxLength),
    cssSelector:  null,
    xpath:        null,
    depth
  };

  if (schema.includePageSection)    {record.pageSection        = detectElementSection(element, absoluteTop);}
  if (schema.includeTier)           {record.tier               = classifyTier(element);}
  if (schema.includeClassMeta)      {record.classOccurrenceCount = getClassOccurrenceCount(element, classOccurrenceMap);}
  if (schema.includeStyles)         {record.styles             = collectStylesFromComputed(computedStyle);}
  if (schema.includeAttributes)     {record.attributes         = collectAttributes(element);}
  if (schema.includeRect)           {record.rect               = buildBoundingRect(rect, scrollX, scrollY);}
  if (schema.includeNeighbours)     {record.neighbours         = getNeighbours(element);}
  if (schema.includeClassHierarchy) {record.classHierarchy     = getClassHierarchy(element);}

  return record;
}

/**
 * Returns a batch size scaled to total element count to balance throughput vs.
 * event-loop responsiveness. Smaller batches on larger pages prevent long task warnings.
 *
 * @param {number} totalElements - Total number of elements to process.
 * @returns {number} Recommended batch size.
 */
function computeAdaptiveBatchSize(totalElements) {
  if (totalElements <= 200)  {return 40;}
  if (totalElements <= 1000) {return 25;}
  if (totalElements <= 3000) {return 15;}
  return 10;
}

/**
 * Processes visits in adaptive batches: builds records, generates selectors per batch,
 * then yields to the event loop between batches so the page remains responsive.
 * Element references are nulled immediately after use to allow GC during long extractions.
 *
 * @param {object[]} visits - Filtered traversal records.
 * @param {object[]} readings - Parallel geometry/style readings.
 * @param {Map<string, number>} classOccurrenceMap - Class frequency map for occurrence counts.
 * @returns {Promise<object[]>} Fully assembled element records with selectors filled in.
 */
async function executeUnifiedPass(visits, readings, classOccurrenceMap) {
  performance.mark('unified-pass-start');

  const hardCapMs     = get('extraction.batchHardCapMs', 30);
  const schema        = get('schema');
  const generateCSS   = get('selectors.generateCSS', true);
  const generateXPath = get('selectors.generateXPath', true);
  const doSelectors   = generateCSS || generateXPath;
  const baseBatchSize = computeAdaptiveBatchSize(visits.length);
  const ctx           = { classOccurrenceMap, schema };
  const results       = [];

  let i = 0;
  while (i < visits.length) {
    const batchStart     = performance.now();
    const batchEndTarget = i + baseBatchSize;
    const batchRecords   = [];
    const batchElements  = [];

    while (i < visits.length) {
      const j = i;
      i++;

      let record;
      try {
        record = buildElementRecord(visits[j], readings[j], ctx);
      } catch (err) {
        logger.warn('Element record build failed', { index: j, error: err.message });
        visits[j].element = null;
        continue;
      }

      if (record !== null) {
        batchRecords.push(record);
        batchElements.push(visits[j].element);
        visits[j].element = null;
      } else {
        visits[j].element = null;
      }

      // Hard wall: break out of the inner loop if wall-clock time exceeded,
      // even if the target batch size has not been reached yet.
      if (performance.now() - batchStart >= hardCapMs || i >= batchEndTarget) {
        break;
      }
    }

    if (doSelectors && batchElements.length > 0) {
      const selectors = await generateSelectorsForElements(batchElements);
      for (let k = 0; k < batchRecords.length; k++) {
        const sel = selectors[k];
        if (sel) {
          batchRecords[k].cssSelector = generateCSS   ? (sel.css   ?? null) : null;
          batchRecords[k].xpath       = generateXPath ? (sel.xpath ?? null) : null;
          if (sel.shadowPath) {batchRecords[k].shadowPath = sel.shadowPath;}
        }
      }
    }

    for (let k = 0; k < batchElements.length; k++) {
      batchElements[k] = null;
    }

    for (const record of batchRecords) {
      results.push(record);
    }

    if (i < visits.length) {
      await yieldToEventLoop();
    }
  }

  performance.mark('unified-pass-end');
  performance.measure('extraction-unified-pass', 'unified-pass-start', 'unified-pass-end');

  logger.debug('Unified pass complete', {
    total:    results.length,
    adaptive: baseBatchSize
  });

  return results;
}

/**
 * Top-level extraction entry point. Waits for page readiness, runs the full pipeline,
 * and returns a structured extraction result with metadata and element records.
 *
 * @param {{ class?: string, id?: string, tag?: string }|null} [filters] - Optional extraction filters from the popup.
 * @returns {Promise<{ url: string, title: string, timestamp: string, totalElements: number, elements: object[], duration: number, captureQuality: string, filters: object|null }>}
 * @throws Re-throws any error from the pipeline after logging it.
 */
async function extract(filters) {
  const perfHandle      = performanceMonitor.start('extraction-total');
  const startTime       = performance.now();
  const resolvedFilters = filters ?? null;

  logger.info('Extraction started', {
    url:        window.location.href,
    hasFilters: Boolean(resolvedFilters)
  });

  try {
    const captureQuality = await waitForReadiness();

    performance.mark('traversal-start');
    const visits = traverseDocument(resolvedFilters);
    performance.mark('traversal-end');
    performance.measure('extraction-traversal', 'traversal-start', 'traversal-end');

    logger.debug('Traversal complete', { rawCount: visits.length });

    const readings = executePass1(visits);
    const { filteredVisits, filteredReadings } = applyVisibilityFilter(visits, readings);

    const maxElements     = get('extraction.maxElements');
    const overflow        = filteredVisits.length > maxElements;
    const clampedVisits   = overflow ? filteredVisits.slice(0, maxElements) : filteredVisits;
    const clampedReadings = overflow ? filteredReadings.slice(0, maxElements) : filteredReadings;

    if (overflow) {
      logger.warn('Element count truncated', {
        original: filteredVisits.length,
        limit:    maxElements
      });
    }

    const classOccurrenceMap = buildClassOccurrenceMap(clampedVisits);
    const elements           = await executeUnifiedPass(clampedVisits, clampedReadings, classOccurrenceMap);

    const duration = Math.round(performance.now() - startTime);
    performanceMonitor.end(perfHandle);

    logger.info('Extraction complete', {
      elementCount: elements.length,
      duration,
      captureQuality
    });

    return {
      url:           window.location.href,
      title:         document.title || 'Untitled Page',
      timestamp:     new Date().toISOString(),
      totalElements: elements.length,
      extractOptions: {
        schema:         get('schema'),
        filtersApplied: Boolean(resolvedFilters)
      },
      styleCategories: get('extraction.styleCategories'),
      elements,
      duration,
      captureQuality,
      filters: resolvedFilters
    };
  } catch (err) {
    performanceMonitor.end(perfHandle);
    logger.error('Extraction failed', { error: err.message, url: window.location.href });
    throw err;
  }
}

export { extract };