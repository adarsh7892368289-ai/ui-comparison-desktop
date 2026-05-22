'use strict';

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');

const PROJECT_ROOT = path.resolve(__dirname, '..');

const PARSER_PLUGINS = [
  'asyncGenerators',
  'bigInt',
  'classPrivateMethods',
  'classPrivateProperties',
  'classProperties',
  ['decorators', { decoratorsBeforeExport: true }],
  'doExpressions',
  'dynamicImport',
  'exportDefaultFrom',
  'exportNamespaceFrom',
  'functionBind',
  'functionSent',
  'importMeta',
  'logicalAssignment',
  'moduleStringNames',
  'nullishCoalescingOperator',
  'numericSeparator',
  'objectRestSpread',
  'optionalCatchBinding',
  'optionalChaining',
  ['pipelineOperator', { proposal: 'minimal' }],
  ['recordAndTuple', { syntaxType: 'hash' }],
  'throwExpressions',
  'topLevelAwait',
  'v8intrinsic'
];

const PRESERVE_PATTERNS = [
  /^!/,
  /^\s*eslint-disable/,
  /^\s*eslint-enable/,
  /^\s*eslint\s/,
  /^\s*global\s/,
  /^\s*globals\s/,
  /^\s*exported\s/,
  /^\s*jshint\s/,
  /^\s*jslint\s/,
  /^\s*istanbul\s/,
  /^\s*c8\s/,
  /^\s*v8 ignore/,
  /^\s*prettier-ignore/,
  /^\s*ts-(ignore|expect-error|nocheck|check)/,
  /^\s*@ts-/,
  /webpackChunkName/,
  /webpackIgnore/,
  /webpackMode/,
  /webpackPrefetch/,
  /webpackPreload/,
  /webpackInclude/,
  /webpackExclude/,
  /@vite-ignore/,
  /#__PURE__/,
  /@__PURE__/,
  /@license\b/i,
  /@preserve\b/i,
  /@cc_on/,
  /\bsourceMappingURL\b/,
  /\bsourceURL\b/
];

function shouldPreserveComment(value) {
  return PRESERVE_PATTERNS.some((re) => re.test(value));
}

function stripJsComments(code) {
  const ast = parser.parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: true,
    allowSuperOutsideMethod: true,
    errorRecovery: false,
    tokens: false,
    plugins: PARSER_PLUGINS
  });

  const isSoleContentOfEmptyBlock = (start, end) => {
    let i = start - 1;
    while (i >= 0 && /\s/.test(code[i])) i--;
    if (i < 0 || code[i] !== '{') return false;
    let j = end;
    while (j < code.length && /\s/.test(code[j])) j++;
    if (j >= code.length || code[j] !== '}') return false;
    return true;
  };

  const comments = (ast.comments || []).filter(
    (c) => !shouldPreserveComment(c.value) && !isSoleContentOfEmptyBlock(c.start, c.end)
  );
  if (comments.length === 0) return code;

  comments.sort((a, b) => b.start - a.start);

  let out = code;
  for (const c of comments) {
    let start = c.start;
    let end = c.end;

    const lineStart = out.lastIndexOf('\n', start - 1) + 1;
    const before = out.slice(lineStart, start);
    const aloneOnLine = before.trim() === '';

    if (aloneOnLine) {
      start = lineStart;
      while (out[end] === ' ' || out[end] === '\t') end++;
      if (out[end] === '\r') end++;
      if (out[end] === '\n') end++;
    } else {
      while (start > 0 && (out[start - 1] === ' ' || out[start - 1] === '\t')) start--;
      if (c.type !== 'CommentLine') {
        let trail = end;
        while (out[trail] === ' ' || out[trail] === '\t') trail++;
        if (out[trail] === '\r' || out[trail] === '\n' || trail === out.length) {
          end = trail;
        }
      }
    }

    out = out.slice(0, start) + out.slice(end);
  }

  out = out.replace(/[ \t]+$/gm, '');
  out = out.replace(/\n{3,}/g, '\n\n');

  return out;
}

function stripCssComments(css) {
  let out = '';
  let i = 0;
  const len = css.length;
  let state = 'normal';

  while (i < len) {
    const c = css[i];
    if (state === 'normal') {
      if (c === "'" || c === '"') {
        state = c === "'" ? 'squote' : 'dquote';
        out += c;
        i++;
        continue;
      }
      if (c === '/' && css[i + 1] === '*') {
        const endIdx = css.indexOf('*/', i + 2);
        if (endIdx === -1) {
          i = len;
          continue;
        }
        const inner = css.slice(i + 2, endIdx);
        const preserve =
          inner.startsWith('!') ||
          /@license|@preserve/i.test(inner) ||
          /\bcopyright\b/i.test(inner);
        if (preserve) {
          out += css.slice(i, endIdx + 2);
          i = endIdx + 2;
          continue;
        }
        let blockStart = i;
        while (blockStart > 0 && (css[blockStart - 1] === ' ' || css[blockStart - 1] === '\t')) {
          blockStart--;
        }
        const lineStart = css.lastIndexOf('\n', blockStart - 1) + 1;
        const before = css.slice(lineStart, blockStart);
        let blockEnd = endIdx + 2;
        if (before.trim() === '') {
          const removedLeading = i - blockStart;
          if (removedLeading > 0) out = out.slice(0, out.length - removedLeading);
          if (css[blockEnd] === '\r') blockEnd++;
          if (css[blockEnd] === '\n') blockEnd++;
        }
        i = blockEnd;
        continue;
      }
      out += c;
      i++;
    } else if (state === 'squote') {
      out += c;
      if (c === '\\' && i + 1 < len) {
        out += css[i + 1];
        i += 2;
        continue;
      }
      if (c === "'") state = 'normal';
      i++;
    } else if (state === 'dquote') {
      out += c;
      if (c === '\\' && i + 1 < len) {
        out += css[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') state = 'normal';
      i++;
    }
  }

  out = out.replace(/[ \t]+$/gm, '');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out;
}

function collectJsFiles() {
  const files = [];
  const skipDirs = new Set(['node_modules', 'dist', 'release', '.git']);

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name)) continue;
        walk(full);
      } else if (ent.name.endsWith('.js')) {
        files.push(full);
      }
    }
  }

  walk(path.join(PROJECT_ROOT, 'src'));
  walk(path.join(PROJECT_ROOT, 'test'));
  walk(path.join(PROJECT_ROOT, 'scripts'));

  for (const name of fs.readdirSync(PROJECT_ROOT)) {
    if (name.startsWith('webpack.') && name.endsWith('.js')) {
      files.push(path.join(PROJECT_ROOT, name));
    }
  }

  return [...new Set(files)].sort();
}

function collectCssFiles() {
  const files = [];
  const skipDirs = new Set(['node_modules', 'dist', 'release', '.git']);

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name)) continue;
        walk(full);
      } else if (ent.name.endsWith('.css')) {
        files.push(full);
      }
    }
  }

  walk(path.join(PROJECT_ROOT, 'src'));
  return [...new Set(files)].sort();
}

function processFile(file, dryRun) {
  const original = fs.readFileSync(file, 'utf8');
  let body = original;
  let shebang = '';
  if (body.startsWith('#!')) {
    const nl = body.indexOf('\n');
    if (nl !== -1) {
      shebang = body.slice(0, nl + 1);
      body = body.slice(nl + 1);
    }
  }

  let next;
  try {
    next = file.endsWith('.css') ? stripCssComments(body) : stripJsComments(body);
  } catch (err) {
    return { error: err.message };
  }

  const result = shebang + next;
  if (result === original) return { unchanged: true };
  if (!dryRun) fs.writeFileSync(file, result, 'utf8');
  return { changed: true, before: original.length, after: result.length };
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const fileArg = args.indexOf('--file');
  const onlyFile = fileArg !== -1 ? path.resolve(args[fileArg + 1]) : null;

  let files;
  if (onlyFile) {
    files = [onlyFile];
  } else {
    files = [...collectJsFiles(), ...collectCssFiles()];
  }

  let changed = 0;
  let errors = 0;
  for (const file of files) {
    const r = processFile(file, dryRun);
    const rel = path.relative(PROJECT_ROOT, file);
    if (r.error) {
      console.error(`[strip-comments] ERROR ${rel}: ${r.error}`);
      errors++;
    } else if (r.changed) {
      changed++;
      console.log(`[strip-comments] ${dryRun ? 'WOULD' : 'EDIT'} ${rel} (${r.before}->${r.after})`);
    }
  }

  console.log(`[strip-comments] Done. ${changed} changed, ${errors} errors, ${files.length} total${dryRun ? ' (dry-run)' : ''}`);
  if (errors > 0) process.exitCode = 1;
}

main();
