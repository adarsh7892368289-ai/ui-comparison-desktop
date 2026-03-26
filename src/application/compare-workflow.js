'use strict';

const MINIMUM_SCHEMA_VERSION = '3.0';

class PreFlightError extends Error {
  constructor(code, compatResult) {
    super(`Pre-flight check failed: ${code}`);
    this.name         = 'PreFlightError';
    this.code         = code;
    this.compatResult = compatResult;
  }
}

class CompatibilityError extends Error {
  constructor(baselineVersion, compareVersion) {
    super(
      `Report schema version too old: baseline=${baselineVersion ?? 'unknown'}, ` +
      `compare=${compareVersion ?? 'unknown'}. ` +
      `Both reports must be schema version >= ${MINIMUM_SCHEMA_VERSION}. ` +
      'Recapture both reports.'
    );
    this.name            = 'CompatibilityError';
    this.baselineVersion = baselineVersion;
    this.compareVersion  = compareVersion;
  }
}

function parseVersion(versionStr) {
  const parts = (versionStr ?? '0.0').split('.');
  return {
    major: parseInt(parts[0], 10) || 0,
    minor: parseInt(parts[1], 10) || 0,
  };
}

function versionAtLeast(versionStr, minStr) {
  const subject = parseVersion(versionStr);
  const minimum = parseVersion(minStr);
  if (subject.major !== minimum.major) {
    return subject.major > minimum.major;
  }
  return subject.minor >= minimum.minor;
}

function assertVersionCompatibility(baselineVersion, compareVersion) {
  const baselineSufficient = versionAtLeast(baselineVersion, MINIMUM_SCHEMA_VERSION);
  const compareSufficient  = versionAtLeast(compareVersion,  MINIMUM_SCHEMA_VERSION);
  if (!baselineSufficient || !compareSufficient) {
    throw new CompatibilityError(baselineVersion, compareVersion);
  }
}

module.exports = {
  assertVersionCompatibility,
  PreFlightError,
  CompatibilityError,
  parseVersion,
  versionAtLeast,
};