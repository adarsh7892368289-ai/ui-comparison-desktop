import * as XLSX from 'xlsx';
import storage from '../../infrastructure/idb-repository.js';
import { dispatch, getState } from '../state.js';
import { Toast, Modal, syncCompareButton } from '../ui.js';
import { loadAndRenderReports } from './report-manager.js';
import { syncReportSelectTrigger } from '../components/report-select-combobox.js';
import { tryLoadCachedComparison } from './compare-workflow.js';
import { parseReportAoa } from '@core/export/extraction-exporters/report-table-parser.js';
import { unescapeCsv } from '@core/export/export-utils/csv-utils.js';

const api = window.electronAPI;

const CSV_REPORT_SEPARATOR = /^##\s*=====\s*REPORT\s+\d+/iu;
const BOM_CODE = 0xFEFF;

function _stripBom(text) {
  return text && text.charCodeAt(0) === BOM_CODE ? text.slice(1) : text;
}

function _sheetToAoa(sheet) {
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: true });
}

function _splitCsvIntoReportBlocks(content) {
  const lines = _stripBom(content).split(/\r?\n/u);
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (CSV_REPORT_SEPARATOR.test(line.trim())) {
      if (current && current.length) blocks.push(current);
      current = [];
      continue;
    }
    if (current == null) current = [];
    current.push(line);
  }
  if (current && current.length) blocks.push(current);
  return blocks.length ? blocks : [lines];
}

function parseCsvToReports(content) {
  const blocks = _splitCsvIntoReportBlocks(content);
  const reports = [];
  for (const block of blocks) {
    const csv = block.join('\n');
    let aoa;
    try {
      const wb = XLSX.read(csv, { type: 'string' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      if (!sheet) continue;
      aoa = _sheetToAoa(sheet).map((row) =>
        (Array.isArray(row) ? row.map(unescapeCsv) : row));
    } catch (err) {
      console.warn('CSV import: failed to parse block —', err.message);
      continue;
    }
    const report = parseReportAoa(aoa);
    if (report) reports.push(report);
  }
  return reports;
}

function parseExcelToReports(base64Content) {
  const buffer = Uint8Array.from(atob(base64Content), (c) => c.charCodeAt(0));
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'array' });
  } catch (err) {
    console.warn('Excel import: failed to parse workbook —', err.message);
    return [];
  }

  const names = workbook.SheetNames || [];
  const reports = [];
  const metaSheet = names.find((n) => /^metadata$/iu.test(n));
  const reportSheets = names.filter((n) => /^report[_\s]?\d+/iu.test(n));

  if (reportSheets.length > 0) {
    for (const name of reportSheets) {
      const report = parseReportAoa(_sheetToAoa(workbook.Sheets[name]));
      if (report) reports.push(report);
    }
    return reports;
  }

  if (metaSheet) {
    const combined = [..._sheetToAoa(workbook.Sheets[metaSheet])];
    const elemSheet = names.find((n) => /^elements$/iu.test(n));
    if (elemSheet) {
      combined.push(['EXTRACTED ELEMENTS']);
      const elemRows = _sheetToAoa(workbook.Sheets[elemSheet]);
      for (const r of elemRows) combined.push(r);
    }
    const report = parseReportAoa(combined);
    if (report) reports.push(report);
    return reports;
  }

  const sheet = workbook.Sheets[names[0]];
  if (sheet) {
    const report = parseReportAoa(_sheetToAoa(sheet));
    if (report) reports.push(report);
  }
  return reports;
}

async function handleImportReport(file, slot) {
  if (!file) { return; }
  try {
    let ipcResult;
    if (file instanceof File) {
      const ext = (file.name.split('.').pop() ?? '').toLowerCase();
      if (ext === 'xlsx' || ext === 'xls') {
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) { binary += String.fromCharCode(bytes[i]); }
        ipcResult = { success: true, ext, content: btoa(binary) };
      } else {
        ipcResult = { success: true, ext, content: await file.text() };
      }
    } else {
      ipcResult = await api.importFile();
    }
    if (!ipcResult.success) {
      if (ipcResult.reason !== 'cancelled') {
        Toast.error(ipcResult.error ?? 'Import failed');
      }
      return;
    }

    let parsedReports;
    try {
      if (ipcResult.ext === 'json') {
        const json = JSON.parse(ipcResult.content);
        parsedReports = Array.isArray(json) ? json : [json];
      } else if (ipcResult.ext === 'csv') {
        parsedReports = parseCsvToReports(ipcResult.content);
        if (!parsedReports.length) {
          Toast.error('CSV format not recognised — check the file was exported from this application');
          return;
        }
      } else if (ipcResult.ext === 'xlsx' || ipcResult.ext === 'xls') {
        parsedReports = parseExcelToReports(ipcResult.content);
        if (!parsedReports.length) {
          Toast.error('Excel format not recognised — check the file was exported from this application');
          return;
        }
      } else {
        Toast.info(`Unsupported file type ".${ipcResult.ext}" — use JSON, CSV, or Excel`);
        return;
      }
    } catch {
      Toast.error('Could not parse imported file');
      return;
    }

    const valid = (parsedReports || []).filter((r) => r && r.url);
    if (!valid.length) {
      Toast.error('Imported file does not contain a valid report');
      return;
    }

    const targetsSlot = slot === 'baseline' || slot === 'compare';
    const toImport = targetsSlot ? valid.slice(0, 1) : valid;

    let importedCount = 0;
    let skipped = 0;
    let lastImported = null;

    for (const report of toImport) {
      const reports  = getState().reports ?? [];
      const existing = reports.find((r) => r.url === report.url);
      if (existing) {
        const label = toImport.length > 1 ? ` (${importedCount + skipped + 1}/${toImport.length})` : '';
        const confirmed = await Modal.confirm(
          'Duplicate report',
          `A report from "${report.url}" already exists. Replace it?${label}`,
          { confirmText: 'Replace' }
        );
        if (!confirmed) { skipped++; continue; }
        await storage.deleteReport(existing.id);
      }

      const imported = {
        ...report,
        id:        report.id        ?? crypto.randomUUID(),
        timestamp: report.timestamp ?? new Date().toISOString(),
        source:    report.source    ?? 'imported',
      };

      await storage.saveReport(imported);
      lastImported = imported;
      importedCount++;
    }

    await loadAndRenderReports();

    if (importedCount === 0) {
      Toast.info('No reports imported');
      return;
    }

    if (!targetsSlot) {
      syncCompareButton();
      tryLoadCachedComparison();
      Toast.success(importedCount === 1
        ? 'Imported report — select it in Compare to use it.'
        : `Imported ${importedCount} reports — select them in Compare to use them.`);
      return;
    }

    const selId = slot === 'baseline' ? 'baseline-report' : 'compare-report';
    const sel   = document.getElementById(selId);
    if (sel && lastImported) {
      sel.value = lastImported.id;
      syncReportSelectTrigger(sel);
    }

    if (lastImported) {
      const actionKey = slot === 'baseline' ? 'BASELINE_SELECTED' : 'COMPARE_SELECTED';
      dispatch(actionKey, { id: lastImported.id });
    }
    syncCompareButton();

    Toast.success(`Report imported — ${lastImported?.totalElements ?? 0} elements`);
  } catch (err) {
    Toast.error(err.message ?? 'Import failed');
  }
}

export { handleImportReport };