'use strict';

const SystemBanner = {
  _slot: null,
  _current: null,

  _init() {
    if (this._slot) return;
    this._slot = document.getElementById('system-banner-slot');
  },

  show(message, type = 'warning', { dismissible = false } = {}) {
    this._init();
    if (!this._slot) return;

    this.dismiss();

    const banner = document.createElement('div');
    banner.className = `system-banner system-banner--${type}`;
    banner.setAttribute('role', 'alert');

    const msg = document.createElement('span');
    msg.className = 'system-banner__msg';
    msg.textContent = message;
    banner.appendChild(msg);

    if (dismissible) {
      const btn = document.createElement('button');
      btn.className = 'system-banner__dismiss';
      btn.setAttribute('aria-label', 'Dismiss');
      btn.textContent = '\u00d7';
      btn.addEventListener('click', () => this.dismiss());
      banner.appendChild(btn);
    }

    this._slot.appendChild(banner);
    this._current = banner;
  },

  dismiss() {
    if (this._current?.isConnected) {
      this._current.remove();
    }
    this._current = null;
  },

  warning(message, opts) { this.show(message, 'warning', opts); },
  error(message, opts)   { this.show(message, 'error', opts); },
};

export { SystemBanner };
