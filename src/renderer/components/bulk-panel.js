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

// Per UI spec §3.2 row heights live as CSS custom properties on the
// panel (`--bulk-row-h-compact`, `--bulk-row-h-running`,
// `--bulk-row-h-failed`); these defaults are overwritten on mount via
// `_readRowHeightsFromCss(rootEl)`. Mutating module-level state is safe
// because the renderer instantiates a single bulk panel.
let ROW_HEIGHT_COMPACT = 48;
let ROW_HEIGHT_ACTIVE  = 64;
let ROW_HEIGHT_FAILED  = 72;
const ACTIVE_STATES = new Set([
  'extracting-baseline',
  'extracting-compare',
  'matching',
  'screenshots',
  'persisting',
]);

function _rowHeightFor(status) {
  if (status === 'failed') { return ROW_HEIGHT_FAILED; }
  if (ACTIVE_STATES.has(status)) { return ROW_HEIGHT_ACTIVE; }
  return ROW_HEIGHT_COMPACT;
}

function _readRowHeightsFromCss(rootEl) {
  if (!rootEl || typeof getComputedStyle !== 'function') { return; }
  try {
    const cs = getComputedStyle(rootEl);
    const c = parseInt(cs.getPropertyValue('--bulk-row-h-compact'), 10);
    const r = parseInt(cs.getPropertyValue('--bulk-row-h-running'), 10);
    const f = parseInt(cs.getPropertyValue('--bulk-row-h-failed'),  10);
    if (Number.isFinite(c) && c > 0) { ROW_HEIGHT_COMPACT = c; }
    if (Number.isFinite(r) && r > 0) { ROW_HEIGHT_ACTIVE  = r; }
    if (Number.isFinite(f) && f > 0) { ROW_HEIGHT_FAILED  = f; }
  } catch { void 0; }
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

function _firstVisibleIndex(offsets, scrollTop) {
  if (offsets.length === 0) { return 0; }
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= scrollTop) { lo = mid; }
    else                           { hi = mid - 1; }
  }
  return lo;
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

  // Spec §3.2 — pull row heights from CSS custom properties exactly once
  // on mount; values cached on module-level constants for O(1) reads.
  _readRowHeightsFromCss(containerEl);

  const _state = {
    rowOffsets:           [],
    filteredIndexes:      [],
    totalHeight:          0,
    lastViewH:            0,
    lastSeenStatus:       new Map(),
    // For the "phase-change-only" recompute trigger (see _recomputeOffsets
    // for the mechanism). Snapshot of statuses captured *after* the last
    // successful recompute, indexed by pairIndex.
    lastStatusForOffsets: new Map(),
    lastPairsLen:         0,
    filterDirty:          false,
    rewardTimers:         new Map(),
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

  const _refs = {};

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
        <div id="bulk-nav-bar" hidden></div>
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
    _refs.navBar       = containerEl.querySelector('#bulk-nav-bar');
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
      const area = document.getElementById('bulk-result-area');
      const shot = document.getElementById('bulk-results-screenshot-section');
      const host = document.getElementById('bulk-result-panel-host');
      if (host) { host.replaceChildren(); }
      if (shot) { shot.replaceChildren(); }
      if (area) { area.hidden = true; }
      const hadViewer = getState().bulkJob?.activePairIndex != null;
      if (hadViewer) {
        dispatch('BULK_ACTIVE_PAIR_CLEAR', {});
        return;
      }
      void routeBulkResetClick();
    });
    _refs.viewport?.addEventListener('scroll', _renderRows, { passive: true });
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
      _refreshFilteredView();
    });
    _refs.failuresOnlyBtn?.addEventListener('click', () => {
      _state.failuresOnly = !_state.failuresOnly;
      _refs.failuresOnlyBtn.classList.toggle('btn-ghost--active', _state.failuresOnly);
      _refreshFilteredView();
    });
    _refs.showNumbersBtn?.addEventListener('click', () => {
      _state.showNumbers = !_state.showNumbers;
      _refs.showNumbersBtn.classList.toggle('btn-ghost--active', _state.showNumbers);
      if (_state.showNumbers) { void _lazyLoadNumbersForVisiblePairs(); }
      _renderRows();
    });
    _refs.colStateBtn?.addEventListener('click', () => {
      _state.failureFirstSort = !_state.failureFirstSort;
      _refs.colStateBtn.classList.toggle('bulk-pair-col--sorted', _state.failureFirstSort);
      _refreshFilteredView();
    });

    if (typeof ResizeObserver !== 'undefined' && _refs.viewport) {
      _refs.resizeObs = new ResizeObserver(() => {
        const h = _refs.viewport.clientHeight;
        if (h > 0) { _state.lastViewH = h; }
        _renderRows();
      });
      _refs.resizeObs.observe(_refs.viewport);
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

  // [BUG FIX] Phase-change-only recompute trigger (UI spec §3.5).
  //
  // Mechanism: _recomputeOffsets allocates new arrays of length N (≤500)
  // and walks every pair to rebuild the cumulative `_offsets` table. At
  // concurrency 4 with ~10 BULK_PROGRESS events/sec/pair, the panel
  // receives ~40 state-change subscriptions per second; running this
  // O(N) work on every one is ~20 000 array writes/sec at 500 pairs.
  //
  // Most BULK_PROGRESS events bump pct *within the same phase*; row
  // heights only change on phase transitions (queued→active 48→64,
  // active→done 64→48, *→failed →72). So we short-circuit when no
  // status has flipped since the last recompute and the filter
  // configuration is unchanged. The pre-check is N hash-map lookups
  // (≈50 µs at 500 pairs) instead of allocating two N-sized arrays.
  //
  // Filter mutations (search input, failures-only toggle, sort toggle)
  // set `_state.filterDirty = true` to force the next recompute.
  function _shouldRecomputeOffsets(pairs) {
    if (pairs.length !== _state.lastPairsLen)         { return true; }
    if (_state.filterDirty)                            { return true; }
    if (_state.rowOffsets.length === 0 && pairs.length > 0) { return true; }
    for (const p of pairs) {
      if (_state.lastStatusForOffsets.get(p.pairIndex) !== p.status) {
        return true;
      }
    }
    return false;
  }

  function _recomputeOffsets(pairs) {
    if (!_shouldRecomputeOffsets(pairs)) { return; }
    const filtered = _computeFilteredIndexes(pairs);
    _state.filteredIndexes = filtered;
    const offs = new Array(filtered.length);
    let acc = 0;
    for (let i = 0; i < filtered.length; i++) {
      offs[i] = acc;
      acc += _rowHeightFor(pairs[filtered[i]].status);
    }
    _state.rowOffsets  = offs;
    _state.totalHeight = acc;
    _state.lastPairsLen = pairs.length;
    _state.lastStatusForOffsets.clear();
    for (const p of pairs) {
      _state.lastStatusForOffsets.set(p.pairIndex, p.status);
    }
    _state.filterDirty = false;
    if (_refs.spacer) { _refs.spacer.style.height = `${acc}px`; }
  }

  function _refreshFilteredView() {
    const job = getState().bulkJob;
    if (!job) { return; }
    _state.filterDirty = true;
    _recomputeOffsets(job.pairs);
    _renderRows();
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
      if (_state.showNumbers) { _renderRows(); }
    } finally {
      _state.numbersLoading.delete(pair.pairIndex);
    }
  }

  async function _lazyLoadNumbersForVisiblePairs() {
    const job = getState().bulkJob;
    if (!job) { return; }
    const reports = getState().reports ?? [];
    const filtered = _state.filteredIndexes;
    for (const idx of filtered) {
      const pair = job.pairs[idx];
      if (pair?.status === 'done' && !_state.numbersByPair.has(pair.pairIndex)) {
        void _lazyLoadNumbersForPair(pair, reports);
      }
    }
  }

  function _buildRow(pair) {
    const node = document.createElement('div');
    const activeCls = ACTIVE_STATES.has(pair.status) ? ' bulk-row--active' : '';
    const failedCls = pair.status === 'failed' ? ' bulk-row--failed' : '';
    const doneCls   = pair.status === 'done'   ? ' bulk-row--done'   : '';
    node.className = `bulk-row bulk-row--${pair.status}${activeCls}${failedCls}${doneCls}`;
    node.dataset.pairIndex = String(pair.pairIndex);
    node.setAttribute('role', 'listitem');

    const showProgress = ACTIVE_STATES.has(pair.status);
    const pctNum       = Math.max(2, Math.min(100, pair.pct ?? 0));
    const finishingCls = pctNum >= 95 ? ' progress-fill--finishing' : '';
    const progressHtml = showProgress
      ? `<div class="bulk-pair-row__inline-progress bulk-pair-row__inline-progress--running">
           <div class="progress-track">
             <div class="progress-fill${finishingCls}" style="width:${pctNum}%"></div>
           </div>
         </div>
         <span class="bulk-row__pct">${Math.round(pair.pct ?? 0)}%</span>`
      : '';

    const errorHtml = pair.status === 'failed'
      ? `<div class="bulk-row__error" title="${_esc(pair.error ?? '')}">${_esc(getErrorHint(pair.errorCode))}</div>`
      : '';

    const labelText = pair.label ? ` · ${_esc(pair.label)}` : '';

    const dedupGlyph = (pair.deduped && pair.deduped !== 'none')
      ? '<span class="bulk-row__dedup" title="Reused recent extraction" aria-label="Reused recent extraction">⤴</span>'
      : '';

    let numbersHtml = '';
    if (_state.showNumbers && pair.status === 'done') {
      const cached = _state.numbersByPair.get(pair.pairIndex);
      const delta = cached && Number.isFinite(cached.elementDelta) ? cached.elementDelta : null;
      const crit  = cached && Number.isFinite(cached.critical)     ? cached.critical     : null;
      const high  = cached && Number.isFinite(cached.high)         ? cached.high         : null;
      const fmtDelta = delta == null ? '—' : (delta > 0 ? `+${delta}` : String(delta));
      numbersHtml = `
        <span class="bulk-row__numbers" aria-hidden="true">
          <span class="bulk-row__num bulk-row__num--delta" title="Element delta (compare − baseline)">Δ ${fmtDelta}</span>
          <span class="bulk-row__num bulk-row__num--crit"  title="Critical diffs">C ${crit ?? '—'}</span>
          <span class="bulk-row__num bulk-row__num--high"  title="High diffs">H ${high ?? '—'}</span>
        </span>
      `;
    }

    node.innerHTML = `
      <div class="bulk-row__main">
        <span class="bulk-status-dot bulk-status-dot--${pair.status}" aria-hidden="true"></span>
        <span class="bulk-row__index">#${pair.pairIndex + 1}</span>
        <span class="bulk-row__urls" title="${_esc(pair.baselineUrl)} → ${_esc(pair.compareUrl)}">
          ${_esc(pair.baselineUrl)} → ${_esc(pair.compareUrl)}${labelText}
        </span>
        ${dedupGlyph}
        ${numbersHtml}
        <span class="bulk-row__state">${_stateLabel(pair.status)}</span>
        ${pair.status === 'done'
          ? `<button type="button" class="btn-ghost btn-sm bulk-row__open-btn" data-pair-index="${pair.pairIndex}">Open</button>`
          : ''}
      </div>
      ${progressHtml}
      ${errorHtml}
    `;
    return node;
  }

  function _renderRows() {
    if (!_refs.viewport || !_refs.window) { return; }
    const pairs = getState().bulkJob?.pairs ?? [];
    const filtered = _state.filteredIndexes;
    if (pairs.length === 0 || filtered.length === 0) {
      _refs.window.replaceChildren();
      return;
    }

    const viewH = _state.lastViewH || _refs.viewport.clientHeight || 400;
    const scrollTop = _refs.viewport.scrollTop;
    const overscanPx = 3 * ROW_HEIGHT_ACTIVE;
    const renderTop = Math.max(0, scrollTop - overscanPx);
    const renderBot = scrollTop + viewH + overscanPx;

    let pos = _firstVisibleIndex(_state.rowOffsets, renderTop);
    const frag = document.createDocumentFragment();
    while (pos < filtered.length && _state.rowOffsets[pos] < renderBot) {
      const originalIndex = filtered[pos];
      const pair = pairs[originalIndex];
      const node = _buildRow(pair);
      node.style.position  = 'absolute';
      node.style.left      = '0';
      node.style.right     = '0';
      node.style.transform = `translateY(${_state.rowOffsets[pos]}px)`;
      node.style.height    = `${_rowHeightFor(pair.status)}px`;
      if (_state.rewardTimers.has(pair.pairIndex)) {
        node.classList.add('bulk-row--reward');
      }
      frag.appendChild(node);
      pos++;
    }
    _refs.window.replaceChildren(frag);

    if (_state.showNumbers) { void _lazyLoadNumbersForVisiblePairs(); }
  }

  function _ensureVisible(pairIndex) {
    if (!_refs.viewport) { return; }
    if (_refs.autoFollow && !_refs.autoFollow.checked) { return; }
    const pos = _state.filteredIndexes.indexOf(pairIndex);
    if (pos < 0 || pos >= _state.rowOffsets.length) { return; }
    const top = _state.rowOffsets[pos];
    const h = _rowHeightFor(getState().bulkJob.pairs[pairIndex].status);
    const viewH = _state.lastViewH || _refs.viewport.clientHeight || 400;
    const scrollTop = _refs.viewport.scrollTop;
    if (top < scrollTop || top + h > scrollTop + viewH) {
      _refs.viewport.scrollTop = Math.max(0, top - viewH / 2);
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

  function _detectTransitionsAndReward(pairs) {
    for (const pair of pairs) {
      const prev = _state.lastSeenStatus.get(pair.pairIndex);
      if (prev !== pair.status) {
        _state.lastSeenStatus.set(pair.pairIndex, pair.status);
        if (pair.status === 'done' && prev && ACTIVE_STATES.has(prev)) {
          if (_state.rewardTimers.has(pair.pairIndex)) {
            clearTimeout(_state.rewardTimers.get(pair.pairIndex));
          }
          // UI spec §9.4: dot scales 1.0→1.3→1.0 over 150 ms; class is
          // removed at 200 ms so the animation can re-trigger if the row
          // re-renders. Failed/cancelled rows skip this entirely (we only
          // arm the timer when status === 'done').
          const t = setTimeout(() => {
            _state.rewardTimers.delete(pair.pairIndex);
            _renderRows();
          }, 200);
          _state.rewardTimers.set(pair.pairIndex, t);
        }
      }
    }
  }

  // [BUG FIX] UI spec §3.5 / §9.3: ensureVisible runs after every
  // BULK_PROGRESS, not only on phase transitions. _ensureVisible is a
  // no-op when the row is already in view (avoids jitter); it also
  // honours the auto-follow toggle. Calling it for every active row
  // costs <1 µs per row when in-view (single arithmetic comparison).
  function _ensureVisibleForActivePairs(pairs) {
    if (!_refs.viewport) { return; }
    if (_refs.autoFollow && !_refs.autoFollow.checked) { return; }
    for (const pair of pairs) {
      if (ACTIVE_STATES.has(pair.status)) {
        _ensureVisible(pair.pairIndex);
      }
    }
  }

  function _onWindowClick(ev) {
    const btn = ev.target.closest('.bulk-row__open-btn');
    if (!btn) return;
    const idx = parseInt(btn.dataset.pairIndex, 10);
    if (!Number.isFinite(idx)) return;
    ev.stopPropagation();
    void routeBulkPairOpenClick(idx);
  }

  function _renderNavBar(job, hasComparison) {
    if (!_refs.navBar) return;
    const activePairIndex = job?.activePairIndex;
    if (activePairIndex == null || !hasComparison) {
      _refs.navBar.hidden = true;
      _refs.navBar.textContent = '';
      return;
    }

    const pairs = job.pairs ?? [];
    const total = pairs.length;

    const prevDone = (function findPrev() {
      for (let i = activePairIndex - 1; i >= 0; i--) {
        if (pairs[i]?.status === 'done') return i;
      }
      return -1;
    }());

    const nextDone = (function findNext() {
      for (let i = activePairIndex + 1; i < total; i++) {
        if (pairs[i]?.status === 'done') return i;
      }
      return -1;
    }());

    const prevDisabled = prevDone < 0;
    const nextDisabled = nextDone < 0;

    _refs.navBar.hidden = false;
    _refs.navBar.innerHTML = `
      <div class="bulk-nav-bar">
        <button type="button" class="btn-ghost btn-sm" id="bulk-prev-pair-btn"
                data-nav-index="${prevDone}" ${prevDisabled ? 'disabled' : ''}>
          ‹ Pair ${prevDone >= 0 ? prevDone + 1 : '—'}
        </button>
        <span class="bulk-nav-bar__position">
          Pair ${activePairIndex + 1} of ${total}
        </span>
        <button type="button" class="btn-ghost btn-sm" id="bulk-next-pair-btn"
                data-nav-index="${nextDone}" ${nextDisabled ? 'disabled' : ''}>
          Pair ${nextDone >= 0 ? nextDone + 1 : '—'} ›
        </button>
      </div>
    `;

    if (!prevDisabled) {
      _refs.navBar.querySelector('#bulk-prev-pair-btn')?.addEventListener('click', () => {
        void routeBulkPairOpenClick(prevDone);
      });
    }
    if (!nextDisabled) {
      _refs.navBar.querySelector('#bulk-next-pair-btn')?.addEventListener('click', () => {
        void routeBulkPairOpenClick(nextDone);
      });
    }
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

  function _renderForState(state) {
    _renderTabStatus(state);
    const job = state.bulkJob;
    const rows = state.bulkParsedRows ?? [];

    if (job) {
      if (!_refs.viewport) { _renderRowsRequiresShell(); }
      _recomputeOffsets(job.pairs);
      _detectTransitionsAndReward(job.pairs);
      _renderJobHeader(job);
      _renderNavBar(job, Boolean(state.bulkJob?.viewer));
      _renderRows();
      _ensureVisibleForActivePairs(job.pairs);
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

  function _renderRowsRequiresShell() {
    _resetViewportRefs();
    _renderRunningShell();
  }

  function _resetViewportRefs() {
    if (_refs.resizeObs) { try { _refs.resizeObs.disconnect(); } catch { void 0; } }
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
    _refs.navBar = null;
    _refs.storageDegradedSlot = null;
    _refs.autoFollow = null;
    _refs.filterInput     = null;
    _refs.failuresOnlyBtn = null;
    _refs.showNumbersBtn  = null;
    _refs.colStateBtn     = null;
    _state.cancelPendingTotal  = null;
    _state.cancelledSinceClick = 0;
    _state.searchQuery        = '';
    _state.failuresOnly       = false;
    _state.failureFirstSort   = false;
    _state.showNumbers        = false;
    _state.numbersByPair.clear();
    _state.numbersLoading.clear();
    _state.filteredIndexes    = [];
    _state.rowOffsets         = [];
    _state.totalHeight        = 0;
    _state.lastStatusForOffsets.clear();
    _state.lastPairsLen       = 0;
    _state.filterDirty        = false;
  }

  _renderForState(getState());
  const unsubscribe = subscribe((state) => _renderForState(state));

  return {
    destroy() {
      try { unsubscribe(); } catch { void 0; }
      _resetViewportRefs();
      for (const t of _state.rewardTimers.values()) { clearTimeout(t); }
      _state.rewardTimers.clear();
      if (_state.elapsedInterval) {
        clearInterval(_state.elapsedInterval);
        _state.elapsedInterval = null;
      }
      containerEl.innerHTML = '';
    },
    ensureVisible: _ensureVisible,
  };
}

export { createBulkPanel };
