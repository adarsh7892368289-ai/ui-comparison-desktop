import { describe, it, expect } from 'vitest';







function parseValidationResponse(statusCode, body) {
  if (statusCode === 401) {
    return { success: false, error: 'Invalid credentials' };
  }

  if (statusCode === 403) {
    return { success: false, error: 'Account cannot create Playwright sessions — check SauceLabs plan permissions' };
  }

  if (statusCode !== 200) {
    return { success: false, error: `SauceLabs API error (HTTP ${statusCode})` };
  }

  let parsed;
  try {
    parsed = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return { success: false, error: 'Invalid response from SauceLabs API' };
  }

  const hasConcurrency = parsed && (
  typeof parsed.subaccounts === 'object' && parsed.subaccounts !== null ||
  typeof parsed.concurrency === 'object' && parsed.concurrency !== null ||
  parsed.totals && typeof parsed.totals === 'object');


  if (!hasConcurrency) {
    return { success: false, error: 'Account cannot create Playwright sessions — check SauceLabs plan permissions' };
  }

  return { success: true, username: 'user', region: 'us-west-1' };
}

describe('Credential validation response parser', () => {
  it('returns invalid credentials on 401', () => {
    const result = parseValidationResponse(401, '');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid credentials');
  });

  it('returns permissions error on 403', () => {
    const result = parseValidationResponse(403, '');
    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot create Playwright sessions');
  });

  it('returns generic error for unexpected HTTP codes', () => {
    const result = parseValidationResponse(500, '');
    expect(result.success).toBe(false);
    expect(result.error).toContain('HTTP 500');
  });

  it('returns success when response has concurrency data', () => {
    const body = JSON.stringify({ concurrency: { overall: 5 } });
    const result = parseValidationResponse(200, body);
    expect(result.success).toBe(true);
  });

  it('returns success when response has subaccounts', () => {
    const body = JSON.stringify({ subaccounts: { team1: {} } });
    const result = parseValidationResponse(200, body);
    expect(result.success).toBe(true);
  });

  it('returns success when response has totals', () => {
    const body = JSON.stringify({ totals: { sessions: 10 } });
    const result = parseValidationResponse(200, body);
    expect(result.success).toBe(true);
  });

  it('returns permissions error on 200 without entitlement markers', () => {
    const body = JSON.stringify({ username: 'user', email: 'x@y.com' });
    const result = parseValidationResponse(200, body);
    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot create Playwright sessions');
  });

  it('returns invalid response error on unparseable JSON', () => {
    const result = parseValidationResponse(200, 'not json');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid response from SauceLabs API');
  });

  it('returns permissions error when body is null', () => {
    const result = parseValidationResponse(200, 'null');
    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot create Playwright sessions');
  });
});