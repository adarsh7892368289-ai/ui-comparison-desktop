import storage from '../../infrastructure/idb-repository.js';
import { dispatch, getState } from '../state.js';
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

function displayReportsFooter(count) {
  const footer = document.getElementById('reports-footer');
  if (!footer) { return; }
  footer.textContent = count === 0 ? '' : `${count} report${count !== 1 ? 's' : ''} saved`;
}

function renderReportCard(report, displayIndex, showEnvBadge) {
  const card = document.createElement('div');
  card.className = 'report-card';
  card.setAttribute('role', 'listitem');

  const host    = hostFromUrl(report.url);
  const path    = lastPathSegment(report.url);
  const env     = envTag(report.url);
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
  await loadAndRenderReports();
}

export {
  hostFromUrl,
  lastPathSegment,
  sanitize,
  sanitizeFilename,
  envTag,
  relativeTime,
  displayReportsFooter,
  renderReportCard,
  renderReportList,
  loadAndRenderReports,
  populateReportSelectors,
  handleDeleteReport,
  handleDeleteAllReports,
  handleExtraction,
  initializeApp,
};