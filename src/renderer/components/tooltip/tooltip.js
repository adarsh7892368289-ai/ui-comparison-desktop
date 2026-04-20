'use strict';

export function attachTooltip(triggerEl, getText) {
  if (!triggerEl || typeof getText !== 'function') {
    return () => {};
  }
  let showTimer = null;
  let tip = null;
  const removeTip = () => {
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    if (tip) {
      tip.remove();
      tip = null;
    }
  };
  const placeTip = () => {
    if (!tip) return;
    const rect = triggerEl.getBoundingClientRect();
    const margin = varSpace();
    tip.style.left = '0px';
    tip.style.top = '0px';
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = rect.left + rect.width / 2 - tw / 2;
    const maxL = window.innerWidth - tw - margin;
    left = Math.max(margin, Math.min(left, maxL));
    let top = rect.bottom + margin;
    if (top + th > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - th - margin);
    }
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };
  function varSpace() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--space-2').trim();
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : 8;
  }
  const onEnter = () => {
    removeTip();
    showTimer = setTimeout(() => {
      showTimer = null;
      const text = getText();
      if (!text) return;
      tip = document.createElement('div');
      tip.className = 'app-tooltip';
      tip.setAttribute('role', 'tooltip');
      tip.textContent = text;
      document.body.appendChild(tip);
      placeTip();
    }, 400);
  };
  const onLeave = () => {
    removeTip();
  };
  const onDown = () => {
    removeTip();
  };
  triggerEl.addEventListener('mouseenter', onEnter);
  triggerEl.addEventListener('mouseleave', onLeave);
  triggerEl.addEventListener('pointerdown', onDown);
  window.addEventListener('scroll', placeTip, true);
  window.addEventListener('resize', placeTip);
  return () => {
    window.removeEventListener('scroll', placeTip, true);
    window.removeEventListener('resize', placeTip);
    triggerEl.removeEventListener('mouseenter', onEnter);
    triggerEl.removeEventListener('mouseleave', onLeave);
    triggerEl.removeEventListener('pointerdown', onDown);
    removeTip();
  };
}
