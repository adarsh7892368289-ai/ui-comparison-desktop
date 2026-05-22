import { describe, it, expect } from 'vitest';
import {
  SchemaValidationError,
  validateJobConfig,
  validateScreenshotsManifest,
  validateExtractionResult
} from '@core/saucelabs-bridge/schemas.js';


describe('validateJobConfig', () => {
  function valid() {
    return {
      url: 'https://example.com/page',
      filters: null,
      maxScreenshots: 200,
      testTimeoutMs: 600_000,
      configOverrides: { extraction: { maxElements: 10000 } }
    };
  }

  it('accepts a minimal valid config', () => {
    expect(() => validateJobConfig(valid())).not.toThrow();
  });

  it('returns the original object on success (no mutation)', () => {
    const cfg = valid();
    expect(validateJobConfig(cfg)).toBe(cfg);
  });

  it('rejects non-object root', () => {
    expect(() => validateJobConfig(null)).toThrow(SchemaValidationError);
    expect(() => validateJobConfig('string')).toThrow(SchemaValidationError);
    expect(() => validateJobConfig([])).toThrow(SchemaValidationError);
  });

  it('requires url', () => {
    const cfg = valid();
    delete cfg.url;
    const err = expectThrows(() => validateJobConfig(cfg));
    expect(err.errors.some((e) => e.path === '$.url')).toBe(true);
  });

  it('requires url to be http or https', () => {
    const cfg = valid();
    cfg.url = 'file:///etc/passwd';
    const err = expectThrows(() => validateJobConfig(cfg));
    expect(err.errors.some((e) => e.path === '$.url' && /protocol/.test(e.message))).toBe(true);
  });

  it('rejects malformed url string', () => {
    const cfg = valid();
    cfg.url = 'not a url';
    const err = expectThrows(() => validateJobConfig(cfg));
    expect(err.errors.some((e) => e.path === '$.url')).toBe(true);
  });

  it('rejects non-string url', () => {
    const cfg = valid();
    cfg.url = 42;
    const err = expectThrows(() => validateJobConfig(cfg));
    expect(err.errors.some((e) => e.path === '$.url' && /string/.test(e.message))).toBe(true);
  });

  it('accepts filters as null or object', () => {
    expect(() => validateJobConfig({ ...valid(), filters: null })).not.toThrow();
    expect(() => validateJobConfig({ ...valid(), filters: { class: 'btn' } })).not.toThrow();
  });

  it('rejects filter sub-fields with wrong types', () => {
    const cfg = { ...valid(), filters: { class: 123 } };
    const err = expectThrows(() => validateJobConfig(cfg));
    expect(err.errors.some((e) => e.path === '$.filters.class')).toBe(true);
  });

  it('rejects non-positive or non-integer maxScreenshots', () => {
    expect(() => validateJobConfig({ ...valid(), maxScreenshots: 0 })).toThrow(SchemaValidationError);
    expect(() => validateJobConfig({ ...valid(), maxScreenshots: -5 })).toThrow(SchemaValidationError);
    expect(() => validateJobConfig({ ...valid(), maxScreenshots: 1.5 })).toThrow(SchemaValidationError);
    expect(() => validateJobConfig({ ...valid(), maxScreenshots: NaN })).toThrow(SchemaValidationError);
  });

  it('rejects non-positive testTimeoutMs', () => {
    expect(() => validateJobConfig({ ...valid(), testTimeoutMs: 0 })).toThrow(SchemaValidationError);
    expect(() => validateJobConfig({ ...valid(), testTimeoutMs: -1 })).toThrow(SchemaValidationError);
  });

  it('reports all errors at once (not just the first)', () => {
    const bad = { url: 42, maxScreenshots: -1, testTimeoutMs: 0 };
    const err = expectThrows(() => validateJobConfig(bad));
    expect(err.errors.length).toBeGreaterThanOrEqual(3);
    const paths = err.errors.map((e) => e.path);
    expect(paths).toContain('$.url');
    expect(paths).toContain('$.maxScreenshots');
    expect(paths).toContain('$.testTimeoutMs');
  });
});


describe('validateJobConfig — device (mobile emulation)', () => {
  function valid() {
    return {
      url: 'https://example.com',
      filters: null,
      maxScreenshots: 200,
      testTimeoutMs: 600_000
    };
  }

  it('accepts device: null', () => {
    expect(() => validateJobConfig({ ...valid(), device: null })).not.toThrow();
  });

  it('accepts device: undefined / absent (back-compat with desktop-only jobs)', () => {
    expect(() => validateJobConfig(valid())).not.toThrow();
  });

  it('accepts a valid device object', () => {
    expect(() => validateJobConfig({ ...valid(), device: { name: 'iPhone 13' } })).not.toThrow();
  });

  it('rejects device without a name', () => {
    let caught;
    try { validateJobConfig({ ...valid(), device: {} }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    expect(caught.errors.some((e) => e.path === '$.device.name')).toBe(true);
  });

  it('rejects device with empty / whitespace name', () => {
    let caught;
    try { validateJobConfig({ ...valid(), device: { name: '   ' } }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    expect(caught.errors.some((e) => /name/.test(e.path))).toBe(true);
  });

  it('rejects device with non-string name', () => {
    let caught;
    try { validateJobConfig({ ...valid(), device: { name: 123 } }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(SchemaValidationError);
  });

  it('rejects non-object device (e.g., a string)', () => {
    let caught;
    try { validateJobConfig({ ...valid(), device: 'iPhone 13' }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    expect(caught.errors.some((e) => e.path === '$.device')).toBe(true);
  });
});


describe('validateScreenshotsManifest', () => {
  function fullManifest() {
    return {
      keyframes: [
        { id: 'kf_0', scrollY: 0, viewportWidth: 1920, viewportHeight: 1080,
          elementIds: ['1.2.3'], filename: 'keyframe-0.jpg' }
      ],
      elementKeyframeMap: { '1.2.3': 'kf_0' },
      documentYById: { '1.2.3': 50 },
      documentHeight: 5000,
      viewportHeight: 1080,
      actualDPR: 2,
      keyframeMeasurements: [{
        keyframeId: 'kf_0',
        actualScrollY: 0,
        rects: [{ id: '1.2.3', found: true, viewportX: 0, viewportY: 0, width: 100, height: 100 }],
        pseudoStyles: []
      }]
    };
  }

  it('accepts a complete valid manifest', () => {
    expect(() => validateScreenshotsManifest(fullManifest())).not.toThrow();
  });

  it('accepts the degenerate empty-page manifest (keyframes: [], no measurements)', () => {
    const m = { keyframes: [], elementKeyframeMap: {} };
    expect(() => validateScreenshotsManifest(m)).not.toThrow();
  });

  it('requires top-level keys when not degenerate', () => {
    const m = fullManifest();
    delete m.documentHeight;
    delete m.actualDPR;
    const err = expectThrows(() => validateScreenshotsManifest(m));
    const paths = err.errors.map((e) => e.path);
    expect(paths).toContain('$.documentHeight');
    expect(paths).toContain('$.actualDPR');
  });

  it('rejects non-object root', () => {
    expect(() => validateScreenshotsManifest(null)).toThrow(SchemaValidationError);
    expect(() => validateScreenshotsManifest('x')).toThrow(SchemaValidationError);
  });

  it('rejects invalid keyframe filename pattern', () => {
    const m = fullManifest();
    m.keyframes[0].filename = 'keyframe-0.webp';
    const err = expectThrows(() => validateScreenshotsManifest(m));
    expect(err.errors.some((e) => /filename/.test(e.path))).toBe(true);
  });

  it('rejects non-string elementIds entries', () => {
    const m = fullManifest();
    m.keyframes[0].elementIds = [123];
    const err = expectThrows(() => validateScreenshotsManifest(m));
    expect(err.errors.some((e) => /elementIds/.test(e.path))).toBe(true);
  });

  it('rejects non-finite numbers (NaN, Infinity) in measurement rects', () => {
    const m = fullManifest();
    m.keyframeMeasurements[0].rects[0].viewportX = NaN;
    const err = expectThrows(() => validateScreenshotsManifest(m));
    expect(err.errors.some((e) => /viewportX/.test(e.path))).toBe(true);
  });

  it('rejects elementKeyframeMap with non-string values', () => {
    const m = fullManifest();
    m.elementKeyframeMap = { 'h.1': 5 };
    const err = expectThrows(() => validateScreenshotsManifest(m));
    expect(err.errors.some((e) => /elementKeyframeMap/.test(e.path))).toBe(true);
  });

  it('rejects measurement entries missing keyframeId', () => {
    const m = fullManifest();
    delete m.keyframeMeasurements[0].keyframeId;
    const err = expectThrows(() => validateScreenshotsManifest(m));
    expect(err.errors.some((e) => /keyframeId/.test(e.path))).toBe(true);
  });

  it('skips rect coordinate checks when found is false (degenerate is fine)', () => {
    const m = fullManifest();
    m.keyframeMeasurements[0].rects[0] = { id: '1.2.3', found: false };
    expect(() => validateScreenshotsManifest(m)).not.toThrow();
  });

  it('reports paths with array indices', () => {
    const m = fullManifest();
    m.keyframes[0].id = 42;
    const err = expectThrows(() => validateScreenshotsManifest(m));
    expect(err.errors.some((e) => e.path === '$.keyframes[0].id')).toBe(true);
  });
});


describe('validateExtractionResult', () => {
  it('accepts a minimal valid extraction result', () => {
    expect(() => validateExtractionResult({ elements: [] })).not.toThrow();
    expect(() => validateExtractionResult({ elements: [{ hpid: '1' }] })).not.toThrow();
  });

  it('accepts extra fields (forward compat)', () => {
    expect(() => validateExtractionResult({
      elements: [],
      url: 'https://example.com',
      timestamp: new Date().toISOString(),
      futureField: { x: 1 }
    })).not.toThrow();
  });

  it('rejects non-object root', () => {
    expect(() => validateExtractionResult(null)).toThrow(SchemaValidationError);
    expect(() => validateExtractionResult([])).toThrow(SchemaValidationError);
  });

  it('rejects non-array elements', () => {
    const err = expectThrows(() => validateExtractionResult({ elements: 'string' }));
    expect(err.errors.some((e) => e.path === '$.elements')).toBe(true);
  });
});


describe('SchemaValidationError', () => {
  it('formats every error path in the message', () => {
    let caught;
    try {
      validateJobConfig({ url: 42, maxScreenshots: -1, testTimeoutMs: -1 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    expect(caught.message).toContain('$.url');
    expect(caught.message).toContain('$.maxScreenshots');
    expect(caught.message).toContain('$.testTimeoutMs');
  });

  it('exposes structured errors via .errors', () => {
    let caught;
    try {
      validateJobConfig({});
    } catch (e) {
      caught = e;
    }
    expect(Array.isArray(caught.errors)).toBe(true);
    expect(caught.errors.length).toBeGreaterThan(0);
    for (const e of caught.errors) {
      expect(typeof e.path).toBe('string');
      expect(typeof e.message).toBe('string');
    }
  });

  it('exposes label so consumers can include it in user-facing messages', () => {
    let caught;
    try {
      validateJobConfig({}, 'my-label');
    } catch (e) {
      caught = e;
    }
    expect(caught.label).toBe('my-label');
  });
});

function expectThrows(fn) {
  let caught;
  try { fn(); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(SchemaValidationError);
  return caught;
}
