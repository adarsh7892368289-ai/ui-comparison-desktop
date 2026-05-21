#!/usr/bin/env node
'use strict';

/**
 * no-darwin-color: enforces UI_REDESIGN_PLAN.md §0.2.
 *
 * `html.platform-darwin` is layout-only by contract. Any rule that
 * targets it and sets a color/background/border/fill/stroke/shadow
 * property collides on specificity with `[data-theme="*"]` and silently
 * overrides theme tokens depending on stylesheet load order. This
 * linter blocks that class of regression at PR time.
 */

const fs = require('node:fs');
const path = require('node:path');

const STYLES_DIR = path.join(__dirname, '..', 'src', 'renderer', 'styles');
const FORBIDDEN = [
  'color',
  'background',
  'background-color',
  'border',
  'border-color',
  'fill',
  'stroke',
  'box-shadow',
  'outline-color',
  'caret-color'
];

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function findDarwinBlocks(css) {
  const blocks = [];
  const re = /(^|[\s,}])(html\.platform-darwin[^{]*)\{/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const selector = m[2].trim();
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < css.length && depth > 0) {
      const ch = css[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    blocks.push({ selector, body: css.slice(start, i - 1) });
  }
  return blocks;
}

function findViolations(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const css = stripComments(raw);
  const violations = [];
  for (const block of findDarwinBlocks(css)) {
    for (const prop of FORBIDDEN) {
      const re = new RegExp(`(^|[;{\\s])${prop}\\s*:`, 'i');
      if (re.test(block.body)) {
        violations.push({ selector: block.selector, prop });
      }
    }
  }
  return violations;
}

function main() {
  if (!fs.existsSync(STYLES_DIR)) {
    console.error(`[no-darwin-color] styles directory not found: ${STYLES_DIR}`);
    process.exit(2);
  }
  const files = fs.readdirSync(STYLES_DIR).filter((f) => f.endsWith('.css'));
  let total = 0;
  for (const f of files) {
    const filePath = path.join(STYLES_DIR, f);
    const violations = findViolations(filePath);
    for (const v of violations) {
      total++;
      console.error(
        `[no-darwin-color] ${path.relative(process.cwd(), filePath)}: ` +
          `\`${v.selector}\` may not set \`${v.prop}\`. ` +
          `\`html.platform-darwin\` is layout-only — see UI_REDESIGN_PLAN.md §0.2.`
      );
    }
  }
  if (total > 0) {
    console.error(`[no-darwin-color] ${total} violation(s) found.`);
    process.exit(1);
  }
  process.exit(0);
}

main();
