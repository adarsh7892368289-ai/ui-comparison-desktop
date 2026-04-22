'use strict';


export const STAGE_RE = /\b(stage|staging|dev|test|qa|uat|preview|sandbox|canary)\b/i;





export function hostFromUrl(url) {
  if (url == null || url === '') {
    return '';
  }
  const s = typeof url === 'string' ? url : String(url);
  try {
    return new URL(s).hostname;
  } catch {
    return s;
  }
}





export function lastPathSegment(url) {
  if (url == null || url === '') {
    return '';
  }
  const s = typeof url === 'string' ? url : String(url);
  try {
    const seg = new URL(s).pathname.replace(/\/$/, '').split('/').filter(Boolean).pop();
    return seg ? `/${seg}` : '/';
  } catch {
    return '';
  }
}





export function envTag(url) {
  if (!url) {
    return null;
  }
  const host = hostFromUrl(url).toLowerCase();
  if (STAGE_RE.test(host)) {
    return 'STAGE';
  }
  return 'PROD';
}