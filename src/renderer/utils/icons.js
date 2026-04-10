'use strict';

/**
 * Inline Lucide-style SVG strings (no .svg webpack loader).
 * Default: 16×16, viewBox 24×24, stroke 1.5, currentColor.
 */
const BASE =
  'xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';

function svg(inner, size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" ${BASE} aria-hidden="true">${inner}</svg>`;
}

export function iconChevronLeft(size = 16) {
  return svg('<polyline points="15 18 9 12 15 6"/>', size);
}

export function iconChevronRight(size = 16) {
  return svg('<polyline points="9 18 15 12 9 6"/>', size);
}

export function iconChevronDown(size = 12) {
  return svg('<polyline points="6 9 12 15 18 9"/>', size);
}

export function iconX(size = 14) {
  return svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', size);
}

export function iconCheck(size = 16) {
  return svg('<polyline points="20 6 9 17 4 12"/>', size);
}

export function iconAlertTriangle(size = 16) {
  return svg(
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/>',
    size
  );
}

export function iconAlertCircle(size = 16) {
  return svg(
    '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    size
  );
}

/** Command palette & navigation */
export function iconGlobe(size = 16) {
  return svg(
    '<circle cx="12" cy="12" r="10"/><line x1="2" x2="22" y1="12" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    size
  );
}

export function iconGitCompare(size = 16) {
  return svg(
    '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 1 9-9"/><path d="M18 3v12a9 9 0 0 1-9 9"/>',
    size
  );
}

export function iconList(size = 16) {
  return svg(
    '<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>',
    size
  );
}

export function iconSearch(size = 16) {
  return svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>', size);
}

export function iconPlay(size = 16) {
  return svg('<polygon points="5 3 19 12 5 21 5 3"/>', size);
}

export function iconFileDown(size = 16) {
  return svg(
    '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/>',
    size
  );
}

export function iconTrash2(size = 16) {
  return svg(
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
    size
  );
}

export function iconActivity(size = 16) {
  return svg('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>', size);
}

/** Report row actions: baseline = target, compare = vertical arrows */
export function iconTarget(size = 16) {
  return svg('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>', size);
}

export function iconArrowUpDown(size = 16) {
  return svg('<path d="m7 15 5 5 5-5"/><path d="m17 9-5-5-5 5"/>', size);
}

/** [BONUS] Imported report badge (was ↑) */
export function iconArrowUp(size = 16) {
  return svg('<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>', size);
}
