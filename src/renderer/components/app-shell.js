'use strict';

import { iconChevronLeft } from '../utils/icons.js';
import { syncLeftPanelRailState } from '../utils/left-panel-breakpoints.js';
import { dispatch } from '../state.js';

const SIDEBAR_MIN_W = 200;
const SIDEBAR_MAX_W = 900;
const SNAP_POINTS = [260, 320, 400, 480, 560, 640, 720, 800];
const SNAP_THRESHOLD = 16;
const SIDEBAR_SNAP_MS = 120;

function sidebarMaxW() {
  if (typeof window === 'undefined') { return SIDEBAR_MAX_W; }
  return Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, window.innerWidth - 200));
}

const DEFAULT_SIDEBAR_EXPANDED_PX = 400;

function clampSidebarWidth(px) {
  const n = Math.round(px);
  if (!Number.isFinite(n)) {
    return Math.min(DEFAULT_SIDEBAR_EXPANDED_PX, sidebarMaxW());
  }
  return Math.max(SIDEBAR_MIN_W, Math.min(sidebarMaxW(), n));
}

function snapNearestResize(width) {
  let nearest = null;
  let minDist = Infinity;
  for (const point of SNAP_POINTS) {
    const dist = Math.abs(width - point);
    if (dist < SNAP_THRESHOLD && dist < minDist) {
      minDist = dist;
      nearest = point;
    }
  }
  return nearest;
}

export class AppShell {
  constructor() {
    this._sectionIds = ['extract', 'compare', 'bulk', 'saucelabs'];
    this._activeSection = null;
    this._collapsed = false;
    this._toggleQueued = 0;
    this._toggleFlushRaf = null;
    this._sidebarTransitionEnd = null;
    this._mainPaneResizeObserver = null;
    this._applyInitialSidebarFromStorage();
    this._syncPanelToggleButton();
    this._initResizeHandle();
    this._initTabNav();
  }

  _railWidthPx() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-rail-width').trim();
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 48;
  }

  _reduceMotion() {
    return typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  _applyInitialSidebarFromStorage() {
    const root = document.getElementById('app-root');
    const panel = document.getElementById('left-panel');
    if (!root || !panel) { return; }
    let collapsed = false;
    try {
      collapsed = localStorage.getItem('sidebar-collapsed') === '1';
    } catch { void 0; }
    this._collapsed = collapsed;
    panel.classList.toggle('left-panel--collapsed', collapsed);
    if (collapsed) {
      root.style.setProperty('--sidebar-width', `${this._railWidthPx()}px`);
    } else {
      root.style.setProperty('--sidebar-width', `${this._sidebarExpandedWidthPx()}px`);
    }
  }

  _clearSidebarTransitionEnd(root) {
    if (this._sidebarTransitionEnd && root) {
      root.removeEventListener('transitionend', this._sidebarTransitionEnd);
      this._sidebarTransitionEnd = null;
    }
  }

  _initTabNav() {
    const nav = document.getElementById('main-pane-section-nav');
    if (!nav) { return; }

    const setOffset = () => {
      const h = nav.offsetHeight;
      document.documentElement.style.setProperty(
        '--main-pane-sticky-offset',
        `${Math.max(0, Math.round(h))}px`
      );
    };
    requestAnimationFrame(() => {
      requestAnimationFrame(setOffset);
    });
    this._mainPaneResizeObserver = new ResizeObserver(setOffset);
    this._mainPaneResizeObserver.observe(nav);

    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-main-pane-section]');
      if (!btn || !nav.contains(btn)) { return; }
      const id = btn.getAttribute('data-main-pane-section');
      this.activateSection(id);
    });
  }

  activateSection(sectionId) {
    if (!this._sectionIds.includes(sectionId)) { return; }
    this._activeSection = sectionId;

    for (const id of this._sectionIds) {
      const panel = document.getElementById(`section-${id}`);
      if (!panel) { continue; }
      if (id === sectionId) {
        panel.hidden = false;
      } else {
        panel.hidden = true;
      }
    }

    const mainContent = document.getElementById('main-content');
    if (mainContent) { mainContent.dataset.activeSection = sectionId; }

    this._syncTabButtons(sectionId);

    if (sectionId === 'extract' || sectionId === 'compare') {
      dispatch('BULK_ACTIVE_PAIR_CLEAR', {});
    }
  }

  _syncTabButtons(sectionId) {
    const nav = document.getElementById('main-pane-section-nav');
    if (!nav) { return; }
    nav.querySelectorAll('[data-main-pane-section]').forEach((btn) => {
      const sid = btn.getAttribute('data-main-pane-section');
      const isActive = sid === sectionId;
      btn.setAttribute('aria-current', String(isActive));
      btn.setAttribute('aria-selected', String(isActive));
    });
  }

  toggleSection(sectionId) {
    this.activateSection(sectionId);
  }

  _syncPanelToggleButton() {
    const btn = document.getElementById('panel-toggle-btn');
    if (!btn) { return; }
    if (!btn.querySelector('svg')) {
      btn.innerHTML = iconChevronLeft(14);
    }
    btn.setAttribute('aria-expanded', String(!this._collapsed));
    btn.setAttribute('aria-label', this._collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  }

  collapseLeftPanelIfExpanded() {
    if (this._collapsed) { return; }
    if (this._toggleFlushRaf != null) {
      cancelAnimationFrame(this._toggleFlushRaf);
      this._toggleFlushRaf = null;
    }
    this._toggleQueued = 0;
    this._applyLeftPanelToggleOnce();
  }

  toggleLeftPanel() {
    if (this._reduceMotion()) {
      if (this._toggleFlushRaf != null) {
        cancelAnimationFrame(this._toggleFlushRaf);
        this._toggleFlushRaf = null;
      }
      this._toggleQueued = 0;
      this._applyLeftPanelToggleOnce();
      return;
    }
    this._toggleQueued += 1;
    if (this._toggleFlushRaf != null) {
      cancelAnimationFrame(this._toggleFlushRaf);
    }
    this._toggleFlushRaf = requestAnimationFrame(() => {
      this._toggleFlushRaf = null;
      const n = this._toggleQueued;
      this._toggleQueued = 0;
      if (n % 2 === 0) { return; }
      this._applyLeftPanelToggleOnce();
    });
  }

  _applyLeftPanelToggleOnce() {
    const panel = document.getElementById('left-panel');
    const root = document.getElementById('app-root');
    if (!panel || !root) { return; }

    const focusInPanel = panel.contains(document.activeElement);
    const reduce = this._reduceMotion();

    this._clearSidebarTransitionEnd(root);

    this._collapsed = !this._collapsed;
    panel.classList.toggle('left-panel--collapsed', this._collapsed);

    if (this._collapsed) {
      root.style.setProperty('--sidebar-width', `${this._railWidthPx()}px`);
    } else {
      root.style.setProperty('--sidebar-width', `${this._sidebarExpandedWidthPx()}px`);
    }

    try {
      localStorage.setItem('sidebar-collapsed', this._collapsed ? '1' : '0');
    } catch { void 0; }

    const handle = document.getElementById('panel-resize-handle');
    if (handle && !this._collapsed) {
      const w = parseInt(getComputedStyle(panel).width, 10);
      handle.setAttribute(
        'aria-valuenow',
        String(Number.isFinite(w) ? w : this._sidebarExpandedWidthPx())
      );
    }

    this._syncPanelToggleButton();
    requestAnimationFrame(() => syncLeftPanelRailState());

    const btn = document.getElementById('panel-toggle-btn');
    if (reduce) {
      if (this._collapsed && focusInPanel && btn) {
        requestAnimationFrame(() => btn.focus());
      }
      return;
    }

    if (!this._collapsed || !focusInPanel || !btn) { return; }

    const refocusToggle = focusInPanel;
    const SIDEBAR_MOTION_MS = 320;
    const onEnd = (ev) => {
      if (ev.target !== root || ev.propertyName !== '--sidebar-width') { return; }
      this._clearSidebarTransitionEnd(root);
      if (this._collapsed && refocusToggle) { btn.focus(); }
    };
    this._sidebarTransitionEnd = onEnd;
    root.addEventListener('transitionend', onEnd);
    window.setTimeout(() => {
      this._clearSidebarTransitionEnd(root);
      if (this._collapsed && refocusToggle) { btn.focus(); }
    }, SIDEBAR_MOTION_MS);
  }

  _sidebarExpandedWidthPx() {
    const def = DEFAULT_SIDEBAR_EXPANDED_PX;
    try {
      const saved = parseInt(localStorage.getItem('sidebar-width'), 10);
      if (!Number.isNaN(saved) && saved >= SIDEBAR_MIN_W && saved <= SIDEBAR_MAX_W) {
        return clampSidebarWidth(saved);
      }
    } catch { void 0; }
    return clampSidebarWidth(def);
  }

  _initResizeHandle() {
    const handle = document.getElementById('panel-resize-handle');
    if (!handle) { return; }

    const root = document.getElementById('app-root') ?? document.documentElement;
    const panelEl = () => document.getElementById('left-panel');

    const setWidth = (w) => {
      const clamped = clampSidebarWidth(w);
      root.style.setProperty('--sidebar-width', `${clamped}px`);
      handle.setAttribute('aria-valuenow', String(clamped));
      handle.setAttribute('aria-valuemin', String(SIDEBAR_MIN_W));
      handle.setAttribute('aria-valuemax', String(sidebarMaxW()));
      try { localStorage.setItem('sidebar-width', String(clamped)); } catch { void 0; }
      requestAnimationFrame(() => syncLeftPanelRailState());
    };

    if (!this._collapsed) {
      try {
        const saved = parseInt(localStorage.getItem('sidebar-width'), 10);
        if (saved >= SIDEBAR_MIN_W && saved <= SIDEBAR_MAX_W) { setWidth(saved); }
      } catch { void 0; }

      const panelInit = panelEl();
      if (panelInit) {
        const w = parseInt(getComputedStyle(panelInit).width, 10);
        if (Number.isFinite(w)) {
          setWidth(w);
        }
      }
    }

    if (this._collapsed) {
      handle.setAttribute('aria-valuenow', String(this._sidebarExpandedWidthPx()));
    } else {
      const p0 = panelEl();
      const w0 = p0 ? parseInt(getComputedStyle(p0).width, 10) : NaN;
      handle.setAttribute(
        'aria-valuenow',
        String(Number.isFinite(w0) ? w0 : this._sidebarExpandedWidthPx())
      );
    }

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const panel = panelEl();
      if (!panel || panel.classList.contains('left-panel--collapsed')) { return; }
      const startX = e.clientX;
      const startW = parseInt(getComputedStyle(panel).width, 10);
      root.style.setProperty('transition', 'none');
      handle.classList.add('is-resizing');
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';

      const onMove = (me) => {
        setWidth(startW + me.clientX - startX);
      };
      const onUp = () => {
        handle.classList.remove('is-resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);

        root.style.removeProperty('transition');

        const p = panelEl();
        if (!p) { return; }
        const rawW = parseInt(getComputedStyle(p).width, 10);
        const clamped = clampSidebarWidth(Number.isFinite(rawW) ? rawW : startW);
        const snapped = snapNearestResize(clamped);
        const reduce = typeof window !== 'undefined'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        if (snapped !== null && Math.abs(snapped - clamped) >= 2 && !reduce) {
          root.style.setProperty(
            'transition',
            `--sidebar-width ${SIDEBAR_SNAP_MS}ms var(--ease-standard)`
          );
          setWidth(snapped);
          window.setTimeout(() => {
            root.style.removeProperty('transition');
          }, SIDEBAR_SNAP_MS + 40);
        } else {
          setWidth(clamped);
        }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    handle.addEventListener('keydown', (e) => {
      const panel = panelEl();
      if (!panel || panel.classList.contains('left-panel--collapsed')) { return; }
      const current = parseInt(getComputedStyle(panel).width, 10);
      const step = e.shiftKey ? 50 : 10;
      if (e.key === 'ArrowRight') { e.preventDefault(); setWidth(current + step); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); setWidth(current - step); }
    });

    let resizeClampTimer = null;
    window.addEventListener('resize', () => {
      if (this._collapsed) { return; }
      clearTimeout(resizeClampTimer);
      resizeClampTimer = setTimeout(() => {
        const p = panelEl();
        if (!p) { return; }
        const cur = parseInt(getComputedStyle(p).width, 10);
        const c = clampSidebarWidth(Number.isFinite(cur) ? cur : SIDEBAR_MIN_W);
        if (c !== cur) { setWidth(c); }
        else { handle.setAttribute('aria-valuemax', String(sidebarMaxW())); }
      }, 120);
    });
  }

  destroy() {
    const root = document.getElementById('app-root');
    this._clearSidebarTransitionEnd(root);
    if (this._mainPaneResizeObserver) {
      this._mainPaneResizeObserver.disconnect();
      this._mainPaneResizeObserver = null;
    }
  }
}

export function createAppShell() {
  return new AppShell();
}
