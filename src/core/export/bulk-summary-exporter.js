'use strict';

import * as XLSX from 'xlsx';
import { config as defaultsConfig } from '../../config/defaults.js';

const TEMPLATE_HEADERS = [
'baseline_url',
'compare_url',
'mode',
'filter_class',
'filter_id',
'filter_tag',
'screenshots',
'label',
'browser'];


const TEMPLATE_EXAMPLE_ROWS = [
{
  baseline_url: 'https://example.com',
  compare_url: 'https://staging.example.com',
  mode: 'dynamic',
  filter_class: '',
  filter_id: '',
  filter_tag: '',
  screenshots: 'true',
  label: 'Home page',
  browser: ''
},
{
  baseline_url: 'https://example.com/about',
  compare_url: 'https://staging.example.com/about',
  mode: 'static',
  filter_class: '',
  filter_id: '',
  filter_tag: '',
  screenshots: 'false',
  label: 'About page',
  browser: ''
}];


const TEMPLATE_COL_WIDTHS = {
  baseline_url: 40,
  compare_url: 40,
  mode: 12,
  filter_class: 20,
  filter_id: 20,
  filter_tag: 20,
  screenshots: 12,
  browser: 12,
  label: 25
};

const TEMPLATE_INSTRUCTIONS = [
'Bulk plan format — quick reference',
'',
'1. The plan must be the first sheet of the workbook. Headers are matched case-insensitively.',
'2. Required columns: baseline_url and compare_url. Both must start with http:// or https://.',
'3. Optional column "mode": dynamic (default) or static. Any other value invalidates the row.',
'4. Optional column "screenshots": true / false / yes / no / 1 / 0 / empty. Empty inherits the job-level toggle.',
'5. Optional column "label": free-text, truncated to 80 characters in the report.',
'6. Optional column "browser": chromium, firefox, webkit, or any displayName from your browser list. Empty inherits the job-level browser.',
'7. Maximum 500 rows per workbook. Larger workbooks are rejected.',
'8. Duplicate column headers (case-insensitive) cause the workbook to be rejected.',
'9. Invalid rows are skipped silently. The job runs as long as at least one row is valid.',
'10. Invalid rows still appear in the downloaded summary with status: invalid, so the audit trail is complete.'];


const SUMMARY_HEADERS = [
'pair_index',
'label',
'baseline_url',
'compare_url',
'mode',
'filter_class',
'filter_id',
'filter_tag',
'screenshots',
'browser',
'status',
'failure_reason',
'deduped',
'total_elements_baseline',
'total_elements_compare',
'match_rate_pct',
'added_count',
'removed_count',
'modified_count',
'severity_critical',
'severity_high',
'severity_medium',
'severity_low',
'duration_ms',
'comparison_id'];


const STATUS_COLUMN_INDEX = SUMMARY_HEADERS.indexOf('status');
const DEDUPED_COLUMN_INDEX = SUMMARY_HEADERS.indexOf('deduped');

function _excelColors() {
  const ex = defaultsConfig?.export?.excel ?? {};
  return {
    headerColor: ex.headerColor ?? '4472C4',
    criticalColor: ex.criticalColor ?? 'FF4444',
    mediumColor: ex.mediumColor ?? 'FFD700'
  };
}

function _solidFill(rgbHex) {
  return { fill: { patternType: 'solid', fgColor: { rgb: rgbHex }, bgColor: { rgb: rgbHex } } };
}

function _cellRef(rowIdx, colIdx) {
  return XLSX.utils.encode_cell({ r: rowIdx, c: colIdx });
}

function _setCellStyle(sheet, rowIdx, colIdx, style) {
  const ref = _cellRef(rowIdx, colIdx);
  if (!sheet[ref]) {return;}
  sheet[ref].s = { ...(sheet[ref].s ?? {}), ...style };
}

function _sanitiseError(raw) {
  if (raw == null) {return '';}
  return String(raw).replace(/\s+/g, ' ').trim().slice(0, 500);
}

function _normalisedStatus(status) {
  if (status === 'done' || status === 'failed' || status === 'cancelled' || status === 'invalid') {
    return status;
  }
  if (status === 'completed') {return 'done';}
  return 'failed';
}

function _browserLabel(pair) {
  const b = pair.browser;
  if (!b) {return '';}
  if (typeof b === 'string') {return b;}
  return b.displayName ?? b.browserType ?? '';
}

function _dedupedValue(pair) {
  if (typeof pair.deduped === 'string' && pair.deduped) {return pair.deduped;}
  const sides = pair.dedupedSides ?? null;
  if (sides && (sides.baseline || sides.compare)) {
    if (sides.baseline && sides.compare) {return 'both';}
    if (sides.baseline) {return 'baseline';}
    return 'compare';
  }
  return 'none';
}

function _summaryFrom(comparisonResult) {
  return comparisonResult?.comparison?.summary ?? comparisonResult?.summary ?? null;
}

function _matchingFrom(comparisonResult) {
  return comparisonResult?.matching ?? null;
}

function _buildSummaryRow(pair) {
  const baseline = pair.baselineReport ?? null;
  const compare = pair.compareReport ?? null;
  const comparison = pair.comparisonResult ?? null;
  const matching = _matchingFrom(comparison);
  const summary = _summaryFrom(comparison);
  const sev = summary?.severityCounts ?? null;

  const matchRatePct = matching?.matchRate != null ?
  Math.round(Number(matching.matchRate) * 100) / 100 :
  '';

  let durationMs = '';
  if (typeof comparison?.duration === 'number') {
    durationMs = Math.round(comparison.duration);
  } else if (pair.startedAt != null && pair.completedAt != null) {
    durationMs = pair.completedAt - pair.startedAt;
  }

  return {
    pair_index: (pair.pairIndex ?? 0) + 1,
    label: pair.label ?? '',
    baseline_url: pair.baselineUrl ?? '',
    compare_url: pair.compareUrl ?? '',
    mode: pair.mode ?? '',
    filter_class: pair.filterClass ?? '',
    filter_id: pair.filterId ?? '',
    filter_tag: pair.filterTag ?? '',
    screenshots: pair.includeScreenshots === false ? 'no' : 'yes',
    browser: _browserLabel(pair),
    status: _normalisedStatus(pair.status),
    failure_reason: _sanitiseError(pair.error),
    deduped: _dedupedValue(pair),
    total_elements_baseline: baseline?.totalElements ?? '',
    total_elements_compare: compare?.totalElements ?? '',
    match_rate_pct: matchRatePct,
    added_count: matching?.unmatchedCompare ?? '',
    removed_count: matching?.unmatchedBaseline ?? '',
    modified_count: summary?.modifiedElements ?? summary?.rootCauseCount ?? '',
    severity_critical: sev?.critical ?? 0,
    severity_high: sev?.high ?? 0,
    severity_medium: sev?.medium ?? 0,
    severity_low: sev?.low ?? 0,
    duration_ms: durationMs,
    comparison_id: comparison?.id ?? pair.comparisonId ?? ''
  };
}

function _applySummaryStyles(sheet, summaryRows) {
  const colors = _excelColors();
  const headerFill = _solidFill(colors.headerColor);
  const failedFill = _solidFill(colors.criticalColor);
  const cancelledFill = _solidFill(colors.mediumColor);
  const dedupedFill = _solidFill(colors.headerColor);

  for (let c = 0; c < SUMMARY_HEADERS.length; c++) {
    _setCellStyle(sheet, 0, c, { ...headerFill, font: { bold: true } });
  }

  summaryRows.forEach((row, i) => {
    const rowIdx = i + 1;
    if (row.status === 'failed') {
      _setCellStyle(sheet, rowIdx, STATUS_COLUMN_INDEX, failedFill);
    } else if (row.status === 'cancelled' || row.status === 'invalid') {
      _setCellStyle(sheet, rowIdx, STATUS_COLUMN_INDEX, cancelledFill);
    }
    if (row.deduped && row.deduped !== 'none') {
      _setCellStyle(sheet, rowIdx, DEDUPED_COLUMN_INDEX, dedupedFill);
    }
  });
}

function _buildInvalidSummaryRow(parsedRow) {
  const baseline = parsedRow?.baseline_url ?? parsedRow?.baselineUrl ?? '';
  const compare = parsedRow?.compare_url ?? parsedRow?.compareUrl ?? '';
  const pairIndex = typeof parsedRow?.rowIndex === 'number' ?
  parsedRow.rowIndex + 1 :
  '';
  return {
    pair_index: pairIndex,
    label: parsedRow?.label ?? '',
    baseline_url: baseline,
    compare_url: compare,
    mode: parsedRow?.mode ?? '',
    filter_class: parsedRow?.filter_class ?? '',
    filter_id: parsedRow?.filter_id ?? '',
    filter_tag: parsedRow?.filter_tag ?? '',
    screenshots: '',
    browser: _browserLabel({ browser: parsedRow?.resolvedBrowser ?? null }),
    status: 'invalid',
    failure_reason: _sanitiseError(parsedRow?.validationReason),
    deduped: 'none',
    total_elements_baseline: '',
    total_elements_compare: '',
    match_rate_pct: '',
    added_count: '',
    removed_count: '',
    modified_count: '',
    severity_critical: '',
    severity_high: '',
    severity_medium: '',
    severity_low: '',
    duration_ms: '',
    comparison_id: ''
  };
}

function _setSummaryColWidths(sheet) {
  sheet['!cols'] = SUMMARY_HEADERS.map((h) => {
    if (h === 'baseline_url' || h === 'compare_url') {return { wch: 40 };}
    if (h === 'failure_reason') {return { wch: 50 };}
    if (h === 'comparison_id') {return { wch: 38 };}
    if (h === 'label') {return { wch: 25 };}
    if (h === 'filter_class' || h === 'filter_id' || h === 'filter_tag') {return { wch: 20 };}
    return { wch: Math.max(12, h.length + 2) };
  });
}

function buildBulkSummaryWorkbook(job, pairs, invalidRows = []) {
  const executedRows = (pairs ?? []).map(_buildSummaryRow);
  const invalidSummaryRows = (invalidRows ?? []).map(_buildInvalidSummaryRow);
  const summaryRows = [...executedRows, ...invalidSummaryRows];

  const sheet = XLSX.utils.json_to_sheet(summaryRows, { header: SUMMARY_HEADERS });
  _setSummaryColWidths(sheet);
  _applySummaryStyles(sheet, summaryRows);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Bulk Summary');

  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}

function _setTemplateColWidths(sheet) {
  sheet['!cols'] = TEMPLATE_HEADERS.map((h) => ({ wch: TEMPLATE_COL_WIDTHS[h] ?? 12 }));
}

function _freezeTemplateHeader(sheet) {
  sheet['!freeze'] = { xSplit: 0, ySplit: 1 };
  sheet['!views'] = [{ state: 'frozen', xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft' }];
}

function _buildInstructionsSheet() {
  const aoa = TEMPLATE_INSTRUCTIONS.map((line) => [line]);
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  sheet['!cols'] = [{ wch: 100 }];
  return sheet;
}

function buildBulkTemplateWorkbook() {
  const rows = TEMPLATE_EXAMPLE_ROWS.map((row) => {
    const ordered = {};
    for (const h of TEMPLATE_HEADERS) {ordered[h] = row[h] ?? '';}
    return ordered;
  });

  const planSheet = XLSX.utils.json_to_sheet(rows, { header: TEMPLATE_HEADERS });
  _setTemplateColWidths(planSheet);
  _freezeTemplateHeader(planSheet);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, planSheet, 'Plan');
  XLSX.utils.book_append_sheet(wb, _buildInstructionsSheet(), 'Instructions');

  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}

export {
  buildBulkTemplateWorkbook,
  buildBulkSummaryWorkbook,
  TEMPLATE_HEADERS,
  SUMMARY_HEADERS };