'use strict';

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

export function iconRowsComfortable(size = 16) {
  return svg(
    '<line x1="8" x2="21" y1="5" y2="5"/><line x1="8" x2="21" y1="9" y2="9"/><line x1="3" x2="3.01" y1="7" y2="7"/><line x1="8" x2="21" y1="15" y2="15"/><line x1="8" x2="21" y1="19" y2="19"/><line x1="3" x2="3.01" y1="17" y2="17"/>',
    size
  );
}

export function iconLayers(size = 16) {
  return svg(
    '<rect x="2" y="4" width="20" height="4" rx="1"/><rect x="2" y="10" width="20" height="4" rx="1"/><rect x="2" y="16" width="20" height="4" rx="1"/>',
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

export function iconTarget(size = 16) {
  return svg('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>', size);
}

export function iconArrowUpDown(size = 16) {
  return svg('<path d="m7 15 5 5 5-5"/><path d="m17 9-5-5-5 5"/>', size);
}

export function iconArrowUp(size = 16) {
  return svg('<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>', size);
}

export function iconArrowDown(size = 16) {
  return svg('<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>', size);
}

export function iconLayoutGrid(size = 16) {
  return svg(
    '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
    size
  );
}

export function iconMoreHorizontal(size = 16) {
  return svg('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>', size);
}

export function iconInfo(size = 16) {
  return svg(
    '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="8"/><line x1="12" y1="12" x2="12" y2="16"/>',
    size
  );
}

export function iconSquare(size = 16) {
  return svg('<rect x="3" y="3" width="18" height="18" rx="2"/>', size);
}

export function iconCheckSquare(size = 16) {
  return svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m9 12 2 2 4-4"/>', size);
}

export function iconSpinner(size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
    aria-hidden="true" class="icon-spin">
    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
  </svg>`;
}

export function iconMonitor(size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`;
}

export function iconSmartphone(size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/></svg>`;
}

export function iconTablet(size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M11 18h2"/></svg>`;
}