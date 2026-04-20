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
import { SINGLE_EXTRACTED_REPORT_EXPORT_FORMATS } from '@core/export/extraction-exporters/extracted-report-export-catalog.js';
import { handleExportReport } from './export-workflow.js';
import { tryLoadCachedComparison } from './compare-workflow.js';
import { relativeTime } from '../utils/time.js';
import { createReportList } from '../components/report-list.js';
import { attachTooltip } from '../components/tooltip/tooltip.js';
import {
  wireReportSelect,
  refreshReportSelectPanel,
  syncReportSelectTrigger,
} from '../components/report-select-combobox.js';
import {
  iconArrowUpDown,
  iconCheck,
  iconLayers,
  iconLayoutGrid,
  iconList,
  iconRowsComfortable,
  iconSearch,
  iconSpinner,
  iconX,
} from '../utils/icons.js';

let _reportList = null;
let _statusBar = null;

let _emptyClearSearchButton = null;
let _sortMenuDocDown = null;
let _groupMenuDocDown = null;
let _sidebarTooltipDisposers = [];

const SORT_PRESETS = [
  { sortField: 'date', sortDirection: 'desc', menuLabel: 'Date — newest first' },
  { sortField: 'date', sortDirection: 'asc', menuLabel: 'Date — oldest first' },
  { sortField: 'name', sortDirection: 'asc', menuLabel: 'Host — A to Z' },
  { sortField: 'name', sortDirection: 'desc', menuLabel: 'Host — Z to A' },
  { sortField: 'elements', sortDirection: 'desc', menuLabel: 'Elements — most first' },
  { sortField: 'elements', sortDirection: 'asc', menuLabel: 'Elements — fewest first' },
];

const DENSITY_CYCLE_ORDER = ['compact', 'default', 'comfortable'];

const GROUP_OPTIONS = [
  { key: null, label: 'No grouping' },
  { key: 'host', label: 'By Host' },
  { key: 'date', label: 'By Date' },
  { key: 'environment', label: 'By Environment' },
];

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

function _normalizeViewConfig(raw) {
  const o = typeof raw === 'object' && raw !== null ? raw : {};
  let sortField = o.sortField ?? o.sortBy;
  let sortDirection = o.sortDirection ?? o.sortDir;
  if (sortField !== 'date' && sortField !== 'elements' && sortField !== 'name') {
    sortField = 'date';
  }
  if (sortDirection !== 'asc' && sortDirection !== 'desc') {
    sortDirection = 'desc';
  }
  const density = ['default', 'compact', 'comfortable'].includes(o.density)
    ? o.density
    : 'default';
  let groupBy = o.groupBy ?? null;
  if (groupBy === '') { groupBy = null; }
  return { sortField, sortDirection, density, groupBy };
}

function _persistListViewConfig() {
  const cfg = _reportList?.getViewConfig();
  if (!cfg) return;
  _saveViewConfig({
    groupBy: cfg.groupBy,
    sortField: cfg.sortField,
    sortDirection: cfg.sortDirection,
    density: cfg.density,
  });
}

function _removeSortMenuListener() {
  if (_sortMenuDocDown) {
    document.removeEventListener('pointerdown', _sortMenuDocDown, true);
    _sortMenuDocDown = null;
  }
}

function _removeGroupMenuListener() {
  if (_groupMenuDocDown) {
    document.removeEventListener('pointerdown', _groupMenuDocDown, true);
    _groupMenuDocDown = null;
  }
}

function _closeSortMenu() {
  const menu = document.getElementById('sort-control-menu');
  const btn = document.getElementById('sort-control-btn');
  if (menu) { menu.hidden = true; }
  if (btn) { btn.setAttribute('aria-expanded', 'false'); }
  _removeSortMenuListener();
}

function _closeGroupMenu() {
  const menu = document.getElementById('group-control-menu');
  const btn = document.getElementById('group-control-btn');
  if (menu) { menu.hidden = true; }
  if (btn) { btn.setAttribute('aria-expanded', 'false'); }
  _removeGroupMenuListener();
}

function _sortTooltipText(cfg) {
  const p = SORT_PRESETS.find(
    x => x.sortField === cfg.sortField && x.sortDirection === cfg.sortDirection
  );
  return p ? `Sort: ${p.menuLabel}` : 'Sort: Date — newest first';
}

function _groupTooltipText(cfg) {
  if (!cfg.groupBy) return 'No grouping';
  const g = GROUP_OPTIONS.find(x => x.key === cfg.groupBy);
  return g ? `Group: ${g.label}` : 'No grouping';
}

function _rebuildSortMenu() {
  const menu = document.getElementById('sort-control-menu');
  if (!menu) return;
  const cfg = _reportList?.getViewConfig() ?? { sortField: 'date', sortDirection: 'desc' };
  menu.textContent = '';
  const groups = [
    { title: 'Date', keys: ['date'] },
    { title: 'Host', keys: ['name'] },
    { title: 'Elements', keys: ['elements'] },
  ];
  let first = true;
  for (const g of groups) {
    if (!first) {
      const div = document.createElement('li');
      div.className = 'filter-rail__dropdown-divider';
      div.setAttribute('role', 'separator');
      menu.appendChild(div);
    }
    first = false;
    const head = document.createElement('li');
    head.className = 'filter-rail__dropdown-heading';
    head.textContent = g.title;
    head.setAttribute('role', 'presentation');
    menu.appendChild(head);
    const presets = SORT_PRESETS.filter(p => g.keys.includes(p.sortField));
    for (const preset of presets) {
      const active = cfg.sortField === preset.sortField && cfg.sortDirection === preset.sortDirection;
      const li = document.createElement('li');
      li.setAttribute('role', 'none');
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'filter-rail__dropdown-item' + (active ? ' filter-rail__dropdown-item--active' : '');
      row.setAttribute('role', 'menuitem');
      row.dataset.sortField = preset.sortField;
      row.dataset.sortDirection = preset.sortDirection;
      const check = document.createElement('span');
      check.className = 'filter-rail__dropdown-item-check';
      check.innerHTML = active ? iconCheck(14) : '';
      check.setAttribute('aria-hidden', 'true');
      const lab = document.createElement('span');
      lab.className = 'filter-rail__dropdown-item-label';
      const short = preset.menuLabel.includes(' — ')
        ? preset.menuLabel.split(' — ')[1]
        : preset.menuLabel;
      lab.textContent = short;
      row.appendChild(check);
      row.appendChild(lab);
      row.addEventListener('click', () => {
        _reportList?.setViewConfig({
          sortField: preset.sortField,
          sortDirection: preset.sortDirection,
        });
        _persistListViewConfig();
        _syncSortControl();
        _closeSortMenu();
      });
      li.appendChild(row);
      menu.appendChild(li);
    }
  }
}

function _rebuildGroupMenu() {
  const menu = document.getElementById('group-control-menu');
  if (!menu) return;
  const cfg = _reportList?.getViewConfig() ?? { groupBy: null };
  menu.textContent = '';
  for (const { key, label } of GROUP_OPTIONS) {
    const li = document.createElement('li');
    li.setAttribute('role', 'none');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'filter-rail__dropdown-item' + ((cfg.groupBy || null) === (key || null) ? ' filter-rail__dropdown-item--active' : '');
    row.setAttribute('role', 'menuitem');
    row.dataset.groupKey = key === null ? '' : key;
    const check = document.createElement('span');
    check.className = 'filter-rail__dropdown-item-check';
    check.innerHTML = (cfg.groupBy || null) === (key || null) ? iconCheck(14) : '';
    check.setAttribute('aria-hidden', 'true');
    const lab = document.createElement('span');
    lab.className = 'filter-rail__dropdown-item-label';
    lab.textContent = label;
    row.appendChild(check);
    row.appendChild(lab);
    row.addEventListener('click', () => {
      const next = key === null ? null : key;
      _reportList?.setViewConfig({ groupBy: next });
      _persistListViewConfig();
      _syncGroupControl();
      _closeGroupMenu();
    });
    li.appendChild(row);
    menu.appendChild(li);
  }
}

function _openSortMenu() {
  const menu = document.getElementById('sort-control-menu');
  const btn = document.getElementById('sort-control-btn');
  if (!menu || !btn) return;
  _closeGroupMenu();
  _rebuildSortMenu();
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  setTimeout(() => {
    _sortMenuDocDown = (ev) => {
      if (btn.contains(ev.target) || menu.contains(ev.target)) return;
      _closeSortMenu();
    };
    document.addEventListener('pointerdown', _sortMenuDocDown, true);
  }, 0);
}

function _openGroupMenu() {
  const menu = document.getElementById('group-control-menu');
  const btn = document.getElementById('group-control-btn');
  if (!menu || !btn) return;
  _closeSortMenu();
  _rebuildGroupMenu();
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  setTimeout(() => {
    _groupMenuDocDown = (ev) => {
      if (btn.contains(ev.target) || menu.contains(ev.target)) return;
      _closeGroupMenu();
    };
    document.addEventListener('pointerdown', _groupMenuDocDown, true);
  }, 0);
}

function _syncSortControl() {
  const btn = document.getElementById('sort-control-btn');
  if (!btn) return;
  const cfg = _reportList?.getViewConfig() ?? { sortField: 'date', sortDirection: 'desc' };
  const preset = SORT_PRESETS.find(
    x => x.sortField === cfg.sortField && x.sortDirection === cfg.sortDirection
  ) ?? SORT_PRESETS[0];
  btn.innerHTML = `${iconArrowUpDown(14)}<span class="filter-rail__toolbar-btn-label">${preset.menuLabel}</span>`;
  btn.setAttribute('aria-label', _sortTooltipText(cfg));
}

function _syncGroupControl() {
  const btn = document.getElementById('group-control-btn');
  if (!btn) return;
  const cfg = _reportList?.getViewConfig() ?? { groupBy: null };
  const g = GROUP_OPTIONS.find(x => (x.key || null) === (cfg.groupBy || null));
  const label = g?.label ?? 'No grouping';
  btn.innerHTML = `${iconLayers(14)}<span class="filter-rail__toolbar-btn-label">${label}</span>`;
  btn.classList.toggle('filter-rail__toolbar-btn--active', Boolean(cfg.groupBy));
  btn.setAttribute('aria-label', _groupTooltipText(cfg));
}

function _densityTooltipLabel(density) {
  if (density === 'compact') return 'Compact view — click to switch density';
  if (density === 'comfortable') return 'Expanded view — click to switch density';
  return 'Default view — click to switch density';
}

function _syncDensityCycleButton() {
  const btn = document.getElementById('density-cycle-btn');
  if (!btn) return;
  const cfg = _reportList?.getViewConfig() ?? { density: 'default' };
  const d = cfg.density;
  if (d === 'compact') {
    btn.innerHTML = iconList(14);
  } else if (d === 'comfortable') {
    btn.innerHTML = iconLayoutGrid(14);
  } else {
    btn.innerHTML = iconRowsComfortable(14);
  }
  btn.setAttribute('aria-label', _densityTooltipLabel(d));
}

function _disposeSidebarTooltips() {
  for (const d of _sidebarTooltipDisposers) {
    try { d(); } catch { void 0; }
  }
  _sidebarTooltipDisposers = [];
}

function _wireSidebarTooltips() {
  _disposeSidebarTooltips();
  const sortBtn = document.getElementById('sort-control-btn');
  if (sortBtn) {
    _sidebarTooltipDisposers.push(attachTooltip(sortBtn, () => {
      const cfg = _reportList?.getViewConfig() ?? { sortField: 'date', sortDirection: 'desc' };
      return _sortTooltipText(cfg);
    }));
  }
  const groupBtn = document.getElementById('group-control-btn');
  if (groupBtn) {
    _sidebarTooltipDisposers.push(attachTooltip(groupBtn, () => {
      const cfg = _reportList?.getViewConfig() ?? { groupBy: null };
      return _groupTooltipText(cfg);
    }));
  }
  const densityBtn = document.getElementById('density-cycle-btn');
  if (densityBtn) {
    _sidebarTooltipDisposers.push(attachTooltip(densityBtn, () => {
      const d = _reportList?.getViewConfig()?.density ?? 'default';
      if (d === 'compact') return 'Compact view';
      if (d === 'comfortable') return 'Expanded view';
      return 'Default view';
    }));
  }
  const clearBtn = document.getElementById('search-reports-clear');
  if (clearBtn) {
    _sidebarTooltipDisposers.push(attachTooltip(clearBtn, () => 'Clear search'));
  }
}

function _injectSidebarControlIcons() {
  const si = document.getElementById('search-reports-icon');
  if (si && !si.querySelector('svg')) {
    si.innerHTML = iconSearch(14);
  }
  const clear = document.getElementById('search-reports-clear');
  if (clear && !clear.querySelector('svg')) {
    clear.innerHTML = iconX(12);
  }
  _syncDensityCycleButton();
}

function _syncSearchClearVisibility() {
  const input = document.getElementById('search-reports');
  const clear = document.getElementById('search-reports-clear');
  if (!clear) return;
  const empty = (input?.value ?? '').trim().length === 0;
  clear.classList.toggle('filter-rail__search-clear--off', empty);
  clear.setAttribute('aria-hidden', empty ? 'true' : 'false');
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

  const savedView = _normalizeViewConfig(_loadViewConfigFromStorage());
  _reportList?.setViewConfig({
    groupBy: savedView.groupBy,
    sortField: savedView.sortField,
    sortDirection: savedView.sortDirection,
    density: savedView.density,
  });
  _persistListViewConfig();

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
          if (SINGLE_EXTRACTED_REPORT_EXPORT_FORMATS.has(payload.format)) {
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

  _injectSidebarControlIcons();

  document.getElementById('sort-control-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = document.getElementById('sort-control-menu');
    const open = menu && !menu.hidden;
    if (open) {
      _closeSortMenu();
    } else {
      _openSortMenu();
    }
  });

  document.getElementById('group-control-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = document.getElementById('group-control-menu');
    const open = menu && !menu.hidden;
    if (open) {
      _closeGroupMenu();
    } else {
      _openGroupMenu();
    }
  });

  document.getElementById('density-cycle-btn')?.addEventListener('click', () => {
    const cur = _reportList?.getViewConfig()?.density ?? 'default';
    let i = DENSITY_CYCLE_ORDER.indexOf(cur);
    if (i < 0) { i = DENSITY_CYCLE_ORDER.indexOf('default'); }
    const safeNext = DENSITY_CYCLE_ORDER[(i + 1) % DENSITY_CYCLE_ORDER.length];
    _reportList?.setViewConfig({ density: safeNext });
    _persistListViewConfig();
    _syncDensityCycleButton();
  });

  const searchClear = document.getElementById('search-reports-clear');
  searchClear?.addEventListener('click', () => {
    const input = document.getElementById('search-reports');
    if (!input) return;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  });

  let _searchDebounce;
  document.getElementById('search-reports')?.addEventListener('input', e => {
    _syncSearchClearVisibility();
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => {
      renderReportList(getState().reports ?? [], e.target.value);
    }, 250);
  });

  wireEmptyClearSearchButton();

  _syncSortControl();
  _syncGroupControl();
  _syncDensityCycleButton();
  _syncSearchClearVisibility();
  _wireSidebarTooltips();

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