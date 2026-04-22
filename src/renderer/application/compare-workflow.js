import { dispatch, getState } from '../state.js';
import storage from '../../infrastructure/idb-repository.js';
import { buildPairKey } from '../../infrastructure/idb-repository.js';
import { assessUrlCompatibility } from '@core/comparison/url-compatibility.js';
import { relativeTime } from '../utils/time.js';
import {
  Toast,
  setError,
  showProgress,
  hideProgress,
  updateProgress,
  syncCompareButton,
} from '../ui.js';

const api = window.electronAPI;

const _compareCancelAck = new Set();

let _activeCompareCancel = null;
let _compareBusy = false;

export function routeCompareBtnClick() {
  if (_activeCompareCancel) {
    void _activeCompareCancel();
    return;
  }
  void handleComparison();
}

function _clearCompareCancelLine() {
  const el = document.getElementById('compare-summary');
  if (!el) return;
  el.replaceChildren();
  el.hidden = true;
}

function _buildCompareSummaryStrip(result, fromCache, cachedAtIso) {
  const m = result?.matching ?? {};
  const summary = result?.comparison?.summary ?? {};
  const added = result?.unmatchedElements?.compare ?? [];
  const removed = result?.unmatchedElements?.baseline ?? [];
  const addedCnt = m.addedCount ?? added.length ?? 0;
  const removedCnt = m.removedCount ?? removed.length ?? 0;
  const modified = m.modifiedCount ?? summary.modifiedElements ?? 0;
  const unmatched = addedCnt + removedCnt;
  const changeCount = modified + unmatched;
  const totalElements = _totalElementsFromMatching(m);
  const matchPct = m.matchRate ?? 0;
  const durationMs = result?.duration ?? 0;
  return {
    changeCount,
    matchPct,
    totalElements,
    durationMs,
    fromCache: Boolean(fromCache),
    cachedAtIso: cachedAtIso ?? null,
  };
}

function _matchPctValueClass(pct) {
  if (pct >= 90) return 'compare-result-stats__value compare-result-stats__value--match-hi';
  if (pct >= 70) return 'compare-result-stats__value compare-result-stats__value--match-mid';
  return 'compare-result-stats__value compare-result-stats__value--match-lo';
}

export function renderCompareSummaryFromStrip(strip) {
  const slot = document.getElementById('compare-summary');
  if (!slot) return;
  if (!strip || typeof strip !== 'object') {
    slot.replaceChildren();
    slot.hidden = true;
    return;
  }
  slot.replaceChildren();
  slot.hidden = false;
  const pack = document.createElement('div');
  pack.className = 'compare-result-stats-pack';
  const stateLbl = document.createElement('div');
  stateLbl.className = 'compare-result-stats__state-label';
  stateLbl.textContent = strip.fromCache && strip.cachedAtIso
    ? `LOADED FROM CACHE · ${relativeTime(strip.cachedAtIso)}`
    : 'COMPARISON COMPLETE';
  pack.appendChild(stateLbl);

  const row = document.createElement('div');
  row.className = 'compare-result-stats';

  const chipEl = document.createElement('div');
  chipEl.className = 'compare-result-stats__chip';
  const vEl = document.createElement('span');
  vEl.className = 'compare-result-stats__value';
  vEl.textContent = String(strip.totalElements ?? 0);
  const lEl = document.createElement('span');
  lEl.className = 'compare-result-stats__label';
  lEl.textContent = 'elements';
  chipEl.append(vEl, lEl);

  const sep1 = document.createElement('span');
  sep1.className = 'compare-result-stats__sep';
  sep1.setAttribute('aria-hidden', 'true');

  const chipMatch = document.createElement('div');
  chipMatch.className = 'compare-result-stats__chip';
  const vMt = document.createElement('span');
  vMt.className = _matchPctValueClass(Number(strip.matchPct) || 0);
  vMt.textContent = `${strip.matchPct ?? 0}%`;
  const lMt = document.createElement('span');
  lMt.className = 'compare-result-stats__label';
  lMt.textContent = 'matched';
  chipMatch.append(vMt, lMt);

  const sep2 = document.createElement('span');
  sep2.className = 'compare-result-stats__sep';
  sep2.setAttribute('aria-hidden', 'true');

  const chipChanges = document.createElement('div');
  chipChanges.className = 'compare-result-stats__chip';
  const vCh = document.createElement('span');
  vCh.className = 'compare-result-stats__value';
  vCh.textContent = String(strip.changeCount ?? 0);
  const lCh = document.createElement('span');
  lCh.className = 'compare-result-stats__label';
  lCh.textContent = 'changes';
  chipChanges.append(vCh, lCh);

  const trail = document.createElement('span');
  trail.className = 'compare-result-stats__trail';
  const meta = document.createElement('span');
  meta.className = 'compare-result-stats__meta';
  meta.textContent = `${Math.round(Number(strip.durationMs) || 0)}ms`;
  trail.appendChild(meta);

  row.append(chipEl, sep1, chipMatch, sep2, chipChanges, trail);

  pack.appendChild(row);
  slot.appendChild(pack);
}

function _totalElementsFromMatching(m) {
  if (!m || typeof m !== 'object') return 0;
  if (m.totalElements != null) return m.totalElements;
  return (m.totalMatched ?? 0) + (m.unmatchedBaseline ?? 0) + (m.unmatchedCompare ?? 0);
}

function _enqueueOptionalLoadCachedAfterCancel(baselineId, compareId, mode) {
  void (async () => {
    let cached = null;
    try {
      cached = await storage.loadComparisonByPair(baselineId, compareId, mode);
    } catch { return; }
    if (!cached) return;
    const slot = document.getElementById('compare-summary');
    if (!slot || slot.hidden) return;
    const label = slot.querySelector('.compare-cancel-status__text');
    if (!label || label.textContent !== 'Comparison cancelled') return;
    const domb = document.getElementById('baseline-report')?.value?.trim() ?? '';
    const domc = document.getElementById('compare-report')?.value?.trim() ?? '';
    const modeEl = document.querySelector('[name="compare-mode"]:checked')?.value ?? 'dynamic';
    if (domb !== baselineId || domc !== compareId || modeEl !== mode) return;
    if (slot.querySelector('button.btn-ghost.btn-sm')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-ghost btn-sm';
    btn.textContent = 'Load previous result';
    const onClick = () => void tryLoadCachedComparison();
    btn.addEventListener('click', onClick);
    slot.appendChild(btn);
  })();
}

function _renderCompareCancelledLine(baselineId, compareId, mode) {
  const slot = document.getElementById('compare-summary');
  if (!slot) return;
  slot.replaceChildren();
  const line = document.createElement('div');
  line.className = 'compare-summary-cancel-line';
  const dot = document.createElement('span');
  dot.className = 'compare-cancel-status__dot';
  dot.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.className = 'compare-cancel-status__text';
  text.textContent = 'Comparison cancelled';
  line.appendChild(dot);
  line.appendChild(text);
  slot.appendChild(line);
  slot.hidden = false;
  _enqueueOptionalLoadCachedAfterCancel(baselineId, compareId, mode);
}

function scrollCompareResultsIntoView() {
  const el = document.getElementById('compare-results');
  if (!el) { return; }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function normalizeComparisonResult(result) {
  if (!result || typeof result !== 'object') { return null; }

  const visualDiffs = result.visualDiffs instanceof Map
    ? result.visualDiffs
    : new Map(
        Object.entries(result.visualDiffs ?? {}).map(([k, v]) => [String(k), v])
      );

  const comparison = result.comparison && typeof result.comparison === 'object'
    ? result.comparison
    : {};

  return {
    ...result,
    visualDiffs,
    comparison: {
      ...comparison,
      results: Array.isArray(comparison.results) ? comparison.results : [],
      summary: comparison.summary && typeof comparison.summary === 'object'
        ? comparison.summary
        : {},
    },
  };
}

async function tryLoadCachedComparison() {
  const domb = document.getElementById('baseline-report')?.value?.trim() ?? '';
  const domc = document.getElementById('compare-report')?.value?.trim() ?? '';
  let state = getState();
  if (!state.selectedBaseline && domb) {
    dispatch('BASELINE_SELECTED', { id: domb });
  }
  if (!state.selectedCompare && domc) {
    dispatch('COMPARE_SELECTED', { id: domc });
  }
  state = getState();
  const baselineId = state.selectedBaseline ?? domb ?? null;
  const compareId = state.selectedCompare ?? domc ?? null;
  const mode = state.compareMode ?? document.querySelector('[name="compare-mode"]:checked')?.value ?? 'dynamic';
  if (!baselineId || !compareId || baselineId === compareId) {
    return;
  }

  try {
    const cached = await storage.loadComparisonByPair(
      baselineId,
      compareId,
      mode
    );
    if (cached) {
      let diffs = [];
      try { diffs = await storage.loadComparisonDiffs(cached.id); } catch (_) { void 0; }
      const stLatest = getState();
      const baselineRep = stLatest.reports?.find(r => r.id === cached.baselineId);
      const compareRep  = stLatest.reports?.find(r => r.id === cached.compareId);
      const normalized = normalizeComparisonResult({
        baselineId:        cached.baselineId,
        compareId:         cached.compareId,
        mode:              cached.mode,
        matching:          cached.matching,
        comparison:        { summary: cached.summary, results: diffs },
        visualDiffs:       {},
        unmatchedElements: cached.unmatchedElements,
        duration:          cached.duration ?? 0,
        baselineUrl:       baselineRep?.url ?? '',
        compareUrl:        compareRep?.url ?? '',
      });
      const compareSummaryStrip = _buildCompareSummaryStrip(normalized, true, cached.timestamp);
      dispatch('COMPARISON_COMPLETE', {
        result: { ...normalized, id: cached.id },
        cachedAt: cached.timestamp,
        fromCache: true,
        compareSummaryStrip,
      });
      scrollCompareResultsIntoView();
    } else {
      _clearCompareCancelLine();
      dispatch('RESET_COMPARISON', {});
    }
  } catch (_) {
    Toast.show('Previous comparison unavailable', 'warning', 4000);
  }
}

async function handleComparison() {
  if (_compareBusy) {
    return;
  }
  const state   = getState();
  const reports = state.reports ?? [];

  const baselineReport = reports.find(r => r.id === state.selectedBaseline);
  const compareReport  = reports.find(r => r.id === state.selectedCompare);

  if (!baselineReport || !compareReport) {
    setError('compare', 'Select both baseline and compare reports');
    return;
  }
  if (baselineReport.id === compareReport.id) {
    setError('compare', 'Select two different reports');
    return;
  }

  setError('compare', '');
  _clearCompareCancelLine();

  try {
    const compat = assessUrlCompatibility(baselineReport.url, compareReport.url);
    if (compat.classification === 'INCOMPATIBLE') {
      const delta = compat.mismatchDelta;
      const msg = delta?.pathname
        ? `Incompatible URLs — paths differ: "${delta.pathname.baseline}" vs "${delta.pathname.compare}"`
        : 'Incompatible URLs — check that both reports are from the same page path';
      Toast.error(msg);
      dispatch('RESET_COMPARISON', {});
      return;
    }
    if (compat.classification === 'CAUTION') {
      const delta = compat.mismatchDelta;
      const parts = [];
      if (delta?.hash) { parts.push(`hash differs (${delta.hash.baseline || 'none'} → ${delta.hash.compare || 'none'})`); }
      if (delta?.queryParams?.length) { parts.push(`query params differ: ${delta.queryParams.map(p => p.key).join(', ')}`); }
      Toast.warning(`URL mismatch — ${parts.join('; ') || 'check page state'} — results may include false positives`);
    }
  } catch (compatErr) {
    console.error('URL compatibility check failed:', compatErr);
    Toast.warning('URL compatibility check failed — proceeding');
  }

  _compareBusy = true;
  const compareBtn = document.getElementById('compare-btn');
  const originalHTML = compareBtn.innerHTML;
  const originalClass = compareBtn.className;
  compareBtn.style.minWidth = `${compareBtn.offsetWidth}px`;
  compareBtn.className = 'btn-primary btn-primary--operation-cancel';
  compareBtn.textContent = 'Cancel';
  compareBtn.disabled = false;

  const operationId = crypto.randomUUID();
  const activeOpId = operationId;

  _activeCompareCancel = async () => {
    const ack = await api.cancelOperation({ operationId: activeOpId, kind: 'compare' });
    if (ack?.acknowledged) {
      _compareCancelAck.add(activeOpId);
      dispatch('OPERATION_CANCELLING', {});
      const lbl = document.getElementById('compare-progress-label');
      if (lbl) { lbl.textContent = 'Cancelling…'; }
      compareBtn.disabled = true;
    }
  };

  dispatch('COMPARISON_STARTED', {});

  const mode               = document.querySelector('[name="compare-mode"]:checked')?.value ?? 'dynamic';
  const includeScreenshots = document.getElementById('visual-diff-toggle')?.checked ?? true;

  const off = api.onComparisonProgress((data) => {
    if (data?.operationId && data.operationId !== activeOpId) return;
    updateProgress('compare', data.pct, data.label);
    dispatch('COMPARISON_PROGRESS', { label: data.label, pct: data.pct });
  });

  showProgress('compare', 'Starting…');

  try {
    const [baselineElements, compareElements] = await Promise.all([
      storage.loadReportElements(baselineReport.id),
      storage.loadReportElements(compareReport.id),
    ]);

    if (!baselineElements.length) {
      throw new Error(`No elements found for baseline report — re-extract the page`);
    }
    if (!compareElements.length) {
      throw new Error(`No elements found for compare report — re-extract the page`);
    }

    const result = await api.startComparison({
      baselineId:       baselineReport.id,
      compareId:        compareReport.id,
      mode,
      baselineUrl:      baselineReport.url,
      compareUrl:       compareReport.url,
      baselineElements,
      compareElements,
      includeScreenshots,
      operationId,
    });

    if (_compareCancelAck.has(operationId) || result.cancelled) {
      hideProgress('compare');
      dispatch('RESET_COMPARISON', {});
      _renderCompareCancelledLine(baselineReport.id, compareReport.id, mode);
      return;
    }

    if (!result.success) {
      hideProgress('compare');
      _clearCompareCancelLine();
      const err = result.error ?? 'Comparison failed';
      dispatch('COMPARISON_ERROR', { error: err });
      setError('compare', err);
      Toast.error(err);
      return;
    }

    if (_compareCancelAck.has(operationId)) {
      hideProgress('compare');
      dispatch('RESET_COMPARISON', {});
      _renderCompareCancelledLine(baselineReport.id, compareReport.id, mode);
      return;
    }

    hideProgress('compare');

    const sr         = result.result;
    const normalized = normalizeComparisonResult({
      ...sr,
      baselineUrl: baselineReport.url,
      compareUrl:  compareReport.url,
    });

    const meta = {
      id:                crypto.randomUUID(),
      pairKey:           buildPairKey(sr.baselineId, sr.compareId, sr.mode),
      baselineId:        sr.baselineId,
      compareId:         sr.compareId,
      mode:              sr.mode,
      matching:          sr.matching,
      summary:           sr.comparison?.summary,
      unmatchedElements: sr.unmatchedElements,
      duration:          sr.duration,
      timestamp:         sr.completedAt ?? new Date().toISOString(),
    };

    await storage.saveComparison(meta, sr.comparison?.results ?? []);

    try {
      if (sr.visualBlobs && typeof sr.visualBlobs === 'object') {
        for (const [keyframeId, blobData] of Object.entries(sr.visualBlobs)) {
          if (blobData && blobData.buffer) {
            const uint8Array = blobData.buffer instanceof Uint8Array
              ? blobData.buffer
              : new Uint8Array(blobData.buffer);
            const blob = new Blob([uint8Array], { type: blobData.mimeType || 'image/webp' });
            await storage.saveVisualBlob(`${meta.id}:${keyframeId}`, blob, meta.id);
          }
        }
      }

      if (Array.isArray(sr.visualKeyframes) && sr.visualKeyframes.length > 0) {
        await Promise.all(sr.visualKeyframes.map(kf => storage.saveVisualKeyframe(kf)));
      }

      if (Array.isArray(sr.visualRectRecords) && sr.visualRectRecords.length > 0) {
        await storage.saveVisualElementRects(sr.visualRectRecords);
      }
    } catch (persistErr) {
      console.error('Visual data persistence failed — comparison result is still available this session but screenshots may not appear in exports:', persistErr.message);
      Toast.warning('Some visual screenshots could not be saved — full report images may be missing.');
    }

    const compareSummaryStrip = _buildCompareSummaryStrip(
      { ...normalized, duration: sr.duration },
      false,
      null,
    );
    dispatch('COMPARISON_COMPLETE', {
      result: { ...normalized, id: meta.id },
      fromCache: false,
      compareSummaryStrip,
    });
    scrollCompareResultsIntoView();

    if (sr.visualDiffStatus?.status !== 'completed') {
      Toast.info(`Visual diff did not complete (status: ${sr.visualDiffStatus?.status}) — screenshot comparison may be unavailable`);
    }

  } catch (err) {
    hideProgress('compare');
    _clearCompareCancelLine();
    const msg = err.message ?? 'Unexpected error';
    dispatch('COMPARISON_ERROR', { error: msg });
    setError('compare', msg);
    Toast.error(msg);
  } finally {
    off();
    hideProgress('compare');
    _compareCancelAck.delete(operationId);
    _activeCompareCancel = null;
    _compareBusy = false;
    dispatch('COMPARE_UI_END', {});
    compareBtn.className = originalClass;
    compareBtn.innerHTML = originalHTML;
    compareBtn.style.minWidth = '';
    syncCompareButton();
  }
}

export { normalizeComparisonResult, tryLoadCachedComparison, handleComparison };