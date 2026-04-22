'use strict';


export function sanitize(value) {
  const el = document.createElement('span');
  el.textContent = String(value ?? '');
  return el.innerHTML;
}


export function sanitizeFilename(name) {
  const cleaned = String(name ?? 'export').
  replace(/[^a-zA-Z0-9_.-]+/g, '-').
  replace(/[-_.]{2,}/g, '-').
  replace(/^[-_.]+|[-_.]+$/g, '').
  slice(0, 200);
  return cleaned || 'export';
}