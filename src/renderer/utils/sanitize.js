'use strict';


export function sanitize(value) {
  const el = document.createElement('span');
  el.textContent = String(value ?? '');
  return el.innerHTML;
}


export function sanitizeErrorMessage(raw) {
  if (raw == null) {return 'Unknown error';}
  let str = typeof raw === 'string' ? raw : (raw.message ?? String(raw));
  const logIdx = str.indexOf('Browser logs:');
  if (logIdx >= 0) {str = str.slice(0, logIdx).trim();}
  const callIdx = str.indexOf('Call log:');
  if (callIdx >= 0) {str = str.slice(0, callIdx).trim();}
  const firstLine = str.split('\n')[0].trim();
  if (firstLine.length > 200) {return `${firstLine.slice(0, 200)}…`;}
  return firstLine || 'Unknown error';
}


export function sanitizeFilename(name) {
  const cleaned = String(name ?? 'export').
  replace(/[^a-zA-Z0-9_.-]+/g, '-').
  replace(/[-_.]{2,}/g, '-').
  replace(/^[-_.]+|[-_.]+$/g, '').
  slice(0, 200);
  return cleaned || 'export';
}