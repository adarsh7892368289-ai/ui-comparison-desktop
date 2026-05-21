'use strict';

// Schema validators for the SauceLabs trust boundary.
//
// Two formats cross the boundary between the renderer/main process and the
// SauceLabs VM:
//   1. job.json — written by main, read by the spec inside the VM.
//   2. screenshots-manifest.json + extraction-result.json — written by the
//      spec, read by the renderer after saucectl downloads them.
//
// We validate at the boundary so type / shape errors fail loud with
// actionable messages instead of silently producing broken IDB records that
// surface hours later as "no screenshots in the report."
//
// No external schema-lib dependency: the runtime ships inside the VM where
// node_modules is constrained, and the validation rules are simple enough
// to express directly. The validator collects ALL errors before throwing
// so a single failure surfaces every drift point at once.

class SchemaValidationError extends Error {
  constructor(label, errors) {
    const lines = errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n');
    super(`${label} schema validation failed:\n${lines}`);
    this.name = 'SchemaValidationError';
    this.label = label;
    this.errors = errors;
  }
}

function _typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// Lightweight assertion-collecting validator. Each rule is a function that
// receives (value, errors, path) and pushes errors when invalid.
function _check(value, path, rules, errors) {
  for (const rule of rules) {
    rule(value, errors, path);
  }
}

const required = (msg = 'is required') => (v, errors, path) => {
  if (v === undefined) errors.push({ path, message: msg });
};

const isType = (expected) => (v, errors, path) => {
  if (v === undefined) return; // skipped; required handles undefined
  const got = _typeOf(v);
  if (got !== expected) {
    errors.push({ path, message: `expected ${expected}, got ${got}` });
  }
};

const isOneOf = (...allowed) => (v, errors, path) => {
  if (v === undefined) return;
  const got = _typeOf(v);
  if (!allowed.includes(got)) {
    errors.push({ path, message: `expected one of [${allowed.join(', ')}], got ${got}` });
  }
};

const isFiniteNumber = () => (v, errors, path) => {
  if (v === undefined) return;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errors.push({ path, message: `expected finite number, got ${_typeOf(v)} (${String(v)})` });
  }
};

const arrayOf = (itemValidator) => (v, errors, path) => {
  if (v === undefined) return;
  if (!Array.isArray(v)) {
    errors.push({ path, message: `expected array, got ${_typeOf(v)}` });
    return;
  }
  for (let i = 0; i < v.length; i++) {
    itemValidator(v[i], errors, `${path}[${i}]`);
  }
};

const recordOf = (valueValidator) => (v, errors, path) => {
  if (v === undefined) return;
  if (_typeOf(v) !== 'object') {
    errors.push({ path, message: `expected object, got ${_typeOf(v)}` });
    return;
  }
  for (const key of Object.keys(v)) {
    valueValidator(v[key], errors, `${path}.${key}`);
  }
};

// ---------------------------------------------------------------------------
// job.json (main → spec)
// ---------------------------------------------------------------------------

function validateJobConfig(raw, label = 'job.json') {
  const errors = [];

  if (_typeOf(raw) !== 'object') {
    throw new SchemaValidationError(label, [
      { path: '$', message: `root must be object, got ${_typeOf(raw)}` }
    ]);
  }

  _check(raw.url, '$.url', [required(), isType('string')], errors);
  if (typeof raw.url === 'string') {
    try {
      const parsed = new URL(raw.url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errors.push({ path: '$.url', message: `protocol must be http or https, got ${parsed.protocol}` });
      }
    } catch (e) {
      errors.push({ path: '$.url', message: `not a valid URL: ${e.message}` });
    }
  }

  _check(raw.filters, '$.filters', [isOneOf('object', 'null')], errors);
  if (raw.filters && _typeOf(raw.filters) === 'object') {
    if (raw.filters.class !== undefined) _check(raw.filters.class, '$.filters.class', [isType('string')], errors);
    if (raw.filters.id !== undefined) _check(raw.filters.id, '$.filters.id', [isType('string')], errors);
    if (raw.filters.tag !== undefined) _check(raw.filters.tag, '$.filters.tag', [isType('string')], errors);
  }

  _check(raw.maxScreenshots, '$.maxScreenshots', [required(), isFiniteNumber()], errors);
  if (typeof raw.maxScreenshots === 'number' && (raw.maxScreenshots <= 0 || !Number.isInteger(raw.maxScreenshots))) {
    errors.push({ path: '$.maxScreenshots', message: 'must be a positive integer' });
  }

  _check(raw.testTimeoutMs, '$.testTimeoutMs', [required(), isFiniteNumber()], errors);
  if (typeof raw.testTimeoutMs === 'number' && raw.testTimeoutMs <= 0) {
    errors.push({ path: '$.testTimeoutMs', message: 'must be > 0' });
  }

  _check(raw.configOverrides, '$.configOverrides', [isOneOf('object', 'undefined')], errors);

  if (errors.length > 0) throw new SchemaValidationError(label, errors);
  return raw;
}

// ---------------------------------------------------------------------------
// screenshots-manifest.json (spec → renderer)
// ---------------------------------------------------------------------------

function _validateKeyframe(kf, errors, path) {
  if (_typeOf(kf) !== 'object') {
    errors.push({ path, message: `expected object, got ${_typeOf(kf)}` });
    return;
  }
  _check(kf.id, `${path}.id`, [required(), isType('string')], errors);
  _check(kf.scrollY, `${path}.scrollY`, [required(), isFiniteNumber()], errors);
  _check(kf.viewportWidth, `${path}.viewportWidth`, [required(), isFiniteNumber()], errors);
  _check(kf.viewportHeight, `${path}.viewportHeight`, [required(), isFiniteNumber()], errors);
  _check(kf.elementIds, `${path}.elementIds`, [required(), arrayOf(isType('string'))], errors);
  _check(kf.filename, `${path}.filename`, [required(), isType('string')], errors);
  if (typeof kf.filename === 'string' && !/^keyframe-\d+\.jpg$/.test(kf.filename)) {
    errors.push({ path: `${path}.filename`, message: `must match keyframe-\\d+\\.jpg, got "${kf.filename}"` });
  }
}

function _validateRect(r, errors, path) {
  if (_typeOf(r) !== 'object') {
    errors.push({ path, message: `expected object, got ${_typeOf(r)}` });
    return;
  }
  _check(r.id, `${path}.id`, [required(), isType('string')], errors);
  _check(r.found, `${path}.found`, [required(), isType('boolean')], errors);
  if (r.found === true) {
    _check(r.viewportX, `${path}.viewportX`, [isFiniteNumber()], errors);
    _check(r.viewportY, `${path}.viewportY`, [isFiniteNumber()], errors);
    _check(r.width, `${path}.width`, [isFiniteNumber()], errors);
    _check(r.height, `${path}.height`, [isFiniteNumber()], errors);
  }
}

function _validateKeyframeMeasurement(m, errors, path) {
  if (_typeOf(m) !== 'object') {
    errors.push({ path, message: `expected object, got ${_typeOf(m)}` });
    return;
  }
  _check(m.keyframeId, `${path}.keyframeId`, [required(), isType('string')], errors);
  _check(m.actualScrollY, `${path}.actualScrollY`, [required(), isFiniteNumber()], errors);
  _check(m.rects, `${path}.rects`, [required(), arrayOf(_validateRect)], errors);
  // pseudoStyles is optional but if present must be an array.
  if (m.pseudoStyles !== undefined) {
    _check(m.pseudoStyles, `${path}.pseudoStyles`, [isType('array')], errors);
  }
}

// Required fields are the contract. Missing fields → throw. Extra fields are
// allowed (forward-compat: future spec versions may add fields).
function validateScreenshotsManifest(raw, label = 'screenshots-manifest.json') {
  const errors = [];

  if (_typeOf(raw) !== 'object') {
    throw new SchemaValidationError(label, [
      { path: '$', message: `root must be object, got ${_typeOf(raw)}` }
    ]);
  }

  _check(raw.keyframes, '$.keyframes', [required(), arrayOf(_validateKeyframe)], errors);
  _check(raw.elementKeyframeMap, '$.elementKeyframeMap', [required(), recordOf(isType('string'))], errors);

  // The "empty page" path produces a degenerate manifest with no measurements.
  // That's valid: the renderer falls back gracefully. Otherwise the new fields
  // (added in milestone #1) must all be present and well-typed.
  const isDegenerate = Array.isArray(raw.keyframes) && raw.keyframes.length === 0;
  if (!isDegenerate) {
    _check(raw.documentYById, '$.documentYById', [required(), recordOf(isFiniteNumber())], errors);
    _check(raw.documentHeight, '$.documentHeight', [required(), isFiniteNumber()], errors);
    _check(raw.viewportHeight, '$.viewportHeight', [required(), isFiniteNumber()], errors);
    _check(raw.actualDPR, '$.actualDPR', [required(), isFiniteNumber()], errors);
    _check(raw.keyframeMeasurements, '$.keyframeMeasurements',
      [required(), arrayOf(_validateKeyframeMeasurement)], errors);
  }

  if (errors.length > 0) throw new SchemaValidationError(label, errors);
  return raw;
}

// ---------------------------------------------------------------------------
// extraction-result.json (spec → renderer)
//
// This file's body is the output of __uiCompare.extractWithConfig — owned by
// the local extractor bundle, which is the same code that runs locally. We
// don't re-validate the entire extractor schema here (that's enforced
// elsewhere); we only assert the top-level shape used by the SauceLabs flow.
// ---------------------------------------------------------------------------

function validateExtractionResult(raw, label = 'extraction-result.json') {
  const errors = [];
  if (_typeOf(raw) !== 'object') {
    throw new SchemaValidationError(label, [
      { path: '$', message: `root must be object, got ${_typeOf(raw)}` }
    ]);
  }
  _check(raw.elements, '$.elements', [arrayOf(isType('object'))], errors);
  // url/title/totalElements are optional — main fills them in if missing.
  if (errors.length > 0) throw new SchemaValidationError(label, errors);
  return raw;
}

export {
  SchemaValidationError,
  validateJobConfig,
  validateScreenshotsManifest,
  validateExtractionResult
};
