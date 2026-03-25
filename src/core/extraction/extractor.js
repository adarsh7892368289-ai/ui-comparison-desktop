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

function getClassName(element) {
  if (!element.className) {return null;}
  if (typeof element.className === 'string') {return element.className || null;}
  return element.className.baseVal || null;
}

function buildClassOccurrenceMap(visits) {
  const counts = new Map();
  for (const { element } of visits) {
    const raw = getClassName(element) ?? '';
    const key = raw.split(/\s+/).filter(Boolean).sort().join(' ');
    if (key) {counts.set(key, (counts.get(key) || 0) + 1);}
  }
  return counts;
}

function getClassOccurrenceCount(element, classOccurrenceMap) {
  const raw = getClassName(element) ?? '';
  const key = raw.split(/\s+/).filter(Boolean).sort().join(' ');
  return key ? (classOccurrenceMap.get(key) || 1) : 0;
}

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

function computeAdaptiveBatchSize(totalElements) {
  if (totalElements <= 200)  {return 40;}
  if (totalElements <= 1000) {return 25;}
  if (totalElements <= 3000) {return 15;}
  return 10;
}

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