'use strict';

/**
 * BulkJobState: {
 *   jobId: string,
 *   filename: string,
 *   status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted',
 *   totalPairs: number,
 *   concurrency: number,
 *   pairs: Array<BulkPairState>,
 *   summary: null | { total, succeeded, failed, cancelled, deduped },
 *   startedAt: number,
 *   completedAt: number | null,
 *   activePairIndex?: number | null,
 * }
 *
 * BulkPairState: {
 *   pairIndex: number,
 *   baselineUrl: string,
 *   compareUrl: string,
 *   label: string | null,
 *   status: 'queued' | 'extracting-baseline' | 'extracting-compare' | 'matching'
 *         | 'screenshots' | 'persisting' | 'done' | 'failed' | 'cancelled',
 *   pct: number,
 *   operationId: string | null,
 *   baselineReportId: string | null,
 *   compareReportId: string | null,
 *   comparisonId: string | null,
 *   error: string | null,
 *   errorCode: string | null,
 * }
 */
const initialState = {
  phase:                  'idle',
  reports:                [],
  comparison:             null,
  progress:               { label: '', pct: 0 },
  error:                  null,
  exportState:            null,
  selectedBaseline:       null,
  selectedCompare:        null,
  compareMode:            'dynamic',
  filters:                { class: '', id: '', tag: '' },
  cachedAt:               null,
  comparisonFromCache:    false,
  compareSummaryStrip:    null,
  selectedBrowser:        null,
  availableBrowsers:      [],
  browserDetectionState:  'idle',
  browserDetectionError:  null,
  bulkJob:                null,
  bulkParsedRows:         [],
  bulkDetectionState:     'idle',
};

let _state       = { ...initialState };
const _listeners = new Set();

function getState() {
  return _state;
}

function dispatch(type, payload = {}) {
  _state = reduce(_state, type, payload);
  for (const listener of _listeners) {
    try { listener(_state); } catch (err) { console.error('State listener error:', err); }
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
        reports: state.reports.filter(r => r.id !== payload.reportId),
      };

    case 'COMPARISON_STARTED':
      return {
        ...state,
        phase:               'comparing',
        comparison:          null,
        progress:            { label: 'Starting…', pct: 0 },
        error:                 null,
        cachedAt:              null,
        comparisonFromCache: false,
        compareSummaryStrip: null,
      };

    case 'COMPARISON_PROGRESS':
      if (state.phase === 'cancelling') {
        return state;
      }
      return {
        ...state,
        progress: { label: payload.label, pct: payload.pct },
      };

    case 'COMPARISON_COMPLETE':
      return {
        ...state,
        phase:                 'done',
        comparison:          payload.result,
        progress:            { label: 'Complete', pct: 100 },
        error:               null,
        cachedAt:            payload.cachedAt ?? null,
        comparisonFromCache: Boolean(payload.fromCache),
        compareSummaryStrip: payload.compareSummaryStrip ?? null,
      };

    case 'COMPARISON_ERROR':
      return {
        ...state,
        phase:                 'error',
        error:                 payload.error,
        progress:              { label: 'Error', pct: 0 },
        comparisonFromCache: false,
        compareSummaryStrip: null,
      };

    case 'EXTRACTION_STARTED':
      return {
        ...state,
        phase:      'extracting',
        progress:   { label: payload.label ?? 'Starting…', pct: payload.pct ?? 0 },
        error:        null,
      };

    case 'EXTRACTION_PROGRESS':
      if (state.phase === 'cancelling') {
        return state;
      }
      return {
        ...state,
        phase:    'extracting',
        progress: { label: payload.label, pct: payload.pct },
      };

    case 'OPERATION_CANCELLING':
      return {
        ...state,
        phase:    'cancelling',
        progress: { label: 'Cancelling…', pct: state.progress?.pct ?? 0 },
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

    case 'BASELINE_SELECTED':
      return { ...state, selectedBaseline: payload.id || null };

    case 'COMPARE_SELECTED':
      return { ...state, selectedCompare: payload.id || null };

    case 'MODE_CHANGED':
      return { ...state, compareMode: payload.mode };

    case 'RESET_COMPARISON': {
      const cleared = {
        ...state,
        comparison:          null,
        phase:               'idle',
        error:               null,
        cachedAt:            null,
        comparisonFromCache: false,
        compareSummaryStrip: null,
      };
      if (state.bulkJob?.activePairIndex != null) {
        cleared.bulkJob = {
          ...state.bulkJob,
          activePairIndex: null,
          viewer:          null,
        };
      }
      return cleared;
    }

    case 'DISMISS_ERROR':
      return {
        ...initialState,
        reports:               state.reports,
        selectedBaseline:      state.selectedBaseline,
        selectedCompare:       state.selectedCompare,
        compareMode:           state.compareMode,
        filters:               state.filters,
        comparisonFromCache: false,
        compareSummaryStrip:   null,
        selectedBrowser:       state.selectedBrowser,
        availableBrowsers:     state.availableBrowsers,
        browserDetectionState: state.browserDetectionState,
        browserDetectionError: state.browserDetectionError,
        bulkJob:               state.bulkJob,
        bulkParsedRows:        state.bulkParsedRows,
        bulkDetectionState:    state.bulkDetectionState,
      };

    case 'BULK_PARSED_ROWS_SET':
      return {
        ...state,
        bulkParsedRows:     Array.isArray(payload.rows) ? payload.rows : [],
        bulkDetectionState: payload.detectionState ?? state.bulkDetectionState,
      };

    case 'BULK_DETECTION_STATE':
      return { ...state, bulkDetectionState: payload.detectionState ?? 'idle' };

    case 'BULK_JOB_STARTED': {
      const spec = payload.jobSpec ?? {};
      const pairs = (spec.pairs ?? []).map((p, i) => ({
        pairIndex:          p.pairIndex,
        baselineUrl:        p.baselineUrl,
        compareUrl:         p.compareUrl,
        mode:               p.mode ?? 'dynamic',
        label:              p.label ?? null,
        browser:            p.browser ?? null,
        includeScreenshots: p.includeScreenshots !== false,
        filterClass:        p.filterClass ?? null,
        filterId:           p.filterId    ?? null,
        filterTag:          p.filterTag   ?? null,
        deduped:            'none',
        // Optimistic Start (UI spec §9.1): the first pair flips to
        // 'extracting-baseline' synchronously so the running view paints
        // within one animation frame; main reconciles when it actually
        // begins extraction (idempotent — same status = no-op).
        status:             i === 0 ? 'extracting-baseline' : 'queued',
        pct:                0,
        operationId:        null,
        baselineReportId:   null,
        compareReportId:    null,
        comparisonId:       p.comparisonId ?? null,
        error:              null,
        errorCode:          null,
      }));
      return {
        ...state,
        bulkJob: {
          jobId:           spec.jobId,
          filename:        spec.filename ?? '',
          status:          'running',
          totalPairs:      pairs.length,
          concurrency:     spec.concurrency ?? 2,
          hostCooldownMs:  spec.hostCooldownMs ?? 0,
          pairs,
          summary:         null,
          startedAt:       Date.now(),
          completedAt:     null,
          activePairIndex: null,
          viewer:          null,
        },
      };
    }

    case 'BULK_PROGRESS': {
      if (!state.bulkJob) { return state; }
      const idx = payload.pairIndex;
      const pairs = state.bulkJob.pairs.map((p) =>
        p.pairIndex === idx
          ? {
              ...p,
              status:      payload.phase ?? p.status,
              pct:         typeof payload.pct === 'number' ? payload.pct : p.pct,
              operationId: payload.operationId ?? p.operationId,
            }
          : p
      );
      return { ...state, bulkJob: { ...state.bulkJob, pairs } };
    }

    case 'BULK_PAIR_COMPLETED': {
      if (!state.bulkJob) { return state; }
      const idx = payload.pairIndex;
      const pairs = state.bulkJob.pairs.map((p) => {
        if (p.pairIndex !== idx) { return p; }
        const isDone = payload.status === 'done';
        const baselineReportId =
          (typeof payload.baselineReport === 'object' && payload.baselineReport)
            ? (payload.baselineReport.id ?? payload.baselineReport.reportId ?? p.baselineReportId)
            : (payload.baselineReportId ?? p.baselineReportId);
        const compareReportId =
          (typeof payload.compareReport === 'object' && payload.compareReport)
            ? (payload.compareReport.id ?? payload.compareReport.reportId ?? p.compareReportId)
            : (payload.compareReportId ?? p.compareReportId);
        const comparisonId =
          payload.comparisonResult?.comparisonId
          ?? payload.comparisonResult?.meta?.id
          ?? payload.comparisonId
          ?? p.comparisonId;
        return {
          ...p,
          status:           payload.status ?? p.status,
          pct:              isDone ? 100 : p.pct,
          baselineReportId,
          compareReportId,
          comparisonId,
          deduped:          payload.deduped ?? p.deduped ?? 'none',
          error:            payload.error     ?? p.error,
          errorCode:        payload.errorCode ?? p.errorCode,
          completedAt:      isDone ? Date.now() : p.completedAt,
        };
      });
      return { ...state, bulkJob: { ...state.bulkJob, pairs } };
    }

    case 'BULK_JOB_COMPLETE': {
      if (!state.bulkJob) { return state; }
      const summary = payload.summary ?? null;
      // Per UI spec §7.2 the cancel-then-complete path resolves to
      // 'cancelled' (zero done) or 'partial' (some done) — distinct from
      // the failure path below.
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
          cancelling:  false,
          completedAt: Date.now(),
        },
      };
    }

    case 'BULK_JOB_CANCELLING': {
      // Per UI spec §7.2: clicking Cancel keeps status='running' but flips
      // a `cancelling` flag so the panel can render the Cancelling… button.
      // Final status transition happens when BULK_JOB_COMPLETE arrives.
      if (!state.bulkJob) { return state; }
      return {
        ...state,
        bulkJob: { ...state.bulkJob, cancelling: true },
      };
    }

    case 'BULK_JOB_CANCELLED': {
      if (!state.bulkJob) { return state; }
      const pairs = state.bulkJob.pairs.map((p) =>
        p.status === 'queued' ? { ...p, status: 'cancelled' } : p
      );
      return {
        ...state,
        bulkJob: { ...state.bulkJob, status: 'cancelled', pairs, completedAt: Date.now() },
      };
    }

    case 'BULK_JOB_STORAGE_DEGRADED': {
      // Per UI spec §7.2 row 13 / §8.5: storage-degraded transitions the
      // job into the same "Cancelling…" visual state as a user-initiated
      // cancel; the renderer also calls electronAPI.cancelBulkJob.
      if (!state.bulkJob) { return state; }
      return {
        ...state,
        bulkJob: { ...state.bulkJob, storageDegraded: true, cancelling: true },
      };
    }

    case 'BULK_JOB_LOADED': {
      const j = payload.job ?? null;
      if (!j) {
        return { ...state, bulkJob: null };
      }
      return {
        ...state,
        bulkJob: {
          ...j,
          viewer:          j.viewer ?? null,
          activePairIndex: j.activePairIndex ?? null,
        },
      };
    }

    case 'BULK_JOB_RESET':
      return {
        ...state,
        bulkJob:            null,
        bulkParsedRows:     [],
        bulkDetectionState: 'idle',
      };

    case 'BULK_JOB_RESUMED':
    case 'BULK_JOB_RESUME_ACCEPTED':
      if (!state.bulkJob) return state;
      return {
        ...state,
        bulkJob: {
          ...state.bulkJob,
          status:      'running',
          resumeOffer: null,
          pairs: state.bulkJob.pairs.map((p) =>
            (payload.incompletePairIndexes ?? []).includes(p.pairIndex)
              ? { ...p, status: 'queued', pct: 0, error: null, errorCode: null }
              : p
          ),
        },
      };

    case 'BULK_JOB_RESUME_OFFERED': {
      const job = payload.job ?? null;
      if (!job) { return state; }
      return {
        ...state,
        bulkJob: {
          ...job,
          status:      'parsed',
          viewer:       job.viewer ?? null,
          activePairIndex: job.activePairIndex ?? null,
          resumeOffer: {
            jobId:          job.jobId,
            completedCount: payload.completedCount ?? 0,
            totalCount:     payload.totalCount ?? (Array.isArray(job.pairs) ? job.pairs.length : 0),
          },
        },
      };
    }

    case 'BULK_JOB_RESUME_DECLINED': {
      if (payload.cascade === true) {
        return {
          ...state,
          bulkJob:            null,
          bulkParsedRows:     [],
          bulkDetectionState: 'idle',
        };
      }
      if (!state.bulkJob) { return state; }
      return {
        ...state,
        bulkJob: {
          ...state.bulkJob,
          status:      'partial',
          resumeOffer: null,
          completedAt: state.bulkJob.completedAt ?? Date.now(),
        },
      };
    }

    case 'BULK_PAIR_OPEN':
      if (!state.bulkJob) { return state; }
      return {
        ...state,
        bulkJob: {
          ...state.bulkJob,
          activePairIndex: payload.pairIndex,
          viewer:          null,
        },
      };

    case 'BULK_PAIR_VIEWER_READY':
      if (!state.bulkJob) { return state; }
      return {
        ...state,
        bulkJob: {
          ...state.bulkJob,
          viewer: {
            result:              payload.result,
            cachedAt:            payload.cachedAt ?? null,
            fromCache:           Boolean(payload.fromCache),
            compareSummaryStrip: payload.compareSummaryStrip ?? null,
          },
        },
      };

    case 'BULK_ACTIVE_PAIR_CLEAR':
      if (!state.bulkJob) { return state; }
      return {
        ...state,
        bulkJob: {
          ...state.bulkJob,
          activePairIndex: null,
          viewer:          null,
        },
      };

    case 'BROWSER_DETECTION_STARTED':
      return {
        ...state,
        browserDetectionState: 'loading',
        browserDetectionError: null,
      };

    case 'BROWSERS_DETECTED':
      return {
        ...state,
        availableBrowsers:     payload.browsers ?? [],
        selectedBrowser:       state.selectedBrowser
          ?? (payload.browsers ?? []).find((b) => b.isLaunchable && b.isDefault)
          ?? null,
        browserDetectionState: 'ready',
        browserDetectionError: null,
      };

    case 'BROWSER_DETECTION_FAILED':
      return {
        ...state,
        browserDetectionState: 'error',
        browserDetectionError: payload.error ?? 'Browser detection failed',
      };

    case 'BROWSER_SELECTED':
      return {
        ...state,
        selectedBrowser: payload.browser ?? null,
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