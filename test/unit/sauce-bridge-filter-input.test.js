import { describe, it, expect } from 'vitest';
import { collectFilters } from '@core/saucelabs-bridge/filter-input.js';

describe('collectFilters — empty input', () => {
  it('returns ok with null filters when all fields are empty', () => {
    expect(collectFilters({})).toEqual({ ok: true, filters: null });
    expect(collectFilters({ class: '', id: '', tag: '' })).toEqual({ ok: true, filters: null });
    expect(collectFilters({ class: '   ', id: '\t', tag: '\n' })).toEqual({ ok: true, filters: null });
    expect(collectFilters()).toEqual({ ok: true, filters: null });
  });

  it('treats whitespace-only fields as empty', () => {
    expect(collectFilters({ class: '   \t\n  ' })).toEqual({ ok: true, filters: null });
  });
});

describe('collectFilters — class field', () => {
  it('accepts a single class', () => {
    expect(collectFilters({ class: 'btn' })).toEqual({ ok: true, filters: { class: 'btn' } });
  });

  it('strips a leading dot', () => {
    expect(collectFilters({ class: '.btn' })).toEqual({ ok: true, filters: { class: 'btn' } });
  });

  it('accepts comma-separated and space-separated tokens, normalises to space-joined', () => {
    expect(collectFilters({ class: 'btn,card' })).toEqual({ ok: true, filters: { class: 'btn card' } });
    expect(collectFilters({ class: 'btn  card' })).toEqual({ ok: true, filters: { class: 'btn card' } });
    expect(collectFilters({ class: '.btn, .card .x' })).toEqual({ ok: true, filters: { class: 'btn card x' } });
  });

  it('accepts hyphens and underscores in identifiers', () => {
    expect(collectFilters({ class: 'my-class _hidden' }))
      .toEqual({ ok: true, filters: { class: 'my-class _hidden' } });
  });

  it('rejects classes containing CSS-unsafe characters', () => {
    expect(collectFilters({ class: 'btn>span' }).ok).toBe(false);
    expect(collectFilters({ class: 'btn:hover' }).ok).toBe(false);
    expect(collectFilters({ class: '1leading' }).ok).toBe(false);
    expect(collectFilters({ class: '<svg>' }).ok).toBe(false);
    expect(collectFilters({ class: 'btn[x]' }).ok).toBe(false);
  });

  it('error message names the offending token', () => {
    const result = collectFilters({ class: 'good bad>token' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('"bad>token"');
  });
});

describe('collectFilters — id field', () => {
  it('strips a leading hash', () => {
    expect(collectFilters({ id: '#main' })).toEqual({ ok: true, filters: { id: 'main' } });
  });

  it('accepts space-separated ids', () => {
    expect(collectFilters({ id: 'header footer' }))
      .toEqual({ ok: true, filters: { id: 'header footer' } });
  });

  it('rejects ids with invalid characters', () => {
    expect(collectFilters({ id: 'my id' }).ok).toBe(true);
    expect(collectFilters({ id: 'my id$' }).ok).toBe(false);
    expect(collectFilters({ id: 'a.b' }).ok).toBe(false);
  });
});

describe('collectFilters — tag field', () => {
  it('lowercases tag names', () => {
    expect(collectFilters({ tag: 'BUTTON' })).toEqual({ ok: true, filters: { tag: 'button' } });
    expect(collectFilters({ tag: 'Section ARTICLE' }))
      .toEqual({ ok: true, filters: { tag: 'section article' } });
  });

  it('rejects tags that don\'t start with a letter', () => {
    expect(collectFilters({ tag: '1div' }).ok).toBe(false);
    expect(collectFilters({ tag: '-foo' }).ok).toBe(false);
    expect(collectFilters({ tag: '_foo' }).ok).toBe(false);
  });

  it('accepts hyphenated custom-element tags', () => {
    expect(collectFilters({ tag: 'my-button' }))
      .toEqual({ ok: true, filters: { tag: 'my-button' } });
  });

  it('error message names the offending tag', () => {
    const result = collectFilters({ tag: 'div 1bad' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('"1bad"');
  });
});

describe('collectFilters — combined fields', () => {
  it('accepts all three fields together', () => {
    expect(collectFilters({ class: '.btn', id: '#main', tag: 'BUTTON' }))
      .toEqual({ ok: true, filters: { class: 'btn', id: 'main', tag: 'button' } });
  });

  it('returns the first encountered error (class > id > tag), short-circuiting', () => {
    const result = collectFilters({ class: 'bad>token', id: 'also$bad', tag: '1bad' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid class name');
  });

  it('does not include keys for empty fields', () => {
    const result = collectFilters({ class: 'btn', id: '', tag: '' });
    expect(result.ok).toBe(true);
    expect(Object.keys(result.filters)).toEqual(['class']);
  });
});

describe('collectFilters — input safety', () => {
  it('handles non-string values gracefully (numbers, null, undefined)', () => {
    expect(() => collectFilters({ class: 123, id: null, tag: undefined })).not.toThrow();
    expect(collectFilters({ class: 123 })).toEqual({ ok: true, filters: null });
  });
});
