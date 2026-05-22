import { describe, it, expect } from 'vitest';
import {
  buildCompareHpidRemap,
  computeDiffKeyframeIds,
  buildSauceRectRecords
} from '@core/saucelabs-bridge/visual-records.js';


describe('buildCompareHpidRemap', () => {
  it('returns an empty map for empty input', () => {
    expect(buildCompareHpidRemap([]).size).toBe(0);
    expect(buildCompareHpidRemap(null).size).toBe(0);
    expect(buildCompareHpidRemap(undefined).size).toBe(0);
  });

  it('maps each compare hpid to its matched baseline hpid', () => {
    const rows = [
      { baselineElement: { hpid: 'b.1' }, compareElement: { hpid: 'c.1' } },
      { baselineElement: { hpid: 'b.2' }, compareElement: { hpid: 'c.2' } },
      { baselineElement: { hpid: 'b.3' }, compareElement: { hpid: 'b.3' } }
    ];
    const remap = buildCompareHpidRemap(rows);
    expect(remap.get('c.1')).toBe('b.1');
    expect(remap.get('c.2')).toBe('b.2');
    expect(remap.get('b.3')).toBe('b.3');
    expect(remap.size).toBe(3);
  });

  it('skips rows missing either baseline or compare hpid (added/removed elements)', () => {
    const rows = [
      { baselineElement: { hpid: 'b.1' }, compareElement: null },
      { baselineElement: null, compareElement: { hpid: 'c.2' } },
      { baselineElement: { hpid: 'b.3' }, compareElement: { hpid: 'c.3' } }
    ];
    const remap = buildCompareHpidRemap(rows);
    expect(remap.size).toBe(1);
    expect(remap.get('c.3')).toBe('b.3');
  });

  it('tolerates malformed rows without crashing', () => {
    const rows = [
      null,
      undefined,
      {},
      { baselineElement: {} },
      { compareElement: {} }
    ];
    expect(() => buildCompareHpidRemap(rows)).not.toThrow();
    expect(buildCompareHpidRemap(rows).size).toBe(0);
  });
});


describe('computeDiffKeyframeIds', () => {
  it('returns empty set when no rows have differences', () => {
    const rows = [
      { baselineElement: { hpid: 'h1' }, totalDifferences: 0 },
      { baselineElement: { hpid: 'h2' }, totalDifferences: 0 }
    ];
    const baselineManifest = { elementKeyframeMap: { h1: 'kf_0', h2: 'kf_1' } };
    const compareManifest = { elementKeyframeMap: { h1: 'kf_0', h2: 'kf_1' } };
    expect(computeDiffKeyframeIds(rows, baselineManifest, compareManifest).size).toBe(0);
  });

  it('includes only keyframes containing diffed elements', () => {
    const rows = [
      { baselineElement: { hpid: 'h1' }, totalDifferences: 3 },
      { baselineElement: { hpid: 'h2' }, totalDifferences: 0 },
      { baselineElement: { hpid: 'h3' }, totalDifferences: 1 }
    ];
    const baselineManifest = { elementKeyframeMap: { h1: 'kf_0', h2: 'kf_1', h3: 'kf_2' } };
    const compareManifest = { elementKeyframeMap: { h1: 'kf_0', h2: 'kf_1', h3: 'kf_2' } };
    const ids = computeDiffKeyframeIds(rows, baselineManifest, compareManifest);
    expect([...ids].sort()).toEqual(['kf_0', 'kf_2']);
  });

  it('unions keyframe ids across both manifests', () => {
    const rows = [{ baselineElement: { hpid: 'h1' }, totalDifferences: 1 }];
    const baselineManifest = { elementKeyframeMap: { h1: 'kf_0' } };
    const compareManifest = { elementKeyframeMap: { h1: 'kf_5' } };
    const ids = computeDiffKeyframeIds(rows, baselineManifest, compareManifest);
    expect([...ids].sort()).toEqual(['kf_0', 'kf_5']);
  });

  it('handles missing elements/manifests gracefully', () => {
    expect(computeDiffKeyframeIds(null, null, null).size).toBe(0);
    expect(computeDiffKeyframeIds([], {}, {}).size).toBe(0);
    expect(computeDiffKeyframeIds([{ totalDifferences: 5 }], {}, {}).size).toBe(0);
  });
});


function makeManifest({
  elementKeyframeMap = {},
  documentYById = {},
  documentHeight = 5000,
  viewportHeight = 1080,
  actualDPR = 2,
  keyframeMeasurements = []
} = {}) {
  return { elementKeyframeMap, documentYById, documentHeight, viewportHeight, actualDPR, keyframeMeasurements };
}

function makeMeasurement(keyframeId, rects, pseudoStyles = []) {
  return { keyframeId, actualScrollY: 0, rects, pseudoStyles };
}

const SESSION = 'session-uuid';
const ROLE = 'baseline';

describe('buildSauceRectRecords — schema contract', () => {
  it('produces records with all fields the consumer expects', () => {
    const manifest = makeManifest({
      elementKeyframeMap: { 'h.1': 'kf_0' },
      documentYById: { 'h.1': 1234 },
      keyframeMeasurements: [
        makeMeasurement('kf_0', [
          {
            id: 'h.1', found: true, inViewport: true,
            viewportX: 100, viewportY: 200, width: 300, height: 50,
            selectorAmbiguous: false, selectorMatchCount: 1
          }
        ])
      ]
    });
    const prefixById = new Map([['kf_0', `${SESSION}_${ROLE}_kf_0`]]);
    const records = buildSauceRectRecords(manifest, SESSION, ROLE, prefixById);
    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r).toMatchObject({
      id: `${SESSION}_${ROLE}_rect_h.1`,
      sessionId: SESSION,
      elementKey: 'h.1',
      tabRole: ROLE,
      keyframeId: `${SESSION}_${ROLE}_kf_0`,
      actualDPR: 2,
      documentY: 1234,
      totalDocumentHeight: 5000,
      pseudoBefore: null,
      pseudoAfter: null,
      rect: { x: 100, y: 200, width: 300, height: 50 },
      rawRect: { x: 100, y: 200, width: 300, height: 50 },
      misaligned: false,
      misalignReason: null,
      selectorAmbiguous: false,
      selectorMatchCount: 1,
      rectClipped: false
    });
  });
});

describe('buildSauceRectRecords — viewport clipping', () => {
  it('clips a rect that extends below the viewport bottom', () => {
    const manifest = makeManifest({
      elementKeyframeMap: { 'h.tall': 'kf_0' },
      viewportHeight: 1080,
      keyframeMeasurements: [
        makeMeasurement('kf_0', [
          { id: 'h.tall', found: true, inViewport: true, viewportX: 0, viewportY: 900, width: 100, height: 300 }
        ])
      ]
    });
    const prefix = new Map([['kf_0', 'p']]);
    const [r] = buildSauceRectRecords(manifest, SESSION, ROLE, prefix);
    expect(r.rect).toEqual({ x: 0, y: 900, width: 100, height: 180 });
    expect(r.rawRect).toEqual({ x: 0, y: 900, width: 100, height: 300 });
    expect(r.rectClipped).toBe(true);
  });

  it('clips a rect that extends above the viewport top', () => {
    const manifest = makeManifest({
      elementKeyframeMap: { 'h.up': 'kf_0' },
      viewportHeight: 1080,
      keyframeMeasurements: [
        makeMeasurement('kf_0', [
          { id: 'h.up', found: true, inViewport: true, viewportX: 0, viewportY: -50, width: 100, height: 200 }
        ])
      ]
    });
    const prefix = new Map([['kf_0', 'p']]);
    const [r] = buildSauceRectRecords(manifest, SESSION, ROLE, prefix);
    expect(r.rect.y).toBe(0);
    expect(r.rect.height).toBe(150);
    expect(r.rawRect.y).toBe(-50);
    expect(r.rawRect.height).toBe(200);
    expect(r.rectClipped).toBe(true);
  });

  it('marks a rect entirely below the viewport as misaligned (clipped-below-fold)', () => {
    const manifest = makeManifest({
      elementKeyframeMap: { 'h.above': 'kf_0' },
      viewportHeight: 1080,
      keyframeMeasurements: [
        makeMeasurement('kf_0', [
          { id: 'h.above', found: true, inViewport: false, viewportX: 0, viewportY: -500, width: 100, height: 100 }
        ])
      ]
    });
    const prefix = new Map([['kf_0', 'p']]);
    const [r] = buildSauceRectRecords(manifest, SESSION, ROLE, prefix);
    expect(r.rect).toBeNull();
    expect(r.misaligned).toBe(true);
    expect(r.misalignReason).toBe('clipped-below-fold');
    expect(r.rectClipped).toBe(true);
  });
});

describe('buildSauceRectRecords — element-not-found / degraded', () => {
  it('emits a misaligned record when the element is not in the keyframe measurement', () => {
    const manifest = makeManifest({
      elementKeyframeMap: { 'h.missing': 'kf_0' },
      keyframeMeasurements: [makeMeasurement('kf_0', [])]
    });
    const prefix = new Map([['kf_0', 'p']]);
    const [r] = buildSauceRectRecords(manifest, SESSION, ROLE, prefix);
    expect(r.rect).toBeNull();
    expect(r.misaligned).toBe(true);
    expect(r.misalignReason).toBe('element-not-found');
  });

  it('emits a misaligned record when measurement marks element as not found', () => {
    const manifest = makeManifest({
      elementKeyframeMap: { 'h.gone': 'kf_0' },
      keyframeMeasurements: [
        makeMeasurement('kf_0', [
          { id: 'h.gone', found: false, misalignReason: 'selector-stale' }
        ])
      ]
    });
    const prefix = new Map([['kf_0', 'p']]);
    const [r] = buildSauceRectRecords(manifest, SESSION, ROLE, prefix);
    expect(r.rect).toBeNull();
    expect(r.misaligned).toBe(true);
    expect(r.misalignReason).toBe('selector-stale');
  });

  it('falls back to defaults when manifest has no remeasure data at all', () => {
    const manifest = {
      elementKeyframeMap: { 'h.legacy': 'kf_0' }
    };
    const prefix = new Map([['kf_0', 'p']]);
    const [r] = buildSauceRectRecords(manifest, SESSION, ROLE, prefix);
    expect(r.rect).toBeNull();
    expect(r.misaligned).toBe(true);
    expect(r.actualDPR).toBe(1);
  });

  it('skips elements whose keyframe is not in the prefix map (filtered out)', () => {
    const manifest = makeManifest({
      elementKeyframeMap: { 'h.in': 'kf_0', 'h.out': 'kf_1' },
      keyframeMeasurements: [
        makeMeasurement('kf_0', [{ id: 'h.in', found: true, inViewport: true, viewportX: 0, viewportY: 0, width: 10, height: 10 }])
      ]
    });
    const prefix = new Map([['kf_0', 'p0']]);
    const records = buildSauceRectRecords(manifest, SESSION, ROLE, prefix);
    expect(records).toHaveLength(1);
    expect(records[0].elementKey).toBe('h.in');
  });
});

describe('buildSauceRectRecords — hpid remap (compare side)', () => {
  it('rekeys compare-side records under the matched baseline hpid', () => {
    const manifest = makeManifest({
      elementKeyframeMap: { 'c.42': 'kf_0' },
      keyframeMeasurements: [
        makeMeasurement('kf_0', [
          { id: 'c.42', found: true, inViewport: true, viewportX: 5, viewportY: 5, width: 10, height: 10 }
        ])
      ]
    });
    const prefix = new Map([['kf_0', `${SESSION}_compare_kf_0`]]);
    const remap = new Map([['c.42', 'b.42']]);
    const [r] = buildSauceRectRecords(manifest, SESSION, 'compare', prefix, remap);
    expect(r.elementKey).toBe('b.42');
    expect(r.id).toBe(`${SESSION}_compare_rect_b.42`);
    expect(r.rect).toEqual({ x: 5, y: 5, width: 10, height: 10 });
  });

  it('skips compare elements not present in the remap (unmatched / added)', () => {
    const manifest = makeManifest({
      elementKeyframeMap: { 'c.added': 'kf_0', 'c.matched': 'kf_0' },
      keyframeMeasurements: [
        makeMeasurement('kf_0', [
          { id: 'c.added', found: true, inViewport: true, viewportX: 0, viewportY: 0, width: 10, height: 10 },
          { id: 'c.matched', found: true, inViewport: true, viewportX: 10, viewportY: 10, width: 10, height: 10 }
        ])
      ]
    });
    const prefix = new Map([['kf_0', 'p']]);
    const remap = new Map([['c.matched', 'b.matched']]);
    const records = buildSauceRectRecords(manifest, SESSION, 'compare', prefix, remap);
    expect(records).toHaveLength(1);
    expect(records[0].elementKey).toBe('b.matched');
  });
});

describe('buildSauceRectRecords — pseudo-element styles', () => {
  it('attaches pseudoBefore/pseudoAfter when present', () => {
    const manifest = makeManifest({
      elementKeyframeMap: { 'h.1': 'kf_0' },
      keyframeMeasurements: [
        makeMeasurement('kf_0',
          [{ id: 'h.1', found: true, inViewport: true, viewportX: 0, viewportY: 0, width: 10, height: 10 }],
          [{
            id: 'h.1',
            before: { content: '"⚠"', display: 'inline-block', color: 'red' },
            after: { content: '"✓"', display: 'inline', color: 'green' }
          }]
        )
      ]
    });
    const prefix = new Map([['kf_0', 'p']]);
    const [r] = buildSauceRectRecords(manifest, SESSION, ROLE, prefix);
    expect(r.pseudoBefore).toMatchObject({
      content: '"⚠"', display: 'inline-block', color: 'red',
      parentHpid: 'h.1', pseudoType: 'before'
    });
    expect(r.pseudoAfter).toMatchObject({
      content: '"✓"', parentHpid: 'h.1', pseudoType: 'after'
    });
  });

  it('keeps pseudo fields null when no pseudo styles exist', () => {
    const manifest = makeManifest({
      elementKeyframeMap: { 'h.plain': 'kf_0' },
      keyframeMeasurements: [
        makeMeasurement('kf_0',
          [{ id: 'h.plain', found: true, inViewport: true, viewportX: 0, viewportY: 0, width: 10, height: 10 }],
          [{ id: 'h.plain', before: null, after: null }]
        )
      ]
    });
    const prefix = new Map([['kf_0', 'p']]);
    const [r] = buildSauceRectRecords(manifest, SESSION, ROLE, prefix);
    expect(r.pseudoBefore).toBeNull();
    expect(r.pseudoAfter).toBeNull();
  });
});
