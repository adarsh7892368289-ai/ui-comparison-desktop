'use strict';

import logger from '../infrastructure/logger.js';
import errorTracker from '../infrastructure/error-tracker.js';
import storage from '../infrastructure/idb-repository.js';

logger.init();
errorTracker.init();

import { getState, dispatch, subscribe } from './state.js';
import { Toast, syncCompareButton } from './ui.js';
import {
  initializeApp,
  insertReportListSkeletonOverlay,
  filteredReportCount,
  handleDeleteAllReports,
  handleExtraction,
} from './application/report-manager.js';
import {
  BULK_EXTRACTED_REPORT_EXPORT_BADGE_LABELS,
  BULK_EXTRACTED_REPORT_EXPORT_FORMAT_LABELS,
  BULK_EXTRACTED_REPORT_EXPORT_FORMATS,
  BULK_EXTRACTED_REPORT_EXPORT_MENU,
} from '@core/export/extraction-exporters/extracted-report-export-catalog.js';
import { handleExportAllReports, getBulkExportFormat, setBulkExportFormat } from './application/export-workflow.js';
import { handleImportReport } from './application/import-workflow.js';
import { handleComparison, tryLoadCachedComparison } from './application/compare-workflow.js';
import { createResultPanel } from './components/result-panel.js';
import { createAppShell }       from './components/app-shell.js';
import { SystemBanner }         from './components/system-banner.js';
import { createStatusBar }      from './components/status-bar.js';
import { attachTooltip }        from './components/tooltip/tooltip.js';
import {
  getLeftPanelRailWidthPx,
  syncLeftPanelRailState,
  TOOLBAR_COMPACT_PX,
} from './utils/left-panel-breakpoints.js';
import {
  iconAlertCircle,
  iconArrowUp,
  iconChevronDown,
  iconFileDown,
  iconTrash2,
} from './utils/icons.js';

const api = window.electronAPI;
if (!api) {
  const showBridgeFatal = () => {
    document.body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100vh;
                  flex-direction:column;gap:16px;background:#0f1523;font-family:system-ui">
        <span style="color:#ef4444;display:inline-flex" aria-hidden="true">${iconAlertCircle(32)}</span>
        <p style="font-size:15px;font-weight:600;color:#e8ecf2;margin:0">Failed to initialize</p>
        <p style="font-size:13px;color:#a0aec0;margin:0">Window bridge unavailable — restart the application.</p>
      </div>`;
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', showBridgeFatal);
  } else {
    showBridgeFatal();
  }
  throw new Error('window.electronAPI is undefined');
}

api.setWindowTitle?.('UI Comparison');

/** @type {(() => void)[]} */
let _toolbarDiscoveryTooltipDisposers = [];

function isKeyboardTypingContext(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) { return false; }
  const t = el.tagName;
  if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') { return true; }
  return Boolean(el.isContentEditable);
}

function initSidebarLayoutObservers() {
  const row = document.querySelector('[data-sidebar-toolbar]');
  const panel = document.getElementById('left-panel');
  if (typeof ResizeObserver === 'undefined') { return; }

  const flush = () => {
    requestAnimationFrame(() => {
      syncLeftPanelRailState();
      if (!row || !panel || panel.classList.contains('left-panel--collapsed')) {
        row?.removeAttribute('data-compact');
        return;
      }
      const w = getLeftPanelRailWidthPx();
      if (w != null) {
        row.dataset.compact = w < TOOLBAR_COMPACT_PX ? 'true' : 'false';
      }
    });
  };

  if (panel) {
    const roPanel = new ResizeObserver(flush);
    roPanel.observe(panel);
  }
  flush();
}

function wireToolbarDiscoveryTooltips() {
  for (const d of _toolbarDiscoveryTooltipDisposers) {
    try { d(); } catch { void 0; }
  }
  _toolbarDiscoveryTooltipDisposers = [];

  const importBtn = document.getElementById('import-report-btn');
  if (importBtn) {
    _toolbarDiscoveryTooltipDisposers.push(
      attachTooltip(importBtn, () => 'Import report from file')
    );
  }
  const deleteBtn = document.getElementById('delete-all-btn');
  if (deleteBtn) {
    _toolbarDiscoveryTooltipDisposers.push(
      attachTooltip(deleteBtn, () => 'Delete all reports')
    );
  }
  const exportPrimary = document.getElementById('export-all-btn');
  if (exportPrimary) {
    _toolbarDiscoveryTooltipDisposers.push(
      attachTooltip(exportPrimary, () => {
        const fmt = getBulkExportFormat();
        const name = BULK_EXTRACTED_REPORT_EXPORT_FORMAT_LABELS[fmt] ?? String(fmt).toUpperCase();
        return `Export all reports as ${name}`;
      })
    );
  }
  const exportTrigger = document.getElementById('export-format-trigger');
  if (exportTrigger) {
    _toolbarDiscoveryTooltipDisposers.push(
      attachTooltip(exportTrigger, () => 'Choose export format')
    );
  }
  const sortBtn = document.getElementById('sort-control-btn');
  if (sortBtn) {
    _toolbarDiscoveryTooltipDisposers.push(
      attachTooltip(sortBtn, () => {
        const lab = sortBtn.querySelector('.filter-rail__toolbar-btn-label');
        const t = lab?.textContent?.trim();
        return t ? `Sort: ${t}` : 'Sort reports';
      })
    );
  }
  const groupBtn = document.getElementById('group-control-btn');
  if (groupBtn) {
    _toolbarDiscoveryTooltipDisposers.push(
      attachTooltip(groupBtn, () => {
        const lab = groupBtn.querySelector('.filter-rail__toolbar-btn-label');
        const t = lab?.textContent?.trim();
        return t ? `Group: ${t}` : 'Group reports';
      })
    );
  }
}

function wireExportSplitControls() {
  const menu = document.getElementById('export-format-menu');
  const trigger = document.getElementById('export-format-trigger');
  const primary = document.getElementById('export-all-btn');

  if (menu && menu.childElementCount === 0) {
    for (const { format, label } of BULK_EXTRACTED_REPORT_EXPORT_MENU) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'split-btn__menu-item';
      item.setAttribute('role', 'menuitem');
      item.dataset.format = format;
      item.textContent = label;
      menu.appendChild(item);
    }
  }

  const closeFormatMenu = () => {
    if (menu) menu.hidden = true;
    trigger?.setAttribute('aria-expanded', 'false');
  };

  const applyBulkFormatUi = (format) => {
    const name = BULK_EXTRACTED_REPORT_EXPORT_FORMAT_LABELS[format] ?? String(format).toUpperCase();
    const badgeText = BULK_EXTRACTED_REPORT_EXPORT_BADGE_LABELS[format] ?? String(format).toUpperCase();
    const label = document.querySelector('#export-split-btn .split-btn__label');
    if (label) label.textContent = name;
    const badge = primary?.querySelector('.format-badge');
    if (badge) badge.textContent = badgeText;
    if (primary) {
      primary.title = `Export all as ${name}`;
      primary.setAttribute('aria-label', `Export all reports as ${name}`);
    }
    if (primary && !primary.querySelector('svg')) {
      primary.insertAdjacentHTML('afterbegin', iconFileDown(14));
    }
  };

  trigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!menu || !trigger) return;
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    trigger.setAttribute('aria-expanded', String(willOpen));
  });

  menu?.addEventListener('click', (e) => {
    const item = e.target.closest('[data-format]');
    if (!item) return;
    const f = item.dataset.format;
    if (!f || !BULK_EXTRACTED_REPORT_EXPORT_FORMATS.has(f)) return;
    setBulkExportFormat(f);
    applyBulkFormatUi(getBulkExportFormat());
    closeFormatMenu();
  });

  document.addEventListener('click', (e) => {
    const split = document.getElementById('export-split-btn');
    if (!split || !menu || menu.hidden) return;
    if (split.contains(e.target)) return;
    closeFormatMenu();
  });

  primary?.addEventListener('click', () => {
    closeFormatMenu();
    void handleExportAllReports();
  });

  applyBulkFormatUi(getBulkExportFormat());
}

let _resultPanel        = null;
let _appShell           = null;
let _statusBar          = null;

document.addEventListener('DOMContentLoaded', async () => {
  if (api.platform === 'darwin') {
    document.documentElement.classList.add('platform-darwin');
  }

  const exportAllPrimary = document.getElementById('export-all-btn');
  if (exportAllPrimary && !exportAllPrimary.querySelector('svg')) {
    exportAllPrimary.insertAdjacentHTML('afterbegin', iconFileDown(14));
  }
  const exportFormatTrigger = document.getElementById('export-format-trigger');
  if (exportFormatTrigger && !exportFormatTrigger.querySelector('svg')) {
    exportFormatTrigger.insertAdjacentHTML('afterbegin', iconChevronDown(10));
  }
  wireExportSplitControls();
  const importToolbarBtn = document.getElementById('import-report-btn');
  if (importToolbarBtn && !importToolbarBtn.querySelector('svg')) {
    importToolbarBtn.insertAdjacentHTML('afterbegin', iconArrowUp(13));
  }
  const deleteAllToolbarBtn = document.getElementById('delete-all-btn');
  if (deleteAllToolbarBtn && !deleteAllToolbarBtn.querySelector('svg')) {
    deleteAllToolbarBtn.insertAdjacentHTML('afterbegin', iconTrash2(14));
  }

  insertReportListSkeletonOverlay();
  _statusBar = createStatusBar();
  _statusBar.updatePhase(getState());
  await initializeApp(_statusBar);

  const compareResultsEl = document.getElementById('compare-results');
  if (compareResultsEl) {
    _resultPanel = createResultPanel(compareResultsEl);
    _resultPanel.clear();
  }

  if (await storage.consumeV5UpgradeDataClearedNotice()) {
    Toast.show(
      'A database upgrade cleared your stored reports. Export your data before upgrading in future.',
      'warning',
      0
    );
  }

  window.addEventListener('storage-degraded', (event) => {
    if (event.detail?.reason === 'WAL_REPLAY_EXHAUSTED') {
      SystemBanner.warning(
        'Storage degraded — some previously queued writes could not be replayed. Those records may be missing.'
      );
    } else {
      SystemBanner.error(
        'Storage failure — too many consecutive write errors. No new data will be saved. Restart the app to recover.'
      );
    }
  });

  _appShell = createAppShell();
  initSidebarLayoutObservers();
  wireToolbarDiscoveryTooltips();

  const panelToggleBtn = document.getElementById('panel-toggle-btn');
  if (panelToggleBtn) {
    attachTooltip(panelToggleBtn, () => panelToggleBtn.getAttribute('aria-label') || '');
  }

  document.getElementById('panel-toggle-btn')
    ?.addEventListener('click', () => _appShell.toggleLeftPanel());

  _appShell.activateSection('extract');

  document.getElementById('url-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.repeat) {
      const btn = document.getElementById('extract-btn');
      if (btn && !btn.disabled) btn.click();
    }
  });

  document.getElementById('url-input')?.addEventListener('input', () => {
    const errEl = document.getElementById('extract-error');
    if (errEl) errEl.textContent = '';
  });

  document.addEventListener('keydown', e => {
    const active = document.activeElement;
    const typing = isKeyboardTypingContext(active);
    if (e.key === 'Escape' && !e.repeat) {
      const overlay = document.getElementById('modal-overlay');
      if (!overlay || overlay.classList.contains('hidden')) {
        const panel = document.getElementById('left-panel');
        if (
          _appShell
          && panel
          && panel.contains(document.activeElement)
          && !panel.classList.contains('left-panel--collapsed')
        ) {
          e.preventDefault();
          e.stopPropagation();
          _appShell.collapseLeftPanelIfExpanded();
          return;
        }
      }
    }
    if (e.key === 'Enter' && !e.repeat && getState().phase === 'error' && !typing) {
      e.preventDefault();
      dispatch('DISMISS_ERROR');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B') && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      _appShell.toggleLeftPanel();
      return;
    }
    if (typing) { return; }
    if (e.key === 'e' || e.key === 'E') { _appShell.activateSection('extract'); }
    if (e.key === 'c' || e.key === 'C') {
      const el = document.activeElement;
      const v = el?.closest?.('.vscroll-viewport');
      if (el && v && el !== v) { return; }
      _appShell.activateSection('compare');
    }
    if (e.key === '/') {
      e.preventDefault();
      document.getElementById('search-reports')?.focus();
    }
    if (e.key === 'Escape') {
      const search = document.getElementById('search-reports');
      if (search?.value) {
        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        search.focus();
      }
    }
  });

  document.getElementById('extract-btn')?.addEventListener('click', handleExtraction);

  document.getElementById('delete-all-btn')?.addEventListener('click', async () => {
    await handleDeleteAllReports();
  });

  document.getElementById('import-report-btn')?.addEventListener('click', () => {
    document.getElementById('import-report-input')?.click();
  });
  document.getElementById('import-report-input')?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    handleImportReport(file, null);
  });

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

  document.querySelectorAll('[name="compare-mode"]').forEach(r => {
    r.addEventListener('change', e => {
      if (e.target.checked) {
        dispatch('MODE_CHANGED', { mode: e.target.value });
        tryLoadCachedComparison();
      }
    });
  });

  document.getElementById('compare-btn')?.addEventListener('click', handleComparison);

  document.addEventListener('keydown', async (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || !e.shiftKey || e.key.toLowerCase() !== 'd') { return; }
    e.preventDefault();
    showDiagnosticsPanel();
  });

  window.electronAPI?.onMenuAction?.((action) => {
    if (action === 'toggle-sidebar') _appShell.toggleLeftPanel();
  });

  subscribe((state) => {
    _statusBar?.updatePhase(state);
    const reports = state.reports ?? [];
    const searchQ = document.getElementById('search-reports')?.value ?? '';
    _statusBar?.updateReportCount(reports, filteredReportCount(reports, searchQ));

    if (state.phase === 'comparing') {
      _resultPanel?.showComparing?.();
    } else if (state.phase === 'error') {
      _resultPanel?.showError?.(state.error);
    } else if (state.comparison && state.phase === 'done') {
      _resultPanel?.render(state.comparison, state.cachedAt ?? null);
    } else if (state.phase === 'idle') {
      _resultPanel?.clear();
    }

  });
});

async function showDiagnosticsPanel() {
  const api = window.electronAPI;
  const result = await api.getPerfMetrics();
    if (!result?.success) { Toast.show('Diagnostics unavailable', 'error'); return; }

    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', background: 'var(--color-scrim)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: '9999',
    });

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      background: 'var(--color-surface-base)', color: 'var(--color-text-primary)',
      borderRadius: '8px', padding: '24px', maxWidth: '900px', width: '90vw',
      maxHeight: '80vh', overflow: 'auto', boxShadow: 'var(--shadow-lg)',
    });

    const titleEl = document.createElement('p');
    titleEl.className   = 'modal-title';
    titleEl.textContent = 'Performance Diagnostics';

    const table  = document.createElement('table');
    table.className = 'diag-table';
    const thead = table.createTHead();
    const hrow  = thead.insertRow();
    for (const h of ['Phase', 'Count', 'p50', 'p95', 'p99', 'Last (ms)']) {
      const th = document.createElement('th');
      th.textContent = h;
      hrow.appendChild(th);
    }

    const tbody  = table.createTBody();
    const entries = Object.entries(result.metrics ?? {});
    if (entries.length === 0) {
      const row = tbody.insertRow();
      const td  = row.insertCell();
      td.setAttribute('colspan', '6');
      td.textContent = 'No data yet';
    } else {
      for (const [phase, s] of entries) {
        const row = tbody.insertRow();
        for (const val of [phase, s.count, s.p50 ?? '—', s.p95 ?? '—', s.p99 ?? '—', s.lastMs ?? '—']) {
          const td = row.insertCell();
          td.textContent = String(val);
        }
      }
    }

    const closeBtn = document.createElement('button');
    closeBtn.className   = 'btn-primary btn-sm';
    closeBtn.textContent = 'Close';
    Object.assign(closeBtn.style, { marginTop: '16px' });

    panel.append(titleEl, table, closeBtn);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const dismiss = () => overlay.remove();
    closeBtn.addEventListener('click', dismiss);
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) { dismiss(); } });
    const escHandler = (ev) => { if (ev.key === 'Escape') { dismiss(); document.removeEventListener('keydown', escHandler); } };
    document.addEventListener('keydown', escHandler);
}