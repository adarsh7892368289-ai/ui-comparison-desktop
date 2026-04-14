'use strict';

const CHEVRON_SVG =
  '<svg class="report-select__chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

function closeDropdown(root) {
  const trigger = root.querySelector('.report-select__trigger');
  const dd = root.querySelector('.report-select__dropdown');
  if (!trigger || !dd) { return; }
  root.classList.remove('report-select--open');
  dd.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
}

function closeOthers(exceptRoot) {
  document.querySelectorAll('.report-select.report-select--open').forEach((r) => {
    if (r !== exceptRoot) { closeDropdown(r); }
  });
}

function openDropdown(root) {
  closeOthers(root);
  const trigger = root.querySelector('.report-select__trigger');
  const dd = root.querySelector('.report-select__dropdown');
  if (!trigger || !dd) { return; }
  root.classList.add('report-select--open');
  dd.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  const toFocus =
    dd.querySelector('[role="option"][aria-selected="true"]') ||
    dd.querySelector('[role="option"]');
  toFocus?.focus();
}

function syncTriggerLabel(selectEl) {
  const root = selectEl.closest('.report-select');
  if (!root) { return; }
  const valueEl = root.querySelector('.report-select__value');
  const opt = selectEl.selectedOptions[0];
  if (!valueEl) { return; }
  valueEl.textContent = opt ? opt.textContent : 'Select report…';
}

function hostHint(url) {
  if (!url) { return ''; }
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function refreshReportSelectPanel(selectEl) {
  const root = selectEl.closest('.report-select');
  if (!root) { return; }
  const listbox = root.querySelector('[role="listbox"]');
  if (!listbox) { return; }
  const trigger = root.querySelector('.report-select__trigger');
  listbox.replaceChildren();
  const selected = selectEl.value;

  for (let i = 0; i < selectEl.options.length; i++) {
    const opt = selectEl.options[i];
    if (!opt.value) { continue; }

    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', opt.value === selected ? 'true' : 'false');
    li.tabIndex = -1;
    li.dataset.value = opt.value;
    li.className = 'report-select__option';

    const title = document.createElement('span');
    title.className = 'report-select__option-title';
    title.textContent = opt.textContent;
    li.appendChild(title);

    const meta = document.createElement('span');
    meta.className = 'report-select__option-meta';
    const url = opt.dataset.reportUrl || '';
    const els = opt.dataset.reportElements ?? '';
    const time = opt.dataset.reportTime ?? '';
    const h = hostHint(url);
    const parts = [];
    if (h) { parts.push(h.length <= 56 ? h : `${h.slice(0, 53)}…`); }
    if (els) { parts.push(`${els} el`); }
    if (time) { parts.push(time); }
    meta.textContent = parts.join(' · ');
    li.appendChild(meta);

    li.title = opt.title || url;

    li.addEventListener('click', () => {
      selectEl.value = opt.value;
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
      refreshReportSelectPanel(selectEl);
      syncTriggerLabel(selectEl);
      closeDropdown(root);
      trigger?.focus();
    });

    listbox.appendChild(li);
  }
  syncTriggerLabel(selectEl);
}

export function syncReportSelectTrigger(selectEl) {
  syncTriggerLabel(selectEl);
  const root = selectEl.closest('.report-select');
  if (root) { refreshReportSelectPanel(selectEl); }
}

export function wireReportSelect(selectEl) {
  const root = selectEl.closest('.report-select');
  if (!root || root.dataset.reportSelectWired === '1') { return; }
  root.dataset.reportSelectWired = '1';

  const trigger = root.querySelector('.report-select__trigger');
  const dd = root.querySelector('.report-select__dropdown');
  if (!trigger || !dd) { return; }

  if (!trigger.querySelector('.report-select__chevron')) {
    trigger.insertAdjacentHTML('beforeend', CHEVRON_SVG);
  }

  trigger.addEventListener('click', () => {
    if (dd.hidden) {
      refreshReportSelectPanel(selectEl);
      openDropdown(root);
    } else {
      closeDropdown(root);
    }
  });

  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (dd.hidden) {
        refreshReportSelectPanel(selectEl);
        openDropdown(root);
      }
    }
    if (e.key === 'Escape' && !dd.hidden) {
      e.preventDefault();
      closeDropdown(root);
      trigger.focus();
    }
  });

  dd.addEventListener('keydown', (e) => {
    const options = [...dd.querySelectorAll('[role="option"]')];
    const cur = document.activeElement;
    const idx = options.indexOf(cur);

    if (e.key === 'Escape') {
      e.preventDefault();
      closeDropdown(root);
      trigger.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = options[Math.min(idx + 1, options.length - 1)] ?? options[0];
      next?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = options[Math.max(idx - 1, 0)] ?? options[options.length - 1];
      next?.focus();
    } else if ((e.key === 'Enter' || e.key === ' ') && cur?.dataset?.value) {
      e.preventDefault();
      selectEl.value = cur.dataset.value;
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
      refreshReportSelectPanel(selectEl);
      syncTriggerLabel(selectEl);
      closeDropdown(root);
      trigger.focus();
    }
  });

  document.addEventListener('click', (e) => {
    if (!root.contains(e.target)) { closeDropdown(root); }
  });

  syncTriggerLabel(selectEl);
}
