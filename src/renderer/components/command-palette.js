'use strict';

export class CommandPalette {
  constructor() {
    this._commands = [];
    this._filtered = [];
    this._activeIndex = 0;
    this._overlay = null;
    this._input = null;
    this._resultsList = null;
    this._previousFocus = null;
    this._boundKeydown = this._onKeydown.bind(this);
    this._boundTrapFocus = this._trapFocus.bind(this);
    this._panel = null;
  }

  registerCommands(commands) {
    this._commands = commands;
  }

  open() {
    if (this._overlay) { return; }
    this._previousFocus = document.activeElement;
    this._overlay = this._buildOverlay();
    document.body.appendChild(this._overlay);
    this._filtered = [...this._commands];
    this._activeIndex = 0;
    this._renderResults();
    this._input.focus();
    document.addEventListener('keydown', this._boundKeydown, true);
  }

  close() {
    if (!this._overlay) { return; }
    document.removeEventListener('keydown', this._boundKeydown, true);
    this._overlay.remove();
    this._overlay = null;
    this._input = null;
    this._resultsList = null;
    this._panel?.removeEventListener('keydown', this._boundTrapFocus);
    this._panel = null;
    if (this._previousFocus?.isConnected) {
      this._previousFocus.focus();
    } else {
      document.body.focus();
    }
    this._previousFocus = null;
  }

  toggle() {
    this._overlay ? this.close() : this.open();
  }

  destroy() {
    this.close();
    this._panel = null;
  }

  _buildOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'cmd-palette__overlay';
    overlay.addEventListener('click', e => {
      if (e.target === overlay) { this.close(); }
    });

    const panel = document.createElement('div');
    panel.className = 'cmd-palette__panel';
    panel.addEventListener('click', e => e.stopPropagation());

    const input = document.createElement('input');
    input.className = 'cmd-palette__input';
    input.type = 'text';
    input.placeholder = 'Type a command…';
    input.setAttribute('aria-label', 'Command search');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-haspopup', 'listbox');
    input.setAttribute('aria-controls', 'cmd-palette-listbox');
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      this._filtered = q
        ? this._commands.filter(c =>
            c.label.toLowerCase().includes(q) ||
            (c.keywords ?? []).some(k => k.toLowerCase().includes(q))
          )
        : [...this._commands];
      this._activeIndex = 0;
      this._renderResults();
    });

    const results = document.createElement('div');
    results.className = 'cmd-palette__results';
    results.setAttribute('role', 'listbox');
    results.id = 'cmd-palette-listbox';

    this._input = input;
    this._resultsList = results;
    this._panel = panel;

    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Command palette');
    panel.addEventListener('keydown', this._boundTrapFocus);

    panel.append(input, results);
    overlay.appendChild(panel);
    return overlay;
  }

  _renderResults() {
    const list = this._resultsList;
    if (!list) { return; }
    list.innerHTML = '';

    if (this._filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'cmd-palette__empty';
      empty.textContent = 'No commands found';
      list.appendChild(empty);
      return;
    }

    let activeOptionId = null;
    this._filtered.forEach((cmd, i) => {
      const item = document.createElement('div');
      const optionId = `cmd-option-${i}`;
      item.id = optionId;
      item.className = 'cmd-palette__item' + (i === this._activeIndex ? ' cmd-palette__item--active' : '');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(i === this._activeIndex));
      item.dataset.index = String(i);
      if (i === this._activeIndex) activeOptionId = optionId;

      const icon = document.createElement('span');
      icon.className = 'cmd-palette__item-icon';
      icon.textContent = cmd.icon ?? '';
      icon.setAttribute('aria-hidden', 'true');

      const label = document.createElement('span');
      label.className = 'cmd-palette__item-label';
      label.textContent = cmd.label;

      item.append(icon, label);

      if (cmd.shortcut) {
        const shortcut = document.createElement('span');
        shortcut.className = 'cmd-palette__item-shortcut';
        shortcut.textContent = cmd.shortcut;
        item.appendChild(shortcut);
      }

      item.addEventListener('click', () => {
        cmd.action();
        this.close();
      });

      list.appendChild(item);
    });

    if (this._input && activeOptionId) {
      this._input.setAttribute('aria-activedescendant', activeOptionId);
    } else if (this._input) {
      this._input.removeAttribute('aria-activedescendant');
    }

    this._scrollActiveIntoView();
  }

  _scrollActiveIntoView() {
    const list = this._resultsList;
    if (!list) { return; }
    list.querySelector('.cmd-palette__item--active')?.scrollIntoView({ block: 'nearest' });
  }

  _setActiveIndex(i) {
    const max = this._filtered.length;
    if (max === 0) { return; }
    this._activeIndex = Math.max(0, Math.min(i, max - 1));
    this._renderResults();
  }

  _trapFocus(e) {
    if (e.key !== 'Tab') return;
    const panel = this._panel;
    if (!panel) return;
    const focusable = [...panel.querySelectorAll('input, [tabindex="0"]')];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  _onKeydown(e) {
    if (!this._overlay) { return; }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this._setActiveIndex(this._activeIndex + 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this._setActiveIndex(this._activeIndex - 1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopImmediatePropagation();
      const cmd = this._filtered[this._activeIndex];
      if (cmd) {
        cmd.action();
        this.close();
      }
    }
  }
}

export function createCommandPalette() {
  return new CommandPalette();
}