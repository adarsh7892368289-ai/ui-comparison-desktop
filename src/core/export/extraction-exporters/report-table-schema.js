const NA = 'N/A';

function _jsonEncode(value) {
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function _jsonDecode(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function _numOrEmpty(value) {
  return value == null || value === '' ? '' : value;
}

function _toNumber(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function _str(raw) {
  if (raw == null) return '';
  return String(raw);
}

function _setRect(el, key, raw) {
  const n = _toNumber(raw);
  if (n == null) return;
  if (!el.rect) el.rect = {};
  el.rect[key] = n;
}

const ELEMENT_COLUMNS = [
  { header: 'HPID', get: (el) => el.hpid ?? '', set: (el, v) => { if (v !== '') el.hpid = _str(v); } },
  { header: 'Absolute HPID', get: (el) => el.absoluteHpid ?? '', set: (el, v) => { if (v !== '') el.absoluteHpid = _str(v); } },
  { header: 'Tag Name', get: (el) => el.tagName ?? '', set: (el, v) => { if (v !== '') el.tagName = _str(v); } },
  { header: 'Element ID', get: (el) => el.elementId ?? '', set: (el, v) => { if (v !== '') el.elementId = _str(v); } },
  { header: 'Class Name', get: (el) => el.className ?? '', set: (el, v) => { if (v !== '') el.className = _str(v); } },
  { header: 'Class Occurrence Count', get: (el) => el.classOccurrenceCount ?? '', set: (el, v) => { const n = _toNumber(v); if (n != null) el.classOccurrenceCount = n; } },
  { header: 'Text Content', get: (el) => el.textContent ?? '', set: (el, v) => { if (v !== '') el.textContent = _str(v); } },
  { header: 'CSS Selector', get: (el) => el.cssSelector ?? '', set: (el, v) => { if (v !== '') el.cssSelector = _str(v); } },
  { header: 'XPath', get: (el) => el.xpath ?? '', set: (el, v) => { if (v !== '') el.xpath = _str(v); } },
  { header: 'Shadow Path', get: (el) => el.shadowPath ?? '', set: (el, v) => { if (v !== '') el.shadowPath = _str(v); } },
  { header: 'Rect X', get: (el) => _numOrEmpty(el.rect?.x), set: (el, v) => _setRect(el, 'x', v) },
  { header: 'Rect Y', get: (el) => _numOrEmpty(el.rect?.y), set: (el, v) => _setRect(el, 'y', v) },
  { header: 'Rect Top', get: (el) => _numOrEmpty(el.rect?.top), set: (el, v) => _setRect(el, 'top', v) },
  { header: 'Rect Left', get: (el) => _numOrEmpty(el.rect?.left), set: (el, v) => _setRect(el, 'left', v) },
  { header: 'Width', get: (el) => _numOrEmpty(el.rect?.width), set: (el, v) => _setRect(el, 'width', v) },
  { header: 'Height', get: (el) => _numOrEmpty(el.rect?.height), set: (el, v) => _setRect(el, 'height', v) },
  { header: 'Tier', get: (el) => el.tier ?? '', set: (el, v) => { if (v !== '') el.tier = _str(v); } },
  { header: 'Depth', get: (el) => el.depth ?? '', set: (el, v) => { const n = _toNumber(v); if (n != null) el.depth = n; } },
  { header: 'Page Section', get: (el) => el.pageSection ?? '', set: (el, v) => { if (v !== '') el.pageSection = _str(v); } },
  { header: 'Class Hierarchy', get: (el) => (el.classHierarchy ? _jsonEncode(el.classHierarchy) : ''), set: (el, v) => { const d = _jsonDecode(v); if (d != null) el.classHierarchy = d; } },
  { header: 'Neighbours', get: (el) => (el.neighbours ? _jsonEncode(el.neighbours) : ''), set: (el, v) => { const d = _jsonDecode(v); if (d != null) el.neighbours = d; } },
  { header: 'Attributes', get: (el) => (el.attributes ? _jsonEncode(el.attributes) : ''), set: (el, v) => { const d = _jsonDecode(v); if (d != null) el.attributes = d; } },
];

const STRUCTURAL_COLUMN_COUNT = ELEMENT_COLUMNS.length;

function buildElementHeaders(cssProperties) {
  return [...ELEMENT_COLUMNS.map((c) => c.header), ...cssProperties];
}

function buildElementRow(el, cssProperties) {
  const base = ELEMENT_COLUMNS.map((c) => c.get(el));
  const styleValues = cssProperties.map((prop) => el.styles?.[prop] ?? '');
  return [...base, ...styleValues];
}

function rowToElement(headerRow, valueRow, cssProperties) {
  const el = {};
  for (let i = 0; i < ELEMENT_COLUMNS.length; i++) {
    const raw = valueRow[i];
    ELEMENT_COLUMNS[i].set(el, raw == null ? '' : raw);
  }
  const styleStart = ELEMENT_COLUMNS.length;
  const headerNames = headerRow || [];
  for (let i = 0; i < cssProperties.length; i++) {
    const colIdx = styleStart + i;
    const headerName = headerNames[colIdx] ?? cssProperties[i];
    const raw = valueRow[colIdx];
    if (raw != null && raw !== '') {
      if (!el.styles) el.styles = {};
      el.styles[headerName] = _str(raw);
    }
  }
  return el;
}

const METADATA_FIELDS = [
  { label: 'Report ID', set: (r, v) => { if (v && v !== NA) r.id = _str(v); } },
  { label: 'URL', set: (r, v) => { if (v) r.url = _str(v); } },
  { label: 'Title', set: (r, v) => { if (v) r.title = _str(v); } },
  { label: 'Timestamp', set: (r, v) => { if (v) r.timestamp = _str(v); } },
  { label: 'Total Elements', set: (r, v) => { const n = _toNumber(v); if (n != null) r.totalElements = n; } },
  { label: 'Duration (ms)', set: (r, v) => { const n = _toNumber(v); if (n != null) r.duration = n; } },
  { label: 'Capture Quality', set: (r, v) => { if (v && v !== NA) r.captureQuality = _str(v); } },
  { label: 'Version', set: (r, v) => { if (v) r.version = _str(v); } },
  { label: 'Filters', set: (r, v) => { const d = _jsonDecode(v); if (d) r.filters = d; } },
  { label: 'Extract Options', set: (r, v) => { const d = _jsonDecode(v); if (d) r.extractOptions = d; } },
  { label: 'Capture Config', set: (r, v) => { const d = _jsonDecode(v); if (d) r.captureConfig = d; } },
];

const METADATA_SETTERS = new Map(METADATA_FIELDS.map((f) => [f.label.toLowerCase(), f.set]));

export {
  NA,
  ELEMENT_COLUMNS,
  STRUCTURAL_COLUMN_COUNT,
  METADATA_FIELDS,
  METADATA_SETTERS,
  buildElementHeaders,
  buildElementRow,
  rowToElement,
  _jsonDecode,
  _toNumber,
};
