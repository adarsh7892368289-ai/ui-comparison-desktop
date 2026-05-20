'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const log = require('electron-log');
const { app } = require('electron');

const sauceBinaryManager = require('./saucelabs-binary-manager');
const { mainDistributionDir } = require('./resource-paths');
const { config: defaultsConfig } = require('../config/defaults.js');

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

const REGION_HOSTS = {
  'us-west-1': 'api.us-west-1.saucelabs.com',
  'us-east-4': 'api.us-east-4.saucelabs.com',
  'eu-central-1': 'api.eu-central-1.saucelabs.com'
};

const POLL_INTERVALS = [
{ maxElapsedMs: 2 * 60 * 1000, intervalMs: 10_000 },
{ maxElapsedMs: 5 * 60 * 1000, intervalMs: 20_000 },
{ maxElapsedMs: 10 * 60 * 1000, intervalMs: 30_000 },
{ maxElapsedMs: Infinity, intervalMs: 60_000 }];


const _jobRegistry = new Map();

function _registerJob(jobId, { username, accessKey, region }) {
  if (!jobId) return null;
  if (_jobRegistry.has(jobId)) return _jobRegistry.get(jobId);
  const controller = new AbortController();
  const entry = {
    jobId,
    controller,
    procs: new Set(),
    sessionIds: new Set(),
    creds: { username, accessKey, region },
    cancelled: false
  };
  _jobRegistry.set(jobId, entry);
  return entry;
}

function _unregisterJob(jobId) {
  if (jobId) _jobRegistry.delete(jobId);
}

function _trackProc(jobId, proc) {
  const entry = _jobRegistry.get(jobId);
  if (entry) entry.procs.add(proc);
}

function _untrackProc(jobId, proc) {
  const entry = _jobRegistry.get(jobId);
  if (entry) entry.procs.delete(proc);
}

function _trackSessionId(jobId, sessionId) {
  if (!jobId || !sessionId) return;
  const entry = _jobRegistry.get(jobId);
  if (entry) entry.sessionIds.add(sessionId);
}

function _getJobSignal(jobId) {
  const entry = _jobRegistry.get(jobId);
  return entry ? entry.controller.signal : null;
}

async function cancelJob(jobId, { username, accessKey, region } = {}) {
  const entry = _jobRegistry.get(jobId);
  if (!entry) {

    return { acknowledged: true, foundEntry: false };
  }
  entry.cancelled = true;
  try {entry.controller.abort();} catch {void 0;}


  for (const proc of entry.procs) {
    try {
      proc.kill('SIGTERM');
      setTimeout(() => {try {proc.kill('SIGKILL');} catch {void 0;}}, 3000).unref?.();
    } catch (err) {
      log.warn('[SauceManager] proc kill failed', { jobId, error: err?.message });
    }
  }



  const creds = entry.creds.username ? entry.creds : { username, accessKey, region };
  if (creds.username && creds.accessKey && entry.sessionIds.size > 0) {
    try {
      await _cancelRemoteSessions({
        username: creds.username,
        accessKey: creds.accessKey,
        region: creds.region || region || 'us-west-1',
        sessionIds: [...entry.sessionIds]
      });
    } catch (err) {
      log.warn('[SauceManager] remote cancel failed', { jobId, error: err?.message });
    }
  }

  return { acknowledged: true, foundEntry: true, cancelledSessions: [...entry.sessionIds] };
}

class JobCancelledError extends Error {
  constructor(jobId) {
    super('Job cancelled');
    this.name = 'JobCancelledError';
    this._sauceJobCancelled = true;
    this.jobId = jobId;
  }
}

function _throwIfCancelled(jobId) {
  const entry = _jobRegistry.get(jobId);
  if (entry && entry.cancelled) throw new JobCancelledError(jobId);
}

function _regionHost(region) {
  return REGION_HOSTS[region] || REGION_HOSTS['us-west-1'];
}

function _basicAuth(username, accessKey) {
  return Buffer.from(`${username}:${accessKey}`).toString('base64');
}

function _request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {data += chunk;});
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: data, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => {req.destroy();reject(new Error('Request timeout'));});
    if (body) req.write(body);
    req.end();
  });
}

function _requestBinary(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => {chunks.push(chunk);});
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, buffer: Buffer.concat(chunks), headers: res.headers });
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => {req.destroy();reject(new Error('Download timeout'));});
    req.end();
  });
}

async function validateCredentials({ username, accessKey, region }) {
  if (!username || !accessKey) {
    return { success: false, error: 'Username and access key are required' };
  }

  const host = _regionHost(region);
  const auth = _basicAuth(username, accessKey);

  let response;
  try {
    response = await _request({
      hostname: host,
      path: `/rest/v1/${encodeURIComponent(username)}/activity`,
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'User-Agent': 'ui-comparison-desktop'
      }
    });
  } catch (err) {
    log.error('[SauceManager] validateCredentials network error', { error: err.message });
    return { success: false, error: `Network error: ${err.message}` };
  }

  if (response.statusCode === 401) {
    return { success: false, error: 'Invalid credentials' };
  }

  if (response.statusCode === 403) {
    return { success: false, error: 'Account cannot create Playwright sessions — check SauceLabs plan permissions' };
  }

  if (response.statusCode !== 200) {
    log.warn('[SauceManager] unexpected status from activity endpoint', { status: response.statusCode });
    return { success: false, error: `SauceLabs API error (HTTP ${response.statusCode})` };
  }

  let body;
  try {
    body = JSON.parse(response.body);
  } catch {
    return { success: false, error: 'Invalid response from SauceLabs API' };
  }

  const hasConcurrency = body && (
  typeof body.subaccounts === 'object' && body.subaccounts !== null ||
  typeof body.concurrency === 'object' && body.concurrency !== null ||
  body.totals && typeof body.totals === 'object');


  if (!hasConcurrency) {
    return { success: false, error: 'Account cannot create Playwright sessions — check SauceLabs plan permissions' };
  }

  log.info('[SauceManager] credentials validated', { username, region });
  return { success: true, username, region };
}

function _getExtractorBundleSource() {
  const distDir = mainDistributionDir();
  const candidates = [
  path.join(distDir, 'extractor-bundle.js'),
  path.join(__dirname, 'extractor-bundle.js'),
  path.join(process.cwd(), 'dist', 'extractor-bundle.js')];

  for (const candidate of candidates) {
    try {
      return fs.readFileSync(candidate, 'utf8');
    } catch {
      void 0;
    }
  }
  throw new Error('Extractor bundle not found — run: npm run build:extractor');
}

function _getKeyframeGrouperSource() {
  const candidates = [
  path.join(__dirname, '..', 'core', 'comparison', 'keyframe-grouper.js'),
  path.join(process.cwd(), 'src', 'core', 'comparison', 'keyframe-grouper.js')];

  for (const candidate of candidates) {
    try {
      return fs.readFileSync(candidate, 'utf8');
    } catch {
      void 0;
    }
  }
  throw new Error('keyframe-grouper.js not found on disk');
}

function _generateYaml({ platform, browserName, screenResolution, region, tunnelName, suiteName }) {
  const tunnelSection = tunnelName ?
  `  tunnel:\n    name: "${tunnelName}"\n` :
  '';

  return `apiVersion: v1alpha
kind: playwright
sauce:
  region: ${region}
  concurrency: 1
${tunnelSection}
playwright:
  version: 1.52.0

suites:
  - name: "${suiteName}"
    platformName: "${platform}"
    screenResolution: "${screenResolution}"
    params:
      browserName: "${browserName}"
      headless: false
    testMatch: ["tests/extract.spec.js"]

artifacts:
  download:
    when: always
    match: ["extraction-result.json", "screenshots-manifest.json", "keyframe-*.webp"]
    directory: ./artifacts/
`;
}

function _convertEsmToCjs(source) {
  let cjs = source.replace(/export\s*\{[^}]*\}\s*;?/g, '');
  cjs = cjs.replace(/export\s+(function|const|let|var)\s/g, '$1 ');
  return cjs;
}

function _buildGrouperInlineSource() {
  const raw = _getKeyframeGrouperSource();
  return _convertEsmToCjs(raw);
}

function _generateTestScript({ url, filters, maxScreenshots }) {
  const extractorBundle = _getExtractorBundleSource();
  const grouperSource = _buildGrouperInlineSource();
  const configOverrides = JSON.stringify({
    extraction: {
      batchHardCapMs: 30,
      maxElements: 10_000,
      skipInvisible: true,
      stabilityWindowMs: 500,
      hardTimeoutMs: 20_000
    }
  });
  const filtersJson = filters ? JSON.stringify(filters) : 'null';
  const maxKf = maxScreenshots || 200;

  return `const { test } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const EXTRACTOR_BUNDLE = ${JSON.stringify(extractorBundle)};

const FILTERS = ${filtersJson};
const CONFIG_OVERRIDES = ${configOverrides};
const MAX_KEYFRAMES = ${maxKf};

function buildSelectorFromFilters(filters) {
  if (!filters) return null;
  const parts = [];
  if (filters.class) {
    const groups = filters.class.trim().split(/[\\s,]+/).filter(Boolean)
      .map((g) => g.trim().split(/\\s+/).filter(Boolean).map((c) => '.' + c.replace(/^\\./, '')).join('')).filter(Boolean);
    if (groups.length) parts.push(groups.join(','));
  }
  if (filters.id) {
    const ids = filters.id.trim().split(/\\s+/).filter(Boolean).map((id) => '#' + id.replace(/^#/, ''));
    if (ids.length) parts.push(ids.join(','));
  }
  if (filters.tag) {
    const tags = filters.tag.trim().split(/\\s+/).filter(Boolean);
    if (tags.length) parts.push(tags.join(','));
  }
  return parts.length > 0 ? parts.join(',') : null;
}

${grouperSource}

test('extract', async ({ page }) => {
  const url = ${JSON.stringify(url)};
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });

  const compoundSelector = buildSelectorFromFilters(FILTERS);
  let waitSelector = compoundSelector;

  if (waitSelector) {
    await page.waitForSelector(waitSelector, { timeout: 30000, state: 'visible' }).catch(() => {});
    await page.waitForFunction(
      (sel) => {
        const count = document.querySelectorAll(sel + ' *').length;
        if (window.__vdiff_prev_desc_count === undefined) { window.__vdiff_prev_desc_count = count; return false; }
        if (window.__vdiff_prev_desc_count !== count) { window.__vdiff_prev_desc_count = count; return false; }
        return count > 0;
      },
      waitSelector,
      { timeout: 30000, polling: 750 }
    ).catch(() => {});
  } else {
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForFunction(
      () => document.readyState === 'complete' && document.querySelectorAll('*').length > 100,
      { timeout: 10000 }
    ).catch(() => {});
  }

  await page.addScriptTag({ content: EXTRACTOR_BUNDLE });

  const report = await page.evaluate(
    ({ filters, cfg }) => window.__uiCompare.extractWithConfig(filters, cfg),
    { filters: compoundSelector ? FILTERS : null, cfg: CONFIG_OVERRIDES }
  );

  fs.writeFileSync('extraction-result.json', JSON.stringify(report));

  const elements = report.elements || [];
  if (elements.length === 0) return;

  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    documentHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
  }));

  const selectorPairs = elements
    .filter((el) => el.cssSelector)
    .map((el) => ({ id: el.hpid, selector: el.cssSelector }));

  const rects = await page.evaluate((pairs) => {
    return pairs.map((p) => {
      const els = document.querySelectorAll(p.selector);
      if (els.length === 0) return { id: p.id, found: false };
      const el = els[0];
      const rect = el.getBoundingClientRect();
      const scrollY = window.scrollY;
      return {
        id: p.id,
        found: true,
        usable: rect.width > 0 && rect.height > 0,
        documentY: rect.top + scrollY,
        height: rect.height,
        width: rect.width,
        viewportX: rect.left,
        viewportY: rect.top,
      };
    });
  }, selectorPairs);

  const validRects = rects.filter((r) => r.found && r.usable);
  if (validRects.length === 0) {
    fs.writeFileSync('screenshots-manifest.json', JSON.stringify({ keyframes: [], elementKeyframeMap: {} }));
    return;
  }

  let keyframes = groupIntoKeyframes(validRects, viewport.height, viewport.width, viewport.documentHeight);

  if (keyframes.length > MAX_KEYFRAMES) {
    keyframes.sort((a, b) => b.elementIds.length - a.elementIds.length);
    keyframes = keyframes.slice(0, MAX_KEYFRAMES);
    keyframes.sort((a, b) => a.scrollY - b.scrollY);
    for (let i = 0; i < keyframes.length; i++) {
      keyframes[i].id = 'kf_' + i;
    }
  }

  const elementKeyframeMap = {};
  for (const kf of keyframes) {
    for (const elId of kf.elementIds) {
      elementKeyframeMap[elId] = kf.id;
    }
  }

  const freezeStyle = \`*, *::before, *::after { animation-play-state: paused !important; transition-duration: 0s !important; scroll-behavior: auto !important; }\`;
  await page.evaluate((css) => {
    const style = document.createElement('style');
    style.id = 'vdiff-freeze-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }, freezeStyle);

  for (let i = 0; i < keyframes.length; i++) {
    const kf = keyframes[i];
    await page.evaluate((y) => window.scrollTo(0, y), kf.scrollY);
    await page.waitForTimeout(300);
    const screenshot = await page.screenshot({ type: 'webp', quality: 85, fullPage: false });
    fs.writeFileSync('keyframe-' + i + '.webp', screenshot);
  }

  fs.writeFileSync('screenshots-manifest.json', JSON.stringify({
    keyframes: keyframes.map((kf, i) => ({
      id: kf.id,
      scrollY: kf.scrollY,
      viewportWidth: kf.viewportWidth,
      viewportHeight: kf.viewportHeight,
      elementIds: kf.elementIds,
      filename: 'keyframe-' + i + '.webp',
    })),
    elementKeyframeMap,
  }));
});
`;
}

function _tmpDir(jobId) {
  return path.join(os.tmpdir(), 'ui-comparison-saucelabs', jobId);
}

function _artifactDir(jobId) {
  return path.join(app.getPath('userData'), 'saucelabs-artifacts', jobId);
}

function _pollIntervalForElapsed(elapsedMs) {
  for (const bucket of POLL_INTERVALS) {
    if (elapsedMs < bucket.maxElapsedMs) return bucket.intervalMs;
  }
  return 60_000;
}

function _stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(new RegExp('\\x1b\\[[0-9;]*m', 'g'), '').trim();
}

function _redactSecrets(str, accessKey) {
  if (!str) return str;
  let out = str;
  if (accessKey && typeof accessKey === 'string' && accessKey.length >= 8) {
    out = out.split(accessKey).join('***REDACTED***');
  }
  return out;
}

function _summariseSaucectlFailure(result, accessKey) {
  const stdout = _redactSecrets(_stripAnsi(result.stdout || ''), accessKey);
  const stderr = _redactSecrets(_stripAnsi(result.stderr || ''), accessKey);
  const parts = [];
  if (stderr) parts.push(`stderr: ${stderr.slice(-1500)}`);
  if (stdout) parts.push(`stdout: ${stdout.slice(-1500)}`);
  return parts.join(' | ') || '(no output captured)';
}

const KNOWN_SAUCE_FAILURE_PATTERNS = [
/concurrent session limit/i,
/Job not started/i,
/Authorization failed/i,
/unable to determine available versions/i];


function _cleanSauceFailureLine(line) {


  const quoted = line.match(/error="([^"]+)"/);
  if (quoted) return quoted[1].trim();

  return line.replace(/^\d{1,2}:\d{2}:\d{2}\s+(?:ERR|WRN|INF|DBG|FTL)\s+/i, '').trim();
}

function _detectKnownSauceFailure(stdout, stderr) {
  const lines = [
  ..._stripAnsi(stdout || '').split(/\r?\n/),
  ..._stripAnsi(stderr || '').split(/\r?\n/)];

  for (const pattern of KNOWN_SAUCE_FAILURE_PATTERNS) {
    for (const line of lines) {
      if (pattern.test(line)) {
        return _cleanSauceFailureLine(line);
      }
    }
  }
  return null;
}

function _toUuidWithDashes(hex) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const _UUID_PATTERN = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const _REJECT_LABEL_RE = /(?:storageId|checksum|config)\s*[:=]?\s*$/i;

function _parseSauceSessionId(stdout) {
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

async function _pollSessionUntilDone({ username, accessKey, region, sessionId, timeoutMs, onProgress, jobId, externalSignal }) {
  const host = _regionHost(region);
  const auth = _basicAuth(username, accessKey);
  const startTime = Date.now();
  const jobSignal = _getJobSignal(jobId);
  const isAborted = () => jobSignal?.aborted || externalSignal?.aborted;
  const MAX_CONSECUTIVE_ERRORS = 8;
  let consecutiveErrors = 0;
  let polling = true;

  while (polling) {
    if (isAborted()) return { status: 'cancelled', error: 'Cancelled' };

    const elapsed = Date.now() - startTime;
    if (elapsed >= timeoutMs) {
      return { status: 'timed_out', error: 'SauceLabs session exceeded polling timeout' };
    }

    let response;
    try {
      response = await _request({
        hostname: host,
        path: `/rest/v1/${encodeURIComponent(username)}/jobs/${sessionId}`,
        method: 'GET',
        headers: {
          'Authorization': `Basic ${auth}`,
          'User-Agent': 'ui-comparison-desktop'
        }
      });
    } catch (err) {
      consecutiveErrors += 1;
      log.warn('[SauceManager] poll network error', { sessionId, error: err.message, consecutiveErrors });
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        return { status: 'failed', error: `SauceLabs API unreachable after ${consecutiveErrors} retries: ${err.message}` };
      }
      await _interruptibleSleep(_backoffForErrors(consecutiveErrors, elapsed), jobSignal, externalSignal);
      continue;
    }

    if (response.statusCode === 401) {
      return { status: 'failed', error: 'Credentials expired during polling' };
    }

    if (response.statusCode === 429) {
      consecutiveErrors += 1;
      log.warn('[SauceManager] poll rate-limited (429)', { sessionId, consecutiveErrors });
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        return { status: 'failed', error: 'SauceLabs API rate-limited (429)' };
      }
      await _interruptibleSleep(_backoffForErrors(consecutiveErrors, elapsed), jobSignal, externalSignal);
      continue;
    }

    if (response.statusCode !== 200) {
      consecutiveErrors += 1;
      log.warn('[SauceManager] poll unexpected status', { sessionId, status: response.statusCode, consecutiveErrors });
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        return { status: 'failed', error: `SauceLabs API returned ${response.statusCode} repeatedly` };
      }
      await _interruptibleSleep(_backoffForErrors(consecutiveErrors, elapsed), jobSignal, externalSignal);
      continue;
    }

    let job;
    try {
      job = JSON.parse(response.body);
    } catch {
      consecutiveErrors += 1;
      await _interruptibleSleep(_backoffForErrors(consecutiveErrors, elapsed), jobSignal, externalSignal);
      continue;
    }

    consecutiveErrors = 0;
    const sauceStatus = (job.status || '').toLowerCase();

    if (sauceStatus === 'complete' || sauceStatus === 'passed') {
      onProgress?.({ phase: 'session_complete', sessionId });
      return { status: 'complete', job };
    }

    if (sauceStatus === 'error' || sauceStatus === 'failed') {
      return { status: 'failed', error: job.error || `SauceLabs session ${sauceStatus}` };
    }

    onProgress?.({ phase: 'running', sessionId, sauceStatus });
    await _interruptibleSleep(_pollIntervalForElapsed(elapsed), jobSignal, externalSignal);
  }
}

function _backoffForErrors(consecutiveErrors, elapsedMs) {
  const baseInterval = _pollIntervalForElapsed(elapsedMs);
  const factor = Math.min(2 ** Math.max(0, consecutiveErrors - 1), 8);
  return Math.min(baseInterval * factor, 5 * 60 * 1000);
}

function _interruptibleSleep(ms, ...signals) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {if (done) return;done = true;clearTimeout(timer);cleanup();resolve();};
    const timer = setTimeout(finish, ms);
    const liveSignals = signals.filter(Boolean);
    const onAbort = () => finish();
    for (const sig of liveSignals) {
      if (sig.aborted) {finish();return;}
      sig.addEventListener('abort', onAbort, { once: true });
    }
    function cleanup() {
      for (const sig of liveSignals) {
        sig.removeEventListener('abort', onAbort);
      }
    }
  });
}

async function _downloadArtifact({ username, accessKey, region, sessionId, filename, destPath }) {
  const host = _regionHost(region);
  const auth = _basicAuth(username, accessKey);

  const response = await _requestBinary({
    hostname: host,
    path: `/rest/v1/${encodeURIComponent(username)}/jobs/${sessionId}/assets/${encodeURIComponent(filename)}`,
    method: 'GET',
    headers: {
      'Authorization': `Basic ${auth}`,
      'User-Agent': 'ui-comparison-desktop'
    }
  });

  if (response.statusCode !== 200) {
    throw new Error(`Artifact download failed: HTTP ${response.statusCode} for ${filename}`);
  }

  if (!response.buffer || response.buffer.length === 0) {
    throw new Error(`Artifact empty: ${filename}`);
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, response.buffer);
  return destPath;
}

async function _spawnSaucectl({ binPath, configDir, username, accessKey, jobId }) {
  return new Promise((resolve, reject) => {
    const { executable, prefixArgs } = sauceBinaryManager.resolveSpawnCommand(binPath);
    const proc = spawn(executable, [...prefixArgs, 'run', '--config', path.join(configDir, '.sauce', 'config.yml')], {
      env: {
        ...process.env,
        SAUCE_USERNAME: username,
        SAUCE_ACCESS_KEY: accessKey
      },
      cwd: configDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    _trackProc(jobId, proc);

    let stdout = '';
    let stderr = '';
    let cancelled = false;

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();


      const sid = _parseSauceSessionId(stdout);
      if (sid) _trackSessionId(jobId, sid);
    });
    proc.stderr.on('data', (chunk) => {stderr += chunk.toString();});

    const timeoutMs = defaultsConfig?.saucelabs?.saucectlTimeoutMs ?? 10 * 60 * 1000;
    const timeout = setTimeout(() => {
      try {proc.kill('SIGKILL');} catch {void 0;}
      reject(new Error(`saucectl timed out after ${Math.round(timeoutMs / 60000)} minutes`));
    }, timeoutMs);

    let cancelListener = null;
    const signal = _getJobSignal(jobId);
    if (signal) {
      cancelListener = () => {
        cancelled = true;
        try {proc.kill('SIGTERM');} catch {void 0;}
        setTimeout(() => {try {proc.kill('SIGKILL');} catch {void 0;}}, 3000).unref?.();
      };
      if (signal.aborted) cancelListener();else
      signal.addEventListener('abort', cancelListener, { once: true });
    }

    const cleanup = () => {
      clearTimeout(timeout);
      _untrackProc(jobId, proc);
      if (signal && cancelListener) signal.removeEventListener('abort', cancelListener);
    };

    proc.on('error', (err) => {
      cleanup();
      reject(err);
    });

    proc.on('close', (code) => {
      cleanup();
      if (cancelled) {
        reject(new JobCancelledError(jobId));
        return;
      }
      if (code !== 0) {
        log.warn('[SauceManager] saucectl exit', _sanitise({
          code,
          stdout: _redactSecrets(_stripAnsi(stdout), accessKey).slice(-2000),
          stderr: _redactSecrets(_stripAnsi(stderr), accessKey).slice(-2000)
        }));
      }
      resolve({ code, stdout, stderr });
    });
  });
}

async function _recoverSessionId({ username, accessKey, region }) {
  const host = _regionHost(region);
  const auth = _basicAuth(username, accessKey);

  const response = await _request({
    hostname: host,
    path: `/rest/v1/${encodeURIComponent(username)}/jobs?limit=1`,
    method: 'GET',
    headers: {
      'Authorization': `Basic ${auth}`,
      'User-Agent': 'ui-comparison-desktop'
    }
  });

  if (response.statusCode !== 200) {
    throw new Error(`Failed to list jobs: HTTP ${response.statusCode}`);
  }

  const jobs = JSON.parse(response.body);
  if (!Array.isArray(jobs) || jobs.length === 0) {
    throw new Error('No recent jobs found on SauceLabs');
  }

  return jobs[0].id;
}

async function submitExtraction({ jobId: providedJobId, username, accessKey, region, url, platform, browserName, screenResolution, tunnelName, filters, onProgress }) {
  const jobId = providedJobId || crypto.randomUUID();
  _registerJob(jobId, { username, accessKey, region });
  const pollTimeoutMs = defaultsConfig?.saucelabs?.pollTimeoutMs ?? 90 * 60 * 1000;
  const maxScreenshots = defaultsConfig?.saucelabs?.maxScreenshotsPerSession ?? 200;

  const binPath = sauceBinaryManager.getResolvedPath();
  if (!binPath) {
    throw new Error('saucectl binary not available — validate credentials first');
  }

  const tmpBase = _tmpDir(jobId);
  const sauceDir = path.join(tmpBase, '.sauce');
  const testsDir = path.join(tmpBase, 'tests');
  fs.mkdirSync(sauceDir, { recursive: true });
  fs.mkdirSync(testsDir, { recursive: true });

  const yaml = _generateYaml({
    platform,
    browserName,
    screenResolution,
    region,
    tunnelName,
    suiteName: `extract-${jobId.slice(0, 8)}`
  });
  fs.writeFileSync(path.join(sauceDir, 'config.yml'), yaml);

  const testScript = _generateTestScript({ url, filters, maxScreenshots });
  fs.writeFileSync(path.join(testsDir, 'extract.spec.js'), testScript);

  log.info('[SauceManager] submitting extraction', { jobId, url, platform, browserName });
  onProgress?.({ phase: 'submitted', jobId });

  let sessionId;
  try {
    const result = await _spawnSaucectl({ binPath, configDir: tmpBase, username, accessKey, jobId });

    const knownFailure = _detectKnownSauceFailure(result.stdout, result.stderr);
    if (knownFailure) {
      _cleanupTmp(tmpBase);
      throw Object.assign(new Error(knownFailure), { _sauceKnownFailure: true });
    }

    sessionId = _parseSauceSessionId(result.stdout);

    if (!sessionId) {
      if (result.code === 0) {
        sessionId = await _recoverSessionId({ username, accessKey, region });
      } else {
        _cleanupTmp(tmpBase);
        const errDetail = _summariseSaucectlFailure(result, accessKey);
        throw new Error(`saucectl failed (exit code ${result.code}): ${errDetail}`);
      }
    } else if (result.code !== 0) {
      log.info('[SauceManager] saucectl exited non-zero but session was created — proceeding to poll', {
        sessionId, code: result.code
      });
    }
    if (sessionId) _trackSessionId(jobId, sessionId);
  } catch (err) {
    _cleanupTmp(tmpBase);
    if (err._sauceKnownFailure || err._sauceJobCancelled) throw err;
    throw err;
  }

  _throwIfCancelled(jobId);

  log.info('[SauceManager] session started', { jobId, sessionId });
  onProgress?.({ phase: 'running', jobId, sessionId });

  const pollResult = await _pollSessionUntilDone({
    username,
    accessKey,
    region,
    sessionId,
    timeoutMs: pollTimeoutMs,
    onProgress,
    jobId
  });

  _cleanupTmp(tmpBase);

  if (pollResult.status === 'cancelled') {
    throw new JobCancelledError(jobId);
  }

  if (pollResult.status !== 'complete') {
    throw new Error(pollResult.error || `Session ended with status: ${pollResult.status}`);
  }

  onProgress?.({ phase: 'downloading', jobId, sessionId });

  const artifactsDir = _artifactDir(jobId);
  fs.mkdirSync(artifactsDir, { recursive: true });

  const extractionPath = path.join(artifactsDir, 'extraction-result.json');
  await _downloadArtifact({
    username, accessKey, region, sessionId,
    filename: 'extraction-result.json',
    destPath: extractionPath
  });

  let manifestPath = null;
  try {
    manifestPath = path.join(artifactsDir, 'screenshots-manifest.json');
    await _downloadArtifact({
      username, accessKey, region, sessionId,
      filename: 'screenshots-manifest.json',
      destPath: manifestPath
    });
  } catch {
    manifestPath = null;
  }

  let manifest = null;
  if (manifestPath) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.keyframes && manifest.keyframes.length > 0) {
        for (const kf of manifest.keyframes) {
          if (kf.filename) {
            try {
              await _downloadArtifact({
                username, accessKey, region, sessionId,
                filename: kf.filename,
                destPath: path.join(artifactsDir, kf.filename)
              });
            } catch (err) {
              log.warn('[SauceManager] keyframe download failed', { filename: kf.filename, error: err.message });
            }
          }
        }
      }
    } catch (err) {
      log.warn('[SauceManager] manifest parse failed', { error: err.message });
      manifest = null;
    }
  }

  const extractionRaw = fs.readFileSync(extractionPath, 'utf8');
  const report = JSON.parse(extractionRaw);

  report.id = crypto.randomUUID();
  report.engine = browserName;
  report.platform = platform;
  report.sauceSessionId = sessionId;
  report.sauceJobId = jobId;

  onProgress?.({ phase: 'done', jobId, sessionId });

  log.info('[SauceManager] extraction complete', {
    jobId, sessionId, elementCount: report?.elements?.length ?? 0
  });

  return {
    jobId,
    sessionId,
    report,
    manifest,
    artifactsDir
  };
}

function _cleanupTmp(tmpBase) {
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch (err) {
    log.warn('[SauceManager] tmp cleanup failed', { path: tmpBase, error: err.message });
  }
}

function cleanupArtifacts(jobId) {
  const dir = _artifactDir(jobId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn('[SauceManager] artifact cleanup failed', { jobId, error: err.message });
  }
}

function cleanupOrphanedTmpDirs() {
  const baseDir = path.join(os.tmpdir(), 'ui-comparison-saucelabs');
  try {
    if (!fs.existsSync(baseDir)) return;
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = path.join(baseDir, entry.name);
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
          log.info('[SauceManager] cleaned orphaned tmp', { dir: entry.name });
        } catch {
          void 0;
        }
      }
    }
  } catch {
    void 0;
  }
}

async function _submitSingleSession({ username, accessKey, region, url, platform, browserName, screenResolution, tunnelName, filters, side, jobId }) {
  const pollTimeoutMs = defaultsConfig?.saucelabs?.pollTimeoutMs ?? 90 * 60 * 1000;
  const maxScreenshots = defaultsConfig?.saucelabs?.maxScreenshotsPerSession ?? 200;

  const binPath = sauceBinaryManager.getResolvedPath();
  if (!binPath) {
    throw new Error('saucectl binary not available');
  }

  const tmpBase = path.join(_tmpDir(jobId), side);
  const sauceDir = path.join(tmpBase, '.sauce');
  const testsDir = path.join(tmpBase, 'tests');
  fs.mkdirSync(sauceDir, { recursive: true });
  fs.mkdirSync(testsDir, { recursive: true });

  const yaml = _generateYaml({
    platform,
    browserName,
    screenResolution,
    region,
    tunnelName,
    suiteName: `${side}-${jobId.slice(0, 8)}`
  });
  fs.writeFileSync(path.join(sauceDir, 'config.yml'), yaml);

  const testScript = _generateTestScript({ url, filters, maxScreenshots });
  fs.writeFileSync(path.join(testsDir, 'extract.spec.js'), testScript);

  let sessionId;
  try {
    const result = await _spawnSaucectl({ binPath, configDir: tmpBase, username, accessKey, jobId });

    const knownFailure = _detectKnownSauceFailure(result.stdout, result.stderr);
    if (knownFailure) {
      _cleanupTmp(tmpBase);
      throw Object.assign(new Error(knownFailure), { _sauceKnownFailure: true });
    }

    sessionId = _parseSauceSessionId(result.stdout);

    if (!sessionId) {
      if (result.code === 0) {
        sessionId = await _recoverSessionId({ username, accessKey, region });
      } else {
        _cleanupTmp(tmpBase);
        const errDetail = _summariseSaucectlFailure(result, accessKey);
        throw new Error(`saucectl failed (${side}, exit code ${result.code}): ${errDetail}`);
      }
    } else if (result.code !== 0) {
      log.info('[SauceManager] saucectl exited non-zero but session was created — proceeding to poll', {
        side, sessionId, code: result.code
      });
    }
    if (sessionId) _trackSessionId(jobId, sessionId);
  } catch (err) {
    _cleanupTmp(tmpBase);
    if (err._sauceKnownFailure || err._sauceJobCancelled) throw err;
    throw err;
  }

  _cleanupTmp(tmpBase);
  return { sessionId, pollTimeoutMs };
}

async function _downloadSessionArtifacts({ username, accessKey, region, sessionId, destDir }) {
  fs.mkdirSync(destDir, { recursive: true });

  const extractionPath = path.join(destDir, 'extraction-result.json');
  if (!fs.existsSync(extractionPath)) {
    await _downloadArtifact({
      username, accessKey, region, sessionId,
      filename: 'extraction-result.json',
      destPath: extractionPath
    });
  }

  let manifest = null;
  const manifestPath = path.join(destDir, 'screenshots-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    try {
      await _downloadArtifact({
        username, accessKey, region, sessionId,
        filename: 'screenshots-manifest.json',
        destPath: manifestPath
      });
    } catch {
      log.warn('[SauceManager] manifest download failed, continuing without screenshots');
    }
  }

  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.keyframes && manifest.keyframes.length > 0) {
        for (const kf of manifest.keyframes) {
          if (kf.filename) {
            const kfPath = path.join(destDir, kf.filename);
            if (!fs.existsSync(kfPath)) {
              try {
                await _downloadArtifact({
                  username, accessKey, region, sessionId,
                  filename: kf.filename,
                  destPath: kfPath
                });
              } catch (err) {
                log.warn('[SauceManager] keyframe download failed', { filename: kf.filename, error: err.message });
              }
            }
          }
        }
      }
    } catch (err) {
      log.warn('[SauceManager] manifest parse failed', { error: err.message });
      manifest = null;
    }
  }

  const report = JSON.parse(fs.readFileSync(extractionPath, 'utf8'));
  return { report, manifest };
}

async function _cancelRemoteSessions({ username, accessKey, region, sessionIds }) {
  const host = _regionHost(region);
  const auth = _basicAuth(username, accessKey);

  const results = await Promise.allSettled(
    sessionIds.filter(Boolean).map((sessionId) =>
    _request({
      hostname: host,
      path: `/rest/v1/${encodeURIComponent(username)}/jobs/${sessionId}`,
      method: 'DELETE',
      headers: {
        'Authorization': `Basic ${auth}`,
        'User-Agent': 'ui-comparison-desktop'
      }
    }).catch((err) => {
      log.warn('[SauceManager] DELETE session failed', { sessionId, error: err.message });
    })
    )
  );

  return results;
}

async function submitComparison({ jobId: providedJobId, username, accessKey, region, baselineUrl, compareUrl, platform, browserName, screenResolution, tunnelName, filters, onProgress, onSessionId }) {
  const jobId = providedJobId || crypto.randomUUID();
  _registerJob(jobId, { username, accessKey, region });
  const pollTimeoutMs = defaultsConfig?.saucelabs?.pollTimeoutMs ?? 90 * 60 * 1000;

  log.info('[SauceManager] submitComparison', { jobId, baselineUrl, compareUrl, platform, browserName });
  onProgress?.({ phase: 'submitted', jobId });

  const sessionArgs = { username, accessKey, region, platform, browserName, screenResolution, tunnelName, filters, jobId };

  let baselineSessionId, compareSessionId;
  try {
    const [baselineResult, compareResult] = await Promise.all([
    _submitSingleSession({ ...sessionArgs, url: baselineUrl, side: 'baseline' }),
    _submitSingleSession({ ...sessionArgs, url: compareUrl, side: 'compare' })]
    );
    baselineSessionId = baselineResult.sessionId;
    compareSessionId = compareResult.sessionId;
  } catch (err) {
    if (err._sauceKnownFailure || err._sauceJobCancelled) throw err;
    throw new Error(`Session submission failed: ${err.message}`);
  }

  _throwIfCancelled(jobId);

  onSessionId?.({ jobId, baselineSessionId, compareSessionId });
  onProgress?.({ phase: 'running', jobId, baselineSessionId, compareSessionId });



  const siblingAbort = new AbortController();
  const wrapPoll = (sessionId, side) =>
  _pollSessionUntilDone({
    username, accessKey, region, sessionId,
    timeoutMs: pollTimeoutMs,
    onProgress: (p) => onProgress?.({ ...p, side, jobId }),
    jobId,
    externalSignal: siblingAbort.signal
  }).then((result) => {
    if (result.status !== 'complete') {
      try {siblingAbort.abort();} catch {void 0;}
    }
    return result;
  });

  const [baselinePoll, comparePoll] = await Promise.all([
  wrapPoll(baselineSessionId, 'baseline'),
  wrapPoll(compareSessionId, 'compare')]
  );

  const baselineStatus = baselinePoll.status;
  const compareStatus = comparePoll.status;

  if (baselineStatus === 'cancelled' || compareStatus === 'cancelled') {
    _throwIfCancelled(jobId);

  }

  if (baselineStatus !== 'complete' && compareStatus !== 'complete') {
    throw Object.assign(
      new Error(`Both sessions failed: baseline=${baselinePoll.error}, compare=${comparePoll.error}`),
      { baselineStatus, compareStatus, jobId }
    );
  }

  if (baselineStatus !== 'complete' || compareStatus !== 'complete') {
    const failedSide = baselineStatus !== 'complete' ? 'baseline' : 'compare';
    const failedError = failedSide === 'baseline' ? baselinePoll.error : comparePoll.error;
    throw Object.assign(
      new Error(`${failedSide} session failed: ${failedError}`),
      {
        partiallyFailed: true,
        partiallyFailedSession: failedSide,
        baselineSessionId,
        compareSessionId,
        baselineStatus,
        compareStatus,
        jobId
      }
    );
  }

  onProgress?.({ phase: 'downloading', jobId });

  const baselineArtifactDir = path.join(_artifactDir(jobId), 'baseline');
  const compareArtifactDir = path.join(_artifactDir(jobId), 'compare');

  const [baselineData, compareData] = await Promise.all([
  _downloadSessionArtifacts({ username, accessKey, region, sessionId: baselineSessionId, destDir: baselineArtifactDir }),
  _downloadSessionArtifacts({ username, accessKey, region, sessionId: compareSessionId, destDir: compareArtifactDir })]
  );

  const baselineReport = baselineData.report;
  baselineReport.id = crypto.randomUUID();
  baselineReport.engine = browserName;
  baselineReport.platform = platform;
  baselineReport.sauceSessionId = baselineSessionId;
  baselineReport.sauceJobId = jobId;

  const compareReport = compareData.report;
  compareReport.id = crypto.randomUUID();
  compareReport.engine = browserName;
  compareReport.platform = platform;
  compareReport.sauceSessionId = compareSessionId;
  compareReport.sauceJobId = jobId;

  onProgress?.({ phase: 'comparing', jobId });

  log.info('[SauceManager] submitComparison complete', { jobId, baselineSessionId, compareSessionId });

  return {
    jobId,
    baselineSessionId,
    compareSessionId,
    baselineReport,
    compareReport,
    baselineManifest: baselineData.manifest,
    compareManifest: compareData.manifest,
    baselineArtifactDir,
    compareArtifactDir
  };
}

async function retryFailedSession({ username, accessKey, region, failedSide, failedSideUrl, successSideSessionId, platform, browserName, screenResolution, tunnelName, filters, jobId, onProgress }) {
  _registerJob(jobId, { username, accessKey, region });
  const successSide = failedSide === 'baseline' ? 'compare' : 'baseline';

  log.info('[SauceManager] retryFailedSession', { jobId, failedSide, failedSideUrl });
  onProgress?.({ phase: 'running', jobId, side: failedSide });

  const { sessionId, pollTimeoutMs } = await _submitSingleSession({
    username, accessKey, region,
    url: failedSideUrl,
    platform: platform || 'Windows 11',
    browserName: browserName || 'chromium',
    screenResolution: screenResolution || '1920x1080',
    tunnelName: tunnelName || null,
    filters: filters || null,
    side: failedSide,
    jobId
  });

  onProgress?.({ phase: 'running', jobId, side: failedSide, sessionId });

  const pollResult = await _pollSessionUntilDone({
    username, accessKey, region, sessionId,
    timeoutMs: pollTimeoutMs,
    onProgress: (p) => onProgress?.({ ...p, side: failedSide, jobId }),
    jobId
  });

  if (pollResult.status === 'cancelled') {
    throw new JobCancelledError(jobId);
  }

  if (pollResult.status !== 'complete') {
    throw Object.assign(
      new Error(`Retry session failed: ${pollResult.error || pollResult.status}`),
      { partiallyFailed: true, partiallyFailedSession: failedSide, jobId }
    );
  }

  onProgress?.({ phase: 'downloading', jobId });

  const retriedArtifactDir = path.join(_artifactDir(jobId), failedSide);
  const successArtifactDir = path.join(_artifactDir(jobId), successSide);

  const [retriedData, successData] = await Promise.all([
  _downloadSessionArtifacts({ username, accessKey, region, sessionId, destDir: retriedArtifactDir }),
  _downloadSessionArtifacts({ username, accessKey, region, sessionId: successSideSessionId, destDir: successArtifactDir })]
  );

  const retriedReport = retriedData.report;
  retriedReport.id = crypto.randomUUID();
  retriedReport.engine = browserName;
  retriedReport.platform = platform;
  retriedReport.sauceSessionId = sessionId;
  retriedReport.sauceJobId = jobId;

  const successReport = successData.report;
  successReport.id = crypto.randomUUID();
  successReport.engine = browserName;
  successReport.platform = platform;
  successReport.sauceSessionId = successSideSessionId;
  successReport.sauceJobId = jobId;

  onProgress?.({ phase: 'comparing', jobId });

  const baselineReport = failedSide === 'baseline' ? retriedReport : successReport;
  const compareReport = failedSide === 'compare' ? retriedReport : successReport;
  const baselineManifest = failedSide === 'baseline' ? retriedData.manifest : successData.manifest;
  const compareManifest = failedSide === 'compare' ? retriedData.manifest : successData.manifest;

  log.info('[SauceManager] retryFailedSession complete', { jobId, sessionId });

  return {
    jobId,
    baselineSessionId: failedSide === 'baseline' ? sessionId : successSideSessionId,
    compareSessionId: failedSide === 'compare' ? sessionId : successSideSessionId,
    baselineReport,
    compareReport,
    baselineManifest,
    compareManifest,
    baselineArtifactDir: path.join(_artifactDir(jobId), 'baseline'),
    compareArtifactDir: path.join(_artifactDir(jobId), 'compare')
  };
}

function _withRegistryCleanup(fn) {
  return async function wrapped(args = {}) {
    const providedJobId = args.jobId;
    try {
      const result = await fn(args);
      if (providedJobId) _unregisterJob(providedJobId);else
      if (result?.jobId) _unregisterJob(result.jobId);
      return result;
    } catch (err) {
      if (providedJobId) _unregisterJob(providedJobId);else
      if (err?.jobId) _unregisterJob(err.jobId);
      throw err;
    }
  };
}

module.exports = {
  validateCredentials,
  submitExtraction: _withRegistryCleanup(submitExtraction),
  submitComparison: _withRegistryCleanup(submitComparison),
  retryFailedSession: _withRegistryCleanup(retryFailedSession),
  cleanupArtifacts,
  cleanupOrphanedTmpDirs,
  cancelJob,
  _cancelRemoteSessions,
  _sanitise
};