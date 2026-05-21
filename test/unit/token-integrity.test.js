import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STYLES_DIR = path.resolve(__dirname, '..', '..', 'src', 'renderer', 'styles');

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function readAllStylesheets() {
  const files = fs.readdirSync(STYLES_DIR).filter((f) => f.endsWith('.css'));
  const out = {};
  for (const f of files) {
    out[f] = fs.readFileSync(path.join(STYLES_DIR, f), 'utf8');
  }
  return out;
}

function findBlock(css, selectorPattern) {
  const re = new RegExp(`(^|[\\s,}])(${selectorPattern})\\s*\\{`, 'g');
  const m = re.exec(css);
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  while (i < css.length && depth > 0) {
    const ch = css[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return css.slice(start, i - 1);
}

function extractDefinedTokens(blockBody) {
  const re = /(--color-[a-z0-9-]+)\s*:\s*([^;]+);/g;
  const map = new Map();
  let m;
  while ((m = re.exec(blockBody)) !== null) {
    map.set(m[1], m[2].trim());
  }
  return map;
}

function extractReferencedColorTokens(css) {
  const re = /var\(\s*(--color-[a-z0-9-]+)/g;
  const set = new Set();
  let m;
  while ((m = re.exec(css)) !== null) {
    set.add(m[1]);
  }
  return set;
}

function extractAllTokenDefinitions(css) {
  const re = /(--[a-z][a-z0-9-]*)\s*:\s*([^;]+);/g;
  const map = new Map();
  let m;
  while ((m = re.exec(css)) !== null) {
    if (!map.has(m[1])) map.set(m[1], m[2].trim());
  }
  return map;
}

function singleVarTarget(value) {
  const trimmed = value.trim();
  const m = /^var\(\s*(--[a-z0-9-]+)\s*(?:,[^)]*)?\)$/.exec(trimmed);
  return m ? m[1] : null;
}

function chainDepth(token, defs, seen = new Set()) {
  if (seen.has(token)) return 0;
  seen.add(token);
  const value = defs.get(token);
  if (!value) return 0;
  const target = singleVarTarget(value);
  if (!target) return 0;
  return 1 + chainDepth(target, defs, seen);
}

const tokens = (() => {
  const sheets = readAllStylesheets();
  const tokensCss = sheets['tokens.css'];
  if (!tokensCss) {
    throw new Error('tokens.css not found in styles directory');
  }
  const noComments = stripComments(tokensCss);
  const darkBody = findBlock(noComments, '\\[data-theme="dark"\\]');
  const lightBody = findBlock(noComments, '\\[data-theme="light"\\]');
  const rootBody = findBlock(noComments, ':root');

  const dark = extractDefinedTokens(darkBody ?? '');
  const light = extractDefinedTokens(lightBody ?? '');
  const root = extractDefinedTokens(rootBody ?? '');
  const rootAll = extractAllTokenDefinitions(rootBody ?? '');
  const darkAll = extractAllTokenDefinitions(darkBody ?? '');
  const lightAll = extractAllTokenDefinitions(lightBody ?? '');

  const allCss = Object.values(sheets).map(stripComments).join('\n');
  const referenced = extractReferencedColorTokens(allCss);

  const allDefs = extractAllTokenDefinitions(allCss);

  return { sheets, dark, light, root, rootAll, darkAll, lightAll, referenced, allDefs };
})();

describe('token integrity — completeness', () => {
  it('every var(--color-*) reference resolves in [data-theme="dark"]', () => {
    const missing = [];
    for (const t of tokens.referenced) {
      if (!tokens.dark.has(t)) missing.push(t);
    }
    expect(missing).toEqual([]);
  });

  it('every var(--color-*) reference resolves in [data-theme="light"]', () => {
    const missing = [];
    for (const t of tokens.referenced) {
      if (!tokens.light.has(t)) missing.push(t);
    }
    expect(missing).toEqual([]);
  });
});

describe('token integrity — cascade depth', () => {
  it('no token alias chain exceeds depth 2', () => {
    const violations = [];
    for (const [name] of tokens.allDefs) {
      const d = chainDepth(name, tokens.allDefs);
      if (d > 2) violations.push({ name, depth: d });
    }
    expect(violations).toEqual([]);
  });
});

describe('token integrity — :root color leak', () => {
  it('no --color-* token is defined directly on :root', () => {
    const leaked = [...tokens.root.keys()].filter((k) => k.startsWith('--color-'));
    expect(leaked).toEqual([]);
  });
});

function resolveCssVarsInValue(value, defs) {
  let prev;
  let cur = value;
  let guard = 0;
  do {
    prev = cur;
    cur = cur.replace(/var\(\s*(--[a-z0-9-]+)\s*(?:,[^)]*)?\)/g, (_, name) => {
      const v = defs.get(name);
      return v ?? '';
    });
    guard++;
  } while (cur !== prev && guard < 8);
  return cur;
}

function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0, g1 = 0, b1 = 0;
  if (hp >= 0 && hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = l - c / 2;
  return [(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255];
}

function parseColor(value) {
  if (!value) return null;
  const v = value.trim();
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(v);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return [r, g, b];
  }
  const hslM = /^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*(?:\/\s*[\d.]+)?\s*\)$/i.exec(v);
  if (hslM) {
    return hslToRgb(parseFloat(hslM[1]), parseFloat(hslM[2]), parseFloat(hslM[3]));
  }
  const hslLegacy = /^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i.exec(v);
  if (hslLegacy) {
    return hslToRgb(parseFloat(hslLegacy[1]), parseFloat(hslLegacy[2]), parseFloat(hslLegacy[3]));
  }
  return null;
}

function relLuminance([r, g, b]) {
  const t = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * t(r) + 0.7152 * t(g) + 0.0722 * t(b);
}

function contrast(rgbA, rgbB) {
  const la = relLuminance(rgbA);
  const lb = relLuminance(rgbB);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function pairContrast(themeDefs, rootDefs, fgToken, bgToken) {
  const merged = new Map([...rootDefs, ...themeDefs]);
  const fgRaw = merged.get(fgToken);
  const bgRaw = merged.get(bgToken);
  if (!fgRaw || !bgRaw) return null;
  const fg = parseColor(resolveCssVarsInValue(fgRaw, merged));
  const bg = parseColor(resolveCssVarsInValue(bgRaw, merged));
  if (!fg || !bg) return null;
  return contrast(fg, bg);
}

const PAIRS = [
  { fg: '--color-text-primary',   bg: '--color-surface-base',    min: 4.5, label: 'text-primary on surface-base' },
  { fg: '--color-text-primary',   bg: '--color-surface-sidebar', min: 4.5, label: 'text-primary on surface-sidebar' },
  { fg: '--color-text-primary',   bg: '--color-surface-raised',  min: 4.5, label: 'text-primary on surface-raised' },
  { fg: '--color-text-secondary', bg: '--color-surface-base',    min: 4.5, label: 'text-secondary on surface-base' },
  { fg: '--color-text-secondary', bg: '--color-surface-sidebar', min: 4.5, label: 'text-secondary on surface-sidebar' },
  { fg: '--color-text-tertiary',  bg: '--color-surface-base',    min: 3.0, label: 'text-tertiary on surface-base' },
  { fg: '--color-text-disabled',  bg: '--color-surface-base',    min: 3.0, label: 'text-disabled on surface-base' }
];

describe('token integrity — contrast (dark theme)', () => {
  for (const p of PAIRS) {
    it(`${p.label} ≥ ${p.min}:1`, () => {
      const ratio = pairContrast(tokens.darkAll, tokens.rootAll, p.fg, p.bg);
      expect(ratio).not.toBeNull();
      expect(ratio).toBeGreaterThanOrEqual(p.min);
    });
  }
});

describe('token integrity — contrast (light theme)', () => {
  for (const p of PAIRS) {
    it(`${p.label} ≥ ${p.min}:1`, () => {
      const ratio = pairContrast(tokens.lightAll, tokens.rootAll, p.fg, p.bg);
      expect(ratio).not.toBeNull();
      expect(ratio).toBeGreaterThanOrEqual(p.min);
    });
  }
});
