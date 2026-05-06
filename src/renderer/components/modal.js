import { sanitize } from '../utils/sanitize.js';

const Modal = {
  _overlay: null,
  _box:     null,
  _resolve: null,
  _previousFocus: null,
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
      this._previousFocus = document.activeElement;
      this._resolve = resolve;
      this._box.innerHTML = `
        <p class="modal-title" id="modal-title">${sanitize(title)}</p>
        <p class="modal-message">${sanitize(message)}</p>
        <div class="modal-actions">
          <button class="btn-ghost btn-sm modal-cancel">Cancel</button>
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
    if (this._previousFocus?.isConnected) {
      this._previousFocus.focus();
    }
    this._previousFocus = null;
    res?.(result);
  },
};

export { Modal };