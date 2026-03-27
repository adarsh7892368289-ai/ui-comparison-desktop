'use strict';

const initialState = {
  phase:             'idle',
  reports:           [],
  comparison:        null,
  progress:          { label: '', pct: 0 },
  error:             null,
  exportState:       null,
  selectedBaseline:  null,
  selectedCompare:   null,
  compareMode:       'dynamic',
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
        phase:      'comparing',
        comparison: null,
        progress:   { label: 'Starting…', pct: 0 },
        error:      null,
      };

    case 'COMPARISON_PROGRESS':
      return {
        ...state,
        progress: { label: payload.label, pct: payload.pct },
      };

    case 'COMPARISON_COMPLETE':
      return {
        ...state,
        phase:      'done',
        comparison: payload.result,
        progress:   { label: 'Complete', pct: 100 },
        error:      null,
      };

    case 'COMPARISON_ERROR':
      return {
        ...state,
        phase:    'error',
        error:    payload.error,
        progress: { label: 'Error', pct: 0 },
      };

    case 'EXTRACTION_PROGRESS':
      return {
        ...state,
        phase:    'extracting',
        progress: { label: payload.label, pct: payload.pct },
      };

    case 'BASELINE_SELECTED':
      return { ...state, selectedBaseline: payload.id || null };

    case 'COMPARE_SELECTED':
      return { ...state, selectedCompare: payload.id || null };

    case 'MODE_CHANGED':
      return { ...state, compareMode: payload.mode };

    case 'RESET_COMPARISON':
      return { ...state, comparison: null, phase: 'idle', error: null };

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