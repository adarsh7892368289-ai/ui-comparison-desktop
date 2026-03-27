'use strict';

function getPageExtractorFn() {
  return async function pageExtractor({ options, sessionId }) {
    const cfg = options ?? {};

    const schema = cfg.schema ?? {
      includeStyles: true, includeAttributes: true, includeRect: true,
      includeNeighbours: false, includeClassHierarchy: false,
      includeTier: true, includeClassMeta: true, includePageSection: true,
      record: { textContent: { maxLength: 500 } },
      enrichment: {
        neighbours: { maxParentClasses: 3, maxChildrenTypes: 10 },
        classHierarchy: { maxParentDepth: 3, maxChildCount: 10, maxClassSlice: 2 }
      }
    };

    const extractionCfg = cfg.extraction ?? {
      batchHardCapMs: 30, maxElements: 10000, skipInvisible: true,
      stabilityWindowMs: 500, hardTimeoutMs: 1000,
      section: { headerPositionRatio: 0.20, footerPositionRatio: 0.15, headerViewportFactor: 1.5, footerViewportFactor: 1.0 },
      irrelevantTags: ['SCRIPT','STYLE','META','LINK','NOSCRIPT','BR','HR','HEAD','TITLE','BASE','TEMPLATE','SLOT','WBR','PARAM','TRACK','SOURCE','AREA','COL','COLGROUP'],
      cssProperties: [
        'font-family','font-size','font-weight','font-style','line-height','letter-spacing','word-spacing','text-align',
        'text-decoration','text-transform','color','background-color','opacity','visibility',
        'padding','padding-top','padding-right','padding-bottom','padding-left',
        'margin','margin-top','margin-right','margin-bottom','margin-left','gap',
        'display','position','float','clear','overflow','overflow-x','overflow-y',
        'width','height','max-width','max-height','min-width','min-height',
        'top','right','bottom','left','z-index',
        'flex-direction','flex-wrap','flex-grow','flex-shrink','flex-basis',
        'justify-content','align-items','align-content','align-self',
        'grid-template-columns','grid-template-rows','grid-column','grid-row',
        'border','border-width','border-style','border-color',
        'border-top-width','border-right-width','border-bottom-width','border-left-width',
        'border-top-style','border-right-style','border-bottom-style','border-left-style',
        'border-top-color','border-right-color','border-bottom-color','border-left-color',
        'border-radius','border-top-left-radius','border-top-right-radius',
        'border-bottom-right-radius','border-bottom-left-radius','box-shadow','text-shadow'
      ]
    };

    const selectorsCfg = cfg.selectors ?? {
      generateCSS: true, generateXPath: true, concurrency: 4, totalTimeout: 600,
      xpath: { perStrategyTimeout: 50, totalTimeout: 400 },
      css:   { perStrategyTimeout: 40, totalTimeout: 250 }
    };

    const hpidCfg = cfg.hpid ?? { maxDepth: 5000, shadowSentinel: 0 };
    const attrCfg = cfg.attributes ?? {
      frameworkPatterns: ['^ng-','^_ngcontent','^_nghost','^v-','^data-v-[a-f0-9]+$','^jsx-','^data-reactid','^data-react-'],
      dynamicIdPatterns: ['^\\d+$','^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$','\\d{13,}$','^[a-f0-9]{32,}$','^(ember|react|vue|angular)\\d+$','^uid-\\d+$','^temp[-_]?\\d+$','-\\d{2,}$'],
      dynamicClassPatterns: ['^Mui[A-Z]\\w+-\\w+-\\d+$','^makeStyles-','^css-[a-z0-9]+$','^jss\\d+$','^sc-[a-z]+-[a-z]+$','^emotion-\\d+$','^lwc-[a-z0-9]+']
    };

    const T0_TAGS = new Set(extractionCfg.irrelevantTags);
    const T3_TAGS = new Set(['BUTTON','INPUT','SELECT','TEXTAREA','LABEL','A','DIALOG','DETAILS','OUTPUT','METER','PROGRESS','OPTION','OPTGROUP']);
    const T3_ROLES = new Set(['button','link','checkbox','radio','textbox','combobox','listbox','menuitem','menuitemcheckbox','menuitemradio','option','searchbox','slider','spinbutton','switch','tab','treeitem','gridcell']);
    const T2_TAGS = new Set(['P','SPAN','H1','H2','H3','H4','H5','H6','IMG','SVG','CANVAS','VIDEO','AUDIO','PICTURE','BLOCKQUOTE','PRE','CODE','STRONG','EM','FIGURE','FIGCAPTION','TIME','ADDRESS','Q','MARK','INS','DEL','ABBR','CITE','DFN','KBD','SAMP','VAR','SMALL','SUB','SUP','DL','DT','DD','IFRAME']);

    const compiledIdPatterns      = attrCfg.dynamicIdPatterns.map(p => new RegExp(p));
    const compiledClassPatterns   = attrCfg.dynamicClassPatterns.map(p => new RegExp(p));
    const compiledFrameworkPats   = attrCfg.frameworkPatterns.map(p => new RegExp(p, 'u'));

    const SHADOW_SENTINEL = hpidCfg.shadowSentinel;

    function isStableId(id) {
      if (!id || id.length < 2 || id.length > 200) { return false; }
      return !compiledIdPatterns.some(p => p.test(id));
    }

    function isStableClass(c) {
      if (!c || typeof c !== 'string' || !c.trim()) { return false; }
      return !compiledClassPatterns.some(p => p.test(c.trim()));
    }

    function isStableValue(value) {
      const UNSTABLE = [/^[0-9]{8,}$/,/^[a-f0-9]{8}-[a-f0-9]{4}/i,/data-aura-rendered/i,/^ember\d+$/i,/^react\d+$/i,/^\d{13}$/,/^tt-for-\d+$/i,/^[0-9]+:[0-9]+;[a-z]$/i,/-\d+-\d+$/];
      if (!value || typeof value !== 'string') { return false; }
      if (value.length < 1 || value.length > 200) { return false; }
      return !UNSTABLE.some(p => p.test(value));
    }

    function isStaticText(text) {
      if (!text || typeof text !== 'string') { return false; }
      if (text.length < 2 || text.length > 200) { return false; }
      const DYN = [/^\d+$/,/^[0-9]{8,}$/,/^[a-f0-9]{8}-[a-f0-9]{4}/i,/^\d{1,2}:\d{2}/,/^\d{1,2}\/\d{1,2}\/\d{2,4}$/,/^loading/i,/^processing/i,/^\$\d+\.\d{2}$/];
      return !DYN.some(p => p.test(text));
    }

    function cleanText(text) {
      if (typeof text !== 'string') { return ''; }
      return text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function isTierZero(element) { return T0_TAGS.has(element.tagName); }

    function classifyTier(element) {
      const { tagName } = element;
      if (T0_TAGS.has(tagName)) { return 'T0'; }
      if (T3_TAGS.has(tagName)) { return 'T3'; }
      const role = element.getAttribute('role');
      if (role && T3_ROLES.has(role)) { return 'T3'; }
      if (T2_TAGS.has(tagName)) { return 'T2'; }
      return 'T1';
    }

    function isVisible(computedStyle, rect) {
      if (!computedStyle) { return false; }
      return (
        computedStyle.display !== 'none' &&
        computedStyle.visibility !== 'hidden' &&
        parseFloat(computedStyle.opacity) > 0 &&
        rect.width > 0 && rect.height > 0
      );
    }

    function collectStylesFromComputed(computedStyle) {
      if (!computedStyle) { return Object.create(null); }
      const styles = Object.create(null);
      for (const prop of extractionCfg.cssProperties) {
        styles[prop] = computedStyle.getPropertyValue(prop);
      }
      return styles;
    }

    function collectAttributes(element) {
      const result = Object.create(null);
      for (const { name, value } of element.attributes) {
        if (!compiledFrameworkPats.some(p => p.test(name))) {
          result[name] = value;
        }
      }
      return result;
    }

    const HEADER_CLASS_RE = /(^|[^a-z])(header|top|navbar|masthead)([^a-z]|$)/i;
    const FOOTER_CLASS_RE = /(^|[^a-z])(footer|bottom|copyright)([^a-z]|$)/i;

    function classifyBySemantics(element) {
      let current = element;
      while (current && current !== document.body && current !== document.documentElement) {
        const tag  = current.tagName.toLowerCase();
        const role = current.getAttribute('role');
        if (tag === 'header' || role === 'banner')       { return 'header'; }
        if (tag === 'main'   || role === 'main')          { return 'main'; }
        if (tag === 'footer' || role === 'contentinfo')   { return 'footer'; }
        if (tag === 'nav'    || role === 'navigation')    { return 'header'; }
        if (tag === 'aside'  || role === 'complementary') { return 'main'; }
        const combined = `${current.className?.toString() ?? ''} ${current.id ?? ''}`;
        if (HEADER_CLASS_RE.test(combined)) { return 'header'; }
        if (FOOTER_CLASS_RE.test(combined)) { return 'footer'; }
        current = current.parentElement;
      }
      return null;
    }

    function detectElementSection(element, absoluteTop) {
      if (!element) { return 'unknown'; }
      const semantic = classifyBySemantics(element);
      if (semantic) { return semantic; }
      if (absoluteTop === null) { return 'unknown'; }
      try {
        const s           = extractionCfg.section;
        const docHeight   = document.documentElement.scrollHeight;
        const vpHeight    = window.innerHeight;
        const headerLimit = Math.min(docHeight * s.headerPositionRatio, vpHeight * s.headerViewportFactor);
        const footerStart = docHeight - Math.min(docHeight * s.footerPositionRatio, vpHeight * s.footerViewportFactor);
        if (absoluteTop < headerLimit) { return 'header'; }
        if (absoluteTop > footerStart) { return 'footer'; }
        return 'main';
      } catch { return 'unknown'; }
    }

    function getNeighbours(element) {
      const maxClasses = schema.enrichment.neighbours.maxParentClasses;
      const maxTypes   = schema.enrichment.neighbours.maxChildrenTypes;

      function fmtRef(el) {
        let ref = el.tagName.toLowerCase();
        if (el.id) { ref += `#${el.id}`; }
        if (el.className && typeof el.className === 'string') {
          const cls = el.className.trim().split(/\s+/).slice(0, maxClasses);
          if (cls.length > 0 && cls[0]) { ref += `.${cls.join('.')}`; }
        }
        return ref;
      }

      function childTypes(children) {
        const counts = {};
        for (const c of children) {
          const t = c.tagName.toLowerCase();
          counts[t] = (counts[t] || 0) + 1;
        }
        return Object.entries(counts).map(([t, n]) => n > 1 ? `${t}(${n})` : t).slice(0, maxTypes);
      }

      return {
        parent:          element.parentElement          ? fmtRef(element.parentElement)          : null,
        previousSibling: element.previousElementSibling ? fmtRef(element.previousElementSibling) : null,
        nextSibling:     element.nextElementSibling     ? fmtRef(element.nextElementSibling)     : null,
        childrenCount:   element.children ? element.children.length : 0,
        childrenTypes:   element.children ? childTypes(element.children) : []
      };
    }

    function getClassHierarchy(element) {
      const maxDepth = schema.enrichment.classHierarchy.maxParentDepth;
      const maxCount = schema.enrichment.classHierarchy.maxChildCount;
      const maxSlice = schema.enrichment.classHierarchy.maxClassSlice;
      const hierarchy = { parentClasses: [], childClasses: [] };

      let current = element.parentElement;
      let depth   = 0;
      while (current && depth < maxDepth) {
        if (current.className && typeof current.className === 'string') {
          const classes = current.className.trim().split(/\s+/);
          if (classes.length > 0 && classes[0]) {
            hierarchy.parentClasses.push({ tag: current.tagName.toLowerCase(), classes: classes.slice(0, maxSlice) });
          }
        }
        current = current.parentElement;
        depth++;
      }

      let counted = 0;
      for (const child of element.children) {
        if (counted >= maxCount) { break; }
        if (child.className && typeof child.className === 'string') {
          const classes = child.className.trim().split(/\s+/);
          if (classes.length > 0 && classes[0]) {
            hierarchy.childClasses.push({ tag: child.tagName.toLowerCase(), classes: classes.slice(0, maxSlice) });
            counted++;
          }
        }
      }
      return hierarchy;
    }

    function serializeHpid(path) { return path.join('.'); }

    function computeAbsoluteHpidPath(element) {
      const path      = [];
      let   current   = element;
      const lightRoot = document.body ?? document.documentElement;
      while (current && current !== lightRoot && current !== document.documentElement) {
        if (current.parentElement) {
          let pos = 1;
          let sib = current.previousElementSibling;
          while (sib) { pos++; sib = sib.previousElementSibling; }
          path.unshift(pos);
          current = current.parentElement;
        } else if (current.parentNode instanceof ShadowRoot) {
          let pos = 1;
          let sib = current.previousElementSibling;
          while (sib) { pos++; sib = sib.previousElementSibling; }
          path.unshift(pos);
          path.unshift(SHADOW_SENTINEL);
          current = current.parentNode.host;
        } else { break; }
      }
      return path;
    }

    function buildNodeFilter(excludedRootSet) {
      return {
        acceptNode(node) {
          if (T0_TAGS.has(node.tagName)) { return NodeFilter.FILTER_REJECT; }
          if (excludedRootSet !== null && excludedRootSet.has(node)) { return NodeFilter.FILTER_REJECT; }
          return NodeFilter.FILTER_ACCEPT;
        }
      };
    }

    function createFrame(node, depth, hpidPath, absolutePath) {
      return { node, depth, hpidPath, absolutePath, childCount: 0 };
    }

    function popToParent(stack, parentNode) {
      while (stack.length > 1 && stack[stack.length - 1].node !== parentNode) { stack.pop(); }
    }

    function assertDepth(depth) {
      if (depth > hpidCfg.maxDepth) { throw new Error(`DOM depth ${depth} exceeded limit`); }
    }

    function collectShadowSubtree(host, hostDepth, hostAbsPath, hostRelPath, nodeFilter, accumulator) {
      const shadowRoot = host.shadowRoot;
      if (!shadowRoot) { return; }
      const shadowAbsBase = hostAbsPath.concat(SHADOW_SENTINEL);
      const shadowRelBase = hostRelPath.concat(SHADOW_SENTINEL);
      const rootFrame = createFrame(shadowRoot, hostDepth, shadowRelBase, shadowAbsBase);
      const stack     = [rootFrame];
      const walker    = document.createTreeWalker(shadowRoot, NodeFilter.SHOW_ELEMENT, nodeFilter);
      let   node      = walker.nextNode();
      while (node) {
        popToParent(stack, node.parentNode);
        const parentFrame = stack[stack.length - 1];
        parentFrame.childCount += 1;
        const depth       = parentFrame.depth + 1;
        const relHpidPath = parentFrame.hpidPath.concat(parentFrame.childCount);
        const absHpidPath = parentFrame.absolutePath.concat(parentFrame.childCount);
        assertDepth(depth);
        stack.push(createFrame(node, depth, relHpidPath, absHpidPath));
        accumulator.push({ element: node, depth, hpidPath: relHpidPath, absoluteHpidPath: absHpidPath });
        if (node.shadowRoot) { collectShadowSubtree(node, depth, absHpidPath, relHpidPath, nodeFilter, accumulator); }
        node = walker.nextNode();
      }
    }

    function collectLightSubtree(root, rootRelPath, rootAbsPath, nodeFilter, accumulator) {
      const rootFrame = createFrame(root, rootRelPath.length - 1, rootRelPath, rootAbsPath);
      const stack     = [rootFrame];
      const walker    = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, nodeFilter);
      let   node      = walker.nextNode();
      while (node) {
        popToParent(stack, node.parentNode);
        const parentFrame = stack[stack.length - 1];
        parentFrame.childCount += 1;
        const depth       = parentFrame.depth + 1;
        const relHpidPath = parentFrame.hpidPath.concat(parentFrame.childCount);
        const absHpidPath = parentFrame.absolutePath.concat(parentFrame.childCount);
        assertDepth(depth);
        stack.push(createFrame(node, depth, relHpidPath, absHpidPath));
        accumulator.push({ element: node, depth, hpidPath: relHpidPath, absoluteHpidPath: absHpidPath });
        if (node.shadowRoot) { collectShadowSubtree(node, depth, absHpidPath, relHpidPath, nodeFilter, accumulator); }
        node = walker.nextNode();
      }
    }

    function hasActiveFilters(filters) {
      return Boolean(filters && (filters.class || filters.id || filters.tag));
    }

    function buildCombinedSelector(filters) {
      function parseClass(raw) {
        const trimmed = raw.trim();
        if (!trimmed) { return null; }
        const selectors = [];
        for (const group of trimmed.split(',')) {
          const classes = group.trim().split(/\s+/).filter(Boolean);
          if (!classes.length) { continue; }
          selectors.push(classes.map(c => `.${CSS.escape(c.replace(/^\./u, ''))}`).join(''));
        }
        return selectors.length > 0 ? selectors.join(',') : null;
      }
      function parseId(raw) {
        const ids = raw.trim().split(',').map(i => i.trim()).filter(Boolean);
        if (!ids.length) { return null; }
        return ids.map(id => `#${CSS.escape(id.replace(/^#/u, ''))}`).join(',');
      }
      function parseTag(raw) {
        const tags = raw.trim().split(/[\s,]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
        return tags.length > 0 ? tags.join(',') : null;
      }
      const parts = [
        filters.class ? parseClass(filters.class) : null,
        filters.id    ? parseId(filters.id)        : null,
        filters.tag   ? parseTag(filters.tag)       : null
      ].filter(Boolean);
      return parts.length > 0 ? parts.join(',') : null;
    }

    function resolveFilteredRoots(filters) {
      const selector = buildCombinedSelector(filters);
      if (!selector) { return null; }
      let candidates;
      try { candidates = Array.from(document.querySelectorAll(selector)); }
      catch { return null; }
      if (!candidates.length) { return []; }
      const set = new WeakSet(candidates);
      return candidates.filter(c => {
        let a = c.parentElement;
        while (a) { if (set.has(a)) { return false; } a = a.parentElement; }
        return true;
      });
    }

    function traverseDocument(filters) {
      const accumulator = [];
      if (!hasActiveFilters(filters)) {
        const body        = document.body ?? document.documentElement;
        const absBodyPath = computeAbsoluteHpidPath(body);
        const relPath     = [1];
        const absPath     = absBodyPath.length > 0 ? absBodyPath : [1];
        accumulator.push({ element: body, depth: 0, hpidPath: relPath, absoluteHpidPath: absPath });
        collectLightSubtree(body, relPath, absPath, buildNodeFilter(null), accumulator);
        return accumulator;
      }
      const roots = resolveFilteredRoots(filters);
      if (!roots || roots.length === 0) { return accumulator; }
      const rootSet    = new WeakSet(roots);
      const nodeFilter = buildNodeFilter(rootSet);
      for (let idx = 0; idx < roots.length; idx++) {
        const root        = roots[idx];
        const relPath     = [idx + 1];
        const absHpidPath = computeAbsoluteHpidPath(root);
        accumulator.push({ element: root, depth: 0, hpidPath: relPath, absoluteHpidPath: absHpidPath });
        if (root.shadowRoot) {
          collectShadowSubtree(root, 0, absHpidPath, relPath, nodeFilter, accumulator);
        } else {
          collectLightSubtree(root, relPath, absHpidPath, nodeFilter, accumulator);
        }
      }
      return accumulator;
    }

    function executePass1(visits) {
      const scrollX  = window.scrollX;
      const scrollY  = window.scrollY;
      const readings = new Array(visits.length);
      for (let i = 0; i < visits.length; i++) {
        const { element } = visits[i];
        try {
          readings[i] = { rect: element.getBoundingClientRect(), computedStyle: window.getComputedStyle(element), isConnected: element.isConnected, scrollX, scrollY };
        } catch {
          readings[i] = { rect: { x:0,y:0,width:0,height:0,top:0,left:0 }, computedStyle: null, isConnected: false, scrollX, scrollY };
        }
      }
      return readings;
    }

    function applyVisibilityFilter(visits, readings) {
      if (!extractionCfg.skipInvisible) { return { filteredVisits: visits, filteredReadings: readings }; }
      const fv = [], fr = [];
      for (let i = 0; i < visits.length; i++) {
        if (!readings[i].isConnected || isTierZero(visits[i].element)) { continue; }
        if (isVisible(readings[i].computedStyle, readings[i].rect)) { fv.push(visits[i]); fr.push(readings[i]); }
      }
      return { filteredVisits: fv, filteredReadings: fr };
    }

    function buildBoundingRect(rect, scrollX, scrollY) {
      if (!rect) { return null; }
      return { x: Math.round(rect.x+scrollX), y: Math.round(rect.y+scrollY), width: Math.round(rect.width), height: Math.round(rect.height), top: Math.round(rect.top+scrollY), left: Math.round(rect.left+scrollX) };
    }

    function getTextContent(element, maxLength) {
      let text = '';
      for (const node of element.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) { text += node.textContent; }
      }
      text = text.trim();
      if (!text.length) { return null; }
      return text.length > maxLength ? `${text.substring(0, maxLength)}...` : text;
    }

    function getClassName(element) {
      if (!element.className) { return null; }
      if (typeof element.className === 'string') { return element.className || null; }
      return element.className.baseVal || null;
    }

    function buildClassOccurrenceMap(visits) {
      const counts = new Map();
      for (const { element } of visits) {
        const raw = getClassName(element) ?? '';
        const key = raw.split(/\s+/).filter(Boolean).sort().join(' ');
        if (key) { counts.set(key, (counts.get(key) || 0) + 1); }
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
      const { classOccurrenceMap }                          = ctx;
      const maxLen     = schema.record.textContent.maxLength;
      const absoluteTop = rect ? Math.round(rect.top + scrollY) : null;

      const record = {
        hpid:         serializeHpid(hpidPath),
        absoluteHpid: serializeHpid(absoluteHpidPath),
        tagName:      element.tagName.toLowerCase(),
        elementId:    element.id || null,
        className:    getClassName(element),
        textContent:  getTextContent(element, maxLen),
        cssSelector:  null,
        xpath:        null,
        depth
      };

      if (schema.includePageSection)    { record.pageSection          = detectElementSection(element, absoluteTop); }
      if (schema.includeTier)           { record.tier                 = classifyTier(element); }
      if (schema.includeClassMeta)      { record.classOccurrenceCount = getClassOccurrenceCount(element, classOccurrenceMap); }
      if (schema.includeStyles)         { record.styles               = collectStylesFromComputed(computedStyle); }
      if (schema.includeAttributes)     { record.attributes           = collectAttributes(element); }
      if (schema.includeRect)           { record.rect                 = buildBoundingRect(rect, scrollX, scrollY); }
      if (schema.includeNeighbours)     { record.neighbours           = getNeighbours(element); }
      if (schema.includeClassHierarchy) { record.classHierarchy       = getClassHierarchy(element); }
      return record;
    }

    function escapeCss(str) {
      if (!str) { return ''; }
      return str.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
    }

    function escapeXPath(str) {
      if (str === null || str === undefined) { return "''"; }
      if (typeof str !== 'string') { str = String(str); }
      if (!str) { return "''"; }
      if (!str.includes("'")) { return `'${str}'`; }
      if (!str.includes('"')) { return `"${str}"`; }
      return `concat('${str.split("'").join("', \"'\", '")}')`;
    }

    function getUniversalTag(element) {
      const ns = element.namespaceURI;
      if (ns === 'http://www.w3.org/2000/svg' || ns === 'http://www.w3.org/1998/Math/MathML') {
        return `*[local-name()='${element.localName}']`;
      }
      return element.tagName.toLowerCase();
    }

    function isValidCssSelector(selector) {
      try { document.querySelector(selector); return true; } catch { return false; }
    }

    function isUniqueCss(selector, target) {
      try { const m = document.querySelectorAll(selector); return m.length === 1 && m[0] === target; } catch { return false; }
    }

    function countXPathMatches(xpath) {
      try {
        const r = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        return r.snapshotLength;
      } catch { return 0; }
    }

    function isUniqueXPath(xpath, target) {
      try {
        const r = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        return r.snapshotLength === 1 && r.snapshotItem(0) === target;
      } catch { return false; }
    }

    function ensureXPathUniqueness(xpath, target) {
      try {
        const r = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        for (let i = 0; i < r.snapshotLength; i++) {
          if (r.snapshotItem(i) === target) { return r.snapshotLength === 1 ? xpath : `(${xpath})[${i+1}]`; }
        }
      } catch {}
      return xpath;
    }

    const TEST_ATTRS = ['data-testid','data-test','data-qa','data-cy','data-automation-id'];

    function generateCSSForElement(element) {
      const tag = element.tagName.toLowerCase();

      function anchorToAncestor(selector) {
        let ancestor = element.parentElement;
        let depth = 0;
        while (ancestor && depth < 6) {
          if (ancestor.id && isStableId(ancestor.id)) {
            const esc = CSS.escape ? CSS.escape(ancestor.id) : escapeCss(ancestor.id);
            return `#${esc} ${selector}`;
          }
          for (const attr of TEST_ATTRS) {
            const val = ancestor.getAttribute(attr);
            if (val) { return `[${attr}="${escapeCss(val)}"] ${selector}`; }
          }
          ancestor = ancestor.parentElement;
          depth++;
        }
        return null;
      }

      function tryCandidate(selector) {
        if (!isValidCssSelector(selector)) { return null; }
        if (isUniqueCss(selector, element)) { return selector; }
        const anchored = anchorToAncestor(selector);
        if (anchored && isValidCssSelector(anchored) && isUniqueCss(anchored, element)) { return anchored; }
        return null;
      }

      if (element.id && isStableId(element.id)) {
        const esc = CSS.escape ? CSS.escape(element.id) : escapeCss(element.id);
        const c = tryCandidate(`${tag}#${esc}`);
        if (c) { return { css: c, confidence: 100, strategy: 'id' }; }
      }

      for (const attr of TEST_ATTRS) {
        const val = element.getAttribute(attr);
        if (val && isStableValue(val)) {
          const c = tryCandidate(`${tag}[${attr}="${escapeCss(val)}"]`);
          if (c) { return { css: c, confidence: 91, strategy: 'test-attr' }; }
        }
      }

      for (const { name, value } of Array.from(element.attributes)) {
        if (!name.startsWith('data-') || TEST_ATTRS.includes(name)) { continue; }
        if (value && isStableValue(value) && value.length < 100) {
          const c = tryCandidate(`${tag}[${name}="${escapeCss(value)}"]`);
          if (c) { return { css: c, confidence: 88, strategy: 'data-attr' }; }
        }
      }

      const classList = Array.from(element.classList).filter(isStableClass);
      if (classList.length >= 2) {
        const esc0 = CSS.escape ? CSS.escape(classList[0]) : escapeCss(classList[0]);
        const esc1 = CSS.escape ? CSS.escape(classList[1]) : escapeCss(classList[1]);
        const c = tryCandidate(`${tag}.${esc0}.${esc1}`);
        if (c) { return { css: c, confidence: 72, strategy: 'class-combo' }; }
      }
      if (classList.length >= 1) {
        const esc0 = CSS.escape ? CSS.escape(classList[0]) : escapeCss(classList[0]);
        const c = tryCandidate(`${tag}.${esc0}`);
        if (c) { return { css: c, confidence: 68, strategy: 'class-single' }; }
      }

      function buildPositionPath(el) {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) { return 'html'; }
        const path = [];
        let current = el;
        while (current && current.nodeType === Node.ELEMENT_NODE) {
          const parent = current.parentElement;
          const t = current.tagName.toLowerCase();
          if (!parent) { path.unshift(t); break; }
          if (current.id && isStableId(current.id)) {
            const esc = CSS.escape ? CSS.escape(current.id) : escapeCss(current.id);
            path.unshift(`#${esc}`);
            break;
          }
          const sameTag = Array.from(parent.children).filter(c => c.tagName === current.tagName);
          if (sameTag.length === 1) { path.unshift(t); }
          else { path.unshift(`${t}:nth-of-type(${sameTag.indexOf(current)+1})`); }
          current = parent;
        }
        return path.join(' > ');
      }

      return { css: buildPositionPath(element), confidence: 30, strategy: 'fallback-position' };
    }

    function generateXPathForElement(element) {
      const tag = getUniversalTag(element);

      function narrowByAncestor(xpath) {
        const match = xpath.match(/\/\/[a-zA-Z*][a-zA-Z0-9_:-]*(\[[\s\S]*\])?$/);
        if (!match) { return null; }
        const segment  = match[0];
        const tagMatch = segment.match(/^\/\/[a-zA-Z*][a-zA-Z0-9_:-]*/);
        if (!tagMatch) { return null; }
        const predicate = segment.slice(tagMatch[0].length);
        let ancestor = element.parentElement;
        let depth = 0;
        while (ancestor && depth < 6) {
          const ancTag = getUniversalTag(ancestor);
          if (ancestor.id && isStableId(ancestor.id)) {
            return `//${ancTag}[@id=${escapeXPath(ancestor.id)}]//${tag}${predicate}`;
          }
          for (const attr of TEST_ATTRS) {
            const val = ancestor.getAttribute(attr);
            if (val) { return `//${ancTag}[@${attr}=${escapeXPath(val)}]//${tag}${predicate}`; }
          }
          ancestor = ancestor.parentElement;
          depth++;
        }
        return null;
      }

      function tryXPath(xpath) {
        const n = countXPathMatches(xpath);
        if (n === 0) { return null; }
        if (n === 1 && isUniqueXPath(xpath, element)) { return xpath; }
        const narrowed = narrowByAncestor(xpath);
        if (narrowed && countXPathMatches(narrowed) === 1 && isUniqueXPath(narrowed, element)) { return narrowed; }
        const disambiguated = ensureXPathUniqueness(xpath, element);
        if (isUniqueXPath(disambiguated, element)) { return disambiguated; }
        return null;
      }

      const text = cleanText(element.textContent);
      if (text && text.length >= 2 && text.length <= 150 && isStaticText(text)) {
        const r = tryXPath(`//${tag}[text()=${escapeXPath(text)}]`);
        if (r) { return { xpath: r, confidence: 99, strategy: 'exact-text' }; }
      }

      for (const attr of TEST_ATTRS) {
        const val = element.getAttribute(attr);
        if (val && isStableValue(val)) {
          const r = tryXPath(`//${tag}[@${attr}=${escapeXPath(val)}]`);
          if (r) { return { xpath: r, confidence: 98, strategy: 'test-attr' }; }
        }
      }

      if (element.id && isStableId(element.id)) {
        const r = tryXPath(`//${tag}[@id=${escapeXPath(element.id)}]`);
        if (r) { return { xpath: r, confidence: 95, strategy: 'stable-id' }; }
      }

      function buildXPathFallback(el) {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) { return '/html'; }
        const path = [];
        let current = el;
        while (current && current.nodeType === Node.ELEMENT_NODE) {
          const parent  = current.parentElement;
          const currTag = getUniversalTag(current);
          if (!parent) { path.unshift(currTag); break; }
          if (current.id && isStableId(current.id)) { path.unshift(`${currTag}[@id=${escapeXPath(current.id)}]`); break; }
          const sameTag = Array.from(parent.children).filter(c => c.tagName === current.tagName);
          if (sameTag.length === 1) { path.unshift(currTag); }
          else { path.unshift(`${currTag}[${sameTag.indexOf(current)+1}]`); }
          current = parent;
        }
        return path.length > 0 ? `/${path.join('/')}` : '/html';
      }

      return { xpath: buildXPathFallback(element), confidence: 30, strategy: 'fallback-position' };
    }

    function yieldToEventLoop() {
      return new Promise(resolve => {
        const ch = new MessageChannel();
        ch.port1.start();
        ch.port1.addEventListener('message', resolve, { once: true });
        ch.port2.postMessage(null);
      });
    }

    function computeAdaptiveBatchSize(n) {
      if (n <= 200)  { return 40; }
      if (n <= 1000) { return 25; }
      if (n <= 3000) { return 15; }
      return 10;
    }

    async function executeUnifiedPass(visits, readings, classOccurrenceMap) {
      const hardCapMs     = extractionCfg.batchHardCapMs;
      const generateCSS   = selectorsCfg.generateCSS;
      const generateXPath = selectorsCfg.generateXPath;
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
          const j = i++;
          let record;
          try { record = buildElementRecord(visits[j], readings[j], ctx); }
          catch { visits[j].element = null; continue; }
          if (record) {
            batchRecords.push(record);
            batchElements.push(visits[j].element);
          }
          visits[j].element = null;
          if (performance.now() - batchStart >= hardCapMs || i >= batchEndTarget) { break; }
        }

        for (let k = 0; k < batchRecords.length; k++) {
          const el = batchElements[k];
          if (!el) { continue; }
          if (generateCSS) {
            const r = generateCSSForElement(el);
            batchRecords[k].cssSelector = r?.css ?? null;
          }
          if (generateXPath) {
            const r = generateXPathForElement(el);
            batchRecords[k].xpath = r?.xpath ?? null;
          }
          batchElements[k] = null;
        }

        for (const r of batchRecords) { results.push(r); }
        if (i < visits.length) { await yieldToEventLoop(); }
      }

      return results;
    }

    const SKELETON_CSS = '[class*="skeleton"],[class*="shimmer"],[class*="placeholder"],[class*="loading"],[class*="spinner"]';
    const NOISE_ATTR_NAMES = ['data-analytics','data-tracking','data-gtm','data-layer','aria-live'];

    function isDocumentReady() {
      for (const img of document.querySelectorAll('img')) {
        if (img.complete) { continue; }
        const r = img.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) { continue; }
        if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) { continue; }
        return false;
      }
      return document.querySelector(SKELETON_CSS) === null;
    }

    function waitForReadiness() {
      return new Promise(resolve => {
        const stabilityWindowMs = extractionCfg.stabilityWindowMs;
        const hardTimeoutMs     = extractionCfg.hardTimeoutMs;
        let stabilityTimer = null;
        let hardTimer      = null;
        let observer       = null;
        let noiseOnlyCount = 0;

        function cleanup() { clearTimeout(hardTimer); clearTimeout(stabilityTimer); if (observer) { observer.disconnect(); } }
        function settle(q) { cleanup(); resolve(q); }

        function checkAndSettle() {
          if (!isDocumentReady()) { return; }
          settle(noiseOnlyCount === 0 ? 'OPTIMAL' : 'STABLE');
        }

        function onMutations(records) {
          const hasVisual = records.some(r => {
            const tag = r.target instanceof Element ? r.target.tagName.toLowerCase() : '';
            if (['atomic-','coveo-','dyn-','gtm-','analytics-','beacon-'].some(p => tag.startsWith(p))) { return false; }
            if (r.type === 'attributes' && NOISE_ATTR_NAMES.includes(r.attributeName)) { return false; }
            if (r.type === 'attributes' && r.attributeName === 'class') {
              const cls = r.target instanceof Element ? (r.target.getAttribute('class') ?? '').toLowerCase() : '';
              if (['analytics','tracking','beacon','telemetry','coveo','atomic'].some(f => cls.includes(f))) { return false; }
            }
            return true;
          });
          if (!hasVisual) { noiseOnlyCount += records.length; return; }
          clearTimeout(stabilityTimer);
          stabilityTimer = setTimeout(checkAndSettle, stabilityWindowMs);
        }

        hardTimer = setTimeout(() => settle('DEGRADED'), hardTimeoutMs);
        observer = new MutationObserver(onMutations);
        observer.observe(document.documentElement, {
          childList: true, subtree: true, attributes: true,
          attributeFilter: [...NOISE_ATTR_NAMES, 'class'], characterData: false
        });
        stabilityTimer = setTimeout(checkAndSettle, stabilityWindowMs);
      });
    }

    const filters     = cfg.filters ?? null;
    const startTime   = performance.now();
    const captureQuality = await waitForReadiness();

    const visits   = traverseDocument(filters);
    const readings = executePass1(visits);
    const { filteredVisits, filteredReadings } = applyVisibilityFilter(visits, readings);

    const maxElements    = extractionCfg.maxElements;
    const overflow       = filteredVisits.length > maxElements;
    const clampedVisits  = overflow ? filteredVisits.slice(0, maxElements) : filteredVisits;
    const clampedReadings = overflow ? filteredReadings.slice(0, maxElements) : filteredReadings;

    const classOccurrenceMap = buildClassOccurrenceMap(clampedVisits);
    const elements           = await executeUnifiedPass(clampedVisits, clampedReadings, classOccurrenceMap);
    const duration           = Math.round(performance.now() - startTime);

    return {
      url:           window.location.href,
      title:         document.title || 'Untitled Page',
      timestamp:     new Date().toISOString(),
      totalElements: elements.length,
      extractOptions: {
        filtersApplied: Boolean(filters)
      },
      styleCategories: extractionCfg.styleCategories ?? ['typography','colors','spacing','layout','borders'],
      elements,
      duration,
      captureQuality,
      filters
    };
  };
}

module.exports = { getPageExtractorFn };