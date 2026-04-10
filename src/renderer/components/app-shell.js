'use strict';

import { iconChevronLeft, iconChevronRight } from '../utils/icons.js';

export class AppShell {
  constructor() {
    this._sectionIds = ['extract', 'compare'];
    this._activeSection = null;
    this._collapsed = false;
    this._wireSectionHeaders();
    this._syncPanelToggleButton();
    this._hydrateAccordionFromDom();
  }

  _wireSectionHeaders() {
    this._sectionIds.forEach(id => {
      const header = document.querySelector(`#section-${id} .nav-section__header`);
      if (!header) { return; }
      header.addEventListener('click', () => this.activateSection(id));
    });
  }

  /**
   * Match DOM classes from index.html before any animated toggle runs.
   * If content is injected into a section body without a full report-list re-render,
   * call _measureAndSetHeight(sectionEl) so height: auto reflects new content.
   */
  _hydrateAccordionFromDom() {
    for (const id of this._sectionIds) {
      const section = document.getElementById(`section-${id}`);
      const body = section?.querySelector('.nav-section__body');
      if (!body) { continue; }
      const expanded = section.classList.contains('nav-section--expanded');
      body.style.transition = 'none';
      if (expanded) {
        body.style.height = 'auto';
        body.style.overflow = '';
      } else {
        body.style.height = '0';
        body.style.overflow = 'hidden';
      }
      body.offsetHeight; /* reflow */
      body.style.transition = '';
    }
  }

  _clearBodyTransitionEnd(body) {
    if (body._accordionTransitionEnd) {
      body.removeEventListener('transitionend', body._accordionTransitionEnd);
      body._accordionTransitionEnd = null;
    }
  }

  _toggleSectionBody(sectionEl, open) {
    const body = sectionEl.querySelector('.nav-section__body');
    if (!body) { return; }

    const reduce = typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      this._clearBodyTransitionEnd(body);
      body.style.height = open ? 'auto' : '0';
      body.style.overflow = open ? '' : 'hidden';
      return;
    }

    this._clearBodyTransitionEnd(body);

    if (open) {
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
      body.offsetHeight; /* force reflow so transition runs */
      const targetH = body.scrollHeight;
      body.style.height = `${targetH}px`;
      const onEnd = (ev) => {
        if (ev.propertyName !== 'height') { return; }
        body.style.height = 'auto';
        body.style.overflow = '';
        body._accordionTransitionEnd = null;
      };
      body._accordionTransitionEnd = onEnd;
      body.addEventListener('transitionend', onEnd, { once: true });
    } else {
      /* Use layout height (not scrollHeight) so closing mid-open animation does not jump. */
      const startH = Math.max(body.getBoundingClientRect().height, 1);
      body.style.height = `${startH}px`;
      body.offsetHeight;
      body.style.overflow = 'hidden';
      body.style.height = '0';
    }
  }

  /**
   * If content is added inside an open section without report-list re-render, call this
   * so height: auto reflects new content (current architecture usually re-renders instead).
   */
  _measureAndSetHeight(sectionEl) {
    const body = sectionEl?.querySelector('.nav-section__body');
    if (!body || !sectionEl.classList.contains('nav-section--expanded')) { return; }
    body.style.height = 'auto';
    body.style.overflow = '';
  }

  activateSection(sectionId) {
    this._sectionIds.forEach(id => {
      const section = document.getElementById(`section-${id}`);
      if (!section) { return; }
      const header = section.querySelector('.nav-section__header');
      const isTarget = id === sectionId;
      section.classList.toggle('nav-section--expanded', isTarget);
      section.classList.toggle('nav-section--active', isTarget);
      header?.setAttribute('aria-expanded', String(isTarget));
      this._toggleSectionBody(section, isTarget);
    });
    this._activeSection = sectionId;
    const label = sectionId.charAt(0).toUpperCase() + sectionId.slice(1);
    /* Single segment — no duplicate product name; root is never a false link */
    this.setBreadcrumb([{ label }]);

    const body = document.getElementById(`body-${sectionId}`);
    const firstFocusable = body?.querySelector(
      'input:not([disabled]), button:not([disabled]), select:not([disabled]), [tabindex="0"]'
    );
    requestAnimationFrame(() => firstFocusable?.focus());
  }

  _syncPanelToggleButton() {
    const btn = document.getElementById('panel-toggle-btn');
    if (!btn) { return; }
    btn.innerHTML = this._collapsed ? iconChevronRight() : iconChevronLeft();
    btn.setAttribute('aria-expanded', String(!this._collapsed));
    btn.setAttribute('aria-label', this._collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  }

  toggleLeftPanel() {
    const panel = document.getElementById('left-panel');
    if (!panel) { return; }
    const focusInPanel = panel.contains(document.activeElement);
    this._collapsed = !this._collapsed;
    panel.classList.toggle('left-panel--collapsed', this._collapsed);
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

  /** Reset toolbar trail after result clear — uses last activated Extract/Compare section */
  syncBreadcrumbToActiveSection() {
    if (!this._activeSection) { return; }
    const label = this._activeSection.charAt(0).toUpperCase() + this._activeSection.slice(1);
    this.setBreadcrumb([{ label }]);
  }

  destroy() {
  }
}

export function createAppShell() {
  return new AppShell();
}
