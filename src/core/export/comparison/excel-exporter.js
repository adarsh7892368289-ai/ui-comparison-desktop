import { get }  from '../../../config/defaults.js';
import logger    from '../../../infrastructure/logger.js';

const HEADER_FONT_COLOR = 'FFFFFF';

function getXLSX() {
  const {XLSX} = globalThis;
  if (!XLSX) {
    throw new Error('XLSX library not loaded. Ensure libs/xlsx.full.min.js is included before popup.js.');
  }
  return XLSX;
}

function _severityColor(severity) {
  return {
    critical: get('export.excel.criticalColor'),
    high:     get('export.excel.highColor'),
    medium:   get('export.excel.mediumColor'),
    low:      get('export.excel.lowColor')
  }[severity] ?? 'FFFFFF';
}

function _headerCellStyle(headerColor) {
  return {
    fill:      { patternType: 'solid', fgColor: { rgb: headerColor } },
    font:      { color: { rgb: HEADER_FONT_COLOR }, bold: true },
    alignment: { vertical: 'center', wrapText: false }
  };
}

function _severityCellStyle(severity) {
  const color  = _severityColor(severity);
  const isDark = severity === 'critical' || severity === 'high';
  return {
    fill: { patternType: 'solid', fgColor: { rgb: color } },
    font: { bold: isDark, color: { rgb: isDark ? HEADER_FONT_COLOR : '000000' } }
  };
}

function _applyHeaderRow(ws, XLSX) {
  if (!ws['!ref']) { return; }
  const headerColor = get('export.excel.headerColor');
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let {c} = range.s; c <= range.e.c; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[addr]) { ws[addr].s = _headerCellStyle(headerColor); }
  }
}

function _applyFreezePane(ws) {
  ws['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', state: 'frozen' };
}

function _applySeverityColumnStyles(ws, XLSX, severityColIndex, dataStartRow = 1) {
  if (!ws['!ref']) { return; }
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let r = dataStartRow; r <= range.e.r; r++) {
    const addr = XLSX.utils.encode_cell({ r, c: severityColIndex });
    const cell = ws[addr];
    if (cell?.v) { cell.s = _severityCellStyle(cell.v); }
  }
}

function exportToExcel(comparisonResult) {
  try {
    const XLSX = getXLSX();
    const wb   = XLSX.utils.book_new();

    _addSummarySheet(wb, comparisonResult, XLSX);
    _addDifferencesSheet(wb, comparisonResult, XLSX);
    _addMatchedElementsSheet(wb, comparisonResult, XLSX);
    _addUnmatchedSheet(wb, comparisonResult, XLSX);
    _addSeveritySheet(wb, comparisonResult, XLSX);

    const filename = `comparison-${comparisonResult.baseline.id}-vs-${comparisonResult.compare.id}.xlsx`;
    XLSX.writeFile(wb, filename, { cellStyles: true });

    logger.info('Excel export complete', { filename });
    return { success: true, filename };
  } catch (error) {
    logger.error('Excel export failed', { error: error.message });
    return { success: false, error: error.message };
  }
}

function _addSummarySheet(wb, result, XLSX) {
  const headerColor = get('export.excel.headerColor');
  const s           = result.comparison.summary;

  const data = [
    ['Field', 'Value'],
    ['', ''],
    ['Baseline ID',           result.baseline.id],
    ['Baseline URL',          result.baseline.url],
    ['Baseline Title',        result.baseline.title],
    ['Baseline Timestamp',    result.baseline.timestamp],
    ['Baseline Elements',     result.baseline.totalElements],
    ['', ''],
    ['Compare ID',            result.compare.id],
    ['Compare URL',           result.compare.url],
    ['Compare Title',         result.compare.title],
    ['Compare Timestamp',     result.compare.timestamp],
    ['Compare Elements',      result.compare.totalElements],
    ['', ''],
    ['Mode',                  result.mode],
    ['Duration (ms)',         result.duration],
    ['', ''],
    ['Total Matched',         result.matching.totalMatched],
    ['Match Rate',            `${result.matching.matchRate}%`],
    ['Unmatched (Baseline)',  result.matching.unmatchedBaseline],
    ['Unmatched (Compare)',   result.matching.unmatchedCompare],
    ['', ''],
    ['Total Elements',        s.totalElements],
    ['Unchanged Elements',    s.unchangedElements],
    ['Modified Elements (apex only)',  s.rootCauseCount ?? s.modifiedElements],
    ['Modified Elements (pre-filter)', s.modifiedElements],
    ['CSS Property Changes (propertyDiffCount)', s.propertyDiffCount ?? s.totalDifferences],
    ['', ''],
    ['Critical',              s.severityCounts.critical],
    ['High',                  s.severityCounts.high],
    ['Medium',                s.severityCounts.medium],
    ['Low',                   s.severityCounts.low]
  ];

  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{ wch: 28 }, { wch: 55 }];

  ['A1', 'B1'].forEach(addr => { if (ws[addr]) { ws[addr].s = _headerCellStyle(headerColor); } });

  const severityRows = { 28: 'critical', 29: 'high', 30: 'medium', 31: 'low' };
  Object.entries(severityRows).forEach(([rowIdx, severity]) => {
    const valueAddr = XLSX.utils.encode_cell({ r: parseInt(rowIdx, 10) - 1, c: 1 });
    if (ws[valueAddr]) { ws[valueAddr].s = _severityCellStyle(severity); }
  });

  XLSX.utils.book_append_sheet(wb, ws, 'Summary');
}

function _addDifferencesSheet(wb, result, XLSX) {
  const headers = [
    'Element ID', 'Tag Name', 'Element ID Attr', 'Class Name',
    'Property', 'Baseline Value', 'Compare Value',
    'Type', 'Category', 'Severity'
  ];

  const rows = [];
  for (const match of result.comparison.results) {
    for (const diff of (match.annotatedDifferences || [])) {
      rows.push([
        match.elementId,
        match.tagName,
        (match.baselineElement?.elementId || match.baselineElementId) || '',
        (match.baselineElement?.className || match.className) || '',
        diff.property,
        diff.baseValue    ?? '',
        diff.compareValue ?? '',
        diff.type,
        diff.category,
        diff.severity
      ]);
    }
  }

  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = [
    { wch: 12 }, { wch: 10 }, { wch: 20 }, { wch: 25 },
    { wch: 28 }, { wch: 32 }, { wch: 32 },
    { wch: 12 }, { wch: 14 }, { wch: 12 }
  ];

  _applyHeaderRow(ws, XLSX);
  _applyFreezePane(ws);
  _applySeverityColumnStyles(ws, XLSX, 9);

  XLSX.utils.book_append_sheet(wb, ws, 'Differences');
}

function _addMatchedElementsSheet(wb, result, XLSX) {
  const headers = [
    'Element ID', 'Tag Name', 'Element ID Attr', 'Class Name',
    'Match Strategy', 'Match Confidence', 'CSS Property Changes', 'Overall Severity'
  ];

  const rows = result.comparison.results.map(r => [
    r.elementId,
    r.tagName,
    (r.baselineElement?.elementId || r.baselineElementId) || '',
    (r.baselineElement?.className || r.className) || '',
    r.strategy,
    typeof r.confidence === 'number' ? r.confidence.toFixed(2) : '',
    r.totalDifferences,
    r.overallSeverity || 'none'
  ]);

  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = [
    { wch: 12 }, { wch: 10 }, { wch: 20 }, { wch: 25 },
    { wch: 18 }, { wch: 16 }, { wch: 18 }, { wch: 16 }
  ];

  _applyHeaderRow(ws, XLSX);
  _applyFreezePane(ws);
  _applySeverityColumnStyles(ws, XLSX, 7);

  XLSX.utils.book_append_sheet(wb, ws, 'Matched Elements');
}

function _addUnmatchedSheet(wb, result, XLSX) {
  const headers = ['Status', 'Element ID', 'Tag Name', 'Element ID Attr', 'Class Name'];
  const rows    = [];

  for (const el of result.unmatchedElements.baseline) {
    rows.push(['Only in Baseline (removed)', el.id, el.tagName, el.elementId || '', el.className || '']);
  }
  for (const el of result.unmatchedElements.compare) {
    rows.push(['Only in Compare (added)', el.id, el.tagName, el.elementId || '', el.className || '']);
  }

  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = [{ wch: 26 }, { wch: 12 }, { wch: 10 }, { wch: 20 }, { wch: 28 }];

  _applyHeaderRow(ws, XLSX);
  _applyFreezePane(ws);

  if (ws['!ref']) {
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let r = 1; r <= range.e.r; r++) {
      const statusAddr = XLSX.utils.encode_cell({ r, c: 0 });
      const cell = ws[statusAddr];
      if (!cell) { continue; }
      const color = cell.v.includes('Baseline') ? 'FFE0E0' : 'E0FFE0';
      cell.s = { fill: { patternType: 'solid', fgColor: { rgb: color } }, font: { bold: true } };
    }
  }

  XLSX.utils.book_append_sheet(wb, ws, 'Unmatched Elements');
}

function _addSeveritySheet(wb, result, XLSX) {
  const groups = { critical: [], high: [], medium: [], low: [] };

  for (const match of result.comparison.results) {
    for (const diff of (match.annotatedDifferences || [])) {
      if (groups[diff.severity]) {
        groups[diff.severity].push({
          elementId:    match.elementId,
          tagName:      match.tagName,
          property:     diff.property,
          baseValue:    diff.baseValue    ?? '',
          compareValue: diff.compareValue ?? ''
        });
      }
    }
  }

  const dataRows    = [];
  const styleQueue  = [];

  for (const severity of ['critical', 'high', 'medium', 'low']) {
    const items = groups[severity];

    const sectionRow = dataRows.length;
    dataRows.push([`${severity.toUpperCase()} — ${items.length} property change${items.length !== 1 ? 's' : ''}`, '', '', '', '']);
    styleQueue.push({ row: sectionRow, type: 'section', severity });

    if (items.length > 0) {
      const subHeaderRow = dataRows.length;
      dataRows.push(['Element ID', 'Tag', 'Property', 'Baseline Value', 'Compare Value']);
      styleQueue.push({ row: subHeaderRow, type: 'subheader' });

      for (const item of items) {
        dataRows.push([item.elementId, item.tagName, item.property, item.baseValue, item.compareValue]);
      }
    }

    dataRows.push(['', '', '', '', '']);
  }

  const ws = XLSX.utils.aoa_to_sheet(dataRows);
  ws['!cols'] = [{ wch: 14 }, { wch: 10 }, { wch: 28 }, { wch: 34 }, { wch: 34 }];

  if (ws['!ref']) {
    const headerColor = get('export.excel.headerColor');
    for (const entry of styleQueue) {
      for (let c = 0; c < 5; c++) {
        const addr = XLSX.utils.encode_cell({ r: entry.row, c });
        if (!ws[addr]) { continue; }
        ws[addr].s = entry.type === 'section'
          ? _severityCellStyle(entry.severity)
          : _headerCellStyle(headerColor);
      }
    }
  }

  XLSX.utils.book_append_sheet(wb, ws, 'By Severity');
}

export { exportToExcel };