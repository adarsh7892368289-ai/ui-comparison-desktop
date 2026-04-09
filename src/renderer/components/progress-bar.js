export function showProgress(id, label) {
  const wrap = document.getElementById(`${id}-progress`);
  if (wrap) { wrap.classList.add('visible'); }
  updateProgress(id, 0, label);
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
  const wrap = document.getElementById(`${id}-progress`);
  if (wrap) { wrap.classList.remove('visible'); }
}