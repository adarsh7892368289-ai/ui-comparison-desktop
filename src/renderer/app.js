'use strict';

import logger from '../infrastructure/logger.js';
import errorTracker from '../infrastructure/error-tracker.js';

logger.init();
errorTracker.init();

import { getState, dispatch, subscribe } from './state.js';
import { Toast, syncCompareButton } from './ui.js';
import {
  initializeApp,
  loadAndRenderReports,
  renderReportList,
  handleDeleteAllReports,
  handleExtraction,
} from './application/report-manager.js';
import { handleExport, handleExportAllReports, handleFullReport } from './application/export-workflow.js';
import { handleImportReport } from './application/import-workflow.js';
import { handleComparison, tryLoadCachedComparison } from './application/compare-workflow.js';
import { createResultPanel } from './components/result-panel.js';
import { createAppShell }       from './components/app-shell.js';
import { createCommandPalette } from './components/command-palette.js';
import { SystemBanner }         from './components/system-banner.js';
import { createStatusBar }      from './components/status-bar.js';

const api = window.electronAPI;
if (!api) {
  throw new Error(
    'window.electronAPI is undefined. ' +
    'Verify preload.js path in BrowserWindow.webPreferences and contextIsolation: true.'
  );
}

let _resultPanel        = null;
let _appShell           = null;
let _cmdPalette         = null;
let _statusBar          = null;

document.addEventListener('DOMContentLoaded', async () => {
  await initializeApp();

  const compareResultsEl = document.getElementById('compare-results');
  if (compareResultsEl) {
    _resultPanel = createResultPanel(compareResultsEl);
    _resultPanel.clear();
  }

  if (localStorage.getItem('ui-compare-v5-upgrade-data-cleared')) {
    localStorage.removeItem('ui-compare-v5-upgrade-data-cleared');
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
  _statusBar = createStatusBar();

  _statusBar.updateReportCount(getState().reports);

  _cmdPalette.registerCommands([
    { id: 'go-extract',  label: 'Go to Extract',        icon: '⬡', shortcut: 'E',         keywords: ['extract', 'capture', 'dom'],       action: () => _appShell.activateSection('extract') },
    { id: 'go-compare',  label: 'Go to Compare',         icon: '⬡', shortcut: 'C',         keywords: ['compare', 'diff', 'regression'],   action: () => _appShell.activateSection('compare') },
    { id: 'go-reports',  label: 'Focus Report List',     icon: '⬡', shortcut: 'R',         keywords: ['reports', 'list', 'history'],       action: () => document.getElementById('search-reports')?.focus() },
    { id: 'search',      label: 'Search Reports',        icon: '⬡', shortcut: '/',         keywords: ['search', 'filter', 'find'],        action: () => document.getElementById('search-reports')?.focus() },
    { id: 'extract',     label: 'Start Extraction',      icon: '⬡', shortcut: '',          keywords: ['run', 'start', 'capture'],         action: () => document.getElementById('extract-btn')?.click() },
    { id: 'compare',     label: 'Run Comparison',        icon: '⬡', shortcut: '',          keywords: ['run', 'compare', 'diff'],          action: () => document.getElementById('compare-btn')?.click() },
    { id: 'export-html', label: 'Export as HTML',        icon: '⬡', shortcut: '',          keywords: ['export', 'html', 'download'],      action: () => { if (document.getElementById('export-format-select')?.value === 'html') { document.getElementById('export-comparison-btn')?.click(); } } },
    { id: 'delete-all',  label: 'Delete All Reports',    icon: '⬡', shortcut: '',          keywords: ['delete', 'clear', 'remove all'],   action: () => document.getElementById('delete-all-btn')?.click() },
    { id: 'diagnostics', label: 'Open Diagnostics Panel',icon: '⬡', shortcut: 'Ctrl+⇧+D', keywords: ['perf', 'metrics', 'debug'],        action: () => showDiagnosticsPanel() },
  ]);

  document.getElementById('cmd-palette-trigger')
    ?.addEventListener('click', () => _cmdPalette.toggle());

  document.getElementById('panel-toggle-btn')
    ?.addEventListener('click', () => _appShell.toggleLeftPanel());

  _appShell.activateSection('extract');

  document.addEventListener('keydown', e => {
    const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      _cmdPalette.toggle();
      return;
    }
    if (inInput) { return; }
    if (e.key === 'e' || e.key === 'E') { _appShell.activateSection('extract'); }
    if (e.key === 'c' || e.key === 'C') { _appShell.activateSection('compare'); }
    if (e.key === '/') {
      e.preventDefault();
      document.getElementById('search-reports')?.focus();
    }
    if (e.key === 'Escape') {
      const search = document.getElementById('search-reports');
      if (search?.value) {
        search.value = '';
        renderReportList(getState().reports ?? [], '');
      }
    }
  });

  document.getElementById('extract-btn')?.addEventListener('click', handleExtraction);

  document.getElementById('export-all-btn')?.addEventListener('click', handleExportAllReports);

  document.getElementById('delete-all-btn')?.addEventListener('click', handleDeleteAllReports);



  ['baseline', 'compare'].forEach(slot => {
    const input = document.getElementById(`${slot}-upload`);
    if (!input) { return; }
    input.addEventListener('change', e => {
      const file = e.target.files?.[0];
      input.value = '';
      handleImportReport(file, slot);
    });
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
    if (!e.ctrlKey || !e.shiftKey || e.key !== 'D') { return; }
    e.preventDefault();
    showDiagnosticsPanel();
  });

  subscribe((state) => {
    _statusBar?.updatePhase(state);
    _statusBar?.updateReportCount(state.reports);

    if (state.comparison && state.phase === 'done') {
      _resultPanel?.render(state.comparison, state.cachedAt ?? null);
      _appShell?.setBreadcrumb([{ label: 'UI Comparison' }, { label: 'Compare' }, { label: 'Results' }]);
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