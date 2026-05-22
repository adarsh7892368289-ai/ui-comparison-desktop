import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPORT_LIST_JS = path.resolve(
  __dirname, '..', '..', 'src', 'renderer', 'components', 'report-list.js'
);
const REPORT_LIST_CSS = path.resolve(
  __dirname, '..', '..', 'src', 'renderer', 'styles', 'report-list.css'
);

function readDensityHeightsFromJs() {
  const src = fs.readFileSync(REPORT_LIST_JS, 'utf8');
  const m = src.match(/DENSITY_HEIGHTS\s*=\s*\{\s*compact:\s*(\d+)\s*,\s*default:\s*(\d+)\s*,\s*comfortable:\s*(\d+)\s*\}/);
  if (!m) throw new Error('DENSITY_HEIGHTS not found in report-list.js');
  return {
    compact: Number(m[1]),
    default: Number(m[2]),
    comfortable: Number(m[3]),
  };
}

function readCssCardHeights() {
  const css = fs.readFileSync(REPORT_LIST_CSS, 'utf8');

  const defaultMatch = css.match(/\.report-card\s*\{[^}]*?height:\s*(\d+)px/);
  if (!defaultMatch) throw new Error('Default .report-card height not found');

  const compactMatch = css.match(
    /\[data-panel="left"\]\[data-density="compact"\]\s+\.report-card\s*\{[^}]*?height:\s*(\d+)px/
  );
  if (!compactMatch) throw new Error('Compact .report-card height not found');

  const comfortableMatch = css.match(
    /\[data-panel="left"\]\[data-density="comfortable"\]\s+\.report-card\s*\{[^}]*?height:\s*(\d+)px/
  );
  if (!comfortableMatch) throw new Error('Comfortable .report-card height not found');

  return {
    default: Number(defaultMatch[1]),
    compact: Number(compactMatch[1]),
    comfortable: Number(comfortableMatch[1]),
  };
}

describe('report-card density contract', () => {
  const jsHeights = readDensityHeightsFromJs();
  const cssHeights = readCssCardHeights();

  it('CSS height for the default density matches DENSITY_HEIGHTS.default', () => {
    expect(cssHeights.default).toBe(jsHeights.default);
  });

  it('CSS height for the compact density matches DENSITY_HEIGHTS.compact', () => {
    expect(cssHeights.compact).toBe(jsHeights.compact);
  });

  it('CSS height for the comfortable density matches DENSITY_HEIGHTS.comfortable', () => {
    expect(cssHeights.comfortable).toBe(jsHeights.comfortable);
  });

  it('skeleton-card height matches DENSITY_HEIGHTS.compact (skeleton mimics compact rows)', () => {
    const css = fs.readFileSync(REPORT_LIST_CSS, 'utf8');
    const m = css.match(/\.skeleton-card\s*\{[^}]*?height:\s*(\d+)px/);
    expect(m).toBeTruthy();
    expect(Number(m[1])).toBe(jsHeights.compact);
  });
});
