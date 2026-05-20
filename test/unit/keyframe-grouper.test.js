import { describe, it, expect } from 'vitest';
import { groupIntoKeyframes } from '../../src/core/comparison/keyframe-grouper.js';

describe('keyframe-grouper', () => {
  it('returns empty array for empty input', () => {
    expect(groupIntoKeyframes([], 900, 1920, 5000)).toEqual([]);
    expect(groupIntoKeyframes(null, 900, 1920, 5000)).toEqual([]);
  });

  it('groups a single element into one keyframe', () => {
    const elements = [
    { id: 'a.1', documentY: 100, height: 50, width: 200 }];

    const kfs = groupIntoKeyframes(elements, 900, 1920, 5000);
    expect(kfs).toHaveLength(1);
    expect(kfs[0].elementIds).toContain('a.1');
    expect(kfs[0].id).toBe('kf_0');
    expect(kfs[0].viewportWidth).toBe(1920);
    expect(kfs[0].viewportHeight).toBe(900);
  });

  it('groups elements with the same root into a single cluster', () => {
    const elements = [
    { id: 'root.0', documentY: 100, height: 50, width: 200 },
    { id: 'root.1', documentY: 200, height: 50, width: 200 },
    { id: 'root.2', documentY: 300, height: 50, width: 200 }];

    const kfs = groupIntoKeyframes(elements, 900, 1920, 5000);
    expect(kfs).toHaveLength(1);
    expect(kfs[0].elementIds).toHaveLength(3);
  });

  it('splits tall clusters into multiple keyframes', () => {
    const elements = [];
    for (let i = 0; i < 20; i++) {
      elements.push({ id: `root.${i}`, documentY: i * 200, height: 50, width: 200 });
    }
    const viewportHeight = 500;
    const documentHeight = 4000;
    const kfs = groupIntoKeyframes(elements, viewportHeight, 1920, documentHeight);
    expect(kfs.length).toBeGreaterThan(1);

    const allIds = kfs.flatMap((kf) => kf.elementIds);
    expect(allIds).toHaveLength(20);
  });

  it('produces non-overlapping scrollY for different roots', () => {
    const elements = [
    { id: 'top.0', documentY: 0, height: 50, width: 200 },
    { id: 'bottom.0', documentY: 3000, height: 50, width: 200 }];

    const kfs = groupIntoKeyframes(elements, 900, 1920, 5000);
    expect(kfs.length).toBe(2);
    expect(kfs[0].scrollY).not.toBe(kfs[1].scrollY);
  });

  it('clamps scrollY so it never exceeds documentHeight - viewportHeight', () => {
    const elements = [
    { id: 'end.0', documentY: 4900, height: 50, width: 200 }];

    const kfs = groupIntoKeyframes(elements, 900, 1920, 5000);
    expect(kfs[0].scrollY).toBeLessThanOrEqual(5000 - 900);
  });

  describe('Scenario C filter test — concrete fixture', () => {
    it('produces exactly 3 keyframe IDs for elements distributed across 10 frames', () => {


      const viewportHeight = 500;
      const documentHeight = 10000;
      const elements = [];

      for (let i = 0; i < 10; i++) {
        const root = `root${i}`;

        for (let j = 0; j < 3; j++) {
          elements.push({
            id: `${root}.${j}`,
            documentY: i * 1000 + j * 50,
            height: 40,
            width: 200
          });
        }
      }

      const keyframes = groupIntoKeyframes(elements, viewportHeight, 1920, documentHeight);
      expect(keyframes.length).toBe(10);


      const elementKeyframeMap = {};
      for (const kf of keyframes) {
        for (const elId of kf.elementIds) {
          elementKeyframeMap[elId] = kf.id;
        }
      }


      const diffHpids = new Set(['root0.0', 'root0.2', 'root4.1', 'root7.0']);

      const diffKeyframeIds = new Set();
      for (const hpid of diffHpids) {
        if (elementKeyframeMap[hpid]) {
          diffKeyframeIds.add(elementKeyframeMap[hpid]);
        }
      }


      expect(diffKeyframeIds.size).toBe(3);


      const expectedKfIds = new Set([
      keyframes[0].id,
      keyframes[4].id,
      keyframes[7].id]
      );
      expect(diffKeyframeIds).toEqual(expectedKfIds);


      for (const kf of keyframes) {
        if (![0, 4, 7].includes(keyframes.indexOf(kf))) {
          expect(diffKeyframeIds.has(kf.id)).toBe(false);
        }
      }
    });
  });
});