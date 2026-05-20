import { describe, it, expect } from 'vitest';










const POLL_INTERVALS = [
{ maxElapsedMs: 2 * 60 * 1000, intervalMs: 10_000 },
{ maxElapsedMs: 5 * 60 * 1000, intervalMs: 20_000 },
{ maxElapsedMs: 10 * 60 * 1000, intervalMs: 30_000 },
{ maxElapsedMs: Infinity, intervalMs: 60_000 }];


const POLL_TIMEOUT_MS = 90 * 60 * 1000;

function pollIntervalForElapsed(elapsedMs) {
  if (elapsedMs >= POLL_TIMEOUT_MS) return null;
  for (const bucket of POLL_INTERVALS) {
    if (elapsedMs < bucket.maxElapsedMs) return bucket.intervalMs;
  }
  return 60_000;
}

describe('Polling backoff schedule', () => {
  it('returns 10s for 0 elapsed', () => {
    expect(pollIntervalForElapsed(0)).toBe(10_000);
  });

  it('returns 10s at 1 minute', () => {
    expect(pollIntervalForElapsed(60_000)).toBe(10_000);
  });

  it('returns 10s at 1:59', () => {
    expect(pollIntervalForElapsed(119_999)).toBe(10_000);
  });

  it('returns 20s at exactly 2 minutes', () => {
    expect(pollIntervalForElapsed(120_000)).toBe(20_000);
  });

  it('returns 20s at 3 minutes', () => {
    expect(pollIntervalForElapsed(180_000)).toBe(20_000);
  });

  it('returns 30s at exactly 5 minutes', () => {
    expect(pollIntervalForElapsed(300_000)).toBe(30_000);
  });

  it('returns 30s at 7 minutes', () => {
    expect(pollIntervalForElapsed(420_000)).toBe(30_000);
  });

  it('returns 60s at exactly 10 minutes', () => {
    expect(pollIntervalForElapsed(600_000)).toBe(60_000);
  });

  it('returns 60s at 30 minutes', () => {
    expect(pollIntervalForElapsed(1_800_000)).toBe(60_000);
  });

  it('returns 60s at 89 minutes', () => {
    expect(pollIntervalForElapsed(89 * 60 * 1000)).toBe(60_000);
  });

  it('returns null at exactly 90 minutes (timeout)', () => {
    expect(pollIntervalForElapsed(90 * 60 * 1000)).toBeNull();
  });

  it('returns null beyond 90 minutes', () => {
    expect(pollIntervalForElapsed(100 * 60 * 1000)).toBeNull();
  });
});