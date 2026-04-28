import storage from '../../infrastructure/idb-repository.js';
import { dispatch, getState } from '../state.js';
import {
  setError,
  showProgress,
  hideProgress,
  updateProgress } from
'../ui.js';
import { iconAlertTriangle } from '../utils/icons.js';
import { loadAndRenderReports } from './report-manager.js';

const api = window.electronAPI;

const _extractCancelAck = new Set();

let _activeExtractCancel = null;
let _extractBusy = false;

export function routeExtractBtnClick() {
  if (_activeExtractCancel) {
    void _activeExtractCancel();
    return;
  }
  void handleExtraction();
}

function _filterClause(filters) {
  if (!filters || typeof filters !== 'object') return 'none';
  const parts = [];
  if (filters.class?.trim()) parts.push(`class="${filters.class.trim()}"`);
  if (filters.id?.trim()) parts.push(`id="${filters.id.trim()}"`);
  if (filters.tag?.trim()) parts.push(`tag="${filters.tag.trim()}"`);
  return parts.length ? parts.join(', ') : 'none';
}

function _reportDisplayLabel(reportId) {
  const reports = getState().reports ?? [];
  const total = reports.length;
  const idx = reports.findIndex((r) => r.id === reportId);
  if (idx < 0) return '';
  return `R${total - idx}`;
}

function _clearExtractSummary() {
  const el = document.getElementById('extract-summary');
  if (!el) return;
  el.replaceChildren();
  el.hidden = true;
}

function _renderExtractSummary(payload) {
  const slot = document.getElementById('extract-summary');
  if (!slot) return;
  slot.replaceChildren();
  const { status } = payload;
  const card = document.createElement('div');
  card.className = 'operation-summary-card';

  const body = document.createElement('div');
  body.className = 'operation-summary-card__body';

  if (status === 'success') {
    const header = document.createElement('div');
    header.className = 'operation-summary-card__header';
    const dot = document.createElement('span');
    dot.className = 'operation-summary-card__status-dot';
    dot.setAttribute('aria-hidden', 'true');
    const primary = document.createElement('span');
    primary.className = 'operation-summary-card__primary';
    const num = document.createElement('span');
    num.className = 'operation-summary-card__stat-num';
    num.textContent = String(payload.elementCount ?? 0);
    const lab = document.createElement('span');
    lab.className = 'operation-summary-card__stat-suffix';
    lab.textContent = 'elements';
    primary.appendChild(num);
    primary.appendChild(lab);
    const chips = document.createElement('div');
    chips.className = 'operation-summary-card__chips';
    const durSec = payload.durationMs != null ? (payload.durationMs / 1000).toFixed(1) : '0';
    const durChip = document.createElement('span');
    durChip.className = 'operation-summary-card__chip';
    durChip.textContent = `${durSec}s`;
    chips.appendChild(durChip);
    const rid = payload.reportId ? _reportDisplayLabel(payload.reportId) : '';
    if (rid) {
      const idChip = document.createElement('span');
      idChip.className = 'operation-summary-card__chip';
      idChip.textContent = rid;
      chips.appendChild(idChip);
    }
    header.appendChild(dot);
    header.appendChild(primary);
    header.appendChild(chips);
    body.appendChild(header);

    const metaRow = document.createElement('div');
    metaRow.className = 'operation-summary-card__meta-row';
    const urlSpan = document.createElement('span');
    urlSpan.className = 'operation-summary-card__url';
    const u = payload.url ?? '';
    urlSpan.textContent = u;
    urlSpan.title = u;
    metaRow.appendChild(urlSpan);
    const clause = payload.filterClause ?? 'none';
    if (clause !== 'none') {
      const sep = document.createElement('span');
      sep.className = 'operation-summary-card__filters';
      sep.textContent = ` · Filters: ${clause}`;
      metaRow.appendChild(sep);
    }
    body.appendChild(metaRow);

    if (payload.captureQuality === 'DEGRADED') {
      const wr = document.createElement('div');
      wr.className = 'operation-summary-card__warnline';
      const ic = document.createElement('span');
      ic.setAttribute('aria-hidden', 'true');
      ic.innerHTML = iconAlertTriangle(14);
      const wt = document.createElement('span');
      wt.textContent =
      'Page was still loading during extraction — captured elements may be incomplete.';
      wr.appendChild(ic);
      wr.appendChild(wt);
      body.appendChild(wr);
    }
  } else if (status === 'cancelled') {
    const header = document.createElement('div');
    header.className = 'operation-summary-card__header';
    const dot = document.createElement('span');
    dot.className = 'operation-summary-card__status-dot operation-summary-card__status-dot--muted';
    dot.setAttribute('aria-hidden', 'true');
    const line = document.createElement('span');
    line.className = 'operation-summary-card__cancelled-only';
    line.textContent = 'Extraction cancelled';
    header.appendChild(dot);
    header.appendChild(line);
    body.appendChild(header);
  } else {
    const header = document.createElement('div');
    header.className = 'operation-summary-card__header';
    const dot = document.createElement('span');
    dot.className = 'operation-summary-card__status-dot operation-summary-card__status-dot--error';
    dot.setAttribute('aria-hidden', 'true');
    const line = document.createElement('span');
    line.className = 'operation-summary-card__error-only';
    line.textContent = payload.message || 'Extraction failed';
    header.appendChild(dot);
    header.appendChild(line);
    body.appendChild(header);
  }

  card.appendChild(body);
  slot.appendChild(card);
  slot.hidden = false;
}

function _validateBrowserSelection(snapshot) {
  const { browserDetectionState, selectedBrowser } = snapshot;
  if (browserDetectionState !== 'ready') {
    return { ok: false, message: 'Browser detection still running — wait for the selector to populate.' };
  }
  if (!selectedBrowser) {
    return { ok: false, message: 'No browser available — install Playwright browsers (npm run install:browsers).' };
  }
  if (!selectedBrowser.isLaunchable) {
    return { ok: false, message: `${selectedBrowser.displayName} cannot be driven by Playwright on this OS.` };
  }
  return { ok: true };
}

async function handleExtraction() {
  const extractBtn = document.getElementById('extract-btn');
  const urlInput = document.getElementById('url-input');
  if (!extractBtn || !urlInput) {return;}

  if (_extractBusy) {
    return;
  }

  const url = urlInput.value.trim();
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    setError('extract', 'Enter a valid URL starting with http:// or https://');
    return;
  }

  const stateSnapshot = getState();
  const browserCheck = _validateBrowserSelection(stateSnapshot);
  if (!browserCheck.ok) {
    setError('extract', browserCheck.message);
    _renderExtractSummary({ status: 'error', message: browserCheck.message });
    return;
  }
  const selectedBrowser = stateSnapshot.selectedBrowser;
  const browserPayload = selectedBrowser
    ? {
        browserType:    selectedBrowser.browserType,
        channel:        selectedBrowser.channel,
        executablePath: selectedBrowser.executablePath,
      }
    : { browserType: 'chromium', channel: null, executablePath: null };

  _extractBusy = true;
  setError('extract', '');
  _clearExtractSummary();

  const originalHTML = extractBtn.innerHTML;
  const originalClass = extractBtn.className;
  extractBtn.style.minWidth = `${extractBtn.offsetWidth}px`;
  extractBtn.className = 'btn-primary btn-primary--operation-cancel';
  extractBtn.textContent = 'Cancel';
  extractBtn.disabled = false;

  const operationId = crypto.randomUUID();

  _activeExtractCancel = async () => {
    const ack = await api.cancelOperation({ operationId, kind: 'extract' });
    if (ack?.acknowledged) {
      _extractCancelAck.add(operationId);
      dispatch('OPERATION_CANCELLING', {});
      const lbl = document.getElementById('extract-progress-label');
      if (lbl) {lbl.textContent = 'Cancelling…';}
      extractBtn.disabled = true;
    }
  };

  dispatch('EXTRACTION_STARTED', { label: 'Starting…', pct: 0 });

  const filterClass = document.getElementById('filter-class')?.value.trim() ?? '';
  const filterId = document.getElementById('filter-id')?.value.trim() ?? '';
  const filterTag = document.getElementById('filter-tag')?.value.trim() ?? '';
  const filters = {};
  if (filterClass) {filters.class = filterClass;}
  if (filterId) {filters.id = filterId;}
  if (filterTag) {filters.tag = filterTag;}
  const options = Object.keys(filters).length > 0
    ? { filters, browser: browserPayload }
    : { browser: browserPayload };
  const filterClause = _filterClause(Object.keys(filters).length ? filters : {});

  const offExtraction = api.onExtractionProgress((data) => {
    if (data?.operationId && data.operationId !== operationId) return;
    updateProgress('extract', data.pct, data.label);
    dispatch('EXTRACTION_PROGRESS', { label: data.label, pct: data.pct });
  });

  showProgress('extract', 'Starting…');

  try {
    const result = await api.extractElements({ url, options, operationId });

    if (_extractCancelAck.has(operationId) || result.cancelled) {
      hideProgress('extract');
      _renderExtractSummary({ status: 'cancelled' });
      return;
    }

    if (!result.success) {
      hideProgress('extract');
      const errText = result.error ?? 'Extraction failed';
      setError('extract', errText);
      _renderExtractSummary({ status: 'error', message: errText });
      return;
    }

    if (_extractCancelAck.has(operationId)) {
      hideProgress('extract');
      _renderExtractSummary({ status: 'cancelled' });
      return;
    }

    const report = Object.assign({}, result.report, {
      id: result.report.id ?? crypto.randomUUID(),
      timestamp: result.report.timestamp ?? new Date().toISOString(),
      url: result.report.url ?? url,
      duration: result.report?.duration ?? result.duration
    });

    hideProgress('extract');

    await storage.saveReport(report);
    await loadAndRenderReports();
    _renderExtractSummary({
      status: 'success',
      elementCount: report.totalElements ?? 0,
      durationMs: report.duration,
      url: report.url ?? url,
      filterClause,
      captureQuality: result.report?.captureQuality,
      reportId: report.id
    });

  } catch (err) {
    hideProgress('extract');
    const msg = err.message ?? 'Unexpected error';
    setError('extract', msg);
    _renderExtractSummary({ status: 'error', message: msg });
  } finally {
    offExtraction();
    hideProgress('extract');
    _extractCancelAck.delete(operationId);
    _activeExtractCancel = null;
    _extractBusy = false;
    dispatch('EXTRACT_UI_END', {});
    extractBtn.className = originalClass;
    extractBtn.innerHTML = originalHTML;
    extractBtn.style.minWidth = '';
    extractBtn.disabled = false;
  }
}