import { describe, it, expect } from 'vitest';
import { config, get } from '../../src/config/defaults.js';

describe('SauceLabs config defaults', () => {
  it('has saucelabs.compatibleSaucectlRange defined', () => {
    expect(get('saucelabs.compatibleSaucectlRange')).toBe('>=0.200.0 <1.0.0');
  });

  it('has saucelabs.versionCheckTimeoutMs = 5000', () => {
    expect(get('saucelabs.versionCheckTimeoutMs')).toBe(5000);
  });

  it('has saucelabs.maxScreenshotsPerSession = 200', () => {
    expect(get('saucelabs.maxScreenshotsPerSession')).toBe(200);
  });

  it('has saucelabs.pollTimeoutMs = 90 minutes', () => {
    expect(get('saucelabs.pollTimeoutMs')).toBe(90 * 60 * 1000);
  });

  it('has saucelabs.maxRetainedJobs = 20', () => {
    expect(get('saucelabs.maxRetainedJobs')).toBe(20);
  });

  it('config object is frozen (immutable)', () => {
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.saucelabs)).toBe(true);
  });
});
