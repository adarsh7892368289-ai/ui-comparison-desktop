'use strict';

function sanitize(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const Toast = {
  _root: null,
  _init() { this._root = this._root ?? document.getElementById('toast-container'); },
  show(msg, type, duration = 3000) {
    this._init();
    const t   = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const txt = document.createElement('span');
    txt.textContent = msg;
    const x = document.createElement('button');
    x.className   = 'toast-close';
    x.setAttribute('aria-label', 'Dismiss');
    x.textContent = '×';
    x.addEventListener('click', () => this._dismiss(t));
    t.append(txt, x);
    this._root.appendChild(t);
    requestAnimationFrame(() => t.classList.add('visible'));
    if (duration > 0) { setTimeout(() => this._dismiss(t), duration); }
    while (this._root.children.length > 4) { this._dismiss(this._root.firstChild); }
  },
  _dismiss(t) {
    if (!t?.isConnected) { return; }
    t.classList.remove('visible');
    t.addEventListener('transitionend', () => t.remove(), { once: true });
  },
  success(m) { this.show(m, 'success', 3000); },
  error(m)   { this.show(m, 'error',   0);    },
  info(m)    { this.show(m, 'info',    3000); },
  warning(m) { this.show(m, 'warning', 4000); },
};

const Modal = {
  _overlay: null,
  _box:     null,
  _resolve: null,
  _init() {
    if (this._overlay) { return; }
    this._overlay = document.getElementById('modal-overlay');
    this._box     = document.getElementById('modal-box');
    this._overlay.addEventListener('click', e => {
      if (e.target === this._overlay) { this._close(false); }
    });
    document.addEventListener('keydown', e => {
      if (this._resolve && e.key === 'Escape') { this._close(false); }
    });
  },
  confirm(title, message, { confirmText = 'Confirm', destructive = false } = {}) {
    this._init();
    return new Promise(resolve => {
      this._resolve = resolve;
      this._box.innerHTML = `
        <p class="modal-title" id="modal-title">${sanitize(title)}</p>
        <p class="modal-message">${sanitize(message)}</p>
        <div class="modal-actions">
          <button class="btn-ghost modal-cancel">Cancel</button>
          <button class="btn-${destructive ? 'destructive' : 'primary'} btn-sm modal-confirm">
            ${sanitize(confirmText)}
          </button>
        </div>`;
      this._overlay.classList.remove('hidden');
      this._box.querySelector('.modal-confirm').focus();
      this._box.querySelector('.modal-cancel').addEventListener('click',  () => this._close(false));
      this._box.querySelector('.modal-confirm').addEventListener('click', () => this._close(true));
    });
  },
  _close(result) {
    this._overlay?.classList.add('hidden');
    const res     = this._resolve;
    this._resolve = null;
    res?.(result);
  },
};

function showProgress(id, label) {
  const wrap = document.getElementById(`${id}-progress`);
  if (wrap) { wrap.classList.add('visible'); }
  updateProgress(id, 0, label);
}

function updateProgress(id, pct, label) {
  const bar  = document.getElementById(`${id}-progress-bar`);
  const lbl  = document.getElementById(`${id}-progress-label`);
  const wrap = document.getElementById(`${id}-progress`);
  if (bar)  { bar.style.width = `${pct}%`; }
  if (lbl && label) { lbl.textContent = label; }
  if (wrap) { wrap.setAttribute('aria-valuenow', pct); }
}

function hideProgress(id) {
  const wrap = document.getElementById(`${id}-progress`);
  if (wrap) { wrap.classList.remove('visible'); }
}

function setError(id, msg) {
  const el = document.getElementById(`${id}-error`);
  if (el) { el.textContent = msg ?? ''; }
}

import { getState } from './state.js';

function syncCompareButton() {
  const state = getState();
  const btn   = document.getElementById('compare-btn');
  if (btn) {
    btn.disabled = !state.selectedBaseline ||
                   !state.selectedCompare  ||
                   state.selectedBaseline === state.selectedCompare;
  }
}

export {
  Toast,
  Modal,
  showProgress,
  updateProgress,
  hideProgress,
  setError,
  syncCompareButton,
};