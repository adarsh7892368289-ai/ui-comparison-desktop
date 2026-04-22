'use strict';

import {
  iconX,
  iconCheck,
  iconAlertTriangle,
  iconAlertCircle,
  iconInfo,
} from '../utils/icons.js';
import {
  NOTIFICATION_DURATION_INDEFINITE,
  NOTIFICATION_DURATION_LONG_MS,
  NOTIFICATION_DURATION_SHORT_MS,
} from '../constants/notification-timing.js';
import {
  initNotificationQueue,
  dispatchEnqueue,
  dispatchRemoveAnimationComplete,
  dispatchToastDismissRequested,
} from '../application/notification-queue.js';

const iconByTier = {
  success: iconCheck,
  warning: iconAlertTriangle,
  error: iconAlertCircle,
  info: iconInfo,
};

function appendSvgFromString(parent, svgString) {
  const p = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  const root = p.documentElement;
  if (root && root.nodeName.toLowerCase() === 'svg') {
    parent.appendChild(root);
  }
}

function resolveDurationArg(type, duration) {
  if (duration === NOTIFICATION_DURATION_INDEFINITE || duration === 0) {
    return NOTIFICATION_DURATION_INDEFINITE;
  }
  if (duration === undefined || duration === 'inherit') {
    return 'inherit';
  }
  if (typeof duration === 'number' && duration > 0) {
    return duration;
  }
  return 'inherit';
}

function mountNotification(item) {
  const container = document.getElementById('toast-container');
  const type = item.tier;
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.dataset.notificationId = item.id;
  const isAlert = type === 'error';
  toast.setAttribute('role', isAlert ? 'alert' : 'status');
  toast.setAttribute('aria-live', isAlert ? 'assertive' : 'polite');
  toast.setAttribute('aria-atomic', 'true');

  const iconFn = iconByTier[type] || iconInfo;
  const main = document.createElement('div');
  main.className = 'toast-main';

  const iconCol = document.createElement('div');
  iconCol.className = 'toast-icon-col';
  const iconSpan = document.createElement('span');
  iconSpan.className = 'toast-icon';
  iconSpan.setAttribute('aria-hidden', 'true');
  appendSvgFromString(iconSpan, iconFn(18));
  iconCol.appendChild(iconSpan);

  const copy = document.createElement('div');
  copy.className = 'toast-copy';

  const titleEl = document.createElement('div');
  titleEl.className = 'toast-title';
  titleEl.textContent = item.title;

  copy.appendChild(titleEl);
  if (item.body) {
    const bodyEl = document.createElement('div');
    bodyEl.className = 'toast-body';
    bodyEl.textContent = item.body;
    copy.appendChild(bodyEl);
  }

  main.appendChild(iconCol);
  main.appendChild(copy);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'toast-close';
  closeBtn.setAttribute('aria-label', 'Dismiss notification');
  appendSvgFromString(closeBtn, iconX(14));
  closeBtn.addEventListener('click', () => {
    dispatchToastDismissRequested(toast);
  });

  toast.appendChild(main);
  toast.appendChild(closeBtn);

  if (item.durationMs !== NOTIFICATION_DURATION_INDEFINITE) {
    toast.classList.add('toast--has-progress');
    const bar = document.createElement('div');
    bar.className = 'toast-progress';
    toast.appendChild(bar);
  }

  container.appendChild(toast);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      toast.classList.add('toast--visible');
      const bar = toast.querySelector('.toast-progress');
      if (bar && item.durationMs !== NOTIFICATION_DURATION_INDEFINITE) {
        const d = item.durationMs;
        bar.style.transition = `transform ${d}ms linear`;
        requestAnimationFrame(() => {
          bar.style.transform = 'scaleX(0)';
        });
      }
    });
  });

  return toast;
}

function beginDismissToast(toast) {
  if (!toast || toast.dataset.dismissing) return;
  toast.dataset.dismissing = '1';
  toast.classList.remove('toast--visible');
  toast.classList.add('toast--dismissing');
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    dispatchRemoveAnimationComplete(toast);
  };
  toast.addEventListener(
    'transitionend',
    (ev) => {
      if (ev.target !== toast) return;
      finish();
    },
    { once: true }
  );
  setTimeout(finish, 200);
}

function removeToastElement(toast) {
  if (toast && toast.parentNode) {
    toast.remove();
  }
}

function updateNotificationContent(id, item) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = Array.from(container.querySelectorAll('[data-notification-id]')).find(
    (node) => node.dataset.notificationId === id
  );
  if (!el) return;
  const titleEl = el.querySelector('.toast-title');
  const bodyEl = el.querySelector('.toast-body');
  if (titleEl) titleEl.textContent = item.title;
  if (item.body) {
    if (bodyEl) bodyEl.textContent = item.body;
    else {
      const b = document.createElement('div');
      b.className = 'toast-body';
      b.textContent = item.body;
      el.querySelector('.toast-copy')?.appendChild(b);
    }
  }
}

initNotificationQueue({
  mountNotification,
  beginDismissToast,
  removeToastElement,
  updateNotificationContent,
});

class Toast {
  static show(message, type = 'info', duration, body = null, dedupeKey = undefined) {
    const durationMs = resolveDurationArg(type, duration === undefined ? 'inherit' : duration);
    dispatchEnqueue({
      tier: type,
      title: message,
      body,
      durationMs,
      dedupeKey,
    });
  }

  static success(msg, body) {
    return Toast.show(msg, 'success', NOTIFICATION_DURATION_SHORT_MS, body);
  }

  static warning(msg, body, dedupeKey) {
    return Toast.show(msg, 'warning', NOTIFICATION_DURATION_LONG_MS, body, dedupeKey);
  }

  static error(msg, body) {
    return Toast.show(msg, 'error', NOTIFICATION_DURATION_INDEFINITE, body);
  }

  static info(msg, body) {
    return Toast.show(msg, 'info', NOTIFICATION_DURATION_SHORT_MS, body);
  }
}

export { Toast };
