import { relativeTime } from '../utils/time.js';
import { handleExport, handleFullReport } from '../application/export-workflow.js';
import { dispatch } from '../state.js';
import { iconAlertCircle, iconCheck, iconGitCompare } from '../utils/icons.js';

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

function shortenUrl(url) {
  try { const u = new URL(url); return u.hostname + (u.pathname !== '/' ? u.pathname : ''); }
  catch { return url ?? '—'; }
}

function getMatchRateColor(pct) {
  if (pct >= 75) { return 'var(--color-success)'; }
  if (pct >= 60) { return 'hsl(25 85% 52%)'; }
  return 'var(--color-destructive)';
}

function _truncateElText(s, max = 40) {
  if (s == null || s === '') { return ''; }
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (t.length <= max) { return t; }
  return `${t.slice(0, max)}…`;
}

function _elementTagClassLine(el) {
  const tag = (el.tagName || 'element').toLowerCase();
  const cn = el.className != null ? String(el.className).trim() : '';
  const parts = cn ? cn.split(/\s+/).filter(Boolean).slice(0, 3) : [];
  return parts.length ? `${tag}.${parts.join('.')}` : tag;
}

function _buildElRow(el) {
  const row = _ce('div', 'el-row');
  const sel = el.cssSelector ?? el.xpath ?? '';
  if (sel) { row.title = sel; }

  const info = _ce('div', 'el-info');
  const tagLine = _elementTagClassLine(el);
  const textRaw = el.textContent != null ? String(el.textContent).trim() : '';

  if (textRaw) {
    info.appendChild(_text('span', 'el-label', `${tagLine} `));
    info.appendChild(_text('span', 'el-text', `"${_truncateElText(textRaw, 40)}"`));
  } else if (el.className != null && String(el.className).trim()) {
    info.appendChild(_text('span', 'el-label', tagLine));
  } else {
    info.appendChild(_text('span', 'el-label', `<${(el.tagName || 'element').toLowerCase()}>`));
  }

  row.appendChild(info);
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

    this._removeListeners();
    this._container.replaceChildren();

    const root = _ce('div', 'result-panel');

    root.appendChild(this._buildSummaryBar(matching, mode, duration, cachedAt, result.baselineUrl, result.compareUrl));
    root.appendChild(this._buildCoverageSection(matching, modifiedElements, unchangedElements, added, removed));

    if (added.length > 0) {
      root.appendChild(this._buildElementSection('Added in compare', added));
    }
    if (removed.length > 0) {
      root.appendChild(this._buildElementSection('Removed from baseline', removed));
    }

    if (propChanges > 0) {
      root.appendChild(this._buildSeveritySection(propChanges, sevElements, critical, high, medium, low, sevTotal));
    } else {
      const noDiffs = _ce('div', 'rp-no-diffs');
      const checkIc = _ce('span', 'rp-inline-icon');
      checkIc.innerHTML = iconCheck(16);
      noDiffs.append(checkIc, document.createTextNode('No style differences in matched elements'));
      root.appendChild(noDiffs);
    }

    root.appendChild(this._buildActionsBar());

    this._container.appendChild(root);
  }

  _buildSummaryBar(matching, mode, duration, cachedAt, baselineUrl, compareUrl) {
    const bar = _ce('div', 'result-summary-bar');

    const pct    = matching.matchRate ?? 0;
    const r      = 30;
    const cx     = 40;
    const cy     = 40;
    const circ   = 2 * Math.PI * r;
    const filled = (pct / 100) * circ;
    const gap    = circ - filled;

    const arcColor = getMatchRateColor(pct);

    const svgNS = 'http://www.w3.org/2000/svg';
    const svgEl = document.createElementNS(svgNS, 'svg');
    svgEl.setAttribute('width',   '80');
    svgEl.setAttribute('height',  '80');
    svgEl.setAttribute('viewBox', '0 0 80 80');
    svgEl.setAttribute('class',   'match-rate-donut');
    svgEl.setAttribute('aria-label', `${pct}% match rate`);
    svgEl.setAttribute('role', 'img');

    const track = document.createElementNS(svgNS, 'circle');
    track.setAttribute('cx', cx); track.setAttribute('cy', cy); track.setAttribute('r', r);
    track.setAttribute('fill', 'none');
    track.setAttribute('stroke', 'var(--color-surface-raised)');
    track.setAttribute('stroke-width', '8');

    const arc = document.createElementNS(svgNS, 'circle');
    arc.setAttribute('cx', cx); arc.setAttribute('cy', cy); arc.setAttribute('r', r);
    arc.setAttribute('fill', 'none');
    arc.setAttribute('stroke', arcColor);
    arc.setAttribute('stroke-width', '8');
    arc.setAttribute('stroke-linecap', 'round');
    arc.setAttribute('stroke-dasharray', `${filled} ${gap}`);
    arc.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);

    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('class', 'match-rate-value');
    label.setAttribute('x', cx); label.setAttribute('y', cy);
    label.setAttribute('dominant-baseline', 'central');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-size', '16');
    label.setAttribute('font-weight', '600');
    label.setAttribute('fill', arcColor);
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

    const urlRow  = _ce('div', 'result-url-row');
    const urlAEl  = _text('span', 'result-url result-url--baseline', shortenUrl(baselineUrl));
    urlAEl.title  = baselineUrl ?? '';
    const sep     = _text('span', 'result-url-sep', '↔');
    const urlBEl  = _text('span', 'result-url result-url--compare', shortenUrl(compareUrl));
    urlBEl.title  = compareUrl ?? '';
    urlRow.append(urlAEl, sep, urlBEl);
    detail.appendChild(urlRow);

    bar.appendChild(detail);
    return bar;
  }

  _buildCoverageSection(matching, modifiedElements, unchangedElements, added, removed) {
    const total     = matching.totalElements
                   ?? ((matching.totalMatched ?? 0) + (matching.unmatchedBaseline ?? 0) + (matching.unmatchedCompare ?? 0));
    const matched   = matching.totalMatched ?? 0;
    const unchanged = matching.unchangedCount ?? unchangedElements ?? 0;
    const modified  = matching.modifiedCount  ?? modifiedElements  ?? 0;
    const addedCnt  = matching.addedCount     ?? (added?.length   ?? 0);
    const removedCnt= matching.removedCount   ?? (removed?.length ?? 0);
    const unmatched = addedCnt + removedCnt;

    const pct = (n) => total > 0 ? Math.round(n / total * 100) : 0;

    const section = _ce('section', 'result-section coverage-section');

    const title = _ce('div', 'section-title');
    title.textContent = `Elements — ${total} total`;
    section.appendChild(title);

    const bar = _ce('div', 'coverage-proportion-bar');
    const segMatched = _ce('div', 'coverage-prop-seg coverage-prop-matched');
    segMatched.style.width = pct(matched) + '%';
    segMatched.title = `Matched: ${matched}`;
    const segUnmatched = _ce('div', 'coverage-prop-seg coverage-prop-unmatched');
    segUnmatched.style.width = pct(unmatched) + '%';
    segUnmatched.title = `Unmatched: ${unmatched}`;
    bar.append(segMatched, segUnmatched);
    section.appendChild(bar);

    const tree = _ce('div', 'coverage-tree');
    tree.appendChild(this._buildCoverageGroup('Matched', matched, pct(matched),
      [{ label: 'Unchanged', val: unchanged, symbol: '●', note: 'no differences', cls: 'unchanged' },
       { label: 'Modified',  val: modified,  symbol: '●', note: 'CSS changes',    cls: 'modified'  }]
    ));
    tree.appendChild(this._buildCoverageGroup('Unmatched', unmatched, pct(unmatched),
      [{ label: 'Added',   val: addedCnt,   symbol: '+', note: 'new in compare',       cls: 'added'   },
       { label: 'Removed', val: removedCnt, symbol: '−', note: 'missing from baseline', cls: 'removed' }]
    ));
    section.appendChild(tree);
    return section;
  }

  _buildElementSection(title, elements) {
    const details = _ce('details', 'result-section element-section');
    const summary = _ce('summary');
    summary.textContent = `${title} (${elements.length})`;
    details.appendChild(summary);
    const list = _ce('div', 'el-list');
    for (const el of elements) {
      list.appendChild(_buildElRow(el));
    }
    details.appendChild(list);
    return details;
  }

  _buildCoverageGroup(label, total, pct, children) {
    const group  = _ce('div', 'coverage-group');
    const header = _ce('div', 'coverage-group-header');
    const lbl    = _ce('span', 'cg-label');  lbl.textContent  = label;
    const val    = _ce('span', 'cg-value');  val.textContent  = String(total);
    const pctEl  = _ce('span', 'cg-pct');   pctEl.textContent = `${pct}%`;
    header.append(lbl, val, pctEl);
    group.appendChild(header);
    for (const child of children) {
      const row  = _ce('div', `coverage-child coverage-child--${child.cls}`);
      const sym  = _ce('span', 'cc-sym');   sym.textContent  = child.symbol;
      const cLbl = _ce('span', 'cc-label'); cLbl.textContent = child.label;
      const cVal = _ce('span', 'cc-val');   cVal.textContent = String(child.val);
      const note = _ce('span', 'cc-note');  note.textContent = child.note;
      row.append(sym, cLbl, cVal, note);
      group.appendChild(row);
    }
    return group;
  }

  _buildSeveritySection(propChanges, sevElements, critical, high, medium, low, sevTotal) {
    const section = _ce('div', 'severity-section result-section--nested');
    const frame = _ce('div', 'severity-section__frame');
    const titleText = `${propChanges} CSS change${propChanges !== 1 ? 's' : ''} across ${sevElements} modified element${sevElements !== 1 ? 's' : ''}`;
    const titleEl = _ce('div', 'section-title section-title--nested');
    titleEl.textContent = titleText;
    frame.appendChild(titleEl);

    const list = _ce('div');
    list.setAttribute('role', 'list');
    if (critical > 0) { list.appendChild(_buildSevRow('Critical', critical, 'critical', sevTotal)); }
    if (high     > 0) { list.appendChild(_buildSevRow('High',     high,     'high',     sevTotal)); }
    if (medium   > 0) { list.appendChild(_buildSevRow('Medium',   medium,   'medium',   sevTotal)); }
    if (low      > 0) { list.appendChild(_buildSevRow('Low',      low,      'low',      sevTotal)); }
    frame.appendChild(list);
    section.appendChild(frame);

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
    const root = _ce('div', 'result-empty-state result-empty-state--idle result-empty-state--compact');
    root.setAttribute('role', 'status');
    root.innerHTML = `
      <div class="result-empty-icon" aria-hidden="true">${iconGitCompare(22)}</div>
      <div class="result-empty-compact-copy">
        <p class="result-empty-title">No comparison yet</p>
        <p class="result-empty-hint">Extract two pages and compare them to see results here.</p>
      </div>`;
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