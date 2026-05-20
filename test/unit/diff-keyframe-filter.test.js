import { describe, it, expect } from 'vitest';







function computeDiffKeyframeIds(comparisonResults, baselineManifest, compareManifest) {
  const diffHpids = new Set();
  for (const r of comparisonResults ?? []) {
    if ((r.totalDifferences ?? 0) > 0) {
      const hpid = r.baselineElement?.hpid ?? null;
      if (hpid) diffHpids.add(hpid);
    }
  }

  const diffKeyframeIds = new Set();
  const baseMap = baselineManifest?.elementKeyframeMap ?? {};
  const compMap = compareManifest?.elementKeyframeMap ?? {};

  for (const hpid of diffHpids) {
    if (baseMap[hpid]) diffKeyframeIds.add(baseMap[hpid]);
    if (compMap[hpid]) diffKeyframeIds.add(compMap[hpid]);
  }

  return diffKeyframeIds;
}

describe('_computeDiffKeyframeIds (Scenario C filter)', () => {
  it('returns empty set when no comparison results have diffs', () => {
    const results = [
    { baselineElement: { hpid: 'el1' }, totalDifferences: 0 },
    { baselineElement: { hpid: 'el2' }, totalDifferences: 0 }];

    const manifest = {
      elementKeyframeMap: { el1: 'kf_0', el2: 'kf_1' }
    };
    const ids = computeDiffKeyframeIds(results, manifest, manifest);
    expect(ids.size).toBe(0);
  });

  it('returns correct keyframe IDs for elements with diffs', () => {
    const results = [
    { baselineElement: { hpid: 'el1' }, totalDifferences: 3 },
    { baselineElement: { hpid: 'el2' }, totalDifferences: 0 },
    { baselineElement: { hpid: 'el3' }, totalDifferences: 1 }];

    const baseManifest = {
      elementKeyframeMap: { el1: 'kf_0', el2: 'kf_1', el3: 'kf_2' }
    };
    const compManifest = {
      elementKeyframeMap: { el1: 'kf_0', el2: 'kf_1', el3: 'kf_2' }
    };
    const ids = computeDiffKeyframeIds(results, baseManifest, compManifest);
    expect(ids.size).toBe(2);
    expect(ids.has('kf_0')).toBe(true);
    expect(ids.has('kf_2')).toBe(true);
    expect(ids.has('kf_1')).toBe(false);
  });

  it('includes keyframes from both baseline and compare manifests', () => {
    const results = [
    { baselineElement: { hpid: 'el1' }, totalDifferences: 2 }];

    const baseManifest = { elementKeyframeMap: { el1: 'kf_base_0' } };
    const compManifest = { elementKeyframeMap: { el1: 'kf_comp_3' } };

    const ids = computeDiffKeyframeIds(results, baseManifest, compManifest);
    expect(ids.size).toBe(2);
    expect(ids.has('kf_base_0')).toBe(true);
    expect(ids.has('kf_comp_3')).toBe(true);
  });

  it('handles null manifests gracefully', () => {
    const results = [
    { baselineElement: { hpid: 'el1' }, totalDifferences: 5 }];

    const ids = computeDiffKeyframeIds(results, null, null);
    expect(ids.size).toBe(0);
  });

  it('handles missing hpid gracefully', () => {
    const results = [
    { baselineElement: {}, totalDifferences: 5 },
    { baselineElement: null, totalDifferences: 3 },
    { totalDifferences: 2 }];

    const manifest = { elementKeyframeMap: {} };
    const ids = computeDiffKeyframeIds(results, manifest, manifest);
    expect(ids.size).toBe(0);
  });

  it('deduplicates when multiple diff elements share the same keyframe', () => {
    const results = [
    { baselineElement: { hpid: 'el1' }, totalDifferences: 1 },
    { baselineElement: { hpid: 'el2' }, totalDifferences: 1 },
    { baselineElement: { hpid: 'el3' }, totalDifferences: 1 }];


    const manifest = {
      elementKeyframeMap: { el1: 'kf_0', el2: 'kf_0', el3: 'kf_0' }
    };
    const ids = computeDiffKeyframeIds(results, manifest, manifest);
    expect(ids.size).toBe(1);
    expect(ids.has('kf_0')).toBe(true);
  });

  describe('Scenario C concrete fixture', () => {
    it('10 keyframes, diffs in 3 → exactly 3 diffKeyframeIds', () => {

      const elementKeyframeMap = {};
      for (let kf = 0; kf < 10; kf++) {
        for (let el = 0; el < 3; el++) {
          elementKeyframeMap[`el_${kf}_${el}`] = `kf_${kf}`;
        }
      }


      const results = [
      { baselineElement: { hpid: 'el_2_0' }, totalDifferences: 4 },
      { baselineElement: { hpid: 'el_2_2' }, totalDifferences: 1 },
      { baselineElement: { hpid: 'el_5_1' }, totalDifferences: 2 },
      { baselineElement: { hpid: 'el_8_0' }, totalDifferences: 7 },

      { baselineElement: { hpid: 'el_0_0' }, totalDifferences: 0 },
      { baselineElement: { hpid: 'el_1_1' }, totalDifferences: 0 },
      { baselineElement: { hpid: 'el_3_2' }, totalDifferences: 0 },
      { baselineElement: { hpid: 'el_4_0' }, totalDifferences: 0 },
      { baselineElement: { hpid: 'el_6_1' }, totalDifferences: 0 },
      { baselineElement: { hpid: 'el_7_2' }, totalDifferences: 0 },
      { baselineElement: { hpid: 'el_9_0' }, totalDifferences: 0 }];


      const manifest = { elementKeyframeMap };
      const ids = computeDiffKeyframeIds(results, manifest, manifest);

      expect(ids.size).toBe(3);
      expect(ids.has('kf_2')).toBe(true);
      expect(ids.has('kf_5')).toBe(true);
      expect(ids.has('kf_8')).toBe(true);


      for (let i = 0; i < 10; i++) {
        if (![2, 5, 8].includes(i)) {
          expect(ids.has(`kf_${i}`)).toBe(false);
        }
      }
    });
  });
});