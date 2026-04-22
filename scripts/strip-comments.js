'use strict';

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;

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
'v8intrinsic'];


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
        i += 2;
        while (i < len - 1 && !(css[i] === '*' && css[i + 1] === '/')) {
          i++;
        }
        i += 2;
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
      if (c === "'") {
        state = 'normal';
      }
      i++;
    } else if (state === 'dquote') {
      out += c;
      if (c === '\\' && i + 1 < len) {
        out += css[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') {
        state = 'normal';
      }
      i++;
    }
  }
  return out;
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
  return generate(ast, { comments: false, retainLines: true, compact: false }, code).code;
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
        if (skipDirs.has(ent.name)) {
          continue;
        }
        walk(full);
      } else if (ent.name.endsWith('.js')) {
        files.push(full);
      }
    }
  }

  walk(path.join(PROJECT_ROOT, 'src'));
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
        if (skipDirs.has(ent.name)) {
          continue;
        }
        walk(full);
      } else if (ent.name.endsWith('.css')) {
        files.push(full);
      }
    }
  }

  walk(path.join(PROJECT_ROOT, 'src'));
  return [...new Set(files)].sort();
}

function main() {
  let jsChanged = 0;
  let cssChanged = 0;
  let jsErrors = 0;

  for (const file of collectJsFiles()) {
    const original = fs.readFileSync(file, 'utf8');
    if (!/\/\/|\/\*|\*\//.test(original)) {
      continue;
    }
    try {
      const next = stripJsComments(original);
      if (next !== original) {
        fs.writeFileSync(file, next, 'utf8');
        jsChanged++;
      }
    } catch (err) {
      console.error(`[strip-comments] JS failed: ${path.relative(PROJECT_ROOT, file)}`);
      console.error(err.message);
      jsErrors++;
    }
  }

  for (const file of collectCssFiles()) {
    const original = fs.readFileSync(file, 'utf8');
    if (!/\/\*/.test(original)) {
      continue;
    }
    const next = stripCssComments(original);
    if (next !== original) {
      fs.writeFileSync(file, next, 'utf8');
      cssChanged++;
    }
  }

  console.log(
    `[strip-comments] Done. JS files updated: ${jsChanged}, CSS files updated: ${cssChanged}, JS errors: ${jsErrors}`
  );
  if (jsErrors > 0) {
    process.exitCode = 1;
  }
}

main();