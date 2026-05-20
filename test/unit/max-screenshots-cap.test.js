import { describe, it, expect } from 'vitest';
import { groupIntoKeyframes } from '../../src/core/comparison/keyframe-grouper.js';







function capKeyframes(keyframes, maxKeyframes) {
  if (keyframes.length <= maxKeyframes) return keyframes;


  keyframes.sort((a, b) => b.elementIds.length - a.elementIds.length);
  keyframes = keyframes.slice(0, maxKeyframes);


  keyframes.sort((a, b) => a.scrollY - b.scrollY);


  for (let i = 0; i < keyframes.length; i++) {
    keyframes[i].id = 'kf_' + i;
  }

  return keyframes;
}

describe('MAX_SCREENSHOTS_PER_SESSION capping', () => {
  it('does not cap when keyframes <= max', () => {
    const keyframes = [
    { id: 'kf_0', scrollY: 0, elementIds: ['a', 'b', 'c'], viewportWidth: 1920, viewportHeight: 900 },
    { id: 'kf_1', scrollY: 900, elementIds: ['d', 'e'], viewportWidth: 1920, viewportHeight: 900 }];

    const result = capKeyframes([...keyframes], 200);
    expect(result).toHaveLength(2);
  });

  it('caps to MAX_KEYFRAMES when exceeded', () => {
    const keyframes = [];
    for (let i = 0; i < 300; i++) {
      keyframes.push({
        id: `kf_${i}`,
        scrollY: i * 900,
        elementIds: Array.from({ length: Math.floor(Math.random() * 10) + 1 }, (_, j) => `el_${i}_${j}`),
        viewportWidth: 1920,
        viewportHeight: 900
      });
    }
    const result = capKeyframes(keyframes, 200);
    expect(result).toHaveLength(200);
  });

  it('keeps keyframes with most elements (greedy retention)', () => {
    const keyframes = [
    { id: 'kf_0', scrollY: 0, elementIds: ['a'], viewportWidth: 1920, viewportHeight: 900 },
    { id: 'kf_1', scrollY: 900, elementIds: ['b', 'c', 'd', 'e', 'f'], viewportWidth: 1920, viewportHeight: 900 },
    { id: 'kf_2', scrollY: 1800, elementIds: ['g', 'h'], viewportWidth: 1920, viewportHeight: 900 }];

    const result = capKeyframes([...keyframes], 2);
    expect(result).toHaveLength(2);

    const allElementIds = result.flatMap((kf) => kf.elementIds);
    expect(allElementIds).toContain('b');
    expect(allElementIds).toContain('g');
    expect(allElementIds).not.toContain('a');
  });

  it('re-sorts by scrollY after capping for sequential capture', () => {
    const keyframes = [
    { id: 'kf_0', scrollY: 0, elementIds: ['a'], viewportWidth: 1920, viewportHeight: 900 },
    { id: 'kf_1', scrollY: 900, elementIds: ['b', 'c', 'd'], viewportWidth: 1920, viewportHeight: 900 },
    { id: 'kf_2', scrollY: 1800, elementIds: ['e', 'f', 'g', 'h'], viewportWidth: 1920, viewportHeight: 900 },
    { id: 'kf_3', scrollY: 2700, elementIds: ['i', 'j'], viewportWidth: 1920, viewportHeight: 900 }];

    const result = capKeyframes([...keyframes], 3);
    expect(result).toHaveLength(3);


    for (let i = 1; i < result.length; i++) {
      expect(result[i].scrollY).toBeGreaterThanOrEqual(result[i - 1].scrollY);
    }
  });

  it('re-indexes IDs after capping', () => {
    const keyframes = [];
    for (let i = 0; i < 10; i++) {
      keyframes.push({
        id: `kf_${i}`,
        scrollY: i * 900,
        elementIds: [`el_${i}`],
        viewportWidth: 1920,
        viewportHeight: 900
      });
    }
    const result = capKeyframes(keyframes, 5);
    expect(result).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(result[i].id).toBe(`kf_${i}`);
    }
  });

  it('integrates with groupIntoKeyframes output for large pages', () => {

    const elements = [];
    for (let root = 0; root < 100; root++) {
      for (let el = 0; el < 5; el++) {
        elements.push({
          id: `root${root}.${el}`,
          documentY: root * 200 + el * 30,
          height: 25,
          width: 300
        });
      }
    }

    const keyframes = groupIntoKeyframes(elements, 900, 1920, 20000);
    expect(keyframes.length).toBeGreaterThan(5);


    const capped = capKeyframes([...keyframes], 10);
    expect(capped).toHaveLength(10);


    const allInputIds = new Set(elements.map((e) => e.id));
    for (const kf of capped) {
      for (const id of kf.elementIds) {
        expect(allInputIds.has(id)).toBe(true);
      }
    }
  });
});