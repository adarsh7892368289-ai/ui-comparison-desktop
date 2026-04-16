import storage from '../../infrastructure/idb-repository.js';
import { dispatch, getState, subscribe } from '../state.js';
import {
  Toast,
  Modal,
  setError,
  showProgress,
  hideProgress,
  updateProgress,
  syncCompareButton,
} from '../ui.js';
import { handleExportReport } from './export-workflow.js';
import { tryLoadCachedComparison } from './compare-workflow.js';
import { relativeTime } from '../utils/time.js';
import { createReportList } from '../components/report-list.js';
import {
  wireReportSelect,
  refreshReportSelectPanel,
  syncReportSelectTrigger,
} from '../components/report-select-combobox.js';
import { iconArrowDown, iconArrowUp, iconLayoutGrid, iconSpinner } from '../utils/icons.js';

let _reportList = null;
let _statusBar = null;

const _densityStates = ['default', 'compact', 'comfortable'];
let _densityIdx = 0;
let _sortDir = 'desc';

/** Previously bound #empty-clear-search for safe removeEventListener on re-init. */
let _emptyClearSearchButton = null;

const VIEW_CONFIG_KEY = 'sidebar-view-config';
const LEGACY_VIEW_CONFIG_KEY = 'report-view-config';

function _loadViewConfigFromStorage() {
  try {
    const cur = localStorage.getItem(VIEW_CONFIG_KEY);
    if (cur) { return JSON.parse(cur); }
  } catch { void 0; }
  try {
    const leg = localStorage.getItem(LEGACY_VIEW_CONFIG_KEY);
    if (leg) {
      const parsed = JSON.parse(leg);
      try {
        localStorage.setItem(VIEW_CONFIG_KEY, leg);
        localStorage.removeItem(LEGACY_VIEW_CONFIG_KEY);
      } catch { void 0; }
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    }
  } catch { void 0; }
  return {};
}

function _saveViewConfig(patch) {
  try {
    const existing = JSON.parse(localStorage.getItem(VIEW_CONFIG_KEY) || '{}');
    localStorage.setItem(VIEW_CONFIG_KEY, JSON.stringify({ ...existing, ...patch }));
  } catch { void 0; }
}

function _syncDensityToggleButton() {
  const btn = document.getElementById('density-toggle-btn');
  if (!btn) return;
  const d = _densityStates[_densityIdx];
  btn.setAttribute('aria-label', `Density: ${d}`);
  btn.title = `Density: ${d}`;
  btn.innerHTML = iconLayoutGrid(14);
}

function _syncSortDirButton() {
  const btn = document.getElementById('sort-dir-btn');
  if (!btn) return;
  const isDesc = _sortDir === 'desc';
  btn.dataset.dir = _sortDir;
  btn.setAttribute('aria-label', `Sort direction: ${isDesc ? 'newest' : 'oldest'} first`);
  btn.setAttribute('title', `Sort direction: ${isDesc ? 'newest' : 'oldest'} first`);
  btn.innerHTML = isDesc ? iconArrowDown(13) : iconArrowUp(13);
}

const api = window.electronAPI;

function handleEmptyClearSearchClick() {
  const input = document.getElementById('search-reports');
  if (!input) return;
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}

function wireEmptyClearSearchButton() {
  const btn = document.getElementById('empty-clear-search');
  if (!btn) return;
  if (_emptyClearSearchButton && _emptyClearSearchButton !== btn) {
    _emptyClearSearchButton.removeEventListener('click', handleEmptyClearSearchClick);
  }
  if (_emptyClearSearchButton === btn) return;
  btn.addEventListener('click', handleEmptyClearSearchClick);
  _emptyClearSearchButton = btn;
}

function announceReportList(message) {
  const el = document.getElementById('report-list-announcer');
  if (el) { el.textContent = message; }
}

function selectBaselineFromReport(report) {
  dispatch('BASELINE_SELECTED', { id: report.id });
  const sel = document.getElementById('baseline-report');
  if (sel) {
    sel.value = report.id;
    syncReportSelectTrigger(sel);
  }
  syncCompareButton();
  tryLoadCachedComparison();
  Toast.success('Set as baseline');
  announceReportList(`Set as baseline — ${hostFromUrl(report.url)}`);
}

function selectCompareFromReport(report) {
  dispatch('COMPARE_SELECTED', { id: report.id });
  const sel = document.getElementById('compare-report');
  if (sel) {
    sel.value = report.id;
    syncReportSelectTrigger(sel);
  }
  syncCompareButton();
  tryLoadCachedComparison();
  Toast.success('Set as compare');
  announceReportList(`Set as compare — ${hostFromUrl(report.url)}`);
}

const STAGE_RE = /\b(stage|staging|dev|test|qa|uat|preview|sandbox|canary)\b/i;

function hostFromUrl(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function lastPathSegment(url) {
  try {
    const seg = new URL(url).pathname.replace(/\/$/, '').split('/').filter(Boolean).pop();
    return seg ? `/${seg}` : '/';
  } catch { return ''; }
}

function sanitizeFilename(name) {
  const cleaned = String(name ?? 'export')
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/[-_.]{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 200);
  return cleaned || 'export';
}

function envTag(url) {
  if (!url) { return null; }
  const host = hostFromUrl(url).toLowerCase();
  if (STAGE_RE.test(host)) { return 'STAGE'; }
  return 'PROD';
}

function insertReportListSkeletonOverlay() {
  const c = document.getElementById('reports-list');
  if (!c || c.querySelector('.report-list-skeleton-overlay')) { return; }
  const o = document.createElement('div');
  o.className = 'report-list-skeleton-overlay';
  o.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 5; i++) {
    const d = document.createElement('div');
    d.className = 'skeleton-card';
    o.appendChild(d);
  }
  c.appendChild(o);
}

function filteredReportCount(reports, searchQuery) {
  const list = reports ?? [];
  const rawQ = searchQuery ?? '';
  const q = rawQ.toLowerCase().trim();
  if (!q) return list.length;
  return list.filter(r =>
    (hostFromUrl(r.url) || '').toLowerCase().includes(q) ||
    (r.url || '').toLowerCase().includes(q) ||
    (lastPathSegment(r.url) || '').toLowerCase().includes(q) ||
    (r.environment || '').toLowerCase().includes(q) ||
    (r.name || '').toLowerCase().includes(q)).length;
}

function renderReportList(reports, searchQuery) {
  document.querySelector('#reports-list .report-list-skeleton-overlay')?.remove();
  const rawQ = searchQuery ?? '';
  _reportList?.setReports(reports, rawQ);
  const count = filteredReportCount(reports, searchQuery);
  _statusBar?.updateReportCount(reports, count);
  const empty = document.getElementById('reports-empty');
  if (!empty) { return; }
  empty.classList.toggle('hidden', count > 0);
  const isFiltered = typeof searchQuery === 'string' && searchQuery.trim().length > 0;
  empty.dataset.filtered = String(isFiltered);
  const emptyPanel = empty.querySelector('[data-state="empty"]');
  const filteredPanel = empty.querySelector('[data-state="filtered"]');
  if (emptyPanel && filteredPanel) {
    emptyPanel.hidden = isFiltered;
    filteredPanel.hidden = !isFiltered;
  }
  if (isFiltered) {
    const titleEl = filteredPanel?.querySelector('.empty-title');
    if (titleEl) {
      const q = rawQ.trim();
      titleEl.textContent = q.length > 0 ? `No results for "${q}"` : 'No results';
    }
  } else {
    const titleEl = filteredPanel?.querySelector('.empty-title');
    if (titleEl) { titleEl.textContent = 'No results'; }
  }
}

async function loadAndRenderReports() {
  const reports = await storage.loadReports();
  dispatch('REPORTS_LOADED', { reports });

  const query = document.getElementById('search-reports')?.value ?? '';
  renderReportList(reports, query);
  populateReportSelectors(reports);
}

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
      const host        = hostFromUrl(r.url).replace(/^www\./, '');
      const path        = lastPathSegment(r.url);
      const displayIdx  = total - i;
      const envPrefix   = hasMultiEnv ? `${envTag(r.url)} · ` : '';
      const importedPfx = r.source === 'imported' ? '[↑] ' : '';
      const label       = `${importedPfx}R${displayIdx} · ${envPrefix}${host}${path}`;
      const opt         = new Option(label, r.id);
      opt.title         = `${r.url} · ${r.totalElements ?? 0} elements · ${relativeTime(r.timestamp)}`;
      opt.dataset.reportUrl       = r.url || '';
      opt.dataset.reportElements  = String(r.totalElements ?? 0);
      opt.dataset.reportTime      = relativeTime(r.timestamp);
      if (r.id === current) { opt.selected = true; }
      sel.appendChild(opt);
    });
    refreshReportSelectPanel(sel);
  });
  syncCompareButton();
}

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
    await storage.deleteAllReports();
    await loadAndRenderReports();
    Toast.success(`Deleted ${reports.length} report${reports.length !== 1 ? 's' : ''}`);
  } catch (err) {
    Toast.error(err.message ?? 'Delete failed');
  }
}

async function handleExtraction() {
  const extractBtn = document.getElementById('extract-btn');
  const urlInput   = document.getElementById('url-input');
  if (!extractBtn || !urlInput) { return; }

  const url = urlInput.value.trim();
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    setError('extract', 'Enter a valid URL starting with http:// or https://');
    return;
  }
  setError('extract', '');
  const originalHTML = extractBtn.innerHTML;
  extractBtn.style.minWidth = extractBtn.offsetWidth + 'px';
  extractBtn.disabled  = true;
  extractBtn.innerHTML = `${iconSpinner(14)} <span>Extracting…</span>`;
  showProgress('extract', 'Starting…');

  const offExtraction = api.onExtractionProgress((data) => {
    updateProgress('extract', data.pct, data.label);
  });

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
      duration:  result.report?.duration ?? result.duration,
    });

    if (result.report.captureQuality === 'DEGRADED') {
      Toast.warning('Page was still loading during extraction — captured elements may be incomplete.');
    }

    await storage.saveReport(report);
    await loadAndRenderReports();
    const dur = report.duration;
    const durStr = dur ? ` · ${(dur / 1000).toFixed(1)}s` : '';
    Toast.success(`Extracted ${report.totalElements ?? 0} elements${durStr}`);

  } catch (err) {
    setError('extract', err.message ?? 'Unexpected error');
  } finally {
    offExtraction();
    extractBtn.disabled    = false;
    extractBtn.innerHTML   = originalHTML;
    extractBtn.style.minWidth = '';
    hideProgress('extract');
  }
}

async function initializeApp(statusBar) {
  _statusBar = statusBar ?? null;
  await storage.applyPendingOperations();

  const listContainer = document.getElementById('reports-list');
  if (listContainer) {
    _reportList = createReportList(listContainer, {
      onSelect: (report) => {
        _reportList?.setSelected(report.id);
      },
      onDelete: (report) => handleDeleteReport(report),
      onBaseline: (report) => selectBaselineFromReport(report),
      onCompare: (report) => selectCompareFromReport(report),
    });
  }

  const savedView = _loadViewConfigFromStorage();

  if (savedView.groupBy !== undefined) {
    const sel = document.getElementById('group-by-select');
    if (sel) { sel.value = savedView.groupBy || ''; }
    _reportList?.setViewConfig({ groupBy: savedView.groupBy ?? null });
  }

  if (savedView.sortBy) {
    const sel = document.getElementById('sort-by-select');
    if (sel) { sel.value = savedView.sortBy; }
    _reportList?.setViewConfig({ sortBy: savedView.sortBy });
  }

  if (savedView.sortDir === 'asc' || savedView.sortDir === 'desc') {
    _sortDir = savedView.sortDir;
    _reportList?.setViewConfig({ sortDir: _sortDir });
  }

  if (savedView.density) {
    const idx = _densityStates.indexOf(savedView.density);
    if (idx !== -1) {
      _densityIdx = idx;
      _reportList?.setViewConfig({ density: savedView.density });
      _syncDensityToggleButton();
    }
  }

  if (typeof api?.onContextAction === 'function') {
    api.onContextAction((payload) => {
      if (!payload || typeof payload.reportId !== 'string') { return; }
      const reports = getState().reports ?? [];
      const report = reports.find(r => r.id === payload.reportId);
      if (!report) { return; }
      switch (payload.action) {
        case 'setBaseline':
          selectBaselineFromReport(report);
          break;
        case 'compare':
          selectCompareFromReport(report);
          break;
        case 'export':
          if (['json', 'csv', 'excel'].includes(payload.format)) {
            handleExportReport(report, payload.format);
          }
          break;
        case 'delete':
          handleDeleteReport(report);
          break;
        default:
          break;
      }
    });
  }

  subscribe(state => {
    _reportList?.setBaseline(state.selectedBaseline ?? null);
    _reportList?.setCompare(state.selectedCompare ?? null);
  });

  document.getElementById('group-by-select')?.addEventListener('change', e => {
    _reportList?.setViewConfig({ groupBy: e.target.value || null });
    _saveViewConfig({ groupBy: e.target.value || null });
  });

  document.getElementById('sort-by-select')?.addEventListener('change', e => {
    _reportList?.setViewConfig({ sortBy: e.target.value });
    _saveViewConfig({ sortBy: e.target.value });
  });

  document.getElementById('sort-dir-btn')?.addEventListener('click', () => {
    _sortDir = _sortDir === 'desc' ? 'asc' : 'desc';
    _syncSortDirButton();
    _reportList?.setViewConfig({ sortDir: _sortDir });
    _saveViewConfig({ sortDir: _sortDir });
  });

  document.getElementById('density-toggle-btn')?.addEventListener('click', () => {
    _densityIdx = (_densityIdx + 1) % _densityStates.length;
    const d = _densityStates[_densityIdx];
    _reportList?.setViewConfig({ density: d });
    _saveViewConfig({ density: d });
    _syncDensityToggleButton();
  });

  let _searchDebounce;
  document.getElementById('search-reports')?.addEventListener('input', e => {
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => {
      renderReportList(getState().reports ?? [], e.target.value);
    }, 250);
  });

  wireEmptyClearSearchButton();

  _syncSortDirButton();
  _syncDensityToggleButton();

  const baselineSelect = document.getElementById('baseline-report');
  const compareSelect = document.getElementById('compare-report');
  if (baselineSelect) { wireReportSelect(baselineSelect); }
  if (compareSelect) { wireReportSelect(compareSelect); }

  await loadAndRenderReports();
}

export {
  hostFromUrl,
  lastPathSegment,
  sanitizeFilename,
  envTag,
  insertReportListSkeletonOverlay,
  renderReportList,
  filteredReportCount,
  loadAndRenderReports,
  populateReportSelectors,
  handleDeleteReport,
  handleDeleteAllReports,
  handleExtraction,
  initializeApp,
};