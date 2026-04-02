'use strict';

import storage from '../infrastructure/idb-repository.js';
import { getState, dispatch, subscribe } from './state.js';
import { exportToHTML }                  from '../core/export/comparison/html-exporter.js';
import { buildComparisonCsv }            from '../core/export/comparison/csv-exporter.js';
import { buildComparisonJsonPayload }    from '../core/export/comparison/json-exporter.js';
import { exportToExcel }                 from '../core/export/comparison/excel-exporter.js';
import {
  buildExtractedReportCsv,
  buildExtractedReportJson,
  buildAllExtractedReportsCsv,
  buildAllExtractedReportsJson,
  buildExtractedReportExcel,
  buildAllExtractedReportsExcel,
} from '../core/export/extraction/report-exporter.js';
import { assessUrlCompatibility } from '../application/url-compatibility.js';

const api = window.electronAPI;
if (!api) {
  throw new Error(
    'window.electronAPI is undefined. ' +
    'Verify preload.js path in BrowserWindow.webPreferences and contextIsolation: true.'
  );
}

let _visibilityObserver = null;
let _activeDisplayCmpId = null;
let _pendingCachedAt    = null;

// ── Utilities ─────────────────────────────────────────────────────────────────

function hostFromUrl(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function lastPathSegment(url) {
  try {
    const seg = new URL(url).pathname.replace(/\/$/, '').split('/').filter(Boolean).pop();
    return seg ? `/${seg}` : '/';
  } catch { return ''; }
}

function sanitize(value) {
  const el = document.createElement('span');
  el.textContent = String(value ?? '');
  return el.innerHTML;
}

function sanitizeFilename(name) {
  const cleaned = String(name ?? 'export')
    .replace(/[^a-zA-Z0-9_.\-]+/g, '-')
    .replace(/[-_.]{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 200);
  return cleaned || 'export';
}

const STAGE_RE = /\b(stage|staging|dev|test|qa|uat|preview|sandbox|canary)\b/i;

function envTag(url) {
  if (!url) { return null; }
  const host = hostFromUrl(url).toLowerCase();
  if (STAGE_RE.test(host)) { return 'STAGE'; }
  return 'PROD';
}

function relativeTime(isoString) {
  const mins = Math.floor((Date.now() - new Date(isoString).getTime()) / 60000);
  if (mins < 1)  { return 'just now'; }
  if (mins < 60) { return `${mins}m ago`; }
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  { return `${hrs}h ago`; }
  return `${Math.floor(hrs / 24)}d ago`;
}

// normalizeComparisonResult — called at BOTH entry points (fresh result + cached load)
// so every exporter sees an identical shape and no consumer does defensive normalization.
// Keys coerced to String because Object.fromEntries on a Map with numeric keys coerces
// them to "42"; the reconstructed Map must also store string keys so lookups match.
function normalizeComparisonResult(result) {
  if (!result || typeof result !== 'object') { return null; }

  const visualDiffs = result.visualDiffs instanceof Map
    ? result.visualDiffs
    : new Map(
        Object.entries(result.visualDiffs ?? {}).map(([k, v]) => [String(k), v])
      );

  const comparison = result.comparison && typeof result.comparison === 'object'
    ? result.comparison
    : {};

  return {
    ...result,
    visualDiffs,
    comparison: {
      ...comparison,
      results: Array.isArray(comparison.results) ? comparison.results : [],
      summary: comparison.summary && typeof comparison.summary === 'object'
        ? comparison.summary
        : {},
    },
  };
}

// ── Toast ─────────────────────────────────────────────────────────────────────

const Toast = {
  _root: null,
  _init() { this._root = this._root ?? document.getElementById('toast-container'); },
  show(msg, type, duration = 3000) {
    this._init();
    const t   = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const txt = document.createElement('span');
    txt.textContent = msg;
    const x = document.createElement('button');
    x.className   = 'toast-close';
    x.setAttribute('aria-label', 'Dismiss');
    x.textContent = '×';
    x.addEventListener('click', () => this._dismiss(t));
    t.append(txt, x);
    this._root.appendChild(t);
    requestAnimationFrame(() => t.classList.add('visible'));
    if (duration > 0) { setTimeout(() => this._dismiss(t), duration); }
    while (this._root.children.length > 4) { this._dismiss(this._root.firstChild); }
  },
  _dismiss(t) {
    if (!t?.isConnected) { return; }
    t.classList.remove('visible');
    t.addEventListener('transitionend', () => t.remove(), { once: true });
  },
  success(m) { this.show(m, 'success', 3000); },
  error(m)   { this.show(m, 'error',   0);    },
  info(m)    { this.show(m, 'info',    3000); },
  warning(m) { this.show(m, 'warning', 4000); },
};

// ── Modal confirm ─────────────────────────────────────────────────────────────

const Modal = {
  _overlay: null,
  _box:     null,
  _resolve: null,
  _init() {
    if (this._overlay) { return; }
    this._overlay = document.getElementById('modal-overlay');
    this._box     = document.getElementById('modal-box');
    this._overlay.addEventListener('click', e => {
      if (e.target === this._overlay) { this._close(false); }
    });
    document.addEventListener('keydown', e => {
      if (this._resolve && e.key === 'Escape') { this._close(false); }
    });
  },
  confirm(title, message, { confirmText = 'Confirm', destructive = false } = {}) {
    this._init();
    return new Promise(resolve => {
      this._resolve = resolve;
      this._box.innerHTML = `
        <p class="modal-title" id="modal-title">${sanitize(title)}</p>
        <p class="modal-message">${sanitize(message)}</p>
        <div class="modal-actions">
          <button class="btn-ghost modal-cancel">Cancel</button>
          <button class="btn-${destructive ? 'destructive' : 'primary'} btn-sm modal-confirm">
            ${sanitize(confirmText)}
          </button>
        </div>`;
      this._overlay.classList.remove('hidden');
      this._box.querySelector('.modal-confirm').focus();
      this._box.querySelector('.modal-cancel').addEventListener('click',  () => this._close(false));
      this._box.querySelector('.modal-confirm').addEventListener('click', () => this._close(true));
    });
  },
  _close(result) {
    this._overlay?.classList.add('hidden');
    const res     = this._resolve;
    this._resolve = null;
    res?.(result);
  },
};

// ── Progress ──────────────────────────────────────────────────────────────────

function showProgress(id, label) {
  const wrap = document.getElementById(`${id}-progress`);
  if (wrap) { wrap.classList.add('visible'); }
  updateProgress(id, 0, label);
}

function updateProgress(id, pct, label) {
  const bar  = document.getElementById(`${id}-progress-bar`);
  const lbl  = document.getElementById(`${id}-progress-label`);
  const wrap = document.getElementById(`${id}-progress`);
  if (bar)  { bar.style.width = `${pct}%`; }
  if (lbl && label) { lbl.textContent = label; }
  if (wrap) { wrap.setAttribute('aria-valuenow', pct); }
}

function hideProgress(id) {
  const wrap = document.getElementById(`${id}-progress`);
  if (wrap) { wrap.classList.remove('visible'); }
}

function setError(id, msg) {
  const el = document.getElementById(`${id}-error`);
  if (el) { el.textContent = msg ?? ''; }
}

// ── Report list rendering ─────────────────────────────────────────────────────

function displayReportsFooter(count) {
  const footer = document.getElementById('reports-footer');
  if (!footer) { return; }
  footer.textContent = count === 0 ? '' : `${count} report${count !== 1 ? 's' : ''} saved`;
}

function renderReportCard(report, displayIndex, showEnvBadge) {
  const card = document.createElement('div');
  card.className = 'report-card';
  card.setAttribute('role', 'listitem');

  const host   = hostFromUrl(report.url);
  const path   = lastPathSegment(report.url);
  const env    = envTag(report.url);
  const envHtml = (showEnvBadge && env)
    ? `<span class="env-badge env-badge--${env.toLowerCase()}">${sanitize(env)}</span>`
    : '';

  function filterLabel(filters) {
    if (!filters) { return null; }
    return filters.class || filters.id || filters.tag || null;
  }
  const filter = filterLabel(report.filters);

  card.innerHTML = `
    <div class="report-card-body">
      <div class="report-card-header">
        <span class="report-index">R${displayIndex}</span>
        ${envHtml}
        <span class="meta-host" title="${sanitize(report.url)}">${sanitize(host)}</span>
      </div>
      <div class="report-card-meta">
        <span>${sanitize(report.totalElements ?? 0)} el</span>
        <span class="meta-sep">·</span>
        <span class="meta-path">${sanitize(path)}</span>
        ${filter ? `<span class="meta-sep">·</span><span class="meta-filter" title="Extraction filter">${sanitize(filter)}</span>` : ''}
        <span class="meta-sep">·</span>
        <span>${relativeTime(report.timestamp)}</span>
        ${report.source === 'imported' ? '<span class="meta-sep">·</span><span class="meta-imported-badge" title="Uploaded from file">↑ imported</span>' : ''}
      </div>
    </div>
    <div class="report-card-actions">
      <details class="export-dropdown">
        <summary class="btn-ghost btn-sm" title="Export options">Export ▾</summary>
        <div class="export-menu">
          <button class="export-menu-item" data-format="excel">Excel</button>
          <button class="export-menu-item" data-format="json">JSON</button>
          <button class="export-menu-item" data-format="csv">CSV</button>
        </div>
      </details>
      <button class="btn-icon-danger" title="Delete report" aria-label="Delete report from ${sanitize(host)}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>
        </svg>
      </button>
    </div>`;

  card.querySelectorAll('.export-menu-item').forEach(btn => {
    btn.addEventListener('click', () => {
      card.querySelector('details').removeAttribute('open');
      handleExportReport(report, btn.dataset.format);
    });
  });

  card.querySelector('.btn-icon-danger').addEventListener('click', () => handleDeleteReport(report));
  return card;
}

function renderReportList(reports, searchQuery) {
  const list  = document.getElementById('reports-list');
  const empty = document.getElementById('reports-empty');
  if (!list) { return; }

  const q        = (searchQuery ?? '').toLowerCase().trim();
  const filtered = q
    ? reports.filter(r =>
        (hostFromUrl(r.url) || '').toLowerCase().includes(q) ||
        (r.url || '').toLowerCase().includes(q) ||
        (r.title || '').toLowerCase().includes(q))
    : reports;

  list.textContent = '';

  if (filtered.length === 0) {
    empty?.classList.remove('hidden');
    return;
  }
  empty?.classList.add('hidden');

  const envTags     = reports.map(r => envTag(r.url));
  const hasMultiEnv = envTags.some(e => e === 'STAGE');
  const total       = reports.length;

  const frag = document.createDocumentFragment();
  filtered.forEach(r => {
    const posInAll   = reports.indexOf(r);
    const displayIdx = total - posInAll;
    frag.appendChild(renderReportCard(r, displayIdx, hasMultiEnv));
  });
  list.appendChild(frag);
}

async function loadAndRenderReports() {
  const reports = await storage.loadReports();
  dispatch('REPORTS_LOADED', { reports });

  const query = document.getElementById('search-reports')?.value ?? '';
  renderReportList(reports, query);
  populateReportSelectors(reports);
  displayReportsFooter(reports.length);
}

// ── Report selector (compare panel) ──────────────────────────────────────────

function populateReportSelectors(reports) {
  const total       = reports.length;
  const envTags     = reports.map(r => envTag(r.url));
  const hasMultiEnv = envTags.some(e => e === 'STAGE');

  ['baseline-report', 'compare-report'].forEach(selId => {
    const sel = document.getElementById(selId);
    if (!sel) { return; }
    const current = sel.value;
    sel.textContent = '';
    sel.appendChild(new Option('Select report…', ''));
    reports.forEach((r, i) => {
      const host       = hostFromUrl(r.url).replace(/^www\./, '');
      const path       = lastPathSegment(r.url);
      const displayIdx = total - i;
      const envPrefix  = hasMultiEnv ? `${envTag(r.url)} · ` : '';
      const importedPfx = r.source === 'imported' ? '[↑] ' : '';
      const label      = `${importedPfx}R${displayIdx} · ${envPrefix}${host}${path}`;
      const opt        = new Option(label, r.id);
      opt.title        = `${r.url} · ${r.totalElements ?? 0} elements · ${relativeTime(r.timestamp)}`;
      if (r.id === current) { opt.selected = true; }
      sel.appendChild(opt);
    });
  });
  syncCompareButton();
}

function syncCompareButton() {
  const state = getState();
  const btn   = document.getElementById('compare-btn');
  if (btn) {
    btn.disabled = !state.selectedBaseline ||
                   !state.selectedCompare  ||
                   state.selectedBaseline === state.selectedCompare;
  }
}

// ── Delete handlers ───────────────────────────────────────────────────────────

async function handleDeleteReport(report) {
  const confirmed = await Modal.confirm(
    'Delete report',
    `Delete "${report.title || hostFromUrl(report.url)}"? This cannot be undone.`,
    { confirmText: 'Delete', destructive: true }
  );
  if (!confirmed) { return; }
  try {
    await storage.deleteReport(report.id);
    await loadAndRenderReports();
    Toast.success('Report deleted');
  } catch (err) {
    Toast.error(err.message ?? 'Delete failed');
  }
}

async function handleDeleteAllReports() {
  const state   = getState();
  const reports = state.reports ?? [];
  if (reports.length === 0) { Toast.info('No reports to delete'); return; }

  const confirmed = await Modal.confirm(
    'Delete all reports',
    `This permanently deletes all ${reports.length} saved report${reports.length !== 1 ? 's' : ''}. This cannot be undone.`,
    { confirmText: 'Delete All', destructive: true }
  );
  if (!confirmed) { return; }
  try {
    for (const r of reports) {
      await storage.deleteReport(r.id);
    }
    await loadAndRenderReports();
    Toast.success(`Deleted ${reports.length} report${reports.length !== 1 ? 's' : ''}`);
  } catch (err) {
    Toast.error(err.message ?? 'Delete failed');
  }
}

// ── Per-report export ─────────────────────────────────────────────────────────

async function handleExportReport(report, format) {
  // Load full report elements from IDB (report card only carries metadata)
  let fullReport = report;
  try {
    const elements = await storage.loadReportElements(report.id);
    fullReport = { ...report, elements: elements ?? [] };
  } catch (_) {
    fullReport = { ...report, elements: [] };
  }

  const safeId   = sanitizeFilename(report.id?.slice(0, 12) ?? 'report');
  const host     = sanitizeFilename(hostFromUrl(report.url));

  try {
    if (format === 'json') {
      const json         = buildExtractedReportJson(fullReport);
      const safeFilename = sanitizeFilename(`report-${host}-${safeId}.json`);
      const res = await Promise.race([
        api.exportFile({ format: 'json', data: json, filename: safeFilename }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Export timeout')), 120_000)),
      ]);
      if (res.success)                   { Toast.success(`Saved to ${res.filePath}`); }
      else if (res.reason !== 'cancelled') { Toast.error(res.error ?? 'Export failed'); }
      return;
    }

    if (format === 'csv') {
      const csv          = buildExtractedReportCsv(fullReport);
      const safeFilename = sanitizeFilename(`report-${host}-${safeId}.csv`);
      const res = await Promise.race([
        api.exportFile({ format: 'csv', data: csv, filename: safeFilename }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Export timeout')), 120_000)),
      ]);
      if (res.success)                   { Toast.success(`Saved to ${res.filePath}`); }
      else if (res.reason !== 'cancelled') { Toast.error(res.error ?? 'Export failed'); }
      return;
    }

    if (format === 'excel') {
      const result = buildExtractedReportExcel(fullReport);
      if (!result.success) { Toast.error(`Excel build failed: ${result.error}`); return; }
      const raw          = result.data;
      const data         = raw instanceof Uint8Array ? raw : new Uint8Array(raw.buffer, raw.byteOffset ?? 0, raw.byteLength);
      const safeFilename = sanitizeFilename(`report-${host}-${safeId}.xlsx`);
      const res = await Promise.race([
        api.exportFile({ format: 'xlsx', data, filename: safeFilename }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Export timeout')), 120_000)),
      ]);
      if (res.success)                   { Toast.success(`Saved to ${res.filePath}`); }
      else if (res.reason !== 'cancelled') { Toast.error(res.error ?? 'Export failed'); }
      return;
    }

    Toast.error(`Unknown format: ${format}`);
  } catch (err) {
    Toast.error(err.message ?? 'Export failed');
  }
}

// ── Export All reports ────────────────────────────────────────────────────────

async function handleExportAllReports() {
  const state   = getState();
  const reports = state.reports ?? [];

  if (reports.length === 0) { Toast.info('No reports to export'); return; }

  const format = document.getElementById('export-all-format')?.value ?? 'csv';

  // Load elements for all reports (they live in IDB, not in the report metadata)
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
    if (format === 'json') {
      const json         = buildAllExtractedReportsJson(fullReports);
      const safeFilename = sanitizeFilename(`all-reports-${ts}.json`);
      const res = await Promise.race([
        api.exportFile({ format: 'json', data: json, filename: safeFilename }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Export timeout')), 120_000)),
      ]);
      if (res.success)                   { Toast.success(`Exported ${reports.length} reports`); }
      else if (res.reason !== 'cancelled') { Toast.error(res.error ?? 'Export failed'); }
      return;
    }

    if (format === 'csv') {
      const csv          = buildAllExtractedReportsCsv(fullReports);
      const safeFilename = sanitizeFilename(`all-reports-${ts}.csv`);
      const res = await Promise.race([
        api.exportFile({ format: 'csv', data: csv, filename: safeFilename }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Export timeout')), 120_000)),
      ]);
      if (res.success)                   { Toast.success(`Exported ${reports.length} reports`); }
      else if (res.reason !== 'cancelled') { Toast.error(res.error ?? 'Export failed'); }
      return;
    }

    if (format === 'excel') {
      const result = buildAllExtractedReportsExcel(fullReports);
      if (!result.success) { Toast.error(`Excel build failed: ${result.error}`); return; }
      const raw          = result.data;
      const data         = raw instanceof Uint8Array ? raw : new Uint8Array(raw.buffer, raw.byteOffset ?? 0, raw.byteLength);
      const safeFilename = sanitizeFilename(`all-reports-${ts}.xlsx`);
      const res = await Promise.race([
        api.exportFile({ format: 'xlsx', data, filename: safeFilename }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Export timeout')), 120_000)),
      ]);
      if (res.success)                   { Toast.success(`Exported ${reports.length} reports`); }
      else if (res.reason !== 'cancelled') { Toast.error(res.error ?? 'Export failed'); }
      return;
    }

    Toast.error(`Unknown format: ${format}`);
  } catch (err) {
    Toast.error(err.message ?? 'Export failed');
  }
}

// ── Import report ─────────────────────────────────────────────────────────────

async function handleImportReport(file, slot) {
  if (!file) { return; }
  try {
    const ipcResult = await api.importFile();
    if (!ipcResult.success) {
      if (ipcResult.reason !== 'cancelled') {
        Toast.error(ipcResult.error ?? 'Import failed');
      }
      return;
    }
    // Parse the imported content into a report object
    let report;
    try {
      if (ipcResult.ext === 'json') {
        report = JSON.parse(ipcResult.content);
        // Support both raw report and array-wrapped
        if (Array.isArray(report)) { report = report[0]; }
      } else if (ipcResult.ext === 'csv') {
        Toast.info('CSV import not yet supported — use JSON or Excel');
        return;
      } else {
        Toast.info('Excel report import not yet supported — use JSON');
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

    // Deduplicate by URL — ask user if replacing
    const state   = getState();
    const reports = state.reports ?? [];
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

// ── Comparison export ─────────────────────────────────────────────────────────

async function handleExport() {
  const state  = getState();
  const result = state.comparison;
  if (!result) { Toast.error('No comparison result to export'); return; }

  const format = document.getElementById('export-format-select')?.value ?? 'excel';
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
      const res = await Promise.race([
        api.exportHTML({ htmlContent: html, filename: safeFilename }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Export timeout')), 120_000)),
      ]);
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
      const res = await Promise.race([
        api.exportFile({ format: 'csv', data: csv, filename: safeFilename }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Export timeout')), 120_000)),
      ]);
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
      const res = await Promise.race([
        api.exportFile({ format: 'json', data: json, filename: safeFilename }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Export timeout')), 120_000)),
      ]);
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
      const res = await Promise.race([
        api.exportFile({ format: 'xlsx', data, filename: safeFilename }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Export timeout')), 120_000)),
      ]);
      if (res.success)                   { Toast.success(`Saved to ${res.filePath}`); }
      else if (res.reason !== 'cancelled') { Toast.error(res.error ?? 'Export failed'); }
    } catch (err) {
      Toast.error(err.message ?? 'Excel export failed');
    }
    return;
  }

  Toast.error(`Unknown format: ${format}`);
}

// ── Full Report (HTML export shortcut) ───────────────────────────────────────

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

// ── displayComparisonResults ──────────────────────────────────────────────────

function displayComparisonResults(result, cachedAt = null) {
  const container = document.getElementById('compare-results');
  if (!container || !result) { return; }

  const { matching, comparison, mode, duration } = result;
  const { summary } = comparison;
  const { severityBreakdown, severityCounts, totalDifferences, propertyDiffCount, modifiedElements, unchangedElements } = summary;
  const { critical = 0, high = 0, medium = 0, low = 0 } = severityBreakdown ?? severityCounts ?? {};
  const sevTotal = (critical + high + medium + low) || 1;

  const added   = result.unmatchedElements?.compare  ?? [];
  const removed = result.unmatchedElements?.baseline ?? [];

  const totalElements  = (matching.totalMatched ?? 0) + (matching.unmatchedBaseline ?? 0) + (matching.unmatchedCompare ?? 0);
  const unmatchedTotal = (matching.unmatchedBaseline ?? 0) + (matching.unmatchedCompare ?? 0);

  const pct  = n => totalElements > 0 ? ((n / totalElements) * 100).toFixed(1) : 0;
  const spct = n => sevTotal  > 0 ? ((n / sevTotal)  * 100).toFixed(1) : 0;

  const rateClass = critical > 0 ? 'rate-critical' : high > 0 ? 'rate-high' : 'rate-ok';

  const sevRow = (label, count, type) => count === 0 ? '' : `
    <div class="sev-row">
      <span class="badge badge-${type}">${label}</span>
      <div class="sev-bar-wrap"><div class="sev-bar-fill sev-${type}" style="width:${spct(count)}%"></div></div>
      <span class="sev-count">${count}</span>
    </div>`;

  const DETAIL_CAP = 20;

  const elRow = (el, status) => {
    const tag    = (el.tagName || 'unknown').toLowerCase();
    const idStr  = el.elementId ? `#${el.elementId}` : '';
    const cls    = el.className?.trim()
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      : '';
    const label  = `${tag}${idStr}${cls}` || 'unknown';
    const hpid   = el.hpid ? `<span class="el-hpid" title="HPID">${sanitize(el.hpid)}</span>` : '';
    const text   = el.textContent?.trim()
      ? `<span class="el-text">"${sanitize(el.textContent.trim().slice(0, 60))}${el.textContent.trim().length > 60 ? '…' : ''}"</span>`
      : '';
    const sel    = el.cssSelector
      ? `<span class="el-sel" title="${sanitize(el.cssSelector)}">${sanitize(el.cssSelector.slice(0, 50))}${el.cssSelector.length > 50 ? '…' : ''}</span>`
      : '';
    const badgeCls = status === 'added' ? 'badge-added' : 'badge-removed';
    const badgeTxt = status === 'added' ? '+' : '−';
    return `<div class="el-row">
      <span class="el-badge ${badgeCls}">${badgeTxt}</span>
      <div class="el-info"><span class="el-label">${sanitize(label)}</span>${hpid}${text}${sel}</div>
    </div>`;
  };

  const addedRows    = added.slice(0, DETAIL_CAP).map(el => elRow(el, 'added')).join('');
  const removedRows  = removed.slice(0, DETAIL_CAP).map(el => elRow(el, 'removed')).join('');
  const addedOver    = added.length   > DETAIL_CAP ? `<div class="el-overflow">+${added.length   - DETAIL_CAP} more — export for full list</div>` : '';
  const removedOver  = removed.length > DETAIL_CAP ? `<div class="el-overflow">+${removed.length - DETAIL_CAP} more — export for full list</div>` : '';
  const propChanges  = propertyDiffCount ?? totalDifferences ?? 0;

  container.innerHTML = `
    <div class="result-card">
      <div class="result-header">
        <div class="result-match-rate ${rateClass}">
          <span class="rate-value">${matching.matchRate}%</span>
          <span class="rate-label">matched</span>
        </div>
        <div class="result-meta">
          <span class="result-mode-badge">${sanitize(mode)}</span>
          <span class="result-duration">${duration}ms</span>
          ${cachedAt ? `<span class="result-cached-badge" title="Loaded from cache — run Compare to refresh">Cached · ${relativeTime(cachedAt)}</span>` : ''}
        </div>
      </div>

      <div class="match-breakdown">
        <div class="match-breakdown-title">Element Coverage — ${totalElements} total</div>
        <div class="match-breakdown-row">
          <div class="mbr-item mbr-matched"><div class="mbr-val">${matching.totalMatched}</div><div class="mbr-lbl">Matched</div></div>
          <div class="mbr-item mbr-modified"><div class="mbr-val">${modifiedElements ?? 0}</div><div class="mbr-lbl">Modified</div></div>
          <div class="mbr-item mbr-unchanged"><div class="mbr-val">${unchangedElements ?? 0}</div><div class="mbr-lbl">Unchanged</div></div>
          <div class="mbr-item mbr-unmatched"><div class="mbr-val">${unmatchedTotal}</div><div class="mbr-lbl">Unmatched</div></div>
        </div>
        <div class="match-bar-wrap">
          <div class="match-bar-seg match-bar-unchanged" style="width:${pct(unchangedElements ?? 0)}%" title="${unchangedElements} unchanged"></div>
          <div class="match-bar-seg match-bar-modified"  style="width:${pct(modifiedElements  ?? 0)}%" title="${modifiedElements} modified"></div>
          <div class="match-bar-seg match-bar-added"     style="width:${pct(added.length)}%"           title="${added.length} added"></div>
          <div class="match-bar-seg match-bar-removed"   style="width:${pct(removed.length)}%"         title="${removed.length} removed"></div>
        </div>
      </div>

      ${propChanges > 0 ? `
        <div class="severity-section">
          <div class="severity-section-title">Severity — ${propChanges} CSS property change${propChanges !== 1 ? 's' : ''} across ${critical + high + medium + low} modified element${(critical + high + medium + low) !== 1 ? 's' : ''}</div>
          ${sevRow('Critical', critical, 'critical')}
          ${sevRow('High',     high,     'high')}
          ${sevRow('Medium',   medium,   'medium')}
          ${sevRow('Low',      low,      'low')}
        </div>` : '<div class="no-diffs">✓ No style differences in matched elements</div>'}

      ${added.length > 0 ? `
        <details class="el-section">
          <summary class="el-section-summary">
            <span class="badge badge-added">+${added.length}</span>
            Added in compare
          </summary>
          <div class="el-list">${addedRows}${addedOver}</div>
        </details>` : ''}

      ${removed.length > 0 ? `
        <details class="el-section">
          <summary class="el-section-summary">
            <span class="badge badge-removed">−${removed.length}</span>
            Removed from baseline
          </summary>
          <div class="el-list">${removedRows}${removedOver}</div>
        </details>` : ''}

      ${matching.ambiguousCount > 0 ? `<div class="ambiguous-note">⚠ ${matching.ambiguousCount} element${matching.ambiguousCount !== 1 ? 's' : ''} had ambiguous matches — see full report for details</div>` : ''}

      <div class="result-actions">
        <div class="export-format-row">
          <select class="select" id="export-format-select" aria-label="Export format">
            <option value="xlsx">Excel</option>
            <option value="csv">CSV</option>
            <option value="html">HTML</option>
            <option value="json">JSON</option>
          </select>
          <button class="btn-ghost btn-sm" id="export-comparison-btn">Export</button>
        </div>
        <button class="btn-primary btn-sm" id="view-report-btn">Full Report</button>
      </div>
    </div>`;

  container.querySelector('#export-comparison-btn')?.addEventListener('click', handleExport);
  container.querySelector('#view-report-btn')?.addEventListener('click', handleFullReport);
}

// ── Cached comparison load ────────────────────────────────────────────────────

async function tryLoadCachedComparison() {
  const state = getState();
  if (!state.selectedBaseline || !state.selectedCompare) { return; }

  try {
    const cached = await storage.loadComparisonByPair(
      state.selectedBaseline,
      state.selectedCompare,
      state.compareMode ?? 'dynamic'
    );
    if (cached) {
      const normalized = normalizeComparisonResult({
        baselineId:        cached.baselineId,
        compareId:         cached.compareId,
        mode:              cached.mode,
        matching:          cached.matching,
        comparison:        { summary: cached.summary, results: cached.results ?? [] },
        visualDiffs:       {},
        unmatchedElements: cached.unmatchedElements,
        duration:          cached.duration ?? 0,
      });
      dispatch('COMPARISON_COMPLETE', { result: normalized });
      displayComparisonResults(normalized, cached.timestamp);
    } else {
      document.getElementById('compare-results').innerHTML = '';
      dispatch('COMPARISON_COMPLETE', { result: null });
    }
  } catch (_) {
    /* cache miss is non-fatal */
  }
}

// ── Comparison handler ────────────────────────────────────────────────────────

async function handleComparison() {
  const state   = getState();
  const reports = state.reports ?? [];

  const baselineReport = reports.find(r => r.id === state.selectedBaseline);
  const compareReport  = reports.find(r => r.id === state.selectedCompare);

  if (!baselineReport || !compareReport) {
    setError('compare', 'Select both baseline and compare reports');
    return;
  }
  if (baselineReport.id === compareReport.id) {
    setError('compare', 'Select two different reports');
    return;
  }

  setError('compare', '');
  const compareBtn = document.getElementById('compare-btn');
  compareBtn.disabled    = true;
  compareBtn.textContent = 'Comparing…';

  try {
    const compat = assessUrlCompatibility(baselineReport.url, compareReport.url);
    if (compat.classification === 'INCOMPATIBLE') {
      const delta = compat.mismatchDelta;
      const msg = delta?.pathname
        ? `Incompatible URLs — paths differ: "${delta.pathname.baseline}" vs "${delta.pathname.compare}"`
        : 'Incompatible URLs — check that both reports are from the same page path';
      Toast.error(msg);
      dispatch('RESET_COMPARISON', {});
      compareBtn.disabled    = false;
      compareBtn.textContent = 'Compare Reports';
      return;
    }
    if (compat.classification === 'CAUTION') {
      const delta = compat.mismatchDelta;
      const parts = [];
      if (delta?.hash) { parts.push(`hash differs (${delta.hash.baseline || 'none'} → ${delta.hash.compare || 'none'})`); }
      if (delta?.queryParams?.length) { parts.push(`query params differ: ${delta.queryParams.map(p => p.key).join(', ')}`); }
      Toast.warning(`URL mismatch — ${parts.join('; ') || 'check page state'} — results may include false positives`);
    }
  } catch (compatErr) {
    console.error('URL compatibility check failed:', compatErr);
    Toast.warning('URL compatibility check failed — proceeding');
  }

  showProgress('compare', 'Starting…');
  dispatch('COMPARISON_STARTED', {});

  const mode               = document.querySelector('[name="compare-mode"]:checked')?.value ?? 'dynamic';
  const includeScreenshots = document.getElementById('visual-diff-toggle')?.checked ?? true;

  const off = api.onComparisonProgress((data) => {
    updateProgress('compare', data.pct, data.label);
  });

  try {
    const [baselineElements, compareElements] = await Promise.all([
      storage.loadReportElements(baselineReport.id),
      storage.loadReportElements(compareReport.id),
    ]);

    if (!baselineElements.length) {
      throw new Error(`No elements found for baseline report — re-extract the page`);
    }
    if (!compareElements.length) {
      throw new Error(`No elements found for compare report — re-extract the page`);
    }

    const result = await api.startComparison({
      baselineId:       baselineReport.id,
      compareId:        compareReport.id,
      mode,
      baselineUrl:      baselineReport.url,
      compareUrl:       compareReport.url,
      baselineElements,
      compareElements,
      includeScreenshots,
    });

    if (!result.success) {
      dispatch('COMPARISON_ERROR', { error: result.error ?? 'Comparison failed' });
      setError('compare', result.error ?? 'Comparison failed');
      Toast.error(result.error ?? 'Comparison failed');
      return;
    }

    const sr         = result.result;
    const normalized = normalizeComparisonResult(sr);

    const meta = {
      id:                crypto.randomUUID(),
      pairKey:           `${sr.baselineId}_${sr.compareId}_${sr.mode}`,
      baselineId:        sr.baselineId,
      compareId:         sr.compareId,
      mode:              sr.mode,
      matching:          sr.matching,
      summary:           sr.comparison?.summary,
      unmatchedElements: sr.unmatchedElements,
      duration:          sr.duration,
      timestamp:         sr.completedAt ?? new Date().toISOString(),
    };

    await storage.saveComparison(meta, sr.comparison?.results ?? []);

    // Save visual blobs to IDB for later retrieval by HTML exporter
    if (sr.visualBlobs && typeof sr.visualBlobs === 'object') {
      for (const [keyframeId, blobData] of Object.entries(sr.visualBlobs)) {
        if (blobData && blobData.buffer) {
          const uint8Array = blobData.buffer instanceof Uint8Array 
            ? blobData.buffer 
            : new Uint8Array(blobData.buffer);
          const blob = new Blob([uint8Array], { type: blobData.mimeType || 'image/webp' });
          await storage.saveVisualBlob(keyframeId, blob, meta.id);
        }
      }
    }

    dispatch('COMPARISON_COMPLETE', { result: normalized });

    const diffs = sr.comparison?.summary?.propertyDiffCount
               ?? sr.comparison?.summary?.totalDifferences
               ?? 0;
    Toast.success(`Done — ${diffs} CSS change${diffs !== 1 ? 's' : ''} found`);

  } catch (err) {
    dispatch('COMPARISON_ERROR', { error: err.message });
    setError('compare', err.message ?? 'Unexpected error');
    Toast.error(err.message ?? 'Comparison failed');
  } finally {
    off();
    compareBtn.disabled    = false;
    compareBtn.textContent = 'Compare Reports';
    hideProgress('compare');
  }
}

// ── DOMContentLoaded ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await storage.applyPendingOperations();
  await loadAndRenderReports();

  // Tab switching
  document.querySelectorAll('[role="tab"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('[role="tab"]').forEach(t => {
        const active = t.dataset.tab === tab;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', String(active));
      });
      document.querySelectorAll('[role="tabpanel"]').forEach(p => {
        const active = p.id === `panel-${tab}`;
        p.hidden = !active;
        p.classList.toggle('active', active);
      });
    });
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (inInput) { return; }
    if (e.key === '1') {
      document.querySelector('[data-tab="extract"]')?.click();
    }
    if (e.key === '2') {
      document.querySelector('[data-tab="compare"]')?.click();
    }
    if (e.key === '/') {
      e.preventDefault();
      document.getElementById('search-reports')?.focus();
    }
    if (e.key === 'Escape') {
      const search = document.getElementById('search-reports');
      if (search?.value) {
        search.value = '';
        // Re-render with empty query
        renderReportList(getState().reports ?? [], '');
      }
    }
  });

  // Extract
  const extractBtn = document.getElementById('extract-btn');
  const urlInput   = document.getElementById('url-input');

  if (extractBtn && urlInput) {
    extractBtn.addEventListener('click', async () => {
      const url = urlInput.value.trim();
      if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
        setError('extract', 'Enter a valid URL starting with http:// or https://');
        return;
      }
      setError('extract', '');
      extractBtn.disabled    = true;
      extractBtn.textContent = 'Extracting…';
      showProgress('extract', 'Starting…');

      try {
        const filterClass = document.getElementById('filter-class')?.value.trim() ?? '';
        const filterId    = document.getElementById('filter-id')?.value.trim()    ?? '';
        const filterTag   = document.getElementById('filter-tag')?.value.trim()   ?? '';
        const filters     = {};
        if (filterClass) { filters.class = filterClass; }
        if (filterId)    { filters.id    = filterId;    }
        if (filterTag)   { filters.tag   = filterTag;   }
        const options = Object.keys(filters).length > 0 ? { filters } : {};
        const result  = await api.extractElements({ url, options });

        if (!result.success) {
          setError('extract', result.error ?? 'Extraction failed');
          return;
        }

        const report = Object.assign({}, result.report, {
          id:        result.report.id        ?? crypto.randomUUID(),
          timestamp: result.report.timestamp ?? new Date().toISOString(),
          url:       result.report.url       ?? url,
        });

        await storage.saveReport(report);
        await loadAndRenderReports();
        Toast.success(`Extracted ${report.totalElements ?? 0} elements`);

      } catch (err) {
        setError('extract', err.message ?? 'Unexpected error');
      } finally {
        extractBtn.disabled    = false;
        extractBtn.textContent = 'Extract Elements';
        hideProgress('extract');
      }
    });
  }

  api.onExtractionProgress((data) => {
    updateProgress('extract', data.pct, data.label);
  });

  // Export All
  document.getElementById('export-all-btn')?.addEventListener('click', handleExportAllReports);

  // Delete All
  document.getElementById('delete-all-btn')?.addEventListener('click', handleDeleteAllReports);

  // Search
  let searchDebounce;
  document.getElementById('search-reports')?.addEventListener('input', e => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      renderReportList(getState().reports ?? [], e.target.value);
    }, 200);
  });

  // Import files for compare slots
  ['baseline', 'compare'].forEach(slot => {
    const input = document.getElementById(`${slot}-upload`);
    if (!input) { return; }
    input.addEventListener('change', e => {
      const file = e.target.files?.[0];
      input.value = '';
      handleImportReport(file, slot);
    });
  });

  // Baseline / compare selectors
  const baselineSel = document.getElementById('baseline-report');
  const compareSel  = document.getElementById('compare-report');

  if (baselineSel) {
    baselineSel.addEventListener('change', e => {
      dispatch('BASELINE_SELECTED', { id: e.target.value });
      syncCompareButton();
      tryLoadCachedComparison();
    });
  }

  if (compareSel) {
    compareSel.addEventListener('change', e => {
      dispatch('COMPARE_SELECTED', { id: e.target.value });
      syncCompareButton();
      tryLoadCachedComparison();
    });
  }

  // Mode radio buttons
  document.querySelectorAll('[name="compare-mode"]').forEach(r => {
    r.addEventListener('change', e => {
      if (e.target.checked) {
        dispatch('MODE_CHANGED', { mode: e.target.value });
        tryLoadCachedComparison();
      }
    });
  });

  // Compare button
  document.getElementById('compare-btn')?.addEventListener('click', handleComparison);

  // State subscription — update comparison result when state changes
  subscribe((state) => {
    if (state.comparison && state.phase === 'done') {
      displayComparisonResults(state.comparison);
    }
  });
});