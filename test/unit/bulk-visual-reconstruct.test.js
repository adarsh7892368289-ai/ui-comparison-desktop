import { describe, it, expect } from 'vitest';
import {
  reconstructBulkVisualRecords,
  hpidAncestors,
  nearestMappedAncestor
} from '../../src/core/visual/bulk-visual-reconstruct.js';

function measRect(id, { x = 0, y = 10, w = 100, h = 20, found = true, inViewport = true } = {}) {
  return { id, found, inViewport, viewportX: x, viewportY: y, width: w, height: h };
}

// A sauce-shaped extraction manifest with one keyframe per element for simplicity.
function manifestFor(elements, { viewportHeight = 900, documentHeight = 3000, actualDPR = 2 } = {}) {
  const keyframes = [];
  const elementKeyframeMap = {};
  const documentYById = {};
  const keyframeMeasurements = [];
  elements.forEach((el, i) => {
    const kfId = `kf_${i}`;
    keyframes.push({ id: kfId, scrollY: i * 100, viewportWidth: 1280, viewportHeight, elementIds: [el.hpid], filename: null });
    elementKeyframeMap[el.hpid] = kfId;
    documentYById[el.hpid] = el.docY ?? i * 100 + 10;
    keyframeMeasurements.push({
      keyframeId: kfId,
      actualScrollY: i * 100,
      rects: [measRect(el.hpid, el.rect)],
      pseudoStyles: el.pseudo ? [{ id: el.hpid, before: el.pseudo.before ?? null, after: el.pseudo.after ?? null }] : []
    });
  });
  return { keyframes, elementKeyframeMap, documentYById, documentHeight, viewportHeight, actualDPR, keyframeMeasurements };
}

describe('hpid helpers', () => {
  it('hpidAncestors returns prefixes from nearest to root', () => {
    expect(hpidAncestors('1.2.3.4')).toEqual(['1.2.3', '1.2', '1']);
    expect(hpidAncestors('1')).toEqual([]);
  });

  it('nearestMappedAncestor finds closest present ancestor', () => {
    const map = new Map([['1', 'a'], ['1.2', 'b']]);
    expect(nearestMappedAncestor('1.2.5.9', map)).toBe('1.2');
    expect(nearestMappedAncestor('1.7', map)).toBe('1');
    expect(nearestMappedAncestor('9.9', map)).toBe(null);
  });
});

describe('reconstructBulkVisualRecords', () => {
  it('returns empty when both manifests missing', () => {
    const out = reconstructBulkVisualRecords({ sessionId: 's', comparisonResults: [], unmatchedElements: {}, baselineManifest: null, compareManifest: null });
    expect(out).toEqual({ keyframeRecords: [], rectRecords: [], blobPlan: [] });
  });

  it('produces only the present side when the opposite manifest is missing (removed-only, no compare capture)', () => {
    const baseM = manifestFor([{ hpid: '2' }, { hpid: '2.7' }]);
    const out = reconstructBulkVisualRecords({
      sessionId: 'sess',
      comparisonResults: [{ baselineElement: { hpid: '2' }, compareElement: { hpid: '2' }, totalDifferences: 0 }],
      unmatchedElements: { baseline: [{ hpid: '2.7' }], compare: [] },
      baselineManifest: baseM, compareManifest: null
    });
    const removed = out.rectRecords.filter((r) => r.elementKey === '2.7');
    // baseline real rect present; compare context skipped (no compare manifest)
    expect(removed).toHaveLength(1);
    expect(removed[0].tabRole).toBe('baseline');
    expect(out.blobPlan.every((b) => b.side === 'baseline')).toBe(true);
  });

  it('builds both-side records for a modified matched pair keyed by baseline hpid', () => {
    const baseM = manifestFor([{ hpid: '1.2' }]);
    const cmpM = manifestFor([{ hpid: '1.3' }]);
    const out = reconstructBulkVisualRecords({
      sessionId: 'sess',
      comparisonResults: [{ baselineElement: { hpid: '1.2' }, compareElement: { hpid: '1.3' }, totalDifferences: 3 }],
      unmatchedElements: { baseline: [], compare: [] },
      baselineManifest: baseM, compareManifest: cmpM
    });

    const byKey = out.rectRecords.filter((r) => r.elementKey === '1.2');
    expect(byKey).toHaveLength(2);
    const base = byKey.find((r) => r.tabRole === 'baseline');
    const cmp = byKey.find((r) => r.tabRole === 'compare');
    expect(base.keyframeId).toBe('sess_baseline_kf_0');
    expect(cmp.keyframeId).toBe('sess_compare_kf_0');
    // both rects real
    expect(base.rect).toBeTruthy();
    expect(cmp.rect).toBeTruthy();
    // blob plan references both raw keyframes
    expect(out.blobPlan).toEqual(expect.arrayContaining([
      { side: 'baseline', rawKfId: 'kf_0', prefixedId: 'sess_baseline_kf_0' },
      { side: 'compare', rawKfId: 'kf_0', prefixedId: 'sess_compare_kf_0' }
    ]));
  });

  it('skips unchanged matched pairs (no totalDifferences)', () => {
    const baseM = manifestFor([{ hpid: '1.2' }]);
    const cmpM = manifestFor([{ hpid: '1.2' }]);
    const out = reconstructBulkVisualRecords({
      sessionId: 'sess',
      comparisonResults: [{ baselineElement: { hpid: '1.2' }, compareElement: { hpid: '1.2' }, totalDifferences: 0 }],
      unmatchedElements: { baseline: [], compare: [] },
      baselineManifest: baseM, compareManifest: cmpM
    });
    expect(out.rectRecords).toHaveLength(0);
    expect(out.keyframeRecords).toHaveLength(0);
  });

  it('added element: real compare rect + baseline context region from nearest matched ancestor', () => {
    // ancestor 1 is matched; added element 1.5 exists only in compare
    const baseM = manifestFor([{ hpid: '1' }, { hpid: '1.5_unused' }]);
    const cmpM = manifestFor([{ hpid: '1' }, { hpid: '1.5' }]);
    const out = reconstructBulkVisualRecords({
      sessionId: 'sess',
      comparisonResults: [{ baselineElement: { hpid: '1' }, compareElement: { hpid: '1' }, totalDifferences: 0 }],
      unmatchedElements: { baseline: [], compare: [{ hpid: '1.5' }] },
      baselineManifest: baseM, compareManifest: cmpM
    });

    const added = out.rectRecords.filter((r) => r.elementKey === '1.5');
    expect(added).toHaveLength(2);
    const cmp = added.find((r) => r.tabRole === 'compare');
    const base = added.find((r) => r.tabRole === 'baseline');
    // compare side is the real captured element (kf_1 in compare manifest)
    expect(cmp.keyframeId).toBe('sess_compare_kf_1');
    // baseline context comes from ancestor '1' -> baseline kf_0
    expect(base.keyframeId).toBe('sess_baseline_kf_0');
  });

  it('removed element: real baseline rect + compare context region', () => {
    const baseM = manifestFor([{ hpid: '2' }, { hpid: '2.7' }]);
    const cmpM = manifestFor([{ hpid: '2' }]);
    const out = reconstructBulkVisualRecords({
      sessionId: 'sess',
      comparisonResults: [{ baselineElement: { hpid: '2' }, compareElement: { hpid: '2' }, totalDifferences: 0 }],
      unmatchedElements: { baseline: [{ hpid: '2.7' }], compare: [] },
      baselineManifest: baseM, compareManifest: cmpM
    });
    const removed = out.rectRecords.filter((r) => r.elementKey === '2.7');
    expect(removed).toHaveLength(2);
    expect(removed.find((r) => r.tabRole === 'baseline').keyframeId).toBe('sess_baseline_kf_1');
    expect(removed.find((r) => r.tabRole === 'compare').keyframeId).toBe('sess_compare_kf_0');
  });

  it('added element with no matched ancestor yields only the compare side', () => {
    const baseM = manifestFor([{ hpid: '9' }]);
    const cmpM = manifestFor([{ hpid: '8.1' }]);
    const out = reconstructBulkVisualRecords({
      sessionId: 'sess',
      comparisonResults: [],
      unmatchedElements: { baseline: [], compare: [{ hpid: '8.1' }] },
      baselineManifest: baseM, compareManifest: cmpM
    });
    const added = out.rectRecords.filter((r) => r.elementKey === '8.1');
    expect(added).toHaveLength(1);
    expect(added[0].tabRole).toBe('compare');
  });

  it('marks element-not-found when source hpid absent from manifest', () => {
    const baseM = manifestFor([{ hpid: '1' }]);
    const cmpM = manifestFor([{ hpid: '1' }]);
    // modified pair references baseline hpid '1.99' that was never captured
    const out = reconstructBulkVisualRecords({
      sessionId: 'sess',
      comparisonResults: [{ baselineElement: { hpid: '1' }, compareElement: { hpid: '1' }, totalDifferences: 2 }],
      unmatchedElements: { baseline: [], compare: [] },
      baselineManifest: baseM, compareManifest: cmpM
    });
    expect(out.rectRecords.find((r) => r.tabRole === 'baseline').rect).toBeTruthy();
  });

  it('only emits keyframe records actually referenced', () => {
    const baseM = manifestFor([{ hpid: '1' }, { hpid: '2' }, { hpid: '3' }]);
    const cmpM = manifestFor([{ hpid: '1' }, { hpid: '2' }, { hpid: '3' }]);
    const out = reconstructBulkVisualRecords({
      sessionId: 'sess',
      comparisonResults: [{ baselineElement: { hpid: '2' }, compareElement: { hpid: '2' }, totalDifferences: 1 }],
      unmatchedElements: { baseline: [], compare: [] },
      baselineManifest: baseM, compareManifest: cmpM
    });
    // only kf_1 (element '2') on each side
    expect(out.keyframeRecords.map((k) => k.id).sort()).toEqual(['sess_baseline_kf_1', 'sess_compare_kf_1']);
  });

  it('carries pseudo styles onto rect records', () => {
    const baseM = manifestFor([{ hpid: '1', pseudo: { before: { content: '"x"' } } }]);
    const cmpM = manifestFor([{ hpid: '1' }]);
    const out = reconstructBulkVisualRecords({
      sessionId: 'sess',
      comparisonResults: [{ baselineElement: { hpid: '1' }, compareElement: { hpid: '1' }, totalDifferences: 1 }],
      unmatchedElements: { baseline: [], compare: [] },
      baselineManifest: baseM, compareManifest: cmpM
    });
    const base = out.rectRecords.find((r) => r.tabRole === 'baseline');
    expect(base.pseudoBefore).toMatchObject({ content: '"x"', parentHpid: '1', pseudoType: 'before' });
  });
});
