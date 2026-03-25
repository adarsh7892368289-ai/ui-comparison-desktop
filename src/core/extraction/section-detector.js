import { get } from '../../config/defaults.js';

const HEADER_CLASS_RE = /(^|[^a-z])(header|top|navbar|masthead)([^a-z]|$)/i;
const FOOTER_CLASS_RE = /(^|[^a-z])(footer|bottom|copyright)([^a-z]|$)/i;
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