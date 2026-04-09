import { sanitize } from '../utils/sanitize.js';
import { relativeTime } from '../utils/time.js';
import { handleExportReport } from '../application/export-workflow.js';
import { Modal } from './modal.js';

const HEADER_HEIGHT = 28;
const DENSITY_HEIGHTS = { compact: 44, default: 64, comfortable: 80 };
const OVERSCAN = 3;
const STAGE_RE = /\b(stage|staging|dev|test|qa|uat|preview|sandbox|canary)\b/i;

const DEFAULT_VIEW_CONFIG = {
  density: 'default',
  groupBy: null,
  sortBy: 'date',
  sortDir: 'desc',
};

function _el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function _hostFromUrl(url) {
  try { return new URL(url).hostname; } catch { return url || ''; }
}

function _lastPathSegment(url) {
  try {
    const seg = new URL(url).pathname.replace(/\/$/, '').split('/').filter(Boolean).pop();
    return seg ? `/${seg}` : '/';
  } catch { return ''; }
}

function _envTag(url) {
  if (!url) return null;
  return STAGE_RE.test(_hostFromUrl(url).toLowerCase()) ? 'STAGE' : 'PROD';
}

function _filterLabel(filters) {
  if (!filters) return null;
  return filters.class || filters.id || filters.tag || null;
}

export class ReportList {
  constructor(containerEl, callbacks) {
    this._container = containerEl;
    this._cb = callbacks || {};
    this._config = { ...DEFAULT_VIEW_CONFIG };
    this._reports = [];
    this._query = '';
    this._selectedId = null;
    this._baselineId = null;
    this._compareId = null;
    this._rowItems = [];
    this._offsets = [];
    this._totalHeight = 0;
    this._focusedLogicalIndex = -1;

    this._viewport = _el('div', 'vscroll-viewport');
    this._spacer = _el('div', 'vscroll-spacer');
    this._window = _el('div', 'vscroll-window');
    this._spacer.appendChild(this._window);
    this._viewport.appendChild(this._spacer);
    this._container.appendChild(this._viewport);

    this._onScroll = this._render.bind(this);
    this._viewport.addEventListener('scroll', this._onScroll, { passive: true });
    this._resizeObs = new ResizeObserver(() => this._render());
    this._resizeObs.observe(this._viewport);

    this._onKeydown = this._handleKeydown.bind(this);
    this._viewport.addEventListener('keydown', this._onKeydown);
  }

  setReports(reports, query) {
    this._reports = reports || [];
    this._query = query || '';
    this._buildRowItems();
    this._render();
  }

  setViewConfig(patch) {
    Object.assign(this._config, patch);
    this._updateDensityClass();
    this._buildRowItems();
    this._render();
  }

  setSelected(reportId) {
    this._selectedId = reportId || null;
    this._refreshStates();
  }

  setBaseline(reportId) {
    this._baselineId = reportId || null;
    this._refreshStates();
  }

  setCompare(reportId) {
    this._compareId = reportId || null;
    this._refreshStates();
  }

  destroy() {
    this._viewport.removeEventListener('scroll', this._onScroll);
    this._viewport.removeEventListener('keydown', this._onKeydown);
    this._resizeObs.disconnect();
  }

  _updateDensityClass() {
    const panel = document.getElementById('left-panel');
    if (!panel) return;
    panel.classList.remove('density-compact', 'density-comfortable');
    if (this._config.density === 'compact') panel.classList.add('density-compact');
    if (this._config.density === 'comfortable') panel.classList.add('density-comfortable');
  }

  _cardHeight() {
    return DENSITY_HEIGHTS[this._config.density] ?? DENSITY_HEIGHTS.default;
  }

  _buildRowItems() {
    const { groupBy, sortBy, sortDir } = this._config;
    const q = this._query.toLowerCase().trim();
    const dir = sortDir === 'asc' ? 1 : -1;

    let filtered = q
      ? this._reports.filter(r =>
          (_hostFromUrl(r.url)).toLowerCase().includes(q) ||
          (r.url || '').toLowerCase().includes(q) ||
          (r.environment || '').toLowerCase().includes(q) ||
          (r.name || '').toLowerCase().includes(q))
      : [...this._reports];

    filtered.sort((a, b) => {
      let va, vb;
      if (sortBy === 'elements') {
        va = a.totalElements ?? 0; vb = b.totalElements ?? 0;
        return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
      }
      if (sortBy === 'name') {
        va = (a.name ?? _hostFromUrl(a.url)).toLowerCase();
        vb = (b.name ?? _hostFromUrl(b.url)).toLowerCase();
        return va < vb ? -dir : va > vb ? dir : 0;
      }
      va = a.timestamp ?? ''; vb = b.timestamp ?? '';
      return va < vb ? -dir : va > vb ? dir : 0;
    });

    if (!groupBy) {
      const total = filtered.length;
      this._rowItems = filtered.map((r, i) => ({
        type: 'report', report: r, displayIndex: total - i,
      }));
    } else {
      const groups = new Map();
      for (const r of filtered) {
        const key = this._groupKey(r, groupBy);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      this._rowItems = [];
      let idx = filtered.length;
      for (const [label, items] of groups) {
        this._rowItems.push({ type: 'header', label });
        for (const r of items) {
          this._rowItems.push({ type: 'report', report: r, displayIndex: idx-- });
        }
      }
    }

    this._buildLayout();
  }

  _groupKey(report, groupBy) {
    if (groupBy === 'host') {
      return _hostFromUrl(report.url) || 'Unknown';
    }
    if (groupBy === 'date') {
      return report.timestamp ? report.timestamp.slice(0, 10) : 'Unknown';
    }
    if (groupBy === 'environment') {
      return report.environment ?? _envTag(report.url) ?? 'Unknown';
    }
    return 'Unknown';
  }

  _buildLayout() {
    const cardH = this._cardHeight();
    const offsets = [];
    let total = 0;
    for (const item of this._rowItems) {
      offsets.push(total);
      total += item.type === 'header' ? HEADER_HEIGHT : cardH;
    }
    this._offsets = offsets;
    this._totalHeight = total;
    this._spacer.style.height = total + 'px';
  }

  _render() {
    const scrollTop = this._viewport.scrollTop;
    const viewH = this._viewport.clientHeight || 400;
    const cardH = this._cardHeight();
    const n = this._rowItems.length;

    if (n === 0) {
      this._window.textContent = '';
      this._window.style.top = '0px';
      return;
    }

    const overscanPx = OVERSCAN * cardH;
    const renderTop = Math.max(0, scrollTop - overscanPx);
    const renderBottom = scrollTop + viewH + overscanPx;

    let startIdx = 0;
    for (let i = 0; i < n; i++) {
      const rowH = this._rowItems[i].type === 'header' ? HEADER_HEIGHT : cardH;
      if (this._offsets[i] + rowH > renderTop) { startIdx = i; break; }
    }

    let endIdx = n;
    for (let i = startIdx; i < n; i++) {
      if (this._offsets[i] >= renderBottom) { endIdx = i; break; }
    }

    this._window.style.top = this._offsets[startIdx] + 'px';

    const showEnvBadge = this._reports.some(r =>
      STAGE_RE.test(_hostFromUrl(r.url).toLowerCase()));

    const frag = document.createDocumentFragment();
    for (let i = startIdx; i < endIdx; i++) {
      const item = this._rowItems[i];
      frag.appendChild(item.type === 'header'
        ? this._renderHeader(item.label)
        : this._renderCard(item.report, item.displayIndex, showEnvBadge));
    }

    this._window.textContent = '';
    this._window.appendChild(frag);
    this._refreshStates();
  }

  _renderHeader(label) {
    const header = _el('div', 'report-group-header', label);
    header.setAttribute('role', 'presentation');
    return header;
  }

  _renderCard(report, displayIndex, showEnvBadge) {
    const host = _hostFromUrl(report.url);
    const path = _lastPathSegment(report.url);
    const env = _envTag(report.url);
    const isBaseline = report.id === this._baselineId;
    const isCompare = report.id === this._compareId;

    const card = _el('div', 'report-card');
    card.dataset.reportId = report.id;
    card.setAttribute('role', 'listitem');
    card.setAttribute('tabindex', '0');

    const roleLabel = isBaseline ? ' (Baseline)' : isCompare ? ' (Compare)' : '';
    card.setAttribute('aria-label', `Report ${displayIndex}: ${host}${path}, ${report.totalElements ?? 0} elements${roleLabel}`);

    if (isBaseline) {
      const badge = _el('span', 'report-role-badge report-role-badge--baseline', 'B');
      badge.title = 'Baseline report';
      card.appendChild(badge);
    } else if (isCompare) {
      const badge = _el('span', 'report-role-badge report-role-badge--compare', 'C');
      badge.title = 'Compare report';
      card.appendChild(badge);
    }

    const body = _el('div', 'report-card-body');
    body.style.cursor = 'pointer';

    const headerRow = _el('div', 'report-card-header');
    headerRow.appendChild(_el('span', 'report-index', `R${displayIndex}`));
    if (showEnvBadge && env) {
      headerRow.appendChild(
        _el('span', `env-badge env-badge--${env.toLowerCase()}`, env));
    }
    const hostSpan = _el('span', 'meta-host', host);
    hostSpan.title = report.url;
    headerRow.appendChild(hostSpan);
    body.appendChild(headerRow);

    const meta = _el('div', 'report-card-meta');
    meta.appendChild(_el('span', '', `${report.totalElements ?? 0} el`));
    meta.appendChild(_el('span', 'meta-sep', '·'));
    meta.appendChild(_el('span', 'meta-path', path));

    const filter = _filterLabel(report.filters);
    if (filter) {
      meta.appendChild(_el('span', 'meta-sep', '·'));
      const fs = _el('span', 'meta-filter', filter);
      fs.title = 'Extraction filter';
      meta.appendChild(fs);
    }

    meta.appendChild(_el('span', 'meta-sep', '·'));
    meta.appendChild(_el('span', '', relativeTime(report.timestamp)));

    if (report.source === 'imported') {
      meta.appendChild(_el('span', 'meta-sep', '·'));
      const ib = _el('span', 'meta-imported-badge', '↑ imported');
      ib.title = 'Uploaded from file';
      meta.appendChild(ib);
    }

    body.appendChild(meta);
    body.addEventListener('click', () => this._cb.onSelect?.(report));
    card.appendChild(body);

    const actions = _el('div', 'report-card-actions');

    const baselineBtn = _el('button', 'btn-ghost btn-sm');
    baselineBtn.title = 'Set as baseline';
    baselineBtn.setAttribute('aria-label', 'Set as baseline');
    baselineBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M3 12h6M15 12h6"/></svg>`;
    baselineBtn.addEventListener('click', e => { e.stopPropagation(); this._cb.onBaseline?.(report); });
    actions.appendChild(baselineBtn);

    const compareBtn = _el('button', 'btn-ghost btn-sm');
    compareBtn.title = 'Set as compare';
    compareBtn.setAttribute('aria-label', 'Set as compare');
    compareBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" aria-hidden="true"><path d="M8 6l4-4 4 4M16 18l-4 4-4-4M12 2v20"/></svg>`;
    compareBtn.addEventListener('click', e => { e.stopPropagation(); this._cb.onCompare?.(report); });
    actions.appendChild(compareBtn);

    const details = document.createElement('details');
    details.className = 'export-dropdown';
    const summary = _el('summary', 'btn-ghost btn-sm', 'Export ▾');
    summary.title = 'Export options';
    details.appendChild(summary);
    const menu = _el('div', 'export-menu');
    menu.setAttribute('role', 'menu');
    for (const [fmt, lbl] of [['excel', 'Excel'], ['json', 'JSON'], ['csv', 'CSV']]) {
      const btn = _el('button', 'export-menu-item', lbl);
      btn.setAttribute('role', 'menuitem');
      btn.addEventListener('click', () => {
        details.removeAttribute('open');
        handleExportReport(report, fmt);
      });
      menu.appendChild(btn);
    }
    details.appendChild(menu);
    actions.appendChild(details);

    const deleteBtn = _el('button', 'btn-icon-danger');
    deleteBtn.title = 'Delete report';
    deleteBtn.setAttribute('aria-label', `Delete report from ${sanitize(host)}`);
    deleteBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;
    deleteBtn.addEventListener('click', e => { e.stopPropagation(); this._cb.onDelete?.(report); });
    actions.appendChild(deleteBtn);

    card.appendChild(actions);
    return card;
  }

  _reportRowIndices() {
    const indices = [];
    for (let i = 0; i < this._rowItems.length; i++) {
      if (this._rowItems[i].type === 'report') indices.push(i);
    }
    return indices;
  }

  _focusCardByLogicalIndex(logicalIdx) {
    if (logicalIdx < 0 || logicalIdx >= this._rowItems.length) return;
    this._focusedLogicalIndex = logicalIdx;
    const offset = this._offsets[logicalIdx];
    const cardH = this._cardHeight();
    const viewH = this._viewport.clientHeight || 400;
    if (offset < this._viewport.scrollTop || offset + cardH > this._viewport.scrollTop + viewH) {
      this._viewport.scrollTop = Math.max(0, offset - cardH);
      this._render();
    }
    const item = this._rowItems[logicalIdx];
    if (item?.type !== 'report') return;
    requestAnimationFrame(() => {
      const card = this._window.querySelector(`.report-card[data-report-id="${item.report.id}"]`);
      card?.focus();
    });
  }

  _handleKeydown(e) {
    const reportIndices = this._reportRowIndices();
    if (reportIndices.length === 0) return;

    const focused = document.activeElement;
    const focusedId = focused?.dataset?.reportId;
    if (focusedId) {
      const logIdx = this._rowItems.findIndex(
        item => item.type === 'report' && item.report.id === focusedId
      );
      if (logIdx >= 0) this._focusedLogicalIndex = logIdx;
    }

    const currentPos = reportIndices.indexOf(this._focusedLogicalIndex);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextPos = currentPos < reportIndices.length - 1 ? currentPos + 1 : 0;
      this._focusCardByLogicalIndex(reportIndices[nextPos]);
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prevPos = currentPos > 0 ? currentPos - 1 : reportIndices.length - 1;
      this._focusCardByLogicalIndex(reportIndices[prevPos]);
      return;
    }

    if (e.key === 'Enter' && focusedId) {
      e.preventDefault();
      const report = this._reports.find(r => r.id === focusedId);
      if (report) this._cb.onSelect?.(report);
      return;
    }

    if (e.key === 'Delete' && focusedId) {
      e.preventDefault();
      const report = this._reports.find(r => r.id === focusedId);
      if (!report) return;
      Modal.confirm('Delete report', 'This cannot be undone.', { confirmText: 'Delete', destructive: true })
        .then(confirmed => { if (confirmed) this._cb.onDelete?.(report); });
    }
  }

  _refreshStates() {
    this._window.querySelectorAll('.report-card').forEach(card => {
      const id = card.dataset.reportId;
      card.classList.toggle('report-card--selected', id === this._selectedId);
      card.classList.toggle('report-card--baseline', id === this._baselineId);
      card.classList.toggle('report-card--compare', id === this._compareId);

      const existing = card.querySelector('.report-role-badge');
      const needsBaseline = id === this._baselineId;
      const needsCompare = id === this._compareId;

      if (needsBaseline && (!existing || !existing.classList.contains('report-role-badge--baseline'))) {
        existing?.remove();
        const badge = _el('span', 'report-role-badge report-role-badge--baseline', 'B');
        badge.title = 'Baseline report';
        card.insertBefore(badge, card.firstChild);
      } else if (needsCompare && (!existing || !existing.classList.contains('report-role-badge--compare'))) {
        existing?.remove();
        const badge = _el('span', 'report-role-badge report-role-badge--compare', 'C');
        badge.title = 'Compare report';
        card.insertBefore(badge, card.firstChild);
      } else if (!needsBaseline && !needsCompare && existing) {
        existing.remove();
      }
    });
  }
}

export function createReportList(containerEl, callbacks) {
  return new ReportList(containerEl, callbacks);
}