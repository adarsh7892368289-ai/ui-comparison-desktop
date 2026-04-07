import * as XLSX from 'xlsx';
import storage from '../../infrastructure/idb-repository.js';
import { dispatch, getState } from '../state.js';
import { Toast, Modal, syncCompareButton } from '../ui.js';
import { loadAndRenderReports } from './report-manager.js';
import { tryLoadCachedComparison } from './compare-workflow.js';

const api = window.electronAPI;

function parseCsvToReport(content) {
  let rows;
  try {
    const workbook  = XLSX.read(content, { type: 'string' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      console.warn('CSV import: no sheet found in file');
      return null;
    }
    rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
  } catch (parseErr) {
    console.warn('CSV import: failed to parse CSV —', parseErr.message);
    return null;
  }

  if (!rows.length) {
    console.warn('CSV import: no data rows found');
    return null;
  }

  const first = rows[0];
  if (!first.url) {
    console.warn('CSV import: unknown CSV format — no url column found; import skipped');
    return null;
  }

  let elements = [];
  if (typeof first.elements === 'string' && first.elements) {
    try {
      elements = JSON.parse(first.elements);
    } catch {
      elements = [];
    }
  } else if (rows.length > 1) {
    elements = rows.map(r => ({ ...r }));
  }

  return {
    id:            first.id            || crypto.randomUUID(),
    name:          first.name          || first.url,
    url:           first.url,
    timestamp:     first.timestamp     || new Date().toISOString(),
    environment:   first.environment   || null,
    schemaVersion: first.schemaVersion || null,
    elements,
  };
}

function parseExcelToReport(base64Content) {
  const buffer = Uint8Array.from(atob(base64Content), c => c.charCodeAt(0));
  let rows;
  try {
    const workbook  = XLSX.read(buffer, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      console.warn('Excel import: no sheet found in file');
      return null;
    }
    rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
  } catch (parseErr) {
    console.warn('Excel import: failed to parse workbook —', parseErr.message);
    return null;
  }

  if (!rows.length) {
    console.warn('Excel import: no data rows found');
    return null;
  }

  const first = rows[0];
  if (!first.url) {
    console.warn('Excel import: unknown sheet format — no url column found; import skipped');
    return null;
  }

  let elements = [];
  if (typeof first.elements === 'string' && first.elements) {
    try {
      elements = JSON.parse(first.elements);
    } catch {
      elements = [];
    }
  } else if (rows.length > 1) {
    elements = rows.map(r => ({ ...r }));
  }

  return {
    id:            first.id            || crypto.randomUUID(),
    name:          first.name          || first.url,
    url:           first.url,
    timestamp:     first.timestamp     || new Date().toISOString(),
    environment:   first.environment   || null,
    schemaVersion: first.schemaVersion || null,
    elements,
  };
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

    let report;
    try {
      if (ipcResult.ext === 'json') {
        report = JSON.parse(ipcResult.content);
        if (Array.isArray(report)) { report = report[0]; }
      } else if (ipcResult.ext === 'csv') {
        report = parseCsvToReport(ipcResult.content);
        if (!report) {
          Toast.error('CSV format not recognised — check the file was exported from this application');
          return;
        }
      } else if (ipcResult.ext === 'xlsx' || ipcResult.ext === 'xls') {
        report = parseExcelToReport(ipcResult.content);
        if (!report) {
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

    if (!report || !report.url) {
      Toast.error('Imported file does not contain a valid report');
      return;
    }

    const state    = getState();
    const reports  = state.reports ?? [];
    const existing = reports.find(r => r.url === report.url);
    if (existing) {
      const confirmed = await Modal.confirm(
        'Duplicate report',
        `A report from "${report.url}" already exists. Replace it?`,
        { confirmText: 'Replace' }
      );
      if (!confirmed) { return; }
      await storage.deleteReport(existing.id);
    }

    const imported = {
      ...report,
      id:        report.id        ?? crypto.randomUUID(),
      timestamp: report.timestamp ?? new Date().toISOString(),
      source:    'imported',
    };

    await storage.saveReport(imported);
    await loadAndRenderReports();

    const selId = slot === 'baseline' ? 'baseline-report' : 'compare-report';
    const sel   = document.getElementById(selId);
    if (sel) { sel.value = imported.id; }

    const actionKey = slot === 'baseline' ? 'BASELINE_SELECTED' : 'COMPARE_SELECTED';
    dispatch(actionKey, { id: imported.id });
    syncCompareButton();
    tryLoadCachedComparison();

    Toast.success(`Report imported — ${imported.totalElements ?? 0} elements`);
  } catch (err) {
    Toast.error(err.message ?? 'Import failed');
  }
}

export { handleImportReport };