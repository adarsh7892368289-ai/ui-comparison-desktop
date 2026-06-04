import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import {
  buildExtractedReportCsv,
  buildExtractedReportExcel,
  buildAllExtractedReportsCsv,
  buildAllExtractedReportsExcel,
} from '../../src/core/export/extraction-exporters/report-exporter.js';
import { parseReportAoa } from '../../src/core/export/extraction-exporters/report-table-parser.js';
import { unescapeCsv } from '../../src/core/export/export-utils/csv-utils.js';

const LONG_TEXT = 'x'.repeat(450);

function makeReport(overrides = {}) {
  return {
    id: 'rep-001',
    url: 'https://www.example.com/page',
    title: 'Example Page',
    timestamp: '2026-06-03T10:00:00.000Z',
    totalElements: 2,
    duration: 1234,
    captureQuality: 'NORMAL',
    captureConfig: {
      source: 'local',
      deviceType: 'desktop',
      deviceName: null,
      viewport: { width: 1280, height: 720 },
      devicePixelRatio: 2,
      screenResolution: '1920 × 1080',
      orientation: 'landscape',
      hasTouch: false,
      userAgent: 'Mozilla/5.0 (Test)'
    },
    filters: { class: 'card', id: null, tag: null },
    elements: [
      {
        hpid: '1',
        tagName: 'div',
        elementId: 'main',
        className: 'card hero',
        classOccurrenceCount: 3,
        textContent: LONG_TEXT,
        cssSelector: 'div.card',
        xpath: '/html/body/div[1]',
        rect: { x: 10, y: 20, top: 20, left: 10, width: 300, height: 150 },
        tier: 'A',
        depth: 2,
        pageSection: 'header',
        attributes: { 'data-role': 'banner', role: 'region' },
        neighbours: ['n1', 'n2'],
        classHierarchy: ['card', 'hero'],
        styles: { 'font-size': '16px', 'color': 'rgb(0, 0, 0)' }
      },
      {
        hpid: '2',
        tagName: 'span',
        className: 'label',
        classOccurrenceCount: 1,
        textContent: 'short',
        rect: { x: 0, y: 0, top: 0, left: 0, width: 50, height: 20 },
        styles: { 'font-size': '12px' }
      }
    ],
    ...overrides
  };
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function csvToAoa(csv) {
  const wb = XLSX.read(stripBom(csv), { type: 'string' });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  return aoa.map((row) => (Array.isArray(row) ? row.map(unescapeCsv) : row));
}

describe('extracted report CSV round-trip', () => {
  it('reconstructs metadata, captureConfig, and elements from a single-report CSV', () => {
    const original = makeReport();
    const csv = buildExtractedReportCsv(original);
    const parsed = parseReportAoa(csvToAoa(csv));

    expect(parsed).toBeTruthy();
    expect(parsed.id).toBe(original.id);
    expect(parsed.url).toBe(original.url);
    expect(parsed.title).toBe(original.title);
    expect(parsed.timestamp).toBe(original.timestamp);
    expect(parsed.duration).toBe(1234);
    expect(parsed.captureQuality).toBe('NORMAL');
    expect(parsed.captureConfig).toEqual(original.captureConfig);
    expect(parsed.filters).toEqual(original.filters);
    expect(parsed.elements).toHaveLength(2);
  });

  it('preserves full element fields including nested objects and long text', () => {
    const original = makeReport();
    const parsed = parseReportAoa(csvToAoa(buildExtractedReportCsv(original)));
    const el = parsed.elements[0];

    expect(el.tagName).toBe('div');
    expect(el.classOccurrenceCount).toBe(3);
    expect(el.textContent).toBe(LONG_TEXT);
    expect(el.textContent.length).toBe(450);
    expect(el.rect).toEqual({ x: 10, y: 20, top: 20, left: 10, width: 300, height: 150 });
    expect(el.attributes).toEqual({ 'data-role': 'banner', role: 'region' });
    expect(el.neighbours).toEqual(['n1', 'n2']);
    expect(el.classHierarchy).toEqual(['card', 'hero']);
    expect(el.styles['font-size']).toBe('16px');
    expect(el.styles.color).toBe('rgb(0, 0, 0)');
  });

  it('round-trips a multi-report CSV into all reports', () => {
    const a = makeReport({ id: 'a', url: 'https://a.test' });
    const b = makeReport({ id: 'b', url: 'https://b.test', captureConfig: { source: 'cloud', deviceType: 'phone', deviceName: 'iPhone 13', viewport: { width: 390, height: 844 }, devicePixelRatio: 3, screenResolution: null, orientation: 'portrait', hasTouch: true, userAgent: null } });
    const csv = buildAllExtractedReportsCsv([a, b]);

    const lines = stripBom(csv).split(/\r?\n/u);
    const blocks = [];
    let cur = null;
    for (const line of lines) {
      if (/^##\s*=====\s*REPORT\s+\d+/iu.test(line.trim())) {
        if (cur) blocks.push(cur);
        cur = [];
        continue;
      }
      if (cur == null) cur = [];
      cur.push(line);
    }
    if (cur) blocks.push(cur);

    const parsed = blocks.map((bl) => parseReportAoa(csvToAoa(bl.join('\n')))).filter(Boolean);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].url).toBe('https://a.test');
    expect(parsed[1].url).toBe('https://b.test');
    expect(parsed[1].captureConfig.deviceType).toBe('phone');
    expect(parsed[1].captureConfig.deviceName).toBe('iPhone 13');
  });
});

describe('extracted report XLSX round-trip', () => {
  function combineXlsx(base64OrBytes) {
    const wb = XLSX.read(base64OrBytes, { type: 'array' });
    const names = wb.SheetNames;
    const metaName = names.find((n) => /^metadata$/iu.test(n));
    const elemName = names.find((n) => /^elements$/iu.test(n));
    const combined = XLSX.utils.sheet_to_json(wb.Sheets[metaName], { header: 1, defval: '' });
    combined.push(['EXTRACTED ELEMENTS']);
    for (const r of XLSX.utils.sheet_to_json(wb.Sheets[elemName], { header: 1, defval: '' })) {
      combined.push(r);
    }
    return combined;
  }

  it('reconstructs a single-report XLSX (Metadata + Elements sheets)', () => {
    const original = makeReport();
    const result = buildExtractedReportExcel(original);
    expect(result.success).toBe(true);

    const parsed = parseReportAoa(combineXlsx(result.data));
    expect(parsed.url).toBe(original.url);
    expect(parsed.captureConfig).toEqual(original.captureConfig);
    expect(parsed.elements).toHaveLength(2);
    expect(parsed.elements[0].textContent).toBe(LONG_TEXT);
    expect(parsed.elements[0].attributes).toEqual({ 'data-role': 'banner', role: 'region' });
  });

  it('reconstructs each report from a multi-report XLSX (Report_N sheets)', () => {
    const a = makeReport({ id: 'a', url: 'https://a.test' });
    const b = makeReport({ id: 'b', url: 'https://b.test' });
    const result = buildAllExtractedReportsExcel([a, b]);
    expect(result.success).toBe(true);

    const wb = XLSX.read(result.data, { type: 'array' });
    const reportSheets = wb.SheetNames.filter((n) => /^report[_\s]?\d+/iu.test(n));
    expect(reportSheets.length).toBe(2);

    const parsed = reportSheets
      .map((n) => parseReportAoa(XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' })))
      .filter(Boolean);
    expect(parsed.map((r) => r.url).sort()).toEqual(['https://a.test', 'https://b.test']);
  });
});

describe('legacy flat-format import still works', () => {
  it('parses a flat sheet with url + elements JSON column', () => {
    const aoa = [
      ['id', 'url', 'name', 'timestamp', 'elements'],
      ['legacy-1', 'https://legacy.test', 'Legacy', '2026-01-01T00:00:00.000Z', JSON.stringify([{ hpid: '1', tagName: 'div' }])]
    ];
    const parsed = parseReportAoa(aoa);
    expect(parsed).toBeTruthy();
    expect(parsed.url).toBe('https://legacy.test');
    expect(parsed.elements).toHaveLength(1);
    expect(parsed.elements[0].tagName).toBe('div');
  });

  it('returns null for an unrecognised sheet with no url', () => {
    expect(parseReportAoa([['foo', 'bar'], ['1', '2']])).toBeNull();
  });
});

describe('edge cases (regression)', () => {
  it('zero-element report imports elements as [] (never undefined)', () => {
    const original = makeReport({ elements: [], totalElements: 0 });
    const parsed = parseReportAoa(csvToAoa(buildExtractedReportCsv(original)));
    expect(parsed).toBeTruthy();
    expect(Array.isArray(parsed.elements)).toBe(true);
    expect(parsed.elements).toHaveLength(0);
  });

  it('does not fabricate classOccurrenceCount for an element that lacks it', () => {
    const original = makeReport({
      elements: [{ hpid: '1', tagName: 'div', url: undefined }],
      totalElements: 1
    });
    const parsed = parseReportAoa(csvToAoa(buildExtractedReportCsv(original)));
    expect(parsed.elements[0].classOccurrenceCount).toBeUndefined();
  });

  it('preserves a genuine classOccurrenceCount of 0', () => {
    const original = makeReport({
      elements: [{ hpid: '1', tagName: 'div', classOccurrenceCount: 0 }],
      totalElements: 1
    });
    const parsed = parseReportAoa(csvToAoa(buildExtractedReportCsv(original)));
    expect(parsed.elements[0].classOccurrenceCount).toBe(0);
  });

  it('round-trips strings that start with CSV formula characters', () => {
    const original = makeReport({
      elements: [{
        hpid: '1',
        tagName: 'div',
        className: '-webkit-box',
        textContent: '=SUM(A1)',
        cssSelector: '+combinator',
        styles: { 'font-family': '@font-face', 'margin-top': '-5px' }
      }],
      totalElements: 1
    });
    const parsed = parseReportAoa(csvToAoa(buildExtractedReportCsv(original)));
    const el = parsed.elements[0];
    expect(el.className).toBe('-webkit-box');
    expect(el.textContent).toBe('=SUM(A1)');
    expect(el.cssSelector).toBe('+combinator');
    expect(el.styles['font-family']).toBe('@font-face');
    expect(el.styles['margin-top']).toBe('-5px');
  });

  it('preserves falsy element fields (hpid="0", depth=0, rect.x=0)', () => {
    const original = makeReport({
      elements: [{ hpid: '0', tagName: 'div', depth: 0, rect: { x: 0, y: 0, width: 0, height: 0 } }],
      totalElements: 1
    });
    const parsed = parseReportAoa(csvToAoa(buildExtractedReportCsv(original)));
    const el = parsed.elements[0];
    expect(el.hpid).toBe('0');
    expect(el.depth).toBe(0);
    expect(el.rect.x).toBe(0);
  });
});
