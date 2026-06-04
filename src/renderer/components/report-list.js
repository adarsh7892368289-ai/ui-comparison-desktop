import { sanitize } from '../utils/sanitize.js';
import { STAGE_RE, hostFromUrl, lastPathSegment, envTag } from '../utils/report-metadata.js';
import { relativeTime, absoluteCalendarDate } from '../utils/time.js';
import { iconArrowUp, iconArrowUpDown, iconTarget, iconSquare, iconCheckSquare, iconMoreHorizontal, iconX } from '../utils/icons.js';
import { SINGLE_EXTRACTED_REPORT_EXPORT_MENU } from '@core/export/extraction-exporters/extracted-report-export-catalog.js';
import { handleExportReport } from '../application/export-workflow.js';
import { Modal } from './modal.js';
import { buildReportDetailsPanel, getReportDeviceInfo } from './report-details-panel.js';

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
    this._jobMeta = new Map();
    this._multiSelectActive = false;
    this._selectedIds = new Set();
    this._anchorId = null;
    this._expandedReportId = null;
    this._detailsDrawer = null;
    this._detailsDrawerCard = null;
    this._detailsDrawerOutsideHandler = null;
    this._detailsDrawerEscHandler = null;
    this._detailsDrawerResizeHandler = null;
    this._activeOverflow = null;
    this._hasOpenOverflow = false;
    this._renderedRange = null;

    this._viewport = _el('div', 'vscroll-viewport');
    this._spacer = _el('div', 'vscroll-spacer');
    this._window = _el('div', 'vscroll-window');
    this._window.setAttribute('role', 'list');
    this._spacer.appendChild(this._window);
    this._viewport.appendChild(this._spacer);
    this._container.prepend(this._viewport);

    this._scrollRafPending = false;
    this._onScroll = () => {
      this._closeAllOverflowMenus();
      if (this._scrollRafPending) {return;}
      this._scrollRafPending = true;
      requestAnimationFrame(() => {
        this._scrollRafPending = false;
        this._render(true);
        if (this._detailsDrawer) {this._positionDetailsDrawer();}
      });
    };
    this._viewport.addEventListener('scroll', this._onScroll, { passive: true });

    this._onWindowResize = () => {
      this._activeOverflow?.position();
    };
    window.addEventListener('resize', this._onWindowResize);
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
    if (this._expandedReportId
        && !this._reports.some(r => r.id === this._expandedReportId)) {
      this._closeDetailsDrawer();
    } else if (this._detailsDrawer) {
      this._refreshDetailsDrawerContent();
    }
    this._buildRowItems();
    const firstReportIdx = this._rowItems.findIndex(x => x.type === 'report');
    this._focusedLogicalIndex = firstReportIdx >= 0 ? firstReportIdx : -1;
    this._render();
  }

  setJobMeta(jobMetaMap) {
    this._jobMeta = jobMetaMap instanceof Map ? jobMetaMap : new Map();
    if (this._detailsDrawer) {
      this._refreshDetailsDrawerContent();
    }
    if (this._config.groupBy === 'job') {
      this._buildRowItems();
      this._render();
    }
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

  setMultiSelectMode(active) {
    const changed = this._multiSelectActive !== active;
    this._multiSelectActive = active;
    if (changed) {
      this._container.classList.toggle('multi-select-active', active);
      this._render();
    }
  }

  setSelectedIds(selectedIds) {
    this._selectedIds = selectedIds;
    this._render();
  }

  setAnchorId(anchorId) {
    this._anchorId = anchorId;
  }

  getVisibleReportIds() {
    return this._rowItems
      .filter(item => item.type === 'report')
      .map(item => item.report.id);
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
    this._closeAllOverflowMenus();
    this._closeDetailsDrawer();
    this._viewport.removeEventListener('scroll', this._onScroll);
    this._viewport.removeEventListener('keydown', this._onKeydown);
    if (this._onWindowResize) {
      window.removeEventListener('resize', this._onWindowResize);
    }
    this._resizeObs.disconnect();
  }

  _updateDensityClass() {
    const panel = document.getElementById('left-panel');
    if (!panel) return;
    const d = this._config.density;
    panel.dataset.density = (d === 'compact' || d === 'comfortable') ? d : 'default';
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

      if (groupBy === 'job') {
        const jobKeys = [];
        const singleKey = '__single__';
        for (const key of groups.keys()) {
          if (key !== singleKey) jobKeys.push(key);
        }
        jobKeys.sort((a, b) => {
          const aId = a.replace('__job__', '');
          const bId = b.replace('__job__', '');
          const at = this._jobMeta.get(aId)?.createdAt ?? 0;
          const bt = this._jobMeta.get(bId)?.createdAt ?? 0;
          return bt - at;
        });
        if (groups.has(singleKey)) jobKeys.push(singleKey);

        this._rowItems = [];
        let idx = filtered.length;
        for (const key of jobKeys) {
          const items = groups.get(key) ?? [];
          const label = this._jobGroupLabel(key);
          const jobId = key === singleKey ? null : key.replace('__job__', '');
          const meta  = jobId ? this._jobMeta.get(jobId) : null;
          this._rowItems.push({
            type:   'header',
            label,
            jobId,
            status: meta?.status ?? null,
          });
          const sorted = [...items].sort((a, b) => (a.pairIndex ?? 0) - (b.pairIndex ?? 0));
          for (const r of sorted) {
            this._rowItems.push({ type: 'report', report: r, displayIndex: idx-- });
          }
        }
      } else {
        this._rowItems = [];
        let idx = filtered.length;
        for (const [label, items] of groups) {
          this._rowItems.push({ type: 'header', label });
          for (const r of items) {
            this._rowItems.push({ type: 'report', report: r, displayIndex: idx-- });
          }
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
    if (groupBy === 'job') {
      return report.bulkJobId ? `__job__${report.bulkJobId}` : '__single__';
    }
    return 'Unknown';
  }

  _jobGroupLabel(key) {
    if (key === '__single__') return 'Single runs';
    const jobId = key.replace('__job__', '');
    const meta = this._jobMeta.get(jobId);
    if (!meta) return `Bulk job · ${jobId.slice(0, 8)}…`;
    const parts = [`Bulk: ${meta.filename ?? jobId.slice(0, 8)}`];
    if (meta.totalPairs != null) parts.push(`${meta.totalPairs} pairs`);
    if (meta.createdAt) parts.push(relativeTime(meta.createdAt));
    return parts.join(' · ');
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

  _render(fromScroll = false) {
    if (this._activeOverflow) {
      const trigger = this._activeOverflow.trigger;
      if (!trigger.isConnected) this._closeAllOverflowMenus();
    }
    const scrollTop = this._viewport.scrollTop;
    const viewH = this._viewportCssHeight();
    const cardH = this._cardHeight();
    const n = this._rowItems.length;

    if (n === 0) {
      this._window.textContent = '';
      this._window.style.top = '0px';
      this._viewport.tabIndex = -1;
      this._renderedRange = null;
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

    if (fromScroll && this._renderedRange
      && this._renderedRange.startIdx === startIdx
      && this._renderedRange.endIdx === endIdx) {
      return;
    }
    this._renderedRange = { startIdx, endIdx };

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
        ? this._renderHeader(item)
        : this._renderCard(item.report, item.displayIndex, showEnvBadge, i, focusedInWindow && i === focusedRow));
    }

    this._window.textContent = '';
    this._window.appendChild(frag);
  }

  _renderHeader(item) {
    const label  = typeof item === 'string' ? item : (item?.label ?? '');
    const jobId  = typeof item === 'object' && item ? item.jobId  : null;
    const status = typeof item === 'object' && item ? item.status : null;

    const header = _el('div', 'report-group-header');
    header.setAttribute('role', 'presentation');

    const labelSpan = _el('span', 'report-group-header__label', label);
    header.appendChild(labelSpan);

    if (jobId && status) {
      const chip = document.createElement('span');
      chip.className = `report-group-header__chip report-group-header__chip--${status}`;
      const chipLabels = {
        completed: 'Done',
        done:      'Done',
        partial:   'Partial',
        failed:    'Failed',
        cancelled: 'Cancelled',
      };
      chip.textContent = chipLabels[status] ?? status;
      header.appendChild(chip);
    }

    if (jobId) {
      header.dataset.bulkJobId = jobId;
      header.addEventListener('contextmenu', (e) => {
        if (!window.electronAPI?.showContextMenu) { return; }
        e.preventDefault();
        window.electronAPI.showContextMenu({ bulkJobId: jobId });
      });
    }

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
    if (isBaseline) {card.classList.add('report-card--baseline');}
    if (isCompare) {card.classList.add('report-card--compare');}
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
      if (this._multiSelectActive) {
        if (!this._selectedIds.has(report.id)) {
          this._cb.onMultiSelectToggle?.(report.id);
        }
        const count = this._selectedIds.has(report.id)
          ? this._selectedIds.size
          : this._selectedIds.size + 1;
        window.electronAPI.showContextMenu({
          reportId: report.id,
          multiSelect: true,
          count,
        });
      } else {
        window.electronAPI.showContextMenu({
          reportId: report.id,
          isBaseline,
        });
      }
    });

    const body = _el('div', 'report-card-body');
    body.style.cursor = 'pointer';
    body.title = report.url || '';

    const isMultiSelected = this._multiSelectActive && this._selectedIds.has(report.id);
    if (this._multiSelectActive) {
      card.setAttribute('aria-selected', String(isMultiSelected));
    }
    if (isMultiSelected) {
      card.classList.add('report-card--multi-selected');
    }

    const cardLabel = report.title || report.name || host || report.url || '';

    const leading = _el('div', 'report-card-leading');
    const indexSpan = _el('span', 'report-card-index report-card-index--lead', `R${displayIndex}`);
    indexSpan.title = report.url || '';
    leading.appendChild(indexSpan);
    leading.appendChild(this._renderCheckbox(report.id, cardLabel));
    card.appendChild(leading);

    if (density === 'compact') {
      const row = _el('div', 'report-card-line report-card-line--compact');
      this._appendEnvBadge(row, showEnvBadge, env, report);
      const hostSpan = _el('span', 'report-card-host report-card-host--secondary', host);
      hostSpan.title = report.url || '';
      row.appendChild(hostSpan);
      body.appendChild(row);
    } else {
      const line1 = _el('div', 'report-card-line report-card-line--primary');
      line1.title = report.url || '';
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

    body.addEventListener('click', (e) => this._handleCardClick(e, report));
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

    actions.appendChild(this._buildOverflowMenu(report, host));

    card.appendChild(actions);

    const badge = _el('span', 'report-role-badge');
    if (isBaseline) {
      badge.classList.add('report-role-badge--baseline', 'report-role-badge--visible', 'report-role-badge--clickable');
      badge.textContent = 'B';
      badge.title = 'Click to clear baseline';
      badge.addEventListener('click', (e) => { e.stopPropagation(); this._cb.onBaseline?.(report); });
    } else if (isCompare) {
      badge.classList.add('report-role-badge--compare', 'report-role-badge--visible', 'report-role-badge--clickable');
      badge.textContent = 'C';
      badge.title = 'Click to clear compare';
      badge.addEventListener('click', (e) => { e.stopPropagation(); this._cb.onCompare?.(report); });
    }
    card.appendChild(badge);

    return card;
  }

  _buildOverflowMenu(report, host) {
    const wrap = _el('div', 'report-card-overflow');
    wrap.dataset.reportId = report.id;

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'btn-ghost btn-sm report-card-overflow__trigger';
    trigger.dataset.action = 'overflow-menu';
    trigger.innerHTML = iconMoreHorizontal(16);
    trigger.title = 'More actions';
    trigger.setAttribute('aria-label', 'More actions');
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', (e) => { e.stopPropagation(); });
    wrap.appendChild(trigger);

    const buildMenu = () => {
      const menu = _el('div', 'export-menu report-card-overflow-menu');
      menu.setAttribute('role', 'menu');
      menu.dataset.reportId = report.id;

      const expanded = this._expandedReportId === report.id;
      const detailsItem = _el(
        'button',
        'export-menu-item report-card-overflow-menu__item',
        expanded ? 'Hide details' : 'View details'
      );
      detailsItem.setAttribute('role', 'menuitem');
      detailsItem.type = 'button';
      detailsItem.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenu();
        this._toggleDetails(report.id);
      });
      menu.appendChild(detailsItem);

      menu.appendChild(_el('div', 'export-menu-sep'));

      const exportLabel = _el('div', 'report-card-overflow-menu__group-label', 'Export as');
      exportLabel.setAttribute('aria-hidden', 'true');
      menu.appendChild(exportLabel);
      for (const { format, label } of SINGLE_EXTRACTED_REPORT_EXPORT_MENU) {
        const btn = _el('button', 'export-menu-item report-card-overflow-menu__item', label);
        btn.setAttribute('role', 'menuitem');
        btn.type = 'button';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          closeMenu();
          handleExportReport(report, format);
        });
        menu.appendChild(btn);
      }

      menu.appendChild(_el('div', 'export-menu-sep'));

      const deleteItem = _el(
        'button',
        'export-menu-item export-menu-item--danger report-card-overflow-menu__item',
        'Delete'
      );
      deleteItem.setAttribute('role', 'menuitem');
      deleteItem.type = 'button';
      deleteItem.dataset.action = 'delete';
      deleteItem.setAttribute('aria-label', `Delete report from ${sanitize(host)}`);
      deleteItem.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenu();
        this._cb.onDelete?.(report);
      });
      menu.appendChild(deleteItem);

      menu.addEventListener('pointerenter', cancelClose);
      menu.addEventListener('pointerleave', scheduleClose);
      menu.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          closeMenu();
          trigger.focus();
        }
      });

      return menu;
    };

    let menuEl = null;
    let closeTimer = null;
    const cancelClose = () => {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    };
    const scheduleClose = () => {
      cancelClose();
      closeTimer = setTimeout(() => closeMenu(), 150);
    };
    const positionMenu = () => {
      if (!menuEl) return;
      const triggerRect = trigger.getBoundingClientRect();
      const margin = 8;
      const menuRect = menuEl.getBoundingClientRect();
      const menuW = menuRect.width || 180;
      const menuH = menuRect.height || 200;
      const viewportH = window.innerHeight;
      const viewportW = window.innerWidth;

      const spaceBelow = viewportH - triggerRect.bottom;
      const spaceAbove = triggerRect.top;
      const placeBelow = spaceBelow >= menuH + margin || spaceBelow >= spaceAbove;

      let top = placeBelow
        ? triggerRect.bottom
        : triggerRect.top - menuH;
      top = Math.max(margin, Math.min(top, viewportH - menuH - margin));

      let left = triggerRect.right - menuW;
      left = Math.max(margin, Math.min(left, viewportW - menuW - margin));

      menuEl.dataset.placement = placeBelow ? 'below' : 'above';
      menuEl.style.top = Math.round(top) + 'px';
      menuEl.style.left = Math.round(left) + 'px';
    };
    const open = () => {
      cancelClose();
      this._closeAllOverflowMenus();
      if (!menuEl) {
        menuEl = buildMenu();
        menuEl.classList.add('report-card-overflow-menu--portal');
        document.body.appendChild(menuEl);
      }
      wrap.classList.add('report-card-overflow--open');
      trigger.setAttribute('aria-expanded', 'true');
      this._activeOverflow = { wrap, trigger, menuEl, close: closeMenu, position: positionMenu };
      this._hasOpenOverflow = true;
      requestAnimationFrame(positionMenu);
    };
    const closeMenu = () => {
      cancelClose();
      wrap.classList.remove('report-card-overflow--open');
      trigger.setAttribute('aria-expanded', 'false');
      if (menuEl) {
        menuEl.remove();
        menuEl = null;
      }
      if (this._activeOverflow?.wrap === wrap) {
        this._activeOverflow = null;
      }
    };

    wrap._closeOverflow = closeMenu;
    wrap._reposition = positionMenu;

    wrap.addEventListener('pointerenter', open);
    wrap.addEventListener('pointerleave', scheduleClose);
    wrap.addEventListener('focusin', open);
    wrap.addEventListener('focusout', (e) => {
      if (wrap.contains(e.relatedTarget)) return;
      if (menuEl && menuEl.contains(e.relatedTarget)) return;
      scheduleClose();
    });
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        open();
        requestAnimationFrame(() => {
          const first = menuEl?.querySelector('.export-menu-item');
          first?.focus();
        });
      } else if (e.key === 'Escape') {
        closeMenu();
      }
    });

    return wrap;
  }

  _closeAllOverflowMenus() {
    if (this._activeOverflow) {
      this._activeOverflow.close();
    }
    if (!this._hasOpenOverflow) {return;}
    this._hasOpenOverflow = false;
    document.querySelectorAll('.report-card-overflow-menu--portal').forEach((el) => el.remove());
    this._window.querySelectorAll('.report-card-overflow--open').forEach((el) => {
      el.classList.remove('report-card-overflow--open');
      el.querySelector('.report-card-overflow__trigger')?.setAttribute('aria-expanded', 'false');
    });
  }

  _toggleDetails(reportId) {
    if (this._expandedReportId === reportId) {
      this._closeDetailsDrawer();
      return;
    }
    this._openDetailsDrawer(reportId);
  }

  _openDetailsDrawer(reportId) {
    const report = this._reports.find(r => r.id === reportId);
    if (!report) return;

    this._closeAllOverflowMenus();

    if (!this._detailsDrawer) {
      const drawer = _el('div', 'report-details-drawer');
      drawer.setAttribute('role', 'dialog');
      drawer.setAttribute('aria-modal', 'false');
      drawer.setAttribute('aria-label', 'Report details');
      drawer.tabIndex = -1;

      const header = _el('div', 'report-details-drawer__header');
      const titleWrap = _el('div', 'report-details-drawer__title-wrap');
      const title = _el('h3', 'report-details-drawer__title', 'Report details');
      const deviceBadge = _el('span', 'report-details-drawer__device');
      deviceBadge.hidden = true;
      titleWrap.appendChild(title);
      titleWrap.appendChild(deviceBadge);
      header.appendChild(titleWrap);
      this._detailsDrawerDeviceBadge = deviceBadge;
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'report-details-drawer__close';
      closeBtn.setAttribute('aria-label', 'Close report details');
      closeBtn.title = 'Close (Esc)';
      closeBtn.innerHTML = iconX(16);
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._closeDetailsDrawer();
      });
      header.appendChild(closeBtn);
      drawer.appendChild(header);

      const body = _el('div', 'report-details-drawer__body');
      drawer.appendChild(body);
      this._detailsDrawerCard = body;
      this._detailsDrawer = drawer;

      drawer.addEventListener('mousedown', (e) => e.stopPropagation());

      document.body.appendChild(drawer);
    }

    this._expandedReportId = reportId;
    this._refreshDetailsDrawerContent();
    this._positionDetailsDrawer();
    this._activateDetailsDrawerListeners();

    requestAnimationFrame(() => {
      this._detailsDrawer?.classList.add('report-details-drawer--visible');
    });
  }

  _refreshDetailsDrawerContent() {
    if (!this._detailsDrawer || !this._expandedReportId) return;
    const report = this._reports.find(r => r.id === this._expandedReportId);
    if (!report) {
      this._closeDetailsDrawer();
      return;
    }
    const badge = this._detailsDrawerDeviceBadge;
    if (badge) {
      const info = getReportDeviceInfo(report);
      if (info) {
        badge.innerHTML = `${info.iconSvg(13)}<span>${info.label}</span>`;
        badge.title = `Captured on ${info.label.toLowerCase()}`;
        badge.dataset.device = info.deviceType;
        badge.hidden = false;
      } else {
        badge.hidden = true;
        badge.removeAttribute('data-device');
      }
    }

    const panel = buildReportDetailsPanel(report, this._jobMeta);
    this._detailsDrawerCard.textContent = '';
    this._detailsDrawerCard.appendChild(panel);
  }

  _positionDetailsDrawer() {
    if (!this._detailsDrawer) return;
    const leftPanel = document.getElementById('left-panel');
    if (!leftPanel) return;
    const panelRect = leftPanel.getBoundingClientRect();
    const left = Math.max(0, Math.round(panelRect.right));

    const viewportH = window.innerHeight;
    const margin = 12;
    const desiredHeight = Math.max(220, Math.round(panelRect.height / 2));
    const height = Math.min(desiredHeight, Math.max(220, viewportH - margin * 2));

    const card = this._expandedReportId
      ? this._window.querySelector(`.report-card[data-report-id="${this._expandedReportId}"]`)
      : null;
    let anchorTop;
    if (card) {
      const cardRect = card.getBoundingClientRect();
      anchorTop = Math.round(cardRect.top);
    } else {
      anchorTop = Math.round(panelRect.top);
    }

    const minTop = margin;
    const maxTop = Math.max(minTop, viewportH - height - margin);
    const clampedTop = Math.min(Math.max(anchorTop, minTop), maxTop);

    this._detailsDrawer.style.left = left + 'px';
    this._detailsDrawer.style.top = clampedTop + 'px';
    this._detailsDrawer.style.height = height + 'px';
  }

  _activateDetailsDrawerListeners() {
    this._deactivateDetailsDrawerListeners();

    this._detailsDrawerOutsideHandler = (e) => {
      if (!this._detailsDrawer) return;
      const path = e.composedPath ? e.composedPath() : [];
      if (path.includes(this._detailsDrawer)) return;
      this._closeDetailsDrawer();
    };
    document.addEventListener('mousedown', this._detailsDrawerOutsideHandler, true);

    this._detailsDrawerEscHandler = (e) => {
      if (e.key !== 'Escape') return;
      if (!this._detailsDrawer) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      this._closeDetailsDrawer();
    };
    document.addEventListener('keydown', this._detailsDrawerEscHandler);

    this._detailsDrawerResizeHandler = () => this._positionDetailsDrawer();
    window.addEventListener('resize', this._detailsDrawerResizeHandler);
  }

  _deactivateDetailsDrawerListeners() {
    if (this._detailsDrawerOutsideHandler) {
      document.removeEventListener('mousedown', this._detailsDrawerOutsideHandler, true);
      this._detailsDrawerOutsideHandler = null;
    }
    if (this._detailsDrawerEscHandler) {
      document.removeEventListener('keydown', this._detailsDrawerEscHandler);
      this._detailsDrawerEscHandler = null;
    }
    if (this._detailsDrawerResizeHandler) {
      window.removeEventListener('resize', this._detailsDrawerResizeHandler);
      this._detailsDrawerResizeHandler = null;
    }
  }

  _closeDetailsDrawer() {
    this._expandedReportId = null;
    this._deactivateDetailsDrawerListeners();
    if (this._detailsDrawer) {
      const drawer = this._detailsDrawer;
      this._detailsDrawer = null;
      this._detailsDrawerCard = null;
      drawer.remove();
    }
  }

  _renderCheckbox(reportId, reportLabel) {
    const checked = this._selectedIds.has(reportId);
    const container = _el('div', 'report-card-checkbox');
    container.innerHTML = checked ? iconCheckSquare(16) : iconSquare(16);
    if (checked) container.classList.add('report-card-checkbox--checked');
    container.setAttribute('role', 'checkbox');
    container.setAttribute('aria-checked', String(checked));
    container.setAttribute('aria-label', `Select ${reportLabel || 'report'}`);
    container.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this._multiSelectActive) {
        this._cb.onMultiSelectEnter?.(reportId);
      } else {
        this._cb.onMultiSelectToggle?.(reportId);
      }
    });
    return container;
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

  _handleCardClick(e, report) {
    const isMac = navigator.platform.toUpperCase().includes('MAC');
    const modKey = isMac ? e.metaKey : e.ctrlKey;

    if (e.shiftKey && this._multiSelectActive) {
      e.preventDefault();
      const visibleIds = this.getVisibleReportIds();
      const anchorId = this._anchorId;
      if (!anchorId) {
        this._cb.onMultiSelectAll?.([report.id]);
        return;
      }
      const anchorIdx = visibleIds.indexOf(anchorId);
      const targetIdx = visibleIds.indexOf(report.id);
      if (anchorIdx < 0 || targetIdx < 0) {
        this._cb.onMultiSelectAll?.([report.id]);
        return;
      }
      const start = Math.min(anchorIdx, targetIdx);
      const end = Math.max(anchorIdx, targetIdx);
      const rangeIds = visibleIds.slice(start, end + 1);
      this._cb.onMultiSelectAll?.(rangeIds);
      return;
    }

    if (modKey) {
      e.preventDefault();
      if (!this._multiSelectActive) {
        this._cb.onMultiSelectEnter?.(report.id);
      } else {
        this._cb.onMultiSelectToggle?.(report.id);
      }
      return;
    }

    if (this._multiSelectActive) {
      this._cb.onMultiSelectToggle?.(report.id);
      return;
    }

    this._cb.onSelect?.(report);
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

    if (this._multiSelectActive) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this._cb.onMultiSelectExit?.();
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        if (this._selectedIds.size > 0) {
          e.preventDefault();
          this._cb.onMultiSelectDelete?.();
          return;
        }
      }

      const isMac = navigator.platform.toUpperCase().includes('MAC');
      if ((e.key === 'a' || e.key === 'A') && (isMac ? e.metaKey : e.ctrlKey)) {
        e.preventDefault();
        const visibleIds = this.getVisibleReportIds();
        this._cb.onMultiSelectAll?.(visibleIds);
        return;
      }

      if (e.key === ' ') {
        const id = focusedId
          ?? (this._rowItems[this._focusedLogicalIndex]?.type === 'report'
            ? this._rowItems[this._focusedLogicalIndex].report.id
            : null);
        if (id) {
          e.preventDefault();
          this._cb.onMultiSelectToggle?.(id);
          return;
        }
      }

      if (e.key === 'b' || e.key === 'B' || e.key === 'c' || e.key === 'C' || e.key === 'Enter') {
        return;
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
