'use strict';

export class AppShell {
  constructor() {
    this._sectionIds = ['extract', 'compare'];
    this._activeSection = null;
    this._collapsed = false;
    this._wireSectionHeaders();
  }

  _wireSectionHeaders() {
    this._sectionIds.forEach(id => {
      const header = document.querySelector(`#section-${id} .nav-section__header`);
      if (!header) { return; }
      header.addEventListener('click', () => this.activateSection(id));
    });
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
    });
    this._activeSection = sectionId;
    const label = sectionId.charAt(0).toUpperCase() + sectionId.slice(1);
    this.setBreadcrumb([{ label: 'UI Comparison' }, { label }]);

    const body = document.getElementById(`body-${sectionId}`);
    const firstFocusable = body?.querySelector(
      'input:not([disabled]), button:not([disabled]), select:not([disabled]), [tabindex="0"]'
    );
    requestAnimationFrame(() => firstFocusable?.focus());
  }

  toggleLeftPanel() {
    const panel = document.getElementById('left-panel');
    if (!panel) { return; }
    const focusInPanel = panel.contains(document.activeElement);
    this._collapsed = !this._collapsed;
    panel.classList.toggle('left-panel--collapsed', this._collapsed);
    const btn = document.getElementById('panel-toggle-btn');
    if (btn) {
      btn.textContent = this._collapsed ? '\u203a' : '\u2039';
      btn.setAttribute('aria-expanded', String(!this._collapsed));
    }
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
      el.className = isLast ? 'breadcrumb-current' : 'breadcrumb-link';
      el.textContent = seg.label;
      if (!isLast && seg.action) {
        el.addEventListener('click', seg.action);
      }
      container.appendChild(el);
    });
  }

  destroy() {
  }
}

export function createAppShell() {
  return new AppShell();
}