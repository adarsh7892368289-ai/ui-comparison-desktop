'use strict';

import { getState, subscribe } from '../state.js';
import {
  validateAndStoreCredentials,
  getCredentials,
  submitExtraction,
  submitComparison,
  cancelSauceJob,
  retrySauceJob,
  resetSauceJob,
  loadSauceComparisonResult,
} from
'../application/saucelabs-workflow.js';
import { handleSauceFullReport } from '../application/export-workflow.js';
import { relativeTime } from '../utils/time.js';
import { collectFilters } from '@core/saucelabs-bridge/filter-input.js';

const REGIONS = [
{ value: 'us-west-1', label: 'US West 1' },
{ value: 'us-east-4', label: 'US East 4' },
{ value: 'eu-central-1', label: 'EU Central 1' }];


const PLATFORMS = [
'Windows 10', 'Windows 11',
'macOS 12', 'macOS 13', 'macOS 14', 'macOS 15'];


const BROWSERS = [
{ value: 'chromium', label: 'Chromium' },
{ value: 'chrome', label: 'Chrome' },
{ value: 'firefox', label: 'Firefox' },
{ value: 'webkit', label: 'WebKit' }];


const RESOLUTIONS = [
'1024x768', '1280x960', '1280x1024', '1440x900',
'1600x1200', '1680x1050', '1920x1080', '1920x1200'];


export function createSauceLabsPanel(hostEl) {
  hostEl.innerHTML = '';

  const panel = document.createElement('div');
  panel.className = 'saucelabs-panel';

  panel.innerHTML = `
    <div class="saucelabs-panel__credentials card">
      <h3 class="card-title">SauceLabs Credentials</h3>
      <p class="saucelabs-panel__hint">Credentials are stored in memory only and cleared on app restart.</p>

      <div class="form-field">
        <label class="label" for="sauce-username">Username</label>
        <input class="input" id="sauce-username" type="text" placeholder="Your SauceLabs username" autocomplete="off">
      </div>

      <div class="form-field">
        <label class="label" for="sauce-access-key">Access Key</label>
        <input class="input" id="sauce-access-key" type="password" placeholder="Your SauceLabs access key" autocomplete="off">
      </div>

      <div class="form-field">
        <label class="label" for="sauce-region">Region</label>
        <select class="input" id="sauce-region"></select>
      </div>

      <div class="saucelabs-panel__actions">
        <button type="button" class="btn-primary btn-sm" id="sauce-validate-btn">Validate</button>
      </div>

      <div class="saucelabs-panel__status" id="sauce-credential-status" aria-live="polite"></div>
    </div>

    <div class="saucelabs-panel__job-config card" id="sauce-job-config-section" hidden>
      <h3 class="card-title">Compare on SauceLabs</h3>

      <div class="form-field">
        <label class="label" for="sauce-baseline-url">Baseline URL</label>
        <input class="input" id="sauce-baseline-url" type="url" placeholder="https://baseline.example.com" autocomplete="off">
      </div>

      <div class="form-field">
        <label class="label" for="sauce-compare-url">Compare URL</label>
        <input class="input" id="sauce-compare-url" type="url" placeholder="https://compare.example.com" autocomplete="off">
      </div>

      <div class="form-row">
        <div class="form-field form-field--half">
          <label class="label" for="sauce-platform">Platform</label>
          <select class="input" id="sauce-platform"></select>
        </div>
        <div class="form-field form-field--half">
          <label class="label" for="sauce-browser">Browser</label>
          <select class="input" id="sauce-browser"></select>
        </div>
      </div>

      <div class="form-row">
        <div class="form-field form-field--half">
          <label class="label" for="sauce-resolution">Resolution</label>
          <select class="input" id="sauce-resolution"></select>
        </div>
        <div class="form-field form-field--half">
          <label class="label" for="sauce-tunnel">Tunnel (optional)</label>
          <input class="input" id="sauce-tunnel" type="text" placeholder="tunnel-name" autocomplete="off">
        </div>
      </div>

      <div class="card-header">
        <h4 class="card-title">Filters</h4>
        <span class="badge-optional">optional</span>
      </div>
      <div class="filter-grid">
        <div class="form-field">
          <label class="label" for="sauce-filter-class">Class</label>
          <input class="input" id="sauce-filter-class" type="text" placeholder="e.g. btn" autocomplete="off" maxlength="500">
        </div>
        <div class="form-field">
          <label class="label" for="sauce-filter-id">ID</label>
          <input class="input" id="sauce-filter-id" type="text" placeholder="e.g. header" autocomplete="off" maxlength="200">
        </div>
        <div class="form-field">
          <label class="label" for="sauce-filter-tag">Tag</label>
          <input class="input" id="sauce-filter-tag" type="text" placeholder="e.g. button" autocomplete="off" maxlength="200">
        </div>
      </div>
      <div class="saucelabs-panel__filter-error" id="sauce-filter-error" role="alert" aria-live="polite" hidden></div>

      <div class="saucelabs-panel__actions">
        <button type="button" class="btn-primary" id="sauce-compare-btn">Run Comparison on SauceLabs</button>
        <button type="button" class="btn-secondary btn-sm" id="sauce-extract-btn">Extract Only</button>
      </div>
    </div>

    <div class="saucelabs-panel__job-status card" id="sauce-job-section" hidden>
      <h3 class="card-title">Job Status</h3>
      <div class="saucelabs-panel__job-card" id="sauce-job-card"></div>
    </div>

    <div class="saucelabs-panel__result-section card" id="sauce-result-section" hidden>
      <div id="sauce-result-host"></div>
    </div>
  `;

  hostEl.appendChild(panel);

  const regionSelect = panel.querySelector('#sauce-region');
  for (const r of REGIONS) {
    const opt = document.createElement('option');
    opt.value = r.value;
    opt.textContent = r.label;
    regionSelect.appendChild(opt);
  }

  const platformSelect = panel.querySelector('#sauce-platform');
  for (const p of PLATFORMS) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    if (p === 'Windows 11') opt.selected = true;
    platformSelect.appendChild(opt);
  }

  const browserSelect = panel.querySelector('#sauce-browser');
  for (const b of BROWSERS) {
    const opt = document.createElement('option');
    opt.value = b.value;
    opt.textContent = b.label;
    browserSelect.appendChild(opt);
  }

  const resolutionSelect = panel.querySelector('#sauce-resolution');
  for (const r of RESOLUTIONS) {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r;
    if (r === '1920x1080') opt.selected = true;
    resolutionSelect.appendChild(opt);
  }

  const usernameInput = panel.querySelector('#sauce-username');
  const accessKeyInput = panel.querySelector('#sauce-access-key');
  const validateBtn = panel.querySelector('#sauce-validate-btn');
  const statusEl = panel.querySelector('#sauce-credential-status');
  const configSection = panel.querySelector('#sauce-job-config-section');
  const baselineUrlInput = panel.querySelector('#sauce-baseline-url');
  const compareUrlInput = panel.querySelector('#sauce-compare-url');
  const tunnelInput = panel.querySelector('#sauce-tunnel');
  const filterClassInput = panel.querySelector('#sauce-filter-class');
  const filterIdInput = panel.querySelector('#sauce-filter-id');
  const filterTagInput = panel.querySelector('#sauce-filter-tag');
  const filterErrorEl = panel.querySelector('#sauce-filter-error');
  const compareBtn = panel.querySelector('#sauce-compare-btn');
  const extractBtn = panel.querySelector('#sauce-extract-btn');
  const jobSection = panel.querySelector('#sauce-job-section');
  const jobCard = panel.querySelector('#sauce-job-card');
  const resultSection = panel.querySelector('#sauce-result-section');
  const resultHost = panel.querySelector('#sauce-result-host');
  let lastRenderedComparisonId = null;

  function renderCredentialStatus(state) {
    const credState = state.sauceCredentialState;
    const error = state.sauceCredentialError;

    statusEl.className = 'saucelabs-panel__status';
    validateBtn.disabled = credState === 'validating';

    switch (credState) {
      case 'validating':
        statusEl.textContent = 'Validating...';
        statusEl.classList.add('saucelabs-panel__status--validating');
        break;
      case 'valid':
        statusEl.innerHTML = '<span class="saucelabs-panel__check" aria-hidden="true"></span> Connected';
        statusEl.classList.add('saucelabs-panel__status--valid');
        configSection.hidden = false;
        break;
      case 'credentials_required':
        statusEl.textContent = `${state.sauceInFlightJobCount ?? 0} job(s) need credentials to resume polling.`;
        statusEl.classList.add('saucelabs-panel__status--error');
        configSection.hidden = true;
        break;
      case 'error':
        statusEl.textContent = error || 'Validation failed';
        statusEl.classList.add('saucelabs-panel__status--error');
        configSection.hidden = true;
        break;
      default:
        statusEl.textContent = '';
        configSection.hidden = true;
        break;
    }
  }

  function renderJobStatus(state) {
    const job = state.sauceJob;
    if (!job) {
      jobSection.hidden = true;
      jobCard.innerHTML = '';
      return;
    }

    jobSection.hidden = false;
    const statusClass = _statusBadgeClass(job.status);
    const statusLabel = _statusLabel(job.status, job.phase);

    const isTerminal = ['done', 'failed', 'cancelled', 'timed_out'].includes(job.status);
    const isRunning = !isTerminal && job.status !== 'partially_failed';

    jobCard.innerHTML = `
      <div class="sauce-job__header">
        <span class="sauce-job__badge ${statusClass}">${statusLabel}</span>
        ${isTerminal ? `<button type="button" class="btn-sm btn-ghost" id="sauce-job-dismiss">Dismiss</button>` : ''}
        ${isRunning ? `<button type="button" class="btn-sm btn-ghost sauce-job__cancel-btn" id="sauce-job-cancel">Cancel</button>` : ''}
      </div>
      <div class="sauce-job__details">
        ${job.baselineUrl ? `<span class="sauce-job__url">${_escapeHtml(job.baselineUrl)}</span>` : ''}
        ${job.compareUrl ? `<span class="sauce-job__url">${_escapeHtml(job.compareUrl)}</span>` : ''}
        ${job.url ? `<span class="sauce-job__url">${_escapeHtml(job.url)}</span>` : ''}
        <span class="sauce-job__meta">${job.platform || ''} / ${job.browserName || ''}</span>
      </div>
      ${job.error ? `<div class="sauce-job__error">${_escapeHtml(job.error)}</div>` : ''}
      ${job.persistWarning ? `<div class="sauce-job__warning">${_escapeHtml(job.persistWarning)}</div>` : ''}
      ${job.persistenceWarning ? `<div class="sauce-job__warning" title="${_escapeHtml(JSON.stringify(job.persistenceWarning.failedSteps || []))}">Some visual data could not be saved — ${_escapeHtml(job.persistenceWarning.summary)}. The report may be missing screenshots or rect overlays.</div>` : ''}
      ${job.status === 'partially_failed' ? `<div class="sauce-job__error">Session failed: ${_escapeHtml(job.partiallyFailedSession || 'unknown')}</div>` : ''}
      ${job.status === 'partially_failed' ? `<div class="sauce-job__retry"><button type="button" class="btn-primary btn-sm" id="sauce-job-retry">Retry Failed Session</button></div>` : ''}
      ${job.comparisonId ? `<div class="sauce-job__result">Comparison complete — view in report list.</div>` : ''}
      ${job.reportId ? `<div class="sauce-job__result">Report saved to library.</div>` : ''}
      ${job.credentialsRequired ? `<div class="sauce-job__error">Re-enter credentials above to resume.</div>` : ''}
    `;

    const dismissBtn = jobCard.querySelector('#sauce-job-dismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => resetSauceJob());
    }

    const cancelBtn = jobCard.querySelector('#sauce-job-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => void cancelSauceJob());
    }

    const retryBtn = jobCard.querySelector('#sauce-job-retry');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        retryBtn.disabled = true;
        void retrySauceJob(job.jobId);
      });
    }
  }

  // Renders the SauceLabs comparison result inline in the SauceLabs tab.
  // Mirrors the Compare tab's result-panel visual structure but is fully
  // owned by SauceLabs (no DOM-id collisions, no shared state.comparison).
  function renderSauceResult(state) {
    const sauceResult = state.sauceComparisonResult;
    if (!sauceResult || !sauceResult.result) {
      resultSection.hidden = true;
      resultHost.replaceChildren();
      lastRenderedComparisonId = null;
      return;
    }
    if (sauceResult.comparisonId === lastRenderedComparisonId) return;
    lastRenderedComparisonId = sauceResult.comparisonId;

    resultSection.hidden = false;
    resultHost.replaceChildren();
    resultHost.appendChild(_buildSauceResultPanel(sauceResult));
  }

  function _validateUrl(input) {
    const val = input.value.trim();
    if (!val) return null;
    try {
      const parsed = new URL(val);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      return val;
    } catch {
      return null;
    }
  }

  function _showFilterError(msg) {
    if (!msg) {
      filterErrorEl.hidden = true;
      filterErrorEl.textContent = '';
      return;
    }
    filterErrorEl.hidden = false;
    filterErrorEl.textContent = msg;
  }

  function _collectFilters() {
    return collectFilters({
      class: filterClassInput.value,
      id: filterIdInput.value,
      tag: filterTagInput.value
    });
  }

  // Clear the inline error as soon as the user edits any filter input.
  for (const el of [filterClassInput, filterIdInput, filterTagInput]) {
    el.addEventListener('input', () => _showFilterError(null));
  }

  validateBtn.addEventListener('click', () => {
    const username = usernameInput.value.trim();
    const accessKey = accessKeyInput.value.trim();
    const region = regionSelect.value;
    void validateAndStoreCredentials({ username, accessKey, region });
  });

  usernameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') validateBtn.click();
  });
  accessKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') validateBtn.click();
  });

  compareBtn.addEventListener('click', () => {
    const baselineUrl = _validateUrl(baselineUrlInput);
    const compareUrl = _validateUrl(compareUrlInput);
    if (!baselineUrl || !compareUrl) return;

    const filterResult = _collectFilters();
    if (!filterResult.ok) {
      _showFilterError(filterResult.error);
      return;
    }
    _showFilterError(null);

    compareBtn.disabled = true;
    extractBtn.disabled = true;
    void submitComparison({
      baselineUrl,
      compareUrl,
      platform: platformSelect.value,
      browserName: browserSelect.value,
      screenResolution: resolutionSelect.value,
      tunnelName: tunnelInput.value.trim() || null,
      filters: filterResult.filters
    });
  });

  extractBtn.addEventListener('click', () => {
    const url = _validateUrl(baselineUrlInput);
    if (!url) return;

    const filterResult = _collectFilters();
    if (!filterResult.ok) {
      _showFilterError(filterResult.error);
      return;
    }
    _showFilterError(null);

    compareBtn.disabled = true;
    extractBtn.disabled = true;
    void submitExtraction({
      url,
      platform: platformSelect.value,
      browserName: browserSelect.value,
      screenResolution: resolutionSelect.value,
      tunnelName: tunnelInput.value.trim() || null,
      filters: filterResult.filters
    });
  });

  const existingCreds = getCredentials();
  if (existingCreds) {
    usernameInput.value = existingCreds.username;
    accessKeyInput.value = existingCreds.accessKey;
    regionSelect.value = existingCreds.region;
  }

  // When a stored comparison job finishes loading and is in 'done' state but
  // we don't yet have its result in state, hydrate it from IDB.
  let lastHydratedJobId = null;
  function maybeHydrateResult(state) {
    const job = state.sauceJob;
    if (!job || job.status !== 'done' || !job.jobId) return;
    if (state.sauceComparisonResult?.jobId === job.jobId) return;
    if (lastHydratedJobId === job.jobId) return;
    lastHydratedJobId = job.jobId;
    void loadSauceComparisonResult(job.jobId);
  }
  const unsubscribe = subscribe((state) => {
    renderCredentialStatus(state);
    renderJobStatus(state);
    renderSauceResult(state);
    maybeHydrateResult(state);
    const isRunning = state.sauceJob && !['done', 'failed', 'cancelled', 'timed_out'].includes(state.sauceJob.status);
    compareBtn.disabled = isRunning;
    extractBtn.disabled = isRunning;
  });

  const currentState = getState();
  renderCredentialStatus(currentState);
  renderJobStatus(currentState);
  renderSauceResult(currentState);
  maybeHydrateResult(currentState);

  return { destroy: unsubscribe };
}

function _statusBadgeClass(status) {
  switch (status) {
    case 'submitted':return 'sauce-job__badge--submitted';
    case 'running':return 'sauce-job__badge--running';
    case 'downloading':return 'sauce-job__badge--running';
    case 'comparing':return 'sauce-job__badge--running';
    case 'done':return 'sauce-job__badge--done';
    case 'failed':return 'sauce-job__badge--failed';
    case 'partially_failed':return 'sauce-job__badge--failed';
    case 'cancelled':return 'sauce-job__badge--failed';
    case 'timed_out':return 'sauce-job__badge--failed';
    default:return '';
  }
}

function _statusLabel(status, phase) {
  switch (status) {
    case 'submitted':return 'Submitted';
    case 'running':return 'Running';
    case 'downloading':return 'Downloading Artifacts';
    case 'comparing':return 'Comparing';
    case 'done':return 'Done';
    case 'failed':return 'Failed';
    case 'partially_failed':return 'Partially Failed';
    case 'cancelled':return 'Cancelled';
    case 'timed_out':return 'Timed Out';
    default:return phase || status || 'Unknown';
  }
}

function _escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Inline SauceLabs result panel — visually parallels Compare's ResultPanel
// but is fully self-contained: no DOM-id collisions with the Compare tab,
// and the Full Report button always opens the SauceLabs comparison.
function _buildSauceResultPanel(sauceResult) {
  const { result, cachedAt, fromCache } = sauceResult;
  const matching = result.matching ?? {};
  const summary = result.comparison?.summary ?? {};
  const mode = result.mode ?? 'dynamic';
  const duration = result.duration ?? 0;

  const sev = summary.severityBreakdown ?? summary.severityCounts ?? {};
  const critical = sev.critical ?? 0;
  const high = sev.high ?? 0;
  const medium = sev.medium ?? 0;
  const low = sev.low ?? 0;
  const sevTotal = (critical + high + medium + low) || 1;

  const totalDifferences = summary.totalDifferences ?? summary.propertyDiffCount ?? 0;
  const modified = matching.modifiedCount ?? summary.modifiedElements ?? 0;
  const unchanged = matching.unchangedCount ?? summary.unchangedElements ?? 0;
  const added = result.unmatchedElements?.compare ?? [];
  const removed = result.unmatchedElements?.baseline ?? [];
  const total = matching.totalElements ??
    (matching.totalMatched ?? 0) + (matching.unmatchedBaseline ?? 0) + (matching.unmatchedCompare ?? 0);
  const matched = matching.totalMatched ?? 0;

  const root = document.createElement('div');
  root.className = 'result-panel sauce-result-panel';

  // Summary bar with match-rate donut.
  root.appendChild(_buildSauceSummaryBar({
    matching, mode, duration, cachedAt, fromCache,
    baselineUrl: result.baselineUrl ?? '',
    compareUrl: result.compareUrl ?? ''
  }));

  // Coverage section.
  const coverage = document.createElement('section');
  coverage.className = 'result-section coverage-section';
  const coverageTitle = document.createElement('div');
  coverageTitle.className = 'section-title';
  coverageTitle.textContent = `Elements — ${total} total`;
  coverage.appendChild(coverageTitle);

  const stats = document.createElement('div');
  stats.className = 'coverage-stats';
  stats.style.display = 'grid';
  stats.style.gridTemplateColumns = 'repeat(auto-fit, minmax(110px, 1fr))';
  stats.style.gap = 'var(--space-2)';
  stats.style.marginTop = 'var(--space-2)';
  stats.append(
    _buildStat('Matched', matched),
    _buildStat('Modified', modified),
    _buildStat('Unchanged', unchanged),
    _buildStat('Only Compare', added.length),
    _buildStat('Only Baseline', removed.length),
  );
  coverage.appendChild(stats);
  root.appendChild(coverage);

  // Severity section (only if any property differences).
  if (totalDifferences > 0) {
    const sevSection = document.createElement('section');
    sevSection.className = 'result-section';
    const sevTitle = document.createElement('div');
    sevTitle.className = 'section-title';
    sevTitle.textContent = `Severity — ${totalDifferences} ${totalDifferences === 1 ? 'difference' : 'differences'}`;
    sevSection.appendChild(sevTitle);
    sevSection.appendChild(_buildSevRow('Critical', critical, 'critical', sevTotal));
    sevSection.appendChild(_buildSevRow('High', high, 'high', sevTotal));
    sevSection.appendChild(_buildSevRow('Medium', medium, 'medium', sevTotal));
    sevSection.appendChild(_buildSevRow('Low', low, 'low', sevTotal));
    root.appendChild(sevSection);
  } else {
    const noDiffs = document.createElement('div');
    noDiffs.className = 'rp-no-diffs';
    noDiffs.textContent = 'No style differences in matched elements';
    root.appendChild(noDiffs);
  }

  // Action bar — own button id (sauce-view-report-btn) so it never collides
  // with the Compare tab's view-report-btn.
  const actions = document.createElement('div');
  actions.className = 'result-actions';
  const fullReportBtn = document.createElement('button');
  fullReportBtn.type = 'button';
  fullReportBtn.id = 'sauce-view-report-btn';
  fullReportBtn.className = 'btn-primary';
  fullReportBtn.style.padding = '0 var(--space-5)';
  fullReportBtn.textContent = 'Full Report';
  fullReportBtn.addEventListener('click', async () => {
    fullReportBtn.disabled = true;
    const original = fullReportBtn.textContent;
    fullReportBtn.textContent = 'Generating…';
    try {
      await handleSauceFullReport();
    } finally {
      fullReportBtn.disabled = false;
      fullReportBtn.textContent = original;
    }
  });
  actions.appendChild(fullReportBtn);
  root.appendChild(actions);

  return root;
}

function _buildSauceSummaryBar({ matching, mode, duration, cachedAt, fromCache, baselineUrl, compareUrl }) {
  const bar = document.createElement('div');
  bar.className = 'result-summary-bar';

  const pct = matching.matchRate ?? 0;
  const r = 30;
  const cx = 40;
  const cy = 40;
  const circ = 2 * Math.PI * r;
  const filled = pct / 100 * circ;
  const gap = circ - filled;

  const arcColor = pct >= 75 ? 'var(--color-success)'
    : pct >= 60 ? 'hsl(25 85% 52%)'
      : 'var(--color-destructive)';

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', '80');
  svg.setAttribute('height', '80');
  svg.setAttribute('viewBox', '0 0 80 80');
  svg.setAttribute('class', 'match-rate-donut');
  svg.setAttribute('aria-label', `${pct}% match rate`);
  svg.setAttribute('role', 'img');

  const track = document.createElementNS(svgNS, 'circle');
  track.setAttribute('cx', cx); track.setAttribute('cy', cy); track.setAttribute('r', r);
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke', 'var(--color-surface-raised)');
  track.setAttribute('stroke-width', '8');

  const arc = document.createElementNS(svgNS, 'circle');
  arc.setAttribute('cx', cx); arc.setAttribute('cy', cy); arc.setAttribute('r', r);
  arc.setAttribute('fill', 'none');
  arc.setAttribute('stroke', arcColor);
  arc.setAttribute('stroke-width', '8');
  arc.setAttribute('stroke-linecap', 'round');
  arc.setAttribute('stroke-dasharray', `${filled} ${gap}`);
  arc.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);

  const label = document.createElementNS(svgNS, 'text');
  label.setAttribute('class', 'match-rate-value');
  label.setAttribute('x', cx); label.setAttribute('y', cy);
  label.setAttribute('dominant-baseline', 'central');
  label.setAttribute('text-anchor', 'middle');
  label.setAttribute('font-size', '16');
  label.setAttribute('font-weight', '600');
  label.setAttribute('fill', arcColor);
  label.textContent = `${pct}%`;

  svg.append(track, arc, label);

  const group = document.createElement('div');
  group.className = 'match-rate-group';
  const lbl = document.createElement('span');
  lbl.className = 'match-rate-label';
  lbl.textContent = 'match rate';
  group.append(svg, lbl);
  bar.appendChild(group);

  const detail = document.createElement('div');
  detail.className = 'result-detail-col';

  const meta = document.createElement('div');
  meta.className = 'result-meta';
  const modeBadge = document.createElement('span');
  modeBadge.className = 'result-mode-badge';
  modeBadge.textContent = mode;
  meta.appendChild(modeBadge);
  const durationEl = document.createElement('span');
  durationEl.textContent = `${duration}ms`;
  meta.appendChild(durationEl);
  if (fromCache && cachedAt) {
    const cached = document.createElement('span');
    cached.className = 'result-mode-badge';
    cached.title = 'Loaded from cache';
    cached.textContent = `Cached · ${relativeTime(cachedAt)}`;
    meta.appendChild(cached);
  }
  detail.appendChild(meta);

  const urlRow = document.createElement('div');
  urlRow.className = 'result-url-row';
  const urlA = document.createElement('span');
  urlA.className = 'result-url result-url--baseline';
  urlA.textContent = _shortenUrl(baselineUrl);
  urlA.title = baselineUrl;
  const sep = document.createElement('span');
  sep.className = 'result-url-sep';
  sep.textContent = '↔';
  const urlB = document.createElement('span');
  urlB.className = 'result-url result-url--compare';
  urlB.textContent = _shortenUrl(compareUrl);
  urlB.title = compareUrl;
  urlRow.append(urlA, sep, urlB);
  detail.appendChild(urlRow);

  bar.appendChild(detail);
  return bar;
}

function _buildStat(label, value) {
  const wrap = document.createElement('div');
  wrap.style.padding = 'var(--space-2) var(--space-3)';
  wrap.style.background = 'var(--color-surface-raised)';
  wrap.style.borderRadius = 'var(--radius-md, 6px)';
  const v = document.createElement('div');
  v.style.fontSize = 'var(--font-size-lg)';
  v.style.fontWeight = '600';
  v.textContent = String(value);
  const l = document.createElement('div');
  l.style.fontSize = 'var(--font-size-sm)';
  l.style.color = 'var(--color-text-muted)';
  l.textContent = label;
  wrap.append(v, l);
  return wrap;
}

function _buildSevRow(label, count, type, sevTotal) {
  const pct = sevTotal > 0 ? (count / sevTotal * 100).toFixed(1) : 0;
  const row = document.createElement('div');
  row.className = 'rp-sev-row';
  row.setAttribute('role', 'listitem');
  row.setAttribute('aria-label', `${label}: ${count} element${count !== 1 ? 's' : ''}`);
  const badge = document.createElement('span');
  badge.className = `badge badge-${type}`;
  badge.textContent = label;
  const wrap = document.createElement('div');
  wrap.className = 'rp-sev-bar-wrap';
  const fill = document.createElement('div');
  fill.className = `rp-sev-bar-fill sev-${type}`;
  fill.style.width = `${pct}%`;
  wrap.appendChild(fill);
  const countEl = document.createElement('span');
  countEl.className = 'sev-count';
  countEl.textContent = String(count);
  row.append(badge, wrap, countEl);
  return row;
}

function _shortenUrl(url) {
  if (!url) return '—';
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return url;
  }
}