import { describe, it, expect } from 'vitest';





function mapSauceStatus(sauceStatus) {
  const normalized = (sauceStatus || '').toLowerCase().trim();

  if (normalized === 'complete' || normalized === 'passed') return 'complete';
  if (normalized === 'error' || normalized === 'failed') return 'failed';


  if (['in progress', 'running', 'new', 'queued'].includes(normalized)) return 'running';


  return 'running';
}

describe('SauceLabs status mapping', () => {
  it('maps "complete" to complete', () => {
    expect(mapSauceStatus('complete')).toBe('complete');
  });

  it('maps "passed" to complete', () => {
    expect(mapSauceStatus('passed')).toBe('complete');
  });

  it('maps "error" to failed', () => {
    expect(mapSauceStatus('error')).toBe('failed');
  });

  it('maps "failed" to failed', () => {
    expect(mapSauceStatus('failed')).toBe('failed');
  });

  it('maps "in progress" to running', () => {
    expect(mapSauceStatus('in progress')).toBe('running');
  });

  it('maps "running" to running', () => {
    expect(mapSauceStatus('running')).toBe('running');
  });

  it('maps "new" to running', () => {
    expect(mapSauceStatus('new')).toBe('running');
  });

  it('maps "queued" to running', () => {
    expect(mapSauceStatus('queued')).toBe('running');
  });

  it('maps unknown status to running (timeout handled externally)', () => {
    expect(mapSauceStatus('some_unknown_status')).toBe('running');
    expect(mapSauceStatus('')).toBe('running');
    expect(mapSauceStatus(null)).toBe('running');
  });

  it('is case-insensitive', () => {
    expect(mapSauceStatus('COMPLETE')).toBe('complete');
    expect(mapSauceStatus('Error')).toBe('failed');
    expect(mapSauceStatus('In Progress')).toBe('running');
  });
});