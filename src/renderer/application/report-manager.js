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

let _reportList = null;

const api = window.electronAPI;

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
    .replace(/[^a-zA-Z0-9_.\-]+/g, '-')
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

function displayReportsFooter(count) {
  const footer = document.getElementById('reports-footer');
  if (!footer) { return; }
  footer.textContent = count === 0 ? '' : `${count} report${count !== 1 ? 's' : ''} saved`;
}

function renderReportList(reports, searchQuery) {
  _reportList?.setReports(reports, searchQuery ?? '');
  const empty = document.getElementById('reports-empty');
  if (!empty) { return; }
  const q = (searchQuery ?? '').toLowerCase().trim();
  const count = q
    ? reports.filter(r =>
        (hostFromUrl(r.url) || '').toLowerCase().includes(q) ||
        (r.url || '').toLowerCase().includes(q) ||
        (r.name || '').toLowerCase().includes(q)).length
    : reports.length;
  empty.classList.toggle('hidden', count > 0);
}

async function loadAndRenderReports() {
  const reports = await storage.loadReports();
  dispatch('REPORTS_LOADED', { reports });

  const query = document.getElementById('search-reports')?.value ?? '';
  renderReportList(reports, query);
  populateReportSelectors(reports);
  displayReportsFooter(reports.length);
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
      if (r.id === current) { opt.selected = true; }
      sel.appendChild(opt);
    });
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
  extractBtn.disabled    = true;
  extractBtn.textContent = 'Extracting…';
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
    });

    if (result.report.captureQuality === 'DEGRADED') {
      Toast.warning('Page was still loading during extraction — captured elements may be incomplete.');
    }

    await storage.saveReport(report);
    await loadAndRenderReports();
    Toast.success(`Extracted ${report.totalElements ?? 0} elements`);

  } catch (err) {
    setError('extract', err.message ?? 'Unexpected error');
  } finally {
    offExtraction();
    extractBtn.disabled    = false;
    extractBtn.textContent = 'Extract Elements';
    hideProgress('extract');
  }
}

async function initializeApp() {
  await storage.applyPendingOperations();

  const listContainer = document.getElementById('reports-list');
  if (listContainer) {
    _reportList = createReportList(listContainer, {
      onSelect: (report) => {
        _reportList?.setSelected(report.id);
      },
      onDelete: (report) => handleDeleteReport(report),
      onBaseline: (report) => {
        dispatch('BASELINE_SELECTED', { id: report.id });
        const sel = document.getElementById('baseline-report');
        if (sel) { sel.value = report.id; }
        syncCompareButton();
        tryLoadCachedComparison();
      },
      onCompare: (report) => {
        dispatch('COMPARE_SELECTED', { id: report.id });
        const sel = document.getElementById('compare-report');
        if (sel) { sel.value = report.id; }
        syncCompareButton();
        tryLoadCachedComparison();
      },
    });
  }

  subscribe(state => {
    _reportList?.setBaseline(state.selectedBaseline ?? null);
    _reportList?.setCompare(state.selectedCompare ?? null);
  });

  document.getElementById('group-by-select')?.addEventListener('change', e => {
    _reportList?.setViewConfig({ groupBy: e.target.value || null });
  });

  document.getElementById('sort-by-select')?.addEventListener('change', e => {
    _reportList?.setViewConfig({ sortBy: e.target.value });
  });

  const _densityStates = ['default', 'compact', 'comfortable'];
  let _densityIdx = 0;
  document.getElementById('density-toggle-btn')?.addEventListener('click', () => {
    _densityIdx = (_densityIdx + 1) % _densityStates.length;
    _reportList?.setViewConfig({ density: _densityStates[_densityIdx] });
  });

  let _searchDebounce;
  document.getElementById('search-reports')?.addEventListener('input', e => {
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => {
      renderReportList(getState().reports ?? [], e.target.value);
    }, 200);
  });

  await loadAndRenderReports();
}

export {
  hostFromUrl,
  lastPathSegment,
  sanitizeFilename,
  envTag,
  displayReportsFooter,
  renderReportList,
  loadAndRenderReports,
  populateReportSelectors,
  handleDeleteReport,
  handleDeleteAllReports,
  handleExtraction,
  initializeApp,
};