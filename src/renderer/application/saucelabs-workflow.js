'use strict';

import { dispatch, getState } from '../state.js';
import storage, { buildPairKey } from '../../infrastructure/idb-repository.js';
import { loadAndRenderReports } from './report-manager.js';
import { loadComparisonFromCacheByPairIds } from './compare-workflow.js';
import { Comparator } from '@core/comparison/comparator.js';
import {
  buildCompareHpidRemap,
  computeDiffKeyframeIds,
  buildSauceRectRecords
} from '@core/saucelabs-bridge/visual-records.js';
import {
  SchemaValidationError,
  validateScreenshotsManifest,
  validateExtractionResult
} from '@core/saucelabs-bridge/schemas.js';
import {
  PhaseTimer,
  PersistenceTally,
  OUTCOME
} from '@core/saucelabs-bridge/metrics.js';
import {
  SIDE,
  DEFAULT_SAUCE_COMPARISON_MODE,
  oppositeSide
} from '@core/saucelabs-bridge/constants.js';

const api = window.electronAPI;

let _creds = null;
let _progressUnsub = null;
let _completeUnsub = null;

export function getCredentials() {
  return _creds;
}

export function clearCredentials() {
  _creds = null;
  dispatch('SAUCE_CREDENTIAL_RESET');
}

export async function validateAndStoreCredentials({ username, accessKey, region }) {
  dispatch('SAUCE_CREDENTIAL_VALIDATING');

  if (!username || !accessKey) {
    dispatch('SAUCE_CREDENTIAL_FAILED', { error: 'Username and access key are required' });
    return false;
  }

  if (typeof api?.sauceValidateCredentials !== 'function') {
    dispatch('SAUCE_CREDENTIAL_FAILED', { error: 'SauceLabs integration unavailable in this build' });
    return false;
  }

  let result;
  try {
    result = await api.sauceValidateCredentials({ username, accessKey, region });
  } catch (err) {
    dispatch('SAUCE_CREDENTIAL_FAILED', { error: err?.message ?? 'Validation request failed' });
    return false;
  }

  if (!result || result.success === false) {
    dispatch('SAUCE_CREDENTIAL_FAILED', { error: result?.error ?? 'Validation failed' });
    return false;
  }

  _creds = { username, accessKey, region };
  dispatch('SAUCE_CREDENTIAL_VALID');

  void _resumeInFlightJobs();

  return true;
}

export function initSauceListeners() {
  if (_progressUnsub) _progressUnsub();
  if (_completeUnsub) _completeUnsub();

  if (typeof api?.onSauceJobProgress === 'function') {
    _progressUnsub = api.onSauceJobProgress((data) => {
      dispatch('SAUCE_JOB_PROGRESS', data);

      if (data.baselineSessionId || data.compareSessionId) {
        _updateJobSessionIds(data);
      }
    });
  }

  if (typeof api?.onSauceJobComplete === 'function') {
    _completeUnsub = api.onSauceJobComplete(async (data) => {
      if (data.success && data.baselineReport && data.compareReport) {
        await _handleComparisonComplete(data);
      } else if (data.success && data.report) {
        await _handleExtractionComplete(data);
      } else if (data.partiallyFailed) {
        _handlePartialFailure(data);
      } else {
        dispatch('SAUCE_JOB_FAILED', { error: data.error || 'Job failed' });
        _updateJobStatus(data.jobId, 'failed', { error: data.error });
      }
    });
  }
}

export async function submitExtraction({ url, platform, browserName, screenResolution, tunnelName, filters, device }) {
  if (!_creds) {
    dispatch('SAUCE_JOB_FAILED', { error: 'Credentials not available — validate first', url });
    return null;
  }

  if (typeof api?.sauceSubmitJob !== 'function') {
    dispatch('SAUCE_JOB_FAILED', { error: 'SauceLabs integration unavailable in this build', url });
    return null;
  }

  let result;
  try {
    result = await api.sauceSubmitJob({
      username: _creds.username,
      accessKey: _creds.accessKey,
      region: _creds.region,
      url,
      platform,
      browserName,
      screenResolution,
      tunnelName: tunnelName || null,
      filters: filters || null,
      device: device || null
    });
  } catch (err) {
    dispatch('SAUCE_JOB_FAILED', { error: err?.message || 'Submission request failed', url, platform, browserName });
    return null;
  }

  if (!result || !result.success) {
    dispatch('SAUCE_JOB_FAILED', { error: result?.error || 'Submission failed', url, platform, browserName });
    return null;
  }



  const extractionJobRecord = {
    id: result.jobId,
    status: 'submitted',
    baselineStatus: null,
    compareStatus: null,
    partiallyFailedSession: null,
    url,
    baselineUrl: null,
    compareUrl: null,
    platform,
    browserName,
    screenResolution,
    region: _creds.region,
    tunnelName: tunnelName || null,
    filters: filters || null,
    device: device || null,
    baselineSessionId: null,
    compareSessionId: null,
    sessionId: null,
    baselineArtifactDir: null,
    compareArtifactDir: null,
    artifactsDir: null,
    comparisonId: null,
    baselineReportId: null,
    compareReportId: null,
    reportId: null,
    kind: 'extraction',
    error: null,
    createdAt: Date.now(),
    completedAt: null,
    lastPolledAt: null
  };

  try {
    if (typeof storage.saveSauceJob === 'function') {
      await storage.saveSauceJob(extractionJobRecord);
    }
  } catch (err) {
    console.error('[sauce-workflow] saveSauceJob (extraction) failed', err);
    dispatch('SAUCE_PERSIST_WARNING', {
      message: `Job state could not be saved (${err?.message || 'IDB error'}). Resume-after-restart is unavailable for this job.`
    });
  }

  dispatch('SAUCE_JOB_SUBMITTED', {
    job: {
      jobId: result.jobId,
      status: 'submitted',
      url,
      platform,
      browserName,
      screenResolution,
      submittedAt: Date.now()
    }
  });

  return result.jobId;
}

export async function submitComparison({ baselineUrl, compareUrl, platform, browserName, screenResolution, tunnelName, filters, device }) {
  if (!_creds) {
    dispatch('SAUCE_JOB_FAILED', { error: 'Credentials not available — validate first', baselineUrl, compareUrl });
    return null;
  }

  if (typeof api?.sauceSubmitComparison !== 'function') {
    dispatch('SAUCE_JOB_FAILED', { error: 'SauceLabs integration unavailable in this build', baselineUrl, compareUrl });
    return null;
  }

  let result;
  try {
    result = await api.sauceSubmitComparison({
      username: _creds.username,
      accessKey: _creds.accessKey,
      region: _creds.region,
      baselineUrl,
      compareUrl,
      platform,
      browserName,
      screenResolution,
      tunnelName: tunnelName || null,
      filters: filters || null,
      device: device || null
    });
  } catch (err) {
    dispatch('SAUCE_JOB_FAILED', { error: err?.message || 'Submission request failed', baselineUrl, compareUrl, platform, browserName });
    return null;
  }

  if (!result || !result.success) {
    dispatch('SAUCE_JOB_FAILED', { error: result?.error || 'Submission failed', baselineUrl, compareUrl, platform, browserName });
    return null;
  }

  const jobRecord = {
    id: result.jobId,
    status: 'submitted',
    baselineStatus: 'submitted',
    compareStatus: 'submitted',
    partiallyFailedSession: null,
    baselineUrl,
    compareUrl,
    platform,
    browserName,
    screenResolution,
    region: _creds.region,
    tunnelName: tunnelName || null,
    filters: filters || null,
    device: device || null,
    baselineSessionId: null,
    compareSessionId: null,
    baselineArtifactDir: null,
    compareArtifactDir: null,
    comparisonId: null,
    baselineReportId: null,
    compareReportId: null,
    kind: 'comparison',
    error: null,
    createdAt: Date.now(),
    completedAt: null,
    lastPolledAt: null,
    baselinePollStartedAt: null,
    comparePollStartedAt: null
  };

  try {
    await storage.saveSauceJob(jobRecord);
  } catch (err) {
    console.error('[sauce-workflow] saveSauceJob (comparison) failed', err);
    dispatch('SAUCE_PERSIST_WARNING', {
      message: `Job state could not be saved (${err?.message || 'IDB error'}). Resume-after-restart is unavailable for this job.`
    });
  }

  dispatch('SAUCE_COMPARISON_SUBMITTED', {
    job: {
      jobId: result.jobId,
      baselineUrl,
      compareUrl,
      platform,
      browserName,
      screenResolution
    }
  });

  return result.jobId;
}

export async function cancelSauceJob() {
  const state = getState();
  const job = state.sauceJob;
  if (!job?.jobId) return;

  dispatch('SAUCE_JOB_CANCELLED');

  if (typeof api?.sauceCancelJob === 'function' && _creds) {
    try {
      await api.sauceCancelJob({
        jobId: job.jobId,
        username: _creds.username,
        accessKey: _creds.accessKey,
        region: _creds.region,
        baselineSessionId: job.baselineSessionId ?? null,
        compareSessionId: job.compareSessionId ?? null
      });
    } catch {
      void 0;
    }
  }

  await _updateJobStatus(job.jobId, 'cancelled', { completedAt: Date.now() });
}

export async function detectAndResumeSauceJobs() {
  if (typeof storage.loadSauceJobsByStatus !== 'function') return;

  let inFlight = [];
  try {
    inFlight = await storage.loadSauceJobsByStatus([
    'submitted', 'running', 'downloading', 'comparing', 'partially_failed']
    );
  } catch (err) {
    console.error('[sauce-workflow] loadSauceJobsByStatus failed', err);
    return;
  }

  if (inFlight.length === 0) return;

  dispatch('SAUCE_CREDENTIALS_REQUIRED', { count: inFlight.length });

  const mostRecent = inFlight.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
  dispatch('SAUCE_JOB_LOADED', {
    job: {
      jobId: mostRecent.id,
      status: mostRecent.status,
      baselineUrl: mostRecent.baselineUrl,
      compareUrl: mostRecent.compareUrl,
      platform: mostRecent.platform,
      browserName: mostRecent.browserName,
      screenResolution: mostRecent.screenResolution,
      baselineSessionId: mostRecent.baselineSessionId,
      compareSessionId: mostRecent.compareSessionId,
      baselineStatus: mostRecent.baselineStatus,
      compareStatus: mostRecent.compareStatus,
      partiallyFailedSession: mostRecent.partiallyFailedSession,
      error: mostRecent.error,
      credentialsRequired: true
    }
  });
}

export async function retrySauceJob(jobId) {
  if (!_creds) {
    dispatch('SAUCE_JOB_FAILED', { error: 'Credentials not available — validate first' });
    return null;
  }

  if (typeof api?.sauceRetryFailedSession !== 'function') {
    dispatch('SAUCE_JOB_FAILED', { error: 'Retry unavailable in this build' });
    return null;
  }

  let storedJob = null;
  try {
    storedJob = await storage.loadSauceJob(jobId);
  } catch (err) {
    console.error('[sauce-workflow] loadSauceJob failed', err);
  }

  if (!storedJob || storedJob.status !== 'partially_failed' || !storedJob.partiallyFailedSession) {
    dispatch('SAUCE_JOB_FAILED', { error: 'Job is not in a retryable state' });
    return null;
  }

  const failedSide = storedJob.partiallyFailedSession;
  const successSide = oppositeSide(failedSide);
  const failedSideUrl = failedSide === SIDE.BASELINE ? storedJob.baselineUrl : storedJob.compareUrl;
  const successSideSessionId = successSide === SIDE.BASELINE ?
  storedJob.baselineSessionId :
  storedJob.compareSessionId;

  dispatch('SAUCE_JOB_PROGRESS', { jobId, phase: 'running', status: 'running' });

  await _updateJobStatus(jobId, 'running', {
    partiallyFailedSession: null,
    [`${failedSide}Status`]: 'submitted'
  });

  let result;
  try {
    result = await api.sauceRetryFailedSession({
      username: _creds.username,
      accessKey: _creds.accessKey,
      region: _creds.region,
      jobId,
      failedSide,
      failedSideUrl,
      successSideSessionId,
      platform: storedJob.platform,
      browserName: storedJob.browserName,
      screenResolution: storedJob.screenResolution,
      tunnelName: storedJob.tunnelName || null,
      filters: storedJob.filters ?? null,
      device: storedJob.device ?? null
    });
  } catch (err) {
    dispatch('SAUCE_JOB_FAILED', { error: err?.message || 'Retry request failed', jobId });
    return null;
  }

  if (!result || !result.success) {
    dispatch('SAUCE_JOB_FAILED', { error: result?.error || 'Retry submission failed', jobId });
    return null;
  }

  return result.jobId;
}

export function resetSauceJob() {
  dispatch('SAUCE_JOB_RESET');
}

export async function loadSauceComparisonResult(jobId) {
  if (!jobId) return null;
  let storedJob = null;
  try {
    storedJob = await storage.loadSauceJob(jobId);
  } catch (err) {
    console.error('[sauce-workflow] loadSauceJob failed', err);
    return null;
  }
  if (!storedJob || storedJob.kind !== 'comparison') return null;
  if (!storedJob.baselineReportId || !storedJob.compareReportId) return null;

  try {
    const loaded = await loadComparisonFromCacheByPairIds(
      storedJob.baselineReportId,
      storedJob.compareReportId,
      DEFAULT_SAUCE_COMPARISON_MODE
    );
    if (!loaded) return null;
    dispatch('SAUCE_COMPARISON_RESULT', {
      jobId,
      comparisonId: storedJob.comparisonId ?? loaded.result.id,
      result: loaded.result,
      cachedAt: loaded.cachedAt,
      fromCache: true
    });
    return loaded.result;
  } catch (err) {
    console.error('[sauce-workflow] loadSauceComparisonResult failed', err);
    return null;
  }
}

async function _resumeInFlightJobs() {
  if (typeof storage.loadSauceJobsByStatus !== 'function') return;

  let inFlight = [];
  try {
    inFlight = await storage.loadSauceJobsByStatus([
    'submitted', 'running', 'downloading', 'comparing']
    );
  } catch {
    return;
  }

  if (inFlight.length === 0) return;

  const job = inFlight.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];

  dispatch('SAUCE_JOB_LOADED', {
    job: {
      jobId: job.id,
      status: job.status,
      baselineUrl: job.baselineUrl,
      compareUrl: job.compareUrl,
      platform: job.platform,
      browserName: job.browserName,
      screenResolution: job.screenResolution,
      baselineSessionId: job.baselineSessionId,
      compareSessionId: job.compareSessionId,
      baselineStatus: job.baselineStatus,
      compareStatus: job.compareStatus,
      error: null,
      credentialsRequired: false
    }
  });
}

async function _handleExtractionComplete(data) {
  if (!_validateBoundary({
    label: 'extraction',
    jobId: data.jobId,
    extractionResult: data.report
  })) return;

  try {
    await _persistReport(data.report);
  } catch (err) {
    console.error('[sauce-workflow] report persistence failed', err);
  }
  dispatch('SAUCE_JOB_COMPLETE', {
    reportId: data.report.id,
    sessionId: data.sessionId
  });
}

function _validateBoundary({ label, jobId, extractionResult, manifest, manifestSide }) {
  const issues = [];

  if (extractionResult !== undefined) {
    try {
      validateExtractionResult(extractionResult, `${label} extraction-result.json`);
    } catch (err) {
      if (err instanceof SchemaValidationError) issues.push(err);
      else throw err;
    }
  }

  if (manifest !== undefined) {
    try {
      validateScreenshotsManifest(manifest, `${manifestSide ?? label} screenshots-manifest.json`);
    } catch (err) {
      if (err instanceof SchemaValidationError) issues.push(err);
      else throw err;
    }
  }

  if (issues.length === 0) return true;

  const summary = issues.map((i) => i.message).join('\n\n');
  console.error('[sauce-workflow] boundary schema validation failed', {
    jobId,
    issues: issues.flatMap((i) => i.errors.map((e) => ({ label: i.label, ...e })))
  });
  dispatch('SAUCE_JOB_FAILED', {
    jobId,
    error: `SauceLabs returned a payload this build cannot consume:\n${summary}`
  });
  if (jobId) {
    void _updateJobStatus(jobId, 'failed', {
      error: `Schema validation failed: ${issues[0].message.split('\n')[0]}`,
      completedAt: Date.now()
    });
  }
  return false;
}

async function _handleComparisonComplete(data) {
  const { baselineReport, compareReport, baselineManifest, compareManifest, jobId } = data;

  if (!_validateBoundary({ label: SIDE.BASELINE, jobId, extractionResult: baselineReport, manifest: baselineManifest, manifestSide: SIDE.BASELINE })) return;
  if (!_validateBoundary({ label: SIDE.COMPARE, jobId, extractionResult: compareReport, manifest: compareManifest, manifestSide: SIDE.COMPARE })) return;

  const timer = new PhaseTimer({ jobId, logger: console, component: 'sauce-workflow' });

  try {
    await timer.time('persistReports', async () => {
      await _persistReport(baselineReport);
      await _persistReport(compareReport);
    });
  } catch (err) {
    console.error('[sauce-workflow] report persistence failed', err);
  }

  let comparisonId = null;
  let persistenceResult = null;
  try {
    const comparator = new Comparator();
    const baselineInput = { ...baselineReport, elements: baselineReport.elements ?? [] };
    const compareInput = { ...compareReport, elements: compareReport.elements ?? [] };

    let comparisonResult = null;
    await timer.time('compare', async () => {
      const gen = comparator.compare(baselineInput, compareInput, DEFAULT_SAUCE_COMPARISON_MODE);
      for await (const frame of gen) {
        if (frame.type === 'result') {
          comparisonResult = frame.payload;
        }
      }
    });

    if (comparisonResult) {
      comparisonId = crypto.randomUUID();
      const mode = DEFAULT_SAUCE_COMPARISON_MODE;
      const pairKey = buildPairKey(baselineReport.id, compareReport.id, mode);

      const diffKeyframeIds = computeDiffKeyframeIds(
        comparisonResult.comparison?.results ?? [],
        baselineManifest,
        compareManifest
      );

      const meta = {
        id: comparisonId,
        pairKey,
        baselineId: baselineReport.id,
        compareId: compareReport.id,
        mode,
        matching: comparisonResult.matching ?? null,
        summary: comparisonResult.comparison?.summary ?? null,
        unmatchedElements: comparisonResult.unmatchedElements ?? null,
        duration: comparisonResult.duration ?? 0,
        timestamp: new Date().toISOString(),
        sauceJobId: jobId,
        visualDiffStatus: null,
        visualSessionId: comparisonId
      };

      await timer.time('saveComparison', () =>
        storage.saveComparison(meta, comparisonResult.comparison?.results ?? [])
      );

      persistenceResult = await timer.time('persistVisualData', () =>
        _persistFilteredVisualData({
          jobId,
          comparisonId,
          baselineManifest,
          compareManifest,
          diffKeyframeIds,
          comparisonResults: comparisonResult.comparison?.results ?? [],
          baselineArtifactDir: data.baselineArtifactDir,
          compareArtifactDir: data.compareArtifactDir
        })
      );

      await _updateJobStatus(jobId, 'done', {
        comparisonId,
        baselineReportId: baselineReport.id,
        compareReportId: compareReport.id,
        baselineArtifactDir: data.baselineArtifactDir,
        compareArtifactDir: data.compareArtifactDir,
        completedAt: Date.now(),
        persistenceIncomplete: !!persistenceResult?.anyFailed,
        persistenceSummary: persistenceResult?.summary ?? null
      });
    }
  } catch (err) {
    console.error('[sauce-workflow] comparison failed', err);
  }

  if (persistenceResult?.anyFailed) {
    dispatch('SAUCE_PERSISTENCE_INCOMPLETE', {
      jobId,
      comparisonId,
      summary: persistenceResult.summary,
      failedSteps: persistenceResult.failedSteps,
      steps: persistenceResult.steps
    });
  }

  console.info('[sauce-workflow] handleComparisonComplete done', {
    event: 'sauce.comparison.summary',
    jobId,
    comparisonId,
    totalRendererDurationMs: timer.totalDurationMs(),
    phases: timer.snapshot(),
    persistenceIncomplete: !!persistenceResult?.anyFailed
  });

  dispatch('SAUCE_JOB_COMPLETE', {
    comparisonId,
    baselineReportId: baselineReport.id,
    compareReportId: compareReport.id
  });

  if (comparisonId && baselineReport?.id && compareReport?.id) {
    try {
      const loaded = await loadComparisonFromCacheByPairIds(
        baselineReport.id,
        compareReport.id,
        DEFAULT_SAUCE_COMPARISON_MODE
      );
      if (loaded) {
        dispatch('SAUCE_COMPARISON_RESULT', {
          jobId,
          comparisonId,
          result: loaded.result,
          cachedAt: loaded.cachedAt,
          fromCache: false
        });
      }
    } catch (err) {
      console.error('[sauce-workflow] loadComparisonFromCacheByPairIds failed', err);
    }
  }

  try {await loadAndRenderReports();} catch {void 0;}
}

function _handlePartialFailure(data) {
  dispatch('SAUCE_JOB_PARTIALLY_FAILED', {
    partiallyFailedSession: data.partiallyFailedSession,
    error: data.error
  });

  _updateJobStatus(data.jobId, 'partially_failed', {
    partiallyFailedSession: data.partiallyFailedSession,
    baselineSessionId: data.baselineSessionId,
    compareSessionId: data.compareSessionId,
    baselineStatus: data.baselineStatus,
    compareStatus: data.compareStatus,
    error: data.error
  });
}

async function _persistFilteredVisualData({
  jobId,
  comparisonId,
  baselineManifest,
  compareManifest,
  diffKeyframeIds,
  comparisonResults,
  baselineArtifactDir,
  compareArtifactDir
}) {
  const tally = new PersistenceTally({ jobId, logger: console, component: 'sauce-workflow' });
  if (!diffKeyframeIds || diffKeyframeIds.size === 0) return tally.finalize();

  const sessionId = comparisonId;

  const compareHpidRemap = buildCompareHpidRemap(comparisonResults);

  const sides = [
  { manifest: baselineManifest, role: SIDE.BASELINE, artifactDir: baselineArtifactDir, hpidRemap: null },
  { manifest: compareManifest, role: SIDE.COMPARE, artifactDir: compareArtifactDir, hpidRemap: compareHpidRemap }];

  for (const { manifest, role, artifactDir, hpidRemap } of sides) {
    const keyframes = manifest?.keyframes ?? [];

    const prefixById = new Map();
    for (const kf of keyframes) {
      if (!diffKeyframeIds.has(kf.id)) continue;
      prefixById.set(kf.id, `${sessionId}_${role}_${kf.id}`);
    }
    if (prefixById.size === 0) continue;

    for (const kf of keyframes) {
      const prefixedId = prefixById.get(kf.id);
      if (!prefixedId) continue;

      const keyframeRecord = {
        id: prefixedId,
        sessionId,
        keyframeId: prefixedId,
        scrollY: kf.scrollY ?? 0,
        viewportWidth: kf.viewportWidth ?? 0,
        viewportHeight: kf.viewportHeight ?? 0,
        tabRole: role,
        elementIds: kf.elementIds ?? []
      };
      try {
        await storage.saveVisualKeyframe(keyframeRecord);
        tally.record('saveVisualKeyframe', OUTCOME.OK);
      } catch (err) {
        tally.record('saveVisualKeyframe', OUTCOME.FAILED, { id: prefixedId, error: err?.message });
        console.error('[sauce-workflow] saveVisualKeyframe failed', err);
      }
    }

    const rectRecords = buildSauceRectRecords(manifest, sessionId, role, prefixById, hpidRemap);
    if (rectRecords.length > 0 && typeof storage.saveVisualElementRects === 'function') {
      try {
        await storage.saveVisualElementRects(rectRecords);
        tally.record('saveVisualElementRects', OUTCOME.OK, { count: rectRecords.length });
      } catch (err) {
        tally.record('saveVisualElementRects', OUTCOME.FAILED, { count: rectRecords.length, error: err?.message });
        console.error('[sauce-workflow] saveVisualElementRects failed', err);
      }
    }

    if (!artifactDir || typeof api?.sauceReadKeyframe !== 'function') {
      for (const kf of keyframes) {
        if (prefixById.has(kf.id) && kf.filename) {
          tally.record('saveVisualBlob', OUTCOME.SKIPPED, { reason: 'no-artifact-dir-or-ipc' });
        }
      }
      continue;
    }

    for (const kf of keyframes) {
      const prefixedId = prefixById.get(kf.id);
      if (!prefixedId || !kf.filename) continue;

      let res;
      try {
        res = await api.sauceReadKeyframe({ artifactDir, filename: kf.filename });
      } catch (err) {
        tally.record('sauceReadKeyframe', OUTCOME.FAILED, { filename: kf.filename, error: err?.message });
        console.error('[sauce-workflow] sauceReadKeyframe IPC failed', err);
        continue;
      }
      if (!res?.success || !res.base64) {
        tally.record('sauceReadKeyframe', OUTCOME.FAILED, { filename: kf.filename, error: res?.error ?? 'no-data' });
        console.warn('[sauce-workflow] keyframe read returned no data', { filename: kf.filename, error: res?.error });
        continue;
      }
      tally.record('sauceReadKeyframe', OUTCOME.OK);

      const blobId = `${comparisonId}:${prefixedId}`;
      const mimeType = res.mimeType || 'image/jpeg';

      try {
        const u8 = _base64ToUint8Array(res.base64);
        const blob = new Blob([u8], { type: mimeType });
        if (typeof storage.saveVisualBlob === 'function') {
          await storage.saveVisualBlob(blobId, blob, comparisonId);
          tally.record('saveVisualBlob', OUTCOME.OK, { bytes: u8.length });
        } else {
          tally.record('saveVisualBlob', OUTCOME.SKIPPED, { reason: 'no-storage-api' });
        }
      } catch (err) {
        tally.record('saveVisualBlob', OUTCOME.FAILED, { blobId, error: err?.message });
        console.error('[sauce-workflow] saveVisualBlob failed', err);
      }

      if (typeof api.registerBlob === 'function') {
        try {
          await api.registerBlob({ blobId, base64: res.base64, mimeType });
          tally.record('registerBlob', OUTCOME.OK);
        } catch (err) {
          tally.record('registerBlob', OUTCOME.FAILED, { blobId, error: err?.message });
          console.error('[sauce-workflow] registerBlob failed', err);
        }
      }
    }
  }

  return tally.finalize();
}

function _base64ToUint8Array(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function _persistReport(report) {
  if (!report || !report.id) return;

  const meta = {
    id: report.id,
    url: report.url,
    title: report.title || '',
    timestamp: report.timestamp || new Date().toISOString(),
    totalElements: report.totalElements || (report.elements?.length ?? 0),
    extractOptions: report.extractOptions || null,
    duration: report.duration || 0,
    engine: report.engine || 'chromium',
    platform: report.platform || '',
    sauceSessionId: report.sauceSessionId || null,
    sauceJobId: report.sauceJobId || null,
    source: 'saucelabs'
  };

  const elements = report.elements || [];
  if (typeof storage.saveReport === 'function') {
    await storage.saveReport({ ...meta, elements });
  }
}

async function _updateJobStatus(jobId, status, patch = {}) {
  if (typeof storage.updateSauceJob !== 'function') return;
  try {


    const merged = status === undefined ? { ...patch } : { status, ...patch };
    await storage.updateSauceJob(jobId, merged);
  } catch (err) {
    console.error('[sauce-workflow] updateSauceJob failed', err);
  }
}

async function _patchSauceJob(jobId, patch) {
  if (typeof storage.updateSauceJob !== 'function') return;
  if (!patch || Object.keys(patch).length === 0) return;
  try {
    await storage.updateSauceJob(jobId, patch);
  } catch (err) {
    console.error('[sauce-workflow] updateSauceJob (patch) failed', err);
  }
}

function _updateJobSessionIds(data) {
  const jobId = data.jobId ?? getState().sauceJob?.jobId;
  if (!jobId) return;

  const patch = {};
  if (data.baselineSessionId) patch.baselineSessionId = data.baselineSessionId;
  if (data.compareSessionId) patch.compareSessionId = data.compareSessionId;




  if (data.baselineSessionId && data.compareSessionId) {
    patch.status = 'running';
    patch.baselineStatus = 'running';
    patch.compareStatus = 'running';
  } else if (data.baselineSessionId) {
    patch.baselineStatus = 'running';
  } else if (data.compareSessionId) {
    patch.compareStatus = 'running';
  }

  if (Object.keys(patch).length === 0) return;
  void _patchSauceJob(jobId, patch);
}