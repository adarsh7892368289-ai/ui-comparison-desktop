import * as XLSX       from 'xlsx';
import { get }        from '../../../config/defaults.js';
import { rowsToCsv }  from '../export-utils/csv-utils.js';
import {
  STRUCTURAL_COLUMN_COUNT,
  buildElementHeaders as _schemaHeaders,
  buildElementRow as _schemaRow }
from './report-table-schema.js';

const UTF8_BOM          = '\uFEFF';
const HEADER_FONT_COLOR = 'FFFFFF';

function _headerCellStyle(headerColor) {
  return {
    fill:      { patternType: 'solid', fgColor: { rgb: headerColor } },
    font:      { color: { rgb: HEADER_FONT_COLOR }, bold: true },
    alignment: { vertical: 'center', wrapText: false }
  };
}

function _applyFreezePane(ws) {
  ws['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', state: 'frozen' };
}

function _buildElementHeaders(cssProperties) {
  return _schemaHeaders(cssProperties);
}

function _buildElementRow(el, cssProperties) {
  return _schemaRow(el, cssProperties);
}

function _buildReportMetadataRows(report) {
  return [
    ['REPORT METADATA'],
    ['Report ID',       report.id],
    ['URL',             report.url],
    ['Title',           report.title],
    ['Timestamp',       report.timestamp],
    ['Total Elements',  report.totalElements],
    ['Duration (ms)',   report.duration       ?? 'N/A'],
    ['Capture Quality', report.captureQuality ?? 'N/A'],
    ['Version',         report.version        ?? ''],
    ['Filters',         report.filters        ? JSON.stringify(report.filters)        : ''],
    ['Extract Options', report.extractOptions  ? JSON.stringify(report.extractOptions) : ''],
    ['Capture Config',  report.captureConfig   ? JSON.stringify(report.captureConfig)  : ''],
    []
  ];
}

function buildExtractedReportCsv(report) {
  const cssProperties = get('extraction.cssProperties', []);
  const rows          = _buildReportMetadataRows(report);

  const cc = report.captureConfig;
  if (cc && typeof cc === 'object') {
    rows.push(['CAPTURE CONFIG']);
    rows.push(['Source',        cc.source       ?? 'local']);
    rows.push(['Device Type',   cc.deviceType   ?? 'N/A']);
    if (cc.deviceName) {rows.push(['Device Model', cc.deviceName]);}
    rows.push(['Viewport',      cc.viewport ? `${cc.viewport.width} x ${cc.viewport.height}` : 'N/A']);
    rows.push(['Screen',        cc.screenResolution ?? 'N/A']);
    rows.push(['Pixel Ratio',   cc.devicePixelRatio ?? 'N/A']);
    rows.push(['Orientation',   cc.orientation  ?? 'N/A']);
    rows.push(['Touch',         cc.hasTouch == null ? 'N/A' : (cc.hasTouch ? 'yes' : 'no')]);
    if (cc.userAgent) {rows.push(['User Agent', cc.userAgent]);}
    rows.push([]);
  }

  const filters = report.filters;
  if (filters && Object.values(filters).some(Boolean)) {
    rows.push(['FILTERS APPLIED']);
    rows.push(['Class Filter', filters.class || 'none']);
    rows.push(['ID Filter',    filters.id    || 'none']);
    rows.push(['Tag Filter',   filters.tag   || 'none']);
    rows.push([]);
  }

  const schema = report.extractOptions?.schema;
  if (schema) {
    rows.push(['SCHEMA OPTIONS']);
    rows.push(['Styles',          schema.includeStyles         ?? false]);
    rows.push(['Attributes',      schema.includeAttributes     ?? false]);
    rows.push(['Rect',            schema.includeRect           ?? false]);
    rows.push(['Neighbours',      schema.includeNeighbours     ?? false]);
    rows.push(['Class Hierarchy', schema.includeClassHierarchy ?? false]);
    rows.push([]);
  }

  rows.push(['EXTRACTED ELEMENTS']);
  rows.push(_buildElementHeaders(cssProperties));

  for (const el of (report.elements || [])) {
    rows.push(_buildElementRow(el, cssProperties));
  }

  return UTF8_BOM + rowsToCsv(rows);
}

function buildExtractedReportJson(report) {
  return JSON.stringify(report, null, 2);
}

function buildAllExtractedReportsCsv(reports) {
  const sections = reports.map((report, i) =>
    `## ===== REPORT ${i + 1} of ${reports.length} =====\n${buildExtractedReportCsv(report).replace(UTF8_BOM, '')}`
  );
  return UTF8_BOM + sections.join('\n\n');
}

function buildAllExtractedReportsJson(reports) {
  return JSON.stringify(reports, null, 2);
}

function buildExtractedReportExcel(report) {
  try {
    const cssProperties = get('extraction.cssProperties', []);
    const headerColor   = get('export.excel.headerColor');
    const wb            = XLSX.utils.book_new();

    const metaData = [
      ['Field', 'Value'],
      ['Report ID',       report.id],
      ['URL',             report.url],
      ['Title',           report.title],
      ['Timestamp',       report.timestamp],
      ['Total Elements',  report.totalElements],
      ['Duration (ms)',   report.duration       ?? 'N/A'],
      ['Capture Quality', report.captureQuality ?? 'N/A'],
      ['Version',         report.version        ?? ''],
      ['Filters',         report.filters        ? JSON.stringify(report.filters)        : ''],
      ['Extract Options', report.extractOptions  ? JSON.stringify(report.extractOptions) : ''],
      ['Capture Config',  report.captureConfig   ? JSON.stringify(report.captureConfig)  : '']
    ];

    const metaWs = XLSX.utils.aoa_to_sheet(metaData);
    metaWs['!cols'] = [{ wch: 20 }, { wch: 60 }];
    ['A1', 'B1'].forEach(addr => {
      if (metaWs[addr]) { metaWs[addr].s = _headerCellStyle(headerColor); }
    });
    _applyFreezePane(metaWs);
    XLSX.utils.book_append_sheet(wb, metaWs, 'Metadata');

    const headers     = _buildElementHeaders(cssProperties);
    const elementRows = (report.elements || []).map(el => _buildElementRow(el, cssProperties));
    const elemWs      = XLSX.utils.aoa_to_sheet([headers, ...elementRows]);

    const structuralCount = STRUCTURAL_COLUMN_COUNT;
    elemWs['!cols'] = [
      ...Array(structuralCount).fill({ wch: 20 }),
      ...cssProperties.map(() => ({ wch: 15 }))
    ];

    if (elemWs['!ref']) {
      const range = XLSX.utils.decode_range(elemWs['!ref']);
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r: 0, c });
        if (elemWs[addr]) { elemWs[addr].s = _headerCellStyle(headerColor); }
      }
    }
    _applyFreezePane(elemWs);
    XLSX.utils.book_append_sheet(wb, elemWs, 'Elements');

    const raw = XLSX.write(wb, { bookType: 'xlsx', type: 'array', cellStyles: true });
    return { success: true, data: raw instanceof Uint8Array ? raw : new Uint8Array(raw) };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function buildAllExtractedReportsExcel(reports) {
  try {
    const cssProperties = get('extraction.cssProperties', []);
    const headerColor   = get('export.excel.headerColor');
    const wb            = XLSX.utils.book_new();

    const summaryHeaders = ['Index', 'Report ID', 'URL', 'Title', 'Timestamp', 'Total Elements'];
    const summaryRows    = reports.map((r, i) => [
      i + 1,
      (r.id || '').substring(0, 8),
      r.url        ?? '',
      r.title      ?? '',
      r.timestamp  ?? '',
      r.totalElements ?? 0
    ]);

    const summaryWs = XLSX.utils.aoa_to_sheet([summaryHeaders, ...summaryRows]);
    summaryWs['!cols'] = [{ wch: 8 }, { wch: 12 }, { wch: 55 }, { wch: 30 }, { wch: 22 }, { wch: 14 }];

    if (summaryWs['!ref']) {
      const range = XLSX.utils.decode_range(summaryWs['!ref']);
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r: 0, c });
        if (summaryWs[addr]) { summaryWs[addr].s = _headerCellStyle(headerColor); }
      }
    }
    _applyFreezePane(summaryWs);
    XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary');

    const headers = _buildElementHeaders(cssProperties);

    reports.forEach((report, i) => {
      const aoa          = _buildReportMetadataRows(report);
      aoa.push(['EXTRACTED ELEMENTS']);
      aoa.push(headers);
      for (const el of (report.elements || [])) {
        aoa.push(_buildElementRow(el, cssProperties));
      }
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 24 }, { wch: 40 }];
      _applyFreezePane(ws);

      const sheetName = `Report_${i + 1}`.substring(0, 31);
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    });

    const raw = XLSX.write(wb, { bookType: 'xlsx', type: 'array', cellStyles: true });
    return { success: true, data: raw instanceof Uint8Array ? raw : new Uint8Array(raw) };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export {
  buildExtractedReportCsv,
  buildExtractedReportJson,
  buildAllExtractedReportsCsv,
  buildAllExtractedReportsJson,
  buildExtractedReportExcel,
  buildAllExtractedReportsExcel
};