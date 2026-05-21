import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  buildSauceRectRecords,
  computeDiffKeyframeIds
} from '@core/saucelabs-bridge/visual-records.js';

// ---------------------------------------------------------------------------
// Contract test: the SauceLabs runner spec (src/saucelabs-runner/extract.spec.js)
// emits a screenshots-manifest.json with a specific shape. The renderer's
// bridge functions (visual-records.js) parse that shape. If either side drifts
// without the other, screenshots silently disappear from the HTML report.
//
// This test asserts that the field names the spec writes are the same field
// names the bridge reads. We do this by:
//   1. Statically grepping the spec source for the keys it emits into manifest.
//   2. Confirming each expected key is present.
//   3. Constructing a minimal manifest with that exact shape and pushing it
//      through the bridge — verifying it produces a valid record.
// ---------------------------------------------------------------------------

const SPEC_PATH = resolve(__dirname, '../../src/saucelabs-runner/extract.spec.js');
const specSource = readFileSync(SPEC_PATH, 'utf8');

describe('SauceLabs manifest schema contract', () => {
  // Top-level manifest fields the spec writes inside `const manifest = { ... }`.
  // These are the exact keys the bridge reads via manifest?.<key>.
  const REQUIRED_TOP_LEVEL_KEYS = [
    'keyframes',
    'elementKeyframeMap',
    'documentYById',
    'documentHeight',
    'viewportHeight',
    'actualDPR',
    'keyframeMeasurements'
  ];

  for (const key of REQUIRED_TOP_LEVEL_KEYS) {
    it(`spec emits manifest.${key}`, () => {
      // Match `key:`, `key,`, or `key` at end-of-line (shorthand property syntax).
      const re = new RegExp(`\\b${key}\\b(?:\\s*[,:]|\\s*$)`, 'm');
      expect(re.test(specSource)).toBe(true);
    });
  }

  // Per-keyframe fields the renderer reads off the keyframes[] array.
  const KEYFRAME_FIELDS = ['id', 'scrollY', 'viewportWidth', 'viewportHeight', 'elementIds', 'filename'];
  for (const field of KEYFRAME_FIELDS) {
    it(`spec emits keyframes[].${field}`, () => {
      const re = new RegExp(`${field}:\\s*`);
      expect(re.test(specSource)).toBe(true);
    });
  }

  // Per-keyframe-measurement fields the renderer reads off keyframeMeasurements[].
  const MEASUREMENT_FIELDS = ['keyframeId', 'actualScrollY', 'rects', 'pseudoStyles'];
  for (const field of MEASUREMENT_FIELDS) {
    it(`spec emits keyframeMeasurements[].${field}`, () => {
      const re = new RegExp(`${field}:\\s*`);
      expect(re.test(specSource)).toBe(true);
    });
  }

  // Per-rect fields the bridge reads off keyframeMeasurements[].rects[].
  // The remeasure function constructs these inline; we look for them in the
  // spec source as object keys produced by inPageRemeasureRects.
  const RECT_FIELDS = ['id', 'found', 'inViewport', 'viewportX', 'viewportY', 'width', 'height', 'misalignReason', 'selectorAmbiguous', 'selectorMatchCount'];
  for (const field of RECT_FIELDS) {
    it(`spec emits keyframeMeasurements[].rects[].${field}`, () => {
      // Permit either `field:` or `field,` (shorthand property).
      const re = new RegExp(`\\b${field}\\b\\s*[,:]`);
      expect(re.test(specSource)).toBe(true);
    });
  }
});

describe('SauceLabs manifest end-to-end roundtrip', () => {
  // A full "happy path" manifest in the exact shape the spec writes.
  // Push it through the bridge and verify the output record shape is what
  // the local Compare flow's _rebuildVisualDiffsFromSession expects.
  function makeRealisticManifest() {
    return {
      keyframes: [
        {
          id: 'kf_0',
          scrollY: 0,
          viewportWidth: 1920,
          viewportHeight: 1080,
          elementIds: ['1.2.3', '1.2.4'],
          filename: 'keyframe-0.jpg'
        },
        {
          id: 'kf_1',
          scrollY: 1080,
          viewportWidth: 1920,
          viewportHeight: 1080,
          elementIds: ['1.5.1'],
          filename: 'keyframe-1.jpg'
        }
      ],
      elementKeyframeMap: {
        '1.2.3': 'kf_0',
        '1.2.4': 'kf_0',
        '1.5.1': 'kf_1'
      },
      documentYById: { '1.2.3': 50, '1.2.4': 200, '1.5.1': 1500 },
      documentHeight: 6000,
      viewportHeight: 1080,
      actualDPR: 2,
      keyframeMeasurements: [
        {
          keyframeId: 'kf_0',
          actualScrollY: 0,
          rects: [
            { id: '1.2.3', found: true, inViewport: true, viewportX: 100, viewportY: 50, width: 800, height: 60, selectorAmbiguous: false, selectorMatchCount: 1, misalignReason: null },
            { id: '1.2.4', found: true, inViewport: true, viewportX: 100, viewportY: 200, width: 800, height: 400, selectorAmbiguous: false, selectorMatchCount: 1, misalignReason: null }
          ],
          pseudoStyles: [
            { id: '1.2.3', before: null, after: null },
            { id: '1.2.4', before: { content: '"›"', display: 'inline-block' }, after: null }
          ]
        },
        {
          keyframeId: 'kf_1',
          actualScrollY: 1080,
          rects: [
            { id: '1.5.1', found: true, inViewport: true, viewportX: 50, viewportY: 420, width: 1820, height: 100, selectorAmbiguous: false, selectorMatchCount: 1, misalignReason: null }
          ],
          pseudoStyles: [{ id: '1.5.1', before: null, after: null }]
        }
      ]
    };
  }

  it('produces rect records with all fields _rebuildVisualDiffsFromSession reads', () => {
    const manifest = makeRealisticManifest();
    const sessionId = 'cmp-uuid';
    const role = 'baseline';
    const prefixById = new Map([
      ['kf_0', `${sessionId}_${role}_kf_0`],
      ['kf_1', `${sessionId}_${role}_kf_1`]
    ]);
    const records = buildSauceRectRecords(manifest, sessionId, role, prefixById);
    expect(records).toHaveLength(3);

    // Locate the element-with-pseudo to confirm pseudo wiring.
    const withPseudo = records.find((r) => r.elementKey === '1.2.4');
    expect(withPseudo.pseudoBefore).toMatchObject({
      content: '"›"',
      parentHpid: '1.2.4',
      pseudoType: 'before'
    });

    // The rebuild path (compare-workflow.js _rebuildVisualDiffsFromSession's
    // toEntry function) reads exactly these fields. If any is missing, the
    // rendered diff entries will be malformed.
    for (const r of records) {
      expect(r).toHaveProperty('keyframeId');
      expect(r).toHaveProperty('rect');
      expect(r).toHaveProperty('rawRect');
      expect(r).toHaveProperty('actualDPR');
      expect(r).toHaveProperty('documentY');
      expect(r).toHaveProperty('totalDocumentHeight');
      expect(r).toHaveProperty('pseudoBefore');
      expect(r).toHaveProperty('pseudoAfter');
      expect(r).toHaveProperty('misaligned');
      expect(r).toHaveProperty('misalignReason');
      expect(r).toHaveProperty('selectorAmbiguous');
      expect(r).toHaveProperty('selectorMatchCount');
      expect(r).toHaveProperty('rectClipped');
      expect(r.tabRole).toBe(role);
      expect(r.sessionId).toBe(sessionId);
    }
  });

  it('Scenario C filter selects only diff keyframes from a realistic manifest', () => {
    const manifest = makeRealisticManifest();
    const comparisonResults = [
      { baselineElement: { hpid: '1.2.3' }, totalDifferences: 2 }, // diff in kf_0
      { baselineElement: { hpid: '1.2.4' }, totalDifferences: 0 }, // unchanged
      { baselineElement: { hpid: '1.5.1' }, totalDifferences: 5 }  // diff in kf_1
    ];
    const ids = computeDiffKeyframeIds(comparisonResults, manifest, manifest);
    expect([...ids].sort()).toEqual(['kf_0', 'kf_1']);
  });
});
