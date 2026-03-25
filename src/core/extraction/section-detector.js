/**
 * Classifies a DOM element into one of three page sections: header, main, or footer.
 * Runs in the content-script context after DOM extraction.
 * Invariant: always returns a string — callers can compare without null-guarding.
 * Called by: extractor.js per-element enrichment pass.
 */
import { get } from '../../config/defaults.js';

// Word-boundary regexes prevent partial matches (e.g. "share" triggering "header").
const HEADER_CLASS_RE = /(^|[^a-z])(header|top|navbar|masthead)([^a-z]|$)/i;
const FOOTER_CLASS_RE = /(^|[^a-z])(footer|bottom|copyright)([^a-z]|$)/i;

/**
 * Walks the ancestor chain looking for HTML5 landmark elements or ARIA roles
 * that unambiguously identify the section. Stops at <body> to avoid false positives.
 *
 * @param {Element} element - The element to classify.
 * @returns {'header'|'main'|'footer'|null} Null when no semantic landmark is found.
 */
function classifyBySemantics(element) {
  let current = element;

  while (current && current !== document.body && current !== document.documentElement) {
    const tag  = current.tagName.toLowerCase();
    const role = current.getAttribute('role');

    if (tag === 'header' || role === 'banner')       {return 'header';}
    if (tag === 'main'   || role === 'main')          {return 'main';}
    if (tag === 'footer' || role === 'contentinfo')   {return 'footer';}
    if (tag === 'nav'    || role === 'navigation')    {return 'header';}
    if (tag === 'aside'  || role === 'complementary') {return 'main';}

    const className = current.className?.toString() ?? '';
    const id        = current.id ?? '';
    const combined  = `${className} ${id}`;

    if (HEADER_CLASS_RE.test(combined)) {return 'header';}
    if (FOOTER_CLASS_RE.test(combined)) {return 'footer';}

    current = current.parentElement;
  }

  return null;
}

/**
 * Falls back to pixel thresholds when no semantic landmark exists.
 * Thresholds are capped at a viewport-relative value so they stay sane on infinite-scroll pages.
 *
 * @param {number} absoluteTop - Element's top offset from the document origin in pixels.
 * @returns {'header'|'main'|'footer'}
 */
function classifyByPosition(absoluteTop) {
  const cfg            = get('extraction.section');
  const docHeight      = document.documentElement.scrollHeight;
  const viewportHeight = window.innerHeight;

  const headerLimit = Math.min(docHeight * cfg.headerPositionRatio, viewportHeight * cfg.headerViewportFactor);
  const footerStart = docHeight - Math.min(docHeight * cfg.footerPositionRatio, viewportHeight * cfg.footerViewportFactor);

  if (absoluteTop < headerLimit) {return 'header';}
  if (absoluteTop > footerStart) {return 'footer';}
  return 'main';
}

/**
 * Public entry point: semantic classification first, position-based fallback second.
 * Returns 'unknown' instead of throwing when inputs are missing or position math fails.
 *
 * @param {Element|null} element - The DOM element to classify.
 * @param {number|null} absoluteTop - Pre-computed top offset; pass null to skip position fallback.
 * @returns {'header'|'main'|'footer'|'unknown'}
 */
function detectElementSection(element, absoluteTop) {
  if (!element) {return 'unknown';}

  const semantic = classifyBySemantics(element);
  if (semantic) {return semantic;}

  if (absoluteTop === null) {return 'unknown';}

  try {
    return classifyByPosition(absoluteTop);
  } catch {
    return 'unknown';
  }
}

export { detectElementSection };