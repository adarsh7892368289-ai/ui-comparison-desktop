'use strict';

export { Toast } from './components/toast.js';
export { Modal } from './components/modal.js';
export { showProgress, updateProgress, hideProgress } from './components/progress-bar.js';

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

export { setError, syncCompareButton };