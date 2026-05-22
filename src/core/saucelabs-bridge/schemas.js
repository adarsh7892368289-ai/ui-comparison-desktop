'use strict';


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

function _check(value, path, rules, errors) {
  for (const rule of rules) {
    rule(value, errors, path);
  }
}

const required = (msg = 'is required') => (v, errors, path) => {
  if (v === undefined) errors.push({ path, message: msg });
};

const isType = (expected) => (v, errors, path) => {
  if (v === undefined) return;
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

  _check(raw.device, '$.device', [isOneOf('object', 'null', 'undefined')], errors);
  if (raw.device && _typeOf(raw.device) === 'object') {
    _check(raw.device.name, '$.device.name', [required(), isType('string')], errors);
    if (typeof raw.device.name === 'string' && raw.device.name.trim() === '') {
      errors.push({ path: '$.device.name', message: 'must be non-empty' });
    }
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
  if (m.pseudoStyles !== undefined) {
    _check(m.pseudoStyles, `${path}.pseudoStyles`, [isType('array')], errors);
  }
}

function validateScreenshotsManifest(raw, label = 'screenshots-manifest.json') {
  const errors = [];

  if (_typeOf(raw) !== 'object') {
    throw new SchemaValidationError(label, [
      { path: '$', message: `root must be object, got ${_typeOf(raw)}` }
    ]);
  }

  _check(raw.keyframes, '$.keyframes', [required(), arrayOf(_validateKeyframe)], errors);
  _check(raw.elementKeyframeMap, '$.elementKeyframeMap', [required(), recordOf(isType('string'))], errors);

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


function validateExtractionResult(raw, label = 'extraction-result.json') {
  const errors = [];
  if (_typeOf(raw) !== 'object') {
    throw new SchemaValidationError(label, [
      { path: '$', message: `root must be object, got ${_typeOf(raw)}` }
    ]);
  }
  _check(raw.elements, '$.elements', [arrayOf(isType('object'))], errors);
  if (errors.length > 0) throw new SchemaValidationError(label, errors);
  return raw;
}

export {
  SchemaValidationError,
  validateJobConfig,
  validateScreenshotsManifest,
  validateExtractionResult
};
