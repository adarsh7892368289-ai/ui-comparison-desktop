'use strict';

import { getState, dispatch, subscribe } from '../state.js';
import {
  routeBulkStartClick,
  routeBulkCancelClick,
  routeBulkDownloadTemplateClick,
  routeBulkPairOpenClick,
  routeBulkExportClick,
  routeBulkResetClick,
  routeBulkDownloadAllResultsClick,
  routeBulkDownloadAllCancelClick,
  subscribeBulkDownloadAllProgress,
  isBulkDownloadAllRunning,
} from '../application/bulk-workflow.js';
import { get as getDefault } from '@config/defaults.js';
import { getErrorHint } from '@core/export/bulk-pair-state-labels.js';
import storage from '../../infrastructure/idb-repository.js';
import { Toast } from '../ui.js';
import { sanitizeErrorMessage } from '../utils/sanitize.js';

const TERMINAL_STATUSES = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted']);

const BULK_CONCURRENCY_RAM_THRESHOLD_MB = 12 * 1024;
const BULK_CONCURRENCY_HETEROGENEOUS_CAP = 1;
const BULK_CONCURRENCY_HETEROGENEOUS_HINT =
  'Mixed browsers detected — concurrency limited to 1 on this machine.';

const ROW_HEIGHT = 56;
const OVERSCAN   = 3;

const ACTIVE_STATES = new Set([
  'extracting-baseline',
  'extracting-compare',
  'matching',
  'screenshots',
  'persisting',
]);

const FAILURE_FIRST_RANK = {
  'failed':              0,
  'cancelled':           1,
  'extracting-baseline': 2,
  'extracting-compare':  2,
  'matching':            2,
  'screenshots':         2,
  'persisting':          2,
  'queued':              3,
  'done':                4,
};

let _hostTotalMemMB     = null;
let _hostMemoryFetched  = false;
let _hostMemoryPromise  = null;

function _ensureHostMemory(api) {
  if (_hostMemoryFetched) { return Promise.resolve(_hostTotalMemMB); }
  if (_hostMemoryPromise) { return _hostMemoryPromise; }
  if (typeof api?.getHostMemory !== 'function') {
    _hostMemoryFetched = true;
    return Promise.resolve(null);
  }
  _hostMemoryPromise = (async () => {
    try {
      const result = await api.getHostMemory();
      _hostTotalMemMB = typeof result?.totalMemMB === 'number' ? result.totalMemMB : null;
    } catch {
      _hostTotalMemMB = null;
    }
    _hostMemoryFetched = true;
    _hostMemoryPromise = null;
    return _hostTotalMemMB;
  })();
  return _hostMemoryPromise;
}

function _hostHasEnoughRamForHighConcurrency(totalMemMB) {
  return typeof totalMemMB === 'number' && totalMemMB >= BULK_CONCURRENCY_RAM_THRESHOLD_MB;
}

function _isHeterogeneousPlan(parsedRows, selectedBrowser) {
  if (!Array.isArray(parsedRows) || parsedRows.length === 0) { return false; }
  const jobType = selectedBrowser?.browserType ?? null;
  if (!jobType) { return false; }
  for (const r of parsedRows) {
    if (!r || r.valid === false) { continue; }
    const rType = r.resolvedBrowser?.browserType ?? jobType;
    if (rType !== jobType) { return true; }
  }
  return false;
}

function _stateLabel(status) {
  switch (status) {
    case 'queued':              return 'Queued';
    case 'extracting-baseline': return 'Extracting baseline…';
    case 'extracting-compare':  return 'Extracting compare…';
    case 'matching':            return 'Matching…';
    case 'screenshots':         return 'Screenshots…';
    case 'persisting':          return 'Saving…';
    case 'done':                return 'Done';
    case 'failed':              return 'Failed';
    case 'cancelled':           return 'Cancelled';
    default:                    return status;
  }
}

function _pairStateBucket(status) {
  if (status === 'done')      { return 'done'; }
  if (status === 'failed')    { return 'failed'; }
  if (status === 'cancelled') { return 'cancelled'; }
  if (ACTIVE_STATES.has(status)) { return 'active'; }
  return 'queued';
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
  ));
}

function createBulkPanel(containerEl /* api, storage */) {
  if (!containerEl) { return { destroy() {} }; }

  containerEl.classList.add('bulk-panel');
  containerEl.innerHTML = '';

  const _state = {
    filteredIndexes:      [],
    lastPairsLen:         0,
    lastStatusByPair:     new Map(),
    cancelPendingTotal:   null,
    cancelledSinceClick:  0,
    elapsedInterval:      null,
    searchQuery:          '',
    failuresOnly:         false,
    failureFirstSort:     false,
    showNumbers:          false,
    numbersByPair:        new Map(),
    numbersLoading:       new Set(),
    downloadAllUnsub:     null,
  };

  const _geom   = { containerHeight: 0, totalHeight: 0 };
  const _scroll = { top: 0 };
  const _raf    = { handle: 0 };
  const _mountedByPairIndex = new Map();
  const _recyclePool = [];
  const POOL_PARK_Y  = -9999;

  const _refs = {};
  let _keyboardUnbind = null;

  function _renderIdle(inlineError = null) {
    const inlineErrorHtml = inlineError && inlineError.message
      ? `<div class="error-msg bulk-idle__error" id="bulk-idle-error" role="alert">${_esc(inlineError.message)}${
          inlineError.withTemplateBtn
            ? ' <button type="button" class="btn-ghost btn-sm bulk-idle__error-template-btn" id="bulk-idle-error-template-btn">Download template</button>'
            : ''
        }</div>`
      : '';

    containerEl.innerHTML = `
      <div class="bulk-idle">
        <div class="card">
          ${inlineErrorHtml}
          <p class="field-hint bulk-idle__lede">Run many URL-pair comparisons from an Excel plan.</p>
          <div class="bulk-idle__actions">
            <button type="button" class="btn-primary" id="bulk-pick-btn">Upload Excel file</button>
            <button type="button" class="btn-ghost btn-sm" id="bulk-template-btn">Download template</button>
            <input type="file" id="bulk-file-input" accept=".xlsx" hidden>
          </div>
          <hr class="card-sep">
          <div class="card-header">
            <h2 class="card-title">Required columns</h2>
          </div>
          <div class="bulk-idle__example">
            <table class="bulk-example-table">
              <thead>
                <tr><th>baseline_url</th><th>compare_url</th><th>mode</th></tr>
              </thead>
              <tbody>
                <tr><td>https://staging/login</td><td>https://prod/login</td><td>dynamic</td></tr>
                <tr><td>https://staging/checkout</td><td>https://prod/checkout</td><td>static</td></tr>
              </tbody>
            </table>
            <p class="bulk-idle__hint">Maximum 500 rows.</p>
          </div>
          <hr class="card-sep">
          <label class="toggle-row" for="bulk-screenshots">
            <div class="toggle-row__text">
              <span class="toggle-row__label">Take screenshots</span>
              <span class="toggle-row__hint">During bulk extraction</span>
            </div>
            <div class="visual-toggle__track">
              <input type="checkbox" id="bulk-screenshots" checked>
              <span class="visual-toggle__thumb" aria-hidden="true"></span>
            </div>
          </label>
          <details class="bulk-idle__advanced">
            <summary>Advanced</summary>
            <div class="form-field bulk-idle__advanced-field">
              <label class="label" for="bulk-host-cooldown">Host cooldown (ms)</label>
              <input class="input" type="number" id="bulk-host-cooldown" min="0" step="100" value="500">
            </div>
          </details>
        </div>
      </div>
    `;

    containerEl.querySelector('#bulk-template-btn')
      ?.addEventListener('click', () => void routeBulkDownloadTemplateClick());
    containerEl.querySelector('#bulk-idle-error-template-btn')
      ?.addEventListener('click', () => void routeBulkDownloadTemplateClick());

    const fileInput = containerEl.querySelector('#bulk-file-input');
    containerEl.querySelector('#bulk-pick-btn')
      ?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', _onFilePicked);
  }

  function _showInlineIdleError(message, withTemplateBtn = false) {
    _renderIdle({ message, withTemplateBtn });
  }

  async function _onFilePicked(ev) {
    const file = ev.target.files?.[0];
    if (ev.target) { ev.target.value = ''; }
    if (!file) { return; }

    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext !== 'xlsx') {
      Toast.warning('Only .xlsx files are supported for bulk plans — pick an .xlsx file or download the template.');
      return;
    }

    dispatch('BULK_DETECTION_STATE', { detectionState: 'loading' });

    let buf;
    try {
      buf = await file.arrayBuffer();
    } catch (err) {
      dispatch('BULK_DETECTION_STATE', { detectionState: 'idle' });
      Toast.error(sanitizeErrorMessage(err?.message ?? err ?? 'Failed to read file'));
      return;
    }

    let result;
    try {
      result = await _parseWorkbook(new Uint8Array(buf));
    } catch (err) {
      dispatch('BULK_DETECTION_STATE', { detectionState: 'idle' });
      console.error('[bulk] parse failed', err);
      Toast.error(`Could not read the Excel file: ${sanitizeErrorMessage(err?.message ?? String(err))}`);
      return;
    }

    if (!result.ok) {
      dispatch('BULK_DETECTION_STATE', { detectionState: 'idle' });
      if (result.kind === 'inline') {
        _showInlineIdleError(result.message, Boolean(result.withTemplateBtn));
      } else {
        Toast.error(result.message);
      }
      return;
    }

    const rows = result.rows;
    const valid   = rows.filter((r) => r && r.valid !== false);
    const invalid = rows.filter((r) => r && r.valid === false);
    if (valid.length === 0) {
      dispatch('BULK_DETECTION_STATE', { detectionState: 'idle' });
      const firstReason = invalid[0]?.validationReason ?? 'no valid rows';
      _showInlineIdleError(`Every row failed validation. The first error is: ${firstReason}.`, true);
      return;
    }

    dispatch('BULK_PARSED_ROWS_SET', { rows, detectionState: 'ready' });
  }

  async function _parseWorkbook(uint8) {
    let XLSX = null;
    try {
      const mod = await import('xlsx');
      XLSX = mod?.default ?? mod;
    } catch (err) {
      throw new Error(`Excel parser unavailable: ${err?.message ?? err}`);
    }

    const wb = XLSX.read(uint8, { type: 'array' });
    const firstSheetName = wb.SheetNames?.[0];
    if (!firstSheetName) {
      return { ok: false, kind: 'inline', message: 'No sheets found in workbook.' };
    }
    const worksheet = wb.Sheets[firstSheetName];

    let parsePlanWorksheet = null;
    try {
      const m = await import('@core/bulk/plan-parser.js');
      parsePlanWorksheet = m?.parsePlanWorksheet ?? null;
    } catch { void 0; }

    let rows = [];
    if (typeof parsePlanWorksheet === 'function') {
      const parsed = parsePlanWorksheet(worksheet);
      if (parsed?.error) {
        const msg = parsed.error;
        const isZeroRows = /no url pairs found/i.test(msg);
        const isMaxRows  = /maximum supported/i.test(msg);
        const isDupHdr   = /duplicate column header/i.test(msg);
        const isMissing  = /missing required column/i.test(msg);
        if (isZeroRows || isMaxRows || isDupHdr || isMissing) {
          const hinted = isZeroRows
            ? `${msg}. Try downloading the template above for the expected format.`
            : isMaxRows
              ? `${msg}. Split your audit into multiple files and run them sequentially.`
              : isDupHdr
                ? `${msg}. Each header may appear only once.`
                : msg;
          return { ok: false, kind: 'inline', message: hinted };
        }
        return { ok: false, kind: 'toast', message: msg };
      }
      rows = parsed?.rows ?? [];
    } else {
      const raw = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
      rows = raw.map((r) => {
        const lower = {};
        for (const k of Object.keys(r)) { lower[String(k).toLowerCase().trim()] = r[k]; }
        return lower;
      });
    }

    let validatePlanRows = null;
    try {
      const v = await import('@core/bulk/plan-validator.js');
      validatePlanRows = v?.validatePlanRows ?? null;
    } catch { void 0; }

    if (typeof validatePlanRows === 'function') {
      const snapshot = getState();
      const jobOptions = { selectedBrowser: snapshot.selectedBrowser ?? null };
      const availableBrowsers = snapshot.availableBrowsers ?? [];
      const result = validatePlanRows(rows, jobOptions, availableBrowsers);
      const valid   = (result?.valid   ?? []).map((r) => ({ ...r, valid: true }));
      const invalid = (result?.invalid ?? []).map((r) => ({ ...r, valid: false }));
      return { ok: true, rows: [...valid, ...invalid] };
    }

    const fallback = rows.map((r) => {
      const baseline = String(r.baseline_url ?? '').trim();
      const compare  = String(r.compare_url  ?? '').trim();
      const ok = /^https?:\/\//i.test(baseline) && /^https?:\/\//i.test(compare);
      return {
        baseline_url:     baseline,
        compare_url:      compare,
        mode:             String(r.mode ?? 'dynamic').toLowerCase(),
        screenshots:      r.screenshots,
        label:            r.label ? String(r.label) : null,
        valid:            ok,
        validationReason: ok ? null : 'baseline_url and compare_url must start with http:// or https://',
      };
    });
    return { ok: true, rows: fallback };
  }

  function _renderPreview(rows) {
    const valid = rows.filter((r) => r.valid !== false);
    const invalid = rows.filter((r) => r.valid === false);
    const sample = [...valid.slice(0, 3), ...invalid];

    const showFilterClass = rows.some((r) => r && r.filter_class != null && String(r.filter_class).trim() !== '');
    const showFilterId    = rows.some((r) => r && r.filter_id    != null && String(r.filter_id).trim()    !== '');
    const showFilterTag   = rows.some((r) => r && r.filter_tag   != null && String(r.filter_tag).trim()   !== '');

    const filterHeaderHtml =
      `${showFilterClass ? '<th>filter_class</th>' : ''}` +
      `${showFilterId    ? '<th>filter_id</th>'    : ''}` +
      `${showFilterTag   ? '<th>filter_tag</th>'   : ''}`;

    const _filterCellsFor = (r) =>
      `${showFilterClass ? `<td>${_esc(r.filter_class ?? '')}</td>` : ''}` +
      `${showFilterId    ? `<td>${_esc(r.filter_id    ?? '')}</td>` : ''}` +
      `${showFilterTag   ? `<td>${_esc(r.filter_tag   ?? '')}</td>` : ''}`;

    containerEl.innerHTML = `
      <div class="bulk-preview">
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">Plan preview</h2>
            <span class="badge-optional">${rows.length} pairs — ${valid.length} valid, ${invalid.length} invalid</span>
          </div>
          <table class="bulk-preview__table">
            <thead>
              <tr><th>#</th><th>baseline_url</th><th>compare_url</th><th>mode</th><th>label</th>${filterHeaderHtml}</tr>
            </thead>
            <tbody>
              ${sample.map((r, i) => `
                <tr class="${r.valid === false ? 'bulk-preview__row--invalid' : ''}"
                    ${r.valid === false ? `title="${_esc(r.validationReason ?? 'invalid row')}"` : ''}>
                  <td>${i + 1}</td>
                  <td>${_esc(r.baseline_url ?? r.baselineUrl)}</td>
                  <td>${_esc(r.compare_url  ?? r.compareUrl)}</td>
                  <td>${_esc(r.mode ?? '')}</td>
                  <td>${_esc(r.label ?? '')}</td>
                  ${_filterCellsFor(r)}
                </tr>
              `).join('')}
            </tbody>
          </table>
          <div class="bulk-preview__warning"></div>
          <hr class="card-sep">
          <div class="bulk-preview__job-options">
            <div class="form-field">
              <label class="label" for="bulk-concurrency">Concurrency</label>
              <select class="select" id="bulk-concurrency">
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
              </select>
            </div>
            <div class="bulk-concurrency-hint" id="bulk-concurrency-hint" hidden></div>
            <label class="toggle-row" for="bulk-force-refresh">
              <div class="toggle-row__text">
                <span class="toggle-row__label">Force fresh extraction</span>
                <span class="toggle-row__hint">Skip same-day cached extraction and re-run every URL.</span>
              </div>
              <div class="visual-toggle__track">
                <input type="checkbox" id="bulk-force-refresh">
                <span class="visual-toggle__thumb" aria-hidden="true"></span>
              </div>
            </label>
          </div>
          <div class="bulk-preview__actions">
            <button type="button" class="btn-ghost" id="bulk-preview-back-btn">← Back</button>
            <button type="button" class="btn-primary" id="bulk-start-btn" ${valid.length === 0 ? 'disabled' : ''}>
              Start
            </button>
          </div>
        </div>
      </div>
    `;

    containerEl.querySelector('#bulk-preview-back-btn')?.addEventListener('click', () => {
      dispatch('BULK_PARSED_ROWS_SET', { rows: [], detectionState: 'idle' });
    });
    containerEl.querySelector('#bulk-start-btn')?.addEventListener('click', () => void routeBulkStartClick());

    void _initConcurrencyDropdown(rows);
  }

  async function _initConcurrencyDropdown(parsedRows) {
    const select = containerEl.querySelector('#bulk-concurrency');
    const hint   = containerEl.querySelector('#bulk-concurrency-hint');
    if (!select) { return; }

    const totalMemMB     = await _ensureHostMemory(window.electronAPI);
    const hasEnoughRAM   = _hostHasEnoughRamForHighConcurrency(totalMemMB);
    const heterogeneous  = _isHeterogeneousPlan(parsedRows ?? [], getState().selectedBrowser);

    let defaultConcurrency;
    try { defaultConcurrency = getDefault('bulk.defaultConcurrency'); }
    catch { defaultConcurrency = 2; }

    const hostMax = hasEnoughRAM ? 4 : 2;
    let initialValue = Math.max(1, Math.min(defaultConcurrency, hostMax));

    if (heterogeneous && !hasEnoughRAM) {
      initialValue = BULK_CONCURRENCY_HETEROGENEOUS_CAP;
    }

    for (const opt of Array.from(select.options)) {
      const val = parseInt(opt.value, 10);
      opt.disabled = val > hostMax;
    }

    select.value = String(initialValue);
    if (heterogeneous && !hasEnoughRAM) {
      select.disabled = true;
      if (hint) {
        hint.hidden = false;
        hint.textContent = BULK_CONCURRENCY_HETEROGENEOUS_HINT;
      }
    } else {
      select.disabled = false;
      if (hint) {
        hint.hidden = true;
        hint.textContent = '';
      }
    }
  }

  function _renderRunningShell() {
    const autoFollowChecked = _readAutoFollow();
    containerEl.innerHTML = `
      <div class="bulk-running">
        <header class="bulk-running__header" id="bulk-job-header">
          <div class="bulk-running__title-block">
            <div class="bulk-running__title-row">
              <h2 class="bulk-running__title" id="bulk-job-filename">Bulk run</h2>
              <span class="bulk-running__elapsed" id="bulk-job-elapsed" aria-live="off">00:00</span>
            </div>
            <p class="bulk-running__summary" id="bulk-job-summary-line"></p>
          </div>
          <div class="bulk-running__controls">
            <label class="bulk-auto-follow-label">
              <input type="checkbox" id="bulk-auto-follow" ${autoFollowChecked ? 'checked' : ''}>
              <span>Auto-follow</span>
            </label>
            <button type="button" class="btn-ghost btn-sm bulk-back-btn" id="bulk-back-btn" hidden>← Back</button>
            <button type="button" class="btn-ghost btn-sm bulk-export-btn" id="bulk-summary-export-btn" hidden>Export summary (.xlsx)</button>
            <span class="bulk-download-all" id="bulk-download-all-controls" hidden>
              <span class="bulk-download-all__split" role="group" aria-label="Download all results">
                <button type="button" class="btn-ghost btn-sm bulk-download-all__action" id="bulk-download-all-btn">
                  Download all results
                </button>
                <span class="bulk-download-all__divider" aria-hidden="true"></span>
                <label class="bulk-download-all__format-wrap" title="Format for per-pair export">
                  <select class="bulk-download-all__format" id="bulk-download-all-format"
                          aria-label="Per-pair export format">
                    <option value="html">HTML</option>
                    <option value="json">JSON</option>
                    <option value="csv">CSV</option>
                  </select>
                  <span class="bulk-download-all__chevron" aria-hidden="true">▾</span>
                </label>
              </span>
              <button type="button" class="btn-ghost btn-sm bulk-download-all__cancel" id="bulk-download-all-cancel-btn" hidden>Cancel export</button>
              <span class="bulk-download-all__progress" id="bulk-download-all-progress" hidden aria-live="polite"></span>
            </span>
            <button type="button" class="btn-primary btn-primary--operation-cancel" id="bulk-cancel-job-btn"
                    title="Stops after current page (up to ~60s)">Cancel</button>
            <span class="bulk-cancel-note" id="bulk-cancel-note" hidden></span>
          </div>
        </header>
        <div class="progress-track bulk-running__progress" id="bulk-job-progress">
          <div class="progress-fill" id="bulk-job-progress-bar"></div>
        </div>
        <div class="bulk-pair-toolbar">
          <input type="search" id="bulk-pair-filter" class="bulk-pair-toolbar__search"
                 placeholder="Filter pairs (URL or label)…" autocomplete="off">
          <button type="button" id="bulk-show-only-failures-btn"
                  class="btn-ghost btn-sm bulk-pair-toolbar__btn">Show only failures</button>
          <button type="button" id="bulk-show-numbers-btn"
                  class="btn-ghost btn-sm bulk-pair-toolbar__btn">+ counts</button>
        </div>
        <div class="bulk-pair-columns" id="bulk-pair-columns">
          <span class="bulk-pair-col bulk-pair-col--idx">#</span>
          <span class="bulk-pair-col bulk-pair-col--urls">Pair</span>
          <button type="button" id="bulk-pair-col-state-btn"
                  class="bulk-pair-col bulk-pair-col--state bulk-pair-col--sortable"
                  title="Click to sort: failures first">State</button>
        </div>
        <div id="bulk-storage-degraded-slot"></div>
        <div class="bulk-vscroll-viewport vscroll-viewport" id="bulk-pair-list" role="list" tabindex="0">
          <div class="bulk-vscroll-spacer">
            <div class="bulk-vscroll-window"></div>
          </div>
        </div>
      </div>
    `;

    _refs.viewport     = containerEl.querySelector('#bulk-pair-list');
    _refs.spacer       = containerEl.querySelector('.bulk-vscroll-spacer');
    _refs.window       = containerEl.querySelector('.bulk-vscroll-window');
    _refs.summary      = containerEl.querySelector('#bulk-job-summary-line');
    _refs.title        = containerEl.querySelector('#bulk-job-filename');
    _refs.elapsed      = containerEl.querySelector('#bulk-job-elapsed');
    _refs.progressBar  = containerEl.querySelector('#bulk-job-progress-bar');
    _refs.cancelBtn    = containerEl.querySelector('#bulk-cancel-job-btn');
    _refs.cancelNote   = containerEl.querySelector('#bulk-cancel-note');
    _refs.exportBtn    = containerEl.querySelector('#bulk-summary-export-btn');
    _refs.downloadAllControls = containerEl.querySelector('#bulk-download-all-controls');
    _refs.downloadAllFormat   = containerEl.querySelector('#bulk-download-all-format');
    _refs.downloadAllBtn      = containerEl.querySelector('#bulk-download-all-btn');
    _refs.downloadAllCancel   = containerEl.querySelector('#bulk-download-all-cancel-btn');
    _refs.downloadAllProgress = containerEl.querySelector('#bulk-download-all-progress');
    _refs.backBtn      = containerEl.querySelector('#bulk-back-btn');
    _refs.storageDegradedSlot = containerEl.querySelector('#bulk-storage-degraded-slot');
    _refs.autoFollow   = containerEl.querySelector('#bulk-auto-follow');

    _refs.cancelBtn?.addEventListener('click', _onCancelClick);
    _refs.exportBtn?.addEventListener('click', () => void routeBulkExportClick());
    _refs.downloadAllBtn?.addEventListener('click', () => {
      const format = _refs.downloadAllFormat?.value ?? 'html';
      try { localStorage.setItem('bulk-download-all-format', format); } catch { void 0; }
      void routeBulkDownloadAllResultsClick(format);
    });
    _refs.downloadAllCancel?.addEventListener('click', () => routeBulkDownloadAllCancelClick());
    try {
      const stored = localStorage.getItem('bulk-download-all-format');
      if (stored && _refs.downloadAllFormat && ['html','json','csv'].includes(stored)) {
        _refs.downloadAllFormat.value = stored;
      }
    } catch { void 0; }
    if (_state.downloadAllUnsub) { try { _state.downloadAllUnsub(); } catch { void 0; } }
    _state.downloadAllUnsub = subscribeBulkDownloadAllProgress(_renderDownloadAllProgress);
    _renderDownloadAllProgress({
      running:   isBulkDownloadAllRunning(),
      current:   0,
      total:     0,
      succeeded: 0,
      failed:    0,
      format:    null,
    });
    _refs.backBtn?.addEventListener('click', () => {
      const hadViewer = getState().bulkJob?.activePairIndex != null;
      if (hadViewer) {
        _closeResultPanel();
        return;
      }
      void routeBulkResetClick();
    });
    _refs.viewport?.addEventListener('scroll', _onScroll, { passive: true });
    _refs.window?.addEventListener('click', _onWindowClick);
    _refs.autoFollow?.addEventListener('change', () => {
      _writeAutoFollow(Boolean(_refs.autoFollow?.checked));
    });

    _refs.filterInput      = containerEl.querySelector('#bulk-pair-filter');
    _refs.failuresOnlyBtn  = containerEl.querySelector('#bulk-show-only-failures-btn');
    _refs.showNumbersBtn   = containerEl.querySelector('#bulk-show-numbers-btn');
    _refs.colStateBtn      = containerEl.querySelector('#bulk-pair-col-state-btn');

    _refs.filterInput?.addEventListener('input', () => {
      _state.searchQuery = String(_refs.filterInput.value ?? '');
      _fullRelayoutAndRepaint();
    });
    _refs.failuresOnlyBtn?.addEventListener('click', () => {
      _state.failuresOnly = !_state.failuresOnly;
      _refs.failuresOnlyBtn.classList.toggle('btn-ghost--active', _state.failuresOnly);
      _fullRelayoutAndRepaint();
    });
    _refs.showNumbersBtn?.addEventListener('click', () => {
      _state.showNumbers = !_state.showNumbers;
      _refs.showNumbersBtn.classList.toggle('btn-ghost--active', _state.showNumbers);
      if (_state.showNumbers) { void _lazyLoadNumbersForVisiblePairs(); }
      _patchInPlaceAll();
    });
    _refs.colStateBtn?.addEventListener('click', () => {
      _state.failureFirstSort = !_state.failureFirstSort;
      _refs.colStateBtn.classList.toggle('bulk-pair-col--sorted', _state.failureFirstSort);
      _fullRelayoutAndRepaint();
    });

    if (typeof ResizeObserver !== 'undefined' && _refs.viewport) {
      _refs.resizeObs = new ResizeObserver(_onResize);
      _refs.resizeObs.observe(_refs.viewport);
    }

    _geom.containerHeight = _refs.viewport?.clientHeight ?? 0;
    _scroll.top           = _refs.viewport?.scrollTop ?? 0;
    _ensurePoolCapacity();
  }

  function _scheduleRepaint() {
    if (_raf.handle !== 0) { cancelAnimationFrame(_raf.handle); }
    _raf.handle = requestAnimationFrame(() => {
      _raf.handle = 0;
      _repaint();
    });
  }

  function _onScroll() {
    if (!_refs.viewport) { return; }
    _scroll.top = _refs.viewport.scrollTop;
    _scheduleRepaint();
  }

  function _onResize() {
    if (!_refs.viewport) { return; }
    _geom.containerHeight = _refs.viewport.clientHeight;
    _ensurePoolCapacity();
    _scheduleRepaint();
  }

  function _updateTotalHeight() {
    _geom.totalHeight = _state.filteredIndexes.length * ROW_HEIGHT;
    if (_refs.spacer) {
      _refs.spacer.style.height = `${_geom.totalHeight}px`;
    }
  }

  function _visibleRange() {
    const viewH = _geom.containerHeight || (_refs.viewport?.clientHeight ?? 400);
    const total = _state.filteredIndexes.length;
    if (total === 0) { return { start: 0, end: 0 }; }
    const firstIdx = Math.floor(_scroll.top / ROW_HEIGHT);
    const lastIdx  = Math.floor((_scroll.top + viewH) / ROW_HEIGHT);
    const start = Math.max(0, firstIdx - OVERSCAN);
    const end   = Math.min(total, lastIdx + OVERSCAN + 1);
    return { start, end };
  }

  function _repaint() {
    if (!_refs.window) { return; }
    _ensurePoolCapacity();
    const pairs = getState().bulkJob?.pairs ?? [];
    const filtered = _state.filteredIndexes;
    const { start, end } = _visibleRange();

    const keep = new Set();
    for (let i = start; i < end; i++) { keep.add(filtered[i]); }
    for (const [pairIndex, node] of _mountedByPairIndex) {
      if (!keep.has(pairIndex)) {
        _mountedByPairIndex.delete(pairIndex);
        _releaseNode(node);
      }
    }

    for (let i = start; i < end; i++) {
      const originalIndex = filtered[i];
      const pair = pairs[originalIndex];
      if (!pair) { continue; }
      let node = _mountedByPairIndex.get(originalIndex);
      if (!node) {
        node = _acquireNode();
        node.dataset.pairIndex = String(originalIndex);
        node.style.visibility  = 'visible';
        _mountedByPairIndex.set(originalIndex, node);
      }
      const yPx = i * ROW_HEIGHT;
      if (node.dataset.translateY !== String(yPx)) {
        node.dataset.translateY = String(yPx);
        node.style.transform    = `translateY(${yPx}px)`;
      }
      _syncRow(node, pair);
    }
  }

  function _createRow() {
    const node = document.createElement('div');
    node.className = 'bulk-row';
    node.setAttribute('role', 'listitem');
    node.style.transform  = `translateY(${POOL_PARK_Y}px)`;
    node.style.visibility = 'hidden';
    node.dataset.translateY = String(POOL_PARK_Y);
    node.innerHTML = `
      <div class="bulk-row__inner" data-field="inner">
        <div class="bulk-row__main">
          <span class="bulk-status-dot" aria-hidden="true"></span>
          <span class="bulk-row__index" data-field="index"></span>
          <span class="bulk-row__urls"  data-field="urls"></span>
          <span class="bulk-row__dedup" data-field="dedup" title="Reused recent extraction" aria-label="Reused recent extraction" hidden>⤴</span>
          <span class="bulk-row__numbers" data-field="numbers" aria-hidden="true" hidden></span>
          <span class="bulk-row__pct"   data-field="pct" hidden></span>
          <span class="bulk-row__state" data-field="state"></span>
          <button type="button" class="btn-ghost btn-sm bulk-row__open-btn"
                  data-field="openBtn" hidden>Open</button>
        </div>
        <div class="bulk-row__progress" data-field="progress" aria-hidden="true" hidden>
          <div class="bulk-row__progress-fill" data-field="progressFill"></div>
        </div>
      </div>
    `;
    node._fields = {
      inner:        node.querySelector('[data-field="inner"]'),
      index:        node.querySelector('[data-field="index"]'),
      urls:         node.querySelector('[data-field="urls"]'),
      dedup:        node.querySelector('[data-field="dedup"]'),
      numbers:      node.querySelector('[data-field="numbers"]'),
      state:        node.querySelector('[data-field="state"]'),
      pct:          node.querySelector('[data-field="pct"]'),
      openBtn:      node.querySelector('[data-field="openBtn"]'),
      progress:     node.querySelector('[data-field="progress"]'),
      progressFill: node.querySelector('[data-field="progressFill"]'),
    };
    node._fields.inner.addEventListener('animationend', (ev) => {
      if (ev.target === node._fields.inner && node.dataset.animOnce) {
        node.dataset.animOnce = '';
      }
    });
    return node;
  }

  function _desiredPoolSize() {
    const viewH = _geom.containerHeight || (_refs.viewport?.clientHeight ?? 400);
    return Math.ceil(viewH / ROW_HEIGHT) + OVERSCAN * 2 + 4;
  }

  function _ensurePoolCapacity() {
    if (!_refs.window) { return; }
    const target    = _desiredPoolSize();
    const liveTotal = _recyclePool.length + _mountedByPairIndex.size;
    if (liveTotal >= target) { return; }
    const frag = document.createDocumentFragment();
    for (let i = liveTotal; i < target; i++) {
      const node = _createRow();
      _recyclePool.push(node);
      frag.appendChild(node);
    }
    _refs.window.appendChild(frag);
  }

  function _acquireNode() {
    if (_recyclePool.length > 0) { return _recyclePool.pop(); }
    const node = _createRow();
    if (_refs.window) { _refs.window.appendChild(node); }
    return node;
  }

  function _releaseNode(node) {
    const f = node._fields;
    if (f) {
      if (node.dataset.pairState  !== 'queued') { node.dataset.pairState  = 'queued'; }
      if (node.dataset.pairStatus !== 'queued') { node.dataset.pairStatus = 'queued'; }
      node.dataset.animOnce = '';
      if (f.index.textContent   !== '') { f.index.textContent   = ''; }
      if (f.urls.textContent    !== '') { f.urls.textContent    = ''; f.urls.title = ''; }
      if (f.state.textContent   !== '') { f.state.textContent   = ''; f.state.title = ''; }
      if (f.pct.textContent     !== '') { f.pct.textContent     = ''; }
      if (!f.dedup.hidden)    { f.dedup.hidden    = true; }
      if (!f.numbers.hidden)  { f.numbers.hidden  = true; f.numbers.dataset.html = ''; f.numbers.textContent = ''; }
      if (!f.pct.hidden)      { f.pct.hidden      = true; }
      if (!f.progress.hidden) { f.progress.hidden = true; }
      if (!f.openBtn.hidden)  { f.openBtn.hidden  = true; }
      if (f.progressFill.style.width !== '0%') { f.progressFill.style.width = '0%'; }
    }
    node.style.visibility = 'hidden';
    if (node.dataset.translateY !== String(POOL_PARK_Y)) {
      node.dataset.translateY = String(POOL_PARK_Y);
      node.style.transform    = `translateY(${POOL_PARK_Y}px)`;
    }
    _recyclePool.push(node);
  }

  function _syncRow(node, pair) {
    const bucket   = _pairStateBucket(pair.status);
    const prevBkt  = node.dataset.pairState;
    if (prevBkt !== bucket) {
      node.dataset.pairState = bucket;
      if (prevBkt && prevBkt !== 'queued' && (bucket === 'done' || bucket === 'failed')) {
        node.dataset.animOnce = bucket;
      } else if (bucket !== 'done' && bucket !== 'failed') {
        node.dataset.animOnce = '';
      }
    }
    if (node.dataset.pairStatus !== pair.status) {
      node.dataset.pairStatus = pair.status;
    }
    const f = node._fields;
    if (!f) { return; }

    const indexText = `#${pair.pairIndex + 1}`;
    if (f.index.textContent !== indexText) { f.index.textContent = indexText; }

    const labelText = pair.label ? ` · ${pair.label}` : '';
    const urlsText  = `${pair.baselineUrl} → ${pair.compareUrl}${labelText}`;
    if (f.urls.textContent !== urlsText) {
      f.urls.textContent = urlsText;
      f.urls.title       = urlsText;
    }

    const stateText = pair.status === 'failed'
      ? `${_stateLabel(pair.status)} — ${getErrorHint(pair.errorCode)}`
      : _stateLabel(pair.status);
    if (f.state.textContent !== stateText) {
      f.state.textContent = stateText;
      f.state.title       = pair.status === 'failed' ? (pair.error ?? '') : '';
    }

    const showDedup = Boolean(pair.deduped && pair.deduped !== 'none');
    if (f.dedup.hidden !== !showDedup) { f.dedup.hidden = !showDedup; }

    const active = ACTIVE_STATES.has(pair.status);
    if (f.progress.hidden !== !active) { f.progress.hidden = !active; }
    if (f.pct.hidden      !== !active) { f.pct.hidden      = !active; }
    if (active) {
      const pctText  = `${Math.round(pair.pct ?? 0)}%`;
      const widthStr = `${Math.max(2, Math.min(100, pair.pct ?? 0))}%`;
      if (f.pct.textContent !== pctText) { f.pct.textContent = pctText; }
      if (f.progressFill.style.width !== widthStr) {
        f.progressFill.style.width = widthStr;
      }
    }

    const showOpen = pair.status === 'done';
    if (f.openBtn.hidden !== !showOpen) {
      f.openBtn.hidden = !showOpen;
    }
    if (showOpen && f.openBtn.dataset.pairIndex !== String(pair.pairIndex)) {
      f.openBtn.dataset.pairIndex = String(pair.pairIndex);
    }

    const showNumbers = _state.showNumbers && pair.status === 'done';
    if (showNumbers) {
      const cached = _state.numbersByPair.get(pair.pairIndex);
      const delta = cached && Number.isFinite(cached.elementDelta) ? cached.elementDelta : null;
      const crit  = cached && Number.isFinite(cached.critical)     ? cached.critical     : null;
      const high  = cached && Number.isFinite(cached.high)         ? cached.high         : null;
      const fmtDelta = delta == null ? '—' : (delta > 0 ? `+${delta}` : String(delta));
      const nextHtml =
        `<span class="bulk-row__num bulk-row__num--delta" title="Element delta (compare − baseline)">Δ ${fmtDelta}</span>` +
        `<span class="bulk-row__num bulk-row__num--crit"  title="Critical diffs">C ${crit ?? '—'}</span>` +
        `<span class="bulk-row__num bulk-row__num--high"  title="High diffs">H ${high ?? '—'}</span>`;
      if (f.numbers.dataset.html !== nextHtml) {
        f.numbers.dataset.html = nextHtml;
        f.numbers.innerHTML    = nextHtml;
      }
      if (f.numbers.hidden) { f.numbers.hidden = false; }
    } else if (!f.numbers.hidden) {
      f.numbers.hidden = true;
    }
  }

  function _onCancelClick() {
    if (!_refs.cancelBtn || _refs.cancelBtn.disabled) { return; }
    _refs.cancelBtn.disabled    = true;
    _refs.cancelBtn.textContent = 'Cancelling…';
    const job = getState().bulkJob;
    if (job?.pairs && _refs.cancelNote) {
      const pendingAtClick = job.pairs.filter((p) =>
        p.status !== 'done' && p.status !== 'failed' && p.status !== 'cancelled'
      ).length;
      _state.cancelPendingTotal = pendingAtClick;
      _state.cancelledSinceClick = 0;
      _refs.cancelNote.hidden      = false;
      _refs.cancelNote.textContent =
        `Stopping after current page (up to ~60s) · cancelled 0/${pendingAtClick} pending`;
    }
    void routeBulkCancelClick();
  }

  function _readAutoFollow() {
    try {
      const stored = localStorage.getItem('bulk-auto-follow');
      if (stored === null) { return true; }
      return stored !== 'false';
    } catch {
      return true;
    }
  }
  function _writeAutoFollow(checked) {
    try { localStorage.setItem('bulk-auto-follow', checked ? 'true' : 'false'); }
    catch { void 0; }
  }

  function _computeFilteredIndexes(pairs) {
    const q = (_state.searchQuery ?? '').trim().toLowerCase();
    const failuresOnly = Boolean(_state.failuresOnly);
    const indexes = [];
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[i];
      if (failuresOnly && p.status !== 'failed' && p.status !== 'cancelled') { continue; }
      if (q) {
        const hay = `${p.baselineUrl ?? ''}|${p.compareUrl ?? ''}|${p.label ?? ''}`.toLowerCase();
        if (!hay.includes(q)) { continue; }
      }
      indexes.push(i);
    }
    if (_state.failureFirstSort) {
      indexes.sort((a, b) => {
        const ra = FAILURE_FIRST_RANK[pairs[a].status] ?? 99;
        const rb = FAILURE_FIRST_RANK[pairs[b].status] ?? 99;
        if (ra !== rb) { return ra - rb; }
        return (pairs[a].pairIndex ?? 0) - (pairs[b].pairIndex ?? 0);
      });
    }
    return indexes;
  }

  function _recomputeFilteredIndexes() {
    const pairs = getState().bulkJob?.pairs ?? [];
    _state.filteredIndexes = _computeFilteredIndexes(pairs);
    _updateTotalHeight();
  }

  function _fullRelayoutAndRepaint() {
    _recomputeFilteredIndexes();
    for (const node of _mountedByPairIndex.values()) { _releaseNode(node); }
    _mountedByPairIndex.clear();
    _scheduleRepaint();
  }

  function _patchInPlaceAll() {
    const pairs = getState().bulkJob?.pairs ?? [];
    for (const [pairIndex, node] of _mountedByPairIndex) {
      const pair = pairs[pairIndex];
      if (pair) { _syncRow(node, pair); }
    }
  }

  function _filterAffectsOrderOrInclusion() {
    return _state.failuresOnly || _state.failureFirstSort;
  }

  async function _lazyLoadNumbersForPair(pair, reports) {
    if (!pair || pair.status !== 'done') { return; }
    if (_state.numbersByPair.has(pair.pairIndex)) { return; }
    if (_state.numbersLoading.has(pair.pairIndex)) { return; }
    _state.numbersLoading.add(pair.pairIndex);
    try {
      const baseline = reports.find((r) => r.id === pair.baselineReportId) ?? null;
      const compare  = reports.find((r) => r.id === pair.compareReportId)  ?? null;
      let comparison = null;
      if (pair.baselineReportId && pair.compareReportId && pair.mode) {
        try {
          comparison = await storage.loadComparisonByPair(
            pair.baselineReportId, pair.compareReportId, pair.mode
          );
        } catch { void 0; }
      }
      const elementDelta = (baseline?.totalElements != null && compare?.totalElements != null)
        ? compare.totalElements - baseline.totalElements
        : null;
      const summary = comparison?.summary ?? comparison?.comparison?.summary ?? null;
      const sev = summary?.severityCounts ?? null;
      _state.numbersByPair.set(pair.pairIndex, {
        elementDelta,
        critical: sev?.critical ?? 0,
        high:     sev?.high     ?? 0,
      });
      if (_state.showNumbers) {
        const node = _mountedByPairIndex.get(pair.pairIndex);
        if (node) { _syncRow(node, pair); }
      }
    } finally {
      _state.numbersLoading.delete(pair.pairIndex);
    }
  }

  async function _lazyLoadNumbersForVisiblePairs() {
    const job = getState().bulkJob;
    if (!job) { return; }
    const reports = getState().reports ?? [];
    for (const pairIndex of _mountedByPairIndex.keys()) {
      const pair = job.pairs[pairIndex];
      if (pair?.status === 'done' && !_state.numbersByPair.has(pair.pairIndex)) {
        void _lazyLoadNumbersForPair(pair, reports);
      }
    }
  }

  function _ensureVisible(pairIndex) {
    if (!_refs.viewport) { return; }
    if (_refs.autoFollow && !_refs.autoFollow.checked) { return; }
    const pos = _state.filteredIndexes.indexOf(pairIndex);
    if (pos < 0) { return; }
    const top = pos * ROW_HEIGHT;
    const viewH = _geom.containerHeight || _refs.viewport.clientHeight || 400;
    const scrollTop = _scroll.top;
    if (top < scrollTop || top + ROW_HEIGHT > scrollTop + viewH) {
      _refs.viewport.scrollTop = Math.max(0, top - viewH / 2);
    }
  }

  function _ensureVisibleForActivePairs(pairs) {
    if (!_refs.viewport) { return; }
    if (_refs.autoFollow && !_refs.autoFollow.checked) { return; }
    for (const pair of pairs) {
      if (ACTIVE_STATES.has(pair.status)) {
        _ensureVisible(pair.pairIndex);
      }
    }
  }

  function _renderJobHeader(job) {
    if (!_refs.summary || !_refs.title) { return; }
    _refs.title.textContent = job.filename || 'Bulk run';

    const done      = job.pairs.filter((p) => p.status === 'done').length;
    const failed    = job.pairs.filter((p) => p.status === 'failed').length;
    const cancelled = job.pairs.filter((p) => p.status === 'cancelled').length;
    const queued    = job.pairs.filter((p) => p.status === 'queued').length;
    const reused    = job.pairs.filter((p) => p.deduped && p.deduped !== 'none').length;
    const runningPair = job.pairs.find((p) => ACTIVE_STATES.has(p.status));
    const runningIndex = runningPair ? runningPair.pairIndex : null;

    const reusedHtml = reused > 0
      ? ` · <span class="bulk-summary__reused">${reused} reused</span>`
      : '';
    const headSegment = runningIndex !== null
      ? `Pair ${runningIndex + 1} of ${job.totalPairs} running · `
      : '';
    _refs.summary.innerHTML =
      `${headSegment}${done} done${reusedHtml} · ${failed} failed · ${cancelled} cancelled · ${queued} queued`;

    if (_refs.progressBar) {
      const pct = job.totalPairs > 0 ? ((done + failed + cancelled) / job.totalPairs) * 100 : 0;
      _refs.progressBar.style.width = `${pct}%`;
      _refs.progressBar.classList.toggle('progress-fill--finishing', pct >= 95);
    }

    const isTerminal   = TERMINAL_STATUSES.has(job.status);
    const isCancelling = job.cancelling === true;

    if (_refs.cancelBtn) {
      _refs.cancelBtn.hidden = isTerminal;
      if (isTerminal) {
        _refs.cancelBtn.disabled = true;
        _refs.cancelBtn.textContent = _stateLabel(job.status);
      } else if (isCancelling || _refs.cancelBtn.disabled) {
        _refs.cancelBtn.disabled    = true;
        _refs.cancelBtn.textContent = 'Cancelling…';
      } else {
        _refs.cancelBtn.disabled    = false;
        _refs.cancelBtn.textContent = 'Cancel';
      }
    }

    if (_refs.cancelNote && _refs.cancelNote.hidden === false) {
      const cancelledNow = cancelled;
      _refs.cancelNote.textContent =
        `Stopping after current page (up to ~60s) · cancelled ${Math.min(cancelledNow, _state.cancelPendingTotal ?? cancelledNow)}/${_state.cancelPendingTotal ?? cancelledNow} pending`;
      if (isTerminal) {
        _refs.cancelNote.hidden      = true;
        _refs.cancelNote.textContent = '';
      }
    }

    if (_refs.backBtn)   { _refs.backBtn.hidden   = !isTerminal; }
    if (_refs.exportBtn) { _refs.exportBtn.hidden = !isTerminal; }
    if (_refs.downloadAllControls) {
      const hasExportablePairs = (job.pairs ?? []).some((p) =>
        p && p.status === 'done' && p.baselineReportId && p.compareReportId && p.comparisonId
      );
      _refs.downloadAllControls.hidden = !(isTerminal && hasExportablePairs);
    }

    _renderStorageDegradedNotice(job);
    _ensureElapsedTimer(job);
  }

  function _renderStorageDegradedNotice(job) {
    const slot = _refs.storageDegradedSlot;
    if (!slot) { return; }
    if (job?.storageDegraded === true) {
      if (!slot.firstChild) {
        slot.innerHTML = `
          <div class="bulk-storage-degraded-notice" role="alert">
            Storage is degraded — the run was halted. Pairs already saved remain available. Restart the application to recover storage.
          </div>
        `;
      }
    } else if (slot.firstChild) {
      slot.replaceChildren();
    }
  }

  function _renderDownloadAllProgress(p) {
    if (!_refs.downloadAllProgress || !_refs.downloadAllBtn) { return; }
    const running = Boolean(p?.running);
    if (running) {
      _refs.downloadAllProgress.hidden    = false;
      _refs.downloadAllProgress.textContent =
        `Pair ${p.current} of ${p.total} · ${p.succeeded} written${p.failed ? ` · ${p.failed} failed` : ''}`;
      _refs.downloadAllBtn.disabled = true;
      if (_refs.downloadAllFormat) { _refs.downloadAllFormat.disabled = true; }
      if (_refs.downloadAllCancel) { _refs.downloadAllCancel.hidden   = false; }
    } else {
      _refs.downloadAllProgress.hidden    = true;
      _refs.downloadAllProgress.textContent = '';
      _refs.downloadAllBtn.disabled = false;
      if (_refs.downloadAllFormat) { _refs.downloadAllFormat.disabled = false; }
      if (_refs.downloadAllCancel) { _refs.downloadAllCancel.hidden   = true;  }
    }
  }

  function _formatElapsed(deltaMs) {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) { return '00:00'; }
    const totalSec = Math.floor(deltaMs / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function _ensureElapsedTimer(job) {
    if (!_refs.elapsed) { return; }
    const isTerminal = TERMINAL_STATUSES.has(job.status);
    const startedAt = job.startedAt;

    const tick = () => {
      if (!_refs.elapsed) { return; }
      const startMs = startedAt ?? Date.now();
      const endMs   = isTerminal && job.completedAt ? job.completedAt : Date.now();
      _refs.elapsed.textContent = _formatElapsed(endMs - startMs);
    };
    tick();

    if (isTerminal) {
      if (_state.elapsedInterval) {
        clearInterval(_state.elapsedInterval);
        _state.elapsedInterval = null;
      }
      return;
    }
    if (_state.elapsedInterval) { return; }
    _state.elapsedInterval = setInterval(tick, 1000);
  }

  function _onWindowClick(ev) {
    const btn = ev.target.closest('.bulk-row__open-btn');
    if (!btn) { return; }
    const idx = parseInt(btn.dataset.pairIndex, 10);
    if (!Number.isFinite(idx)) { return; }
    ev.stopPropagation();
    void routeBulkPairOpenClick(idx);
  }

  function _findAdjacentDonePairIndex(pairs, from, delta) {
    if (delta < 0) {
      for (let i = from - 1; i >= 0; i--) {
        if (pairs[i]?.status === 'done') { return i; }
      }
      return -1;
    }
    for (let i = from + 1; i < pairs.length; i++) {
      if (pairs[i]?.status === 'done') { return i; }
    }
    return -1;
  }

  function _ensureNavFooter() {
    let footer = document.getElementById('bulk-pair-nav-footer');
    if (footer) { return footer; }
    const area = document.getElementById('bulk-result-area');
    if (!area) { return null; }
    footer = document.createElement('div');
    footer.id = 'bulk-pair-nav-footer';
    footer.className = 'bulk-pair-nav-footer';
    footer.innerHTML = `
      <button type="button" class="btn-ghost btn-sm bulk-pair-nav-footer__prev" data-field="prev">
        ‹ Previous
      </button>
      <span class="bulk-pair-nav-footer__position" data-field="position"></span>
      <div class="bulk-pair-nav-footer__actions">
        <button type="button" class="btn-ghost btn-sm bulk-pair-nav-footer__close" data-field="close"
                title="Close (Esc)">Close</button>
        <button type="button" class="btn-ghost btn-sm bulk-pair-nav-footer__next" data-field="next">
          Next ›
        </button>
      </div>
    `;
    area.appendChild(footer);
    footer.querySelector('[data-field="prev"]').addEventListener('click', () => _navigatePair(-1));
    footer.querySelector('[data-field="next"]').addEventListener('click', () => _navigatePair(1));
    footer.querySelector('[data-field="close"]').addEventListener('click', () => _closeResultPanel());
    return footer;
  }

  function _renderNavFooter(job, hasComparison) {
    const area = document.getElementById('bulk-result-area');
    if (!area) { return; }
    const activePairIndex = job?.activePairIndex;
    if (activePairIndex == null || !hasComparison) {
      const existing = document.getElementById('bulk-pair-nav-footer');
      if (existing) { existing.hidden = true; }
      return;
    }

    const footer = _ensureNavFooter();
    if (!footer) { return; }
    footer.hidden = false;

    const pairs = job.pairs ?? [];
    const total = pairs.length;
    const prevIdx = _findAdjacentDonePairIndex(pairs, activePairIndex, -1);
    const nextIdx = _findAdjacentDonePairIndex(pairs, activePairIndex,  1);

    const prevBtn = footer.querySelector('[data-field="prev"]');
    const nextBtn = footer.querySelector('[data-field="next"]');
    const posEl   = footer.querySelector('[data-field="position"]');

    prevBtn.disabled = prevIdx < 0;
    nextBtn.disabled = nextIdx < 0;
    prevBtn.dataset.targetIndex = String(prevIdx);
    nextBtn.dataset.targetIndex = String(nextIdx);
    posEl.textContent = `Pair ${activePairIndex + 1} of ${total}`;
  }

  function _navigatePair(delta) {
    const job = getState().bulkJob;
    if (!job || job.activePairIndex == null) { return; }
    const target = _findAdjacentDonePairIndex(job.pairs ?? [], job.activePairIndex, delta);
    if (target >= 0) { void routeBulkPairOpenClick(target); }
  }

  function _closeResultPanel() {
    const area = document.getElementById('bulk-result-area');
    const shot = document.getElementById('bulk-results-screenshot-section');
    const host = document.getElementById('bulk-result-panel-host');
    if (host) { host.replaceChildren(); }
    if (shot) { shot.replaceChildren(); }
    if (area) { area.hidden = true; }
    const footer = document.getElementById('bulk-pair-nav-footer');
    if (footer) { footer.hidden = true; }
    dispatch('BULK_ACTIVE_PAIR_CLEAR', {});
  }

  function _setupKeyboardNav() {
    const handler = (ev) => {
      const job = getState().bulkJob;
      if (!job || job.activePairIndex == null) { return; }
      const area = document.getElementById('bulk-result-area');
      if (!area || area.hidden) { return; }
      const t = ev.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) { return; }
      if (ev.key === 'ArrowLeft') {
        ev.preventDefault();
        _navigatePair(-1);
      } else if (ev.key === 'ArrowRight') {
        ev.preventDefault();
        _navigatePair(1);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        _closeResultPanel();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }

  function _renderTabStatus(state) {
    const span = document.getElementById('nav-section-status-bulk');
    if (!span) { return; }
    const status     = state.bulkJob?.status ?? null;
    const detection  = state.bulkDetectionState ?? 'idle';
    const effective  = status ?? (detection === 'loading' ? 'parsing' : null);
    let html = '';
    switch (effective) {
      case 'parsing':
        html = '<span class="nav-section-status__spinner" aria-hidden="true"></span>';
        break;
      case 'running':
        html = '<span class="nav-section-status__dot nav-section-status__dot--active">●</span>';
        break;
      case 'completed':
        html = '<span class="nav-section-status__dot nav-section-status__dot--success">●</span>';
        break;
      case 'partial':
        html = '<span class="nav-section-status__dot nav-section-status__dot--warning">●</span>';
        break;
      case 'failed':
        html = '<span class="nav-section-status__dot nav-section-status__dot--error">✗</span>';
        break;
      default:
        html = '';
        break;
    }
    if (span.innerHTML !== html) { span.innerHTML = html; }
  }

  function _handleJobPairsChanged(job, forceRelayout) {
    const pairs = job.pairs;
    let needRelayout = forceRelayout;

    if (pairs.length !== _state.lastPairsLen) {
      needRelayout = true;
      _state.lastPairsLen = pairs.length;
    }

    if (!needRelayout && _filterAffectsOrderOrInclusion()) {
      for (const p of pairs) {
        if (_state.lastStatusByPair.get(p.pairIndex) !== p.status) {
          needRelayout = true;
          break;
        }
      }
    }

    for (const p of pairs) {
      _state.lastStatusByPair.set(p.pairIndex, p.status);
    }

    if (needRelayout) {
      _fullRelayoutAndRepaint();
    } else {
      _patchInPlaceAll();
    }

    _ensureVisibleForActivePairs(pairs);
  }

  function _renderForState(state) {
    _renderTabStatus(state);
    const job = state.bulkJob;
    const rows = state.bulkParsedRows ?? [];

    if (job) {
      const justMounted = !_refs.viewport;
      if (justMounted) { _renderRunningShell(); }
      _handleJobPairsChanged(job, justMounted);
      _renderJobHeader(job);
      _renderNavFooter(job, Boolean(state.bulkJob?.viewer));
      return;
    }

    if (rows.length > 0) {
      _resetViewportRefs();
      _renderPreview(rows);
      return;
    }

    _resetViewportRefs();
    _renderIdle();
  }

  function _resetViewportRefs() {
    if (_refs.resizeObs) { try { _refs.resizeObs.disconnect(); } catch { void 0; } }
    if (_raf.handle !== 0) {
      cancelAnimationFrame(_raf.handle);
      _raf.handle = 0;
    }
    if (_state.elapsedInterval) {
      clearInterval(_state.elapsedInterval);
      _state.elapsedInterval = null;
    }
    _refs.viewport = null;
    _refs.spacer = null;
    _refs.window = null;
    _refs.summary = null;
    _refs.title = null;
    _refs.elapsed = null;
    _refs.progressBar = null;
    _refs.cancelBtn = null;
    _refs.cancelNote = null;
    _refs.exportBtn = null;
    _refs.downloadAllControls = null;
    _refs.downloadAllFormat   = null;
    _refs.downloadAllBtn      = null;
    _refs.downloadAllCancel   = null;
    _refs.downloadAllProgress = null;
    if (_state.downloadAllUnsub) { try { _state.downloadAllUnsub(); } catch { void 0; } _state.downloadAllUnsub = null; }
    _refs.backBtn = null;
    _refs.resizeObs = null;
    _refs.storageDegradedSlot = null;
    _refs.autoFollow = null;
    _refs.filterInput     = null;
    _refs.failuresOnlyBtn = null;
    _refs.showNumbersBtn  = null;
    _refs.colStateBtn     = null;
    _mountedByPairIndex.clear();
    _recyclePool.length   = 0;
    _geom.containerHeight = 0;
    _geom.totalHeight     = 0;
    _scroll.top           = 0;
    _state.cancelPendingTotal  = null;
    _state.cancelledSinceClick = 0;
    _state.searchQuery        = '';
    _state.failuresOnly       = false;
    _state.failureFirstSort   = false;
    _state.showNumbers        = false;
    _state.numbersByPair.clear();
    _state.numbersLoading.clear();
    _state.filteredIndexes    = [];
    _state.lastPairsLen       = 0;
    _state.lastStatusByPair.clear();
  }

  _renderForState(getState());
  const unsubscribe = subscribe((state) => _renderForState(state));
  _keyboardUnbind = _setupKeyboardNav();

  return {
    destroy() {
      try { unsubscribe(); } catch { void 0; }
      if (_keyboardUnbind) { try { _keyboardUnbind(); } catch { void 0; } _keyboardUnbind = null; }
      _resetViewportRefs();
      if (_state.elapsedInterval) {
        clearInterval(_state.elapsedInterval);
        _state.elapsedInterval = null;
      }
      const footer = document.getElementById('bulk-pair-nav-footer');
      if (footer) { footer.remove(); }
      containerEl.innerHTML = '';
    },
    ensureVisible: _ensureVisible,
  };
}

export { createBulkPanel };
