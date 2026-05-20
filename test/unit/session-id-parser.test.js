import { describe, it, expect } from 'vitest';







function _stripAnsi(str) {

  return str.replace(new RegExp('\\x1b\\[[0-9;]*m', 'g'), '').trim();
}

const _UUID_PATTERN = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const _REJECT_LABEL_RE = /(?:storageId|checksum|config)\s*[:=]?\s*$/i;

function _toUuidWithDashes(hex) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function parseSauceSessionId(stdout) {
  const cleaned = _stripAnsi(stdout || '');

  const urlMatch = cleaned.match(new RegExp(`app\\.saucelabs\\.com/tests/(${_UUID_PATTERN})`, 'i'));
  if (urlMatch) return urlMatch[1].toLowerCase();

  const labeled = cleaned.match(new RegExp(`(?:^|[^a-zA-Z])(?:job|session)\\s*[:=]\\s*"?(${_UUID_PATTERN})`, 'i'));
  if (labeled) return labeled[1].toLowerCase();

  const bareScanner = new RegExp(_UUID_PATTERN, 'gi');
  let m;
  while ((m = bareScanner.exec(cleaned)) !== null) {
    const before = cleaned.slice(Math.max(0, m.index - 32), m.index);
    if (_REJECT_LABEL_RE.test(before)) continue;
    return m[0].toLowerCase();
  }

  const tagged = cleaned.match(/job[^\n]*?\b([a-f0-9]{32})\b/i);
  if (tagged) return _toUuidWithDashes(tagged[1].toLowerCase());

  return null;
}

const KNOWN_SAUCE_FAILURE_PATTERNS = [
/concurrent session limit/i,
/Job not started/i,
/Authorization failed/i,
/unable to determine available versions/i];


function cleanSauceFailureLine(line) {
  const quoted = line.match(/error="([^"]+)"/);
  if (quoted) return quoted[1].trim();
  return line.replace(/^\d{1,2}:\d{2}:\d{2}\s+(?:ERR|WRN|INF|DBG|FTL)\s+/i, '').trim();
}

function detectKnownSauceFailure(stdout, stderr) {
  const lines = [
  ..._stripAnsi(stdout || '').split(/\r?\n/),
  ..._stripAnsi(stderr || '').split(/\r?\n/)];

  for (const pattern of KNOWN_SAUCE_FAILURE_PATTERNS) {
    for (const line of lines) {
      if (pattern.test(line)) return cleanSauceFailureLine(line);
    }
  }
  return null;
}

describe('parseSauceSessionId', () => {
  it('does NOT match a UUID labeled as storageId=', () => {
    const stdout = 'Uploading bundle: storageId=b3adbf7e-ae0b-4543-a6f7-9af1e0ee22ab';
    expect(parseSauceSessionId(stdout)).toBeNull();
  });

  it('does NOT match a UUID labeled as checksum=', () => {
    const stdout = 'checksum=b3adbf7e-ae0b-4543-a6f7-9af1e0ee22ab';
    expect(parseSauceSessionId(stdout)).toBeNull();
  });

  it('does NOT match a UUID labeled as config=', () => {
    const stdout = 'config: b3adbf7e-ae0b-4543-a6f7-9af1e0ee22ab';
    expect(parseSauceSessionId(stdout)).toBeNull();
  });

  it('extracts the job ID from app.saucelabs.com/tests/{uuid}', () => {
    const id = '12345678-aaaa-bbbb-cccc-1234567890ab';
    const stdout = `Test URL: https://app.saucelabs.com/tests/${id}`;
    expect(parseSauceSessionId(stdout)).toBe(id);
  });

  it('prefers the URL-embedded job ID over an unrelated storageId UUID elsewhere in stdout', () => {
    const realId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const stdout = [
    'Uploading bundle: storageId=b3adbf7e-ae0b-4543-a6f7-9af1e0ee22ab',
    `Test URL: https://app.saucelabs.com/tests/${realId}`].
    join('\n');
    expect(parseSauceSessionId(stdout)).toBe(realId);
  });

  it('matches a UUID after a "job:" label', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const stdout = `job: ${id}`;
    expect(parseSauceSessionId(stdout)).toBe(id);
  });

  it('matches a UUID after a "session:" label', () => {
    const id = '99999999-8888-7777-6666-555555555555';
    const stdout = `session: ${id}`;
    expect(parseSauceSessionId(stdout)).toBe(id);
  });

  it('returns null when stdout is empty', () => {
    expect(parseSauceSessionId('')).toBeNull();
    expect(parseSauceSessionId(null)).toBeNull();
  });

  it('skips storageId UUID and finds a later bare UUID', () => {
    const realId = 'cafecafe-0000-1111-2222-333344445555';
    const stdout = [
    'storageId=b3adbf7e-ae0b-4543-a6f7-9af1e0ee22ab',
    `Job started ${realId}`].
    join('\n');
    expect(parseSauceSessionId(stdout)).toBe(realId);
  });
});

describe('detectKnownSauceFailure', () => {
  it('detects "concurrent session limit" and returns the full sentence', () => {
    const stdout = 'Submitting tests...\nYour organization has reached its concurrent session limit. Please retry later.\nExiting.';
    const msg = detectKnownSauceFailure(stdout, '');
    expect(msg).toBeTruthy();
    expect(msg).toContain('concurrent session limit');
    expect(msg).toContain('Your organization');
  });

  it('extracts the quoted error message from a saucectl ERR log line', () => {
    const stdout = '22:28:11 ERR Suite failed to start. error="job start failed (400): Job not started. Your organization has reached its concurrent session limit. Contact your administrator or sales@saucelabs.com to upgrade." passed=false suite=extract-c3a32fca url=';
    const msg = detectKnownSauceFailure(stdout, '');
    expect(msg).toBe('job start failed (400): Job not started. Your organization has reached its concurrent session limit. Contact your administrator or sales@saucelabs.com to upgrade.');
    expect(msg).not.toMatch(/^\d{1,2}:\d{2}:\d{2}/);
    expect(msg).not.toContain('passed=false');
    expect(msg).not.toContain('suite=');
  });

  it('detects "Job not started"', () => {
    const stdout = 'Job not started: queue full';
    expect(detectKnownSauceFailure(stdout, '')).toBe('Job not started: queue full');
  });

  it('detects "Authorization failed" in stderr', () => {
    const stderr = 'Authorization failed: invalid access key';
    expect(detectKnownSauceFailure('', stderr)).toBe('Authorization failed: invalid access key');
  });

  it('detects "unable to determine available versions"', () => {
    const stdout = 'ERROR: unable to determine available versions for playwright';
    const msg = detectKnownSauceFailure(stdout, '');
    expect(msg).toContain('unable to determine available versions');
  });

  it('strips the timestamp + log-level prefix when no quoted error is present', () => {
    const stdout = '22:28:11 ERR Authorization failed unexpectedly';
    expect(detectKnownSauceFailure(stdout, '')).toBe('Authorization failed unexpectedly');
  });

  it('returns null on stdout that contains no known failure markers', () => {
    const stdout = 'Test URL: https://app.saucelabs.com/tests/abc\nAll passed.';
    expect(detectKnownSauceFailure(stdout, '')).toBeNull();
  });
});