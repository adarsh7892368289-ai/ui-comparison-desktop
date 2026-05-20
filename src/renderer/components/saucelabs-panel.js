'use strict';

import { getState, subscribe } from '../state.js';
import {
  validateAndStoreCredentials,
  getCredentials,
  submitExtraction,
  submitComparison,
  cancelSauceJob,
  retrySauceJob,
  initSauceListeners,
  resetSauceJob,
  detectAndResumeSauceJobs } from
'../application/saucelabs-workflow.js';

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

      <div class="saucelabs-panel__actions">
        <button type="button" class="btn-primary" id="sauce-compare-btn">Run Comparison on SauceLabs</button>
        <button type="button" class="btn-secondary btn-sm" id="sauce-extract-btn">Extract Only</button>
      </div>
    </div>

    <div class="saucelabs-panel__job-status card" id="sauce-job-section" hidden>
      <h3 class="card-title">Job Status</h3>
      <div class="saucelabs-panel__job-card" id="sauce-job-card"></div>
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
  const compareBtn = panel.querySelector('#sauce-compare-btn');
  const extractBtn = panel.querySelector('#sauce-extract-btn');
  const jobSection = panel.querySelector('#sauce-job-section');
  const jobCard = panel.querySelector('#sauce-job-card');

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

    compareBtn.disabled = true;
    extractBtn.disabled = true;
    void submitComparison({
      baselineUrl,
      compareUrl,
      platform: platformSelect.value,
      browserName: browserSelect.value,
      screenResolution: resolutionSelect.value,
      tunnelName: tunnelInput.value.trim() || null,
      filters: null
    });
  });

  extractBtn.addEventListener('click', () => {
    const url = _validateUrl(baselineUrlInput);
    if (!url) return;

    compareBtn.disabled = true;
    extractBtn.disabled = true;
    void submitExtraction({
      url,
      platform: platformSelect.value,
      browserName: browserSelect.value,
      screenResolution: resolutionSelect.value,
      tunnelName: tunnelInput.value.trim() || null,
      filters: null
    });
  });

  const existingCreds = getCredentials();
  if (existingCreds) {
    usernameInput.value = existingCreds.username;
    accessKeyInput.value = existingCreds.accessKey;
    regionSelect.value = existingCreds.region;
  }

  initSauceListeners();
  void detectAndResumeSauceJobs();

  const unsubscribe = subscribe((state) => {
    renderCredentialStatus(state);
    renderJobStatus(state);
    const isRunning = state.sauceJob && !['done', 'failed', 'cancelled', 'timed_out'].includes(state.sauceJob.status);
    compareBtn.disabled = isRunning;
    extractBtn.disabled = isRunning;
  });

  const currentState = getState();
  renderCredentialStatus(currentState);
  renderJobStatus(currentState);

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