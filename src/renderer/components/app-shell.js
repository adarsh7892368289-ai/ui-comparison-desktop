'use strict';

import { iconChevronLeft } from '../utils/icons.js';

const SNAP_POINTS = [240, 300, 380, 480];
const SNAP_THRESHOLD = 20;

/** @param {number} width */
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
    this._sectionIds = ['extract', 'compare'];
    this._activeSection = null;
    this._collapsed = false;
    this._buildSectionsMap();
    this._wireSectionHeaders();
    this._syncPanelToggleButton();
    this._hydrateAccordionFromDom();
    this._initResizeHandle();
  }

  _buildSectionsMap() {
    this._sections = new Map();
    for (const id of this._sectionIds) {
      const el = document.getElementById(`section-${id}`);
      if (!el) { continue; }
      const headerBtn = el.querySelector('.nav-section__header');
      const body = document.getElementById(`body-${id}`);
      const firstFocusable = body?.querySelector(
        'input:not([disabled]), button:not([disabled]), select:not([disabled]), [tabindex="0"]'
      ) ?? null;
      this._sections.set(id, { el, headerBtn, firstFocusable });
    }
  }

  _wireSectionHeaders() {
    this._sections.forEach((section, id) => {
      section.headerBtn?.addEventListener('click', () => this.toggleSection(id));
    });
  }

  toggleSection(sectionId) {
    const section = this._sections.get(sectionId);
    if (!section) { return; }
    const isOpen = section.el.classList.contains('nav-section--expanded');
    if (isOpen) {
      this._closeSectionBody(section.el);
      section.el.classList.remove('nav-section--expanded');
      section.headerBtn?.setAttribute('aria-expanded', 'false');
      if (sectionId === this._activeSection) {
        const next = this._sectionIds.find(
          (id) => id !== sectionId && this._sections.get(id)?.el.classList.contains('nav-section--expanded')
        );
        if (next) { this._applyWorkflowFocus(next); }
      }
    } else {
      this._openSectionBody(section.el);
      section.el.classList.add('nav-section--expanded');
      section.headerBtn?.setAttribute('aria-expanded', 'true');
      this._applyWorkflowFocus(sectionId);
    }
    this._persistSectionStates();
  }

  activateSection(sectionId) {
    const section = this._sections.get(sectionId);
    if (!section) { return; }
    if (!section.el.classList.contains('nav-section--expanded')) {
      this._openSectionBody(section.el);
      section.el.classList.add('nav-section--expanded');
      section.headerBtn?.setAttribute('aria-expanded', 'true');
      this._persistSectionStates();
    }
    this._applyWorkflowFocus(sectionId);
    section.firstFocusable?.focus();
  }

  _applyWorkflowFocus(sectionId) {
    this._sections.forEach(({ el }, id) => {
      el.classList.toggle('nav-section--active', id === sectionId);
    });
    this._activeSection = sectionId;
    const mainContent = document.getElementById('main-content');
    if (mainContent) { mainContent.dataset.activeSection = sectionId; }
    const label = sectionId.charAt(0).toUpperCase() + sectionId.slice(1);
    this.setBreadcrumb([{ label }]);
  }

  _persistSectionStates() {
    const states = {};
    this._sections.forEach((section, id) => {
      states[id] = section.el.classList.contains('nav-section--expanded');
    });
    try { localStorage.setItem('section-states', JSON.stringify(states)); } catch { void 0; }
  }

  _hydrateAccordionFromDom() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('section-states')); } catch { void 0; }
    this._sections.forEach((section, id) => {
      const shouldBeOpen = saved ? (saved[id] ?? false) : (id === 'extract');
      const body = section.el.querySelector('.nav-section__body');
      if (!body) { return; }
      body.style.transition = 'none';
      if (shouldBeOpen) {
        section.el.classList.add('nav-section--expanded');
        body.style.height = 'auto';
        body.style.overflow = '';
        section.headerBtn?.setAttribute('aria-expanded', 'true');
      } else {
        section.el.classList.remove('nav-section--expanded');
        body.style.height = '0';
        body.style.overflow = 'hidden';
        section.headerBtn?.setAttribute('aria-expanded', 'false');
      }
      body.offsetHeight;
      body.style.transition = '';
    });
  }

  _clearBodyTransitionEnd(body) {
    if (body._accordionOpenFallback != null) {
      clearTimeout(body._accordionOpenFallback);
      body._accordionOpenFallback = null;
    }
    if (body._accordionTransitionEnd) {
      body.removeEventListener('transitionend', body._accordionTransitionEnd);
      body._accordionTransitionEnd = null;
    }
  }

  _openSectionBody(sectionEl) {
    const body = sectionEl.querySelector('.nav-section__body');
    if (!body) { return; }

    const reduce = typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      this._clearBodyTransitionEnd(body);
      body.style.height = 'auto';
      body.style.overflow = '';
      return;
    }

    this._clearBodyTransitionEnd(body);

    const rectH = body.getBoundingClientRect().height;
    const fullH = body.scrollHeight;
    if (fullH > 0 && Math.abs(rectH - fullH) < 2) {
      body.style.height = 'auto';
      body.style.overflow = '';
      return;
    }
    body.style.height = '0';
    body.style.overflow = 'hidden';
    body.style.display = 'block';
    body.offsetHeight;
    const targetH = body.scrollHeight;
    body.style.height = `${targetH}px`;
    const OPEN_FALLBACK_MS = 320;
    let openSettled = false;
    const finishOpen = () => {
      if (openSettled) { return; }
      openSettled = true;
      this._clearBodyTransitionEnd(body);
      body.style.height = 'auto';
      body.style.overflow = '';
    };
    const onEnd = (ev) => {
      if (ev.propertyName !== 'height' || ev.target !== body) { return; }
      finishOpen();
    };
    body._accordionTransitionEnd = onEnd;
    body.addEventListener('transitionend', onEnd);
    body._accordionOpenFallback = setTimeout(finishOpen, OPEN_FALLBACK_MS);
  }

  _closeSectionBody(sectionEl) {
    const body = sectionEl.querySelector('.nav-section__body');
    if (!body) { return; }

    const reduce = typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      this._clearBodyTransitionEnd(body);
      body.style.height = '0';
      body.style.overflow = 'hidden';
      return;
    }

    this._clearBodyTransitionEnd(body);
    const startH = Math.max(body.getBoundingClientRect().height, 1);
    body.style.height = `${startH}px`;
    body.offsetHeight;
    body.style.overflow = 'hidden';
    body.style.height = '0';
  }

  _measureAndSetHeight(sectionEl) {
    const body = sectionEl?.querySelector('.nav-section__body');
    if (!body || !sectionEl.classList.contains('nav-section--expanded')) { return; }
    body.style.height = 'auto';
    body.style.overflow = '';
  }

  _sidebarExpandedWidthPx() {
    const MIN_W = 220;
    const MAX_W = 480;
    const def = 300;
    try {
      const saved = parseInt(localStorage.getItem('sidebar-width'), 10);
      if (!Number.isNaN(saved) && saved >= MIN_W && saved <= MAX_W) { return saved; }
    } catch { void 0; }
    return def;
  }

  _syncPanelToggleButton() {
    const btn = document.getElementById('panel-toggle-btn');
    if (!btn) { return; }
    if (!btn.querySelector('svg')) {
      btn.innerHTML = iconChevronLeft(16);
    }
    btn.setAttribute('aria-expanded', String(!this._collapsed));
    btn.setAttribute('aria-label', this._collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  }

  toggleLeftPanel() {
    const panel = document.getElementById('left-panel');
    const root = document.getElementById('app-root');
    if (!panel) { return; }
    const focusInPanel = panel.contains(document.activeElement);

    /* Skip width animation so we never sweep through sub-340px widths (toolbar compact/overflow flicker). */
    panel.classList.add('left-panel--instant-width');

    this._collapsed = !this._collapsed;
    panel.classList.toggle('left-panel--collapsed', this._collapsed);

    if (root) {
      if (this._collapsed) {
        root.style.setProperty('--sidebar-width', '48px');
        panel.classList.remove('toolbar--compact', 'toolbar--narrow');
      } else {
        const w = this._sidebarExpandedWidthPx();
        root.style.setProperty('--sidebar-width', `${w}px`);
        panel.classList.toggle('toolbar--compact', w < 340);
        panel.classList.toggle('toolbar--narrow', w < 270);
      }
    }

    void panel.offsetWidth;
    requestAnimationFrame(() => {
      panel.classList.remove('left-panel--instant-width');
    });

    const handle = document.getElementById('panel-resize-handle');
    if (handle && !this._collapsed) {
      handle.setAttribute('aria-valuenow', String(this._sidebarExpandedWidthPx()));
    }

    this._syncPanelToggleButton();
    const btn = document.getElementById('panel-toggle-btn');
    if (this._collapsed && focusInPanel && btn) {
      requestAnimationFrame(() => btn.focus());
    }
  }

  setBreadcrumb(segments) {
    const container = document.getElementById('toolbar-breadcrumb');
    if (!container) { return; }
    container.innerHTML = '';
    segments.forEach((seg, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'breadcrumb-sep';
        sep.textContent = '/';
        container.appendChild(sep);
      }
      const isLast = i === segments.length - 1;
      const el = document.createElement('span');
      if (isLast) {
        el.className = 'breadcrumb-current';
      } else if (seg.action) {
        el.className = 'breadcrumb-link';
        el.addEventListener('click', seg.action);
      } else {
        el.className = 'breadcrumb-root';
      }
      el.textContent = seg.label;
      container.appendChild(el);
    });
  }

  syncBreadcrumbToActiveSection() {
    if (!this._activeSection) { return; }
    const label = this._activeSection.charAt(0).toUpperCase() + this._activeSection.slice(1);
    this.setBreadcrumb([{ label }]);
  }

  _initResizeHandle() {
    const handle = document.getElementById('panel-resize-handle');
    if (!handle) { return; }

    const MIN_W = 220, MAX_W = 480;
    const root = document.getElementById('app-root') ?? document.documentElement;

    const setWidth = (w) => {
      const clamped = Math.max(MIN_W, Math.min(MAX_W, Math.round(w)));
      root.style.setProperty('--sidebar-width', clamped + 'px');
      const panel = document.getElementById('left-panel');
      if (panel) {
        panel.classList.toggle('toolbar--compact', clamped < 340);
        panel.classList.toggle('toolbar--narrow', clamped < 270);
      }
      handle.setAttribute('aria-valuenow', String(clamped));
      try { localStorage.setItem('sidebar-width', String(clamped)); } catch { void 0; }
    };

    try {
      const saved = parseInt(localStorage.getItem('sidebar-width'), 10);
      if (saved >= MIN_W && saved <= MAX_W) { setWidth(saved); }
    } catch { void 0; }

    const panelInit = document.getElementById('left-panel');
    if (panelInit) {
      const w = parseInt(getComputedStyle(panelInit).width, 10);
      if (Number.isFinite(w)) {
        setWidth(Math.max(MIN_W, Math.min(MAX_W, w)));
      }
    }

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const panel = document.getElementById('left-panel');
      if (!panel) { return; }
      const startX = e.clientX;
      const startW = parseInt(getComputedStyle(panel).width, 10);
      panel.style.transition = 'none';
      handle.classList.add('is-resizing');
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';

      const onMove = (me) => {
        panel.style.transition = 'none';
        setWidth(startW + me.clientX - startX);
      };
      const onUp = () => {
        handle.classList.remove('is-resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);

        const rawW = parseInt(getComputedStyle(panel).width, 10);
        const clamped = Math.max(MIN_W, Math.min(MAX_W, Number.isFinite(rawW) ? rawW : startW));
        const snapped = snapNearestResize(clamped);
        const reduce = typeof window !== 'undefined'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        if (snapped !== null) {
          if (!reduce) {
            handle.style.transition = 'none';
            panel.style.transition = 'width 200ms var(--ease-spring)';
            setWidth(snapped);
            window.setTimeout(() => {
              panel.style.transition = '';
              handle.style.transition = '';
            }, 210);
          } else {
            setWidth(snapped);
            panel.style.transition = '';
          }
        } else {
          setWidth(clamped);
          panel.style.transition = '';
        }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    handle.addEventListener('keydown', (e) => {
      const current = parseInt(getComputedStyle(document.getElementById('left-panel')).width, 10);
      const step = e.shiftKey ? 50 : 10;
      if (e.key === 'ArrowRight') { e.preventDefault(); setWidth(current + step); }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); setWidth(current - step); }
    });
  }

  destroy() {
  }
}

export function createAppShell() {
  return new AppShell();
}