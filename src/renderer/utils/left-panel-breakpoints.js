'use strict';

export const PANEL_COMPACT_PX = 268;
export const TOOLBAR_COMPACT_PX = PANEL_COMPACT_PX;
export const PANEL_ICON_ONLY_PX = 208;

function _finitePositive(n) {
  return Number.isFinite(n) && n > 0;
}

export function getLeftPanelRailWidthPx() {
  const panel = document.getElementById('left-panel');
  if (!panel || panel.classList.contains('left-panel--collapsed')) {
    return null;
  }
  const w = panel.getBoundingClientRect().width;
  return _finitePositive(w) ? w : null;
}

export function syncLeftPanelRailState() {
  const panel = document.getElementById('left-panel');
  if (!panel) {
    return;
  }
  if (panel.classList.contains('left-panel--collapsed')) {
    delete panel.dataset.railState;
    return;
  }
  const w = getLeftPanelRailWidthPx();
  if (w == null) {
    return;
  }
  let state = 'full';
  if (w < PANEL_ICON_ONLY_PX) {
    state = 'icon-only';
  } else if (w < PANEL_COMPACT_PX) {
    state = 'compact';
  }
  panel.dataset.railState = state;
}
