'use strict';

import { dispatch, getState } from '../state.js';
import storage, { buildPairKey } from '../../infrastructure/idb-repository.js';
import { loadAndRenderReports } from './report-manager.js';
import { Comparator } from '@core/comparison/comparator.js';

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

export async function submitExtraction({ url, platform, browserName, screenResolution, tunnelName, filters }) {
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
      filters: filters || null
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

export async function submitComparison({ baselineUrl, compareUrl, platform, browserName, screenResolution, tunnelName, filters }) {
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
      filters: filters || null
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
  const successSide = failedSide === 'baseline' ? 'compare' : 'baseline';
  const failedSideUrl = failedSide === 'baseline' ? storedJob.baselineUrl : storedJob.compareUrl;
  const successSideSessionId = successSide === 'baseline' ?
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
      filters: storedJob.filters ?? null
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

async function _handleComparisonComplete(data) {
  const { baselineReport, compareReport, baselineManifest, compareManifest, jobId } = data;

  try {
    await _persistReport(baselineReport);
    await _persistReport(compareReport);
  } catch (err) {
    console.error('[sauce-workflow] report persistence failed', err);
  }

  let comparisonId = null;
  try {
    const comparator = new Comparator();
    const baselineInput = { ...baselineReport, elements: baselineReport.elements ?? [] };
    const compareInput = { ...compareReport, elements: compareReport.elements ?? [] };

    let comparisonResult = null;
    const gen = comparator.compare(baselineInput, compareInput, 'dynamic');
    for await (const frame of gen) {
      if (frame.type === 'result') {
        comparisonResult = frame.payload;
      }
    }

    if (comparisonResult) {
      comparisonId = crypto.randomUUID();
      const mode = 'dynamic';
      const pairKey = buildPairKey(baselineReport.id, compareReport.id, mode);

      const diffKeyframeIds = _computeDiffKeyframeIds(
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

      await storage.saveComparison(meta, comparisonResult.comparison?.results ?? []);

      await _persistFilteredVisualData({
        jobId,
        comparisonId,
        baselineManifest,
        compareManifest,
        diffKeyframeIds,
        baselineArtifactDir: data.baselineArtifactDir,
        compareArtifactDir: data.compareArtifactDir
      });

      await _updateJobStatus(jobId, 'done', {
        comparisonId,
        baselineReportId: baselineReport.id,
        compareReportId: compareReport.id,
        baselineArtifactDir: data.baselineArtifactDir,
        compareArtifactDir: data.compareArtifactDir,
        completedAt: Date.now()
      });
    }
  } catch (err) {
    console.error('[sauce-workflow] comparison failed', err);
  }

  dispatch('SAUCE_JOB_COMPLETE', {
    comparisonId,
    baselineReportId: baselineReport.id,
    compareReportId: compareReport.id
  });

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

function _computeDiffKeyframeIds(comparisonResults, baselineManifest, compareManifest) {
  const diffHpids = new Set();
  for (const r of comparisonResults ?? []) {
    if ((r.totalDifferences ?? 0) > 0) {
      const hpid = r.baselineElement?.hpid ?? null;
      if (hpid) diffHpids.add(hpid);
    }
  }

  const diffKeyframeIds = new Set();
  const baseMap = baselineManifest?.elementKeyframeMap ?? {};
  const compMap = compareManifest?.elementKeyframeMap ?? {};

  for (const hpid of diffHpids) {
    if (baseMap[hpid]) diffKeyframeIds.add(baseMap[hpid]);
    if (compMap[hpid]) diffKeyframeIds.add(compMap[hpid]);
  }

  return diffKeyframeIds;
}

async function _persistFilteredVisualData({
  comparisonId,
  baselineManifest,
  compareManifest,
  diffKeyframeIds,
  baselineArtifactDir,
  compareArtifactDir
}) {
  if (!diffKeyframeIds || diffKeyframeIds.size === 0) return;

  const sides = [
  { manifest: baselineManifest, role: 'baseline', artifactDir: baselineArtifactDir },
  { manifest: compareManifest, role: 'compare', artifactDir: compareArtifactDir }];


  for (const { manifest, role, artifactDir } of sides) {
    const keyframes = manifest?.keyframes ?? [];
    for (const kf of keyframes) {
      if (!diffKeyframeIds.has(kf.id)) continue;

      const keyframeRecord = {
        id: `${comparisonId}:${kf.id}:${role}`,
        sessionId: comparisonId,
        keyframeId: kf.id,
        scrollY: kf.scrollY ?? 0,
        viewportWidth: kf.viewportWidth ?? 0,
        viewportHeight: kf.viewportHeight ?? 0,
        tabRole: role,
        elementIds: kf.elementIds ?? []
      };

      try {
        await storage.saveVisualKeyframe(keyframeRecord);
      } catch (err) {
        console.error('[sauce-workflow] saveVisualKeyframe failed', err);
      }




      if (!artifactDir || !kf.filename || typeof api?.sauceReadKeyframe !== 'function') {
        continue;
      }

      let res;
      try {
        res = await api.sauceReadKeyframe({ artifactDir, filename: kf.filename });
      } catch (err) {
        console.error('[sauce-workflow] sauceReadKeyframe IPC failed', err);
        continue;
      }
      if (!res?.success || !res.base64) {
        console.warn('[sauce-workflow] keyframe read returned no data', { filename: kf.filename, error: res?.error });
        continue;
      }



      const blobId = `${comparisonId}:${kf.id}_${role}`;
      const mimeType = res.mimeType || 'image/webp';

      try {
        const u8 = _base64ToUint8Array(res.base64);
        const blob = new Blob([u8], { type: mimeType });
        if (typeof storage.saveVisualBlob === 'function') {
          await storage.saveVisualBlob(blobId, blob, comparisonId);
        }
      } catch (err) {
        console.error('[sauce-workflow] saveVisualBlob failed', err);
      }

      if (typeof api.registerBlob === 'function') {
        try {
          await api.registerBlob({ blobId, base64: res.base64, mimeType });
        } catch (err) {
          console.error('[sauce-workflow] registerBlob failed', err);
        }
      }
    }
  }
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