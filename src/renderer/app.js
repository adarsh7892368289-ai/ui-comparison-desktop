'use strict';

import storage from '../infrastructure/idb-repository.js';
import { getState, dispatch, subscribe } from './state.js';

const api = window.electronAPI;
if (!api) {
  throw new Error(
    'window.electronAPI is undefined. ' +
    'Verify preload.js path in BrowserWindow.webPreferences and contextIsolation: true.'
  );
}

function hostFromUrl(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function lastPathSegment(url) {
  try {
    const seg = new URL(url).pathname.replace(/\/$/, '').split('/').filter(Boolean).pop();
    return seg ? `/${seg}` : '/';
  } catch { return ''; }
}

function sanitize(value) {
  const el = document.createElement('span');
  el.textContent = String(value ?? '');
  return el.innerHTML;
}

function relativeTime(isoString) {
  const mins = Math.floor((Date.now() - new Date(isoString).getTime()) / 60000);
  if (mins < 1)  { return 'just now'; }
  if (mins < 60) { return `${mins}m ago`; }
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  { return `${hrs}h ago`; }
  return `${Math.floor(hrs / 24)}d ago`;
}

const Toast = {
  _root: null,
  _init() { this._root = this._root ?? document.getElementById('toast-container'); },
  show(msg, type, duration = 3000) {
    this._init();
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    const txt = document.createElement('span');
    txt.textContent = msg;
    const x = document.createElement('button');
    x.className = 'toast-close';
    x.textContent = '×';
    x.addEventListener('click', () => this._dismiss(t));
    t.append(txt, x);
    this._root.appendChild(t);
    requestAnimationFrame(() => t.classList.add('visible'));
    if (duration > 0) { setTimeout(() => this._dismiss(t), duration); }
    while (this._root.children.length > 4) { this._dismiss(this._root.firstChild); }
  },
  _dismiss(t) {
    if (!t?.isConnected) { return; }
    t.classList.remove('visible');
    t.addEventListener('transitionend', () => t.remove(), { once: true });
  },
  success(m) { this.show(m, 'success', 3000); },
  error(m)   { this.show(m, 'error',   0); },
  info(m)    { this.show(m, 'info',    3000); },
};

function showProgress(id, label) {
  const wrap = document.getElementById(`${id}-progress`);
  if (wrap) { wrap.classList.add('visible'); }
  updateProgress(id, 0, label);
}

function updateProgress(id, pct, label) {
  const bar  = document.getElementById(`${id}-progress-bar`);
  const lbl  = document.getElementById(`${id}-progress-label`);
  const wrap = document.getElementById(`${id}-progress`);
  if (bar)  { bar.style.width = `${pct}%`; }
  if (lbl && label) { lbl.textContent = label; }
  if (wrap) { wrap.setAttribute('aria-valuenow', pct); }
}

function hideProgress(id) {
  const wrap = document.getElementById(`${id}-progress`);
  if (wrap) { wrap.classList.remove('visible'); }
}

function setError(id, msg) {
  const el = document.getElementById(`${id}-error`);
  if (el) { el.textContent = msg ?? ''; }
}

function populateReportSelectors(reports) {
  const total = reports.length;
  ['baseline-report', 'compare-report'].forEach(selId => {
    const sel = document.getElementById(selId);
    if (!sel) { return; }
    const current = sel.value;
    sel.textContent = '';
    sel.appendChild(new Option('Select report…', ''));
    reports.forEach((r, i) => {
      const host  = hostFromUrl(r.url).replace(/^www\./, '');
      const path  = lastPathSegment(r.url);
      const label = `R${total - i} · ${host}${path}`;
      const opt   = new Option(label, r.id);
      opt.title   = `${r.url} · ${r.totalElements ?? 0} elements · ${relativeTime(r.timestamp)}`;
      if (r.id === current) { opt.selected = true; }
      sel.appendChild(opt);
    });
  });
  syncCompareButton();
}

function syncCompareButton() {
  const state = getState();
  const btn   = document.getElementById('compare-btn');
  if (btn) {
    btn.disabled = !state.selectedBaseline ||
                   !state.selectedCompare  ||
                   state.selectedBaseline === state.selectedCompare;
  }
}

async function loadAndRenderReports() {
  const reports = await storage.loadReports();
  dispatch('REPORTS_LOADED', { reports });

  const listEl = document.getElementById('report-list');
  if (!listEl) { return; }
  listEl.innerHTML = '';

  if (!reports || reports.length === 0) {
    const p = document.createElement('p');
    p.style.cssText = 'color:var(--color-text-muted);font-size:12px;padding:12px 0';
    p.textContent   = 'No extractions yet. Enter a URL above to start.';
    listEl.appendChild(p);
    populateReportSelectors([]);
    return;
  }

  const total = reports.length;
  const frag  = document.createDocumentFragment();
  reports.forEach((report, i) => {
    const card = document.createElement('div');
    card.className = 'report-card';
    card.setAttribute('role', 'listitem');

    const host = hostFromUrl(report.url);
    const path = lastPathSegment(report.url);

    const body = document.createElement('div');
    body.className = 'report-card-body';
    body.innerHTML = `
      <div class="report-card-host">
        <span class="report-index">R${total - i}</span>${sanitize(host)}${sanitize(path)}
      </div>
      <div class="report-card-meta">
        ${sanitize(report.totalElements ?? 0)} elements · ${relativeTime(report.timestamp)}
      </div>`;

    const actions = document.createElement('div');
    actions.className = 'report-card-actions';

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async () => {
      await storage.deleteReport(report.id);
      await loadAndRenderReports();
    });

    actions.appendChild(delBtn);
    card.append(body, actions);
    frag.appendChild(card);
  });

  listEl.appendChild(frag);
  populateReportSelectors(reports);
}

function displayComparisonResults(result, cachedAt = null) {
  const container = document.getElementById('compare-results');
  if (!container || !result) { return; }

  const { matching, comparison, mode, duration } = result;
  const { summary } = comparison;
  const { severityBreakdown, severityCounts, totalDifferences, propertyDiffCount, modifiedElements, unchangedElements } = summary;
  const { critical, high, medium, low } = severityBreakdown ?? severityCounts ?? {};
  const sevTotal = (critical + high + medium + low) || 1;

  const added   = result.unmatchedElements?.compare  ?? [];
  const removed = result.unmatchedElements?.baseline ?? [];

  const totalElements  = (matching.totalMatched ?? 0) + (matching.unmatchedBaseline ?? 0) + (matching.unmatchedCompare ?? 0);
  const unmatchedTotal = (matching.unmatchedBaseline ?? 0) + (matching.unmatchedCompare ?? 0);

  const pct = (n) => totalElements > 0 ? ((n / totalElements) * 100).toFixed(1) : 0;
  const spct = (n) => sevTotal > 0 ? ((n / sevTotal) * 100).toFixed(1) : 0;

  const rateClass = critical > 0 ? 'rate-critical' : high > 0 ? 'rate-high' : 'rate-ok';

  const sevRow = (label, count, type) => count === 0 ? '' : `
    <div class="sev-row">
      <span class="badge badge-${type}">${label}</span>
      <div class="sev-bar-wrap"><div class="sev-bar-fill sev-${type}" style="width:${spct(count)}%"></div></div>
      <span class="sev-count">${count}</span>
    </div>`;

  const DETAIL_CAP = 20;
  const elRow = (el, status) => {
    const tag   = (el.tagName || 'unknown').toLowerCase();
    const idStr = el.elementId ? `#${el.elementId}` : '';
    const cls   = el.className?.trim()
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      : '';
    const label = `${tag}${idStr}${cls}` || 'unknown';
    const sel   = el.cssSelector
      ? `<span class="el-sel" title="${sanitize(el.cssSelector)}">${sanitize(el.cssSelector.slice(0,60))}${el.cssSelector.length>60?'…':''}</span>`
      : '';
    const badgeCls = status === 'added' ? 'badge-added' : 'badge-removed';
    const badgeTxt = status === 'added' ? '+' : '−';
    return `<div class="el-row">
      <span class="badge ${badgeCls}">${badgeTxt}</span>
      <div class="el-info"><span class="el-label">${sanitize(label)}</span>${sel}</div>
    </div>`;
  };

  const addedRows   = added.slice(0, DETAIL_CAP).map(el => elRow(el, 'added')).join('');
  const removedRows = removed.slice(0, DETAIL_CAP).map(el => elRow(el, 'removed')).join('');
  const addedOver   = added.length   > DETAIL_CAP ? `<div style="font-size:11px;color:var(--color-text-muted);padding:4px 0">+${added.length   - DETAIL_CAP} more</div>` : '';
  const removedOver = removed.length > DETAIL_CAP ? `<div style="font-size:11px;color:var(--color-text-muted);padding:4px 0">+${removed.length - DETAIL_CAP} more</div>` : '';

  const propChanges = propertyDiffCount ?? totalDifferences ?? 0;

  container.innerHTML = `
    <div class="result-card">
      <div class="result-header">
        <div>
          <div class="rate-value ${rateClass}">${matching.matchRate}%</div>
          <div class="rate-label">matched${cachedAt ? ` · cached ${relativeTime(cachedAt)}` : ''}</div>
        </div>
        <div class="result-meta">
          <span class="result-mode-badge">${sanitize(mode)}</span>
          <span class="result-duration">${duration}ms</span>
        </div>
      </div>

      <div class="section-hdr">Element Coverage — ${totalElements} total</div>
      <div class="match-breakdown-row">
        <div class="mbr-item mbr-matched"><div class="mbr-val">${matching.totalMatched}</div><div class="mbr-lbl">Matched</div></div>
        <div class="mbr-item mbr-modified"><div class="mbr-val">${modifiedElements ?? 0}</div><div class="mbr-lbl">Modified</div></div>
        <div class="mbr-item mbr-unchanged"><div class="mbr-val">${unchangedElements ?? 0}</div><div class="mbr-lbl">Unchanged</div></div>
        <div class="mbr-item mbr-unmatched"><div class="mbr-val">${unmatchedTotal}</div><div class="mbr-lbl">Unmatched</div></div>
      </div>
      <div class="match-bar-wrap">
        <div class="match-bar-seg match-bar-unchanged" style="width:${pct(unchangedElements??0)}%" title="${unchangedElements} unchanged"></div>
        <div class="match-bar-seg match-bar-modified"  style="width:${pct(modifiedElements??0)}%"  title="${modifiedElements} modified"></div>
        <div class="match-bar-seg match-bar-added"     style="width:${pct(added.length)}%"         title="${added.length} added"></div>
        <div class="match-bar-seg match-bar-removed"   style="width:${pct(removed.length)}%"       title="${removed.length} removed"></div>
      </div>

      ${propChanges > 0 ? `
        <div class="section-hdr">Severity — ${propChanges} CSS change${propChanges!==1?'s':''}</div>
        ${sevRow('Critical', critical, 'critical')}
        ${sevRow('High',     high,     'high')}
        ${sevRow('Medium',   medium,   'medium')}
        ${sevRow('Low',      low,      'low')}
      ` : '<div class="no-diffs">✓ No style differences in matched elements</div>'}

      ${added.length > 0 ? `
        <details class="el-section">
          <summary class="el-section-summary">
            <span class="badge badge-added">+${added.length}</span> Added in compare
          </summary>
          <div class="el-list">${addedRows}${addedOver}</div>
        </details>` : ''}

      ${removed.length > 0 ? `
        <details class="el-section">
          <summary class="el-section-summary">
            <span class="badge badge-removed">−${removed.length}</span> Removed from baseline
          </summary>
          <div class="el-list">${removedRows}${removedOver}</div>
        </details>` : ''}

      ${matching.ambiguousCount > 0 ? `<div class="ambiguous-note">⚠ ${matching.ambiguousCount} element${matching.ambiguousCount!==1?'s':''} had ambiguous matches</div>` : ''}

      <div class="result-actions">
        <div class="export-format-row">
          <select class="select" style="width:auto;padding:5px 8px;font-size:12px" id="export-format-select" aria-label="Export format">
            <option value="html">HTML</option>
            <option value="excel">Excel</option>
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
          </select>
          <button class="btn-ghost" id="export-comparison-btn">Export</button>
        </div>
      </div>
    </div>`;

  container.querySelector('#export-comparison-btn')
    ?.addEventListener('click', handleExport);
}

async function handleExport() {
  const state = getState();
  const result = state.comparison;
  if (!result) { Toast.error('No comparison result to export'); return; }

  const format = document.getElementById('export-format-select')?.value ?? 'html';

  if (format === 'html') {
    const htmlContent = buildHtmlExport(result);
    const res = await api.exportHTML({
      htmlContent,
      filename: `comparison-${result.baselineId}-vs-${result.compareId}.html`,
    });
    if (res.success) { Toast.success(`Saved to ${res.filePath}`); }
    else if (res.reason !== 'cancelled') { Toast.error(res.error ?? 'Export failed'); }
    return;
  }

  const payload = JSON.stringify(result, null, 2);
  const res = await api.exportFile({
    data:     payload,
    format:   format === 'excel' ? 'excel' : format,
    filename: `comparison-${Date.now()}.${format === 'excel' ? 'xlsx' : format}`,
  });
  if (res.success) { Toast.success(`Saved to ${res.filePath}`); }
  else if (res.reason !== 'cancelled') { Toast.error(res.error ?? 'Export failed'); }
}

function buildHtmlExport(result) {
  const { matching, comparison, mode, duration, baselineId, compareId } = result;
  const { summary } = comparison;
  const changed = comparison.results?.filter(r => (r.totalDifferences ?? 0) > 0) ?? [];

  const rows = changed.slice(0, 200).map(r => {
    const el  = r.baselineElement ?? r.compareElement ?? {};
    const tag = (el.tagName || '').toLowerCase();
    const sel = el.cssSelector ?? '';
    const diffs = r.differences?.map(d => sanitize(d.property)).join(', ') ?? '';
    return `<tr><td>${sanitize(tag)}</td><td title="${sanitize(sel)}">${sanitize(sel.slice(0,80))}</td><td>${diffs}</td></tr>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>UI Comparison Report</title>
  <style>body{font-family:sans-serif;padding:20px;background:#1a1a2e;color:#e2e8f0}
  h1{margin-bottom:16px}table{width:100%;border-collapse:collapse}
  th,td{border:1px solid rgba(255,255,255,.1);padding:8px;font-size:12px;text-align:left}
  th{background:#16213e}.meta{margin-bottom:16px;font-size:13px;color:#94a3b8}</style></head>
  <body>
  <h1>UI Comparison Report</h1>
  <div class="meta">
    Mode: ${sanitize(mode)} · Match rate: ${matching.matchRate}% · ${duration}ms ·
    Baseline: ${sanitize(baselineId)} vs Compare: ${sanitize(compareId)}
  </div>
  <table><thead><tr><th>Tag</th><th>Selector</th><th>Changed properties</th></tr></thead>
  <tbody>${rows}</tbody></table>
  </body></html>`;
}

document.addEventListener('DOMContentLoaded', async () => {
  // 0.2a — IDB must be open before any storage call; failure is session-fatal
  try {
    await storage.applyPendingOperations();
    console.info('[BOOT] storage ready');
  } catch (initErr) {
    console.error('[BOOT] storage init failed — halting', initErr);
    document.body.innerHTML =
      `<div style="padding:32px;font-family:sans-serif;color:#ef4444">
         <strong>Storage failed to initialise:</strong> ${initErr.message}<br>
         <small>Close other tabs or windows using this app and reload.</small>
       </div>`;
    return;
  }

  await loadAndRenderReports();

  document.querySelectorAll('[role="tab"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('[role="tab"]').forEach(t => {
        const active = t.dataset.tab === tab;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', String(active));
      });
      document.querySelectorAll('[role="tabpanel"]').forEach(p => {
        p.hidden = p.id !== `panel-${tab}`;
        p.classList.toggle('active', p.id === `panel-${tab}`);
      });
    });
  });

  const extractBtn = document.getElementById('extract-btn');
  const urlInput   = document.getElementById('url-input');

  if (extractBtn && urlInput) {
    extractBtn.addEventListener('click', async () => {
      const url = urlInput.value.trim();
      if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
        setError('extract', 'Enter a valid URL starting with http:// or https://');
        return;
      }
      setError('extract', '');
      extractBtn.disabled    = true;
      extractBtn.textContent = 'Extracting…';
      showProgress('extract', 'Starting…');

      try {
        const result = await api.extractElements({ url, options: {} });

        if (!result.success) {
          setError('extract', result.error ?? 'Extraction failed');
          return;
        }

        const report = Object.assign({}, result.report, {
          id:        result.report.id        ?? crypto.randomUUID(),
          timestamp: result.report.timestamp ?? new Date().toISOString(),
          url:       result.report.url       ?? url,
        });

        // 0.2c: structured clone strips prototype chains — verify id survived as own property
        if (!report.id) {
          console.error('[SAVE] report.id missing after IPC — aborting save to prevent orphaned record');
          setError('extract', 'Report ID lost in transit — please retry');
          return;
        }

        await storage.saveReport(report);
        console.info('[SAVE] report saved:', report.id);
        await loadAndRenderReports();
        Toast.success(`Extracted ${report.totalElements ?? 0} elements`);

      } catch (err) {
        setError('extract', err.message ?? 'Unexpected error');
      } finally {
        extractBtn.disabled    = false;
        extractBtn.textContent = 'Extract Elements';
        hideProgress('extract');
      }
    });
  }

  api.onExtractionProgress((data) => {
    updateProgress('extract', data.pct, data.label);
  });

  const baselineSel = document.getElementById('baseline-report');
  const compareSel  = document.getElementById('compare-report');

  if (baselineSel) {
    baselineSel.addEventListener('change', e => {
      dispatch('BASELINE_SELECTED', { id: e.target.value });
      syncCompareButton();
      tryLoadCachedComparison();
    });
  }

  if (compareSel) {
    compareSel.addEventListener('change', e => {
      dispatch('COMPARE_SELECTED', { id: e.target.value });
      syncCompareButton();
      tryLoadCachedComparison();
    });
  }

  document.querySelectorAll('[name="compare-mode"]').forEach(r => {
    r.addEventListener('change', e => {
      if (e.target.checked) {
        dispatch('MODE_CHANGED', { mode: e.target.value });
        tryLoadCachedComparison();
      }
    });
  });

  const compareBtn = document.getElementById('compare-btn');
  if (compareBtn) {
    compareBtn.addEventListener('click', handleComparison);
  }

  subscribe((state) => {
    if (state.comparison && state.phase === 'done') {
      displayComparisonResults(state.comparison);
    }
  });
});

async function tryLoadCachedComparison() {
  const state = getState();
  if (!state.selectedBaseline || !state.selectedCompare) { return; }

  try {
    const cached = await storage.loadComparisonByPair(
      state.selectedBaseline,
      state.selectedCompare,
      state.compareMode ?? 'dynamic'
    );
    if (cached) {
      const reconstructed = {
        baselineId:        cached.baselineId,
        compareId:         cached.compareId,
        mode:              cached.mode,
        matching:          cached.matching,
        comparison:        { summary: cached.summary, results: cached.results ?? [] },
        unmatchedElements: cached.unmatchedElements,
        duration:          cached.duration ?? 0,
      };
      dispatch('COMPARISON_COMPLETE', { result: reconstructed });
      displayComparisonResults(reconstructed, cached.timestamp);
    } else {
      document.getElementById('compare-results').innerHTML = '';
      dispatch('COMPARISON_COMPLETE', { result: null });
    }
  } catch (err) {
    // [BONUS] silent catch was masking IDB read failures and malformed stored comparisons
    console.warn('[BONUS] tryLoadCachedComparison error (non-fatal):', err?.message ?? err);
  }
}

async function handleComparison() {
  const state = getState();
  const reports = state.reports ?? [];

  const baselineReport = reports.find(r => r.id === state.selectedBaseline);
  const compareReport  = reports.find(r => r.id === state.selectedCompare);

  if (!baselineReport || !compareReport) {
    setError('compare', 'Select both baseline and compare reports');
    return;
  }
  if (baselineReport.id === compareReport.id) {
    setError('compare', 'Select two different reports');
    return;
  }

  setError('compare', '');
  const compareBtn = document.getElementById('compare-btn');
  compareBtn.disabled    = true;
  compareBtn.textContent = 'Comparing…';
  showProgress('compare', 'Starting…');
  dispatch('COMPARISON_STARTED', {});

  const mode              = document.querySelector('[name="compare-mode"]:checked')?.value ?? 'dynamic';
  const includeScreenshots = document.getElementById('visual-diff-toggle')?.checked ?? true;

  const off = api.onComparisonProgress((data) => {
    updateProgress('compare', data.pct, data.label);
  });

  try {
    // 0.2d — Renderer loads elements; sending arrays in payload is the only
    // physically possible flow because window.indexedDB is unavailable in the main process
    const baselineElements = await storage.loadReportElements(baselineReport.id);
    const compareElements  = await storage.loadReportElements(compareReport.id);

    if (!baselineElements?.length) {
      setError('compare', 'Baseline report has no stored elements — re-extract the page first');
      dispatch('COMPARISON_ERROR', { error: 'No baseline elements in IDB' });
      return;
    }
    if (!compareElements?.length) {
      setError('compare', 'Compare report has no stored elements — re-extract the page first');
      dispatch('COMPARISON_ERROR', { error: 'No compare elements in IDB' });
      return;
    }

    const result = await api.startComparison({
      baselineId:      baselineReport.id,
      compareId:       compareReport.id,
      mode,
      baselineUrl:     baselineReport.url,
      compareUrl:      compareReport.url,
      baselineElements,
      compareElements,
      includeScreenshots,
    });

    if (!result.success) {
      dispatch('COMPARISON_ERROR', { error: result.error ?? 'Comparison failed' });
      setError('compare', result.error ?? 'Comparison failed');
      Toast.error(result.error ?? 'Comparison failed');
      return;
    }

    const sr = result.result;

    const meta = {
      id:                crypto.randomUUID(),
      pairKey:           `${sr.baselineId}_${sr.compareId}_${sr.mode}`,
      baselineId:        sr.baselineId,
      compareId:         sr.compareId,
      mode:              sr.mode,
      matching:          sr.matching,
      summary:           sr.comparison?.summary,
      unmatchedElements: sr.unmatchedElements,
      duration:          sr.duration,
      timestamp:         sr.completedAt ?? new Date().toISOString(),
    };

    await storage.saveComparison(meta, sr.comparison?.results ?? []);

    dispatch('COMPARISON_COMPLETE', { result: sr });

    const diffs = sr.comparison?.summary?.propertyDiffCount
               ?? sr.comparison?.summary?.totalDifferences
               ?? 0;
    Toast.success(`Done — ${diffs} CSS change${diffs !== 1 ? 's' : ''} found`);

  } catch (err) {
    dispatch('COMPARISON_ERROR', { error: err.message });
    setError('compare', err.message ?? 'Unexpected error');
    Toast.error(err.message ?? 'Comparison failed');
  } finally {
    off();
    compareBtn.disabled    = false;
    compareBtn.textContent = 'Compare Reports';
    hideProgress('compare');
  }
}