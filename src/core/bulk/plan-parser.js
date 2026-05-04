'use strict';

const { get } = require('../../config/defaults.js');

const REQUIRED_HEADERS = ['baseline_url', 'compare_url'];
const OPTIONAL_HEADERS = ['mode', 'screenshots', 'label', 'browser', 'filter_class', 'filter_id', 'filter_tag'];
const KNOWN_HEADERS    = new Set([...REQUIRED_HEADERS, ...OPTIONAL_HEADERS]);

const TRUTHY_TOKENS = new Set(['true', 'yes', '1']);
const FALSY_TOKENS  = new Set(['false', 'no', '0']);

function columnIndexToLetters(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function lettersToColumnIndex(letters) {
  let n = 0;
  for (const ch of letters) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

function parseRef(ref) {
  if (typeof ref !== 'string' || !ref.includes(':')) {
    return null;
  }
  const [start, end] = ref.split(':');
  const startMatch = /^([A-Z]+)(\d+)$/.exec(start);
  const endMatch   = /^([A-Z]+)(\d+)$/.exec(end);
  if (!startMatch || !endMatch) { return null; }
  return {
    startCol: lettersToColumnIndex(startMatch[1]),
    startRow: parseInt(startMatch[2], 10),
    endCol:   lettersToColumnIndex(endMatch[1]),
    endRow:   parseInt(endMatch[2], 10),
  };
}

function readCellValue(worksheet, col, row) {
  const address = `${columnIndexToLetters(col)}${row}`;
  const cell    = worksheet[address];
  if (!cell) { return null; }
  const raw = cell.v;
  if (raw === null || raw === undefined) { return null; }
  return raw;
}

function trimOrNull(value) {
  if (value === null || value === undefined) { return null; }
  const str = String(value).trim();
  return str.length > 0 ? str : null;
}

function coerceScreenshots(rawValue) {
  const trimmed = trimOrNull(rawValue);
  if (trimmed === null) { return true; }
  const lower = trimmed.toLowerCase();
  if (TRUTHY_TOKENS.has(lower)) { return true; }
  if (FALSY_TOKENS.has(lower))  { return false; }
  return true;
}

function buildHeaderMap(worksheet, range) {
  const headers      = [];
  const headerToCol  = new Map();
  const seenLowered  = new Set();
  const headerRow    = range.startRow;

  for (let col = range.startCol; col <= range.endCol; col++) {
    const raw = readCellValue(worksheet, col, headerRow);
    const trimmed = trimOrNull(raw);
    if (trimmed === null) {
      headers.push(null);
      continue;
    }
    const lower = trimmed.toLowerCase();
    if (seenLowered.has(lower)) {
      return { error: `Duplicate column header: ${lower}` };
    }
    seenLowered.add(lower);
    headers.push(lower);
    if (KNOWN_HEADERS.has(lower)) {
      headerToCol.set(lower, col);
    }
  }

  return { headers, headerToCol };
}

function parsePlanWorksheet(worksheet) {
  if (!worksheet || typeof worksheet !== 'object') {
    return { headers: [], totalRowCount: 0, rows: [], error: 'Worksheet is empty or invalid' };
  }

  const range = parseRef(worksheet['!ref']);
  if (!range) {
    return { headers: [], totalRowCount: 0, rows: [], error: 'No URL pairs found in the first sheet' };
  }

  const headerResult = buildHeaderMap(worksheet, range);
  if (headerResult.error) {
    return { headers: [], totalRowCount: 0, rows: [], error: headerResult.error };
  }

  const { headers, headerToCol } = headerResult;

  for (const required of REQUIRED_HEADERS) {
    if (!headerToCol.has(required)) {
      return { headers, totalRowCount: 0, rows: [], error: `Missing required column: ${required}` };
    }
  }

  const dataStartRow = range.startRow + 1;
  const dataEndRow   = range.endRow;

  if (dataEndRow < dataStartRow) {
    return { headers, totalRowCount: 0, rows: [], error: 'No URL pairs found in the first sheet' };
  }

  const maxRows = get('bulk.maxRows');
  const totalRowCount = dataEndRow - dataStartRow + 1;

  if (totalRowCount > maxRows) {
    return {
      headers,
      totalRowCount,
      rows:  [],
      error: `Workbook contains ${totalRowCount} rows; maximum supported is ${maxRows}`,
    };
  }

  const rows = [];
  for (let r = dataStartRow; r <= dataEndRow; r++) {
    const baselineRaw = readCellValue(worksheet, headerToCol.get('baseline_url'), r);
    const compareRaw  = readCellValue(worksheet, headerToCol.get('compare_url'),  r);
    const modeRaw     = headerToCol.has('mode')        ? readCellValue(worksheet, headerToCol.get('mode'),        r) : null;
    const shotsRaw    = headerToCol.has('screenshots') ? readCellValue(worksheet, headerToCol.get('screenshots'), r) : null;
    const labelRaw    = headerToCol.has('label')       ? readCellValue(worksheet, headerToCol.get('label'),       r) : null;
    const browserRaw  = headerToCol.has('browser')     ? readCellValue(worksheet, headerToCol.get('browser'),     r) : null;
    const fClassRaw   = headerToCol.has('filter_class') ? readCellValue(worksheet, headerToCol.get('filter_class'), r) : null;
    const fIdRaw      = headerToCol.has('filter_id')    ? readCellValue(worksheet, headerToCol.get('filter_id'),    r) : null;
    const fTagRaw     = headerToCol.has('filter_tag')   ? readCellValue(worksheet, headerToCol.get('filter_tag'),   r) : null;

    const modeTrimmed = trimOrNull(modeRaw);
    const browserTrim = trimOrNull(browserRaw);

    rows.push({
      baseline_url: trimOrNull(baselineRaw) ?? '',
      compare_url:  trimOrNull(compareRaw)  ?? '',
      mode:         modeTrimmed === null ? 'dynamic' : modeTrimmed,
      screenshots:  coerceScreenshots(shotsRaw),
      label:        trimOrNull(labelRaw),
      browser:      browserTrim === null ? null : browserTrim.toLowerCase(),
      filter_class: trimOrNull(fClassRaw),
      filter_id:    trimOrNull(fIdRaw),
      filter_tag:   trimOrNull(fTagRaw),
      rowIndex:     r - dataStartRow,
    });
  }

  return { headers, totalRowCount, rows, error: null };
}

module.exports = { parsePlanWorksheet };
