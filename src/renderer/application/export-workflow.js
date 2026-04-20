import { getState }                          from '../state.js';
import { Toast }                              from '../ui.js';
import { sanitizeFilename, hostFromUrl }      from './report-manager.js';
import { normalizeComparisonResult }          from './compare-workflow.js';
import { exportToHTML }                       from '@core/export/comparison-exporters/html-exporter.js';
import { buildComparisonCsv }                 from '@core/export/comparison-exporters/csv-exporter.js';
import { buildComparisonJsonPayload }         from '@core/export/comparison-exporters/json-exporter.js';
import { exportToExcel }                      from '@core/export/comparison-exporters/excel-exporter.js';
import {
  buildExtractedReportCsv,
  buildExtractedReportJson,
  buildAllExtractedReportsCsv,
  buildAllExtractedReportsJson,
  buildExtractedReportExcel,
  buildAllExtractedReportsExcel,
} from '@core/export/extraction-exporters/report-exporter.js';
import {
  BULK_EXTRACTED_REPORT_EXPORT_FORMATS,
  SINGLE_EXTRACTED_REPORT_EXPORT_FORMATS,
} from '@core/export/extraction-exporters/extracted-report-export-catalog.js';
import storage from '../../infrastructure/idb-repository.js';

const api = window.electronAPI;

const BULK_EXTRACTED_REPORT_EXPORT_FORMAT_STORAGE_KEY = 'sidebar-export-format';

function _loadPersistedBulkExtractedReportsExportFormat() {
  try {
    const stored = localStorage.getItem(BULK_EXTRACTED_REPORT_EXPORT_FORMAT_STORAGE_KEY);
    if (stored && BULK_EXTRACTED_REPORT_EXPORT_FORMATS.has(stored)) { return stored; }
  } catch { void 0; }
  return 'xlsx';
}

let _bulkExtractedReportsExportFormat = _loadPersistedBulkExtractedReportsExportFormat();

function getBulkExportFormat() {
  return _bulkExtractedReportsExportFormat;
}

function setBulkExportFormat(exportFormat) {
  if (!exportFormat || !BULK_EXTRACTED_REPORT_EXPORT_FORMATS.has(exportFormat)) { return; }
  _bulkExtractedReportsExportFormat = exportFormat;
  try {
    localStorage.setItem(BULK_EXTRACTED_REPORT_EXPORT_FORMAT_STORAGE_KEY, exportFormat);
  } catch { void 0; }
}

function timedExport(promise, timeoutMs = 120_000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Export timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

async function handleExportReport(report, exportFormat) {
  if (!SINGLE_EXTRACTED_REPORT_EXPORT_FORMATS.has(exportFormat)) {
    Toast.error(`Unsupported extracted report export format: ${exportFormat}`);
    return;
  }

  let fullReport = report;
  try {
    const elements = await storage.loadReportElements(report.id);
    fullReport = { ...report, elements: elements ?? [] };
  } catch (_) {
    fullReport = { ...report, elements: [] };
  }

  const safeId = sanitizeFilename(report.id?.slice(0, 12) ?? 'report');
  const host   = sanitizeFilename(hostFromUrl(report.url));

  try {
    if (exportFormat === 'json') {
      const json         = buildExtractedReportJson(fullReport);
      const safeFilename = sanitizeFilename(`report-${host}-${safeId}.json`);
      const res = await timedExport(api.exportFile({ format: 'json', data: json, filename: safeFilename }));
      if (res.success)                   { Toast.success(`Saved to ${res.filePath}`); }
      else if (res.reason !== 'cancelled') { Toast.error(res.error ?? 'Export failed'); }
      return;
    }

    if (exportFormat === 'csv') {
      const csv          = buildExtractedReportCsv(fullReport);
      const safeFilename = sanitizeFilename(`report-${host}-${safeId}.csv`);
      const res = await timedExport(api.exportFile({ format: 'csv', data: csv, filename: safeFilename }));
      if (res.success)                   { Toast.success(`Saved to ${res.filePath}`); }
      else if (res.reason !== 'cancelled') { Toast.error(res.error ?? 'Export failed'); }
      return;
    }

    if (exportFormat === 'excel') {
      const result = buildExtractedReportExcel(fullReport);
      if (!result.success) { Toast.error(`Excel build failed: ${result.error}`); return; }
      const raw          = result.data;
      const data         = raw instanceof Uint8Array ? raw : new Uint8Array(raw.buffer, raw.byteOffset ?? 0, raw.byteLength);
      const safeFilename = sanitizeFilename(`report-${host}-${safeId}.xlsx`);
      const res = await timedExport(api.exportFile({ format: 'xlsx', data, filename: safeFilename }));
      if (res.success)                   { Toast.success(`Saved to ${res.filePath}`); }
      else if (res.reason !== 'cancelled') { Toast.error(res.error ?? 'Export failed'); }
      return;
    }

    Toast.error(`Unknown format: ${exportFormat}`);
  } catch (err) {
    Toast.error(err.message ?? 'Export failed');
  }
}

async function handleExportAllReports() {
  const state   = getState();
  const reports = state.reports ?? [];

  if (reports.length === 0) { Toast.info('No reports to export'); return; }

  const exportFormat = getBulkExportFormat();
  if (!BULK_EXTRACTED_REPORT_EXPORT_FORMATS.has(exportFormat)) {
    Toast.error('Unsupported bulk extracted report export format');
    return;
  }

  let fullReports;
  try {
    fullReports = await Promise.all(
      reports.map(async r => {
        const elements = await storage.loadReportElements(r.id).catch(() => []);
        return { ...r, elements: elements ?? [] };
      })
    );
  } catch (err) {
    Toast.error(`Failed to load report data: ${err.message}`);
    return;
  }

  const ts = new Date().toISOString().slice(0, 10);

  try {
    if (exportFormat === 'json') {
      const json         = buildAllExtractedReportsJson(fullReports);
      const safeFilename = sanitizeFilename(`all-reports-${ts}.json`);
      const res = await timedExport(api.exportFile({ format: 'json', data: json, filename: safeFilename }));
      if (res.success)                   { Toast.success(`Exported ${reports.length} reports`); }
      else if (res.reason !== 'cancelled') { Toast.error(res.error ?? 'Export failed'); }
      return;
    }

    if (exportFormat === 'csv') {
      const csv          = buildAllExtractedReportsCsv(fullReports);
      const safeFilename = sanitizeFilename(`all-reports-${ts}.csv`);
      const res = await timedExport(api.exportFile({ format: 'csv', data: csv, filename: safeFilename }));
      if (res.success)                   { Toast.success(`Exported ${reports.length} reports`); }
      else if (res.reason !== 'cancelled') { Toast.error(res.error ?? 'Export failed'); }
      return;
    }

    if (exportFormat === 'xlsx') {
      const result = buildAllExtractedReportsExcel(fullReports);
      if (!result.success) { Toast.error(`Excel build failed: ${result.error}`); return; }
      const raw          = result.data;
      const data         = raw instanceof Uint8Array ? raw : new Uint8Array(raw.buffer, raw.byteOffset ?? 0, raw.byteLength);
      const safeFilename = sanitizeFilename(`all-reports-${ts}.xlsx`);
      const res = await timedExport(api.exportFile({ format: 'xlsx', data, filename: safeFilename }));
      if (res.success)                   { Toast.success(`Exported ${reports.length} reports`); }
      else if (res.reason !== 'cancelled') { Toast.error(res.error ?? 'Export failed'); }
      return;
    }

    Toast.error(`Unknown format: ${exportFormat}`);
  } catch (err) {
    Toast.error(err.message ?? 'Export failed');
  }
}

async function handleExport() {
  const state  = getState();
  const result = state.comparison;
  if (!result) { Toast.error('No comparison result to export'); return; }

  const format = document.getElementById('export-format-select')?.value ?? 'html';
  const bId    = result.baselineId ?? result.baseline?.id ?? 'unknown';
  const cId    = result.compareId  ?? result.compare?.id  ?? 'unknown';

  if (format === 'html') {
    try {
      const normResult = normalizeComparisonResult(result);
      const html = await exportToHTML(normResult);
      if (html.length > 50_000_000) {
        Toast.info('Large report (>50MB) — browser may struggle to render');
      }
      const safeFilename = sanitizeFilename(`comparison-${bId}-vs-${cId}.html`);
      const res = await timedExport(api.exportHTML({ htmlContent: html, filename: safeFilename }));
      if (res.success)                   { Toast.success(`Saved to ${res.filePath}`); }
      else if (res.reason !== 'cancelled') { Toast.error(res.error ?? 'Export failed'); }
    } catch (err) {
      Toast.error(err.message ?? 'HTML export failed');
    }
    return;
  }

  if (format === 'csv') {
    try {
      const normResult   = normalizeComparisonResult(result);
      const csv          = buildComparisonCsv(normResult);
      const safeFilename = sanitizeFilename(`comparison-${bId}-vs-${cId}.csv`);
      const res = await timedExport(api.exportFile({ format: 'csv', data: csv, filename: safeFilename }));
      if (res.success)                   { Toast.success(`Saved to ${res.filePath}`); }
      else if (res.reason !== 'cancelled') { Toast.error(res.error ?? 'Export failed'); }
    } catch (err) {
      Toast.error(err.message ?? 'CSV export failed');
    }
    return;
  }

  if (format === 'json') {
    try {
      const normResult   = normalizeComparisonResult(result);
      const json         = JSON.stringify(buildComparisonJsonPayload(normResult), null, 2);
      const safeFilename = sanitizeFilename(`comparison-${bId}-vs-${cId}.json`);
      const res = await timedExport(api.exportFile({ format: 'json', data: json, filename: safeFilename }));
      if (res.success)                   { Toast.success(`Saved to ${res.filePath}`); }
      else if (res.reason !== 'cancelled') { Toast.error(res.error ?? 'Export failed'); }
    } catch (err) {
      Toast.error(err.message ?? 'JSON export failed');
    }
    return;
  }

  if (format === 'xlsx') {
    try {
      const normResult   = normalizeComparisonResult(result);
      const raw          = exportToExcel(normResult);
      const data         = raw instanceof Uint8Array ? raw : new Uint8Array(raw.buffer, raw.byteOffset ?? 0, raw.byteLength);
      const safeFilename = sanitizeFilename(`comparison-${bId}-vs-${cId}.xlsx`);
      const res = await timedExport(api.exportFile({ format: 'xlsx', data, filename: safeFilename }));
      if (res.success)                   { Toast.success(`Saved to ${res.filePath}`); }
      else if (res.reason !== 'cancelled') { Toast.error(res.error ?? 'Export failed'); }
    } catch (err) {
      Toast.error(err.message ?? 'Excel export failed');
    }
    return;
  }

  Toast.error(`Unknown format: ${format}`);
}

async function handleFullReport() {
  const capturedResult = getState().comparison;
  if (!capturedResult) { Toast.error('No comparison result to export'); return; }

  const btn  = document.getElementById('view-report-btn');
  const expB = document.getElementById('export-comparison-btn');
  if (btn)  { btn.disabled = true; btn.textContent = 'Generating…'; }
  if (expB) { expB.disabled = true; }

  try {
    const normResult = normalizeComparisonResult(capturedResult);
    const html = await exportToHTML(normResult);
    if (html.trim().length < 100) {
      throw new Error('Generated report is empty or invalid — IDB blob load may have failed');
    }
    if (html.length > 50_000_000) {
      Toast.warning('Report is very large — this may take a moment');
    }
    const res = await api.openReport({ htmlContent: html });
    if (res.success) {
      Toast.success('Report opened in new window');
    } else {
      Toast.error(res.error ?? 'Failed to open report');
    }
  } catch (err) {
    Toast.error(err.message ?? 'Failed to generate report');
  } finally {
    if (btn)  { btn.disabled = false; btn.textContent = 'Full Report'; }
    if (expB) { expB.disabled = false; }
  }
}

export {
  timedExport,
  handleExportReport,
  handleExportAllReports,
  handleExport,
  handleFullReport,
  getBulkExportFormat,
  setBulkExportFormat,
};