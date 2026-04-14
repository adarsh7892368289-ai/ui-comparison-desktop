'use strict';

import {
  iconX,
  iconCheck,
  iconAlertTriangle,
  iconAlertCircle,
  iconInfo,
} from '../utils/icons.js';

class Toast {
  static show(message, type = 'info', duration = 4000, body = null) {
    const container = document.getElementById('toast-container');
    if (!container) { return; }

    while (container.children.length >= 3) {
      Toast._dismiss(container.firstElementChild);
    }

    const icons = {
      success: iconCheck(18),
      warning: iconAlertTriangle(18),
      error: iconAlertCircle(18),
      info: iconInfo(18),
    };

    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

    toast.innerHTML = `
      <span class="toast-icon" aria-hidden="true">${icons[type] ?? ''}</span>
      <div class="toast-content">
        <div class="toast-title">${message}</div>
        ${body ? `<div class="toast-body">${body}</div>` : ''}
      </div>
      <button type="button" class="toast-close" aria-label="Dismiss notification">${iconX(14)}</button>
      ${duration > 0 ? '<div class="toast-progress"></div>' : ''}
    `;

    toast.querySelector('.toast-close').addEventListener('click', () => Toast._dismiss(toast));
    container.appendChild(toast);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => toast.classList.add('toast--visible'));
    });

    if (duration > 0) {
      const bar = toast.querySelector('.toast-progress');
      if (bar) {
        bar.style.transition = `transform ${duration}ms linear`;
        requestAnimationFrame(() => { bar.style.transform = 'scaleX(0)'; });
      }
      const timer = setTimeout(() => Toast._dismiss(toast), duration);
      toast._autoTimer = timer;
    }

    return toast;
  }

  static _dismiss(toast) {
    if (!toast || toast.dataset.dismissing) return;
    toast.dataset.dismissing = '1';
    clearTimeout(toast._autoTimer);
    toast.classList.remove('toast--visible');
    toast.classList.add('toast--dismissing');
    let removed = false;
    const remove = () => { if (!removed) { removed = true; toast.remove(); } };
    toast.addEventListener('transitionend', remove, { once: true });
    setTimeout(remove, 300);
  }

  static success(msg, body) { return Toast.show(msg, 'success', 4000, body); }
  static warning(msg, body) { return Toast.show(msg, 'warning', 6000, body); }
  static error(msg, body)   { return Toast.show(msg, 'error',   0,    body); }
  static info(msg, body)    { return Toast.show(msg, 'info',    4000, body); }
}

export { Toast };