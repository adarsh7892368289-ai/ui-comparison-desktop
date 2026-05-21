'use strict';

// Structured observability helpers for the SauceLabs feature.
//
// Two primitives:
//
//   1. PhaseTimer — measures elapsed wallclock per named phase. Emits one
//      structured log entry on `.end()` with shape:
//         { event: 'sauce.phase', jobId, phase, durationMs, ...extra }
//      so log lines for a single jobId can be grep'd / aggregated.
//
//   2. PersistenceTally — accumulates per-step success/failure counts during
//      keyframe + rect + blob persistence. At the end, emits a single summary
//      log entry and returns a result that tells the caller whether to
//      surface a "partial failure" event to the user.
//
// Both are dependency-free and accept an injected `logger` so they work in
// main (electron-log), renderer (console), or tests (a fake).

class PhaseTimer {
  constructor({ jobId, logger, component = 'sauce.metrics' }) {
    this.jobId = jobId;
    this.logger = logger;
    this.component = component;
    this._startTimes = new Map();
    this._completed = [];
  }

  start(phase) {
    this._startTimes.set(phase, Date.now());
  }

  end(phase, extra = {}) {
    const startedAt = this._startTimes.get(phase);
    if (startedAt === undefined) return null;
    const durationMs = Date.now() - startedAt;
    this._startTimes.delete(phase);

    const entry = {
      event: 'sauce.phase',
      jobId: this.jobId,
      phase,
      durationMs,
      ...extra
    };
    this._completed.push(entry);
    if (this.logger?.info) this.logger.info(`[${this.component}] phase`, entry);
    return entry;
  }

  // Wraps an async function, timing it under `phase` and emitting on success
  // OR failure. Re-throws on failure so callers don't change control flow.
  async time(phase, fn, extra = {}) {
    this.start(phase);
    try {
      const result = await fn();
      this.end(phase, extra);
      return result;
    } catch (err) {
      this.end(phase, { ...extra, error: err?.message ?? String(err), failed: true });
      throw err;
    }
  }

  // Snapshot of every phase that completed (in order).
  snapshot() {
    return [...this._completed];
  }

  // Total wallclock spent across all completed phases.
  totalDurationMs() {
    return this._completed.reduce((sum, e) => sum + (e.durationMs ?? 0), 0);
  }
}

// Outcome categories used by callers to record per-item results.
const OUTCOME = Object.freeze({
  OK: 'ok',
  SKIPPED: 'skipped',
  FAILED: 'failed'
});

class PersistenceTally {
  constructor({ jobId, logger, component = 'sauce.metrics' }) {
    this.jobId = jobId;
    this.logger = logger;
    this.component = component;
    this._steps = {}; // step -> { ok, skipped, failed, errors[] }
  }

  _bucket(step) {
    if (!this._steps[step]) {
      this._steps[step] = { ok: 0, skipped: 0, failed: 0, errors: [] };
    }
    return this._steps[step];
  }

  record(step, outcome, detail = null) {
    const b = this._bucket(step);
    if (outcome === OUTCOME.OK) b.ok += 1;
    else if (outcome === OUTCOME.SKIPPED) b.skipped += 1;
    else if (outcome === OUTCOME.FAILED) {
      b.failed += 1;
      if (detail) {
        // Cap error capture to avoid runaway memory.
        if (b.errors.length < 10) b.errors.push(detail);
      }
    } else {
      throw new Error(`Unknown outcome: ${outcome}`);
    }
  }

  // Final accounting. Returns `{ steps, anyFailed, summary }`. Emits one
  // summary log entry with the per-step counts.
  finalize() {
    const steps = {};
    let anyFailed = false;
    const failedSteps = [];

    for (const [step, b] of Object.entries(this._steps)) {
      const total = b.ok + b.skipped + b.failed;
      steps[step] = {
        attempted: total,
        ok: b.ok,
        skipped: b.skipped,
        failed: b.failed,
        errors: b.errors
      };
      if (b.failed > 0) {
        anyFailed = true;
        failedSteps.push(step);
      }
    }

    const entry = {
      event: 'sauce.persistence',
      jobId: this.jobId,
      anyFailed,
      failedSteps,
      steps
    };
    if (this.logger?.info) this.logger.info(`[${this.component}] persistence`, entry);

    return {
      steps,
      anyFailed,
      failedSteps,
      summary: _humanSummary(steps)
    };
  }
}

function _humanSummary(steps) {
  const parts = [];
  for (const [step, s] of Object.entries(steps)) {
    if (s.failed > 0) {
      parts.push(`${step}: ${s.failed} failed of ${s.attempted}`);
    }
  }
  return parts.length === 0 ? 'all persistence steps ok' : parts.join('; ');
}

export { PhaseTimer, PersistenceTally, OUTCOME };
