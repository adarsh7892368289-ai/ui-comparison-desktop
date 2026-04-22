'use strict';

import {
  NOTIFICATION_DURATION_INDEFINITE,
  NOTIFICATION_DURATION_LONG_MS,
  NOTIFICATION_DURATION_SHORT_MS,
  NOTIFICATION_MIN_ALERT_VISIBLE_MS,
  NOTIFICATION_SPAM_WINDOW_MS,
} from '../constants/notification-timing.js';

const MAX_VISIBLE = 3;

export const NotificationState = Object.freeze({
  IDLE: 'idle',
  ACTIVE: 'active',
  COALESCING: 'coalescing',
  DRAINING: 'draining',
});

let _state = NotificationState.IDLE;
const _waitQueue = [];
const _visible = [];
const _coalesceBuffer = [];
let _spamStamps = [];
let _handlers = null;
let _coalesceTimer = null;

function setState(next) {
  _state = next;
}

function G_visible_lt_3() {
  return _visible.length < MAX_VISIBLE;
}

function G_wait_nonempty() {
  return _waitQueue.length > 0;
}

function registerSpamStamp() {
  const now = Date.now();
  _spamStamps.push(now);
  while (_spamStamps.length && now - _spamStamps[0] > NOTIFICATION_SPAM_WINDOW_MS) {
    _spamStamps.shift();
  }
}

function G_spam() {
  return _spamStamps.length >= 3;
}

function G_tier_t4(item) {
  return item && item.tier === 'error';
}

function normalizeDuration(tier, durationMs) {
  if (durationMs === NOTIFICATION_DURATION_INDEFINITE || durationMs === 0) {
    return NOTIFICATION_DURATION_INDEFINITE;
  }
  if (durationMs == null) {
    if (tier === 'error') return NOTIFICATION_DURATION_INDEFINITE;
    if (tier === 'warning') return NOTIFICATION_DURATION_LONG_MS;
    return NOTIFICATION_DURATION_SHORT_MS;
  }
  if (durationMs === 'inherit') {
    if (tier === 'error') return NOTIFICATION_DURATION_INDEFINITE;
    if (tier === 'warning') return NOTIFICATION_DURATION_LONG_MS;
    return NOTIFICATION_DURATION_SHORT_MS;
  }
  if (typeof durationMs === 'number' && durationMs > 0) {
    return durationMs;
  }
  if (tier === 'error') return NOTIFICATION_DURATION_INDEFINITE;
  if (tier === 'warning') return NOTIFICATION_DURATION_LONG_MS;
  return NOTIFICATION_DURATION_SHORT_MS;
}

function buildItem(partial) {
  const tier = partial.tier || 'info';
  const id = partial.id || crypto.randomUUID();
  const durationMs = normalizeDuration(tier, partial.durationMs);
  return {
    id,
    tier,
    title: partial.title || '',
    body: partial.body ?? null,
    durationMs,
    dedupeKey: partial.dedupeKey,
    repeatCount: partial.repeatCount || 1,
    createdAt: partial.createdAt || Date.now(),
    source: partial.source || 'renderer',
  };
}

function mergeCoalesceBufferIntoWaitQueue() {
  const seen = new Map();
  const ordered = [];
  for (const item of _coalesceBuffer) {
    const k = item.dedupeKey || item.id;
    if (seen.has(k)) {
      const prev = seen.get(k);
      prev.repeatCount = (prev.repeatCount || 1) + 1;
      prev.title = item.title;
      if (item.body != null) prev.body = item.body;
    } else {
      seen.set(k, item);
      ordered.push(item);
    }
  }
  _coalesceBuffer.length = 0;
  for (const it of ordered) {
    if (G_tier_t4(it)) {
      _waitQueue.unshift(it);
    } else {
      _waitQueue.push(it);
    }
  }
}

function dispatchBurstDetected() {
  setState(NotificationState.COALESCING);
  if (_coalesceTimer) {
    clearTimeout(_coalesceTimer);
  }
  _coalesceTimer = setTimeout(dispatchCoalesceComplete, 0);
}

function dispatchCoalesceComplete() {
  _coalesceTimer = null;
  mergeCoalesceBufferIntoWaitQueue();
  setState(NotificationState.ACTIVE);
  if (G_visible_lt_3()) {
    pumpMountFromWaitQueue();
  } else if (G_wait_nonempty()) {
    dispatchEvictOldest();
  }
}

function computeAutoDismissDelayMs(item) {
  if (item.durationMs === NOTIFICATION_DURATION_INDEFINITE) {
    return NOTIFICATION_DURATION_INDEFINITE;
  }
  let d = item.durationMs;
  if (item.tier === 'error' && d !== NOTIFICATION_DURATION_INDEFINITE) {
    d = Math.max(d, NOTIFICATION_MIN_ALERT_VISIBLE_MS);
  }
  return d;
}

function scheduleAutoDismissForEntry(entry) {
  const delay = computeAutoDismissDelayMs(entry.item);
  if (delay === NOTIFICATION_DURATION_INDEFINITE) return;
  entry.timerId = setTimeout(() => {
    dispatchAutoDismissTimerFired(entry.id);
  }, delay);
}

function clearEntryTimer(entry) {
  if (entry.timerId != null) {
    clearTimeout(entry.timerId);
    entry.timerId = null;
  }
}

function mountOne(item) {
  const el = _handlers.mountNotification(item);
  const entry = { id: item.id, item, el, timerId: null };
  _visible.push(entry);
  scheduleAutoDismissForEntry(entry);
  setState(NotificationState.ACTIVE);
}

function pumpMountFromWaitQueue() {
  while (G_visible_lt_3() && G_wait_nonempty()) {
    const next = _waitQueue.shift();
    mountOne(next);
  }
  if (_visible.length === 0) {
    setState(NotificationState.IDLE);
  }
}

function dispatchEvictOldest() {
  const first = _visible[0];
  if (!first) return;
  dispatchToastDismissRequested(first.el);
}

function tryMergeDedupeInWait(item) {
  if (!item.dedupeKey) return false;
  for (const w of _waitQueue) {
    if (w.dedupeKey === item.dedupeKey) {
      w.repeatCount = (w.repeatCount || 1) + 1;
      w.title = item.title;
      if (item.body != null) w.body = item.body;
      return true;
    }
  }
  return false;
}

function tryMergeDedupeVisible(item) {
  if (!item.dedupeKey) return false;
  const vis = _visible.find(v => v.item.dedupeKey === item.dedupeKey);
  if (vis) {
    _handlers.updateNotificationContent(vis.id, item);
    return true;
  }
  return false;
}

export function dispatchEnqueue(partial) {
  const item = buildItem(partial);
  if (tryMergeDedupeVisible(item)) {
    return item.id;
  }
  registerSpamStamp();
  if (G_spam()) {
    _coalesceBuffer.push(item);
    dispatchBurstDetected();
    return item.id;
  }
  if (tryMergeDedupeInWait(item)) {
    return item.id;
  }
  if (G_tier_t4(item)) {
    _waitQueue.unshift(item);
  } else {
    _waitQueue.push(item);
  }
  if (G_visible_lt_3()) {
    pumpMountFromWaitQueue();
  } else {
    dispatchEvictOldest();
  }
  return item.id;
}

export function dispatchToastDismissRequested(el) {
  const idx = _visible.findIndex(v => v.el === el);
  if (idx < 0) return;
  setState(NotificationState.DRAINING);
  const entry = _visible[idx];
  clearEntryTimer(entry);
  _handlers.beginDismissToast(el);
}

export function dispatchAutoDismissTimerFired(id) {
  const idx = _visible.findIndex(v => v.id === id);
  if (idx < 0) return;
  const entry = _visible[idx];
  dispatchToastDismissRequested(entry.el);
}

export function dispatchRemoveAnimationComplete(el) {
  const idx = _visible.findIndex(v => v.el === el);
  if (idx < 0) return;
  const entry = _visible.splice(idx, 1)[0];
  clearEntryTimer(entry);
  _handlers.removeToastElement(el);
  if (G_wait_nonempty()) {
    setState(NotificationState.ACTIVE);
    dispatchShowNextFromWaitQueue();
  } else if (_visible.length === 0) {
    setState(NotificationState.IDLE);
  } else {
    setState(NotificationState.ACTIVE);
  }
}

function dispatchShowNextFromWaitQueue() {
  pumpMountFromWaitQueue();
}

export function initNotificationQueue(handlers) {
  _handlers = handlers;
}

export function getNotificationState() {
  return _state;
}
