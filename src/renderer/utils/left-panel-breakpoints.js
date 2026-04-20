'use strict';

/**
 * Rail density is driven by **`#left-panel` width** (the grid column), not `min(toolbar, controls)`.
 * Using the toolbar strip alone made `data-rail-state` flip to compact/icon-only while the filter
 * row and panel still had room for “No grouping” / “Date — …” labels.
 *
 * **T1 (`PANEL_COMPACT_PX`)** must be **strictly below** the default `--sidebar-width` (300px) so a
 * fresh layout starts in `full`. **T2** stays ≥ 208 so icon-only is still reachable at min width.
 */
export const PANEL_COMPACT_PX = 268;
export const TOOLBAR_COMPACT_PX = PANEL_COMPACT_PX;
export const PANEL_ICON_ONLY_PX = 208;

function _finitePositive(n) {
  return Number.isFinite(n) && n > 0;
}

/**
 * Width used for `#left-panel` `data-rail-state` and toolbar `data-compact`.
 */
export function getLeftPanelRailWidthPx() {
  const panel = document.getElementById('left-panel');
  if (!panel || panel.classList.contains('left-panel--collapsed')) {
    return null;
  }
  const w = panel.getBoundingClientRect().width;
  return _finitePositive(w) ? w : null;
}

/**
 * `data-rail-state` is expanded-only: never set when `.left-panel--collapsed` is present.
 */
export function syncLeftPanelRailState() {
  const panel = document.getElementById('left-panel');
  if (!panel) { return; }
  if (panel.classList.contains('left-panel--collapsed')) {
    delete panel.dataset.railState;
    return;
  }
  const w = getLeftPanelRailWidthPx();
  if (w == null) { return; }
  let state = 'full';
  if (w < PANEL_ICON_ONLY_PX) {
    state = 'icon-only';
  } else if (w < PANEL_COMPACT_PX) {
    state = 'compact';
  }
  panel.dataset.railState = state;
}
