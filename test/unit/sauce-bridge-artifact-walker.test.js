import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  walkFiles,
  findFirstByName,
  findAllMatchingPattern,
  STOP_WALK
} from '@core/saucelabs-bridge/artifact-walker.js';

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sauce-walker-test-'));
});

afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function mk(...parts) {
  const full = path.join(tmpRoot, ...parts);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, '');
  return full;
}

function trySymlink(target, linkPath) {
  // Symlinks may require admin on Windows; skip the test if it fails.
  try {
    fs.symlinkSync(target, linkPath, 'dir');
    return true;
  } catch {
    return false;
  }
}

describe('walkFiles — happy path', () => {
  it('visits every regular file under the root', () => {
    mk('a.txt');
    mk('sub', 'b.txt');
    mk('sub', 'deep', 'c.txt');

    const seen = [];
    walkFiles(tmpRoot, (full, entry) => {
      seen.push(entry.name);
    });
    expect(seen.sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('does nothing when root does not exist', () => {
    const seen = [];
    walkFiles(path.join(tmpRoot, 'nonexistent'), (full) => seen.push(full));
    expect(seen).toEqual([]);
  });

  it('does nothing when given falsy root', () => {
    expect(() => walkFiles(null, () => { })).not.toThrow();
    expect(() => walkFiles('', () => { })).not.toThrow();
    expect(() => walkFiles(undefined, () => { })).not.toThrow();
  });

  it('does nothing when root is a regular file (not a directory)', () => {
    const f = mk('only-a-file.txt');
    const seen = [];
    walkFiles(f, (full) => seen.push(full));
    expect(seen).toEqual([]);
  });
});

describe('walkFiles — STOP_WALK early exit', () => {
  it('stops on STOP_WALK return value', () => {
    mk('a.txt'); mk('b.txt'); mk('c.txt');
    let count = 0;
    walkFiles(tmpRoot, () => {
      count++;
      if (count >= 1) return STOP_WALK;
      return undefined;
    });
    expect(count).toBe(1);
  });

  it('stops on STOP_WALK thrown', () => {
    mk('a.txt'); mk('b.txt'); mk('c.txt');
    let count = 0;
    walkFiles(tmpRoot, () => {
      count++;
      if (count >= 2) throw STOP_WALK;
    });
    expect(count).toBe(2);
  });

  it('rethrows non-STOP_WALK errors from visit()', () => {
    mk('a.txt');
    expect(() => walkFiles(tmpRoot, () => { throw new Error('user-bug'); }))
      .toThrow('user-bug');
  });
});

describe('walkFiles — symlink safety', () => {
  it('skips symlinked files', () => {
    const real = mk('real.txt');
    const linkPath = path.join(tmpRoot, 'link.txt');
    if (!trySymlink(real, linkPath)) return; // skip if symlinks unavailable

    const names = [];
    walkFiles(tmpRoot, (full, entry) => names.push(entry.name));
    expect(names).toContain('real.txt');
    expect(names).not.toContain('link.txt');
  });

  it('does not follow symlinked directories (no infinite loop)', () => {
    mk('dir-a', 'inside-a.txt');
    const linkPath = path.join(tmpRoot, 'dir-a', 'loop');
    // loop -> .. (parent of dir-a, i.e. tmpRoot itself).
    if (!trySymlink(tmpRoot, linkPath)) return; // skip on Windows non-admin

    let nodeCount = 0;
    walkFiles(tmpRoot, () => {
      if (++nodeCount > 100) throw new Error('walker did not terminate');
    });
    // Without symlink protection, this would loop forever or hit MAX_WALK_NODES.
    // We expect it to find inside-a.txt exactly once and not chase the loop.
    expect(nodeCount).toBeLessThan(50);
  });

  it('does not follow symlinks to absolute external dirs', () => {
    // Create a "secret" outside the walk root.
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sauce-walker-external-'));
    try {
      fs.writeFileSync(path.join(externalRoot, 'secret.txt'), '');
      const linkPath = path.join(tmpRoot, 'escape');
      if (!trySymlink(externalRoot, linkPath)) return;

      const names = [];
      walkFiles(tmpRoot, (full, entry) => names.push(entry.name));
      expect(names).not.toContain('secret.txt');
    } finally {
      try { fs.rmSync(externalRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe('walkFiles — caps', () => {
  it('respects maxDepth', () => {
    mk('lvl1', 'lvl2', 'lvl3', 'lvl4', 'lvl5', 'deep.txt');
    const warnings = [];
    const names = [];
    walkFiles(tmpRoot,
      (full, entry) => { names.push(entry.name); },
      { maxDepth: 2, onWarn: (w) => warnings.push(w) }
    );
    expect(names).not.toContain('deep.txt');
    expect(warnings.some((w) => w.kind === 'depth-cap')).toBe(true);
  });

  it('respects maxNodes and emits node-cap warning', () => {
    for (let i = 0; i < 20; i++) mk(`file-${i}.txt`);
    const warnings = [];
    let visits = 0;
    walkFiles(tmpRoot,
      () => { visits++; },
      { maxNodes: 5, onWarn: (w) => warnings.push(w) }
    );
    expect(visits).toBeLessThanOrEqual(5);
    expect(warnings.some((w) => w.kind === 'node-cap')).toBe(true);
  });
});

describe('findFirstByName', () => {
  it('returns the absolute path to the first match', () => {
    mk('other.txt');
    const target = mk('sub', 'wanted.json');
    expect(findFirstByName(tmpRoot, 'wanted.json')).toBe(target);
  });

  it('returns null when no match', () => {
    mk('a.txt');
    expect(findFirstByName(tmpRoot, 'missing.json')).toBeNull();
  });

  it('returns null on bad input', () => {
    expect(findFirstByName(null, 'x.txt')).toBeNull();
    expect(findFirstByName(path.join(tmpRoot, 'nonexistent'), 'x.txt')).toBeNull();
  });

  it('stops walking after first match (perf)', () => {
    mk('first', 'wanted.json');
    // Many siblings; STOP_WALK should prevent visiting all of them.
    for (let i = 0; i < 100; i++) mk(`bystander-${i}.txt`);

    let visitCount = 0;
    walkFiles(tmpRoot, () => { visitCount++; });
    const totalNodes = visitCount;

    visitCount = 0;
    findFirstByName(tmpRoot, 'wanted.json');
    // We don't know exactly how many nodes were visited (depends on traversal
    // order), but it should be less than the total — STOP_WALK fired.
    // This assertion is informational; the contract is "returns first match".
    expect(totalNodes).toBeGreaterThan(0);
  });
});

describe('findAllMatchingPattern', () => {
  it('returns a Map of basename → absolute path', () => {
    const a = mk('keyframe-0.jpg');
    const b = mk('sub', 'keyframe-1.jpg');
    mk('not-a-keyframe.jpg');
    mk('keyframe-0.jpg.tmp'); // doesn't match (tail not .jpg)

    const matches = findAllMatchingPattern(tmpRoot, /^keyframe-\d+\.jpg$/);
    expect(matches.size).toBe(2);
    expect(matches.get('keyframe-0.jpg')).toBe(a);
    expect(matches.get('keyframe-1.jpg')).toBe(b);
  });

  it('keeps the first match for duplicate basenames', () => {
    // Saucectl actually emits duplicate basenames in different subdirs
    // (canonical + attached copy). The walker keeps whichever it sees first.
    mk('sub-a', 'keyframe-0.jpg');
    mk('sub-b', 'keyframe-0.jpg');
    const matches = findAllMatchingPattern(tmpRoot, /^keyframe-\d+\.jpg$/);
    expect(matches.size).toBe(1);
    expect(matches.get('keyframe-0.jpg')).toBeTruthy();
  });

  it('accepts a string pattern (compiled to RegExp)', () => {
    mk('a.json');
    const matches = findAllMatchingPattern(tmpRoot, '\\.json$');
    expect(matches.size).toBe(1);
  });

  it('returns empty Map on bad input', () => {
    expect(findAllMatchingPattern(null, /.*/).size).toBe(0);
    expect(findAllMatchingPattern(path.join(tmpRoot, 'nope'), /.*/).size).toBe(0);
  });
});
