const Toast = {
  _root: null,
  _init() {
    if (this._root) { return; }
    this._root = document.getElementById('toast-container');
  },
  show(message, type = 'info', duration = 4000) {
    this._init();
    if (!this._root) { return; }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

    const msg = document.createElement('span');
    msg.textContent = message;

    const close = document.createElement('button');
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.textContent = '×';
    close.addEventListener('click', () => this._dismiss(toast));

    toast.append(msg, close);
    this._root.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));

    if (duration > 0) {
      setTimeout(() => this._dismiss(toast), duration);
    }
  },
  _dismiss(toast) {
    if (!toast.isConnected) { return; }
    toast.classList.remove('visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  },
  success(message, duration = 4000) { this.show(message, 'success', duration); },
  error(message,   duration = 6000) { this.show(message, 'error',   duration); },
  info(message,    duration = 4000) { this.show(message, 'info',    duration); },
  warning(message, duration = 5000) { this.show(message, 'warning', duration); },
};

export { Toast };