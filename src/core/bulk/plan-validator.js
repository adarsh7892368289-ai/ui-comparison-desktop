'use strict';

const { assessUrlCompatibility } = require('../comparison/url-compatibility.js');

const VALID_MODES = new Set(['dynamic', 'static']);

function isHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0) { return false; }
  return value.startsWith('http://') || value.startsWith('https://');
}

function describeMismatch(delta) {
  if (!delta) { return 'paths or query parameters differ'; }
  if (delta.pathname) {
    return `paths differ (${delta.pathname.baseline} vs ${delta.pathname.compare})`;
  }
  if (delta.queryParams && delta.queryParams.length > 0) {
    return 'query parameters differ';
  }
  if (delta.hash) {
    return 'URL hash differs';
  }
  return 'paths or query parameters differ';
}

const CANONICAL_BROWSER_TYPES = new Set(['chromium', 'firefox', 'webkit']);

function _toDescriptorForJobLevel(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') { return null; }
  const browserType = descriptor.browserType ?? null;
  if (!browserType) { return null; }
  return {
    browserType,
    channel:        descriptor.channel        ?? null,
    executablePath: descriptor.executablePath ?? null,
    displayName:    descriptor.displayName    ?? null,
    isDefault:      Boolean(descriptor.isDefault),
    isLaunchable:   descriptor.isLaunchable   !== false,
  };
}

function _resolveByBrowserType(availableBrowsers, browserType) {
  let firstLaunchable = null;
  for (const descriptor of availableBrowsers) {
    if (descriptor?.browserType !== browserType) { continue; }
    if (descriptor.isLaunchable === false) { continue; }
    if (descriptor.isDefault === true) { return descriptor; }
    if (!firstLaunchable) { firstLaunchable = descriptor; }
  }
  return firstLaunchable;
}

function _resolveByDisplayName(availableBrowsers, lowerToken) {
  for (const descriptor of availableBrowsers) {
    const display = typeof descriptor?.displayName === 'string'
      ? descriptor.displayName.trim().toLowerCase()
      : null;
    if (display && display === lowerToken) { return descriptor; }
  }
  return null;
}

function _resolveBrowserCell(rawCell, availableBrowsers) {
  const lowerToken = String(rawCell).trim().toLowerCase();
  if (!lowerToken) { return { match: null }; }
  if (!Array.isArray(availableBrowsers) || availableBrowsers.length === 0) {
    return { match: null };
  }

  let match = null;
  if (CANONICAL_BROWSER_TYPES.has(lowerToken)) {
    match = _resolveByBrowserType(availableBrowsers, lowerToken);
  }
  if (!match) {
    match = _resolveByDisplayName(availableBrowsers, lowerToken);
  }
  if (!match || match.isLaunchable === false) {
    return { match: null };
  }
  return { match };
}

function validateOneRow(row, jobOptions, availableBrowsers) {
  if (!isHttpUrl(row.baseline_url)) {
    return { status: 'invalid', reason: 'Invalid baseline URL' };
  }
  if (!isHttpUrl(row.compare_url)) {
    return { status: 'invalid', reason: 'Invalid compare URL' };
  }
  if (!VALID_MODES.has(row.mode)) {
    return { status: 'invalid', reason: `Unknown mode: ${row.mode}` };
  }

  const compatibility = assessUrlCompatibility(row.baseline_url, row.compare_url);
  if (compatibility.classification === 'INCOMPATIBLE') {
    return {
      status: 'invalid',
      reason: `URLs are incompatible: ${describeMismatch(compatibility.mismatchDelta)}`,
    };
  }

  const jobLevelDescriptor = _toDescriptorForJobLevel(jobOptions?.selectedBrowser);
  let resolvedBrowser = jobLevelDescriptor;
  const cellHasValue  = row.browser !== null && row.browser !== undefined && String(row.browser).trim().length > 0;

  if (cellHasValue) {
    const { match } = _resolveBrowserCell(row.browser, availableBrowsers);
    if (!match) {
      return { status: 'invalid', reason: `Browser not available: ${row.browser}` };
    }
    resolvedBrowser = _toDescriptorForJobLevel(match);
  }

  if (compatibility.classification === 'CAUTION') {
    return { status: 'warning', reason: `URLs differ in state: ${describeMismatch(compatibility.mismatchDelta)}`, resolvedBrowser };
  }

  return { status: 'valid', reason: null, resolvedBrowser };
}

function validatePlanRows(rows, jobOptions = {}, availableBrowsers = []) {
  const valid    = [];
  const warnings = [];
  const invalid  = [];

  if (!Array.isArray(rows)) {
    return { valid, warnings, invalid };
  }

  for (const row of rows) {
    const outcome = validateOneRow(row, jobOptions, availableBrowsers);
    const enriched = {
      ...row,
      validationStatus: outcome.status,
      validationReason: outcome.reason,
    };
    if (outcome.resolvedBrowser) {
      enriched.resolvedBrowser = outcome.resolvedBrowser;
    }

    if (outcome.status === 'valid') {
      valid.push(enriched);
    } else if (outcome.status === 'warning') {
      warnings.push(enriched);
      valid.push(enriched);
    } else {
      invalid.push(enriched);
    }
  }

  return { valid, warnings, invalid };
}

module.exports = { validatePlanRows };
