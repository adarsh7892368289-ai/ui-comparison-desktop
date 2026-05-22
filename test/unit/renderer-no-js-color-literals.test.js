import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RENDERER_DIR = path.resolve(__dirname, '..', '..', 'src', 'renderer');

const ALLOWED_FILES = new Set([
  'app.js',
]);

function listJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'stubs') continue;
      listJsFiles(p, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

const HEX_RE = /['"]#[0-9a-fA-F]{3,8}['"]/g;
const RGB_RE = /['"][^'"]*\brgb\s*\(/g;
const HSL_RE = /['"][^'"]*\bhsl\s*\(/g;

describe('renderer JS — no hardcoded color literals', () => {
  const files = listJsFiles(RENDERER_DIR);
  const violations = [];

  for (const file of files) {
    const rel = path.relative(RENDERER_DIR, file);
    const basename = path.basename(file);
    if (ALLOWED_FILES.has(basename)) continue;

    const src = fs.readFileSync(file, 'utf8');

    for (const re of [HEX_RE, RGB_RE, HSL_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src)) !== null) {
        violations.push({ file: rel, match: m[0] });
      }
    }
  }

  it('no hex/rgb/hsl color string is hardcoded outside the fatal-banner allowlist', () => {
    expect(violations).toEqual([]);
  });
});
