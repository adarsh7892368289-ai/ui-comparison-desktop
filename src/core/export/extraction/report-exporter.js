/**
 * Serialises extracted element reports to CSV, JSON, and XLSX formats.
 * Runs in the popup context — depends on the global XLSX library and document.createElement.
 * Invariant: never throws — all XLSX paths catch internally and return {success:false}.
 * Called by: export-workflow.js (all six exported build functions).
 */
import { get }        from '../../../config/defaults.js';
import { rowsToCsv }  from '../shared/csv-utils.js';

const UTF8_BOM          = '\uFEFF';
const CSV_TEXT_MAX      = 200;
const HEADER_FONT_COLOR = 'FFFFFF';

/**
 * Retrieves the global XLSX library object.
 * @throws {Error} When libs/xlsx.full.min.js has not been loaded before this call.
 */
function getXLSX() {
  const { XLSX } = globalThis;
  if (!XLSX) {
    throw new Error('XLSX library not loaded. Ensure libs/xlsx.full.min.js is included before popup.js.');
  }
  return XLSX;
}

/** Returns an XLSX cell style object for bold header cells with the configured fill colour. */
function _headerCellStyle(headerColor) {
  return {
    fill:      { patternType: 'solid', fgColor: { rgb: headerColor } },
    font:      { color: { rgb: HEADER_FONT_COLOR }, bold: true },
    alignment: { vertical: 'center', wrapText: false }
  };
}

/** Freezes the top row of a worksheet so headers stay visible while scrolling. */
function _applyFreezePane(ws) {
  ws['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', state: 'frozen' };
}

/**
 * Returns the ordered column header array for an element export.
 * CSS properties are appended after the 22 structural columns.
 * display, visibility, and opacity are intentionally absent here — they appear
 * via the cssProperties spread and must not be duplicated as structural columns.
 * @param {string[]} cssProperties - Ordered list of CSS property names to append as columns.
 * @returns {string[]} Full header array.
 */
function _buildElementHeaders(cssProperties) {
  return [
    'HPID',
    'Absolute HPID',
    'Tag Name',
    'Element ID',
    'Class Name',
    'Class Occurrence Count',
    'Text Content',
    'CSS Selector',
    'XPath',
    'Shadow Path',
    'Rect X',
    'Rect Y',
    'Rect Top',
    'Rect Left',
    'Width',
    'Height',
    'Tier',
    'Depth',
    'Page Section',
    'Class Hierarchy',
    'Neighbours',
    'Attributes',
    ...cssProperties
  ];
}

/**
 * Maps one extracted element to a flat value array matching the _buildElementHeaders order.
 * textContent is capped at CSV_TEXT_MAX characters to keep cell sizes manageable.
 * JSON columns (classHierarchy, neighbours, attributes) are serialised to a single string.
 * @param {object} el - Extracted element object from the report.
 * @param {string[]} cssProperties - Ordered list of CSS property names to resolve from el.styles.
 * @returns {Array} Row value array aligned to _buildElementHeaders.
 */
function _buildElementRow(el, cssProperties) {
  const styleValues = cssProperties.map(prop => el.styles?.[prop] ?? '');
  return [
    el.hpid                ?? '',
    el.absoluteHpid        ?? '',
    el.tagName             ?? '',
    el.elementId           ?? '',
    el.className           ?? '',
    el.classOccurrenceCount ?? 0,
    (el.textContent ?? '').substring(0, CSV_TEXT_MAX),
    el.cssSelector         ?? '',
    el.xpath               ?? '',
    el.shadowPath          ?? '',
    el.rect?.x             ?? '',
    el.rect?.y             ?? '',
    el.rect?.top           ?? '',
    el.rect?.left          ?? '',
    el.rect?.width         ?? '',
    el.rect?.height        ?? '',
    el.tier                ?? '',
    el.depth               ?? '',
    el.pageSection         ?? '',
    el.classHierarchy ? JSON.stringify(el.classHierarchy) : '',
    el.neighbours     ? JSON.stringify(el.neighbours)     : '',
    el.attributes     ? JSON.stringify(el.attributes)     : '',
    ...styleValues
  ];
}

/**
 * Builds a multi-section BOM-prefixed CSV string for a single extraction report.
 * Sections: report metadata, optional filters, optional schema options, element rows.
 * @param {object} report - Extraction report object from idb-repository.
 * @returns {string} BOM-prefixed CSV string.
 */
function buildExtractedReportCsv(report) {
  const cssProperties = get('extraction.cssProperties', []);
  const rows          = [];

  rows.push(['REPORT METADATA']);
  rows.push(['Report ID',       report.id]);
  rows.push(['URL',             report.url]);
  rows.push(['Title',           report.title]);
  rows.push(['Timestamp',       report.timestamp]);
  rows.push(['Total Elements',  report.totalElements]);
  rows.push(['Duration (ms)',   report.duration       ?? 'N/A']);
  rows.push(['Capture Quality', report.captureQuality ?? 'N/A']);
  rows.push([]);

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

/** Serialises a single report to a pretty-printed JSON string. */
function buildExtractedReportJson(report) {
  return JSON.stringify(report, null, 2);
}

/**
 * Concatenates multiple reports into one BOM-prefixed CSV with a separator header
 * between each report section. The BOM on inner reports is stripped to avoid
 * duplicates mid-file.
 */
function buildAllExtractedReportsCsv(reports) {
  const sections = reports.map((report, i) =>
    `## ===== REPORT ${i + 1} of ${reports.length} =====\n${buildExtractedReportCsv(report).replace(UTF8_BOM, '')}`
  );
  return UTF8_BOM + sections.join('\n\n');
}

/** Serialises all reports to a pretty-printed JSON array string. */
function buildAllExtractedReportsJson(reports) {
  return JSON.stringify(reports, null, 2);
}

/**
 * Builds a two-sheet XLSX workbook (Metadata + Elements) for one report.
 * Never throws — XLSX errors are caught and returned as {success:false, error}.
 * @returns {{ success: true, filename: string } | { success: false, error: string }}
 */
function buildExtractedReportExcel(report) {
  try {
    const XLSX          = getXLSX();
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
      ['Extract Options', report.extractOptions  ? JSON.stringify(report.extractOptions) : '']
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

    // 23 structural columns (up to and including 'Attributes') at wch:20; CSS props at wch:15.
    const structuralCount = 23;
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

    const filename = `report-${report.id}.xlsx`;
    XLSX.writeFile(wb, filename, { cellStyles: true });

    return { success: true, filename };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Builds an XLSX workbook with a Summary sheet plus one Elements sheet per report.
 * Never throws — errors are caught and returned as {success:false, error}.
 * @returns {{ success: true, filename: string } | { success: false, error: string }}
 */
function buildAllExtractedReportsExcel(reports) {
  try {
    const XLSX          = getXLSX();
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

    const headers         = _buildElementHeaders(cssProperties);
    const structuralCount = 23; // columns up to and including 'Attributes'

    reports.forEach((report, i) => {
      const elementRows = (report.elements || []).map(el => _buildElementRow(el, cssProperties));
      const ws          = XLSX.utils.aoa_to_sheet([headers, ...elementRows]);

      ws['!cols'] = [
        ...Array(structuralCount).fill({ wch: 20 }),
        ...cssProperties.map(() => ({ wch: 15 }))
      ];

      if (ws['!ref']) {
        const range = XLSX.utils.decode_range(ws['!ref']);
        for (let c = range.s.c; c <= range.e.c; c++) {
          const addr = XLSX.utils.encode_cell({ r: 0, c });
          if (ws[addr]) { ws[addr].s = _headerCellStyle(headerColor); }
        }
      }
      _applyFreezePane(ws);

      // XLSX sheet names are capped at 31 characters.
      const sheetName = `Report_${i + 1}`.substring(0, 31);
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    });

    const filename = 'all-reports.xlsx';
    XLSX.writeFile(wb, filename, { cellStyles: true });

    return { success: true, filename };
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