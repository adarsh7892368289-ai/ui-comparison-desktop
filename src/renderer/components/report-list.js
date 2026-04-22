import { sanitize } from '../utils/sanitize.js';
import { STAGE_RE, hostFromUrl, lastPathSegment, envTag } from '../utils/report-metadata.js';
import { relativeTime, absoluteCalendarDate } from '../utils/time.js';
import { iconArrowUp, iconArrowUpDown, iconFileDown, iconTarget, iconTrash2 } from '../utils/icons.js';
import { SINGLE_EXTRACTED_REPORT_EXPORT_MENU } from '@core/export/extraction-exporters/extracted-report-export-catalog.js';
import { handleExportReport } from '../application/export-workflow.js';
import { Modal } from './modal.js';

const HEADER_HEIGHT = 28;
const DENSITY_HEIGHTS = { compact: 52, default: 64, comfortable: 80 };
const OVERSCAN = 3;

const DATE_GROUP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DEFAULT_VIEW_CONFIG = {
  density: 'default',
  groupBy: null,
  sortField: 'date',
  sortDirection: 'desc',
};

function _el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function _filterChipPairs(filters) {
  if (!filters || typeof filters !== 'object') return [];
  const out = [];
  if (filters.class) out.push(['class', filters.class]);
  if (filters.id) out.push(['id', filters.id]);
  if (filters.tag) out.push(['tag', filters.tag]);
  return out;
}

export class ReportList {
  constructor(containerEl, callbacks) {
    this._container = containerEl;
    this._cb = callbacks || {};
    this._config = { ...DEFAULT_VIEW_CONFIG };
    this._reports = [];
    this._query = '';
    this._baselineId = null;
    this._compareId = null;
    this._rowItems = [];
    this._offsets = [];
    this._totalHeight = 0;
    this._focusedLogicalIndex = -1;
    this._lastKnownHeight = 0;

    this._viewport = _el('div', 'vscroll-viewport');
    this._spacer = _el('div', 'vscroll-spacer');
    this._window = _el('div', 'vscroll-window');
    this._window.setAttribute('role', 'list');
    this._spacer.appendChild(this._window);
    this._viewport.appendChild(this._spacer);
    this._container.prepend(this._viewport);

    this._onScroll = this._render.bind(this);
    this._viewport.addEventListener('scroll', this._onScroll, { passive: true });
    this._resizeObs = new ResizeObserver(() => {
      const h = this._viewport.clientHeight;
      if (h > 0) { this._lastKnownHeight = h; }
      this._render();
    });
    this._resizeObs.observe(this._viewport);

    this._onKeydown = this._handleKeydown.bind(this);
    this._viewport.addEventListener('keydown', this._onKeydown);
  }

  setReports(reports, query) {
    this._reports = reports || [];
    this._query = query || '';
    this._buildRowItems();
    const firstReportIdx = this._rowItems.findIndex(x => x.type === 'report');
    this._focusedLogicalIndex = firstReportIdx >= 0 ? firstReportIdx : -1;
    this._render();
  }

  getViewConfig() {
    return { ...this._config };
  }

  setViewConfig(patch) {
    const prevScroll = this._viewport.scrollTop;
    const prevOffsets = this._offsets.length ? this._offsets.slice() : [];
    const prevDensity = this._config.density;
    const prevRowCount = this._rowItems.length;
    const prevCardH = this._cardHeight();

    Object.assign(this._config, patch);
    this._updateDensityClass();
    this._buildRowItems();

    if (
      patch.density !== undefined &&
      patch.density !== prevDensity &&
      prevOffsets.length > 0 &&
      prevOffsets.length === this._offsets.length &&
      prevRowCount === this._rowItems.length
    ) {
      let anchor = 0;
      let frac = 0;
      for (let i = 0; i < prevOffsets.length; i++) {
        const rowH = this._rowItems[i].type === 'header' ? HEADER_HEIGHT : prevCardH;
        const top = prevOffsets[i];
        const bot = top + rowH;
        if (bot > prevScroll) {
          anchor = i;
          const denom = Math.max(1, rowH);
          frac = Math.max(0, Math.min(1, (prevScroll - top) / denom));
          break;
        }
        anchor = i;
        frac = 1;
      }
      const newRowH = this._rowItems[anchor].type === 'header' ? HEADER_HEIGHT : this._cardHeight();
      const viewH = this._viewportCssHeight();
      const maxScroll = Math.max(0, this._totalHeight - viewH);
      const nextScroll = this._offsets[anchor] + frac * newRowH;
      this._viewport.scrollTop = Math.min(Math.max(0, nextScroll), maxScroll);
    }

    this._clampFocusedLogicalIndex();
    this._render();
  }

  _clampFocusedLogicalIndex() {
    const reportIdxs = this._reportRowIndices();
    if (reportIdxs.length === 0) {
      this._focusedLogicalIndex = -1;
      return;
    }
    if (!reportIdxs.includes(this._focusedLogicalIndex)) {
      this._focusedLogicalIndex = reportIdxs[0];
    }
  }

  setSelected() {
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
    const { groupBy, sortField, sortDirection } = this._config;
    const q = this._query.toLowerCase().trim();
    const dir = sortDirection === 'asc' ? 1 : -1;

    let filtered = q
      ? this._reports.filter(r => {
        const qLower = q;
        return (
          (hostFromUrl(r.url) || '').toLowerCase().includes(qLower) ||
          (r.url || '').toLowerCase().includes(qLower) ||
          (lastPathSegment(r.url) || '').toLowerCase().includes(qLower) ||
          (r.environment || '').toLowerCase().includes(qLower) ||
          (r.name || '').toLowerCase().includes(qLower)
        );
      })
      : [...this._reports];

    filtered.sort((a, b) => {
      let va, vb;
      if (sortField === 'elements') {
        va = a.totalElements ?? 0; vb = b.totalElements ?? 0;
        return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
      }
      if (sortField === 'name') {
        va = (a.name ?? hostFromUrl(a.url)).toLowerCase();
        vb = (b.name ?? hostFromUrl(b.url)).toLowerCase();
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
      return hostFromUrl(report.url) || 'Unknown';
    }
    if (groupBy === 'date') {
      if (!report.timestamp) return 'Unknown date';

      const d = new Date(report.timestamp);
      if (Number.isNaN(d.getTime())) return 'Unknown date';

      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);

      const toDateStr = (dt) => dt.toDateString();

      if (toDateStr(d) === toDateStr(today)) return 'Today';
      if (toDateStr(d) === toDateStr(yesterday)) return 'Yesterday';

      const thisYear = today.getFullYear();
      const dateStr = `${DATE_GROUP_MONTHS[d.getMonth()]} ${d.getDate()}`;
      return d.getFullYear() === thisYear ? dateStr : `${dateStr}, ${d.getFullYear()}`;
    }
    if (groupBy === 'environment') {
      return report.environment ?? envTag(report.url) ?? 'Unknown';
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

  _viewportCssHeight() {
    const ch = this._viewport.clientHeight;
    if (ch > 0) { return ch; }
    return Math.max(this._lastKnownHeight || 0, Math.floor(window.innerHeight * 0.6));
  }

  _render() {
    const scrollTop = this._viewport.scrollTop;
    const viewH = this._viewportCssHeight();
    const cardH = this._cardHeight();
    const n = this._rowItems.length;

    if (n === 0) {
      this._window.textContent = '';
      this._window.style.top = '0px';
      this._viewport.tabIndex = -1;
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
      STAGE_RE.test(hostFromUrl(r.url).toLowerCase()));

    const focusedRow = this._focusedLogicalIndex;
    const focusedIsReport = focusedRow >= 0 && this._rowItems[focusedRow]?.type === 'report';
    const focusedInWindow = focusedIsReport && focusedRow >= startIdx && focusedRow < endIdx;
    this._viewport.tabIndex = focusedIsReport && !focusedInWindow ? 0 : -1;

    const frag = document.createDocumentFragment();
    for (let i = startIdx; i < endIdx; i++) {
      const item = this._rowItems[i];
      frag.appendChild(item.type === 'header'
        ? this._renderHeader(item.label)
        : this._renderCard(item.report, item.displayIndex, showEnvBadge, i, focusedInWindow && i === focusedRow));
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

  _totalReportRows() {
    return this._rowItems.filter(x => x.type === 'report').length;
  }

  _ariaPosInSetForRow(rowIndex) {
    let c = 0;
    for (let j = 0; j <= rowIndex; j++) {
      if (this._rowItems[j]?.type === 'report') { c++; }
    }
    return c;
  }

  _appendEnvBadge(headerRow, showEnvBadge, env, report) {
    if (!showEnvBadge || !env) return;
    const badge = _el('span', `env-badge env-badge--${env.toLowerCase()}`, env);
    const envTitle = report.environment?.trim()
      ? report.environment.trim()
      : env === 'STAGE'
        ? 'Staging environment'
        : 'Production environment';
    badge.title = envTitle;
    headerRow.appendChild(badge);
  }

  _renderCard(report, displayIndex, showEnvBadge, rowIndex, isRovingFocused) {
    const host = hostFromUrl(report.url);
    const path = lastPathSegment(report.url);
    const env = envTag(report.url);
    const isBaseline = report.id === this._baselineId;
    const isCompare = report.id === this._compareId;
    const density = this._config.density;

    const card = _el('div', 'report-card');
    card.dataset.reportId = report.id;
    card.setAttribute('role', 'listitem');
    card.setAttribute('tabindex', isRovingFocused ? '0' : '-1');
    const setSize = this._totalReportRows();
    const pos = this._ariaPosInSetForRow(rowIndex);
    card.setAttribute('aria-setsize', String(setSize));
    card.setAttribute('aria-posinset', String(pos));

    const roleLabel = isBaseline ? ' (Baseline)' : isCompare ? ' (Compare)' : '';
    card.setAttribute('aria-label', `Report ${displayIndex}: ${host}${path}, ${report.totalElements ?? 0} elements${roleLabel}`);
    card.title = 'B: set baseline · C: set compare';

    card.addEventListener('contextmenu', (e) => {
      if (!window.electronAPI?.showContextMenu) { return; }
      e.preventDefault();
      window.electronAPI.showContextMenu({
        reportId: report.id,
        isBaseline,
      });
    });

    const body = _el('div', 'report-card-body');
    body.style.cursor = 'pointer';
    body.title = report.url || '';

    if (density === 'compact') {
      const row = _el('div', 'report-card-line report-card-line--compact');
      const indexSpan = _el('span', 'report-card-index report-card-index--lead', `R${displayIndex}`);
      indexSpan.title = report.url || '';
      row.appendChild(indexSpan);
      this._appendEnvBadge(row, showEnvBadge, env, report);
      const hostSpan = _el('span', 'report-card-host report-card-host--secondary', host);
      hostSpan.title = report.url || '';
      row.appendChild(hostSpan);
      body.appendChild(row);
    } else {
      const line1 = _el('div', 'report-card-line report-card-line--primary');
      line1.title = report.url || '';
      const indexSpan = _el('span', 'report-card-index report-card-index--lead', `R${displayIndex}`);
      indexSpan.title = report.url || '';
      line1.appendChild(indexSpan);
      this._appendEnvBadge(line1, showEnvBadge, env, report);
      const hostSpan = _el('span', 'report-card-host', host);
      hostSpan.title = report.url || '';
      line1.appendChild(hostSpan);
      body.appendChild(line1);

      const line2 = _el('div', 'report-card-line report-card-line--meta');
      line2.title = report.url || '';
      const pathSpan = _el('span', 'meta-path', path);
      pathSpan.title = report.url || '';
      line2.appendChild(pathSpan);
      line2.appendChild(_el('span', 'meta-sep', '·'));
      if (density === 'comfortable') {
        line2.appendChild(_el('span', '', `${report.totalElements ?? 0} elements`));
      } else {
        line2.appendChild(_el('span', '', `${report.totalElements ?? 0} el`));
      }
      const dateStr = density === 'comfortable'
        ? absoluteCalendarDate(report.timestamp)
        : relativeTime(report.timestamp);
      if (dateStr) {
        line2.appendChild(_el('span', 'meta-sep', '·'));
        line2.appendChild(_el('span', 'report-card-timestamp', dateStr));
      }
      if (report.source === 'imported' && density === 'default') {
        line2.appendChild(_el('span', 'meta-sep', '·'));
        const ib = _el('span', 'meta-imported-badge');
        ib.innerHTML = `${iconArrowUp(12)}<span>imported</span>`;
        ib.title = 'Uploaded from file';
        line2.appendChild(ib);
      }
      if (report.source === 'imported' && density === 'comfortable') {
        line2.appendChild(_el('span', 'meta-sep', '·'));
        const ib = _el('span', 'report-card-chip report-card-chip--imported');
        ib.innerHTML = `${iconArrowUp(12)}<span>Imported</span>`;
        ib.title = 'Uploaded from file';
        line2.appendChild(ib);
      }
      body.appendChild(line2);

      if (density === 'comfortable') {
        const pairs = _filterChipPairs(report.filters);
        if (pairs.length > 0) {
          const line3 = _el('div', 'report-card-line report-card-line--chips');
          for (const [k, v] of pairs) {
            const chip = _el('span', 'report-card-chip', `${k}: ${v}`);
            chip.title = 'Extraction filter';
            line3.appendChild(chip);
          }
          body.appendChild(line3);
        }
      }
    }

    body.addEventListener('click', () => this._cb.onSelect?.(report));
    card.appendChild(body);

    const actions = _el('div', 'report-card-actions');

    const baselineBtn = _el('button', 'btn-ghost btn-sm');
    baselineBtn.title = 'Set as baseline';
    baselineBtn.setAttribute('aria-label', 'Set as baseline');
    baselineBtn.innerHTML = iconTarget(16);
    baselineBtn.addEventListener('click', e => { e.stopPropagation(); this._cb.onBaseline?.(report); });
    actions.appendChild(baselineBtn);

    const compareBtn = _el('button', 'btn-ghost btn-sm');
    compareBtn.title = 'Set as compare';
    compareBtn.setAttribute('aria-label', 'Set as compare');
    compareBtn.innerHTML = iconArrowUpDown(16);
    compareBtn.addEventListener('click', e => { e.stopPropagation(); this._cb.onCompare?.(report); });
    actions.appendChild(compareBtn);

    const details = document.createElement('details');
    details.className = 'export-dropdown';
    const summary = _el('summary', 'btn-ghost btn-sm');
    summary.innerHTML = iconFileDown(14);
    summary.title = 'Export options';
    summary.setAttribute('aria-label', 'Export report options');
    summary.addEventListener('click', e => { e.stopPropagation(); });
    details.appendChild(summary);
    const menu = _el('div', 'export-menu');
    menu.setAttribute('role', 'menu');
    for (const { format, label } of SINGLE_EXTRACTED_REPORT_EXPORT_MENU) {
      const btn = _el('button', 'export-menu-item', label);
      btn.setAttribute('role', 'menuitem');
      btn.type = 'button';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        details.removeAttribute('open');
        handleExportReport(report, format);
      });
      menu.appendChild(btn);
    }
    details.appendChild(menu);
    actions.appendChild(details);

    const deleteBtn = _el('button', 'btn-icon-danger');
    deleteBtn.dataset.action = 'delete';
    deleteBtn.title = 'Delete report';
    deleteBtn.setAttribute('aria-label', `Delete report from ${sanitize(host)}`);
    deleteBtn.innerHTML = iconTrash2(16);
    deleteBtn.addEventListener('click', e => { e.stopPropagation(); this._cb.onDelete?.(report); });
    actions.appendChild(deleteBtn);

    card.appendChild(actions);

    const badge = _el('span', 'report-role-badge');
    if (isBaseline) {
      badge.classList.add('report-role-badge--baseline', 'report-role-badge--visible');
      badge.textContent = 'B';
      badge.title = 'Baseline report';
    } else if (isCompare) {
      badge.classList.add('report-role-badge--compare', 'report-role-badge--visible');
      badge.textContent = 'C';
      badge.title = 'Compare report';
    }
    card.appendChild(badge);

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
    const viewH = this._viewportCssHeight();
    if (offset < this._viewport.scrollTop || offset + cardH > this._viewport.scrollTop + viewH) {
      this._viewport.scrollTop = Math.max(0, offset - cardH);
      this._render();
    }
    const item = this._rowItems[logicalIdx];
    if (item?.type !== 'report') return;
    requestAnimationFrame(() => {
      const card = this._window.querySelector(`.report-card[data-report-id="${item.report.id}"]`);
      if (card) {
        card.focus();
      } else if (this._viewport.tabIndex === 0) {
        this._viewport.focus();
      }
    });
  }

  _handleKeydown(e) {
    const reportIndices = this._reportRowIndices();
    if (reportIndices.length === 0) return;

    const focused = document.activeElement;
    let focusedId = null;
    if (focused !== this._viewport) {
      const cardFocus = focused?.closest?.('.report-card');
      focusedId = cardFocus?.dataset?.reportId ?? focused?.dataset?.reportId ?? null;
      if (focusedId) {
        const logIdx = this._rowItems.findIndex(
          item => item.type === 'report' && item.report.id === focusedId
        );
        if (logIdx >= 0) this._focusedLogicalIndex = logIdx;
      }
    }

    let currentPos = reportIndices.indexOf(this._focusedLogicalIndex);
    if (currentPos < 0) {
      currentPos = 0;
      this._focusedLogicalIndex = reportIndices[0];
    }

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

    if (e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      const id = focusedId
        ?? (this._rowItems[this._focusedLogicalIndex]?.type === 'report'
          ? this._rowItems[this._focusedLogicalIndex].report.id
          : null);
      if (!id) { return; }
      const report = this._reports.find(r => r.id === id);
      if (report) { this._cb.onBaseline?.(report); }
      return;
    }

    if (e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      const id = focusedId
        ?? (this._rowItems[this._focusedLogicalIndex]?.type === 'report'
          ? this._rowItems[this._focusedLogicalIndex].report.id
          : null);
      if (!id) { return; }
      const report = this._reports.find(r => r.id === id);
      if (report) { this._cb.onCompare?.(report); }
      return;
    }

    if (e.key === 'Enter') {
      const id = focusedId
        ?? (this._rowItems[this._focusedLogicalIndex]?.type === 'report'
          ? this._rowItems[this._focusedLogicalIndex].report.id
          : null);
      if (!id) { return; }
      e.preventDefault();
      const report = this._reports.find(r => r.id === id);
      if (report) this._cb.onSelect?.(report);
      return;
    }

    if (e.key === 'Delete') {
      const id = focusedId
        ?? (this._rowItems[this._focusedLogicalIndex]?.type === 'report'
          ? this._rowItems[this._focusedLogicalIndex].report.id
          : null);
      if (!id) { return; }
      e.preventDefault();
      const report = this._reports.find(r => r.id === id);
      if (!report) return;
      Modal.confirm('Delete report', 'This cannot be undone.', { confirmText: 'Delete', destructive: true })
        .then(confirmed => { if (confirmed) this._cb.onDelete?.(report); });
    }
  }

  _refreshStates() {
    this._window.querySelectorAll('.report-card').forEach(card => {
      const id = card.dataset.reportId;
      card.classList.toggle('report-card--baseline', id === this._baselineId);
      card.classList.toggle('report-card--compare', id === this._compareId);

      const needsBaseline = id === this._baselineId;
      const needsCompare = id === this._compareId;
      let badge = card.querySelector('.report-role-badge');
      if (!badge) {
        badge = _el('span', 'report-role-badge');
        card.appendChild(badge);
      }
      badge.classList.remove('report-role-badge--baseline', 'report-role-badge--compare');
      if (needsBaseline) {
        badge.classList.add('report-role-badge--baseline', 'report-role-badge--visible');
        badge.textContent = 'B';
        badge.title = 'Baseline report';
      } else if (needsCompare) {
        badge.classList.add('report-role-badge--compare', 'report-role-badge--visible');
        badge.textContent = 'C';
        badge.title = 'Compare report';
      } else {
        badge.textContent = '';
        badge.title = '';
        badge.classList.remove('report-role-badge--visible');
      }
    });
  }
}

export function createReportList(containerEl, callbacks) {
  return new ReportList(containerEl, callbacks);
}
