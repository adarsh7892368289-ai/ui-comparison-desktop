'use strict';

// Validates and normalizes raw filter input from the SauceLabs panel.
// The result feeds into the generated test script's buildSelectorFromFilters,
// so any token that produces a syntactically broken CSS selector is rejected
// here — failing in the renderer is much cheaper than failing inside a
// SauceLabs VM (which costs a concurrent-session slot and minutes of wallclock).
//
// Returns one of:
//   { ok: true, filters: null }                    — all-empty (no filtering)
//   { ok: true, filters: { class?, id?, tag? } }   — at least one valid token
//   { ok: false, error: '<actionable message>' }   — at least one invalid token

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const TAG_RE = /^[A-Za-z][A-Za-z0-9-]*$/;

function _trim(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function collectFilters({ class: classRaw, id: idRaw, tag: tagRaw } = {}) {
  const rawClass = _trim(classRaw);
  const rawId = _trim(idRaw);
  const rawTag = _trim(tagRaw);

  if (!rawClass && !rawId && !rawTag) return { ok: true, filters: null };

  const out = {};

  if (rawClass) {
    const tokens = rawClass.split(/[\s,]+/).filter(Boolean).map((t) => t.replace(/^\./, ''));
    if (tokens.length === 0) {
      return { ok: false, error: 'Class filter is empty after splitting.' };
    }
    const bad = tokens.find((t) => !IDENT_RE.test(t));
    if (bad) {
      return { ok: false, error: `Invalid class name: "${bad}". Use letters, digits, hyphen, or underscore.` };
    }
    out.class = tokens.join(' ');
  }

  if (rawId) {
    const tokens = rawId.split(/\s+/).filter(Boolean).map((t) => t.replace(/^#/, ''));
    if (tokens.length === 0) {
      return { ok: false, error: 'ID filter is empty after splitting.' };
    }
    const bad = tokens.find((t) => !IDENT_RE.test(t));
    if (bad) {
      return { ok: false, error: `Invalid ID: "${bad}". Use letters, digits, hyphen, or underscore.` };
    }
    out.id = tokens.join(' ');
  }

  if (rawTag) {
    const tokens = rawTag.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      return { ok: false, error: 'Tag filter is empty after splitting.' };
    }
    const bad = tokens.find((t) => !TAG_RE.test(t));
    if (bad) {
      return { ok: false, error: `Invalid tag name: "${bad}". Tags must start with a letter.` };
    }
    out.tag = tokens.map((t) => t.toLowerCase()).join(' ');
  }

  return { ok: true, filters: out };
}

export { collectFilters };
