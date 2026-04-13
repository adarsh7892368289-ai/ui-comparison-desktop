import { dispatch, getState } from '../state.js';
import storage from '../../infrastructure/idb-repository.js';
import { buildPairKey } from '../../infrastructure/idb-repository.js';
import { assessUrlCompatibility } from '@core/comparison/url-compatibility.js';
import { iconSpinner } from '../utils/icons.js';
import {
  Toast,
  setError,
  showProgress,
  hideProgress,
  updateProgress,
} from '../ui.js';

const api = window.electronAPI;

function scrollCompareResultsIntoView() {
  const el = document.getElementById('compare-results');
  if (!el) { return; }
  /* Double rAF: layout + result-panel paint after synchronous render (Session 9) */
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
  const state = getState();
  if (!state.selectedBaseline || !state.selectedCompare) { return; }

  try {
    const cached = await storage.loadComparisonByPair(
      state.selectedBaseline,
      state.selectedCompare,
      state.compareMode ?? 'dynamic'
    );
    if (cached) {
      let diffs = [];
      try { diffs = await storage.loadComparisonDiffs(cached.id); } catch (_) {}
      const normalized = normalizeComparisonResult({
        baselineId:        cached.baselineId,
        compareId:         cached.compareId,
        mode:              cached.mode,
        matching:          cached.matching,
        comparison:        { summary: cached.summary, results: diffs },
        visualDiffs:       {},
        unmatchedElements: cached.unmatchedElements,
        duration:          cached.duration ?? 0,
      });
      dispatch('COMPARISON_COMPLETE', { result: { ...normalized, id: cached.id }, cachedAt: cached.timestamp });
      scrollCompareResultsIntoView();
    } else {
      dispatch('RESET_COMPARISON', {});
    }
  } catch (_) {
    Toast.show('Previous comparison unavailable', 'warning', 4000);
  }
}

async function handleComparison() {
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
  const compareBtn = document.getElementById('compare-btn');
  const originalHTML = compareBtn.innerHTML;
  compareBtn.style.minWidth = compareBtn.offsetWidth + 'px';   // lock width BEFORE innerHTML change
  compareBtn.disabled  = true;
  compareBtn.innerHTML = `${iconSpinner(14)} <span>Comparing…</span>`;

  try {
    const compat = assessUrlCompatibility(baselineReport.url, compareReport.url);
    if (compat.classification === 'INCOMPATIBLE') {
      const delta = compat.mismatchDelta;
      const msg = delta?.pathname
        ? `Incompatible URLs — paths differ: "${delta.pathname.baseline}" vs "${delta.pathname.compare}"`
        : 'Incompatible URLs — check that both reports are from the same page path';
      Toast.error(msg);
      dispatch('RESET_COMPARISON', {});
      compareBtn.disabled    = false;
      compareBtn.innerHTML   = originalHTML;
      compareBtn.style.minWidth = '';
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

  showProgress('compare', 'Starting…');
  dispatch('COMPARISON_STARTED', {});

  const mode               = document.querySelector('[name="compare-mode"]:checked')?.value ?? 'dynamic';
  const includeScreenshots = document.getElementById('visual-diff-toggle')?.checked ?? true;

  const off = api.onComparisonProgress((data) => {
    updateProgress('compare', data.pct, data.label);
  });

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
    });

    if (!result.success) {
      dispatch('COMPARISON_ERROR', { error: result.error ?? 'Comparison failed' });
      setError('compare', result.error ?? 'Comparison failed');
      Toast.error(result.error ?? 'Comparison failed');
      return;
    }

    const sr         = result.result;
    const normalized = normalizeComparisonResult(sr);

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

    dispatch('COMPARISON_COMPLETE', { result: { ...normalized, id: meta.id } });
    scrollCompareResultsIntoView();

    if (sr.visualDiffStatus?.status !== 'completed') {
      Toast.info(`Visual diff did not complete (status: ${sr.visualDiffStatus?.status}) — screenshot comparison may be unavailable`);
    }

    const diffs = sr.comparison?.summary?.propertyDiffCount
               ?? sr.comparison?.summary?.totalDifferences
               ?? 0;
    Toast.success(`Done — ${diffs} CSS change${diffs !== 1 ? 's' : ''} found`);

  } catch (err) {
    dispatch('COMPARISON_ERROR', { error: err.message });
    setError('compare', err.message ?? 'Unexpected error');
    Toast.error(err.message ?? 'Comparison failed');
  } finally {
    off();
    compareBtn.disabled    = false;
    compareBtn.innerHTML   = originalHTML;
    compareBtn.style.minWidth = '';
    hideProgress('compare');
  }
}

export { normalizeComparisonResult, tryLoadCachedComparison, handleComparison };