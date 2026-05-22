import { describe, it, expect, vi } from 'vitest';
import { PhaseTimer, PersistenceTally, OUTCOME } from '@core/saucelabs-bridge/metrics.js';

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}


describe('PhaseTimer', () => {
  it('measures elapsed wallclock and emits a structured log entry on end()', () => {
    const logger = fakeLogger();
    const timer = new PhaseTimer({ jobId: 'j1', logger });
    timer.start('phaseA');
    const entry = timer.end('phaseA', { extra: 'meta' });

    expect(entry).toMatchObject({
      event: 'sauce.phase',
      jobId: 'j1',
      phase: 'phaseA',
      extra: 'meta'
    });
    expect(typeof entry.durationMs).toBe('number');
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    expect(logger.info).toHaveBeenCalledTimes(1);
    const [msg, payload] = logger.info.mock.calls[0];
    expect(msg).toContain('[sauce.metrics] phase');
    expect(payload).toBe(entry);
  });

  it('returns null and logs nothing when end() is called without start()', () => {
    const logger = fakeLogger();
    const timer = new PhaseTimer({ jobId: 'j1', logger });
    expect(timer.end('never-started')).toBeNull();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('time() runs the function, times it, and returns its result', async () => {
    const logger = fakeLogger();
    const timer = new PhaseTimer({ jobId: 'j2', logger });
    const result = await timer.time('do-thing', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 42;
    });
    expect(result).toBe(42);
    expect(logger.info).toHaveBeenCalledTimes(1);
    const entry = logger.info.mock.calls[0][1];
    expect(entry.phase).toBe('do-thing');
    expect(entry.durationMs).toBeGreaterThanOrEqual(5);
  });

  it('time() emits a failed=true entry and re-throws on error', async () => {
    const logger = fakeLogger();
    const timer = new PhaseTimer({ jobId: 'j3', logger });
    await expect(
      timer.time('boom', async () => { throw new Error('kaboom'); })
    ).rejects.toThrow('kaboom');
    const entry = logger.info.mock.calls[0][1];
    expect(entry.failed).toBe(true);
    expect(entry.error).toBe('kaboom');
  });

  it('snapshot() returns every completed phase in order', () => {
    const timer = new PhaseTimer({ jobId: 'j4', logger: fakeLogger() });
    timer.start('a'); timer.end('a');
    timer.start('b'); timer.end('b');
    timer.start('c'); timer.end('c');
    const snap = timer.snapshot();
    expect(snap.map((e) => e.phase)).toEqual(['a', 'b', 'c']);
  });

  it('totalDurationMs() sums every completed phase', () => {
    const timer = new PhaseTimer({ jobId: 'j5', logger: fakeLogger() });
    timer.start('a');
    timer._completed.push({ phase: 'forced-1', durationMs: 100 });
    timer._completed.push({ phase: 'forced-2', durationMs: 250 });
    expect(timer.totalDurationMs()).toBe(350);
  });

  it('works without a logger (no-op log)', () => {
    const timer = new PhaseTimer({ jobId: 'j6' });
    timer.start('a');
    expect(() => timer.end('a')).not.toThrow();
  });
});


describe('PersistenceTally', () => {
  it('counts ok/skipped/failed per step', () => {
    const tally = new PersistenceTally({ jobId: 'j', logger: fakeLogger() });
    tally.record('saveBlob', OUTCOME.OK);
    tally.record('saveBlob', OUTCOME.OK);
    tally.record('saveBlob', OUTCOME.FAILED, { id: 'x', error: 'disk full' });
    tally.record('saveBlob', OUTCOME.SKIPPED);

    const result = tally.finalize();
    expect(result.steps.saveBlob).toMatchObject({
      attempted: 4, ok: 2, skipped: 1, failed: 1
    });
    expect(result.steps.saveBlob.errors).toEqual([{ id: 'x', error: 'disk full' }]);
    expect(result.anyFailed).toBe(true);
    expect(result.failedSteps).toEqual(['saveBlob']);
  });

  it('surfaces multiple failed steps in failedSteps and summary', () => {
    const tally = new PersistenceTally({ jobId: 'j', logger: fakeLogger() });
    tally.record('a', OUTCOME.FAILED, { error: 'x' });
    tally.record('b', OUTCOME.OK);
    tally.record('c', OUTCOME.FAILED, { error: 'y' });

    const result = tally.finalize();
    expect(result.anyFailed).toBe(true);
    expect(result.failedSteps.sort()).toEqual(['a', 'c']);
    expect(result.summary).toContain('a:');
    expect(result.summary).toContain('c:');
    expect(result.summary).not.toContain('b:');
  });

  it('returns anyFailed=false when everything succeeded', () => {
    const tally = new PersistenceTally({ jobId: 'j', logger: fakeLogger() });
    tally.record('a', OUTCOME.OK);
    tally.record('b', OUTCOME.SKIPPED);
    const result = tally.finalize();
    expect(result.anyFailed).toBe(false);
    expect(result.failedSteps).toEqual([]);
    expect(result.summary).toBe('all persistence steps ok');
  });

  it('returns empty result when no records were tracked', () => {
    const tally = new PersistenceTally({ jobId: 'j', logger: fakeLogger() });
    const result = tally.finalize();
    expect(result.steps).toEqual({});
    expect(result.anyFailed).toBe(false);
  });

  it('emits one structured summary log on finalize()', () => {
    const logger = fakeLogger();
    const tally = new PersistenceTally({ jobId: 'jX', logger });
    tally.record('a', OUTCOME.OK);
    tally.record('a', OUTCOME.FAILED, { error: 'bad' });
    tally.finalize();

    expect(logger.info).toHaveBeenCalledTimes(1);
    const [msg, payload] = logger.info.mock.calls[0];
    expect(msg).toContain('persistence');
    expect(payload).toMatchObject({
      event: 'sauce.persistence',
      jobId: 'jX',
      anyFailed: true,
      failedSteps: ['a']
    });
  });

  it('caps captured error details to prevent memory growth', () => {
    const tally = new PersistenceTally({ jobId: 'j', logger: fakeLogger() });
    for (let i = 0; i < 50; i++) {
      tally.record('a', OUTCOME.FAILED, { i, error: `err-${i}` });
    }
    const result = tally.finalize();
    expect(result.steps.a.failed).toBe(50);
    expect(result.steps.a.errors.length).toBe(10);
  });

  it('throws on unknown outcome (programmer error)', () => {
    const tally = new PersistenceTally({ jobId: 'j', logger: fakeLogger() });
    expect(() => tally.record('a', 'whatever')).toThrow(/Unknown outcome/);
  });

  it('works without a logger (no-op log)', () => {
    const tally = new PersistenceTally({ jobId: 'j' });
    tally.record('a', OUTCOME.OK);
    expect(() => tally.finalize()).not.toThrow();
  });
});


describe('OUTCOME', () => {
  it('exposes the three valid values', () => {
    expect(OUTCOME.OK).toBe('ok');
    expect(OUTCOME.SKIPPED).toBe('skipped');
    expect(OUTCOME.FAILED).toBe('failed');
  });

  it('is frozen (cannot be mutated by callers)', () => {
    expect(Object.isFrozen(OUTCOME)).toBe(true);
  });
});
