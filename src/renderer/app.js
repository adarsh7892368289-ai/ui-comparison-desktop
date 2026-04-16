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
  hostFromUrl,
} from './application/report-manager.js';
import { handleExportAllReports, getBulkExportFormat, setBulkExportFormat } from './application/export-workflow.js';
import { handleImportReport } from './application/import-workflow.js';
import { handleComparison, tryLoadCachedComparison } from './application/compare-workflow.js';
import { createResultPanel } from './components/result-panel.js';
import { createAppShell }       from './components/app-shell.js';
import { createCommandPalette } from './components/command-palette.js';
import { SystemBanner }         from './components/system-banner.js';
import { createStatusBar }      from './components/status-bar.js';
import {
  iconActivity,
  iconAlertCircle,
  iconArrowUp,
  iconChevronDown,
  iconFileDown,
  iconGitCompare,
  iconGlobe,
  iconLayoutGrid,
  iconList,
  iconMoreHorizontal,
  iconPlay,
  iconSearch,
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

function wireExportSplitControls() {
  const formatNames = { xlsx: 'Excel', csv: 'CSV', json: 'JSON' };
  const menu = document.getElementById('export-format-menu');
  const trigger = document.getElementById('export-format-trigger');
  const primary = document.getElementById('export-all-btn');

  const closeFormatMenu = () => {
    if (menu) menu.hidden = true;
    trigger?.setAttribute('aria-expanded', 'false');
  };

  const applyBulkFormatUi = (format) => {
    const name = formatNames[format] ?? String(format).toUpperCase();
    const label = document.querySelector('#export-split-btn .split-btn__label');
    if (label) label.textContent = name;
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
    if (!f) return;
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
let _cmdPalette         = null;
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
  const densityBtn = document.getElementById('density-toggle-btn');
  if (densityBtn && !densityBtn.querySelector('svg')) {
    densityBtn.insertAdjacentHTML('afterbegin', iconLayoutGrid(16));
  }
  const overflowSummary = document.querySelector('.sidebar-overflow__summary');
  if (overflowSummary && !overflowSummary.querySelector('svg')) {
    overflowSummary.insertAdjacentHTML('afterbegin', iconMoreHorizontal(16));
  }
  const cmdTriggerIcon = document.querySelector('#cmd-palette-trigger .cmd-trigger-icon');
  if (cmdTriggerIcon && !cmdTriggerIcon.querySelector('svg')) {
    cmdTriggerIcon.innerHTML = iconSearch(14);
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
  _cmdPalette = createCommandPalette();

  const isMac =
    typeof api.platform === 'string'
      ? api.platform === 'darwin'
      : typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac');

  _cmdPalette.registerCommands([
    { id: 'go-extract',  label: 'Go to Extract',        icon: iconGlobe(), shortcut: 'E',         keywords: ['extract', 'capture', 'dom'],       action: () => _appShell.activateSection('extract') },
    { id: 'go-compare',  label: 'Go to Compare',         icon: iconGitCompare(), shortcut: 'C',         keywords: ['compare', 'diff', 'regression'],   action: () => _appShell.activateSection('compare') },
    { id: 'go-reports',  label: 'Focus Report List',     icon: iconList(), shortcut: 'R',         keywords: ['reports', 'list', 'history'],       action: () => document.querySelector('#reports-list .vscroll-viewport')?.focus() },
    { id: 'search',      label: 'Search Reports',        icon: iconSearch(), shortcut: '/',         keywords: ['search', 'filter', 'find'],        action: () => document.getElementById('search-reports')?.focus() },
    { id: 'extract',     label: 'Start Extraction',      icon: iconPlay(), shortcut: '',          keywords: ['run', 'start', 'capture'],         action: () => { const btn = document.getElementById('extract-btn'); if (btn && !btn.disabled) btn.click(); } },
    { id: 'compare',     label: 'Run Comparison',        icon: iconGitCompare(), shortcut: '',          keywords: ['run', 'compare', 'diff'],          action: () => { const btn = document.getElementById('compare-btn'); if (btn && !btn.disabled) btn.click(); } },
    { id: 'export-html', label: 'Export as HTML',        icon: iconFileDown(), shortcut: '',          keywords: ['export', 'html', 'download'],      action: () => { const btn = document.getElementById('export-comparison-btn'); if (btn && !btn.disabled && document.getElementById('export-format-select')?.value === 'html') btn.click(); } },
    { id: 'delete-all',  label: 'Delete All Reports',    icon: iconTrash2(), shortcut: '',          keywords: ['delete', 'clear', 'remove all'],   action: () => { const btn = document.getElementById('delete-all-btn'); if (btn && !btn.disabled) btn.click(); } },
    { id: 'diagnostics', label: 'Open Diagnostics Panel',icon: iconActivity(), shortcut: isMac ? '⌘⇧D' : 'Ctrl+⇧+D', keywords: ['perf', 'metrics', 'debug'],        action: () => showDiagnosticsPanel() },
  ]);

  document.getElementById('cmd-palette-trigger')
    ?.addEventListener('click', () => _cmdPalette.toggle());

  document.getElementById('panel-toggle-btn')
    ?.addEventListener('click', () => _appShell.toggleLeftPanel());

  _appShell.activateSection('extract');

  const cmdShortcutSpan = document.getElementById('cmd-palette-shortcut');
  if (cmdShortcutSpan) {
    const keys = isMac ? ['⌘', 'K'] : ['Ctrl', 'K'];
    cmdShortcutSpan.innerHTML = keys.map(k => `<kbd>${k}</kbd>`).join('');
  }

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
    const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (e.key === 'Enter' && !e.repeat && getState().phase === 'error' && !inInput) {
      e.preventDefault();
      dispatch('DISMISS_ERROR');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      _cmdPalette.toggle();
      return;
    }
    if (inInput) { return; }
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

  const closeSidebarToolbarOverflow = () => {
    document.querySelector('.sidebar-toolbar-overflow')?.removeAttribute('open');
  };

  document.getElementById('import-report-overflow-btn')?.addEventListener('click', () => {
    closeSidebarToolbarOverflow();
    document.getElementById('import-report-input')?.click();
  });

  document.getElementById('delete-all-btn')?.addEventListener('click', async () => {
    closeSidebarToolbarOverflow();
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
      _appShell?.setBreadcrumb([{ label: 'Compare' }]);
    } else if (state.phase === 'error') {
      _resultPanel?.showError?.(state.error);
      _appShell?.setBreadcrumb([{ label: 'Compare' }]);
    } else if (state.comparison && state.phase === 'done') {
      _resultPanel?.render(state.comparison, state.cachedAt ?? null);
      _appShell?.setBreadcrumb([
        { label: 'Compare', action: () => _appShell.activateSection('compare') },
        { label: 'Results' },
      ]);
    } else if (state.phase === 'idle') {
      _resultPanel?.clear();
      _appShell?.syncBreadcrumbToActiveSection();
    }

    const titles = {
      idle: 'UI Comparison',
      extracting: 'Extracting elements…',
      comparing: 'Running comparison…',
      done:
        state.comparison && state.phase === 'done'
          ? (() => {
              const br = (state.reports ?? []).find(r => r.id === state.comparison.baselineId);
              const host = br?.url ? hostFromUrl(br.url) : '';
              return host ? `Results — ${host}` : 'UI Comparison';
            })()
          : 'UI Comparison',
      error: 'UI Comparison',
    };
    window.electronAPI?.setWindowTitle?.(titles[state.phase] ?? 'UI Comparison');
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