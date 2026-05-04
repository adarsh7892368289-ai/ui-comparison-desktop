'use strict';

import { getState, dispatch, subscribe } from '../state.js';

const BUSY_PHASES = new Set(['extracting', 'comparing', 'cancelling']);

const UNAVAILABLE_REASON_LABELS = Object.freeze({
  'binary-not-found':
  'Detection found a registry entry but the executable is missing.',
  'version-mismatch':
  'Installed version is outside the range Playwright supports.',
  'playwright-requires-patched-build':
  'Playwright requires its own patched build of this engine — system installs cannot be driven.',
  'unsupported-os':
  'This engine is not available on the current operating system.',
  'devtools-blocked-by-policy':
  'Blocked by your IT policy — DevTools remote debugging is disabled. Use Playwright Chromium instead.'
});

function _humanizeReason(reason) {
  if (!reason) {return '';}
  return UNAVAILABLE_REASON_LABELS[reason] ?? reason;
}

export class BrowserSelector {
  constructor(containerEl, api) {
    this._container = containerEl;
    this._api = api;
    this._unsubscribe = null;

    this._field = document.createElement('div');
    this._field.className = 'form-field browser-selector';

    this._label = document.createElement('label');
    this._label.className = 'label';
    this._label.htmlFor = 'browser-select';
    this._label.id = 'browser-select-label';
    this._label.textContent = 'Browser';

    this._row = document.createElement('div');
    this._row.className = 'browser-selector__row';

    this._select = document.createElement('select');
    this._select.id = 'browser-select';
    this._select.className = 'input browser-selector__select';
    this._select.setAttribute('aria-labelledby', 'browser-select-label');

    this._retryBtn = document.createElement('button');
    this._retryBtn.type = 'button';
    this._retryBtn.className = 'btn-ghost btn-sm browser-selector__retry';
    this._retryBtn.textContent = 'Retry';
    this._retryBtn.hidden = true;

    this._row.append(this._select, this._retryBtn);
    this._field.append(this._label, this._row);
    this._container.appendChild(this._field);

    this._select.addEventListener('change', this._onChange.bind(this));
    this._retryBtn.addEventListener('click', this._onRetry.bind(this));




    this._render(getState());
    this._unsubscribe = subscribe((state) => this._render(state));
  }

  _onChange(event) {
    const id = event.target.value;
    const state = getState();
    const browser = (state.availableBrowsers ?? []).find((b) => b.id === id);
    if (!browser || !browser.isLaunchable) {



      this._render(state);
      return;
    }
    dispatch('BROWSER_SELECTED', { browser });
  }

  _onRetry() {
    if (!this._api || typeof this._api.getAvailableBrowsers !== 'function') {
      return;
    }
    dispatch('BROWSER_DETECTION_STARTED');
    this._api.getAvailableBrowsers({ refresh: true }).then((res) => {
      if (res && res.success) {
        dispatch('BROWSERS_DETECTED', {
          browsers: res.browsers,
          detectedAt: res.detectedAt
        });
      } else {
        dispatch('BROWSER_DETECTION_FAILED', {
          error: res?.error ?? 'Browser detection failed'
        });
      }
    }).catch((err) => {
      dispatch('BROWSER_DETECTION_FAILED', {
        error: err?.message ?? String(err)
      });
    });
  }

  _render(state) {
    const detectionState = state.browserDetectionState;
    const phase = state.phase;
    const browsers = state.availableBrowsers ?? [];

    this._select.replaceChildren();

    if (detectionState === 'loading' || detectionState === 'idle') {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Detecting browsers…';
      opt.disabled = true;
      opt.selected = true;
      this._select.appendChild(opt);
      this._select.disabled = true;
      this._retryBtn.hidden = true;
      return;
    }

    if (detectionState === 'error') {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Browser detection failed';
      opt.disabled = true;
      opt.selected = true;
      this._select.appendChild(opt);
      this._select.disabled = true;
      this._retryBtn.hidden = false;
      this._retryBtn.title = state.browserDetectionError ?? 'Retry browser detection';
      return;
    }


    this._retryBtn.hidden = true;

    if (browsers.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No browsers detected';
      opt.disabled = true;
      opt.selected = true;
      this._select.appendChild(opt);
      this._select.disabled = true;
      return;
    }

    const selectedId = state.selectedBrowser?.id ?? '';
    for (const b of browsers) {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = b.displayName;
      if (!b.isLaunchable) {
        opt.disabled = true;
        const reasonText = _humanizeReason(b.unavailableReason);
        if (reasonText) {opt.title = reasonText;}
      }
      if (b.id === selectedId) {opt.selected = true;}
      this._select.appendChild(opt);
    }

    this._select.disabled = BUSY_PHASES.has(phase);
  }

  destroy() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    if (this._field?.parentNode) {
      this._field.parentNode.removeChild(this._field);
    }
  }
}

export function createBrowserSelector(containerEl, api) {
  if (!containerEl) {return null;}
  return new BrowserSelector(containerEl, api);
}