import { Toast } from './toast.js';
import { sanitize } from '../utils/sanitize.js';
import { relativeTime } from '../utils/time.js';
import { handleExport, handleFullReport } from '../application/export-workflow.js';

const DETAIL_CAP = 50;

function _ce(tag, className) {
  const el = document.createElement(tag);
  if (className) { el.className = className; }
  return el;
}

function _text(tag, className, content) {
  const el = _ce(tag, className);
  el.textContent = content;
  return el;
}

function _buildElRow(el, status) {
  const tag    = (el.tagName || 'unknown').toLowerCase();
  const idPart = el.elementId ? `#${el.elementId}` : '';
  const clsPart = el.className?.trim()
    ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
    : '';
  const label = `${tag}${idPart}${clsPart}` || 'unknown';

  const row   = _ce('div', 'el-row');
  const badge = _text('span', `badge ${status === 'added' ? 'badge-added' : 'badge-removed'}`, status === 'added' ? '+' : '−');
  const info  = _ce('div', 'el-info');

  info.appendChild(_text('span', 'el-label', label));

  if (el.hpid) {
    info.appendChild(_text('span', 'el-hpid', el.hpid));
  }

  if (el.textContent?.trim()) {
    const trimmed = el.textContent.trim().slice(0, 60);
    const suffix  = el.textContent.trim().length > 60 ? '…' : '';
    info.appendChild(_text('span', 'el-text', `"${trimmed}${suffix}"`));
  }

  if (el.cssSelector) {
    const sel = _ce('span', 'el-sel');
    sel.title       = el.cssSelector;
    sel.textContent = el.cssSelector.slice(0, 50) + (el.cssSelector.length > 50 ? '…' : '');
    info.appendChild(sel);
  }

  row.append(badge, info);
  return row;
}

function _buildElSection(items, status) {
  const section = _ce('details', 'element-section');
  const summary = _ce('summary');

  const countBadge = _text('span', `badge ${status === 'added' ? 'badge-added' : 'badge-removed'}`,
    `${status === 'added' ? '+' : '−'}${items.length}`);
  const labelNode = document.createTextNode(` ${status === 'added' ? 'Added in compare' : 'Removed from baseline'}`);

  summary.append(countBadge, labelNode);
  section.appendChild(summary);

  const list = _ce('div', 'el-list');
  const cap  = items.slice(0, DETAIL_CAP);
  cap.forEach(el => list.appendChild(_buildElRow(el, status)));

  if (items.length > DETAIL_CAP) {
    list.appendChild(_text('div', 'el-overflow', `+${items.length - DETAIL_CAP} more — export for full list`));
  }

  section.appendChild(list);
  return section;
}

function _buildSevRow(label, count, type, sevTotal) {
  const pct  = sevTotal > 0 ? ((count / sevTotal) * 100).toFixed(1) : 0;
  const row  = _ce('div', 'rp-sev-row');
  row.setAttribute('role', 'listitem');
  row.setAttribute('aria-label', `${label}: ${count} element${count !== 1 ? 's' : ''}`);
  const badge = _text('span', `badge badge-${type}`, label);
  const wrap  = _ce('div', 'rp-sev-bar-wrap');
  const fill  = _ce('div', `rp-sev-bar-fill sev-${type}`);
  fill.style.width = `${pct}%`;
  wrap.appendChild(fill);
  const countEl = _text('span', 'sev-count', String(count));
  row.append(badge, wrap, countEl);
  return row;
}

export class ResultPanel {
  constructor(containerEl) {
    this._container  = containerEl;
    this._listeners  = [];
  }

  render(result, cachedAt = null) {
    if (!result) { this.clear(); return; }

    const { matching, comparison, mode, duration } = result;
    const { summary } = comparison;
    const {
      severityBreakdown,
      severityCounts,
      totalDifferences,
      propertyDiffCount,
      modifiedElements,
      unchangedElements,
    } = summary;

    const { critical = 0, high = 0, medium = 0, low = 0 } = severityBreakdown ?? severityCounts ?? {};
    const sevTotal    = (critical + high + medium + low) || 1;
    const sevElements = critical + high + medium + low;
    const propChanges = propertyDiffCount ?? totalDifferences ?? 0;

    const added   = result.unmatchedElements?.compare  ?? [];
    const removed = result.unmatchedElements?.baseline ?? [];

    const totalElements  = (matching.totalMatched ?? 0) + (matching.unmatchedBaseline ?? 0) + (matching.unmatchedCompare ?? 0);
    const unmatchedTotal = (matching.unmatchedBaseline ?? 0) + (matching.unmatchedCompare ?? 0);
    const pct = n => totalElements > 0 ? ((n / totalElements) * 100).toFixed(1) : 0;

    const rateClass = critical > 0 ? 'rate-critical' : high > 0 ? 'rate-high' : 'rate-ok';

    this._removeListeners();
    this._container.replaceChildren();

    const root = _ce('div', 'result-panel');

    root.appendChild(this._buildSummaryBar(matching, mode, duration, cachedAt, rateClass));
    root.appendChild(this._buildCoverageSection(matching, modifiedElements, unchangedElements, added, removed, unmatchedTotal, totalElements, pct));

    if (propChanges > 0) {
      root.appendChild(this._buildSeveritySection(propChanges, sevElements, critical, high, medium, low, sevTotal));
    } else {
      root.appendChild(_text('div', 'rp-no-diffs', '✓ No style differences in matched elements'));
    }

    if (added.length > 0) {
      root.appendChild(_buildElSection(added, 'added'));
    }

    if (removed.length > 0) {
      root.appendChild(_buildElSection(removed, 'removed'));
    }

    if (matching.ambiguousCount > 0) {
      const note = _text('div', 'rp-ambiguous-note',
        `⚠ ${matching.ambiguousCount} element${matching.ambiguousCount !== 1 ? 's' : ''} had ambiguous matches — see full report for details`);
      root.appendChild(note);
    }

    root.appendChild(this._buildActionsBar());

    this._container.appendChild(root);
  }

  _buildSummaryBar(matching, mode, duration, cachedAt, rateClass) {
    const bar = _ce('div', 'result-summary-bar');

    const group = _ce('div', 'match-rate-group');
    const circle = _ce('div', `match-rate-circle ${rateClass}`);
    circle.appendChild(_text('span', 'match-rate-value', `${matching.matchRate}%`));
    group.appendChild(circle);
    group.appendChild(_text('span', 'match-rate-label', 'match rate'));
    bar.appendChild(group);

    const detail = _ce('div', 'result-detail-col');

    const meta = _ce('div', 'result-meta');
    meta.appendChild(_text('span', 'result-mode-badge', mode));
    meta.appendChild(_text('span', '', `${duration}ms`));

    if (cachedAt) {
      const cached = _ce('span', 'result-cached-badge');
      cached.title       = 'Loaded from cache — run Compare to refresh';
      cached.textContent = `Cached · ${relativeTime(cachedAt)}`;
      meta.appendChild(cached);
    }

    detail.appendChild(meta);
    bar.appendChild(detail);
    return bar;
  }

  _buildCoverageSection(matching, modifiedElements, unchangedElements, added, removed, unmatchedTotal, totalElements, pct) {
    const section = _ce('div', 'coverage-bar-section');
    section.appendChild(_text('span', 'section-title', `Element Coverage — ${totalElements} total`));

    const dotColors = {
      Matched:   'var(--color-coverage-matched)',
      Modified:  'var(--color-coverage-modified)',
      Unchanged: 'var(--color-coverage-matched)',
      Unmatched: 'var(--color-coverage-removed)',
    };

    const stats = _ce('div', 'coverage-stats');
    const statDefs = [
      { val: matching.totalMatched,    label: 'Matched' },
      { val: modifiedElements  ?? 0,   label: 'Modified' },
      { val: unchangedElements ?? 0,   label: 'Unchanged' },
      { val: unmatchedTotal,           label: 'Unmatched' },
    ];
    statDefs.forEach(({ val, label }) => {
      const stat = _ce('div', 'coverage-stat');
      const dot = _ce('span', 'coverage-dot');
      dot.style.background = dotColors[label] || 'var(--color-neutral-400)';
      const valueRow = _ce('div', 'coverage-stat-value');
      valueRow.textContent = String(val);
      stat.appendChild(dot);
      stat.appendChild(valueRow);
      stat.appendChild(_text('div', 'coverage-stat-label', label));
      stats.appendChild(stat);
    });
    section.appendChild(stats);

    const bar = _ce('div', 'coverage-bar');
    bar.setAttribute('role', 'meter');
    bar.setAttribute('aria-label', 'Element coverage');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', String(totalElements));
    bar.setAttribute('aria-valuenow', String(matching.totalMatched ?? 0));
    bar.setAttribute('aria-valuetext', `${matching.totalMatched ?? 0} of ${totalElements} elements matched`);
    const segs = [
      { cls: 'seg-unchanged', n: unchangedElements ?? 0, title: `${unchangedElements} unchanged`,  segLabel: 'Unchanged' },
      { cls: 'seg-modified',  n: modifiedElements  ?? 0, title: `${modifiedElements} modified`,    segLabel: 'Modified' },
      { cls: 'seg-added',     n: added.length,           title: `${added.length} added`,           segLabel: 'Added' },
      { cls: 'seg-removed',   n: removed.length,         title: `${removed.length} removed`,       segLabel: 'Removed' },
    ];
    segs.forEach(({ cls, n, title, segLabel }) => {
      const pctVal = parseFloat(pct(n));
      const seg = _ce('div', cls);
      seg.style.width = `${pctVal}%`;
      seg.title = title;
      if (pctVal > 15) {
        seg.classList.add('seg--labelled');
        seg.textContent = segLabel;
      }
      bar.appendChild(seg);
    });
    section.appendChild(bar);

    return section;
  }

  _buildSeveritySection(propChanges, sevElements, critical, high, medium, low, sevTotal) {
    const section = _ce('div', 'severity-section');
    const titleText = `Severity — ${propChanges} CSS property change${propChanges !== 1 ? 's' : ''} across ${sevElements} modified element${sevElements !== 1 ? 's' : ''}`;
    section.appendChild(_text('span', 'section-title', titleText));

    const list = _ce('div');
    list.setAttribute('role', 'list');
    if (critical > 0) { list.appendChild(_buildSevRow('Critical', critical, 'critical', sevTotal)); }
    if (high     > 0) { list.appendChild(_buildSevRow('High',     high,     'high',     sevTotal)); }
    if (medium   > 0) { list.appendChild(_buildSevRow('Medium',   medium,   'medium',   sevTotal)); }
    if (low      > 0) { list.appendChild(_buildSevRow('Low',      low,      'low',      sevTotal)); }
    section.appendChild(list);

    return section;
  }

  _buildActionsBar() {
    const bar     = _ce('div', 'result-actions');
    const fmtRow  = _ce('div', 'export-format-row');

    const select  = _ce('select', 'select select-sm');
    select.id     = 'export-format-select';
    select.setAttribute('aria-label', 'Export format');
    [['html', 'HTML'], ['xlsx', 'Excel'], ['csv', 'CSV'], ['json', 'JSON']].forEach(([val, label]) => {
      const opt   = _ce('option');
      opt.value   = val;
      opt.textContent = label;
      select.appendChild(opt);
    });

    const exportBtn      = _ce('button', 'btn-ghost btn-sm');
    exportBtn.id         = 'export-comparison-btn';
    exportBtn.textContent = 'Export';
    const exportHandler   = () => handleExport();
    exportBtn.addEventListener('click', exportHandler);
    this._listeners.push({ el: exportBtn, type: 'click', fn: exportHandler });

    fmtRow.append(select, exportBtn);

    const reportBtn       = _ce('button', 'btn-primary');
    reportBtn.id          = 'view-report-btn';
    reportBtn.style.width = 'auto';
    reportBtn.style.padding = '0 var(--space-5)';
    reportBtn.textContent = 'Full Report';
    const reportHandler   = () => handleFullReport();
    reportBtn.addEventListener('click', reportHandler);
    this._listeners.push({ el: reportBtn, type: 'click', fn: reportHandler });

    bar.append(fmtRow, reportBtn);
    return bar;
  }

  clear() {
    this._removeListeners();
    this._container.replaceChildren();
    this._container.appendChild(_text('p', 'result-empty-state', 'Select two reports and click Compare'));
  }

  destroy() {
    this._removeListeners();
    this._container.replaceChildren();
  }

  _removeListeners() {
    for (const { el, type, fn } of this._listeners) {
      el.removeEventListener(type, fn);
    }
    this._listeners = [];
  }
}

export function createResultPanel(containerEl) {
  return new ResultPanel(containerEl);
}