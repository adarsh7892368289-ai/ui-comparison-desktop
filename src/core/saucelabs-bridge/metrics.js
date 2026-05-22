'use strict';


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

  snapshot() {
    return [...this._completed];
  }

  totalDurationMs() {
    return this._completed.reduce((sum, e) => sum + (e.durationMs ?? 0), 0);
  }
}

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
    this._steps = {};
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
        if (b.errors.length < 10) b.errors.push(detail);
      }
    } else {
      throw new Error(`Unknown outcome: ${outcome}`);
    }
  }

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
