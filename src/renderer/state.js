'use strict';

import { get as configGet } from '../config/defaults.js';

function _clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  if (n < min) { return min; }
  if (n > max) { return max; }
  return n;
}































const initialState = {
  phase: 'idle',
  reports: [],
  comparison: null,
  progress: { label: '', pct: 0 },
  error: null,
  exportState: null,
  selectedBaseline: null,
  selectedCompare: null,
  compareMode: 'dynamic',
  filters: { class: '', id: '', tag: '' },
  cachedAt: null,
  comparisonFromCache: false,
  compareSummaryStrip: null,
  selectedBrowser: null,
  availableBrowsers: [],
  browserDetectionState: 'idle',
  browserDetectionError: null,
  bulkJob: null,
  bulkParsedRows: [],
  bulkDetectionState: 'idle',
  multiSelect: {
    active: false,
    selectedIds: new Set(),
    anchorId: null
  },
  sauceJob: null,
  sauceCredentialState: 'idle',
  sauceCredentialError: null,
  sauceComparisonResult: null,
  tolerances: { enabled: false, ...configGet('comparison.defaultTolerances') }
};

let _state = { ...initialState };
const _listeners = new Set();

function getState() {
  return _state;
}

function dispatch(type, payload = {}) {
  _state = reduce(_state, type, payload);
  for (const listener of _listeners) {
    try {listener(_state);} catch (err) {console.error('State listener error:', err);}
  }
}

function subscribe(listener) {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

function reduce(state, type, payload) {
  switch (type) {

    case 'REPORTS_LOADED':
      return { ...state, reports: payload.reports ?? [] };

    case 'REPORT_DELETED':
      return {
        ...state,
        reports: state.reports.filter((r) => r.id !== payload.reportId)
      };

    case 'COMPARISON_STARTED':
      return {
        ...state,
        phase: 'comparing',
        comparison: null,
        progress: { label: 'Starting…', pct: 0 },
        error: null,
        cachedAt: null,
        comparisonFromCache: false,
        compareSummaryStrip: null
      };

    case 'COMPARISON_PROGRESS':
      if (state.phase === 'cancelling') {
        return state;
      }
      return {
        ...state,
        progress: { label: payload.label, pct: payload.pct }
      };

    case 'COMPARISON_COMPLETE':
      return {
        ...state,
        phase: 'done',
        comparison: payload.result,
        progress: { label: 'Complete', pct: 100 },
        error: null,
        cachedAt: payload.cachedAt ?? null,
        comparisonFromCache: Boolean(payload.fromCache),
        compareSummaryStrip: payload.compareSummaryStrip ?? null
      };

    case 'COMPARISON_ERROR':
      return {
        ...state,
        phase: 'error',
        error: payload.error,
        progress: { label: 'Error', pct: 0 },
        comparisonFromCache: false,
        compareSummaryStrip: null
      };

    case 'EXTRACTION_STARTED':
      return {
        ...state,
        phase: 'extracting',
        progress: { label: payload.label ?? 'Starting…', pct: payload.pct ?? 0 },
        error: null
      };

    case 'EXTRACTION_PROGRESS':
      if (state.phase === 'cancelling') {
        return state;
      }
      return {
        ...state,
        phase: 'extracting',
        progress: { label: payload.label, pct: payload.pct }
      };

    case 'OPERATION_CANCELLING':
      return {
        ...state,
        phase: 'cancelling',
        progress: { label: 'Cancelling…', pct: state.progress?.pct ?? 0 }
      };

    case 'EXTRACT_UI_END':
      if (state.phase === 'extracting' || state.phase === 'cancelling') {
        if (state.comparison) {
          return { ...state, phase: 'done', progress: { label: 'Complete', pct: 100 } };
        }
        return { ...state, phase: 'idle', progress: { label: '', pct: 0 } };
      }
      return state;

    case 'COMPARE_UI_END':
      if (state.phase === 'comparing' || state.phase === 'cancelling') {
        return { ...state, phase: 'idle', progress: { label: '', pct: 0 } };
      }
      return state;

    case 'BASELINE_SELECTED':{
        const id = payload.id || null;
        return { ...state, selectedBaseline: id === state.selectedBaseline ? null : id };
      }

    case 'COMPARE_SELECTED':{
        const id = payload.id || null;
        return { ...state, selectedCompare: id === state.selectedCompare ? null : id };
      }

    case 'MODE_CHANGED':
      return { ...state, compareMode: payload.mode };

    case 'SET_TOLERANCES': {
      const defaults = configGet('comparison.defaultTolerances');
      const seed = (payload.tolerances && typeof payload.tolerances === 'object') ? payload.tolerances : defaults;
      const next = {
        enabled: typeof seed.enabled === 'boolean' ? seed.enabled : Boolean(state.tolerances?.enabled),
        color:   _clampNumber(seed.color,   0, 255, defaults.color),
        size:    _clampNumber(seed.size,    0, 100, defaults.size),
        opacity: _clampNumber(seed.opacity, 0, 1,   defaults.opacity)
      };
      const cur = state.tolerances ?? { enabled: false, ...defaults };
      if (
        cur.enabled === next.enabled &&
        cur.color === next.color &&
        cur.size === next.size &&
        cur.opacity === next.opacity
      ) {
        return state;
      }
      return { ...state, tolerances: next };
    }

    case 'SET_TOLERANCE_ENABLED': {
      const defaults = configGet('comparison.defaultTolerances');
      const enabled = Boolean(payload.enabled);
      const base = state.tolerances ?? { enabled: false, ...defaults };
      if (base.enabled === enabled) { return state; }
      return { ...state, tolerances: { ...base, enabled } };
    }

    case 'SET_TOLERANCE_FIELD': {
      if (!['color', 'size', 'opacity'].includes(payload.field)) { return state; }
      const max = payload.field === 'color' ? 255 : payload.field === 'size' ? 100 : 1;
      const defaults = configGet('comparison.defaultTolerances');
      const value = _clampNumber(payload.value, 0, max, defaults[payload.field]);
      const base = state.tolerances ?? { enabled: false, ...defaults };
      if (base[payload.field] === value) { return state; }
      return { ...state, tolerances: { ...base, [payload.field]: value } };
    }

    case 'RESET_COMPARISON':{
        const cleared = {
          ...state,
          comparison: null,
          phase: 'idle',
          error: null,
          cachedAt: null,
          comparisonFromCache: false,
          compareSummaryStrip: null
        };
        if (state.bulkJob?.activePairIndex != null) {
          cleared.bulkJob = {
            ...state.bulkJob,
            activePairIndex: null,
            viewer: null
          };
        }
        return cleared;
      }

    case 'DISMISS_ERROR':
      return {
        ...initialState,
        reports: state.reports,
        selectedBaseline: state.selectedBaseline,
        selectedCompare: state.selectedCompare,
        compareMode: state.compareMode,
        filters: state.filters,
        comparisonFromCache: false,
        compareSummaryStrip: null,
        selectedBrowser: state.selectedBrowser,
        availableBrowsers: state.availableBrowsers,
        browserDetectionState: state.browserDetectionState,
        browserDetectionError: state.browserDetectionError,
        bulkJob: state.bulkJob,
        bulkParsedRows: state.bulkParsedRows,
        bulkDetectionState: state.bulkDetectionState,
        multiSelect: state.multiSelect,



        sauceJob: state.sauceJob,
        sauceCredentialState: state.sauceCredentialState,
        sauceCredentialError: state.sauceCredentialError,
        sauceInFlightJobCount: state.sauceInFlightJobCount,
        tolerances: state.tolerances
      };

    case 'BULK_PARSED_ROWS_SET':
      return {
        ...state,
        bulkParsedRows: Array.isArray(payload.rows) ? payload.rows : [],
        bulkDetectionState: payload.detectionState ?? state.bulkDetectionState
      };

    case 'BULK_DETECTION_STATE':
      return { ...state, bulkDetectionState: payload.detectionState ?? 'idle' };

    case 'BULK_JOB_STARTED':{
        const spec = payload.jobSpec ?? {};
        const pairs = (spec.pairs ?? []).map((p, i) => ({
          pairIndex: p.pairIndex,
          baselineUrl: p.baselineUrl,
          compareUrl: p.compareUrl,
          mode: p.mode ?? 'dynamic',
          label: p.label ?? null,
          browser: p.browser ?? null,
          includeScreenshots: p.includeScreenshots !== false,
          filterClass: p.filterClass ?? null,
          filterId: p.filterId ?? null,
          filterTag: p.filterTag ?? null,
          deduped: 'none',




          status: i === 0 ? 'extracting-baseline' : 'queued',
          pct: 0,
          operationId: null,
          baselineReportId: null,
          compareReportId: null,
          comparisonId: p.comparisonId ?? null,
          error: null,
          errorCode: null
        }));
        return {
          ...state,
          bulkJob: {
            jobId: spec.jobId,
            filename: spec.filename ?? '',
            status: 'running',
            totalPairs: pairs.length,
            concurrency: spec.concurrency ?? 2,
            hostCooldownMs: spec.hostCooldownMs ?? 0,
            pairs,
            summary: null,
            startedAt: Date.now(),
            completedAt: null,
            activePairIndex: null,
            viewer: null
          }
        };
      }

    case 'BULK_PROGRESS':{
        if (!state.bulkJob) {return state;}
        const idx = payload.pairIndex;
        const pairs = state.bulkJob.pairs.map((p) =>
        p.pairIndex === idx ?
        {
          ...p,
          status: payload.phase ?? p.status,
          pct: typeof payload.pct === 'number' ? payload.pct : p.pct,
          operationId: payload.operationId ?? p.operationId
        } :
        p
        );
        return { ...state, bulkJob: { ...state.bulkJob, pairs } };
      }

    case 'BULK_PAIR_COMPLETED':{
        if (!state.bulkJob) {return state;}
        const idx = payload.pairIndex;
        const pairs = state.bulkJob.pairs.map((p) => {
          if (p.pairIndex !== idx) {return p;}
          const isDone = payload.status === 'done';
          const baselineReportId =
          typeof payload.baselineReport === 'object' && payload.baselineReport ?
          payload.baselineReport.id ?? payload.baselineReport.reportId ?? p.baselineReportId :
          payload.baselineReportId ?? p.baselineReportId;
          const compareReportId =
          typeof payload.compareReport === 'object' && payload.compareReport ?
          payload.compareReport.id ?? payload.compareReport.reportId ?? p.compareReportId :
          payload.compareReportId ?? p.compareReportId;
          const comparisonId =
          payload.comparisonResult?.comparisonId ??
          payload.comparisonResult?.meta?.id ??
          payload.comparisonId ??
          p.comparisonId;
          return {
            ...p,
            status: payload.status ?? p.status,
            pct: isDone ? 100 : p.pct,
            baselineReportId,
            compareReportId,
            comparisonId,
            deduped: payload.deduped ?? p.deduped ?? 'none',
            error: payload.error ?? p.error,
            errorCode: payload.errorCode ?? p.errorCode,
            completedAt: isDone ? Date.now() : p.completedAt
          };
        });
        return { ...state, bulkJob: { ...state.bulkJob, pairs } };
      }

    case 'BULK_JOB_COMPLETE':{
        if (!state.bulkJob) {return state;}
        const summary = payload.summary ?? null;



        let status;
        if (state.bulkJob.cancelling === true) {
          const succeeded = summary?.succeeded ?? 0;
          status = succeeded > 0 ? 'partial' : 'cancelled';
        } else if (summary && summary.succeeded === 0 && summary.total > 0) {
          status = 'failed';
        } else {
          status = 'completed';
        }
        return {
          ...state,
          bulkJob: {
            ...state.bulkJob,
            status,
            summary,
            cancelling: false,
            completedAt: Date.now()
          }
        };
      }

    case 'BULK_JOB_CANCELLING':{



        if (!state.bulkJob) {return state;}
        return {
          ...state,
          bulkJob: { ...state.bulkJob, cancelling: true }
        };
      }

    case 'BULK_JOB_CANCELLED':{
        if (!state.bulkJob) {return state;}
        const pairs = state.bulkJob.pairs.map((p) =>
        p.status === 'queued' ? { ...p, status: 'cancelled' } : p
        );
        return {
          ...state,
          bulkJob: { ...state.bulkJob, status: 'cancelled', pairs, completedAt: Date.now() }
        };
      }

    case 'BULK_JOB_STORAGE_DEGRADED':{



        if (!state.bulkJob) {return state;}
        return {
          ...state,
          bulkJob: { ...state.bulkJob, storageDegraded: true, cancelling: true }
        };
      }

    case 'BULK_JOB_LOADED':{
        const j = payload.job ?? null;
        if (!j) {
          return { ...state, bulkJob: null };
        }
        return {
          ...state,
          bulkJob: {
            ...j,
            viewer: j.viewer ?? null,
            activePairIndex: j.activePairIndex ?? null
          }
        };
      }

    case 'BULK_JOB_RESET':
      return {
        ...state,
        bulkJob: null,
        bulkParsedRows: [],
        bulkDetectionState: 'idle'
      };

    case 'BULK_JOB_RESUMED':
    case 'BULK_JOB_RESUME_ACCEPTED':
      if (!state.bulkJob) return state;
      return {
        ...state,
        bulkJob: {
          ...state.bulkJob,
          status: 'running',
          resumeOffer: null,
          pairs: state.bulkJob.pairs.map((p) =>
          (payload.incompletePairIndexes ?? []).includes(p.pairIndex) ?
          { ...p, status: 'queued', pct: 0, error: null, errorCode: null } :
          p
          )
        }
      };

    case 'BULK_JOB_RESUME_OFFERED':{
        const job = payload.job ?? null;
        if (!job) {return state;}
        return {
          ...state,
          bulkJob: {
            ...job,
            status: 'parsed',
            viewer: job.viewer ?? null,
            activePairIndex: job.activePairIndex ?? null,
            resumeOffer: {
              jobId: job.jobId,
              completedCount: payload.completedCount ?? 0,
              totalCount: payload.totalCount ?? (Array.isArray(job.pairs) ? job.pairs.length : 0)
            }
          }
        };
      }

    case 'BULK_JOB_RESUME_DECLINED':{
        if (payload.cascade === true) {
          return {
            ...state,
            bulkJob: null,
            bulkParsedRows: [],
            bulkDetectionState: 'idle'
          };
        }
        if (!state.bulkJob) {return state;}
        return {
          ...state,
          bulkJob: {
            ...state.bulkJob,
            status: 'partial',
            resumeOffer: null,
            completedAt: state.bulkJob.completedAt ?? Date.now()
          }
        };
      }

    case 'BULK_PAIR_OPEN':
      if (!state.bulkJob) {return state;}
      return {
        ...state,
        bulkJob: {
          ...state.bulkJob,
          activePairIndex: payload.pairIndex,
          viewer: null
        }
      };

    case 'BULK_PAIR_VIEWER_READY':
      if (!state.bulkJob) {return state;}
      return {
        ...state,
        bulkJob: {
          ...state.bulkJob,
          viewer: {
            result: payload.result,
            cachedAt: payload.cachedAt ?? null,
            fromCache: Boolean(payload.fromCache),
            compareSummaryStrip: payload.compareSummaryStrip ?? null
          }
        }
      };

    case 'BULK_ACTIVE_PAIR_CLEAR':
      if (!state.bulkJob) {return state;}
      return {
        ...state,
        bulkJob: {
          ...state.bulkJob,
          activePairIndex: null,
          viewer: null
        }
      };

    case 'BROWSER_DETECTION_STARTED':
      return {
        ...state,
        browserDetectionState: 'loading',
        browserDetectionError: null
      };

    case 'BROWSERS_DETECTED':
      return {
        ...state,
        availableBrowsers: payload.browsers ?? [],
        selectedBrowser: state.selectedBrowser ??
        (payload.browsers ?? []).find((b) => b.isLaunchable && b.isDefault) ??
        null,
        browserDetectionState: 'ready',
        browserDetectionError: null
      };

    case 'BROWSER_DETECTION_FAILED':
      return {
        ...state,
        browserDetectionState: 'error',
        browserDetectionError: payload.error ?? 'Browser detection failed'
      };

    case 'BROWSER_SELECTED':
      return {
        ...state,
        selectedBrowser: payload.browser ?? null
      };

    case 'MULTI_SELECT_ENTER':{
        const ids = new Set(state.multiSelect.selectedIds);
        if (payload.id) {ids.add(payload.id);}
        return {
          ...state,
          multiSelect: { active: true, selectedIds: ids, anchorId: payload.id ?? null }
        };
      }

    case 'MULTI_SELECT_EXIT':
      return {
        ...state,
        multiSelect: { active: false, selectedIds: new Set(), anchorId: null }
      };

    case 'MULTI_SELECT_TOGGLE':{
        const ids = new Set(state.multiSelect.selectedIds);
        if (ids.has(payload.id)) {ids.delete(payload.id);} else {ids.add(payload.id);}
        if (ids.size === 0) {
          return {
            ...state,
            multiSelect: { active: false, selectedIds: new Set(), anchorId: null }
          };
        }
        return {
          ...state,
          multiSelect: { ...state.multiSelect, selectedIds: ids, anchorId: payload.id }
        };
      }

    case 'MULTI_SELECT_RANGE':{
        const ids = new Set(state.multiSelect.selectedIds);
        for (const id of payload.ids ?? []) {ids.add(id);}
        const last = payload.ids?.[payload.ids.length - 1] ?? state.multiSelect.anchorId;
        return {
          ...state,
          multiSelect: { ...state.multiSelect, selectedIds: ids, anchorId: last }
        };
      }

    case 'MULTI_SELECT_ALL':
      return {
        ...state,
        multiSelect: { ...state.multiSelect, selectedIds: new Set(payload.ids ?? []) }
      };

    case 'MULTI_SELECT_CLEAR':
      return {
        ...state,
        multiSelect: { active: false, selectedIds: new Set(), anchorId: null }
      };

    case 'MULTI_SELECT_AFTER_DELETE':{
        const deletedSet = new Set(payload.deletedIds ?? []);
        const ids = new Set(state.multiSelect.selectedIds);
        for (const id of deletedSet) {ids.delete(id);}
        const selectedBaseline = deletedSet.has(state.selectedBaseline) ? null : state.selectedBaseline;
        const selectedCompare = deletedSet.has(state.selectedCompare) ? null : state.selectedCompare;
        return {
          ...state,
          selectedBaseline,
          selectedCompare,
          multiSelect: {
            active: ids.size > 0,
            selectedIds: ids,
            anchorId: ids.size > 0 ? state.multiSelect.anchorId : null
          }
        };
      }

    case 'REPORTS_REMOVE_BY_IDS':{
        const removeSet = new Set(payload.ids ?? []);
        return {
          ...state,
          reports: state.reports.filter((r) => !removeSet.has(r.id))
        };
      }

    case 'REPORTS_RESTORE':{
        const existingIds = new Set(state.reports.map((r) => r.id));
        const toRestore = (payload.reports ?? []).filter((r) => !existingIds.has(r.id));
        return {
          ...state,
          reports: [...state.reports, ...toRestore]
        };
      }

    case 'SAUCE_CREDENTIAL_VALIDATING':
      return { ...state, sauceCredentialState: 'validating', sauceCredentialError: null };

    case 'SAUCE_CREDENTIAL_VALID':
      return { ...state, sauceCredentialState: 'valid', sauceCredentialError: null };

    case 'SAUCE_CREDENTIAL_FAILED':
      return { ...state, sauceCredentialState: 'error', sauceCredentialError: payload.error ?? 'Validation failed' };

    case 'SAUCE_CREDENTIAL_RESET':
      return { ...state, sauceCredentialState: 'idle', sauceCredentialError: null };

    case 'SAUCE_JOB_SUBMITTED':
      return { ...state, sauceJob: payload.job ?? null };

    case 'SAUCE_JOB_PROGRESS':
      if (!state.sauceJob) return state;
      return { ...state, sauceJob: { ...state.sauceJob, ...payload, status: payload.phase || state.sauceJob.status } };

    case 'SAUCE_JOB_COMPLETE':
      if (!state.sauceJob) return state;
      return { ...state, sauceJob: { ...state.sauceJob, status: 'done', ...payload } };

    case 'SAUCE_JOB_FAILED':{




        const base = state.sauceJob ?? {
          jobId: payload.jobId ?? null,
          url: payload.url ?? null,
          baselineUrl: payload.baselineUrl ?? null,
          compareUrl: payload.compareUrl ?? null,
          platform: payload.platform ?? null,
          browserName: payload.browserName ?? null
        };
        return { ...state, sauceJob: { ...base, status: 'failed', error: payload.error ?? null } };
      }

    case 'SAUCE_JOB_PARTIALLY_FAILED':
      if (!state.sauceJob) return state;
      return {
        ...state,
        sauceJob: {
          ...state.sauceJob,
          status: 'partially_failed',
          partiallyFailedSession: payload.partiallyFailedSession ?? null,
          error: payload.error ?? null
        }
      };

    case 'SAUCE_JOB_RETRYING':
      if (!state.sauceJob) return state;
      return {
        ...state,
        sauceJob: {
          ...state.sauceJob,
          status: 'running',
          partiallyFailedSession: null,
          error: null
        }
      };

    case 'SAUCE_JOB_CANCELLED':
      if (!state.sauceJob) return state;
      return { ...state, sauceJob: { ...state.sauceJob, status: 'cancelled', completedAt: Date.now() } };

    case 'SAUCE_PERSIST_WARNING':
      if (!state.sauceJob) return state;
      return {
        ...state,
        sauceJob: {
          ...state.sauceJob,
          persistWarning: payload?.message ?? 'Job state could not be saved — resume after restart is unavailable for this job.'
        }
      };

    case 'SAUCE_COMPARISON_SUBMITTED':
      return {
        ...state,
        sauceJob: {
          ...(payload.job ?? {}),
          status: 'submitted',
          baselineStatus: 'submitted',
          compareStatus: 'submitted',
          submittedAt: Date.now()
        }
      };

    case 'SAUCE_SESSION_IDS':
      if (!state.sauceJob) return state;
      return {
        ...state,
        sauceJob: {
          ...state.sauceJob,
          status: 'running',
          baselineStatus: 'running',
          compareStatus: 'running',
          baselineSessionId: payload.baselineSessionId ?? null,
          compareSessionId: payload.compareSessionId ?? null
        }
      };

    case 'SAUCE_CREDENTIALS_REQUIRED':
      return {
        ...state,
        sauceCredentialState: 'credentials_required',
        sauceInFlightJobCount: payload.count ?? 0
      };

    case 'SAUCE_JOB_LOADED':
      return { ...state, sauceJob: payload.job ?? null };

    case 'SAUCE_JOB_RESET':
      return { ...state, sauceJob: null, sauceComparisonResult: null };

    case 'SAUCE_COMPARISON_RESULT':
      return {
        ...state,
        sauceComparisonResult: {
          jobId: payload.jobId ?? null,
          comparisonId: payload.comparisonId ?? null,
          result: payload.result ?? null,
          cachedAt: payload.cachedAt ?? null,
          fromCache: !!payload.fromCache
        }
      };

    case 'SAUCE_PERSISTENCE_INCOMPLETE':
      if (!state.sauceJob) return state;
      return {
        ...state,
        sauceJob: {
          ...state.sauceJob,
          persistenceWarning: {
            summary: payload.summary ?? 'Some visual data could not be saved',
            failedSteps: payload.failedSteps ?? [],
            steps: payload.steps ?? {}
          }
        }
      };

    case 'FILTERS_UPDATED':
      return { ...state, filters: { ...state.filters, ...payload.filters } };

    case 'EXPORT_STARTED':
      return { ...state, exportState: 'pending' };

    case 'EXPORT_COMPLETE':
      return { ...state, exportState: payload.success ? 'done' : 'error' };

    case 'EXPORT_ERROR':
      return { ...state, exportState: 'error', error: payload.error };

    default:
      return state;
  }
}

export { getState, dispatch, subscribe };