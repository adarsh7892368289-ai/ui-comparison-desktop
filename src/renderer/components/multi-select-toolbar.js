'use strict';

import { iconX } from '../utils/icons.js';

function _el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createMultiSelectToolbar(slotEl) {
  const toolbar = _el('div', 'multi-select-toolbar');
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Bulk actions');

  const count = _el('span', 'multi-select-toolbar__count', '0 selected');
  count.setAttribute('aria-live', 'polite');

  const actions = _el('div', 'multi-select-toolbar__actions');

  const selectAllBtn = _el('button', 'btn-ghost btn-sm', 'Select All');
  selectAllBtn.dataset.action = 'select-all';
  selectAllBtn.type = 'button';

  const deselectBtn = _el('button', 'btn-ghost btn-sm', 'Deselect');
  deselectBtn.dataset.action = 'deselect';
  deselectBtn.type = 'button';

  const deleteBtn = _el('button', 'btn-destructive btn-sm', 'Delete');
  deleteBtn.dataset.action = 'delete';
  deleteBtn.type = 'button';
  deleteBtn.setAttribute('aria-label', 'Delete 0 selected reports');

  actions.appendChild(selectAllBtn);
  actions.appendChild(deselectBtn);
  actions.appendChild(deleteBtn);

  const closeBtn = _el('button', 'multi-select-toolbar__close btn-ghost btn-sm');
  closeBtn.innerHTML = iconX(14);
  closeBtn.setAttribute('aria-label', 'Exit selection mode');
  closeBtn.type = 'button';

  toolbar.appendChild(count);
  toolbar.appendChild(actions);
  toolbar.appendChild(closeBtn);
  slotEl.appendChild(toolbar);

  function _dispatch(name, detail) {
    slotEl.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }));
  }

  selectAllBtn.addEventListener('click', () => _dispatch('multi-select-action', { action: 'select-all' }));
  deselectBtn.addEventListener('click', () => _dispatch('multi-select-action', { action: 'deselect' }));
  deleteBtn.addEventListener('click', () => _dispatch('multi-select-action', { action: 'delete' }));
  closeBtn.addEventListener('click', () => _dispatch('multi-select-action', { action: 'close' }));

  function render(state) {
    const ms = state.multiSelect;
    const size = ms.selectedIds.size;
    const visible = ms.active;

    toolbar.classList.toggle('multi-select-toolbar--visible', visible);
    count.textContent = `${size} selected`;

    deselectBtn.hidden = size === 0;
    deleteBtn.disabled = size === 0;
    deleteBtn.setAttribute('aria-label', `Delete ${size} selected report${size !== 1 ? 's' : ''}`);
  }

  function destroy() {
    slotEl.removeChild(toolbar);
  }

  return { render, destroy };
}
