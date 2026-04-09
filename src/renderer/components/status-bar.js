'use strict';

const STATUS_CLASSES = ['status--active', 'status--success', 'status--error'];

export class StatusBar {
  constructor() {
    this._left   = document.querySelector('#status-bar .status-left');
    this._center = document.querySelector('#status-bar .status-center');
    this._right  = document.querySelector('#status-bar .status-right');
    this._successTimer = null;

    if (this._right) {
      this._right.innerHTML =
        '<kbd>/</kbd> search &nbsp; <kbd>Ctrl+K</kbd> actions &nbsp; <kbd>E</kbd> extract &nbsp; <kbd>C</kbd> compare';
    }
  }

  _setStatusClass(cls) {
    if (!this._center) return;
    STATUS_CLASSES.forEach(c => this._center.classList.remove(c));
    if (cls) this._center.classList.add(cls);
  }

  _clearSuccessTimer() {
    if (this._successTimer) {
      clearTimeout(this._successTimer);
      this._successTimer = null;
    }
  }

  updateReportCount(reports) {
    if (!this._left) return;
    const count = reports?.length ?? 0;
    if (count === 0) {
      this._left.textContent = 'No reports';
      return;
    }
    const hosts = new Set(reports.map(r => {
      try { return new URL(r.url).hostname; } catch { return r.url; }
    }));
    this._left.textContent = `${count} report${count !== 1 ? 's' : ''} \u00b7 ${hosts.size} host${hosts.size !== 1 ? 's' : ''}`;
  }

  updatePhase(state) {
    if (!this._center) return;
    this._clearSuccessTimer();
    const { phase, progress, comparison } = state;

    switch (phase) {
      case 'idle':
        this._center.textContent = '';
        this._setStatusClass(null);
        break;
      case 'extracting':
        this._setStatusClass('status--active');
        this._center.textContent = `Scanning \u00b7 ${progress?.pct ?? 0}%`;
        if (progress?.label) {
          this._center.textContent = progress.label;
        }
        break;
      case 'comparing':
        this._setStatusClass('status--active');
        this._center.textContent = `Matching elements \u00b7 ${progress?.pct ?? 0}%`;
        if (progress?.label) {
          this._center.textContent = progress.label;
        }
        break;
      case 'done': {
        this._setStatusClass('status--success');
        const rate = comparison?.matching?.matchRate ?? '?';
        const total = comparison?.matching?.totalMatched ?? 0;
        this._center.textContent = `Comparison complete \u00b7 ${rate}% matched \u00b7 ${total} elements`;
        this._successTimer = setTimeout(() => {
          this._setStatusClass(null);
        }, 5000);
        break;
      }
      case 'error':
        this._setStatusClass('status--error');
        this._center.textContent = state.error ?? 'Operation failed';
        break;
      default:
        this._center.textContent = '';
        this._setStatusClass(null);
    }
  }
}

export function createStatusBar() {
  return new StatusBar();
}
