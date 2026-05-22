'use strict';


const fs = require('fs');
const path = require('path');

const MAX_WALK_DEPTH = 8;
const MAX_WALK_NODES = 50_000;

const STOP_WALK = Symbol('stop-walk');

function _safeLstat(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}

function walkFiles(rootDir, visit, opts = {}) {
  if (!rootDir) return;

  const maxDepth = opts.maxDepth ?? MAX_WALK_DEPTH;
  const maxNodes = opts.maxNodes ?? MAX_WALK_NODES;
  const onWarn = typeof opts.onWarn === 'function' ? opts.onWarn : null;

  const rootStat = _safeLstat(rootDir);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return;

  const visitedKeys = new Set([`${rootStat.dev}:${rootStat.ino}`]);
  let nodeCount = 0;
  const stack = [{ dir: rootDir, depth: 0 }];

  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > maxDepth) {
      onWarn?.({ kind: 'depth-cap', dir, depth });
      continue;
    }

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (++nodeCount > maxNodes) {
        onWarn?.({ kind: 'node-cap', rootDir, nodeCount });
        return;
      }
      const full = path.join(dir, entry.name);

      const st = _safeLstat(full);
      if (!st || st.isSymbolicLink()) continue;

      if (st.isFile()) {
        let result;
        try {
          result = visit(full, entry);
        } catch (err) {
          if (err === STOP_WALK) return;
          throw err;
        }
        if (result === STOP_WALK) return;
      } else if (st.isDirectory()) {
        const key = `${st.dev}:${st.ino}`;
        if (visitedKeys.has(key)) continue;
        visitedKeys.add(key);
        stack.push({ dir: full, depth: depth + 1 });
      }
    }
  }
}

function findFirstByName(rootDir, filename, opts) {
  let found = null;
  walkFiles(rootDir, (full, entry) => {
    if (entry.name === filename) {
      found = full;
      return STOP_WALK;
    }
    return undefined;
  }, opts);
  return found;
}

function findAllMatchingPattern(rootDir, pattern, opts) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  const matches = new Map();
  walkFiles(rootDir, (full, entry) => {
    if (re.test(entry.name) && !matches.has(entry.name)) {
      matches.set(entry.name, full);
    }
    return undefined;
  }, opts);
  return matches;
}

module.exports = {
  walkFiles,
  findFirstByName,
  findAllMatchingPattern,
  STOP_WALK,
  MAX_WALK_DEPTH,
  MAX_WALK_NODES
};
