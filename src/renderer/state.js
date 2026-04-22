'use strict';

const initialState = {
  phase:               'idle',
  reports:             [],
  comparison:          null,
  progress:            { label: '', pct: 0 },
  error:               null,
  exportState:         null,
  selectedBaseline:    null,
  selectedCompare:     null,
  compareMode:         'dynamic',
  filters:             { class: '', id: '', tag: '' },
  cachedAt:            null,
  comparisonFromCache: false,
  compareSummaryStrip: null,
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

    case 'RESET_COMPARISON':
      return {
        ...state,
        comparison:          null,
        phase:               'idle',
        error:               null,
        cachedAt:            null,
        comparisonFromCache: false,
        compareSummaryStrip: null,
      };

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