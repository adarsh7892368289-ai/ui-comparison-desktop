import { describe, it, expect } from 'vitest';

const _CREDENTIAL_KEYS = new Set(['accessKey', 'access_key', 'password', 'SAUCE_ACCESS_KEY', 'secret', 'token']);

function _sanitise(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(_sanitise);
  const clone = {};
  for (const key of Object.keys(obj)) {
    if (_CREDENTIAL_KEYS.has(key)) {
      clone[key] = '[REDACTED]';
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      clone[key] = _sanitise(obj[key]);
    } else {
      clone[key] = obj[key];
    }
  }
  return clone;
}

describe('_sanitise credential redaction', () => {
  it('redacts accessKey at top level', () => {
    const input = { username: 'bob', accessKey: 'super-secret-123' };
    const result = _sanitise(input);
    expect(result.username).toBe('bob');
    expect(result.accessKey).toBe('[REDACTED]');
  });

  it('redacts access_key at top level', () => {
    const result = _sanitise({ access_key: 'secret', other: 'visible' });
    expect(result.access_key).toBe('[REDACTED]');
    expect(result.other).toBe('visible');
  });

  it('redacts password at top level', () => {
    const result = _sanitise({ password: 'hunter2', user: 'admin' });
    expect(result.password).toBe('[REDACTED]');
    expect(result.user).toBe('admin');
  });

  it('redacts SAUCE_ACCESS_KEY at top level', () => {
    const result = _sanitise({ SAUCE_ACCESS_KEY: 'abc-def', region: 'us-west-1' });
    expect(result.SAUCE_ACCESS_KEY).toBe('[REDACTED]');
    expect(result.region).toBe('us-west-1');
  });

  it('redacts accessKey at arbitrary nesting depth', () => {
    const input = {
      level1: {
        level2: {
          level3: {
            accessKey: 'deeply-nested-secret',
            safe: 'visible'
          }
        }
      }
    };
    const result = _sanitise(input);
    expect(result.level1.level2.level3.accessKey).toBe('[REDACTED]');
    expect(result.level1.level2.level3.safe).toBe('visible');
  });

  it('redacts multiple credential keys in nested objects', () => {
    const input = {
      creds: { username: 'user1', accessKey: 'key1', password: 'pass1' },
      config: { SAUCE_ACCESS_KEY: 'env-key', region: 'eu-central-1' }
    };
    const result = _sanitise(input);
    expect(result.creds.username).toBe('user1');
    expect(result.creds.accessKey).toBe('[REDACTED]');
    expect(result.creds.password).toBe('[REDACTED]');
    expect(result.config.SAUCE_ACCESS_KEY).toBe('[REDACTED]');
    expect(result.config.region).toBe('eu-central-1');
  });

  it('handles arrays containing objects with credentials', () => {
    const input = [
      { accessKey: 'secret1', id: 1 },
      { accessKey: 'secret2', id: 2 }
    ];
    const result = _sanitise(input);
    expect(result[0].accessKey).toBe('[REDACTED]');
    expect(result[0].id).toBe(1);
    expect(result[1].accessKey).toBe('[REDACTED]');
    expect(result[1].id).toBe(2);
  });

  it('preserves non-credential fields unchanged', () => {
    const input = { jobId: 'abc', sessionId: 'def', region: 'us-west-1', code: 0 };
    const result = _sanitise(input);
    expect(result).toEqual(input);
  });

  it('does not mutate the original object', () => {
    const input = { accessKey: 'original', name: 'test' };
    _sanitise(input);
    expect(input.accessKey).toBe('original');
  });

  it('handles null and undefined gracefully', () => {
    expect(_sanitise(null)).toBe(null);
    expect(_sanitise(undefined)).toBe(undefined);
  });

  it('handles primitive values passthrough', () => {
    expect(_sanitise('string')).toBe('string');
    expect(_sanitise(42)).toBe(42);
    expect(_sanitise(true)).toBe(true);
  });
});
