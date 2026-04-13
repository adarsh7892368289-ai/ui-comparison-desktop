import { Toast } from './toast.js';
import { sanitize } from '../utils/sanitize.js';
import { relativeTime } from '../utils/time.js';
import { handleExport, handleFullReport } from '../application/export-workflow.js';
import { dispatch } from '../state.js';
import { iconAlertCircle, iconAlertTriangle, iconCheck, iconGitCompare } from '../utils/icons.js';

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
  const section = _ce('details', 'element-section result-section');
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
      const noDiffs = _ce('div', 'rp-no-diffs');
      const checkIc = _ce('span', 'rp-inline-icon');
      checkIc.innerHTML = iconCheck(16);
      noDiffs.append(checkIc, document.createTextNode('No style differences in matched elements'));
      root.appendChild(noDiffs);
    }

    if (added.length > 0) {
      root.appendChild(_buildElSection(added, 'added'));
    }

    if (removed.length > 0) {
      root.appendChild(_buildElSection(removed, 'removed'));
    }

    if (matching.ambiguousCount > 0) {
      const note = _ce('div', 'rp-ambiguous-note');
      const warnIc = _ce('span', 'rp-inline-icon');
      warnIc.innerHTML = iconAlertTriangle(16);
      note.append(
        warnIc,
        document.createTextNode(
          `${matching.ambiguousCount} element${matching.ambiguousCount !== 1 ? 's' : ''} had ambiguous matches — see full report for details`
        )
      );
      root.appendChild(note);
    }

    root.appendChild(this._buildActionsBar());

    this._container.appendChild(root);
  }

  _buildSummaryBar(matching, mode, duration, cachedAt, rateClass) {
    const bar = _ce('div', 'result-summary-bar');

    const pct   = matching.matchRate ?? 0;
    const r     = 30;
    const cx    = 40;
    const cy    = 40;
    const circ  = 2 * Math.PI * r;           // ~188.5
    const filled = (pct / 100) * circ;
    const gap    = circ - filled;

    const arcColor = rateClass === 'rate-critical' ? 'var(--severity-critical)'
                   : rateClass === 'rate-high'     ? 'var(--severity-high)'
                   :                                 'var(--color-success)';

    const svgNS = 'http://www.w3.org/2000/svg';
    const svgEl = document.createElementNS(svgNS, 'svg');
    svgEl.setAttribute('width',   '80');
    svgEl.setAttribute('height',  '80');
    svgEl.setAttribute('viewBox', '0 0 80 80');
    svgEl.setAttribute('class',   'match-rate-donut');
    svgEl.setAttribute('aria-label', `${pct}% match rate`);
    svgEl.setAttribute('role', 'img');

    // Track arc (unfilled)
    const track = document.createElementNS(svgNS, 'circle');
    track.setAttribute('cx', cx); track.setAttribute('cy', cy); track.setAttribute('r', r);
    track.setAttribute('fill', 'none');
    track.setAttribute('stroke', 'var(--color-surface-raised)');
    track.setAttribute('stroke-width', '8');

    // Filled arc — starts at 12 o'clock via transform rotate(-90)
    const arc = document.createElementNS(svgNS, 'circle');
    arc.setAttribute('cx', cx); arc.setAttribute('cy', cy); arc.setAttribute('r', r);
    arc.setAttribute('fill', 'none');
    arc.setAttribute('stroke', arcColor);
    arc.setAttribute('stroke-width', '8');
    arc.setAttribute('stroke-linecap', 'round');
    arc.setAttribute('stroke-dasharray', `${filled} ${gap}`);
    arc.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);

    // Center percentage text — 16px keeps "100%" within 44px inner diameter
    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', cx); label.setAttribute('y', cy);
    label.setAttribute('dominant-baseline', 'central');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-size', '16');
    label.setAttribute('font-weight', '600');
    label.setAttribute('fill', 'var(--color-text-primary)');
    label.textContent = `${pct}%`;

    svgEl.appendChild(track);
    svgEl.appendChild(arc);
    svgEl.appendChild(label);

    const group = _ce('div', 'match-rate-group');
    group.appendChild(svgEl);
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
      dot.style.background = dotColors[label] || 'var(--color-text-secondary)';
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
      { cls: 'seg-unchanged', n: unchangedElements ?? 0, title: `${unchangedElements} unchanged` },
      { cls: 'seg-modified',  n: modifiedElements  ?? 0, title: `${modifiedElements} modified` },
      { cls: 'seg-added',     n: added.length,           title: `${added.length} added` },
      { cls: 'seg-removed',   n: removed.length,         title: `${removed.length} removed` },
    ];
    segs.forEach(({ cls, n, title }) => {
      const pctVal = parseFloat(pct(n));
      const seg = _ce('div', `coverage-bar-segment ${cls}`);
      seg.style.width = `${pctVal}%`;
      seg.title = title;
      bar.appendChild(seg);
    });
    section.appendChild(bar);

    const legend = _ce('div', 'coverage-bar-legend');
    legend.setAttribute('role', 'list');
    [
      { cls: 'seg-unchanged', label: 'Unchanged' },
      { cls: 'seg-modified', label: 'Modified' },
      { cls: 'seg-added', label: 'Added' },
      { cls: 'seg-removed', label: 'Removed' },
    ].forEach(({ cls, label }) => {
      const item = _ce('div', 'coverage-bar-legend-item');
      item.setAttribute('role', 'listitem');
      const sw = _ce('span', `coverage-legend-swatch ${cls}`);
      sw.setAttribute('aria-hidden', 'true');
      item.appendChild(sw);
      item.appendChild(_text('span', 'coverage-legend-label', label));
      legend.appendChild(item);
    });
    section.appendChild(legend);

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

  showIdle() {
    this._removeListeners();
    this._container.replaceChildren();
    const root = _ce('div', 'result-empty-state result-empty-state--idle');
    root.setAttribute('role', 'status');
    root.innerHTML = `
      <div class="result-empty-icon" aria-hidden="true">${iconGitCompare(40)}</div>
      <p class="result-empty-title">No comparison yet</p>
      <p class="result-empty-hint">Extract two pages and compare them to see results here.</p>`;
    this._container.appendChild(root);
  }

  showComparing() {
    this._removeListeners();
    this._container.replaceChildren();
    const root = _ce('div', 'result-empty-state result-empty-state--comparing');
    root.setAttribute('role', 'status');
    root.setAttribute('aria-busy', 'true');
    root.innerHTML = `
      <div class="result-empty-spinner" aria-hidden="true"></div>
      <p class="result-empty-title">Running comparison…</p>`;
    this._container.appendChild(root);
  }

  showError(message) {
    this._removeListeners();
    this._container.replaceChildren();
    const root = _ce('div', 'result-empty-state result-empty-state--error');
    root.setAttribute('role', 'alert');
    const raw =
      message == null
        ? 'Unknown error'
        : typeof message === 'string'
          ? message
          : typeof message === 'object' && message.message != null
            ? String(message.message)
            : String(message);
    const short = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
    root.innerHTML = `
      <div class="result-empty-icon result-empty-icon--error" aria-hidden="true">${iconAlertCircle(40)}</div>
      <p class="result-empty-title">Comparison failed</p>
      <p class="result-empty-msg"></p>
      <button type="button" class="btn-ghost btn-sm result-empty-dismiss">Dismiss</button>`;
    root.querySelector('.result-empty-msg').textContent = short;
    const btn = root.querySelector('.result-empty-dismiss');
    const onDismiss = () => dispatch('DISMISS_ERROR');
    btn.addEventListener('click', onDismiss);
    this._listeners.push({ el: btn, type: 'click', fn: onDismiss });
    this._container.appendChild(root);
  }

  clear() {
    this.showIdle();
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