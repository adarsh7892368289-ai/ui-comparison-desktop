import storage from '../../infrastructure/idb-repository.js';
import { dispatch, getState, subscribe } from '../state.js';
import {
  Toast,
  Modal,
  syncCompareButton } from
'../ui.js';
import { SINGLE_EXTRACTED_REPORT_EXPORT_FORMATS } from '@core/export/extraction-exporters/extracted-report-export-catalog.js';
import { handleExportReport } from './export-workflow.js';
import { relativeTime } from '../utils/time.js';
import { hostFromUrl, lastPathSegment, envTag } from '../utils/report-metadata.js';
import { createReportList } from '../components/report-list.js';
import { createMultiSelectToolbar } from '../components/multi-select-toolbar.js';
import { attachTooltip } from '../components/tooltip/tooltip.js';
import {
  wireReportSelect,
  refreshReportSelectPanel,
  syncReportSelectTrigger } from
'../components/report-select-combobox.js';
import {
  iconArrowUpDown,
  iconCheck,
  iconLayers,
  iconLayoutGrid,
  iconList,
  iconRowsComfortable,
  iconSearch,
  iconX } from
'../utils/icons.js';

let _reportList = null;
let _statusBar = null;
let _multiSelectToolbar = null;

let _undoBuffer = null;
let _undoTimer = null;
let _undoActive = false;
let _deferredLoads = [];

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
{ sortField: 'elements', sortDirection: 'asc', menuLabel: 'Elements — fewest first' }];


const DENSITY_CYCLE_ORDER = ['compact', 'default', 'comfortable'];

const GROUP_OPTIONS = [
{ key: null, label: 'No grouping' },
{ key: 'host', label: 'By Host' },
{ key: 'date', label: 'By Date' },
{ key: 'environment', label: 'By Environment' },
{ key: 'job', label: 'By Bulk Run' }];


const VIEW_CONFIG_KEY = 'sidebar-view-config';
const LEGACY_VIEW_CONFIG_KEY = 'report-view-config';

function _loadViewConfigFromStorage() {
  try {
    const cur = localStorage.getItem(VIEW_CONFIG_KEY);
    if (cur) {return JSON.parse(cur);}
  } catch {void 0;}
  try {
    const leg = localStorage.getItem(LEGACY_VIEW_CONFIG_KEY);
    if (leg) {
      const parsed = JSON.parse(leg);
      try {
        localStorage.setItem(VIEW_CONFIG_KEY, leg);
        localStorage.removeItem(LEGACY_VIEW_CONFIG_KEY);
      } catch {void 0;}
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    }
  } catch {void 0;}
  return {};
}

function _saveViewConfig(patch) {
  try {
    const existing = JSON.parse(localStorage.getItem(VIEW_CONFIG_KEY) || '{}');
    localStorage.setItem(VIEW_CONFIG_KEY, JSON.stringify({ ...existing, ...patch }));
  } catch {void 0;}
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
  const density = ['default', 'compact', 'comfortable'].includes(o.density) ?
  o.density :
  'default';
  let groupBy = o.groupBy ?? null;
  if (groupBy === '') {groupBy = null;}
  return { sortField, sortDirection, density, groupBy };
}

function _persistListViewConfig() {
  const cfg = _reportList?.getViewConfig();
  if (!cfg) return;
  _saveViewConfig({
    groupBy: cfg.groupBy,
    sortField: cfg.sortField,
    sortDirection: cfg.sortDirection,
    density: cfg.density
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
  if (menu) {menu.hidden = true;}
  if (btn) {btn.setAttribute('aria-expanded', 'false');}
  _removeSortMenuListener();
}

function _closeGroupMenu() {
  const menu = document.getElementById('group-control-menu');
  const btn = document.getElementById('group-control-btn');
  if (menu) {menu.hidden = true;}
  if (btn) {btn.setAttribute('aria-expanded', 'false');}
  _removeGroupMenuListener();
}

function _sortTooltipText(cfg) {
  const p = SORT_PRESETS.find(
    (x) => x.sortField === cfg.sortField && x.sortDirection === cfg.sortDirection
  );
  return p ? `Sort: ${p.menuLabel}` : 'Sort: Date — newest first';
}

function _groupTooltipText(cfg) {
  if (!cfg.groupBy) return 'No grouping';
  const g = GROUP_OPTIONS.find((x) => x.key === cfg.groupBy);
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
  { title: 'Elements', keys: ['elements'] }];

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
    const presets = SORT_PRESETS.filter((p) => g.keys.includes(p.sortField));
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
      const short = preset.menuLabel.includes(' — ') ?
      preset.menuLabel.split(' — ')[1] :
      preset.menuLabel;
      lab.textContent = short;
      row.appendChild(check);
      row.appendChild(lab);
      row.addEventListener('click', () => {
        _reportList?.setViewConfig({
          sortField: preset.sortField,
          sortDirection: preset.sortDirection
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
      if (getState().multiSelect.active) {
        dispatch('MULTI_SELECT_CLEAR');
      }
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
    (x) => x.sortField === cfg.sortField && x.sortDirection === cfg.sortDirection
  ) ?? SORT_PRESETS[0];
  btn.innerHTML = `${iconArrowUpDown(14)}<span class="filter-rail__toolbar-btn-label">${preset.menuLabel}</span>`;
  btn.setAttribute('aria-label', _sortTooltipText(cfg));
}

function _syncGroupControl() {
  const btn = document.getElementById('group-control-btn');
  if (!btn) return;
  const cfg = _reportList?.getViewConfig() ?? { groupBy: null };
  const g = GROUP_OPTIONS.find((x) => (x.key || null) === (cfg.groupBy || null));
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
    try {d();} catch {void 0;}
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

async function _syncJobMeta(state) {
  if (!_reportList) return;
  const cfg = _reportList.getViewConfig();
  if (cfg.groupBy !== 'job') return;

  const map = new Map();
  let storedJobs = [];
  try {
    if (typeof storage.loadAllBulkJobs === 'function') {
      storedJobs = await storage.loadAllBulkJobs();
    }
  } catch {void 0;}

  for (const j of storedJobs ?? []) {
    if (!j?.id) continue;
    map.set(j.id, {
      filename: j.filename ?? null,
      totalPairs: j.totalPairs ?? null,
      createdAt: j.createdAt ?? null,
      status: j.status ?? null
    });
  }

  const job = state.bulkJob;
  if (job?.jobId) {
    const existing = map.get(job.jobId) ?? {};
    map.set(job.jobId, {
      ...existing,
      filename: job.filename ?? existing.filename ?? null,
      totalPairs: job.totalPairs ?? job.pairs?.length ?? existing.totalPairs ?? null,
      createdAt: job.startedAt ?? existing.createdAt ?? null,
      status: job.status ?? existing.status ?? null
    });
  }

  _reportList.setJobMeta(map);
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
  if (el) {el.textContent = message;}
}

function selectBaselineFromReport(report) {
  const wasBaseline = getState().selectedBaseline === report.id;
  dispatch('BASELINE_SELECTED', { id: report.id });
  const sel = document.getElementById('baseline-report');
  if (sel) {
    sel.value = getState().selectedBaseline ?? '';
    syncReportSelectTrigger(sel);
  }
  syncCompareButton();
  if (wasBaseline) {
    Toast.info('Baseline cleared');
    announceReportList('Baseline cleared');
  } else {
    Toast.success('Set as baseline');
    announceReportList(`Set as baseline — ${hostFromUrl(report.url)}`);
  }
}

function selectCompareFromReport(report) {
  const wasCompare = getState().selectedCompare === report.id;
  dispatch('COMPARE_SELECTED', { id: report.id });
  const sel = document.getElementById('compare-report');
  if (sel) {
    sel.value = getState().selectedCompare ?? '';
    syncReportSelectTrigger(sel);
  }
  syncCompareButton();
  if (wasCompare) {
    Toast.info('Compare cleared');
    announceReportList('Compare cleared');
  } else {
    Toast.success('Set as compare');
    announceReportList(`Set as compare — ${hostFromUrl(report.url)}`);
  }
}

function insertReportListSkeletonOverlay() {
  const c = document.getElementById('reports-list');
  if (!c || c.querySelector('.report-list-skeleton-overlay')) {return;}
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
  return list.filter((r) =>
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
  if (!empty) {return;}
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
    if (titleEl) {titleEl.textContent = 'No results';}
  }
}

async function loadAndRenderReports() {
  if (_undoActive) {
    _deferredLoads.push(() => loadAndRenderReports());
    return;
  }
  const reports = await storage.loadReports();
  dispatch('REPORTS_LOADED', { reports });

  const query = document.getElementById('search-reports')?.value ?? '';
  renderReportList(reports, query);
  populateReportSelectors(reports);
}

function _drainDeferredLoads() {
  const pending = _deferredLoads.splice(0);
  if (pending.length > 0) {
    pending[pending.length - 1]();
  }
}

async function handleDeleteSelectedReports() {
  const state = getState();
  const ms = state.multiSelect;
  if (!ms.active || ms.selectedIds.size === 0) return;

  const ids = [...ms.selectedIds];
  const count = ids.length;

  const confirmed = await Modal.confirm(
    'Delete selected reports',
    `Delete ${count} report${count !== 1 ? 's' : ''}? You will have 5 seconds to undo.`,
    { confirmText: 'Delete', destructive: true }
  );
  if (!confirmed) return;

  _undoBuffer = state.reports.filter((r) => ids.includes(r.id));

  dispatch('MULTI_SELECT_AFTER_DELETE', { deletedIds: ids });
  dispatch('REPORTS_REMOVE_BY_IDS', { ids });

  const query = document.getElementById('search-reports')?.value ?? '';
  renderReportList(getState().reports, query);
  populateReportSelectors(getState().reports);

  _undoActive = true;

  const deletedBaseline = _undoBuffer.some((r) => r.id === state.selectedBaseline);
  const deletedCompare = _undoBuffer.some((r) => r.id === state.selectedCompare);
  if (deletedBaseline && deletedCompare) {
    Toast.info('Baseline and compare reports were deleted — select new ones');
  } else if (deletedBaseline) {
    Toast.info('Baseline report was deleted — select a new one');
  } else if (deletedCompare) {
    Toast.info('Compare report was deleted — select a new one');
  }

  _showUndoToast(count);
  _undoTimer = setTimeout(() => _commitDelete(ids), 5000);
}

async function _commitDelete(ids) {
  if (!_undoActive) return;
  clearTimeout(_undoTimer);
  _undoTimer = null;
  const savedBuffer = _undoBuffer;
  _undoBuffer = null;
  _undoActive = false;

  _dismissUndoToast();

  try {
    await storage.deleteReportsBatch(ids);
  } catch (err) {

    if (savedBuffer && savedBuffer.length > 0) {
      dispatch('REPORTS_RESTORE', { reports: savedBuffer });
      const query = document.getElementById('search-reports')?.value ?? '';
      renderReportList(getState().reports, query);
      populateReportSelectors(getState().reports);
    }
    Toast.error('Delete failed — reports restored');
  }

  _drainDeferredLoads();
}

function _handleUndo() {
  if (!_undoActive) return;
  clearTimeout(_undoTimer);
  _undoTimer = null;
  _undoActive = false;

  _dismissUndoToast();

  if (_undoBuffer) {
    dispatch('REPORTS_RESTORE', { reports: _undoBuffer });
    const query = document.getElementById('search-reports')?.value ?? '';
    renderReportList(getState().reports, query);
    populateReportSelectors(getState().reports);
    Toast.info(`${_undoBuffer.length} report${_undoBuffer.length !== 1 ? 's' : ''} restored`);
  }
  _undoBuffer = null;

  _drainDeferredLoads();
}

let _undoToastEl = null;

function _showUndoToast(count) {
  _dismissUndoToast();
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast toast--info toast--has-progress';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  const main = document.createElement('div');
  main.className = 'toast-main';

  const copy = document.createElement('div');
  copy.className = 'toast-copy';
  const title = document.createElement('div');
  title.className = 'toast-title';
  title.textContent = `${count} report${count !== 1 ? 's' : ''} deleted`;
  copy.appendChild(title);
  main.appendChild(copy);

  const undoBtn = document.createElement('button');
  undoBtn.type = 'button';
  undoBtn.className = 'btn-ghost btn-sm toast-undo-btn';
  undoBtn.textContent = 'Undo';
  undoBtn.style.marginLeft = 'auto';
  undoBtn.style.fontWeight = '600';
  undoBtn.addEventListener('click', () => _handleUndo());
  main.appendChild(undoBtn);

  toast.appendChild(main);

  const bar = document.createElement('div');
  bar.className = 'toast-progress';
  toast.appendChild(bar);

  container.appendChild(toast);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      toast.classList.add('toast--visible');
      bar.style.transition = 'transform 5000ms linear';
      requestAnimationFrame(() => {bar.style.transform = 'scaleX(0)';});
    });
  });

  _undoToastEl = toast;
}

function _dismissUndoToast() {
  if (!_undoToastEl) return;
  _undoToastEl.remove();
  _undoToastEl = null;
}

function populateReportSelectors(reports) {
  const total = reports.length;
  const envTags = reports.map((r) => envTag(r.url));
  const hasMultiEnv = envTags.some((e) => e === 'STAGE');

  ['baseline-report', 'compare-report'].forEach((selId) => {
    const sel = document.getElementById(selId);
    if (!sel) {return;}
    const current = sel.value;
    sel.textContent = '';
    sel.appendChild(new Option('Select report…', ''));
    reports.forEach((r, i) => {
      const host = hostFromUrl(r.url).replace(/^www\./, '');
      const path = lastPathSegment(r.url);
      const displayIdx = total - i;
      const envPrefix = hasMultiEnv ? `${envTag(r.url)} · ` : '';
      const importedPfx = r.source === 'imported' ? '[↑] ' : '';
      const label = `${importedPfx}R${displayIdx} · ${envPrefix}${host}${path}`;
      const opt = new Option(label, r.id);
      opt.title = `${r.url} · ${r.totalElements ?? 0} elements · ${relativeTime(r.timestamp)}`;
      opt.dataset.reportUrl = r.url || '';
      opt.dataset.reportElements = String(r.totalElements ?? 0);
      opt.dataset.reportTime = relativeTime(r.timestamp);
      if (r.id === current) {opt.selected = true;}
      sel.appendChild(opt);
    });
    refreshReportSelectPanel(sel);
  });
  const br = document.getElementById('baseline-report');
  const cr = document.getElementById('compare-report');
  const bv = br?.value ?? '';
  const cv = cr?.value ?? '';
  const stSel = getState();
  if (bv && bv !== stSel.selectedBaseline) {
    dispatch('BASELINE_SELECTED', { id: bv });
  }
  if (cv && cv !== stSel.selectedCompare) {
    dispatch('COMPARE_SELECTED', { id: cv });
  }
  syncCompareButton();
}

async function handleDeleteReport(report) {
  const confirmed = await Modal.confirm(
    'Delete report',
    `Delete "${report.title || hostFromUrl(report.url)}"? This cannot be undone.`,
    { confirmText: 'Delete', destructive: true }
  );
  if (!confirmed) {return;}
  try {
    await storage.deleteReport(report.id);
    await loadAndRenderReports();
    Toast.success('Report deleted');
  } catch (err) {
    Toast.error(err.message ?? 'Delete failed');
  }
}

async function _handleDeleteBulkJob(jobId) {
  if (!jobId) {return;}
  let jobLabel = jobId.slice(0, 8) + '…';
  try {
    const meta = await storage.loadBulkJob?.(jobId);
    if (meta?.filename) {jobLabel = meta.filename;}
  } catch {void 0;}

  const confirmed = await Modal.confirm(
    'Delete bulk run',
    `Delete bulk run "${jobLabel}" and all its pairs? This cannot be undone.`,
    { confirmText: 'Delete', destructive: true }
  );
  if (!confirmed) {return;}
  try {
    if (typeof storage.deleteBulkJobCascade !== 'function') {
      Toast.error('Bulk delete is not supported in this build.');
      return;
    }
    await storage.deleteBulkJobCascade(jobId);
    if (getState().bulkJob?.jobId === jobId) {
      dispatch('BULK_JOB_RESET');
    }
    await loadAndRenderReports();
    Toast.success('Bulk run deleted');
  } catch (err) {
    Toast.error(err?.message ?? 'Delete failed');
  }
}

async function handleDeleteAllReports() {
  const state = getState();
  const reports = state.reports ?? [];
  if (reports.length === 0) {Toast.info('No reports to delete');return;}

  const confirmed = await Modal.confirm(
    'Delete all reports',
    `This permanently deletes all ${reports.length} saved report${reports.length !== 1 ? 's' : ''}. This cannot be undone.`,
    { confirmText: 'Delete All', destructive: true }
  );
  if (!confirmed) {return;}
  try {
    await storage.deleteAllReports();
    await loadAndRenderReports();
    Toast.success(`Deleted ${reports.length} report${reports.length !== 1 ? 's' : ''}`);
  } catch (err) {
    Toast.error(err.message ?? 'Delete failed');
  }
}

async function initializeApp(statusBar) {
  console.log('[report-manager] initializeApp START');
  _statusBar = statusBar ?? null;
  try {
    await Promise.race([
      storage.applyPendingOperations(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('IDB init timeout')), 3000))
    ]);
    console.log('[report-manager] applyPendingOperations done');
  } catch (err) {
    console.warn('[report-manager] applyPendingOperations failed or timed out, continuing init', err);
  }

  try {
    const profile = await storage.loadToleranceProfile();
    if (profile && profile.tolerances && typeof profile.tolerances === 'object') {
      dispatch('SET_TOLERANCES', { tolerances: profile.tolerances });
    }
  } catch (err) {
    console.warn('[report-manager] loadToleranceProfile failed, using default tolerances', err);
  }

  const listContainer = document.getElementById('reports-list');
  if (listContainer) {
    _reportList = createReportList(listContainer, {
      onSelect: (report) => {
        _reportList?.setSelected(report.id);
      },
      onDelete: (report) => handleDeleteReport(report),
      onBaseline: (report) => selectBaselineFromReport(report),
      onCompare: (report) => selectCompareFromReport(report),
      onMultiSelectEnter: (id) => {
        dispatch('MULTI_SELECT_ENTER', { id });
      },
      onMultiSelectToggle: (id) => {
        dispatch('MULTI_SELECT_TOGGLE', { id });
      },
      onMultiSelectAll: (ids) => {
        dispatch('MULTI_SELECT_ALL', { ids });
      },
      onMultiSelectExit: () => {
        dispatch('MULTI_SELECT_EXIT');
      },
      onMultiSelectDelete: () => {
        handleDeleteSelectedReports();
      }
    });
  }

  const savedView = _normalizeViewConfig(_loadViewConfigFromStorage());
  _reportList?.setViewConfig({
    groupBy: savedView.groupBy,
    sortField: savedView.sortField,
    sortDirection: savedView.sortDirection,
    density: savedView.density
  });
  _persistListViewConfig();
  _syncJobMeta(getState());

  if (typeof api?.onContextAction === 'function') {
    api.onContextAction((payload) => {
      if (!payload) {return;}
      if (payload.action === 'deleteSelected') {
        handleDeleteSelectedReports();
        return;
      }
      if (payload.action === 'deleteBulkJob' && typeof payload.bulkJobId === 'string') {
        void _handleDeleteBulkJob(payload.bulkJobId);
        return;
      }
      if (typeof payload.reportId !== 'string') {return;}
      const reports = getState().reports ?? [];
      const report = reports.find((r) => r.id === payload.reportId);
      if (!report) {return;}
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

  const toolbarSlot = document.getElementById('multi-select-toolbar-slot');
  if (toolbarSlot) {
    _multiSelectToolbar = createMultiSelectToolbar(toolbarSlot);

    toolbarSlot.addEventListener('multi-select-action', (e) => {
      const action = e.detail?.action;
      if (action === 'select-all') {
        const ids = _reportList?.getVisibleReportIds() ?? [];
        dispatch('MULTI_SELECT_ALL', { ids });
      } else if (action === 'deselect') {
        dispatch('MULTI_SELECT_CLEAR');
      } else if (action === 'delete') {
        handleDeleteSelectedReports();
      } else if (action === 'close') {
        dispatch('MULTI_SELECT_EXIT');
      }
    });
  }

  subscribe((state) => {
    _reportList?.setBaseline(state.selectedBaseline ?? null);
    _reportList?.setCompare(state.selectedCompare ?? null);
    _reportList?.setMultiSelectMode(state.multiSelect.active);
    _reportList?.setSelectedIds(state.multiSelect.selectedIds);
    _reportList?.setAnchorId(state.multiSelect.anchorId);
    _multiSelectToolbar?.render(state);
    _syncJobMeta(state);
  });

  console.log('[report-manager] injecting sidebar control icons');
  _injectSidebarControlIcons();
  console.log('[report-manager] wiring event listeners');

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
    if (i < 0) {i = DENSITY_CYCLE_ORDER.indexOf('default');}
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
  document.getElementById('search-reports')?.addEventListener('input', (e) => {
    _syncSearchClearVisibility();
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => {
      renderReportList(getState().reports ?? [], e.target.value);
    }, 250);
  });

  wireEmptyClearSearchButton();

  console.log('[report-manager] syncing controls');
  _syncSortControl();
  _syncGroupControl();
  _syncDensityCycleButton();
  _syncSearchClearVisibility();
  _wireSidebarTooltips();
  console.log('[report-manager] controls synced, loading reports');

  const baselineSelect = document.getElementById('baseline-report');
  const compareSelect = document.getElementById('compare-report');
  if (baselineSelect) {wireReportSelect(baselineSelect);}
  if (compareSelect) {wireReportSelect(compareSelect);}

  await loadAndRenderReports();
  console.log('[report-manager] initializeApp END');
}

export {
  insertReportListSkeletonOverlay,
  renderReportList,
  filteredReportCount,
  loadAndRenderReports,
  populateReportSelectors,
  handleDeleteReport,
  handleDeleteAllReports,
  handleDeleteSelectedReports,
  initializeApp };