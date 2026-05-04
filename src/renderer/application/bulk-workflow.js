'use strict';

import { getState, dispatch } from '../state.js';
import storage, { buildPairKey } from '../../infrastructure/idb-repository.js';
import { Toast } from '../ui.js';
import { loadComparisonFromCacheByPairIds } from './compare-workflow.js';
import { loadAndRenderReports } from './report-manager.js';
import { buildExtractionKey, todayYmd } from '@core/bulk/extraction-key.js';
import { get as getDefault } from '@config/defaults.js';
import { sanitizeFilename } from '../utils/sanitize.js';
import { hostFromUrl } from '../utils/report-metadata.js';
import { exportToHTML }               from '@core/export/comparison-exporters/html-exporter.js';
import { buildComparisonCsv }         from '@core/export/comparison-exporters/csv-exporter.js';
import { buildComparisonJsonPayload } from '@core/export/comparison-exporters/json-exporter.js';

const api = window.electronAPI;

const BULK_CONCURRENCY_RAM_THRESHOLD_MB  = 12 * 1024;
const BULK_CONCURRENCY_HETEROGENEOUS_CAP = 1;

let _hostTotalMemMBCache = null;
let _hostMemoryCachedFlag = false;

async function _hostTotalMemMB() {
  if (_hostMemoryCachedFlag) { return _hostTotalMemMBCache; }
  if (typeof api?.getHostMemory !== 'function') {
    _hostMemoryCachedFlag = true;
    return null;
  }
  try {
    const result = await api.getHostMemory();
    _hostTotalMemMBCache = typeof result?.totalMemMB === 'number' ? result.totalMemMB : null;
  } catch {
    _hostTotalMemMBCache = null;
  }
  _hostMemoryCachedFlag = true;
  return _hostTotalMemMBCache;
}

function _planIsHeterogeneous(pairs, jobLevelDescriptor) {
  const jobType = jobLevelDescriptor?.browserType ?? null;
  if (!jobType || !Array.isArray(pairs)) { return false; }
  for (const p of pairs) {
    const t = p?.browser?.browserType ?? jobType;
    if (t !== jobType) { return true; }
  }
  return false;
}

function _clampConcurrency(requested, totalMemMB, heterogeneous) {
  let maxConcurrency;
  try { maxConcurrency = getDefault('bulk.maxConcurrency'); }
  catch { maxConcurrency = 4; }
  const hasEnoughRAM = typeof totalMemMB === 'number' && totalMemMB >= BULK_CONCURRENCY_RAM_THRESHOLD_MB;
  const hostMax      = hasEnoughRAM ? maxConcurrency : Math.min(2, maxConcurrency);
  if (heterogeneous && !hasEnoughRAM) {
    return BULK_CONCURRENCY_HETEROGENEOUS_CAP;
  }
  return Math.max(1, Math.min(requested || 1, hostMax));
}

const _pairIdsByJobId      = new Map();
const _pairMetaByJobId     = new Map();
const _pendingPersistByPairIndex = new Map();
// [BUG FIX] Per plan §13.6: write per-pair phase to IDB on the FIRST
// BULK_PROGRESS event of each new phase only — never on intra-phase pct
// bumps. Without this, a crash mid-pair leaves STORE_BULK_PAIRS at
// 'queued' and detectAndOfferResume cannot mark the row INTERRUPTED, so
// resume re-runs work that was almost complete. Key: `${jobId}:${pairIndex}`.
const _lastPersistedPhaseByPairKey = new Map();

function _newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function _readJobOptionsFromDom() {
  const concEl     = document.getElementById('bulk-concurrency');
  const shotsEl    = document.getElementById('bulk-screenshots');
  const cooldEl    = document.getElementById('bulk-host-cooldown');
  const forceEl    = document.getElementById('bulk-force-refresh');
  const concurrency        = Math.max(1, Math.min(4, parseInt(concEl?.value ?? '2', 10) || 2));
  const includeScreenshots = shotsEl ? Boolean(shotsEl.checked) : true;
  const hostCooldownMs     = Math.max(0, parseInt(cooldEl?.value ?? '500', 10) || 0);
  const forceRefresh       = forceEl ? Boolean(forceEl.checked) : false;
  return { concurrency, includeScreenshots, hostCooldownMs, forceRefresh };
}

export async function computeDeduplicationPlan(pairs, jobOptions = {}) {
  const list = Array.isArray(pairs) ? pairs : [];
  if (jobOptions.forceRefresh === true) {
    return list.map((p) => ({ ...p, dedupedSides: {} }));
  }
  if (typeof storage.loadReportByExtractionKey !== 'function') {
    return list.map((p) => ({ ...p, dedupedSides: {} }));
  }

  const dateYmd = todayYmd();
  const out = new Array(list.length);

  for (let i = 0; i < list.length; i++) {
    const pair    = list[i];
    const browser = pair.browser ?? null;
    if (!browser || !browser.browserType) {
      out[i] = { ...pair, dedupedSides: {} };
      continue;
    }
    const keyArgs = {
      browserType:    browser.browserType,
      channel:        browser.channel        ?? null,
      executablePath: browser.executablePath ?? null,
      dateYmd,
    };

    const dedupedSides = {};
    try {
      const baselineKey = await buildExtractionKey({ ...keyArgs, url: pair.baselineUrl });
      const compareKey  = await buildExtractionKey({ ...keyArgs, url: pair.compareUrl  });

      const [baselineHit, compareHit] = await Promise.all([
        storage.loadReportByExtractionKey(baselineKey),
        storage.loadReportByExtractionKey(compareKey),
      ]);

      if (baselineHit && (baselineHit.totalElements ?? 0) > 0) {
        dedupedSides.baseline = { reportId: baselineHit.id };
      }
      if (compareHit && (compareHit.totalElements ?? 0) > 0) {
        dedupedSides.compare = { reportId: compareHit.id };
      }
    } catch (err) {
      console.error('[bulk] dedup lookup failed for pair', i, err);
    }

    out[i] = { ...pair, dedupedSides };
  }

  return out;
}

async function _provideDedupedElementsToMain(jobId, pairs) {
  if (typeof api?.bulkProvideElements !== 'function') { return; }
  for (const pair of pairs) {
    const sides = pair.dedupedSides ?? {};
    if (sides.baseline?.reportId) {
      try {
        const elements = await storage.loadReportElements(sides.baseline.reportId);
        await api.bulkProvideElements({
          jobId,
          pairIndex: pair.pairIndex,
          side:      'baseline',
          elements:  elements ?? [],
        });
      } catch (err) {
        console.error('[bulk] bulkProvideElements baseline failed', err);
      }
    }
    if (sides.compare?.reportId) {
      try {
        const elements = await storage.loadReportElements(sides.compare.reportId);
        await api.bulkProvideElements({
          jobId,
          pairIndex: pair.pairIndex,
          side:      'compare',
          elements:  elements ?? [],
        });
      } catch (err) {
        console.error('[bulk] bulkProvideElements compare failed', err);
      }
    }
  }
}

function _rememberPairMeta(jobId, pairs) {
  const meta = new Map();
  for (const pair of pairs) {
    meta.set(pair.pairIndex, {
      browser:     pair.browser ?? null,
      baselineUrl: pair.baselineUrl,
      compareUrl:  pair.compareUrl,
    });
  }
  _pairMetaByJobId.set(jobId, meta);
}

function _normalizeDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') { return null; }
  const browserType = descriptor.browserType ?? null;
  if (!browserType) { return null; }
  return {
    browserType,
    channel:        descriptor.channel        ?? null,
    executablePath: descriptor.executablePath ?? null,
    displayName:    descriptor.displayName    ?? null,
    isDefault:      Boolean(descriptor.isDefault),
    isLaunchable:   descriptor.isLaunchable   !== false,
  };
}

function _buildJobSpec(snapshot) {
  const opts = _readJobOptionsFromDom();
  const rows = Array.isArray(snapshot.bulkParsedRows) ? snapshot.bulkParsedRows : [];
  const valid = rows.filter((r) => r && r.valid !== false);
  const jobLevelDescriptor = _normalizeDescriptor(snapshot.selectedBrowser)
    ?? { browserType: 'chromium', channel: null, executablePath: null };
  const filename = snapshot.bulkFilename ?? document.getElementById('bulk-filename')?.textContent ?? 'bulk.xlsx';

  const pairs = valid.map((row, i) => {
    const rowDescriptor = _normalizeDescriptor(row.resolvedBrowser) ?? jobLevelDescriptor;
    return {
      pairIndex:          i,
      pairId:             _newId(),
      comparisonId:       _newId(),
      baselineUrl:        row.baseline_url ?? row.baselineUrl,
      compareUrl:         row.compare_url ?? row.compareUrl,
      mode:               row.mode ?? 'dynamic',
      label:              row.label ?? null,
      includeScreenshots: row.screenshots ?? opts.includeScreenshots,
      browser:            rowDescriptor,
      filterClass:        row.filter_class ?? null,
      filterId:           row.filter_id    ?? null,
      filterTag:          row.filter_tag   ?? null,
    };
  });

  const comparisonIdsByPairIndex = {};
  for (const p of pairs) {
    comparisonIdsByPairIndex[p.pairIndex] = p.comparisonId;
  }

  return {
    jobId:          _newId(),
    filename,
    pairs,
    concurrency:    opts.concurrency,
    hostCooldownMs: opts.hostCooldownMs,
    comparisonIdsByPairIndex,
  };
}

export async function routeBulkStartClick() {
  const snapshot = getState();
  if (snapshot.bulkJob && snapshot.bulkJob.status === 'running') { return; }

  const rows = Array.isArray(snapshot.bulkParsedRows) ? snapshot.bulkParsedRows : [];
  const validCount = rows.filter((r) => r && r.valid !== false).length;
  if (validCount === 0) {
    Toast.show('No valid rows to run. Upload a plan with at least one valid pair.', 'warning');
    return;
  }

  const jobSpec = _buildJobSpec(snapshot);

  const browserDescriptor = _normalizeDescriptor(snapshot.selectedBrowser)
    ?? { browserType: 'chromium', channel: null, executablePath: null };
  const createdAt = Date.now();

  const pairIdMap = new Map();
  for (const pair of jobSpec.pairs) {
    pairIdMap.set(pair.pairIndex, pair.pairId);
  }
  _pairIdsByJobId.set(jobSpec.jobId, pairIdMap);

  // [BUG FIX] Optimistic Start render (UI spec §9.1).
  // Dispatch BULK_JOB_STARTED *synchronously* before any awaits so the
  // running view paints within one animation frame of the click. The
  // reducer optimistically sets pairs[0].status='extracting-baseline'.
  // Subsequent awaits (storage save, dedup, host-memory clamp, IPC
  // start) reconcile against this state — the reducer is idempotent
  // because main reports the same status when extraction actually begins.
  dispatch('BULK_JOB_STARTED', { jobSpec });

  try {
    if (typeof storage.saveBulkJob === 'function') {
      await storage.saveBulkJob({
        id:          jobSpec.jobId,
        filename:    jobSpec.filename,
        status:      'running',
        totalPairs:  jobSpec.pairs.length,
        concurrency: jobSpec.concurrency,
        browser:     browserDescriptor,
        createdAt,
      });
    }
    if (typeof storage.saveBulkPair === 'function') {
      for (const pair of jobSpec.pairs) {
        await storage.saveBulkPair({
          id:                 pair.pairId,
          jobId:              jobSpec.jobId,
          pairIndex:          pair.pairIndex,
          baselineUrl:        pair.baselineUrl,
          compareUrl:         pair.compareUrl,
          mode:               pair.mode,
          includeScreenshots: pair.includeScreenshots,
          label:              pair.label ?? null,
          browser:            _normalizeDescriptor(pair.browser) ?? browserDescriptor,
          filterClass:        pair.filterClass ?? null,
          filterId:           pair.filterId    ?? null,
          filterTag:          pair.filterTag   ?? null,
          status:             'queued',
          baselineReportId:   null,
          compareReportId:    null,
          comparisonId:       pair.comparisonId,
          error:              null,
          pct:                0,
          startedAt:          null,
          completedAt:        null,
        });
      }
    }
  } catch (err) {
    _pairIdsByJobId.delete(jobSpec.jobId);
    dispatch('BULK_JOB_CANCELLED');
    Toast.show(`Failed to persist bulk job: ${err?.message ?? err}`, 'error');
    return;
  }

  const opts = _readJobOptionsFromDom();
  let dedupedPairs;
  try {
    dedupedPairs = await computeDeduplicationPlan(jobSpec.pairs, { forceRefresh: opts.forceRefresh });
  } catch (err) {
    console.error('[bulk] computeDeduplicationPlan failed', err);
    dedupedPairs = jobSpec.pairs.map((p) => ({ ...p, dedupedSides: {} }));
  }
  jobSpec.pairs = dedupedPairs;

  const totalMemMB    = await _hostTotalMemMB();
  const heterogeneous = _planIsHeterogeneous(dedupedPairs, browserDescriptor);
  jobSpec.concurrency = _clampConcurrency(jobSpec.concurrency, totalMemMB, heterogeneous);

  _rememberPairMeta(jobSpec.jobId, dedupedPairs);

  if (typeof api?.startBulkJob !== 'function') {
    _pairIdsByJobId.delete(jobSpec.jobId);
    _pairMetaByJobId.delete(jobSpec.jobId);
    dispatch('BULK_JOB_CANCELLED');
    Toast.show('Bulk runner unavailable in this build.', 'error');
    return;
  }

  try {
    const result = await api.startBulkJob(jobSpec);
    if (!result || result.success === false) {
      _pairMetaByJobId.delete(jobSpec.jobId);
      dispatch('BULK_JOB_CANCELLED');
      Toast.show(result?.error ?? 'Failed to start bulk job', 'error');
      return;
    }
    void _provideDedupedElementsToMain(jobSpec.jobId, dedupedPairs);
  } catch (err) {
    _pairMetaByJobId.delete(jobSpec.jobId);
    dispatch('BULK_JOB_CANCELLED');
    Toast.show(err?.message ?? String(err), 'error');
  }
}

export async function routeBulkCancelClick() {
  const snapshot = getState();
  const jobId = snapshot.bulkJob?.jobId;
  if (!jobId) { return; }
  // [BUG FIX] Per UI spec §7.2: Cancel keeps status='running' (visually
  // Cancelling…) until BULK_JOB_COMPLETE arrives. Do NOT dispatch the
  // terminal BULK_JOB_CANCELLED here — that flips state to terminal
  // immediately and prematurely shows Back/Export controls.
  dispatch('BULK_JOB_CANCELLING');
  if (typeof api?.cancelBulkJob === 'function') {
    try { await api.cancelBulkJob(jobId); } catch { void 0; }
  }
}

export async function routeBulkResetClick() {
  const snapshot = getState();
  const job = snapshot.bulkJob;

  if (job && job.status === 'running' && typeof api?.cancelBulkJob === 'function') {
    try { await api.cancelBulkJob(job.jobId); } catch (err) {
      console.error('[bulk] cancelBulkJob during reset failed', err);
    }
  }

  if (job?.jobId) {
    _pairIdsByJobId.delete(job.jobId);
    _pairMetaByJobId.delete(job.jobId);
    const prefix = `${job.jobId}:`;
    for (const k of _lastPersistedPhaseByPairKey.keys()) {
      if (k.startsWith(prefix)) { _lastPersistedPhaseByPairKey.delete(k); }
    }
  }
  _pendingPersistByPairIndex.clear();

  dispatch('BULK_JOB_RESET');
}

function _isReusedSide(reportLike) {
  return Boolean(reportLike && reportLike.reused === true);
}

async function _persistPairResult(payload) {
  const jobId = payload.jobId ?? getState().bulkJob?.jobId ?? null;
  let baselineReportId = null;
  let compareReportId  = null;
  let comparisonId     = null;

  const pairMeta = jobId ? _pairMetaByJobId.get(jobId)?.get(payload.pairIndex) ?? null : null;
  const browser  = pairMeta?.browser ?? null;
  const dateYmd  = todayYmd();

  async function _keyFor(url) {
    if (!url || !browser?.browserType) { return null; }
    try {
      return await buildExtractionKey({
        url,
        browserType:    browser.browserType,
        channel:        browser.channel        ?? null,
        executablePath: browser.executablePath ?? null,
        dateYmd,
      });
    } catch {
      return null;
    }
  }

  try {
    const baselineSide = payload.baselineReport;
    if (baselineSide && typeof storage.saveReport === 'function') {
      if (_isReusedSide(baselineSide)) {
        baselineReportId = baselineSide.reportId ?? null;
      } else if (baselineSide.id) {
        baselineReportId = baselineSide.id;
        const extractionKey = await _keyFor(pairMeta?.baselineUrl ?? baselineSide.url);
        await storage.saveReport({
          ...baselineSide,
          bulkJobId:     jobId,
          extractionKey: extractionKey ?? undefined,
        });
      }
    }

    const compareSide = payload.compareReport;
    if (compareSide && typeof storage.saveReport === 'function') {
      if (_isReusedSide(compareSide)) {
        compareReportId = compareSide.reportId ?? null;
      } else if (compareSide.id) {
        compareReportId = compareSide.id;
        const extractionKey = await _keyFor(pairMeta?.compareUrl ?? compareSide.url);
        await storage.saveReport({
          ...compareSide,
          bulkJobId:     jobId,
          extractionKey: extractionKey ?? undefined,
        });
      }
    }

    const slim = payload.comparisonResult ?? null;
    if (slim && typeof storage.saveComparison === 'function') {
      comparisonId = slim.comparisonId
        ?? slim.meta?.id
        ?? payload.comparisonId
        ?? null;
      const baseId = slim.baselineId ?? baselineReportId;
      const compId = slim.compareId  ?? compareReportId;
      const mode   = slim.mode ?? payload.mode ?? 'dynamic';

      if (comparisonId && baseId && compId) {
        const meta = {
          id:                comparisonId,
          pairKey:           buildPairKey(baseId, compId, mode),
          baselineId:        baseId,
          compareId:         compId,
          mode,
          matching:          slim.matching          ?? null,
          summary:           slim.comparison?.summary ?? null,
          unmatchedElements: slim.unmatchedElements ?? null,
          duration:          slim.duration ?? 0,
          timestamp:         slim.completedAt ?? new Date().toISOString(),
          bulkJobId:         jobId,
          visualDiffStatus:  slim.visualDiffStatus ?? null,
          visualSessionId:   slim.sessionId ?? null,
        };
        await storage.saveComparison(meta, slim.comparison?.results ?? []);

        try {
          if (slim.visualBlobs && typeof slim.visualBlobs === 'object') {
            for (const [keyframeId, blobData] of Object.entries(slim.visualBlobs)) {
              if (blobData && blobData.buffer) {
                const u8 = blobData.buffer instanceof Uint8Array
                  ? blobData.buffer
                  : new Uint8Array(blobData.buffer);
                const blob = new Blob([u8], { type: blobData.mimeType || 'image/webp' });
                await storage.saveVisualBlob(`${comparisonId}:${keyframeId}`, blob, comparisonId);
              }
            }
          }
          if (Array.isArray(slim.visualKeyframes) && slim.visualKeyframes.length > 0) {
            await Promise.all(slim.visualKeyframes.map((kf) => storage.saveVisualKeyframe(kf)));
          }
          if (Array.isArray(slim.visualRectRecords) && slim.visualRectRecords.length > 0) {
            await storage.saveVisualElementRects(slim.visualRectRecords);
          }
        } catch (visualErr) {
          console.error('[bulk] visual persistence failed', visualErr);
        }
      }
    }

    const pairIdMap = jobId ? _pairIdsByJobId.get(jobId) : null;
    const pairId = payload.pairId ?? pairIdMap?.get(payload.pairIndex) ?? null;
    if (pairId && typeof storage.updateBulkPair === 'function') {
      await storage.updateBulkPair(pairId, {
        status:           'done',
        baselineReportId,
        compareReportId,
        comparisonId,
        pct:              100,
        completedAt:      Date.now(),
      });
    }

    try { await loadAndRenderReports(); } catch { void 0; }
  } catch (err) {
    console.error('[bulk] _persistPairResult failed', err);
  }
}

function _runPersistingPhaseAnimation(payload) {
  const ticks = [
    { delay:    0, pct: 95 },
    { delay:  300, pct: 97 },
    { delay:  600, pct: 99 },
    { delay:  900, pct: 100 },
  ];
  for (const tick of ticks) {
    setTimeout(() => {
      dispatch('BULK_PROGRESS', {
        jobId:     payload.jobId,
        pairIndex: payload.pairIndex,
        phase:     'persisting',
        pct:       tick.pct,
      });
    }, tick.delay);
  }
  setTimeout(() => {
    dispatch('BULK_PAIR_COMPLETED', payload);
  }, 1200);
}

export function initBulkListeners() {
  const cleaners = [];

  if (typeof api?.onBulkProgress === 'function') {
    const off = api.onBulkProgress((payload) => {
      const p = payload ?? {};
      // [BUG FIX] Persist per-pair phase to IDB on first event of a new
      // phase only (plan §13.6). The phase transition is the only
      // reconstruction unit needed for resume; intra-phase pct bumps
      // would 100× the write count for no resume benefit.
      const jobId     = p.jobId ?? null;
      const pairIndex = p.pairIndex;
      const phase     = p.phase ?? null;
      if (jobId && phase && Number.isInteger(pairIndex)) {
        const key  = `${jobId}:${pairIndex}`;
        const prev = _lastPersistedPhaseByPairKey.get(key);
        if (prev !== phase) {
          _lastPersistedPhaseByPairKey.set(key, phase);
          const pairId = _pairIdsByJobId.get(jobId)?.get(pairIndex) ?? null;
          if (pairId && typeof storage.updateBulkPair === 'function') {
            const patch = { status: phase };
            if (!prev) { patch.startedAt = Date.now(); }
            // Fire-and-forget — the write goes through the serial
            // #writeQueue (idb-repository A5.2) and is durable before
            // the next pair's events start arriving.
            void storage.updateBulkPair(pairId, patch).catch((err) => {
              console.error('[bulk] updateBulkPair phase write failed', err);
            });
          }
        }
      }
      dispatch('BULK_PROGRESS', p);
    });
    if (typeof off === 'function') { cleaners.push(off); }
  }

  if (typeof api?.onBulkPairCompleted === 'function') {
    const off = api.onBulkPairCompleted((payload) => {
      const p = payload ?? {};
      // [BUG FIX] Clear the phase-tracker entry so a future resume of
      // this same (jobId, pairIndex) — should one occur — starts fresh.
      if (p.jobId && Number.isInteger(p.pairIndex)) {
        _lastPersistedPhaseByPairKey.delete(`${p.jobId}:${p.pairIndex}`);
      }
      if (p.status === 'done') {
        _runPersistingPhaseAnimation(p);
        const persistPromise = _persistPairResult(p).finally(() => {
          if (_pendingPersistByPairIndex.get(p.pairIndex) === persistPromise) {
            _pendingPersistByPairIndex.delete(p.pairIndex);
          }
        });
        _pendingPersistByPairIndex.set(p.pairIndex, persistPromise);
      } else {
        dispatch('BULK_PAIR_COMPLETED', p);
      }
    });
    if (typeof off === 'function') { cleaners.push(off); }
  }

  if (typeof api?.onBulkJobComplete === 'function') {
    const off = api.onBulkJobComplete((payload) => {
      dispatch('BULK_JOB_COMPLETE', payload ?? {});
    });
    if (typeof off === 'function') { cleaners.push(off); }
  }

  return () => {
    for (const fn of cleaners) {
      try { fn(); } catch { void 0; }
    }
  };
}

function _blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function _getBlobKeysByComparisonId(comparisonId) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ui_comparison_db', 9);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction('visual_blobs', 'readonly');
        const index = tx.objectStore('visual_blobs').index('by_comparisonId');
        const keysReq = index.getAllKeys(IDBKeyRange.only(comparisonId));
        keysReq.onsuccess = () => { db.close(); resolve(keysReq.result ?? []); };
        keysReq.onerror = () => { db.close(); reject(keysReq.error); };
      } catch (err) {
        db.close();
        reject(err);
      }
    };
  });
}

async function ensureBlobsRegisteredForComparison(comparisonId, ctx = {}) {
  if (!comparisonId) return;
  if (typeof api?.registerBlob !== 'function') return;

  let blobKeys = [];
  try {
    blobKeys = await _getBlobKeysByComparisonId(comparisonId);
  } catch (err) {
    console.error('[bulk] getBlobKeys failed', err);
    return;
  }

  let skipSkeleton = false;
  if (ctx.includeScreenshots === false) {
    skipSkeleton = true;
  }
  const bid = ctx.baselineId ?? null;
  const cid = ctx.compareId ?? null;
  const mod = ctx.mode ?? null;
  if (bid && cid && mod) {
    try {
      const cached = await storage.loadComparisonByPair(bid, cid, mod);
      if (cached?.visualDiffStatus?.status === 'skipped') {
        skipSkeleton = true;
      }
    } catch {
      void 0;
    }
  }

  const sectionEl =
    ctx.screenshotSectionEl
    ?? document.getElementById('compare-results-screenshot-section');
  let skeletonEl = null;
  const showSkeleton = !skipSkeleton && blobKeys.length > 0 && sectionEl;

  if (showSkeleton) {
    skeletonEl = document.createElement('div');
    skeletonEl.className = 'result-panel__screenshot-skeleton';
    skeletonEl.innerHTML = '<div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div>';
    sectionEl.replaceChildren(skeletonEl);
  }

  try {
    for (const key of blobKeys) {
      try {
        const blob = await storage.loadVisualBlob(key);
        if (!blob) continue;
        const base64 = await _blobToBase64(blob);
        await api.registerBlob({ blobId: key, base64, mimeType: blob.type || 'image/webp' });
      } catch (err) {
        console.error('[bulk] blob re-register failed for key', key, err);
      }
    }
  } finally {
    if (skeletonEl?.parentNode) {
      skeletonEl.remove();
    }
  }
}

export async function routeBulkPairOpenClick(pairIndex) {
  const pendingPersist = _pendingPersistByPairIndex.get(pairIndex);
  if (pendingPersist) {
    try { await pendingPersist; } catch { void 0; }
  }

  const state = getState();
  const pair = state.bulkJob?.pairs?.[pairIndex];
  if (!pair) {
    Toast.show('Pair not found in current job state.', 'warning');
    return;
  }
  if (!pair.baselineReportId || !pair.compareReportId || !pair.comparisonId) {
    Toast.show('This pair has no completed comparison to open.', 'warning');
    return;
  }

  const { baselineReportId, compareReportId, comparisonId, mode } = pair;

  const rowEl = document.querySelector(`.bulk-row[data-pair-index="${pairIndex}"]`);
  if (rowEl) rowEl.classList.add('bulk-row--loading');

  dispatch('BULK_PAIR_OPEN', { pairIndex });

  try {
    await ensureBlobsRegisteredForComparison(comparisonId, {
      baselineId:         baselineReportId,
      compareId:          compareReportId,
      mode:               mode ?? 'dynamic',
      includeScreenshots: pair.includeScreenshots !== false,
      screenshotSectionEl: document.getElementById('bulk-results-screenshot-section'),
    });

    const loaded = await loadComparisonFromCacheByPairIds(
      baselineReportId,
      compareReportId,
      mode ?? 'dynamic'
    );
    if (!loaded) {
      Toast.show('Could not load comparison for this pair.', 'warning');
      dispatch('BULK_ACTIVE_PAIR_CLEAR', {});
      return;
    }
    dispatch('BULK_PAIR_VIEWER_READY', loaded);
    const area = document.getElementById('bulk-result-area');
    if (area) {
      requestAnimationFrame(() => {
        area.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    }
  } finally {
    if (rowEl) rowEl.classList.remove('bulk-row--loading');
  }
}

export async function routeBulkExportClick() {
  const snapshot = getState();
  const job = snapshot.bulkJob;

  const TERMINAL_STATUSES = new Set(['completed', 'partial', 'failed', 'cancelled']);
  if (!job || !TERMINAL_STATUSES.has(job.status)) {
    Toast.show('No completed bulk job to export.', 'warning');
    return;
  }

  const pairs  = job.pairs ?? [];
  const reports = snapshot.reports ?? [];

  const BATCH = 5;
  const enrichedPairs = new Array(pairs.length);

  for (let start = 0; start < pairs.length; start += BATCH) {
    const slice = pairs.slice(start, start + BATCH);
    await Promise.all(slice.map(async (pair, offset) => {
      const idx = start + offset;
      let comparisonResult = null;
      let baselineReport   = null;
      let compareReport    = null;

      if (pair.status === 'done') {
        try {
          if (pair.baselineReportId && pair.compareReportId && pair.mode) {
            comparisonResult = await storage.loadComparisonByPair(
              pair.baselineReportId,
              pair.compareReportId,
              pair.mode
            );
          }
        } catch { void 0; }

        baselineReport = reports.find((r) => r.id === pair.baselineReportId) ?? null;
        compareReport  = reports.find((r) => r.id === pair.compareReportId)  ?? null;
      }

      enrichedPairs[idx] = {
        ...pair,
        comparisonResult,
        baselineReport,
        compareReport,
      };
    }));
  }

  let buildBulkSummaryWorkbook = null;
  try {
    const mod = await import('@core/export/bulk-summary-exporter.js');
    buildBulkSummaryWorkbook = mod?.buildBulkSummaryWorkbook ?? null;
  } catch { void 0; }

  if (typeof buildBulkSummaryWorkbook !== 'function') {
    Toast.show('Summary exporter not available in this build.', 'warning');
    return;
  }

  const invalidRows = (snapshot.bulkParsedRows ?? []).filter((r) => r && r.valid === false);

  try {
    const uint8Array = buildBulkSummaryWorkbook(job, enrichedPairs, invalidRows);
    const baseName   = (job.filename ?? 'bulk').replace(/\.xlsx?$/i, '');
    const filename   = `${baseName}-bulk-summary.xlsx`;

    if (typeof api?.exportFile === 'function') {
      const res = await api.exportFile({ format: 'xlsx', data: Array.from(uint8Array), filename });
      if (res?.success) {
        Toast.show('Bulk summary exported.', 'success');
      } else if (res?.reason !== 'cancelled') {
        Toast.show(`Export failed: ${res?.error ?? 'Unknown error'}`, 'error');
      }
    } else {
      const blob = new Blob([uint8Array], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      Toast.show('Bulk summary exported.', 'success');
    }
  } catch (err) {
    Toast.show(`Export failed: ${err?.message ?? String(err)}`, 'error');
  }
}

const _IN_FLIGHT_PAIR_STATUSES = new Set([
  'extracting-baseline', 'extracting-compare', 'matching', 'screenshots', 'persisting',
]);

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
  ));
}

function _formatRelativeTime(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) { return null; }
  const deltaMs = Date.now() - ts;
  if (deltaMs < 0) { return 'just now'; }
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1)   { return 'just now'; }
  if (minutes < 60)  { return `${minutes} minute${minutes === 1 ? '' : 's'} ago`; }
  const hours = Math.floor(minutes / 60);
  if (hours < 24)    { return `${hours} hour${hours === 1 ? '' : 's'} ago`; }
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

async function _reconcileInFlightPairs(storedPairs) {
  const reconciled = [];
  for (const p of (storedPairs ?? [])) {
    if (!p) { continue; }
    if (_IN_FLIGHT_PAIR_STATUSES.has(p.status)) {
      try {
        await storage.updateBulkPair(p.id, {
          status:    'failed',
          errorCode: 'INTERRUPTED',
          error:     'Interrupted by app restart',
        });
      } catch { void 0; }
      reconciled.push({
        ...p,
        status:    'failed',
        errorCode: 'INTERRUPTED',
        error:     'Interrupted by app restart',
      });
    } else {
      reconciled.push(p);
    }
  }
  return reconciled;
}

function _isIncompletePair(p) {
  if (!p) { return false; }
  if (p.status === 'queued') { return true; }
  if (p.status === 'failed' && p.errorCode === 'INTERRUPTED') { return true; }
  return false;
}

export async function detectAndOfferResume() {
  let allJobs = [];
  try {
    allJobs = await storage.loadAllBulkJobs();
  } catch (err) {
    console.error('[bulk] loadAllBulkJobs failed during resume detection', err);
    return;
  }

  const runningJobs = (allJobs ?? []).filter((j) => j && j.status === 'running');
  if (runningJobs.length === 0) { return; }

  const sorted = [...runningJobs].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const chosen = sorted[0];
  const older  = sorted.slice(1);
  for (const oldJob of older) {
    console.warn('[bulk] multiple interrupted jobs detected — marking older as failed', {
      jobId: oldJob.id, createdAt: oldJob.createdAt,
    });
    try {
      await storage.updateBulkJob(oldJob.id, { status: 'failed' });
    } catch { void 0; }
  }

  let storedPairs = [];
  try {
    storedPairs = await storage.loadBulkPairsByJob(chosen.id);
  } catch (err) {
    console.error('[bulk] loadBulkPairsByJob failed', err);
  }

  const reconciledPairs = await _reconcileInFlightPairs(storedPairs);
  reconciledPairs.sort((a, b) => (a.pairIndex ?? 0) - (b.pairIndex ?? 0));

  const completedCount  = reconciledPairs.filter((p) => p.status === 'done').length;
  const incompleteCount = reconciledPairs.filter(_isIncompletePair).length;
  const failedCount     = reconciledPairs.filter((p) =>
    p.status === 'failed' && p.errorCode !== 'INTERRUPTED'
  ).length + reconciledPairs.filter((p) => p.status === 'cancelled').length;

  if (incompleteCount === 0) {
    const finalStatus = failedCount > 0 ? 'partial' : 'completed';
    try {
      await storage.updateBulkJob(chosen.id, { status: finalStatus, completedAt: Date.now() });
    } catch { void 0; }
    return;
  }

  const totalPairs = chosen.totalPairs ?? reconciledPairs.length;
  const jobForState = {
    jobId:           chosen.id,
    filename:        chosen.filename ?? '',
    status:          'parsed',
    totalPairs,
    concurrency:     chosen.concurrency    ?? 2,
    hostCooldownMs:  chosen.hostCooldownMs ?? 0,
    pairs:           reconciledPairs,
    summary:         chosen.summary ?? null,
    startedAt:       chosen.startedAt ?? null,
    completedAt:     null,
    activePairIndex: null,
  };

  dispatch('BULK_JOB_RESUME_OFFERED', {
    job:            jobForState,
    completedCount,
    totalCount:     totalPairs,
  });

  _renderResumeBanner(jobForState, reconciledPairs, completedCount, totalPairs);
}

function _renderResumeBanner(job, reconciledPairs, completedCount, totalPairs) {
  const slot = document.getElementById('bulk-resume-banner-slot');
  if (!slot) { return; }
  slot.innerHTML = '';

  const incompletePairs = reconciledPairs.filter(_isIncompletePair).sort(
    (a, b) => (a.pairIndex ?? 0) - (b.pairIndex ?? 0)
  );
  const firstIncompleteIndex = incompletePairs[0]?.pairIndex ?? 0;
  const relativeTime         = _formatRelativeTime(job.startedAt) ?? 'recently';
  const filename             = job.filename || 'untitled';

  const banner = document.createElement('div');
  banner.className = 'bulk-resume-banner';
  banner.setAttribute('role', 'status');
  banner.innerHTML = `
    <div class="bulk-resume-banner__text">
      <div class="bulk-resume-banner__title">
        ⚠ A bulk run was interrupted — ${completedCount} of ${totalPairs} pairs completed.
      </div>
      <div class="bulk-resume-banner__meta">
        File: ${_esc(filename)} · Started ${_esc(relativeTime)}
      </div>
    </div>
    <div class="bulk-resume-banner__actions">
      <button type="button" class="btn-primary   btn-sm" id="bulk-resume-btn">
        Resume from pair ${firstIncompleteIndex + 1}
      </button>
      <button type="button" class="btn-secondary btn-sm" id="bulk-resume-view-btn">
        View partial results
      </button>
      <button type="button" class="btn-ghost     btn-sm" id="bulk-resume-discard-btn">
        Discard
      </button>
    </div>
  `;
  slot.appendChild(banner);

  const close = () => { try { slot.innerHTML = ''; } catch { void 0; } };

  banner.querySelector('#bulk-resume-btn')?.addEventListener('click', async () => {
    close();
    await _handleResumeAccepted(job, incompletePairs);
  });

  banner.querySelector('#bulk-resume-view-btn')?.addEventListener('click', async () => {
    close();
    try {
      await storage.updateBulkJob(job.jobId, { status: 'partial', completedAt: Date.now() });
    } catch { void 0; }
    dispatch('BULK_JOB_RESUME_DECLINED', { jobId: job.jobId, cascade: false });
  });

  banner.querySelector('#bulk-resume-discard-btn')?.addEventListener('click', async () => {
    close();
    try {
      await storage.deleteBulkJobCascade(job.jobId);
    } catch (err) {
      console.error('[bulk] deleteBulkJobCascade failed', err);
    }
    _pairIdsByJobId.delete(job.jobId);
    _pairMetaByJobId.delete(job.jobId);
    dispatch('BULK_JOB_RESUME_DECLINED', { jobId: job.jobId, cascade: true });
  });
}

async function _handleResumeAccepted(job, incompletePairs) {
  const incompleteWithIds = incompletePairs.map((p) => ({
    ...p,
    comparisonId: _newId(),
    dedupedSides: {},
  }));
  const incompletePairIndexes    = incompleteWithIds.map((p) => p.pairIndex);
  const comparisonIdsByPairIndex = {};
  for (const p of incompleteWithIds) {
    comparisonIdsByPairIndex[p.pairIndex] = p.comparisonId;
  }

  const totalMemMB    = await _hostTotalMemMB();
  const heterogeneous = _planIsHeterogeneous(incompleteWithIds, getState().selectedBrowser);
  const safeConcurrency = _clampConcurrency(job.concurrency ?? 2, totalMemMB, heterogeneous);

  const resumeSpec = {
    jobId:                    job.jobId,
    filename:                 job.filename ?? '',
    pairs:                    incompleteWithIds,
    concurrency:              safeConcurrency,
    hostCooldownMs:           job.hostCooldownMs ?? 0,
    comparisonIdsByPairIndex,
    resumed:                  true,
  };

  _rememberPairMeta(job.jobId, incompleteWithIds);

  // [BUG FIX] Resume path also needs the pairIndex→pairId map populated
  // so the onBulkProgress phase-persistence write (plan §13.6) can find
  // the stored row to update. Without this, resumed pairs go through
  // their phases without ever updating STORE_BULK_PAIRS, defeating
  // resumability if the resumed run itself crashes.
  const resumedIdMap = new Map();
  for (const p of incompleteWithIds) {
    if (p.id != null) { resumedIdMap.set(p.pairIndex, p.id); }
  }
  _pairIdsByJobId.set(job.jobId, resumedIdMap);

  try {
    await storage.updateBulkJob(job.jobId, { status: 'running', resumedAt: Date.now() });
  } catch { void 0; }

  dispatch('BULK_JOB_RESUME_ACCEPTED', { jobId: job.jobId, incompletePairIndexes });

  if (typeof api?.startBulkJob !== 'function') {
    Toast.show('Bulk runner unavailable in this build.', 'error');
    dispatch('BULK_JOB_CANCELLED');
    return;
  }

  try {
    const result = await api.startBulkJob(resumeSpec);
    if (!result || result.success === false) {
      dispatch('BULK_JOB_CANCELLED');
      Toast.show(result?.error ?? 'Failed to resume bulk job', 'error');
    }
  } catch (err) {
    dispatch('BULK_JOB_CANCELLED');
    Toast.show(err?.message ?? String(err), 'error');
  }
}

// ---------------------------------------------------------------------------
// Bulk Download All Results — per-pair HTML / JSON / CSV to a chosen folder.
//
// Architecture (see SYSTEM_REFERENCE §1, §3, §10):
//   • Per-pair data assembly (loadComparisonByPair → loadComparisonDiffs →
//     visualDiffs rebuild) runs in the renderer because IDB lives in
//     infrastructure/ which is renderer-only. This reuses
//     loadComparisonFromCacheByPairIds from compare-workflow.js so the
//     normalized result shape exactly matches what the existing core/
//     exporters expect.
//   • Format serialisation runs in the renderer via the existing
//     core/export/comparison-exporters/*. HTML inline-embeds visual blobs
//     as data-URIs (html-exporter.js loadBlobData), so the IPC payload is
//     a single self-contained string for all three formats.
//   • Filesystem writes run in main via EXPORT_FILE_TO_DIRECTORY (one IPC
//     per file, no save dialog — folder is chosen once via PICK_DIRECTORY).
//
// Concurrency: serial pair loop with a setTimeout(0) yield between pairs
// to keep the renderer responsive at 500-pair scale and to bound peak
// memory to one decoded pair at a time (HTML payloads can include ~10 MB
// of base64-encoded blobs).
// ---------------------------------------------------------------------------

const VALID_DOWNLOAD_ALL_FORMATS = new Set(['html', 'json', 'csv']);

const _downloadAllState = {
  running:    false,
  cancelled:  false,
  current:    0,
  total:      0,
  succeeded:  0,
  failed:     0,
  format:     null,
  listeners:  new Set(),
};

function _emitDownloadAllProgress() {
  for (const fn of _downloadAllState.listeners) {
    try { fn({
      running:   _downloadAllState.running,
      current:   _downloadAllState.current,
      total:     _downloadAllState.total,
      succeeded: _downloadAllState.succeeded,
      failed:    _downloadAllState.failed,
      format:    _downloadAllState.format,
    }); } catch { void 0; }
  }
}

export function subscribeBulkDownloadAllProgress(fn) {
  if (typeof fn !== 'function') { return () => {}; }
  _downloadAllState.listeners.add(fn);
  return () => { _downloadAllState.listeners.delete(fn); };
}

export function isBulkDownloadAllRunning() { return _downloadAllState.running; }

export function routeBulkDownloadAllCancelClick() {
  if (!_downloadAllState.running) { return; }
  _downloadAllState.cancelled = true;
}

function _padIndex(i, width) {
  return String(i + 1).padStart(width, '0');
}

function _filenameLabel(pair) {
  const fromLabel = pair.label ? sanitizeFilename(pair.label) : '';
  if (fromLabel && fromLabel !== 'export') { return fromLabel; }
  const host = sanitizeFilename(hostFromUrl(pair.compareUrl ?? pair.baselineUrl ?? ''));
  return host || 'pair';
}

async function _serialisePair(pair, format) {
  const loaded = await loadComparisonFromCacheByPairIds(
    pair.baselineReportId,
    pair.compareReportId,
    pair.mode ?? 'dynamic',
  );
  if (!loaded?.result) { return null; }
  const result = loaded.result;
  if (format === 'html') {
    return { content: await exportToHTML(result), encoding: 'utf8' };
  }
  if (format === 'json') {
    return { content: JSON.stringify(buildComparisonJsonPayload(result), null, 2), encoding: 'utf8' };
  }
  if (format === 'csv') {
    return { content: buildComparisonCsv(result), encoding: 'utf8' };
  }
  return null;
}

export async function routeBulkDownloadAllResultsClick(format) {
  if (_downloadAllState.running) {
    Toast.show('A download is already running.', 'warning');
    return;
  }
  if (!VALID_DOWNLOAD_ALL_FORMATS.has(format)) {
    Toast.show(`Unsupported format: ${format}`, 'error');
    return;
  }

  const job = getState().bulkJob;
  const TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled']);
  if (!job || !TERMINAL.has(job.status)) {
    Toast.show('No completed bulk job to export.', 'warning');
    return;
  }

  const exportablePairs = (job.pairs ?? []).filter((p) =>
    p && p.status === 'done' && p.baselineReportId && p.compareReportId && p.comparisonId
  );
  if (exportablePairs.length === 0) {
    Toast.show('No completed pairs to export.', 'warning');
    return;
  }

  if (typeof api?.pickDirectory !== 'function' || typeof api?.exportFileToDirectory !== 'function') {
    Toast.show('Folder export unavailable in this build.', 'error');
    return;
  }

  const pick = await api.pickDirectory({ title: `Export ${exportablePairs.length} pairs as ${format.toUpperCase()}` });
  if (!pick?.success) {
    if (pick?.reason !== 'cancelled') { Toast.show(pick?.error ?? 'Folder selection failed', 'error'); }
    return;
  }
  const dirPath = pick.dirPath;

  const ext = format;
  const padWidth = String(exportablePairs.length).length;

  _downloadAllState.running   = true;
  _downloadAllState.cancelled = false;
  _downloadAllState.current   = 0;
  _downloadAllState.total     = exportablePairs.length;
  _downloadAllState.succeeded = 0;
  _downloadAllState.failed    = 0;
  _downloadAllState.format    = format;
  _emitDownloadAllProgress();

  try {
    for (let i = 0; i < exportablePairs.length; i++) {
      if (_downloadAllState.cancelled) { break; }
      const pair = exportablePairs[i];
      _downloadAllState.current = i + 1;
      _emitDownloadAllProgress();

      const filename = `${_padIndex(pair.pairIndex, padWidth)}-${_filenameLabel(pair)}.${ext}`;
      try {
        const serialised = await _serialisePair(pair, format);
        if (!serialised) {
          _downloadAllState.failed++;
          console.warn('[bulk-download-all] skip — could not load comparison', { pairIndex: pair.pairIndex });
        } else {
          const res = await api.exportFileToDirectory({
            dirPath,
            filename,
            content:  serialised.content,
            encoding: serialised.encoding,
          });
          if (res?.success) {
            _downloadAllState.succeeded++;
          } else {
            _downloadAllState.failed++;
            console.error('[bulk-download-all] write failed', { filename, error: res?.error });
          }
        }
      } catch (err) {
        _downloadAllState.failed++;
        console.error('[bulk-download-all] serialise failed', { pairIndex: pair.pairIndex, err: err?.message });
      }

      _emitDownloadAllProgress();

      // Yield to the macrotask queue so paint, scroll, and the cancel
      // button event fire between pairs. setTimeout(0) (not microtask
      // await) is the minimum that lets the event loop turn over.
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    const { succeeded, failed, cancelled } = {
      succeeded: _downloadAllState.succeeded,
      failed:    _downloadAllState.failed,
      cancelled: _downloadAllState.cancelled,
    };
    _downloadAllState.running   = false;
    _downloadAllState.cancelled = false;
    _downloadAllState.format    = null;
    _emitDownloadAllProgress();

    if (cancelled) {
      Toast.show(`Export cancelled — ${succeeded} of ${_downloadAllState.total} written.`, 'warning');
    } else if (failed === 0) {
      Toast.show(`Exported ${succeeded} files to ${dirPath}.`, 'success');
    } else {
      Toast.show(`Exported ${succeeded} files; ${failed} failed. See console for details.`, 'warning');
    }
  }
}

export async function routeBulkDownloadTemplateClick() {
  let buildBulkTemplateWorkbook = null;
  try {
    const mod = await import('@core/export/bulk-summary-exporter.js');
    buildBulkTemplateWorkbook = mod?.buildBulkTemplateWorkbook ?? null;
  } catch { void 0; }

  if (typeof buildBulkTemplateWorkbook !== 'function') {
    Toast.show('Template generator not available in this build.', 'warning');
    return;
  }

  try {
    const data = buildBulkTemplateWorkbook();
    if (typeof api?.exportFile === 'function') {
      await api.exportFile({ data, filename: 'bulk-template.xlsx', format: 'xlsx' });
    } else {
      const blob = new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'bulk-template.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  } catch (err) {
    Toast.show(`Template download failed: ${err?.message ?? err}`, 'error');
  }
}
