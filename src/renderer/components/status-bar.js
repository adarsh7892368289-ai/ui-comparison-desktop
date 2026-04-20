'use strict';

const STATUS_CLASSES = ['status--active', 'status--success', 'status--error'];

export class StatusBar {
  constructor() {
    this._left   = document.querySelector('#status-bar .status-left');
    this._center = document.querySelector('#status-bar .status-center');
    this._right  = document.querySelector('#status-bar .status-right');
    this._successTimer = null;

    if (this._right) {
      this._right.replaceChildren();
    }
  }

  _kbd(text) {
    const k = document.createElement('kbd');
    k.textContent = text;
    return k;
  }

  updateRightHint(state) {
    if (!this._right) { return; }
    this._right.replaceChildren();

    const phase = state?.phase ?? 'idle';

    if (phase === 'idle' || phase === 'extracting' || phase === 'done') {
      return;
    }

    const frag = document.createDocumentFragment();

    if (phase === 'comparing') {
      frag.appendChild(document.createTextNode('Comparing…'));
      this._right.appendChild(frag);
      return;
    }

    if (phase === 'error') {
      frag.appendChild(this._kbd('Enter'));
      frag.appendChild(document.createTextNode(' Dismiss'));
      this._right.appendChild(frag);
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

  updateReportCount(reports, filteredCount) {
    if (!this._left) return;
    const total = reports?.length ?? 0;
    const filtered = (filteredCount !== undefined && filteredCount !== null)
      ? filteredCount
      : total;

    if (total === 0) {
      this._left.textContent = 'No reports';
      return;
    }

    const hosts = new Set(
      reports.map(r => {
        try { return new URL(r.url).hostname; }
        catch { return r.url || 'unknown'; }
      })
    );

    const hostStr = `${hosts.size} host${hosts.size !== 1 ? 's' : ''}`;

    if (filtered < total) {
      this._left.textContent = `${filtered} of ${total} \u00b7 ${hostStr}`;
    } else {
      this._left.textContent = `${total} report${total !== 1 ? 's' : ''} \u00b7 ${hostStr}`;
    }
  }

  updatePhase(state) {
    this._clearSuccessTimer();
    const { phase, progress, comparison } = state;

    if (this._center) {
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

    this.updateRightHint(state);
  }
}

export function createStatusBar() {
  return new StatusBar();
}