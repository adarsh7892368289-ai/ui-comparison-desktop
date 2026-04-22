const _cancelCleanups = new Map();

export function showProgress(id, label, opts = null) {
  const prev = _cancelCleanups.get(id);
  if (prev) { prev(); _cancelCleanups.delete(id); }
  const wrap = document.getElementById(`${id}-progress`);
  if (wrap) { wrap.classList.add('visible'); }
  updateProgress(id, 0, label);
  const btn = document.getElementById(`${id}-progress-cancel`);
  if (btn && opts?.onCancel) {
    btn.hidden = false;
    const h = () => { opts.onCancel(); };
    btn.addEventListener('click', h);
    _cancelCleanups.set(id, () => {
      btn.removeEventListener('click', h);
      btn.hidden = true;
    });
  } else if (btn) {
    btn.hidden = true;
  }
}

export function updateProgress(id, pct, label) {
  const bar  = document.getElementById(`${id}-progress-bar`);
  const lbl  = document.getElementById(`${id}-progress-label`);
  const wrap = document.getElementById(`${id}-progress`);
  if (bar)  { bar.style.width = `${pct}%`; }
  if (lbl && label) { lbl.textContent = label; }
  if (wrap) {
    wrap.setAttribute('aria-valuenow', pct);
    wrap.setAttribute('aria-valuetext', `${pct}% — ${label ?? ''}`);
  }
}

export function hideProgress(id) {
  const d = _cancelCleanups.get(id);
  if (d) { d(); _cancelCleanups.delete(id); }
  const wrap = document.getElementById(`${id}-progress`);
  if (wrap) { wrap.classList.remove('visible'); }
  const btn = document.getElementById(`${id}-progress-cancel`);
  if (btn) { btn.hidden = true; }
}