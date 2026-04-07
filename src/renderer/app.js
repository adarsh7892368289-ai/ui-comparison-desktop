'use strict';

import { getState, dispatch, subscribe } from './state.js';
import {
  initializeApp,
  loadAndRenderReports,
  renderReportList,
  handleDeleteAllReports,
  handleExtraction,
  sanitize,
  relativeTime,
} from './application/report-manager.js';
import { handleExport, handleExportAllReports, handleFullReport } from './application/export-workflow.js';
import { handleImportReport } from './application/import-workflow.js';
import { handleComparison, tryLoadCachedComparison } from './application/compare-workflow.js';

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

function syncCompareButton() {
  const state = getState();
  const btn   = document.getElementById('compare-btn');
  if (btn) {
    btn.disabled = !state.selectedBaseline ||
                   !state.selectedCompare  ||
                   state.selectedBaseline === state.selectedCompare;
  }
}

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

  const addedRows   = added.slice(0, DETAIL_CAP).map(el => elRow(el, 'added')).join('');
  const removedRows = removed.slice(0, DETAIL_CAP).map(el => elRow(el, 'removed')).join('');
  const addedOver   = added.length   > DETAIL_CAP ? `<div class="el-overflow">+${added.length   - DETAIL_CAP} more — export for full list</div>` : '';
  const removedOver = removed.length > DETAIL_CAP ? `<div class="el-overflow">+${removed.length - DETAIL_CAP} more — export for full list</div>` : '';
  const propChanges = propertyDiffCount ?? totalDifferences ?? 0;

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
            <option value="html">HTML</option>
            <option value="xlsx">Excel</option>
            <option value="csv">CSV</option>
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

document.addEventListener('DOMContentLoaded', async () => {
  await initializeApp();

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
      Toast.warning(
        'Some previously queued writes could not be replayed — those records may be missing.'
      );
    } else {
      Toast.error(
        'Storage failure: too many consecutive write errors. No new data will be saved — restart the app to recover.'
      );
    }
  });

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
        renderReportList(getState().reports ?? [], '');
      }
    }
  });

  document.getElementById('extract-btn')?.addEventListener('click', handleExtraction);

  document.getElementById('export-all-btn')?.addEventListener('click', handleExportAllReports);

  document.getElementById('delete-all-btn')?.addEventListener('click', handleDeleteAllReports);

  let searchDebounce;
  document.getElementById('search-reports')?.addEventListener('input', e => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      renderReportList(getState().reports ?? [], e.target.value);
    }, 200);
  });

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
    const result = await api.getPerfMetrics();
    if (!result?.success) { Toast.error('Diagnostics unavailable'); return; }

    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: '9999',
    });

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      background: 'var(--bg-surface, #1e1e2e)', color: 'var(--text-primary, #cdd6f4)',
      borderRadius: '8px', padding: '24px', maxWidth: '900px', width: '90vw',
      maxHeight: '80vh', overflow: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
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
  });

  subscribe((state) => {
    if (state.comparison && state.phase === 'done') {
      displayComparisonResults(state.comparison, state.cachedAt ?? null);
    }
  });
});

export {
  Toast,
  Modal,
  showProgress,
  updateProgress,
  hideProgress,
  setError,
  syncCompareButton,
  displayComparisonResults,
};