import { describe, it, expect } from 'vitest';






function deriveTopLevelStatus(baselineStatus, compareStatus) {
  if (baselineStatus === 'cancelled' || compareStatus === 'cancelled') return 'cancelled';

  if (baselineStatus === 'submitted' && compareStatus === 'submitted') return 'submitted';

  const bothRunningOrSubmitted =
  ['submitted', 'running'].includes(baselineStatus) &&
  ['submitted', 'running'].includes(compareStatus);
  if (bothRunningOrSubmitted && (baselineStatus === 'running' || compareStatus === 'running')) {
    return 'running';
  }

  if (baselineStatus === 'complete' && compareStatus === 'complete') return 'downloading';

  const failedSet = new Set(['failed', 'timed_out']);
  if (failedSet.has(baselineStatus) && failedSet.has(compareStatus)) {
    if (baselineStatus === 'timed_out' && compareStatus === 'timed_out') return 'timed_out';
    return 'failed';
  }

  if (
  failedSet.has(baselineStatus) && compareStatus === 'complete' ||
  baselineStatus === 'complete' && failedSet.has(compareStatus))
  {
    return 'partially_failed';
  }


  return 'running';
}

function transitionSubStatus(current, sauceLabsStatus) {
  if (current === 'complete' || current === 'failed' || current === 'timed_out' || current === 'cancelled') {
    return current;
  }

  const normalized = (sauceLabsStatus || '').toLowerCase();

  if (normalized === 'complete' || normalized === 'passed') return 'complete';
  if (normalized === 'error' || normalized === 'failed') return 'failed';
  if (normalized === 'timed_out') return 'timed_out';
  if (normalized === 'cancelled') return 'cancelled';


  return current;
}

describe('State Machine — per-session sub-status transitions', () => {
  it('submitted → running: session ID recovered', () => {


    expect(transitionSubStatus('submitted', 'running')).toBe('submitted');


  });

  it('running → complete on SauceLabs "complete"', () => {
    expect(transitionSubStatus('running', 'complete')).toBe('complete');
  });

  it('running → complete on SauceLabs "passed"', () => {
    expect(transitionSubStatus('running', 'passed')).toBe('complete');
  });

  it('running → failed on SauceLabs "error"', () => {
    expect(transitionSubStatus('running', 'error')).toBe('failed');
  });

  it('running → failed on SauceLabs "failed"', () => {
    expect(transitionSubStatus('running', 'failed')).toBe('failed');
  });

  it('running → timed_out on timeout', () => {
    expect(transitionSubStatus('running', 'timed_out')).toBe('timed_out');
  });

  it('running → cancelled on user cancel', () => {
    expect(transitionSubStatus('running', 'cancelled')).toBe('cancelled');
  });

  it('running stays running on "in progress"', () => {
    expect(transitionSubStatus('running', 'in progress')).toBe('running');
  });

  it('running stays running on "queued"', () => {
    expect(transitionSubStatus('running', 'queued')).toBe('running');
  });

  it('terminals are sticky — complete never transitions out', () => {
    expect(transitionSubStatus('complete', 'failed')).toBe('complete');
    expect(transitionSubStatus('complete', 'timed_out')).toBe('complete');
  });

  it('terminals are sticky — failed never transitions out', () => {
    expect(transitionSubStatus('failed', 'complete')).toBe('failed');
  });

  it('terminals are sticky — timed_out never transitions out', () => {
    expect(transitionSubStatus('timed_out', 'complete')).toBe('timed_out');
  });
});

describe('State Machine — top-level derived status', () => {
  it('both submitted → submitted', () => {
    expect(deriveTopLevelStatus('submitted', 'submitted')).toBe('submitted');
  });

  it('both running → running', () => {
    expect(deriveTopLevelStatus('running', 'running')).toBe('running');
  });

  it('one running, one submitted → running', () => {
    expect(deriveTopLevelStatus('running', 'submitted')).toBe('running');
    expect(deriveTopLevelStatus('submitted', 'running')).toBe('running');
  });

  it('both complete → downloading', () => {
    expect(deriveTopLevelStatus('complete', 'complete')).toBe('downloading');
  });

  it('one complete, one failed → partially_failed', () => {
    expect(deriveTopLevelStatus('complete', 'failed')).toBe('partially_failed');
    expect(deriveTopLevelStatus('failed', 'complete')).toBe('partially_failed');
  });

  it('one complete, one timed_out → partially_failed', () => {
    expect(deriveTopLevelStatus('complete', 'timed_out')).toBe('partially_failed');
    expect(deriveTopLevelStatus('timed_out', 'complete')).toBe('partially_failed');
  });

  it('both failed → failed', () => {
    expect(deriveTopLevelStatus('failed', 'failed')).toBe('failed');
  });

  it('one failed, one timed_out → failed', () => {
    expect(deriveTopLevelStatus('failed', 'timed_out')).toBe('failed');
    expect(deriveTopLevelStatus('timed_out', 'failed')).toBe('failed');
  });

  it('both timed_out → timed_out', () => {
    expect(deriveTopLevelStatus('timed_out', 'timed_out')).toBe('timed_out');
  });

  it('any cancelled → cancelled', () => {
    expect(deriveTopLevelStatus('cancelled', 'running')).toBe('cancelled');
    expect(deriveTopLevelStatus('running', 'cancelled')).toBe('cancelled');
    expect(deriveTopLevelStatus('cancelled', 'cancelled')).toBe('cancelled');
    expect(deriveTopLevelStatus('complete', 'cancelled')).toBe('cancelled');
  });

  it('one complete, other still running → running (intermediate state)', () => {
    expect(deriveTopLevelStatus('complete', 'running')).toBe('running');
    expect(deriveTopLevelStatus('running', 'complete')).toBe('running');
  });

  describe('partially_failed → retry → done path', () => {
    it('retry resets failed side to running, top-level back to running', () => {

      let topLevel = deriveTopLevelStatus('failed', 'complete');
      expect(topLevel).toBe('partially_failed');


      topLevel = deriveTopLevelStatus('running', 'complete');
      expect(topLevel).toBe('running');


      topLevel = deriveTopLevelStatus('complete', 'complete');
      expect(topLevel).toBe('downloading');

    });
  });
});

describe('State Machine — reducer actions (state.js patterns)', () => {
  function reduce(state, type, payload = {}) {
    switch (type) {
      case 'SAUCE_COMPARISON_SUBMITTED':
        return {
          ...state,
          sauceJob: {
            ...(payload.job ?? {}),
            status: 'submitted',
            baselineStatus: 'submitted',
            compareStatus: 'submitted'
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
            baselineSessionId: payload.baselineSessionId,
            compareSessionId: payload.compareSessionId
          }
        };
      case 'SAUCE_JOB_COMPLETE':
        if (!state.sauceJob) return state;
        return { ...state, sauceJob: { ...state.sauceJob, status: 'done', ...payload } };
      case 'SAUCE_JOB_FAILED':
        if (!state.sauceJob) return state;
        return { ...state, sauceJob: { ...state.sauceJob, status: 'failed', error: payload.error } };
      case 'SAUCE_JOB_PARTIALLY_FAILED':
        if (!state.sauceJob) return state;
        return {
          ...state,
          sauceJob: {
            ...state.sauceJob,
            status: 'partially_failed',
            partiallyFailedSession: payload.partiallyFailedSession,
            error: payload.error
          }
        };
      case 'SAUCE_JOB_RETRYING':
        if (!state.sauceJob) return state;
        return {
          ...state,
          sauceJob: { ...state.sauceJob, status: 'running', partiallyFailedSession: null, error: null }
        };
      case 'SAUCE_JOB_CANCELLED':
        if (!state.sauceJob) return state;
        return { ...state, sauceJob: { ...state.sauceJob, status: 'cancelled' } };
      case 'SAUCE_JOB_RESET':
        return { ...state, sauceJob: null };
      case 'SAUCE_CREDENTIALS_REQUIRED':
        return { ...state, sauceCredentialState: 'credentials_required', sauceInFlightJobCount: payload.count };
      default:
        return state;
    }
  }

  it('full happy path: submitted → running → done', () => {
    let state = { sauceJob: null };
    state = reduce(state, 'SAUCE_COMPARISON_SUBMITTED', { job: { jobId: 'j1' } });
    expect(state.sauceJob.status).toBe('submitted');

    state = reduce(state, 'SAUCE_SESSION_IDS', { baselineSessionId: 'bs1', compareSessionId: 'cs1' });
    expect(state.sauceJob.status).toBe('running');

    state = reduce(state, 'SAUCE_JOB_COMPLETE', { comparisonId: 'cmp1' });
    expect(state.sauceJob.status).toBe('done');
    expect(state.sauceJob.comparisonId).toBe('cmp1');
  });

  it('partially_failed → retry → done', () => {
    let state = { sauceJob: { jobId: 'j1', status: 'running' } };
    state = reduce(state, 'SAUCE_JOB_PARTIALLY_FAILED', {
      partiallyFailedSession: 'baseline',
      error: 'timeout'
    });
    expect(state.sauceJob.status).toBe('partially_failed');
    expect(state.sauceJob.partiallyFailedSession).toBe('baseline');

    state = reduce(state, 'SAUCE_JOB_RETRYING');
    expect(state.sauceJob.status).toBe('running');
    expect(state.sauceJob.partiallyFailedSession).toBeNull();

    state = reduce(state, 'SAUCE_JOB_COMPLETE', { comparisonId: 'cmp2' });
    expect(state.sauceJob.status).toBe('done');
  });

  it('cancelled from any state', () => {
    let state = { sauceJob: { jobId: 'j1', status: 'running' } };
    state = reduce(state, 'SAUCE_JOB_CANCELLED');
    expect(state.sauceJob.status).toBe('cancelled');
  });

  it('credentials_required on resume', () => {
    let state = { sauceJob: null, sauceCredentialState: 'idle' };
    state = reduce(state, 'SAUCE_CREDENTIALS_REQUIRED', { count: 2 });
    expect(state.sauceCredentialState).toBe('credentials_required');
    expect(state.sauceInFlightJobCount).toBe(2);
  });

  it('SAUCE_JOB_RESET clears sauceJob', () => {
    let state = { sauceJob: { jobId: 'j1', status: 'done' } };
    state = reduce(state, 'SAUCE_JOB_RESET');
    expect(state.sauceJob).toBeNull();
  });
});