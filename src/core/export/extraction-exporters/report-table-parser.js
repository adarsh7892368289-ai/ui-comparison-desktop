import { get } from '../../../config/defaults.js';
import {
  STRUCTURAL_COLUMN_COUNT,
  METADATA_SETTERS,
  buildElementHeaders,
  rowToElement,
  _jsonDecode,
  _toNumber,
} from './report-table-schema.js';

const ELEMENTS_MARKER = 'extracted elements';
const META_MARKER = 'report metadata';

function _cell(row, i) {
  if (!Array.isArray(row)) return '';
  const v = row[i];
  return v == null ? '' : v;
}

function _norm(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function _firstCellNorm(row) {
  return _norm(_cell(row, 0));
}

function _isVerticalReport(aoa) {
  for (const row of aoa) {
    const c0 = _firstCellNorm(row);
    if (c0 === META_MARKER || c0 === ELEMENTS_MARKER) return true;
    if (c0 === 'field' && _norm(_cell(row, 1)) === 'value') return true;
  }
  return false;
}

function _parseVertical(aoa, cssProperties) {
  const report = {};
  let i = 0;
  let elementsHeader = null;
  const elementRows = [];

  while (i < aoa.length) {
    const row = aoa[i];
    const marker = _firstCellNorm(row);

    if (marker === ELEMENTS_MARKER) {
      elementsHeader = aoa[i + 1] || buildElementHeaders(cssProperties);
      for (let j = i + 2; j < aoa.length; j++) {
        const r = aoa[j];
        if (!Array.isArray(r) || r.every((c) => c == null || c === '')) continue;
        elementRows.push(r);
      }
      break;
    }

    const label = _norm(_cell(row, 0));
    const setter = METADATA_SETTERS.get(label);
    if (setter) {
      setter(report, _cell(row, 1));
    }
    i++;
  }

  if (!report.captureConfig) {
    const cc = _reconstructCaptureConfig(aoa);
    if (cc) report.captureConfig = cc;
  }

  const styleCount = Math.max(0, (elementsHeader?.length ?? 0) - STRUCTURAL_COLUMN_COUNT);
  const effectiveStyleProps = styleCount > 0
    ? (elementsHeader || []).slice(STRUCTURAL_COLUMN_COUNT, STRUCTURAL_COLUMN_COUNT + styleCount)
    : cssProperties;

  report.elements = elementRows.map((r) => rowToElement(elementsHeader, r, effectiveStyleProps));
  if (report.totalElements == null) {
    report.totalElements = report.elements.length;
  }

  return report.url ? report : null;
}

function _reconstructCaptureConfig(aoa) {
  let inBlock = false;
  const fields = {};
  for (const row of aoa) {
    const c0 = _norm(_cell(row, 0));
    if (c0 === 'capture config') { inBlock = true; continue; }
    if (!inBlock) continue;
    if (!c0) break;
    fields[c0] = _cell(row, 1);
  }
  if (Object.keys(fields).length === 0) return null;

  const na = (v) => (v == null || v === '' || String(v).toLowerCase() === 'n/a' ? null : v);
  const cc = {
    source: na(fields.source) || 'local',
    deviceType: na(fields['device type']) || null,
    deviceName: na(fields['device model']) || null,
    viewport: null,
    devicePixelRatio: _toNumber(na(fields['pixel ratio'])),
    screenResolution: na(fields.screen) || null,
    orientation: na(fields.orientation) || null,
    hasTouch: fields.touch == null ? null : String(fields.touch).toLowerCase() === 'yes',
    userAgent: na(fields['user agent']) || null,
  };
  const vp = na(fields.viewport);
  if (vp) {
    const m = String(vp).match(/(\d+)\s*[x×]\s*(\d+)/i);
    if (m) cc.viewport = { width: Number(m[1]), height: Number(m[2]) };
  }
  return cc;
}

function _parseFlat(aoa) {
  if (aoa.length < 1) return null;
  const headers = aoa[0].map((h) => _norm(h));
  const urlIdx = headers.indexOf('url');
  if (urlIdx === -1) return null;

  const dataRow = aoa[1];
  if (!dataRow) return null;

  const col = (name) => {
    const idx = headers.indexOf(name);
    return idx === -1 ? '' : _cell(dataRow, idx);
  };

  const report = {
    id: col('id') || undefined,
    name: col('name') || col('url'),
    url: col('url'),
    timestamp: col('timestamp') || undefined,
    environment: col('environment') || null,
    schemaVersion: col('schemaversion') || null,
  };

  const elementsRaw = col('elements');
  const decodedElements = _jsonDecode(elementsRaw);
  if (Array.isArray(decodedElements)) {
    report.elements = decodedElements;
  } else if (aoa.length > 2) {
    report.elements = aoa.slice(1).map((r) => {
      const obj = {};
      headers.forEach((h, idx) => { obj[h] = _cell(r, idx); });
      return obj;
    });
  } else {
    report.elements = [];
  }

  const cc = _jsonDecode(col('captureconfig'));
  if (cc) report.captureConfig = cc;

  return report.url ? report : null;
}

function parseReportAoa(aoa) {
  if (!Array.isArray(aoa) || aoa.length === 0) return null;
  const cssProperties = get('extraction.cssProperties', []);
  if (_isVerticalReport(aoa)) {
    return _parseVertical(aoa, cssProperties);
  }
  return _parseFlat(aoa);
}

export { parseReportAoa };
