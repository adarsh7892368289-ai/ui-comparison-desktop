import logger from '../../../infrastructure/logger.js';
import storage from '../../../infrastructure/idb-repository.js';
import { transformToGroupedReport } from '../shared/report-transformer.js';

async function exportToHTML(comparisonResult) {
  try {
    const grouped          = transformToGroupedReport(comparisonResult);
    const manifest         = resolveVisualManifest(comparisonResult.visualDiffs ?? null);
    const visualDiffStatus = comparisonResult.visualDiffStatus ?? null;
    const blobData         = await loadBlobData(manifest);
    const html             = buildDocument(grouped, comparisonResult, manifest, blobData, visualDiffStatus);
    await triggerDownload(html, `comparison-${Date.now()}.html`);
    logger.info('HTML export complete', {
      elements:         grouped.summary.totalMatched,
      impactScore:      grouped.summary.impactScore,
      rootCauses:       grouped.summary.rootCauseCount,
      visualDiffs:      Object.keys(manifest).length,
      blobsEmbedded:    Object.keys(blobData).length,
      visualDiffStatus: visualDiffStatus?.status ?? 'none'
    });
    return { success: true };
  } catch (error) {
    logger.error('HTML export failed', { error: error.message });
    return { success: false, error: error.message };
  }
}

function resolveVisualManifest(visualDiffs) {
  if (!visualDiffs) { return {}; }
  const out     = Object.create(null);
  const entries = visualDiffs instanceof Map ? visualDiffs.entries() : Object.entries(visualDiffs);
  for (const [key, entry] of entries) {
    const { baseline, compare, diffs } = entry ?? {};
    if (!baseline && !compare) { continue; }
    out[key] = {
      baselineKeyframeId:        baseline?.keyframeId         ?? null,
      baselineRect:              baseline?.viewportRect        ?? null,
      baselineRawRect:           baseline?.rawViewportRect     ?? null,
      baselineActualDPR:         baseline?.dpr ?? 2,
      baselineDocumentY:         baseline?.documentY           ?? null,
      baselineDocumentHeight:    baseline?.totalDocumentHeight ?? null,
      baselineKfScrollY:         baseline?.kfScrollY           ?? null,
      baselinePseudoBefore:      baseline?.pseudoBefore        ?? null,
      baselinePseudoAfter:       baseline?.pseudoAfter         ?? null,
      baselineMisaligned:        baseline?.misaligned          ?? false,
      baselineMisalignReason:    baseline?.misalignReason      ?? null,
      baselineSelectorAmbiguous: baseline?.selectorAmbiguous   ?? false,
      baselineSelectorMatchCount:baseline?.selectorMatchCount  ?? null,
      baselineRectClipped:       baseline?.rectClipped         ?? false,
      compareKeyframeId:         compare?.keyframeId          ?? null,
      compareRect:               compare?.viewportRect         ?? null,
      compareRawRect:            compare?.rawViewportRect      ?? null,
      compareActualDPR:          compare?.dpr  ?? 2,
      compareDocumentY:          compare?.documentY            ?? null,
      compareDocumentHeight:     compare?.totalDocumentHeight  ?? null,
      compareKfScrollY:          compare?.kfScrollY            ?? null,
      comparePseudoBefore:       compare?.pseudoBefore         ?? null,
      comparePseudoAfter:        compare?.pseudoAfter          ?? null,
      compareMisaligned:         compare?.misaligned           ?? false,
      compareMisalignReason:     compare?.misalignReason       ?? null,
      compareSelectorAmbiguous:  compare?.selectorAmbiguous    ?? false,
      compareSelectorMatchCount: compare?.selectorMatchCount   ?? null,
      compareRectClipped:        compare?.rectClipped          ?? false,
      diffs:                     diffs ?? []
    };
  }
  return out;
}

async function blobToDataUri(blob) {
  const buf   = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  let binary  = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${blob.type || 'image/webp'};base64,${btoa(binary)}`;
}

async function loadBlobData(manifest) {
  const ids = new Set();
  for (const entry of Object.values(manifest)) {
    if (entry.baselineKeyframeId) {ids.add(entry.baselineKeyframeId);}
    if (entry.compareKeyframeId)  {ids.add(entry.compareKeyframeId);}
  }
  const out = Object.create(null);
  for (const id of ids) {
    const blob = await storage.loadVisualBlob(id);
    if (blob) {out[id] = await blobToDataUri(blob);}
  }
  return out;
}

async function triggerDownload(html, filename) {
  const bytes = new TextEncoder().encode(html);
  const chunk = 0x8000;
  let binary  = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const url = `data:text/html;base64,${btoa(binary)}`;
  await chrome.downloads.download({ url, filename, saveAs: false });
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildDiagnosticBanner(vds) {
  if (!vds || vds.status === 'success' || vds.status === 'completed' || vds.status === 'devtools-blocked') { return ''; }
  const isFailed  = vds.status === 'failed';
  const bg        = isFailed ? '#7f1d1d' : '#78350f';
  const border    = isFailed ? '#ef4444' : '#f97316';
  const iconLabel = isFailed ? '\u2716 Visual Capture Failed' : '\u26a0 Visual Diff Skipped';
  const hint      = isFailed
    ? 'Close DevTools on both pages and run the comparison again.'
    : 'Screenshots not available \u2014 property diffs are still complete.';
  return `<div style="position:sticky;top:0;z-index:9999;background:${bg};border-bottom:3px solid ${border};padding:10px 16px;display:flex;align-items:flex-start;gap:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;">
  <span style="font-weight:800;color:#fff;white-space:nowrap;">${iconLabel}</span>
  <span style="flex:1;" class="u-text-secondary">${esc(vds.reason || 'No reason provided.')}</span>
  <span class="u-text-tertiary" style="font-size:11px;white-space:nowrap;">${hint}</span>
</div>`;
}

function buildPreFlightBanner(w) {
  if (!w || w.classification !== 'CAUTION') { return ''; }
  const { mismatchDelta, estimatedFalseNegatives } = w;
  const parts = [];
  if (mismatchDelta?.hash)        {parts.push(`SPA hash mismatch: <code>${esc(mismatchDelta.hash.baseline)}</code> vs <code>${esc(mismatchDelta.hash.compare)}</code>`);}
  if (mismatchDelta?.queryParams) {parts.push(`Query differences: ${mismatchDelta.queryParams.map(p => esc(p.key)).join(', ')}`);}
  const fn = estimatedFalseNegatives !== null ? ` ~${estimatedFalseNegatives} false negatives estimated.` : '';
  return `<div style="position:sticky;top:0;z-index:9998;background:#1e3a5f;border-bottom:3px solid #3b82f6;padding:10px 16px;display:flex;align-items:flex-start;gap:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;">
  <span style="font-weight:800;color:#93c5fd;white-space:nowrap;">\u26a0 Page State Mismatch</span>
  <span style="flex:1;" class="u-text-secondary">${parts.join(' \u00b7 ')}${fn}</span>
</div>`;
}

function buildModalHtml() {
  return `<div id="vdiff-modal" class="vdiff-modal" aria-modal="true" role="dialog" hidden>
  <div class="vdiff-modal__header">
    <span class="vdiff-modal__title"></span>
    <div class="vdiff-modal__controls">
      <button data-action="ghost" title="Ghost overlay: superimpose compare screenshot over baseline"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="7" r="5.5" stroke="currentColor" stroke-width="1.4"/><ellipse cx="5.5" cy="12.5" rx="1.5" ry="1" fill="currentColor" opacity=".5"/><ellipse cx="8" cy="13.5" rx="1.5" ry="1" fill="currentColor" opacity=".7"/><ellipse cx="10.5" cy="12.5" rx="1.5" ry="1" fill="currentColor" opacity=".5"/><circle cx="6.2" cy="6.5" r="1" fill="currentColor"/><circle cx="9.8" cy="6.5" r="1" fill="currentColor"/></svg><span class="ctrl-label">Ghost</span></button>
      <button data-action="sync" title="Scroll lock: keep both panes in sync while scrolling" class="active"><svg class="sync-icon-on" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 8h8M9 5l3 3-3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 5L4 8l3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg><svg class="sync-icon-off" width="16" height="16" viewBox="0 0 16 16" fill="none" style="display:none"><path d="M3 6h4M9 10h4M12 4l2 2-2 2M4 14l-2-2 2-2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".4"/></svg><span class="ctrl-label">Scroll Lock</span></button>
      <button data-action="zoom-out" title="Zoom out"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4"/><line x1="4.5" y1="7" x2="9.5" y2="7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
      <button data-action="zoom-in" title="Zoom in"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4"/><line x1="7" y1="4.5" x2="7" y2="9.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="4.5" y1="7" x2="9.5" y2="7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
      <button data-action="close" title="Close workbench (Esc)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
    </div>
  </div>
  <div class="vdiff-modal__panes">
    <div class="vdiff-pane vdiff-pane--baseline">
      <div class="vdiff-pane__label">BASELINE<button class="pane-expand" data-pane="baseline" title="Focus this pane"><svg class="icon-expand" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M7.5 1.5H10.5V4.5M4.5 10.5H1.5V7.5M10.5 1.5L7 5M1.5 10.5L5 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg><svg class="icon-collapse" width="12" height="12" viewBox="0 0 12 12" fill="none" style="display:none"><path d="M9.5 3L6.5 6M6.5 6V3.5M6.5 6H9M2.5 9L5.5 6M5.5 6V8.5M5.5 6H3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
      <div class="vdiff-pane__scroll-container" data-pane="baseline">
        <div class="vdiff-pane__content">
          <img class="vdiff-screenshot" data-role="baseline" decoding="async" alt="Baseline screenshot">
          <svg class="vdiff-svg-overlay" data-role="baseline" aria-hidden="true"></svg>
          <div class="vdiff-ghost" hidden></div>
        </div>
      </div>
    </div>
    <div class="vdiff-pane vdiff-pane--compare">
      <div class="vdiff-pane__label">COMPARE<button class="pane-expand" data-pane="compare" title="Focus this pane"><svg class="icon-expand" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M7.5 1.5H10.5V4.5M4.5 10.5H1.5V7.5M10.5 1.5L7 5M1.5 10.5L5 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg><svg class="icon-collapse" width="12" height="12" viewBox="0 0 12 12" fill="none" style="display:none"><path d="M9.5 3L6.5 6M6.5 6V3.5M6.5 6H9M2.5 9L5.5 6M5.5 6V8.5M5.5 6H3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
      <div class="vdiff-pane__scroll-container" data-pane="compare">
        <div class="vdiff-pane__content">
          <img class="vdiff-screenshot" data-role="compare" decoding="async" alt="Compare screenshot">
          <svg class="vdiff-svg-overlay" data-role="compare" aria-hidden="true"></svg>
        </div>
      </div>
    </div>
  </div>
  <div id="vdiff-tooltip" class="vdiff-tooltip" hidden></div>
</div>`;
}

function buildDevToolsBanner(warnings) {
  if (!warnings || warnings.length === 0) { return ''; }
  const details = warnings.map(w =>
    `<span style="display:block;margin-top:4px;">${esc(w.role)} tab: DevTools was open (viewport reduced to ${esc(String(w.originalHeight))}px). Screenshots taken at ${esc(String(w.bypassHeight))}px using virtual viewport override.</span>`
  ).join('');
  return `<div style="position:sticky;top:0;z-index:9998;background:#1e3a5f;border-bottom:3px solid #3b82f6;padding:10px 16px;display:flex;align-items:flex-start;gap:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;">
  <span style="font-weight:800;color:#93c5fd;white-space:nowrap;">&#8505; DevTools Detected &#8212; Capture Bypassed Successfully</span>
  <span style="flex:1;" class="u-text-secondary">${details}<span style="display:block;margin-top:4px;font-size:11px;color:#bfdbfe;">Results are accurate. Closing DevTools before capture is not required.</span></span>
</div>`;
}

function buildDocument(grouped, raw, manifest, blobData, visualDiffStatus) {
  const { summary } = grouped;
  const title = `${raw.baseline?.url ?? ''} vs ${raw.compare?.url ?? ''}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>UI Diff \u2014 ${esc(title)}</title>
<style>${buildCss()}</style>
</head>
<body>
${buildDiagnosticBanner(visualDiffStatus)}${buildDevToolsBanner(raw.devToolsWarnings ?? [])}${buildPreFlightBanner(raw.preFlightWarning ?? null)}<div class="app">
  <header class="topbar">
    <span class="topbar-title">UI Comparison</span>
    <div class="topbar-direction" title="Comparison direction">&#x25B6; ${esc(raw.baseline?.url ? new URL(raw.baseline.url).hostname : 'Baseline')} &#x2192; ${esc(raw.compare?.url ? new URL(raw.compare.url).hostname : 'Compare')}</div>
    <div class="topbar-urls">
      <div class="topbar-url baseline-url" title="${esc(raw.baseline?.url||'')}"><span class="url-label">B</span>${esc(raw.baseline?.url||'Baseline')}</div>
      <div class="topbar-url compare-url" title="${esc(raw.compare?.url||'')}"><span class="url-label">C</span>${esc(raw.compare?.url||'Compare')}</div>
    </div>
    <div class="topbar-search"><input id="search" type="text" placeholder="Filter elements\u2026" autocomplete="off"></div>
  </header>
  <div class="layout">
    <div class="activity-bar" id="activity-bar-left">
      <button class="activity-btn" id="panel-left-btn" title="Toggle diff tree" aria-label="Toggle diff tree"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1.5" y="1.5" width="15" height="15" rx="2.5" stroke="currentColor" stroke-width="1.4"/><line x1="6.5" y1="1.5" x2="6.5" y2="16.5" stroke="currentColor" stroke-width="1.4"/><line x1="9" y1="6" x2="14" y2="6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="9" y1="9" x2="14" y2="9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="9" y1="12" x2="14" y2="12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></button>
      <button class="activity-btn" id="panel-summary-btn" title="Executive Summary" aria-label="Executive Summary"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1.5" y="9.5" width="3.5" height="7" rx="1" fill="currentColor"/><rect x="7.25" y="5.5" width="3.5" height="11" rx="1" fill="currentColor"/><rect x="13" y="1.5" width="3.5" height="15" rx="1" fill="currentColor"/><line x1="1" y1="17" x2="17" y2="17" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></button>
    </div>
    <div class="sidebar-wrapper"><aside class="sidebar" id="diff-panel">${buildSidebar(summary, raw)}</aside><div id="summary-panel"></div></div>
    <div class="resize-handle" id="resize-left" title="Drag to resize"></div>
    <main class="center-panel">
      <div class="tree-toolbar">
        <button class="toolbar-btn" id="expand-all-btn">\u25BC Expand All</button>
        <button class="toolbar-btn" id="collapse-all-btn">\u25BA Collapse All</button>
        <span class="tree-count" id="tree-count"></span>
      </div>
      <div class="tree-panel" id="tree-panel">
        <div class="list-loading" id="list-loading"><div class="list-spinner"></div><span>Building tree\u2026</span></div>
      </div>
    </main>
    <div class="resize-handle" id="resize-right" title="Drag to resize"></div>
    <aside class="panel-detail" id="panel-detail">
      <div class="detail-empty-state" id="detail-empty-state">
        <div class="detail-empty-icon">\u{1F50D}</div>
        <div class="detail-empty-text">Select an element to inspect</div>
        <div class="detail-empty-sub">Click any node in the tree to view screenshots and property diffs</div>
      </div>
    </aside>
  </div>
</div>
${buildModalHtml()}
<script>${buildJs(grouped, manifest, blobData, raw)}</script>
</body>
</html>`;
}

function buildSidebar(s, raw) {
  const bar         = Math.round(s.matchRate ?? 0);
  const sev         = s.severityBreakdown ?? { critical: 0, high: 0, medium: 0, low: 0 };
  const cmpHost     = (() => { try { return new URL(raw?.compare?.url ?? '').hostname; } catch { return 'Compare'; } })();
  const baseHost    = (() => { try { return new URL(raw?.baseline?.url ?? '').hostname; } catch { return 'Baseline'; } })();
  const suppInfo    = s.suppressedChildCount > 0
    ? `<div class="stat-row stat-row--subdued" title="${s.suppressedChildCount} child elements absorbed into parent diffs (CSS cascade suppression)"><span class="icon">\u2514</span> +${s.suppressedChildCount} cascaded</div>`
    : '';
  return `
<div class="sidebar-section">
  <div class="stat-headline">${bar}%</div>
  <div class="stat-label">Match Rate</div>
  <div class="progress-bar"><div class="progress-fill" style="width:${bar}%"></div></div>
</div>
<div class="sidebar-section">
  <div class="sidebar-section-label">Severity \u2014 ${s.modified ?? 0} element${(s.modified ?? 0) !== 1 ? 's' : ''}</div>
  <div class="stat-row sev-critical"><span class="badge badge-critical">${sev.critical ?? 0}</span> Critical</div>
  <div class="stat-row sev-high"><span class="badge badge-high">${sev.high ?? 0}</span> High</div>
  <div class="stat-row sev-medium"><span class="badge badge-medium">${sev.medium ?? 0}</span> Medium</div>
  <div class="stat-row sev-low"><span class="badge badge-low">${sev.low ?? 0}</span> Low</div>
</div>
<div class="sidebar-section">
  <div class="stat-row"><span class="icon">\u2756</span> ${s.totalMatched} Matched</div>
  <div class="stat-row sev-modified"><span class="icon mod">\u25d0</span> ${s.modified ?? 0} Modified</div>
  ${suppInfo}
  <div class="stat-row"><span class="icon add">\uff0b</span> ${s.added} Only in ${esc(cmpHost)}</div>
  <div class="stat-row"><span class="icon rem">\uff0d</span> ${s.removed} Only in ${esc(baseHost)}</div>
  <div class="stat-row"><span class="icon">\u25cb</span> ${s.unchanged} Unchanged</div>
  <div class="stat-row"><span class="icon amb">\u25c6</span> ${s.ambiguous} Ambiguous</div>
</div>
<div class="sidebar-section filter-buttons">
  <div class="filter-label">Severity</div>
  <button class="filter-btn active" data-sev="all">All</button>
  <button class="filter-btn" data-sev="critical">Critical</button>
  <button class="filter-btn" data-sev="high">High</button>
  <button class="filter-btn" data-sev="medium">Medium</button>
  <button class="filter-btn" data-sev="low">Low</button>
  <button class="filter-btn" data-sev="added">Only Compare</button>
  <button class="filter-btn" data-sev="removed">Only Baseline</button>
</div>
<div class="sidebar-section filter-buttons">
  <div class="filter-label">Category</div>
  <button class="filter-btn active" data-cat="all">All</button>
  <button class="filter-btn" data-cat="layout">Layout</button>
  <button class="filter-btn" data-cat="visual">Visual</button>
  <button class="filter-btn" data-cat="typography">Typography</button>
  <button class="filter-btn" data-cat="spacing">Spacing</button>
</div>`;
}

function buildCss() {
  return `
:root{
  --bg-base:#0d1117;
  --bg-surface:#161b22;
  --bg-elevated:#1c2128;
  --bg-raised:#22272e;
  --bg-hover:rgba(255,255,255,.05);
  --bg-active:rgba(255,255,255,.08);
  --bg-selected:rgba(109,40,217,.12);

  --border-subtle:rgba(255,255,255,.07);
  --border-default:rgba(255,255,255,.12);
  --border-strong:rgba(255,255,255,.22);
  --border-focus:#7c3aed;

  --text-primary:#e6edf3;
  --text-secondary:#8d96a0;
  --text-tertiary:#6e7681;
  --text-muted:#6e7681;
  --text-faint:#3d444d;
  --text-disabled:#484f58;

  --accent:#7c3aed;
  --accent-light:#a78bfa;
  --accent-muted:rgba(124,58,237,.12);
  --accent-faint:rgba(109,40,217,.14);
  --accent-border:rgba(124,58,237,.35);

  --red-text:#f47474;
  --red-bg:rgba(239,68,68,.09);
  --red-border:rgba(239,68,68,.22);
  --green-text:#3fb950;
  --green-bg:rgba(63,185,80,.08);
  --green-border:rgba(63,185,80,.2);
  --amber-text:#d29922;
  --amber-bg:rgba(210,153,34,.09);

  --tree-indent-guide:rgba(255,255,255,.05);
  --tree-row-selected-bg:rgba(109,40,217,.12);
  --tree-row-selected-border:#7c3aed;
  --tree-row-hover-bg:rgba(255,255,255,.04);
  --tree-structural-fg:#6b7d8a;
  --tree-diff-fg:#c7d2fe;

  --sev-critical-bg:#300d0d;
  --sev-critical-fg:#f47474;
  --sev-critical-border:rgba(239,68,68,.28);
  --sev-high-bg:#2d1500;
  --sev-high-fg:#fb923c;
  --sev-high-border:rgba(249,115,22,.28);
  --sev-medium-bg:#221600;
  --sev-medium-fg:#e3b341;
  --sev-medium-border:rgba(227,179,65,.25);
  --sev-low-bg:#131d2e;
  --sev-low-fg:#79c0ff;
  --sev-low-border:rgba(121,192,255,.22);
}

*{box-sizing:border-box;margin:0;padding:0}

body{
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  background:var(--bg-base);color:var(--text-primary);
  font-size:13px;line-height:1.5;letter-spacing:-0.006em;font-weight:400;
  height:100vh;overflow:hidden;
  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;
}
.app{display:flex;flex-direction:column;height:100vh}

.topbar{
  display:flex;align-items:center;gap:12px;padding:0 16px;
  background:var(--bg-surface);
  border-bottom:1px solid var(--border-subtle);
  box-shadow:0 1px 0 var(--border-subtle);
  flex-shrink:0;min-height:46px;
}
.topbar-title{font-weight:800;font-size:14px;color:var(--text-primary);letter-spacing:-0.02em;white-space:nowrap}
.topbar-urls{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0;overflow:hidden}
.topbar-url{
  font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;line-height:1.5;display:flex;align-items:center;gap:5px;
  font-variant-numeric:tabular-nums;
}
.topbar-url:hover{color:var(--text-secondary)}
.baseline-url{color:var(--text-secondary)}
.compare-url{color:var(--text-secondary)}
.url-label{font-size:9px;font-weight:700;letter-spacing:.08em;padding:1px 4px;border-radius:3px;flex-shrink:0;text-transform:uppercase}
.baseline-url .url-label{background:#0c1a2e;color:#60a5fa;border:1px solid #1d3a5f}
.compare-url .url-label{background:#0c1f12;color:#3fb950;border:1px solid #145522}
.topbar-direction{
  font-size:11px;color:var(--accent-light);background:var(--accent-faint);
  border:1px solid var(--accent-border);border-radius:20px;padding:2px 10px;
  white-space:nowrap;flex-shrink:0;font-weight:600;letter-spacing:.01em;
  font-variant-numeric:tabular-nums;
}
#search{
  background:var(--bg-elevated);border:1px solid var(--border-default);
  color:var(--text-primary);border-radius:6px;
  padding:5px 10px 5px 30px;font-size:12px;outline:none;
  min-width:200px;max-width:280px;
  transition:border-color .08s,background .08s;
}
#search:focus{border-color:var(--accent);background:var(--bg-raised)}
#search::placeholder{color:var(--text-faint)}

.layout{display:grid;grid-template-columns:36px var(--col-left,280px) 4px 1fr 4px var(--col-right,0px);grid-template-rows:1fr;flex:1;min-height:0;overflow:hidden}
.sidebar-wrapper{position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.resize-handle{background:var(--border-subtle);cursor:col-resize;transition:background .08s;z-index:5;user-select:none}
.resize-handle:hover,.resize-handle.dragging{background:var(--border-strong)}
.sidebar{overflow-y:auto;padding:14px 12px;background:var(--bg-surface);border-right:1px solid var(--border-subtle);position:relative}
.layout.sidebar-collapsed{grid-template-columns:36px 0 4px 1fr 4px var(--col-right,0px)}
.layout.sidebar-collapsed .sidebar-wrapper{overflow:hidden;min-width:0;width:0}
.layout.sidebar-collapsed #resize-left{pointer-events:none;opacity:0}
.layout.detail-empty #resize-right{pointer-events:none;opacity:0}

.activity-bar{display:flex;flex-direction:column;align-items:center;padding:8px 0;background:var(--bg-base);border-right:1px solid var(--border-subtle);gap:6px}
.activity-btn{background:none;border:none;color:var(--text-tertiary);cursor:pointer;padding:8px 6px;border-radius:6px;line-height:1;transition:color .08s,background .08s;width:36px;height:36px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.activity-btn svg{display:block;flex-shrink:0}
.activity-btn:hover{color:var(--text-secondary);background:var(--bg-hover)}
.activity-btn.active{color:var(--accent-light);background:var(--accent-muted)}

.sidebar-section{margin-bottom:20px}
.stat-headline{
  font-size:36px;font-weight:800;color:var(--text-primary);
  letter-spacing:-1.5px;line-height:1;font-variant-numeric:tabular-nums;
}
.stat-label{font-size:11px;color:var(--text-muted);margin-bottom:5px;font-weight:500;letter-spacing:.02em}
.progress-bar{height:3px;background:var(--bg-raised);border-radius:2px;overflow:hidden;margin-top:8px}
.progress-fill{height:100%;background:linear-gradient(90deg,var(--accent),#06b6d4);border-radius:2px}
.stat-row{display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px;color:var(--text-secondary);font-variant-numeric:tabular-nums}

.badge{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:20px;border-radius:5px;font-size:11px;font-weight:700;padding:0 5px;border:1px solid transparent;font-variant-numeric:tabular-nums}
.badge-critical{background:var(--sev-critical-bg);color:var(--sev-critical-fg);border-color:var(--sev-critical-border)}
.badge-high{background:var(--sev-high-bg);color:var(--sev-high-fg);border-color:var(--sev-high-border)}
.badge-medium{background:var(--sev-medium-bg);color:var(--sev-medium-fg);border-color:var(--sev-medium-border)}
.badge-low{background:var(--sev-low-bg);color:var(--sev-low-fg);border-color:var(--sev-low-border)}

.sidebar-section-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-faint);margin-bottom:8px;font-weight:700}
.stat-row--subdued{opacity:.7;font-size:11px}
.icon.mod{color:var(--accent-light)}
.filter-buttons{display:flex;flex-wrap:wrap;gap:4px}

.filter-btn{
  background:transparent;border:1px solid var(--border-default);border-radius:5px;
  color:var(--text-muted);font-size:11px;font-weight:500;padding:3px 9px;cursor:pointer;
  transition:background .08s,border-color .08s,color .08s;
}
.filter-btn:hover{background:var(--bg-hover);border-color:var(--border-strong);color:var(--text-secondary)}
.filter-btn.active{background:var(--accent-faint);border-color:var(--accent-border);color:var(--accent-light);font-weight:600}
.icon{width:16px;display:inline-block;text-align:center}
.icon.add{color:#3fb950}.icon.rem{color:var(--sev-critical-fg)}.icon.amb{color:var(--amber-text)}

.center-panel{display:flex;flex-direction:column;overflow:hidden;min-width:0;min-height:0}
.tree-toolbar{display:flex;align-items:center;gap:8px;padding:0 12px;height:36px;background:var(--bg-surface);border-bottom:1px solid var(--border-subtle);flex-shrink:0}
.toolbar-btn{
  background:transparent;border:1px solid var(--border-default);border-radius:5px;
  color:var(--text-secondary);font-size:11px;height:26px;padding:0 10px;cursor:pointer;
  transition:background .08s,color .08s,border-color .08s;user-select:none;
}
.toolbar-btn:hover{background:var(--bg-hover);border-color:var(--border-strong);color:var(--text-primary)}
.tree-count{font-size:11px;color:var(--text-faint);margin-left:auto;font-variant-numeric:tabular-nums}
.tree-panel{overflow-y:auto;flex:1;background:var(--bg-base)}
.list-loading{display:flex;align-items:center;gap:10px;padding:20px;color:var(--text-tertiary);font-size:12px}
.list-spinner{width:16px;height:16px;border:2px solid var(--border-subtle);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}
@keyframes spin{to{transform:rotate(360deg)}}
.panel-detail{background:var(--bg-surface);border-left:1px solid var(--border-subtle);overflow-y:auto;overflow-x:hidden;min-width:0;min-height:0;position:relative}

.detail-empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100%;gap:10px;padding:40px 20px;text-align:center}
.detail-empty-icon{font-size:32px;opacity:.3}
.detail-empty-text{font-size:14px;color:var(--text-tertiary);font-weight:600}
.detail-empty-sub{font-size:11px;color:var(--text-disabled);line-height:1.6}

#summary-panel{display:none;flex:1;overflow-y:auto;padding:12px;background:var(--bg-surface);min-height:0}
.sidebar-wrapper.summary-active #diff-panel{display:none}
.sidebar-wrapper.summary-active #summary-panel{display:flex;flex-direction:column;flex:1;min-height:0}

.exec-summary{display:flex;flex-direction:column;gap:14px}
.exec-zone{background:var(--bg-base);border:1px solid var(--border-subtle);border-radius:8px;padding:14px}
.exec-zone-title{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);font-weight:700;margin-bottom:12px}
.impact-score-ring{display:flex;align-items:center;gap:16px}
.impact-score-number{font-size:52px;font-weight:900;line-height:1;letter-spacing:-2px;font-variant-numeric:tabular-nums}
.impact-score-number.score-great{color:#3fb950}
.impact-score-number.score-good{color:#56d364}
.impact-score-number.score-warn{color:var(--amber-text)}
.impact-score-number.score-bad{color:var(--sev-critical-fg)}
.impact-score-meta{display:flex;flex-direction:column;gap:4px}
.impact-score-label{font-size:14px;font-weight:600;color:var(--text-primary)}
.impact-score-sublabel{font-size:11px;color:var(--text-tertiary)}
.impact-chips{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
.impact-chip{background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:20px;font-size:11px;color:var(--text-secondary);padding:3px 10px;cursor:pointer;transition:background .08s,border-color .08s,color .08s}
.impact-chip:hover{background:var(--bg-hover);border-color:var(--border-strong);color:var(--text-primary)}
.impact-chip.chip-active{background:var(--accent-faint);border-color:var(--accent-border);color:var(--accent-light)}
.impact-progress{height:4px;background:var(--bg-elevated);border-radius:2px;overflow:hidden;margin-top:12px}
.impact-progress-fill{height:100%;border-radius:2px;transition:width .6s ease}
.root-cause-list{display:flex;flex-direction:column;gap:6px}
.root-cause-card{
  display:flex;align-items:flex-start;gap:10px;padding:8px 10px;
  background:var(--bg-base);border:1px solid var(--border-subtle);border-radius:6px;
  cursor:pointer;transition:border-color .08s,background .08s;position:relative;
}
.root-cause-card:hover{background:var(--bg-hover);border-color:var(--border-default)}
.root-cause-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:4px}
.root-cause-dot.sev-critical{background:var(--sev-critical-fg)}
.root-cause-dot.sev-high{background:var(--sev-high-fg)}
.root-cause-dot.sev-medium{background:var(--sev-medium-fg)}
.root-cause-dot.sev-low{background:var(--sev-low-fg)}
.root-cause-body{flex:1;min-width:0}
.root-cause-key{font-size:12px;font-family:ui-monospace,'Geist Mono','Cascadia Code','Fira Code','JetBrains Mono',monospace;color:var(--accent-light);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.root-cause-sub{font-size:11px;color:var(--text-muted);line-height:1.4;margin-top:3px}
.root-cause-arrow{font-size:14px;color:var(--text-disabled);flex-shrink:0;align-self:center;transition:color .08s}
.root-cause-card:hover .root-cause-arrow{color:var(--accent-light)}
.root-cause-empty{font-size:12px;color:var(--text-tertiary);text-align:center;padding:20px 0}

.dist-bar-outer{height:20px;border-radius:5px;overflow:hidden;display:flex;margin-bottom:10px}
.dist-segment{height:100%;transition:flex .4s ease;min-width:0;position:relative}
.dist-segment[data-cat=layout]{background:#3b82f6}
.dist-segment[data-cat=style]{background:var(--amber-text)}
.dist-segment[data-cat=content]{background:#0d9488}
.dist-segment[data-cat=dom]{background:var(--accent)}
.dist-legend{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.dist-legend-item{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-secondary);cursor:pointer}
.dist-legend-item:hover{color:var(--text-primary)}
.dist-legend-dot{width:9px;height:9px;border-radius:2px;flex-shrink:0}
.dist-count{color:var(--text-tertiary);font-size:10px;margin-left:auto;font-variant-numeric:tabular-nums}

.detail-header{padding:12px 16px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;background:var(--bg-surface)}
.detail-scroll{display:block}
.detail-body{padding:14px 16px}
.detail-narrative-badge{display:inline-flex;align-items:center;font-size:10px;font-weight:700;letter-spacing:.08em;padding:2px 7px;border-radius:4px;margin-bottom:10px;text-transform:uppercase}
.nb-insertion{background:#0f2a1a;color:#3fb950;border:1px solid #145522}
.nb-removal{background:#300d0d;color:#f47474;border:1px solid #5e1c1c}
.nb-layout{background:#0c1e3a;color:#60a5fa;border:1px solid #1d3a5f}
.nb-position{background:#1e0f2e;color:#c084fc;border:1px solid #5b2a8c}
.nb-style{background:#2a1200;color:#fb923c;border:1px solid #7c2d12}
.nb-structural{background:#161b22;color:var(--text-muted);border:1px solid var(--border-default)}
.nb-content{background:#0c2825;color:#34d399;border:1px solid #065f46}
.nb-pseudo{background:#141030;color:#a5b4fc;border:1px solid #2e2470}
.detail-tag{font-size:14px;font-weight:700;color:var(--text-primary);font-family:ui-monospace,'Geist Mono','Cascadia Code','Fira Code',monospace;word-break:break-all;line-height:1.4;margin-top:6px}
.detail-breadcrumb{font-size:11px;color:var(--text-muted);margin-top:4px;word-break:break-all;line-height:1.5}
.detail-selectors{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
.detail-note{font-size:11px;color:var(--text-tertiary);margin-top:6px;padding:4px 8px;background:var(--bg-elevated);border-radius:4px;border-left:2px solid var(--border-default);font-style:italic}
.detail-instances{font-size:11px;color:var(--green-text);margin-top:6px;padding:4px 8px;background:rgba(63,185,80,.06);border-radius:4px;border-left:2px solid rgba(63,185,80,.3)}
.detail-demotion{font-size:11px;color:#5eead4;margin-top:6px;padding:6px 8px;background:#134e4a22;border-radius:4px;border-left:2px solid #0d9488}
.detail-demotion strong{color:#99f6e4}
.sel-btn{background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:4px;color:var(--text-secondary);font-size:11px;padding:3px 8px;cursor:pointer;font-family:ui-monospace,'Geist Mono','Cascadia Code',monospace;transition:background .08s,border-color .08s}
.sel-btn:hover{background:var(--bg-raised);border-color:var(--border-strong)}.sel-sep{color:var(--border-strong);padding:0 2px;font-size:11px;align-self:center}
.detail-category{margin-bottom:14px}

.cat-title{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin-bottom:6px;padding-bottom:5px;border-bottom:1px solid var(--border-subtle);font-weight:700}

.diff-row{display:grid;grid-template-columns:110px 1fr 14px 1fr;gap:4px;align-items:baseline;padding:5px 0;font-size:12px;border-bottom:1px solid var(--border-subtle)}
.diff-row:last-child{border-bottom:none}
.diff-prop{
  color:var(--text-muted);font-family:ui-monospace,'Geist Mono','Cascadia Code','Fira Code','JetBrains Mono',monospace;
  font-size:11px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-variant-numeric:tabular-nums;
}
.diff-base{
  color:var(--red-text);font-family:ui-monospace,'Geist Mono','Cascadia Code','Fira Code','JetBrains Mono',monospace;
  word-break:break-all;font-size:11px;background:var(--red-bg);border:1px solid var(--red-border);
  padding:1px 5px;border-radius:3px;font-variant-numeric:tabular-nums;
}
.diff-compare{
  color:var(--green-text);font-family:ui-monospace,'Geist Mono','Cascadia Code','Fira Code','JetBrains Mono',monospace;
  word-break:break-all;font-size:11px;background:var(--green-bg);border:1px solid var(--green-border);
  padding:1px 5px;border-radius:3px;font-variant-numeric:tabular-nums;
}
.diff-compare.demoted{color:#5eead4}
.diff-arrow{color:var(--text-faint);text-align:center;font-size:10px}

.sev-pip{display:inline-block;width:6px;height:6px;border-radius:50%;margin-left:4px;vertical-align:middle}
.sev-pip.critical{background:var(--sev-critical-fg)}.sev-pip.high{background:var(--sev-high-fg)}.sev-pip.medium{background:var(--sev-medium-fg)}.sev-pip.low{background:var(--sev-low-fg)}
.swatch{display:inline-block;width:11px;height:11px;border-radius:2px;border:1px solid rgba(255,255,255,.2);vertical-align:middle;margin-right:3px}

.detail-breadcrumb-nav{display:flex;flex-wrap:wrap;align-items:center;gap:2px;margin-top:10px}
.crumb-item{font-size:11px;font-family:ui-monospace,'Geist Mono','Cascadia Code',monospace;color:var(--text-muted);padding:1px 5px;border-radius:3px;white-space:nowrap}
.crumb-diff{color:var(--accent-light);cursor:pointer;border:1px solid var(--accent-border);background:var(--accent-faint)}
.crumb-diff:hover{background:rgba(124,58,237,.2);color:#d8b4fe;border-color:var(--accent)}
.crumb-self{color:var(--text-primary);font-weight:600;background:var(--bg-elevated);border:1px solid var(--border-default)}
.crumb-ellipsis{color:var(--text-disabled)}
.crumb-sep{color:var(--text-faint);font-size:10px;padding:0 3px;user-select:none}

.structural-desc{font-size:12px;color:var(--text-secondary);line-height:1.7;padding:12px;background:var(--bg-hover);border-radius:6px;margin:14px 0;border-left:3px solid var(--border-default)}
.structural-expand-btn{width:100%;justify-content:center;margin-top:4px;padding:6px}
.mutation-desc{font-size:12px;color:var(--text-secondary);line-height:1.7;padding:12px;background:var(--bg-hover);border-radius:6px;margin:14px 0}
.mutation-desc strong{color:var(--text-primary)}
.ambiguous-notice{background:#2d1900;border:1px solid var(--amber-text);border-radius:8px;padding:12px 14px;margin-bottom:16px;font-size:12px;color:var(--amber-text);line-height:1.5}
.ambiguous-notice strong{display:block;margin-bottom:6px;font-size:13px}
.candidate-table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12px}
.candidate-table th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);padding:4px 8px;border-bottom:1px solid var(--border-subtle)}
.candidate-table td{color:var(--text-secondary);padding:5px 8px;border-bottom:1px solid var(--border-subtle);font-family:ui-monospace,'Geist Mono',monospace;font-variant-numeric:tabular-nums}

.cascade-expander{margin-top:12px;border:1px solid var(--border-subtle);border-radius:6px;overflow:hidden}
.cascade-header{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg-elevated);cursor:pointer;font-size:12px;color:var(--accent-light);font-weight:600;user-select:none;transition:background .08s}
.cascade-header:hover{background:var(--bg-raised)}
.cascade-chevron{font-size:9px;transition:transform .15s ease}
.cascade-body{padding:6px 10px;border-top:1px solid var(--border-subtle)}
.cascade-child-row{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid var(--border-subtle);font-size:11px}
.cascade-child-row:last-child{border-bottom:none}
.cascade-child-key{color:var(--text-secondary);font-family:ui-monospace,'Geist Mono',monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cascade-child-type{color:#818cf8;font-size:10px;font-weight:700;background:#1e1b4b;border-radius:3px;padding:1px 5px;letter-spacing:.04em;white-space:nowrap}
.cascade-child-props{color:var(--text-tertiary);font-family:ui-monospace,'Geist Mono',monospace;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px}

.minimap-rail-wrap{width:10px;flex-shrink:0;background:var(--bg-base);border:1px solid var(--border-subtle);border-radius:3px;position:relative;overflow:hidden}
.minimap-dot{position:absolute;left:50%;transform:translate(-50%,-50%);width:6px;height:6px;border-radius:50%;background:var(--sev-critical-fg);box-shadow:0 0 4px rgba(239,68,68,.5);transition:top .2s}
.minimap-container{display:flex;gap:8px;padding:10px 16px 8px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;align-items:stretch;min-height:52px}
.minimap-meta{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:3px}
.minimap-pos{font-size:11px;color:var(--text-tertiary);font-variant-numeric:tabular-nums}
.minimap-pos strong{color:var(--text-secondary);font-variant-numeric:tabular-nums}

.vdiff-inline{margin:0 16px 14px;border:1px solid var(--border-subtle);border-radius:8px;overflow:hidden;flex-shrink:0}
.vdiff-inline-header{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;background:var(--bg-elevated);border-bottom:1px solid var(--border-subtle)}
.vdiff-inline-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--accent-light);font-weight:700}
.vdiff-open-btn{background:var(--accent-faint);border:1px solid var(--accent-border);border-radius:5px;color:var(--accent-light);font-size:11px;font-weight:600;padding:4px 10px;cursor:pointer;transition:background .08s,border-color .08s}
.vdiff-open-btn:hover{background:rgba(124,58,237,.22);border-color:var(--accent)}
.vdiff-thumb-grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--border-subtle)}
.vdiff-thumb-col{background:#080a10;display:flex;flex-direction:column}
.vdiff-pane-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;padding:6px 10px;font-weight:700;flex-shrink:0}
.vdiff-pane-label.label-baseline{color:#60a5fa}
.vdiff-pane-label.label-compare{color:#3fb950}
.vdiff-thumb-wrap{position:relative;overflow:hidden;width:100%;background:#080a10;min-height:60px;max-height:320px !important}
.vdiff-thumb-wrap.loading::before{content:'';display:block;position:absolute;inset:0;background:linear-gradient(90deg,#1a1d27 25%,#252836 50%,#1a1d27 75%);background-size:200% 100%;animation:thumb-shimmer 1.2s infinite linear;border-radius:4px}
.vdiff-thumb-wrap[data-misaligned]::after{content:'';position:absolute;inset:0;border:2px solid #f59e0b;pointer-events:none;z-index:3}
.vdiff-misalign-badge{position:absolute;bottom:4px;left:4px;right:4px;background:rgba(245,158,11,0.92);color:#1a1200;font-size:10px;font-weight:600;padding:3px 6px;border-radius:3px;text-align:center;z-index:4;pointer-events:none}
@keyframes thumb-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.vdiff-thumb{display:block;transform-origin:top left}
.vdiff-thumb-svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:2}
.vdiff-missing{display:flex;align-items:center;justify-content:center;height:80px;color:var(--text-disabled);font-size:11px}

.vdiff-modal{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.88);display:flex;flex-direction:column;backdrop-filter:blur(4px)}
.vdiff-modal[hidden]{display:none}
.vdiff-modal__header{display:flex;align-items:center;gap:12px;padding:10px 16px;background:var(--bg-surface);border-bottom:1px solid var(--border-subtle);flex-shrink:0}
.vdiff-modal__title{font-size:13px;color:var(--accent-light);font-family:ui-monospace,'Geist Mono',monospace;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vdiff-modal__controls{display:flex;gap:4px;align-items:center;flex-shrink:0}
.vdiff-modal__controls button{background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:6px;color:var(--text-tertiary);font-size:11px;padding:5px 10px;cursor:pointer;transition:background .08s,color .08s,border-color .08s;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.vdiff-modal__controls button:hover{background:var(--bg-raised);color:var(--text-primary);border-color:var(--border-strong)}
.vdiff-modal__controls button.active{background:var(--accent-faint);border-color:var(--accent-border);color:var(--accent-light)}
.vdiff-modal__controls [data-action=ghost].active{background:rgba(99,102,241,.15);border-color:rgba(99,102,241,.4);color:#a5b4fc}
.vdiff-modal__controls [data-action=close]{background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.3);color:var(--sev-critical-fg)}
.vdiff-modal__controls [data-action=close]:hover{background:rgba(239,68,68,.18);border-color:rgba(239,68,68,.5)}
.ctrl-label{font-size:11px;font-weight:500;letter-spacing:.01em}
.vdiff-modal__panes{display:flex;flex:1;overflow:hidden;gap:1px;background:var(--border-subtle)}
.vdiff-pane{display:flex;flex-direction:column;background:var(--bg-base);flex:1;min-width:0}
.pane-fullwidth{flex:1 1 100%}
.pane-hidden{display:none!important}
.pane-expand{background:none;border:none;color:inherit;cursor:pointer;padding:0 6px;opacity:.5;float:right;display:inline-flex;align-items:center;transition:opacity .08s}
.pane-expand:hover{opacity:1}
.vdiff-pane--baseline .vdiff-pane__label{color:#60a5fa;background:#060e1a}
.vdiff-pane--compare .vdiff-pane__label{color:#3fb950;background:#051209}
.vdiff-pane__label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;padding:6px 12px;flex-shrink:0;font-weight:700}
.vdiff-pane__scroll-container{overflow:auto;flex:1;position:relative;scrollbar-width:thin;scrollbar-color:var(--border-default) transparent}
.vdiff-pane__content{position:relative;display:inline-block;min-width:100%;transform-origin:top left}
.vdiff-screenshot{width:100%;height:auto;display:block;image-rendering:crisp-edges}
.vdiff-svg-overlay{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:4}
.vdiff-svg-overlay .hl-rect{pointer-events:all;cursor:crosshair}
.vdiff-ghost{position:absolute;inset:0;z-index:5;pointer-events:none}
.vdiff-ghost-img{width:100%;height:auto;opacity:.5}

.vdiff-tooltip{
  position:fixed;z-index:10010;background:var(--bg-elevated);
  border:1px solid var(--accent-border);border-radius:8px;
  padding:10px 12px;font-size:12px;max-width:340px;pointer-events:none;
  box-shadow:0 1px 4px rgba(0,0,0,.3),0 4px 20px rgba(0,0,0,.5);
}
.vdiff-tooltip[hidden]{display:none}
.tt-row{display:grid;grid-template-columns:110px 1fr 14px 1fr;gap:4px;align-items:baseline;padding:2px 0;border-bottom:1px solid var(--border-subtle)}
.tt-row:last-child{border-bottom:none}
.tt-prop{color:var(--text-secondary);font-family:ui-monospace,'Geist Mono','Cascadia Code',monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.tt-base{color:var(--red-text);font-family:ui-monospace,'Geist Mono','Cascadia Code',monospace;word-break:break-all;font-variant-numeric:tabular-nums}
.tt-arr{color:var(--text-faint);text-align:center;font-size:10px}
.tt-cmp{color:var(--green-text);font-family:ui-monospace,'Geist Mono','Cascadia Code',monospace;word-break:break-all;font-variant-numeric:tabular-nums}

.tree-root{padding:4px 0}
.tree-node{display:flex;align-items:center;min-height:28px;padding:0 8px 0 0;border-bottom:1px solid var(--border-subtle);cursor:default;user-select:none;transition:background .08s;position:relative}
.tree-node.tree-has-diff{cursor:pointer}
.tree-node.tree-has-diff:hover{background:var(--tree-row-hover-bg)}
.tree-node.tree-structural{cursor:pointer}
.tree-node.tree-structural:hover{background:var(--tree-row-hover-bg)}
.tree-node.tree-structural .tree-label{color:var(--tree-structural-fg)}
.tree-node.tree-structural .tree-chevron{color:var(--tree-structural-fg)}
.tree-node.tree-selected{background:var(--tree-row-selected-bg)}
.tree-node.tree-selected::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--tree-row-selected-border);border-radius:0 1px 1px 0}
.tree-indent{width:16px;flex-shrink:0;position:relative;align-self:stretch;display:flex;align-items:center}
.tree-indent::before{content:'';position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--tree-indent-guide)}
.tree-indent-segment{width:16px;flex-shrink:0;position:relative;align-self:stretch;display:flex;align-items:center}
.tree-indent-segment::before{content:'';position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--tree-indent-guide)}
.tree-chevron-wrap{width:20px;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.tree-chevron{font-size:8px;color:var(--text-muted);cursor:pointer;width:16px;height:16px;display:flex;align-items:center;justify-content:center;border-radius:3px;transition:background .08s,color .08s,transform .15s;flex-shrink:0}
.tree-chevron:hover{background:var(--bg-active);color:var(--text-secondary)}
.tree-chevron.open{transform:rotate(90deg)}
.tree-chevron-spacer{width:16px;flex-shrink:0}
.tree-label{font-size:12px;color:var(--text-secondary);font-family:ui-monospace,'Geist Mono','Cascadia Code','Fira Code',monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;padding:0 6px;line-height:28px}
.tree-has-diff .tree-label{color:var(--tree-diff-fg);font-weight:600;text-shadow:0 0 12px rgba(199,210,254,.3)}
.tree-structural .tree-label{color:var(--tree-structural-fg);font-weight:400}
.tree-badge{font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px;flex-shrink:0;white-space:nowrap;letter-spacing:.01em;border:1px solid transparent;margin-right:4px}
.tree-badge.nb-insertion{background:#0f2a1a;color:#3fb950;border-color:#145522}
.tree-badge.nb-removal{background:#300d0d;color:#f47474;border-color:#5e1c1c}
.tree-badge.nb-layout{background:#0c1e3a;color:#60a5fa;border-color:#1d3a5f}
.tree-badge.nb-position{background:#1e0f2e;color:#c084fc;border-color:#5b2a8c}
.tree-badge.nb-style{background:#2a1200;color:#fb923c;border-color:#7c2d12}
.tree-badge.nb-content{background:#0c2825;color:#34d399;border-color:#065f46}
.tree-badge.nb-pseudo{background:#141030;color:#a5b4fc;border-color:#2e2470}
.tree-badge.nb-structural{background:var(--bg-elevated);color:var(--text-muted);border-color:var(--border-default)}
.tree-diff-count{background:var(--accent-faint);color:var(--accent-light);border:1px solid var(--accent-border);border-radius:4px;padding:0 5px;font-size:10px;font-weight:600;flex-shrink:0;margin-right:4px;font-variant-numeric:tabular-nums}
.tree-instances{font-size:10px;color:var(--green-text);flex-shrink:0;background:var(--green-bg);border-radius:3px;padding:1px 5px;margin-right:4px;font-weight:600;font-variant-numeric:tabular-nums}
.tree-apex-badge{font-size:9px;color:var(--amber-text);flex-shrink:0;background:var(--amber-bg);border:1px solid rgba(210,153,34,.3);border-radius:3px;padding:1px 4px;margin-right:4px;letter-spacing:.04em}
.tree-visual-dot{width:5px;height:5px;border-radius:50%;background:var(--accent-light);flex-shrink:0;margin-right:6px;opacity:.6}
.tree-children.collapsed{display:none}
.tree-empty{color:var(--text-tertiary);text-align:center;padding:40px 0;font-size:13px}

.u-text-tertiary{color:var(--text-tertiary)}
.u-text-secondary{color:var(--text-secondary)}
.u-label-upper{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted)}
.u-pos-label{font-size:10px;color:var(--text-muted);user-select:none;padding:2px 0;flex-shrink:0;letter-spacing:.06em;text-transform:uppercase;font-variant-numeric:tabular-nums}
.u-dom-delta{font-size:11px;color:var(--text-tertiary);margin-top:10px}
.u-no-diffs{color:var(--text-tertiary);text-align:center;padding:20px}
.u-pct-sup{font-size:28px;color:var(--text-tertiary);font-variant-numeric:tabular-nums}

.tree-node:focus-visible,
.filter-btn:focus-visible,
.toolbar-btn:focus-visible,
.sel-btn:focus-visible,
.impact-chip:focus-visible,
.root-cause-card:focus-visible,
.activity-btn:focus-visible,
.vdiff-open-btn:focus-visible{
  outline:2px solid var(--border-focus);
  outline-offset:1px;
}

.sidebar::-webkit-scrollbar,.tree-panel::-webkit-scrollbar,.panel-detail::-webkit-scrollbar,#summary-panel::-webkit-scrollbar{width:4px}
.sidebar::-webkit-scrollbar-track,.tree-panel::-webkit-scrollbar-track,.panel-detail::-webkit-scrollbar-track,#summary-panel::-webkit-scrollbar-track{background:transparent}
.sidebar::-webkit-scrollbar-thumb,.tree-panel::-webkit-scrollbar-thumb,.panel-detail::-webkit-scrollbar-thumb,#summary-panel::-webkit-scrollbar-thumb{background:var(--border-default);border-radius:4px}
.sidebar::-webkit-scrollbar-thumb:hover,.tree-panel::-webkit-scrollbar-thumb:hover,.panel-detail::-webkit-scrollbar-thumb:hover,#summary-panel::-webkit-scrollbar-thumb:hover{background:var(--border-strong)}
.sidebar{scrollbar-width:thin;scrollbar-color:var(--border-default) transparent}
.tree-panel{scrollbar-width:thin;scrollbar-color:var(--border-default) transparent}
.panel-detail{scrollbar-width:thin;scrollbar-color:var(--border-default) transparent}
#summary-panel{scrollbar-width:thin;scrollbar-color:var(--border-default) transparent}
.vdiff-kf-bar{background:#78350f;border-bottom:1px solid #f59e0b;color:#fbbf24;font-size:10px;font-family:monospace;padding:3px 12px;cursor:default;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.vdiff-pane--baseline.vdiff-kf-mismatch>.vdiff-pane__label,
.vdiff-pane--compare.vdiff-kf-mismatch>.vdiff-pane__label{border-bottom:2px solid #f59e0b;}`;
}

function buildJs(grouped, manifest, blobData, raw) {
  const data         = JSON.stringify(grouped);
  const manifestJson = JSON.stringify(manifest ?? {});
  const blobJson     = JSON.stringify(blobData ?? {});
  const hpidMetaJson = JSON.stringify(
    Object.fromEntries(
      (raw?.comparison?.results ?? [])
        .filter(r => r.hpid)
        .map(r => [r.hpid, { t: r.tagName ?? null, c: r.className ?? null, id: r.elementId ?? null }])
    )
  );
  const meta         = JSON.stringify({
    baselineUrl:  raw?.baseline?.url  ?? '',
    compareUrl:   raw?.compare?.url   ?? '',
    baselineHost: (() => { try { return new URL(raw?.baseline?.url ?? '').hostname; } catch { return 'Baseline'; } })(),
    compareHost:  (() => { try { return new URL(raw?.compare?.url  ?? '').hostname; } catch { return 'Compare';  } })(),
  });

  return `(function(){
'use strict';
var GROUPED         = ${data};
var VISUAL_MANIFEST = ${manifestJson};
var VISUAL_DATA     = ${blobJson};
var COMPARISON_META = ${meta};
var DEVTOOLS_WARNINGS = ${JSON.stringify(raw.devToolsWarnings ?? [])};
var HPID_META       = ${hpidMetaJson};
var SEVERITY_COLORS = {critical:'#ef4444',high:'#f97316',medium:'#eab308',low:'#6b7280',removed:'#ef4444',added:'#22c55e'};
var URL_NOISE_ATTRS=new Set(['href','src','srcset','action','data-href','data-url','data-link','data-src','formaction']);

var detailEl  = document.getElementById('panel-detail');
var layout    = document.querySelector('.layout');
var searchEl  = document.getElementById('search');
var treeEl    = document.getElementById('tree-panel');
var activeSev = 'all';
var activeCat = 'all';
var _syncCtrl     = null;
var _zoom         = 1;
var _resizeObs    = null;
var _activeEntry  = null;
  var _inlineThumbObs  = null;
  var _inlineThumbData = [];
var _selectedNode = null;
var _maskSeq      = 0;

function esc(s){ return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function swatch(v){ if(!v||v==='none'||v==='transparent') return ''; return '<span class="swatch" style="background:'+esc(v)+'" title="'+esc(v)+'"></span>'; }
function sevPip(s){ return '<span class="sev-pip '+esc(s)+'"></span>'; }
function svgNS(tag){ return document.createElementNS('http://www.w3.org/2000/svg',tag); }
function setAttrs(el,attrs){ for(var k in attrs) el.setAttribute(k,String(attrs[k])); }

function isPseudoHpid(hpid){ return String(hpid).includes('::before')||String(hpid).includes('::after'); }
function isPseudoLabel(label){ return String(label).includes('::before')||String(label).includes('::after'); }

function narrativeBadge(item, severity){
  if(isPseudoHpid(item&&item.hpid||'')) return {label:'PSEUDO',cls:'nb-pseudo'};
  if(item&&item.narrativeLabel==='CONTENT DIVERGENCE') return {label:'CONTENT DIVERGENCE',cls:'nb-content'};
  if(severity==='added')   return {label:'DOM INSERTION',cls:'nb-insertion'};
  if(severity==='removed') return {label:'DOM DELETION',cls:'nb-removal'};
  var allProps=[];
  Object.values(item&&item.diffsByCategory||{}).forEach(function(diffs){ diffs.forEach(function(d){ allProps.push(d.property); }); });
  var hasLayout=allProps.some(function(p){ return /position|display|flex|grid|float|overflow|visibility|z-index/.test(p); });
  var hasSize  =allProps.some(function(p){ return /^width$|^height$|max-width|min-width|^margin|^padding/.test(p); });
  var hasPos   =allProps.some(function(p){ return /^top$|^left$|^right$|^bottom$|transform/.test(p); });
  if(hasLayout||hasSize) return {label:'LAYOUT SHIFT',cls:'nb-layout'};
  if(hasPos)             return {label:'POSITION DRIFT',cls:'nb-position'};
  return                        {label:'STYLE REGRESSION',cls:'nb-style'};
}

var HPID_ITEM_MAP=(function(){
  var m=new Map();
  ['critical','high','medium','low'].forEach(function(sev){
    (GROUPED.groups[sev]||[]).forEach(function(item){
      if(item.hpid) m.set(item.hpid,{sev:sev,item:item});
      (item.recurrenceHpids||[]).forEach(function(h){ if(h&&!m.has(h)) m.set(h,{sev:sev,item:item}); });
    });
  });
  ['added','removed'].forEach(function(sev){ (GROUPED.groups[sev]||[]).forEach(function(item){ if(item.hpid) m.set(item.hpid,{sev:sev,item:item}); }); });
  (GROUPED.groups.unchanged||[]).forEach(function(item){ if(item.hpid) m.set(item.hpid,{sev:'unchanged',item:item}); });
  return m;
})();

var HPID_LABEL_MAP=(function(){
  var m=new Map();
  (GROUPED.groups.unchanged||[]).forEach(function(item){ if(item.hpid) m.set(item.hpid,item.elementKey); });
  ['critical','high','medium','low','added','removed'].forEach(function(sev){
    (GROUPED.groups[sev]||[]).forEach(function(item){
      if(item.hpid) m.set(item.hpid,item.elementKey);
      (item.recurrenceHpids||[]).forEach(function(h){ if(h&&!m.has(h)) m.set(h,item.elementKey); });
    });
  });
  Object.keys(HPID_META).forEach(function(hpid){
    if(!m.has(hpid)){
      var meta=HPID_META[hpid];
      var tag=(meta.t||'unknown').toLowerCase();
      var idPart=meta.id?'#'+meta.id:'';
      var cls=meta.c?meta.c.trim():'';
      var clsPart=cls?'.'+cls.split(/\s+/).slice(0,2).join('.'):'';
      m.set(hpid,tag+idPart+clsPart);
    }
  });
  return m;
})();

function countDiffDescendants(hpid){
  var prefix=hpid+'.', count=0;
  HPID_ITEM_MAP.forEach(function(entry,key){ if(key.startsWith(prefix)&&entry.sev!=='unchanged') count++; });
  return count;
}

function classifyNode(hpid){
  var entry=HPID_ITEM_MAP.get(hpid);
  if(!entry||entry.sev==='unchanged') return {type:'STRUCTURAL',hpid:hpid,childDiffCount:countDiffDescendants(hpid)};
  if(entry.sev==='added')   return {type:'DOM_INSERTION',hpid:hpid,item:entry.item,sev:entry.sev};
  if(entry.sev==='removed') return {type:'DOM_DELETION', hpid:hpid,item:entry.item,sev:entry.sev};
  if(entry.item.isApex)     return {type:'DIFF_APEX',    hpid:hpid,item:entry.item,sev:entry.sev};
  return                           {type:'DIFF_DETAIL',  hpid:hpid,item:entry.item,sev:entry.sev};
}

function teardown(){
  if(_selectedNode){ _selectedNode.classList.remove('tree-selected'); _selectedNode=null; }
  detailEl.querySelectorAll('img').forEach(function(img){ img.onload=null; img.onerror=null; img.removeAttribute('src'); });
  if(_inlineThumbObs) { _inlineThumbObs.disconnect(); _inlineThumbObs = null; }
  _inlineThumbData = [];
  var emptyState=document.getElementById('detail-empty-state');
  if(emptyState){
    detailEl.innerHTML='';
    detailEl.appendChild(emptyState);
    emptyState.style.display='';
  } else {
    detailEl.innerHTML='<div class="detail-empty-state"><div class="detail-empty-icon">\u{1F50D}</div><div class="detail-empty-text">Select an element to inspect</div></div>';
  }
  if(layout){ layout.style.setProperty('--col-right','0px'); layout.classList.add('detail-empty'); }
  _activeEntry=null;
}

function initSummaryOverlay(){
  var btn     = document.getElementById('panel-summary-btn');
  var wrapper = document.querySelector('.sidebar-wrapper');
  if(!btn||!wrapper) return;
  var s       = GROUPED.summary;
  var score   = s.impactScore??0;
  var cls     = score>=90?'score-great':score>=70?'score-good':score>=50?'score-warn':'score-bad';
  var dist    = s.distribution||{layout:0,style:0,content:0,dom:0};
  var total   = dist.layout+dist.style+dist.content+dist.dom||1;
  var lPct=Math.round(dist.layout/total*100), sPct=Math.round(dist.style/total*100), cPct=Math.round(dist.content/total*100);
  var dPct=Math.max(0,100-lPct-sPct-cPct);
  var progressColor=score>=90?'#4ade80':score>=70?'#86efac':score>=50?'#fbbf24':'#f87171';
  var zoneA='<div class="exec-zone"><div class="exec-zone-title">Impact Score</div>'+
    '<div class="impact-score-ring"><div class="impact-score-number '+cls+'">'+score+'<span class="u-pct-sup">%</span></div>'+
    '<div class="impact-score-meta"><div class="impact-score-label">Design Consistency</div>'+
    '<div class="impact-score-sublabel">'+(s.rootCauseCount??0)+' root cause'+(s.rootCauseCount!==1?'s':'')+' \u00b7 penalty '+Math.round(s.rawPenalty??0)+'</div></div></div>'+
    '<div class="impact-progress"><div class="impact-progress-fill" style="width:'+score+'%;background:'+progressColor+'"></div></div>'+
    '<div class="impact-chips">'+
    '<button class="impact-chip chip-active" data-mode="root" title="Unique element bugs (post-suppression apex nodes)">'+(s.rootCauseCount??0)+' modified elements</button>'+
    '<button class="impact-chip" data-mode="raw" title="Actual CSS property changes across all apex elements">'+(s.propertyDiffCount??0)+' property diffs</button>'+
    (s.contentDemoted>0?'<button class="impact-chip" data-mode="content">'+s.contentDemoted+' content-demoted</button>':'')+
    '</div></div>';
  var topNodes=s.topApexNodes||[];
  var causeCards=topNodes.length
    ?topNodes.map(function(n){
        var sub=n.suppressedDiffsCount>0?'+'+n.suppressedDiffsCount+' cascade \u00b7 '+n.totalDiffs+' direct diffs':n.totalDiffs+' property diff'+(n.totalDiffs!==1?'s':'');
        return '<div class="root-cause-card" data-hpid="'+esc(n.hpid||'')+'" role="button" tabindex="0">'+
          '<div class="root-cause-dot sev-'+esc(n.severity)+'"></div>'+
          '<div class="root-cause-body"><div class="root-cause-key" title="'+esc(n.elementKey)+'">'+esc(n.elementKey.length>32?n.elementKey.slice(0,31)+'\u2026':n.elementKey)+'</div>'+
          '<div class="root-cause-sub"><span class="tree-badge '+esc(n.narrativeBadgeClass)+'" style="font-size:8px;padding:1px 4px;margin-right:4px;">'+esc(n.narrativeBadgeLabel)+'</span>'+esc(sub)+'</div>'+
          '</div><div class="root-cause-arrow">\u203a</div></div>';
      }).join('')
    :'<div class="root-cause-empty">No apex nodes detected.</div>';
  var zoneB='<div class="exec-zone"><div class="exec-zone-title">'+(topNodes.length&&topNodes[0].suppressedDiffsCount>0?'Top Root Causes':'Top Changes')+'</div>'+
    '<div class="root-cause-list">'+causeCards+'</div></div>';
  var segs=[
    {cat:'layout',pct:lPct,count:dist.layout,label:'Layout',color:'#3b82f6'},
    {cat:'style',pct:sPct,count:dist.style,label:'Style',color:'#f59e0b'},
    {cat:'content',pct:cPct,count:dist.content,label:'Content',color:'#0d9488'},
    {cat:'dom',pct:dPct,count:dist.dom,label:'DOM',color:'#8b5cf6'}
  ].filter(function(s){ return s.count>0||s.pct>0; });
  var barSegs=segs.map(function(sg){ return '<div class="dist-segment" data-cat="'+esc(sg.cat)+'" style="flex:'+sg.pct+'" title="'+esc(sg.label+': '+sg.count)+'"></div>'; }).join('');
  var legend=segs.map(function(sg){
    return '<div class="dist-legend-item" data-cat="'+esc(sg.cat)+'" role="button" tabindex="0">'+
      '<div class="dist-legend-dot" style="background:'+esc(sg.color)+'"></div>'+
      '<span>'+esc(sg.label)+'</span><span class="dist-count">'+esc(String(sg.count))+'</span></div>';
  }).join('');
  var zoneC='<div class="exec-zone"><div class="exec-zone-title">Change Distribution</div>'+
    '<div class="dist-bar-outer">'+barSegs+'</div><div class="dist-legend">'+legend+'</div>'+
    '<div class="u-dom-delta">DOM delta: <strong class="u-text-secondary">+'+esc(String(s.added||0))+' only in '+esc(COMPARISON_META.compareHost||'compare')+'</strong> \u00b7 <strong class="u-text-secondary">\u2212'+esc(String(s.removed||0))+' only in '+esc(COMPARISON_META.baselineHost||'baseline')+'</strong></div>'+
    '</div>';
  var content=document.getElementById('summary-panel');
  if(content) content.innerHTML='<div class="exec-summary">'+zoneA+zoneB+zoneC+'</div>';
  content&&content.querySelectorAll('.root-cause-card[data-hpid]').forEach(function(card){
    function go(){ var h=card.dataset.hpid; if(!h) return; var n=treeEl.querySelector('.tree-node[data-hpid="'+h+'"]'); handleNodeSelection(h,n); if(n) n.scrollIntoView({behavior:'smooth',block:'center'}); wrapper.classList.remove('summary-active'); btn.classList.remove('active'); }
    card.addEventListener('click',go); card.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); go(); } });
  });
  content&&content.querySelectorAll('.dist-legend-item[data-cat]').forEach(function(item){
    item.addEventListener('click',function(){
      var cat=item.dataset.cat;
      document.querySelectorAll('[data-cat].filter-btn').forEach(function(b){ b.classList.remove('active'); });
      var b=document.querySelector('[data-cat="'+cat+'"].filter-btn');
      if(b){ b.classList.add('active'); activeCat=cat; applyFilters(); }
    });
  });
  (function(){
    var layout = document.querySelector('.layout');
    if(!layout) return;
    var lastLeft = null;
    var treeBtn = document.getElementById('panel-left-btn');
    var sumBtn  = document.getElementById('panel-summary-btn');
    var sidebarWrapper = document.querySelector('.sidebar-wrapper');

    function openSidebar(){
      if(layout.classList.contains('sidebar-collapsed')){
        layout.classList.remove('sidebar-collapsed');
        if(lastLeft) layout.style.setProperty('--col-left', lastLeft+'px');
      }
    }
    function collapseSidebar(){
      var cur = layout.style.getPropertyValue('--col-left') || '280';
      lastLeft = parseInt(cur) || 280;
      layout.classList.add('sidebar-collapsed');
    }
    function setActive(btn){ if(treeBtn) treeBtn.classList.remove('active'); if(sumBtn) sumBtn.classList.remove('active'); if(btn) btn.classList.add('active'); }

    if(treeBtn){
      treeBtn.addEventListener('click', function(){
        var isCollapsed = layout.classList.contains('sidebar-collapsed');
        var showingSummary = sidebarWrapper && sidebarWrapper.classList.contains('summary-active');
        if(isCollapsed){
          openSidebar();
          if(sidebarWrapper) sidebarWrapper.classList.remove('summary-active');
          setActive(treeBtn);
        } else if(showingSummary){
          sidebarWrapper.classList.remove('summary-active');
          setActive(treeBtn);
        } else {
          collapseSidebar();
          setActive(null);
        }
      });
    }

    if(sumBtn && sidebarWrapper){
      sumBtn.addEventListener('click', function(){
        var isCollapsed = layout.classList.contains('sidebar-collapsed');
        var showingSummary = sidebarWrapper.classList.contains('summary-active');
        if(isCollapsed){
          openSidebar();
          sidebarWrapper.classList.add('summary-active');
          setActive(sumBtn);
        } else if(!showingSummary){
          sidebarWrapper.classList.add('summary-active');
          setActive(sumBtn);
        } else {
          collapseSidebar();
          sidebarWrapper.classList.remove('summary-active');
          setActive(null);
        }
      });
    }
  })();
  (function(){
    function makeResizable(handleId,cssVar,side){
      var handle=document.getElementById(handleId);
      if(!handle) return;
      var layout=handle.closest('.layout');
      var startX,startVal;
      handle.addEventListener('mousedown',function(e){
        e.preventDefault();
        handle.classList.add('dragging');
        startX=e.clientX;
        var cur=getComputedStyle(layout).getPropertyValue(cssVar).trim();
        startVal=parseInt(cur)||(side==='left'?280:420);
        document.addEventListener('mousemove',onMove);
        document.addEventListener('mouseup',onUp);
      });
      function onMove(e){
        var delta=side==='left'?e.clientX-startX:startX-e.clientX;
        var next=side==='right'?Math.max(200,Math.min(700,startVal+delta)):Math.max(120,Math.min(600,startVal+delta));
        layout.style.setProperty(cssVar,next+'px');
        if(side==='right') layout.classList.remove('detail-empty');
      }
      function onUp(){
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove',onMove);
        document.removeEventListener('mouseup',onUp);
      }
    }
    makeResizable('resize-left','--col-left','left');
    makeResizable('resize-right','--col-right','right');
  })();
}

function buildBreadcrumbCrumbs(hpid){
  var segs=hpid.split('.'), crumbs=[];
  for(var i=1;i<=segs.length;i++){
    var prefix=segs.slice(0,i).join('.');
    var label=HPID_LABEL_MAP.get(prefix)||prefix;
    var hasDiff=HPID_ITEM_MAP.has(prefix)&&HPID_ITEM_MAP.get(prefix).sev!=='unchanged';
    crumbs.push({hpid:prefix,label:label,hasDiff:hasDiff,isSelf:prefix===hpid});
  }
  if(crumbs.length>5) crumbs=[crumbs[0],{isEllipsis:true,label:'\u2026'}].concat(crumbs.slice(-3));
  return crumbs;
}

function buildCrumbHtml(crumbs){
  return crumbs.map(function(c,i){
    var sep=i<crumbs.length-1?'<span class="crumb-sep">\u203a</span>':'';
    if(c.isEllipsis) return '<span class="crumb-item crumb-ellipsis">'+esc(c.label)+'</span>'+sep;
    if(c.isSelf)     return '<span class="crumb-item crumb-self">'+esc(c.label)+'</span>'+sep;
    var cls='crumb-item'+(c.hasDiff?' crumb-diff':'');
    var dat=c.hasDiff?' data-hpid="'+esc(c.hpid)+'"':'';
    return '<span class="'+cls+'"'+dat+' tabindex="'+(c.hasDiff?0:-1)+'">'+esc(c.label)+'</span>'+sep;
  }).join('');
}

function attachCrumbHandlers(container){
  container.querySelectorAll('.crumb-diff[data-hpid]').forEach(function(crumb){
    function go(){ var h=crumb.dataset.hpid; var tgt=treeEl.querySelector('.tree-node[data-hpid="'+h+'"]'); handleNodeSelection(h,tgt); if(tgt) tgt.scrollIntoView({behavior:'smooth',block:'center'}); }
    crumb.addEventListener('click',go);
    crumb.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); go(); } });
  });
}

function buildMiniMapHtml(hpid){
  var entry=VISUAL_MANIFEST[hpid];
  if(!entry||entry.baselineDocumentY==null||!entry.baselineDocumentHeight) return '';
  var docY     = entry.baselineDocumentY;
  var docH     = entry.baselineDocumentHeight;
  var topPct   = Math.min(97,Math.max(3,Math.round(docY/docH*100)));
  var sevColor = SEVERITY_COLORS[(HPID_ITEM_MAP.get(hpid)||{}).sev||'low']||'#6b7280';
  var rect     = entry.baselineRect||{};
  var yDisplay = Math.round(docY);
  var botDisplay=Math.round(docY+(rect.height||0));
  return '<div class="minimap-section-label u-label-upper" style="margin-bottom:4px">Document Position</div><div class="minimap-container">'+
    '<div class="minimap-rail-wrap" title="Dot shows where this element sits on the full page height" style="height:44px">'+
      '<div class="minimap-dot" style="top:'+topPct+'%;background:'+esc(sevColor)+';box-shadow:0 0 4px '+esc(sevColor)+'88"></div>'+
    '</div>'+
    '<div class="u-pos-label">POS</div>'+
    '<div class="minimap-meta">'+
      '<div class="minimap-pos">y: <strong>'+esc(String(yDisplay))+'px</strong> \u2192 <strong>'+esc(String(botDisplay))+'px</strong></div>'+
      '<div class="minimap-pos">position: <strong>'+topPct+'%</strong> from top</div>'+
    '</div>'+
  '</div>';
}

function computeCropParams(img, rect, containerWidth, dpr){
  dpr=dpr||2;
  var rx=rect.x!=null?rect.x:(rect.left||0);
  var ry=rect.y!=null?rect.y:(rect.top||0);
  var rw=rect.width||rect.w||1;
  var rh=rect.height||rect.h||1;
  var vpW=img.naturalWidth/dpr;
  var vpH=img.naturalHeight/dpr;
  rh = Math.min(rh, Math.max(1, vpH - Math.max(0, ry)));
  var scaleX=Math.max(Math.min(containerWidth*0.78/rw, 140/Math.max(rh,1)), 0.25);
  var scaleY=scaleX;
  var ctxPx=Math.min(30/scaleX, 28);
  var paddedX=Math.max(0,Math.min(rx-ctxPx,vpW-rw-1));
  var paddedY=Math.max(0,Math.min(ry-ctxPx,vpH-rh-1));
  var paddedW=Math.min(vpW,rx+rw+ctxPx)-paddedX;
  var paddedH=Math.min(vpH,ry+rh+ctxPx)-paddedY;
  paddedW=Math.max(paddedW,1); paddedH=Math.max(paddedH,1);
  return {paddedX:paddedX,paddedY:paddedY,paddedW:paddedW,paddedH:paddedH,scaleX:scaleX,scaleY:scaleY,displayW:paddedW*scaleX,displayH:paddedH*scaleY,vpW:vpW,vpH:vpH,rx:rx,ry:ry,rw:rw,rh:rh};
}

function applyThumb(img, svgEl, container, rect, diffs, dpr, flags){
  if(!img||!img.naturalWidth||!rect||!container) return;
  var cw=container.clientWidth||container.offsetWidth||200;
  var p=computeCropParams(img,rect,cw,dpr||2);

  img.style.width=(p.vpW*p.scaleX)+'px';
  img.style.height=(p.vpH*p.scaleY)+'px';
  img.style.transform='translate('+(-p.paddedX*p.scaleX)+'px,'+(-p.paddedY*p.scaleY)+'px)';
  img.style.transformOrigin='top left';
  img.style.position='absolute';
  container.style.height=p.displayH+'px';
  var actualH=container.clientHeight||p.displayH;

  if(!svgEl) return;
  svgEl.innerHTML='';
  var sx=p.scaleX, sy=p.scaleY;
  var displayW=p.paddedW*sx, displayH=p.paddedH*sy;
  svgEl.setAttribute('width',displayW);
  svgEl.setAttribute('height',actualH);
  svgEl.style.width=displayW+'px';
  svgEl.style.height=actualH+'px';
  svgEl.style.right='auto';
  svgEl.style.bottom='auto';
  var hL=Math.max(0,(p.rx-p.paddedX)*sx);
  var hT=Math.max(0,(p.ry-p.paddedY)*sy);
  var hW=Math.max(0,p.rw*sx); var hH=Math.max(0,p.rh*sy);
  if(hW<2||hH<2) return;
  var sev=diffs&&diffs[0]?diffs[0].severity:'medium';
  var color=SEVERITY_COLORS[sev]||'#7c3aed';
  var defs=svgNS('defs');
  var filtId='ig-'+(++_maskSeq);
  var filt=svgNS('filter'); filt.setAttribute('id',filtId); filt.setAttribute('x','-20%'); filt.setAttribute('y','-20%'); filt.setAttribute('width','140%'); filt.setAttribute('height','140%');
  var blur=svgNS('feGaussianBlur'); blur.setAttribute('stdDeviation','2'); blur.setAttribute('result','b');
  var merge=svgNS('feMerge'); var mn1=svgNS('feMergeNode'); mn1.setAttribute('in','b'); var mn2=svgNS('feMergeNode'); mn2.setAttribute('in','SourceGraphic'); merge.appendChild(mn1); merge.appendChild(mn2);
  filt.appendChild(blur); filt.appendChild(merge); defs.appendChild(filt); svgEl.appendChild(defs);
  applyFocusMask(svgEl,displayW,actualH,hL,hT,hW,hH,color);
  var glow=svgNS('rect');
  setAttrs(glow,{x:hL-1,y:hT-1,width:hW+2,height:hH+2,fill:'none',stroke:color,'stroke-width':2,opacity:.35,rx:2,filter:'url(#'+filtId+')'});
  svgEl.appendChild(glow);
  var hl=svgNS('rect');
  setAttrs(hl,{x:hL,y:hT,width:hW,height:hH,fill:color+'22',stroke:color,'stroke-width':2,'stroke-dasharray':'6,3',rx:2,'vector-effect':'non-scaling-stroke'});
  hl.dataset.diffs=JSON.stringify(diffs||[]);
  hl.classList.add('hl-rect');
  svgEl.appendChild(hl);
  if(flags&&flags.rectClipped){
    var lbl2=svgNS('text');
    setAttrs(lbl2,{x:hL,y:Math.min(displayH-2,hT+hH+10),'font-size':'9','fill':'#60a5fa','font-family':'sans-serif','pointer-events':'none'});
    lbl2.textContent='\u2193 Partially below fold';
    svgEl.appendChild(lbl2);
  }
}

function applyCrop(img, rect, dpr){
  var container=img&&img.parentElement; if(!container) return;
  var cw=container.clientWidth||container.offsetWidth||200;
  var p=computeCropParams(img,rect,cw,dpr||2);
  img.style.width=(p.vpW*p.scaleX)+'px';
  img.style.height=(p.vpH*p.scaleY)+'px';
  img.style.transform='translate('+(-p.paddedX*p.scaleX)+'px,'+(-p.paddedY*p.scaleY)+'px)';
  img.style.transformOrigin='top left';
  img.style.position='absolute';
  container.style.height=p.displayH+'px';
}

function drawInlineHighlight(svgEl, container, img, rect, diffs, dpr){
  if(!img||!img.naturalWidth||!rect||!svgEl||!container) return;
  applyThumb(img,svgEl,container,rect,diffs,dpr);
}

function applyFocusMask(svgEl, W, H, dx, dy, dw, dh, color){
  var maskId='fm'+(++_maskSeq);
  var defs=svgEl.querySelector('defs');
  var mask=svgNS('mask'); mask.setAttribute('id',maskId);
  var outer=svgNS('rect'); setAttrs(outer,{x:0,y:0,width:W,height:H,fill:'white'});
  var hole=svgNS('rect'); setAttrs(hole,{x:dx,y:dy,width:dw,height:dh,fill:'black',rx:2});
  mask.appendChild(outer); mask.appendChild(hole); defs.appendChild(mask);
  var dim=svgNS('rect'); setAttrs(dim,{x:0,y:0,width:W,height:H,fill:'rgba(0,0,0,.45)',mask:'url(#'+maskId+')'});
  svgEl.insertBefore(dim,defs.nextSibling);
  var ring=svgNS('rect'); setAttrs(ring,{x:dx-1,y:dy-1,width:dw+2,height:dh+2,fill:'none',stroke:color,'stroke-width':2.5,rx:3,'vector-effect':'non-scaling-stroke'});
  svgEl.appendChild(ring);
}

function drawModalHighlights(svgEl, imgEl, rect, diffs, dpr, flags){
  svgEl.innerHTML='';
  if(!rect||!imgEl||!imgEl.naturalWidth) return;
  var layoutW=imgEl.offsetWidth, layoutH=imgEl.offsetHeight;
  if(!layoutW||!layoutH) return;
  dpr = dpr || 2;
  var vpW=imgEl.naturalWidth/dpr;
  var vpH=imgEl.naturalHeight/dpr;
  var sx=layoutW/vpW;
  var sy=layoutH/vpH;
  svgEl.setAttribute('width',layoutW);
  svgEl.setAttribute('height',layoutH);
  var rx=rect.x!=null?rect.x:(rect.left||0);
  var ry=rect.y!=null?rect.y:(rect.top||0);
  var rw=rect.width||rect.w||0;
  var rh=rect.height||rect.h||0;
  var dx=rx*sx, dy=ry*sy, dw=rw*sx, dh=rh*sy;
  if(dw<2||dh<2) return;
  var sev=diffs&&diffs[0]?diffs[0].severity:'medium';
  var color=SEVERITY_COLORS[sev]||'#7c3aed';
  var defs=svgNS('defs');
  var filtId='mg-'+(++_maskSeq);
  var filt=svgNS('filter'); filt.setAttribute('id',filtId); filt.setAttribute('x','-10%'); filt.setAttribute('y','-10%'); filt.setAttribute('width','120%'); filt.setAttribute('height','120%');
  var blur=svgNS('feGaussianBlur'); blur.setAttribute('stdDeviation','3'); blur.setAttribute('result','b');
  var merge=svgNS('feMerge'); var mn1=svgNS('feMergeNode'); mn1.setAttribute('in','b'); var mn2=svgNS('feMergeNode'); mn2.setAttribute('in','SourceGraphic');
  merge.appendChild(mn1); merge.appendChild(mn2); filt.appendChild(blur); filt.appendChild(merge); defs.appendChild(filt); svgEl.appendChild(defs);
  applyFocusMask(svgEl,layoutW,layoutH,dx,dy,dw,dh,color);
  var glow=svgNS('rect');
  setAttrs(glow,{x:dx-2,y:dy-2,width:dw+4,height:dh+4,fill:'none',stroke:color,'stroke-width':3,opacity:.35,rx:2,filter:'url(#'+filtId+')'});
  svgEl.appendChild(glow);
  var hl=svgNS('rect');
  setAttrs(hl,{x:dx,y:dy,width:dw,height:dh,fill:color+'22',stroke:color,'stroke-width':2,'stroke-dasharray':'6,3',rx:2,'vector-effect':'non-scaling-stroke'});
  hl.dataset.diffs=JSON.stringify(diffs||[]);
  hl.classList.add('hl-rect');
  svgEl.appendChild(hl);
  if(flags&&flags.rectClipped){
    var lbl2=svgNS('text');
    setAttrs(lbl2,{x:dx,y:Math.min(layoutH-4,dy+dh+14),'font-size':'11','fill':'#60a5fa','font-family':'sans-serif','pointer-events':'none','font-weight':'600'});
    lbl2.textContent='\u2193 Partially below fold';
    svgEl.appendChild(lbl2);
  }
}

function buildVisualDiffSection(hpid){
  var entry=VISUAL_MANIFEST[hpid]; if(!entry) return '';
  function col(kfId,label,cls,rect,misaligned,misalignReason){
    var rAttr=rect?' data-rect="'+esc(JSON.stringify(rect))+'"':'';
    var misalignBadge=misaligned
      ?'<div class="vdiff-misalign-badge" title="Capture may be inaccurate: '+(misalignReason||'element not in viewport at capture time')+'">&#9888; Potentially misaligned</div>'
      :'';
    return '<div class="vdiff-thumb-col">'+
      '<div class="vdiff-pane-label '+cls+'">'+label+'</div>'+
      (kfId
        ?'<div class="vdiff-thumb-wrap" data-role="'+cls.replace('label-','')+'"'+
              (misaligned?' data-misaligned="true" data-misalign-reason="'+esc(misalignReason||'')+'"':'')+'>'+
            '<img class="vdiff-thumb" data-kf-id="'+esc(kfId)+'"'+rAttr+' alt="'+label+'" decoding="async">'+
            '<svg class="vdiff-thumb-svg" aria-hidden="true"></svg>'+
            misalignBadge+
          '</div>'
        :'<div class="vdiff-missing">No capture</div>')+
      '</div>';
  }
  return '<div class="vdiff-inline">'+
    '<div class="vdiff-inline-header">'+
      '<span class="vdiff-inline-label">\u{1F4F7} Visual Diff</span>'+
      '<button class="vdiff-open-btn" data-hpid="'+esc(hpid)+'">\u29C9 Workbench</button>'+
    '</div>'+
    '<div class="vdiff-thumb-grid">'+
      col(entry.baselineKeyframeId,'Baseline','label-baseline',entry.baselineRect,entry.baselineMisaligned,entry.baselineMisalignReason)+
      col(entry.compareKeyframeId, 'Compare', 'label-compare',  entry.compareRect, entry.compareMisaligned, entry.compareMisalignReason)+
    '</div>'+
  '</div>';
}

function attachVdiffInlineImages(hpid){
  var entry=VISUAL_MANIFEST[hpid]; if(!entry) return;
  var section=detailEl.querySelector('.vdiff-inline'); if(!section) return;
  section.querySelectorAll('img[data-kf-id]').forEach(function(img){
    var kfId=img.dataset.kfId;
    var uri=VISUAL_DATA[kfId]; if(!uri) return;
    var rect;
    try{ rect=JSON.parse(img.dataset.rect||'null'); } catch(e){ rect=null; }
    var wrapper=img.parentElement;
    var role=(wrapper&&wrapper.dataset&&wrapper.dataset.role)||'baseline';
    var dpr=role==='compare'?(entry.compareActualDPR||2):(entry.baselineActualDPR||2);
    var diffs=entry.diffs||[];
    var flags=role==='compare'
      ?{rectClipped:!!entry.compareRectClipped}
      :{rectClipped:!!entry.baselineRectClipped};
    var svgEl=wrapper&&wrapper.querySelector('.vdiff-thumb-svg');
    _inlineThumbData.push({img:img,svgEl:svgEl,wrapper:wrapper,rect:rect,diffs:diffs,dpr:dpr,flags:flags});
    if(wrapper) wrapper.classList.add('loading');
    img.onload=function(){
      var doApply=function(){
        if(rect) applyThumb(img,svgEl,wrapper,rect,diffs,dpr,flags);
        if(wrapper) wrapper.classList.remove('loading');
      };
      var w=wrapper?wrapper.clientWidth||wrapper.offsetWidth:0;
      if(!w){
        requestAnimationFrame(function(){
          requestAnimationFrame(doApply);
        });
      } else {
        doApply();
      }
    };
    img.src=uri;
    if(img.complete&&img.naturalWidth) img.onload();
  });
  var grid=section.querySelector('.vdiff-thumb-grid');
  if(grid&&window.ResizeObserver){
    if(_inlineThumbObs) _inlineThumbObs.disconnect();
    var _rafPending=false;
    var _lastGridW=0;
    _inlineThumbObs=new ResizeObserver(function(entries){
      var w=Math.round(entries[0].contentRect.width);
      if(w===_lastGridW) return;
      _lastGridW=w;
      if(_rafPending) return;
      _rafPending=true;
      requestAnimationFrame(function(){
        _rafPending=false;
        _inlineThumbData.forEach(function(d){
          if(d.img.naturalWidth&&d.rect){
            applyThumb(d.img,d.svgEl,d.wrapper,d.rect,d.diffs,d.dpr,d.flags);
          }
        });
      });
    });
    _inlineThumbObs.observe(grid);
  }
}

function renderStructuralContext(cl){
  var hpid=cl.hpid, count=cl.childDiffCount;
  var label=HPID_LABEL_MAP.get(hpid)||hpid;
  var crumbs=buildBreadcrumbCrumbs(hpid);
  var emptyState=document.getElementById('detail-empty-state');
  if(emptyState) emptyState.style.display='none';
  detailEl.innerHTML=(emptyState?'<div id="detail-empty-state" class="detail-empty-state" style="display:none"></div>':'')+
    '<div class="detail-header">'+
    '<div class="detail-narrative-badge nb-structural">STRUCTURAL ANCESTOR</div>'+
    '<div class="detail-tag">'+esc(label)+'</div>'+
    '<nav class="detail-breadcrumb-nav">'+buildCrumbHtml(crumbs)+'</nav>'+
    '</div>'+
    '<div class="detail-body">'+
    '<div class="structural-desc">This element has no direct property diffs.<br>Structural ancestor containing <strong>'+count+'</strong> diff element'+(count!==1?'s':'')+' in its subtree.</div>'+
    '<button class="toolbar-btn structural-expand-btn" data-expand-hpid="'+esc(hpid)+'">Expand in tree \u25b8</button>'+
    '</div>';
  attachCrumbHandlers(detailEl);
  if(layout){ if(!parseInt(layout.style.getPropertyValue('--col-right'))) layout.style.setProperty('--col-right','420px'); layout.classList.remove('detail-empty'); }
  detailEl.querySelector('.structural-expand-btn')?.addEventListener('click',function(){
    var nodeEl=treeEl.querySelector('.tree-node[data-hpid="'+hpid+'"]');
    if(nodeEl){ var ch=nodeEl.parentElement?.querySelector(':scope>.tree-children'); var cv=nodeEl.querySelector('.tree-chevron'); if(cv&&!cv.classList.contains('open')){ cv.classList.add('open'); if(ch) ch.classList.remove('collapsed'); } nodeEl.scrollIntoView({behavior:'smooth',block:'center'}); }
  });
}

function renderMutationPanel(cl){
  var item=cl.item, isIns=cl.type==='DOM_INSERTION';
  var badge=isIns?{label:'DOM INSERTION',cls:'nb-insertion'}:{label:'DOM DELETION',cls:'nb-removal'};
  var crumbs=item.hpid?buildBreadcrumbCrumbs(item.hpid):[];
  var selBtns=[
    item.xpath?'<button class="sel-btn" data-copy="'+esc(item.xpath)+'">Copy XPath</button>':'',
    item.cssSelector?'<button class="sel-btn" data-copy="'+esc(item.cssSelector)+'">Copy CSS</button>':''
  ].join('');
  var emptyState=document.getElementById('detail-empty-state');
  if(emptyState) emptyState.style.display='none';
  detailEl.innerHTML=(emptyState?'<div id="detail-empty-state" class="detail-empty-state" style="display:none"></div>':'')+
    '<div class="detail-header">'+
    '<div class="detail-narrative-badge '+esc(badge.cls)+'">'+esc(badge.label)+'</div>'+
    '<div class="detail-tag">'+esc(item.elementKey)+'</div>'+
    (crumbs.length?'<nav class="detail-breadcrumb-nav">'+buildCrumbHtml(crumbs)+'</nav>':'')+
    '<div class="detail-selectors">'+selBtns+'</div>'+
    '</div>'+
    '<div class="detail-body">'+(isIns
      ?'<div class="mutation-desc">Present in <strong>'+esc(COMPARISON_META.compareHost||'COMPARE')+'</strong> \u2014 absent in <strong>'+esc(COMPARISON_META.baselineHost||'BASELINE')+'</strong>.</div>'
      :'<div class="mutation-desc">Present in <strong>'+esc(COMPARISON_META.baselineHost||'BASELINE')+'</strong> \u2014 absent in <strong>'+esc(COMPARISON_META.compareHost||'COMPARE')+'</strong>.</div>')+
    '</div>';
  attachCrumbHandlers(detailEl);
  if(layout){ if(!parseInt(layout.style.getPropertyValue('--col-right'))) layout.style.setProperty('--col-right','420px'); layout.classList.remove('detail-empty'); }
  attachCopyHandlers();
}

function renderDiffDetail(item, hpid, severity){
  var badge   =narrativeBadge(item,severity||'modified');
  var crumbs  =hpid?buildBreadcrumbCrumbs(hpid):[];
  var baseBtns=[
    item.xpath?'<button class="sel-btn" data-copy="'+esc(item.xpath)+'">Base XPath</button>':'',
    item.cssSelector?'<button class="sel-btn" data-copy="'+esc(item.cssSelector)+'">Base CSS</button>':''
  ].join('');
  var cmpBtns=[
    item.compareXpath?'<button class="sel-btn" data-copy="'+esc(item.compareXpath)+'">Cmp XPath</button>':'',
    item.compareCssSelector?'<button class="sel-btn" data-copy="'+esc(item.compareCssSelector)+'">Cmp CSS</button>':''
  ].join('');
  var selBtns=baseBtns+(baseBtns&&cmpBtns?'<span class="sel-sep">|</span>':'')+cmpBtns;
  var catBlocks=Object.keys(item.diffsByCategory||{}).map(function(cat){
    var rows=item.diffsByCategory[cat].map(function(d){
      var propName=d.property.startsWith('attr:')?d.property.slice(5):null;
      if(propName&&URL_NOISE_ATTRS.has(propName)) return '';
      var isDemoted=d.narrativeLabel==='CONTENT DIVERGENCE';
      var cmpClass='diff-compare'+(isDemoted?' demoted':'');
      return '<div class="diff-row">'+
        '<span class="diff-prop">'+esc(d.property)+(isDemoted?'<span style="font-size:9px;color:#0d9488;margin-left:4px;">\u2193CD</span>':'')+'</span>'+
        '<span class="diff-base">'+swatch(d.baseValue)+esc(d.baseValue??'\u2014')+'</span>'+
        '<span class="diff-arrow">\u2192</span>'+
        '<span class="'+cmpClass+'">'+swatch(d.compareValue)+esc(d.compareValue??'\u2014')+sevPip(d.severity||'low')+'</span>'+
        '</div>';
    }).filter(Boolean).join('');
    return '<div class="detail-category"><div class="cat-title">'+esc(cat)+'</div>'+rows+'</div>';
  }).join('');
  var instNote=item.recurrenceCount>1?'<div class="detail-instances">\u2731 Instance '+(item.instanceIndex||1)+' of '+item.recurrenceCount+'</div>':'';
  var suppNote=item.suppressedDiffsCount>0?'<div class="detail-note">'+item.suppressedDiffsCount+' inherited diff'+(item.suppressedDiffsCount!==1?'s':'')+' suppressed (CSS cascade)</div>':'';
  var contentNote=item.narrativeLabel==='CONTENT DIVERGENCE'?'<div class="detail-demotion">\u{1F9E0} <strong>Content Intelligence:</strong> Width/height diffs demoted \u2014 text content changed significantly.</div>':'';
  var miniMap=buildMiniMapHtml(hpid);
  var vdiffSec=buildVisualDiffSection(hpid);
  var pseudoSec='';
  var entry=VISUAL_MANIFEST[hpid];
  if(entry&&(entry.baselinePseudoBefore||entry.baselinePseudoAfter)){
    pseudoSec='<div class="detail-category"><div class="cat-title">Pseudo-Elements</div>';
    if(entry.baselinePseudoBefore){
      pseudoSec+='<div style="font-size:11px;color:#a5b4fc;font-family:monospace;padding:3px 0;font-weight:600">::before</div>';
      Object.keys(entry.baselinePseudoBefore).forEach(function(k){
        pseudoSec+='<div class="diff-row"><span class="diff-prop">'+esc(k)+'</span><span class="diff-base">'+esc(entry.baselinePseudoBefore[k])+'</span><span class="diff-arrow">\u2192</span><span class="diff-compare">'+esc((entry.comparePseudoBefore&&entry.comparePseudoBefore[k])||'\u2014')+'</span></div>';
      });
    }
    if(entry.baselinePseudoAfter){
      pseudoSec+='<div style="font-size:11px;color:#a5b4fc;font-family:monospace;padding:3px 0;font-weight:600">::after</div>';
      Object.keys(entry.baselinePseudoAfter).forEach(function(k){
        pseudoSec+='<div class="diff-row"><span class="diff-prop">'+esc(k)+'</span><span class="diff-base">'+esc(entry.baselinePseudoAfter[k])+'</span><span class="diff-arrow">\u2192</span><span class="diff-compare">'+esc((entry.comparePseudoAfter&&entry.comparePseudoAfter[k])||'\u2014')+'</span></div>';
      });
    }
    pseudoSec+='</div>';
  }
  var emptyState=document.getElementById('detail-empty-state');
  if(emptyState) emptyState.style.display='none';
  detailEl.innerHTML=(emptyState?'<div id="detail-empty-state" class="detail-empty-state" style="display:none"></div>':'')+
    '<div class="detail-header">'+
    '<div class="detail-narrative-badge '+esc(badge.cls)+'">'+esc(badge.label)+'</div>'+
    '<div class="detail-tag">'+esc(item.elementKey)+'</div>'+
    (item.breadcrumb?'<div class="detail-breadcrumb">'+esc(item.breadcrumb)+'</div>':'')+
    (crumbs.length?'<nav class="detail-breadcrumb-nav">'+buildCrumbHtml(crumbs)+'</nav>':'')+
    '<div class="detail-selectors">'+selBtns+'</div>'+
    suppNote+instNote+contentNote+
    '</div>'+
    '<div class="detail-body">'+
    (catBlocks||'<div class="u-no-diffs">No property diffs recorded</div>')+
    pseudoSec+
    '</div>'+
    vdiffSec+
    miniMap;
  attachCrumbHandlers(detailEl);
  if(layout){ if(!parseInt(layout.style.getPropertyValue('--col-right'))) layout.style.setProperty('--col-right','420px'); layout.classList.remove('detail-empty'); }
  attachCopyHandlers();
  void layout.getBoundingClientRect();
  attachVdiffInlineImages(hpid);
}

function renderApexCascadeExpander(item){
  var summaries=item.suppressedChildSummaries; if(!summaries||!summaries.length) return;
  var rows=summaries.map(function(s){
    var tl=s.suppressionType==='CSS_INHERIT'?'CSS cascade':s.suppressionType==='LAYOUT_FLOW'?'Layout reflow':'Mixed';
    return '<div class="cascade-child-row"><span class="cascade-child-key">'+esc(s.elementKey)+'</span><span class="cascade-child-type">'+esc(tl)+'</span><span class="cascade-child-props" title="'+esc(s.propNames.join(', '))+'">'+esc(s.propNames.join(', '))+'</span></div>';
  }).join('');
  var exp=document.createElement('div'); exp.className='cascade-expander';
  exp.innerHTML='<div class="cascade-header" role="button" tabindex="0" aria-expanded="false"><span class="cascade-chevron">\u25b6</span><span>'+esc(item.suppressionSummary||item.suppressedDiffsCount+' cascade children')+'</span></div><div class="cascade-body" hidden>'+rows+'</div>';
  exp.querySelector('.cascade-header').addEventListener('click',function(){
    var h=exp.querySelector('.cascade-header'), b=exp.querySelector('.cascade-body');
    var open=h.getAttribute('aria-expanded')==='true';
    h.setAttribute('aria-expanded',String(!open));
    exp.querySelector('.cascade-chevron').textContent=!open?'\u25bc':'\u25b6';
    b.hidden=open;
  });
  var body=detailEl.querySelector('.detail-body');
  if(body) body.appendChild(exp);
}

function handleNodeSelection(hpid, nodeEl){
  teardown();
  var tgtEl=nodeEl||treeEl.querySelector('.tree-node[data-hpid="'+hpid+'"]');
  if(tgtEl){ _selectedNode=tgtEl; tgtEl.classList.add('tree-selected'); }
  var cl=classifyNode(hpid);
  switch(cl.type){
    case 'STRUCTURAL':   renderStructuralContext(cl);                       break;
    case 'DOM_INSERTION':
    case 'DOM_DELETION': renderMutationPanel(cl);                           break;
    case 'DIFF_APEX':    renderDiffDetail(cl.item,cl.hpid,cl.sev);
                         renderApexCascadeExpander(cl.item);                break;
    case 'DIFF_DETAIL':  renderDiffDetail(cl.item,cl.hpid,cl.sev);          break;
    default:             detailEl.innerHTML='<div class="u-no-diffs">No data available.</div>';
  }
  _activeEntry=cl.item??null;
}

function attachCopyHandlers(){
  detailEl.querySelectorAll('[data-copy]').forEach(function(btn){
    btn.addEventListener('click',function(){
      navigator.clipboard.writeText(btn.dataset.copy).then(function(){
        var o=btn.textContent; btn.textContent='Copied!'; setTimeout(function(){ btn.textContent=o; },1200);
      });
    });
  });
}

function setModalImage(imgEl, svgEl, kfId, rect, diffs, dpr, flags){
  svgEl.innerHTML='';
  imgEl.onload=null; imgEl.removeAttribute('src');
  if(!kfId) return;
  var uri=VISUAL_DATA[kfId]; if(!uri) return;
  imgEl.onload=function(){
    drawModalHighlights(svgEl,imgEl,rect,diffs,dpr||2,flags||{});
  };
  imgEl.src=uri;
}

function redrawAll(){
  var modal=document.getElementById('vdiff-modal'); if(!_activeEntry) return;
  var e=_activeEntry;
  ['baseline','compare'].forEach(function(role){
    var img=modal.querySelector('.vdiff-screenshot[data-role="'+role+'"]');
    var svg=modal.querySelector('.vdiff-svg-overlay[data-role="'+role+'"]');
    var rect=role==='baseline'?e.baselineRect:e.compareRect;
    var dpr =role==='baseline'?(e.baselineActualDPR||2):(e.compareActualDPR||2);
    var flags=role==='baseline'
      ?{rectClipped:!!e.baselineRectClipped}
      :{rectClipped:!!e.compareRectClipped};
    if(!img||!img.naturalWidth) return;
    drawModalHighlights(svg,img,rect,e.diffs,dpr,flags);
  });
  var bKfM2 = (e.baselineKeyframeId||'').match(/kf_(\d+)$/);
  var cKfM2 = (e.compareKeyframeId||'').match(/kf_(\d+)$/);
  var kfMis2 = bKfM2 && cKfM2 && bKfM2[1] !== cKfM2[1];
  var bP = modal.querySelector('.vdiff-pane--baseline');
  var cP = modal.querySelector('.vdiff-pane--compare');
  [bP,cP].forEach(function(p){ if(p) p.classList.toggle('vdiff-kf-mismatch', !!kfMis2); });
}

function initSyncScroll(pA,pB){
  var lock=false, enabled=true;
  function sync(s,d){ if(!enabled||lock) return; lock=true; d.scrollLeft=s.scrollLeft; d.scrollTop=s.scrollTop; requestAnimationFrame(function(){ lock=false; }); }
  function onA(){ sync(pA,pB); } function onB(){ sync(pB,pA); }
  pA.addEventListener('scroll',onA,{passive:true}); pB.addEventListener('scroll',onB,{passive:true});
  return {toggle:function(){ enabled=!enabled; return enabled; }, destroy:function(){ pA.removeEventListener('scroll',onA); pB.removeEventListener('scroll',onB); }};
}

function applyZoom(z){
  document.getElementById('vdiff-modal').querySelectorAll('.vdiff-pane__content').forEach(function(c){
    c.style.transform=z===1?'':'scale('+z+')'; c.style.transformOrigin='top left';
  });
}

function openDiffModal(hpid){
  var entry=VISUAL_MANIFEST[hpid]; if(!entry) return;
  _activeEntry=entry;
  var modal=document.getElementById('vdiff-modal');
  modal.querySelector('.vdiff-modal__title').textContent=HPID_LABEL_MAP.get(hpid)||hpid;
  var ghost=modal.querySelector('.vdiff-ghost');
  ghost.hidden=true; ghost.innerHTML='';
  _zoom=1; applyZoom(1);
  modal.querySelector('[data-action="ghost"]').classList.remove('active');
  modal.querySelector('[data-action="sync"]').classList.add('active');
  modal.querySelector('[data-action="sync"] .sync-icon-on').style.display='';
  modal.querySelector('[data-action="sync"] .sync-icon-off').style.display='none';

  modal.removeAttribute('hidden');
  document.body.style.overflow='hidden';

  setModalImage(
    modal.querySelector('.vdiff-screenshot[data-role="baseline"]'),
    modal.querySelector('.vdiff-svg-overlay[data-role="baseline"]'),
    entry.baselineKeyframeId, entry.baselineRect, entry.diffs, entry.baselineActualDPR||2,
    {rectClipped:!!entry.baselineRectClipped}
  );
  setModalImage(
    modal.querySelector('.vdiff-screenshot[data-role="compare"]'),
    modal.querySelector('.vdiff-svg-overlay[data-role="compare"]'),
    entry.compareKeyframeId, entry.compareRect, entry.diffs, entry.compareActualDPR||2,
    {rectClipped:!!entry.compareRectClipped}
  );

  var pA=modal.querySelector('[data-pane="baseline"]'), pB=modal.querySelector('[data-pane="compare"]');
  _syncCtrl=initSyncScroll(pA,pB);

  var bKfM = (entry.baselineKeyframeId||'').match(/kf_(\d+)$/);
  var cKfM = (entry.compareKeyframeId||'').match(/kf_(\d+)$/);
  var kfMismatch = bKfM && cKfM && bKfM[1] !== cKfM[1];
  var bPane = modal.querySelector('.vdiff-pane--baseline');
  var cPane = modal.querySelector('.vdiff-pane--compare');
  [bPane, cPane].forEach(function(p){ if(p) p.classList.remove('vdiff-kf-mismatch'); });
  modal.querySelectorAll('.vdiff-kf-bar').forEach(function(el){ el.remove(); });
  if (kfMismatch) {
    if(bPane) bPane.classList.add('vdiff-kf-mismatch');
    if(cPane) cPane.classList.add('vdiff-kf-mismatch');
    [
      { pane: bPane, label: 'Baseline', scrollY: entry.baselineKfScrollY },
      { pane: cPane, label: 'Compare',  scrollY: entry.compareKfScrollY  }
    ].forEach(function(cfg){
      if (!cfg.pane) return;
      var bar = document.createElement('div');
      bar.className = 'vdiff-kf-bar';
      bar.title = 'The compare page layout shifted this element to a different scroll position. Both screenshots are correct — the element is highlighted at its actual position in each.';
      bar.textContent = '\u2195 Different scroll position \u00b7 ' + cfg.label + ' @' + cfg.scrollY + 'px';
      cfg.pane.querySelector('.vdiff-pane__label').after(bar);
    });
  }
  if(_resizeObs) _resizeObs.disconnect();
  if(window.ResizeObserver){
    _resizeObs=new ResizeObserver(function(){ requestAnimationFrame(redrawAll); });
    _resizeObs.observe(modal.querySelector('.vdiff-modal__panes'));
  }
  requestAnimationFrame(redrawAll);
}

function closeModal(){
  var modal=document.getElementById('vdiff-modal');
  modal.setAttribute('hidden','');
  document.body.style.overflow='';
  if(_resizeObs){ _resizeObs.disconnect(); _resizeObs=null; }
  if(_syncCtrl){ _syncCtrl.destroy(); _syncCtrl=null; }
  _activeEntry=null;
}

function hpidParent(h){ var i=h.lastIndexOf('.'); return i>-1?h.slice(0,i):null; }
function hpidSort(a,b){ var pa=a.split('.').map(Number),pb=b.split('.').map(Number); for(var i=0;i<Math.max(pa.length,pb.length);i++){var va=pa[i]??0,vb=pb[i]??0; if(va!==vb) return va-vb;} return 0; }

function buildTreeData(){
  var nodeMap=new Map();
  function add(hpid,sev,item){ if(!hpid||nodeMap.has(hpid)) return; nodeMap.set(hpid,{hpid:hpid,severity:sev,item:item,hasDiff:true,isStructural:false,children:[]}); }
  ['critical','high','medium','low','added','removed'].forEach(function(sev){ (GROUPED.groups[sev]||[]).forEach(function(item){ if(item.hpid) add(item.hpid,sev,item); (item.recurrenceHpids||[]).slice(1).forEach(function(h,idx){ if(h) add(h,sev,Object.assign({},item,{hpid:h,isRecurrence:true,instanceIndex:idx+2})); }); }); });
  Array.from(nodeMap.keys()).forEach(function(hpid){ var p=hpidParent(hpid); while(p&&!nodeMap.has(p)){ nodeMap.set(p,{hpid:p,severity:null,item:null,hasDiff:false,isStructural:true,children:[]}); p=hpidParent(p); } });
  var roots=[];
  nodeMap.forEach(function(node,hpid){ var p=hpidParent(hpid); if(p&&nodeMap.has(p)) nodeMap.get(p).children.push(node); else roots.push(node); });
  nodeMap.forEach(function(n){ n.children.sort(function(a,b){ return hpidSort(a.hpid,b.hpid); }); });
  roots.sort(function(a,b){ return hpidSort(a.hpid,b.hpid); });
  return {roots:roots,nodeMap:nodeMap};
}

function subtreeHasPriority(node){
  if(node.severity==='critical'||node.severity==='high') return true;
  return node.children.some(subtreeHasPriority);
}

function renderTreeNode(node, depth){
  depth=depth||0;
  var hpid=node.hpid, sev=node.severity, item=node.item;
  var hasDiff=node.hasDiff, isStructural=node.isStructural, children=node.children;
  var hasChildren=children.length>0;
  var label=HPID_LABEL_MAP.get(hpid)||hpid;
  var isPseudo=isPseudoLabel(label);
  var shouldAutoExpand=hasChildren&&subtreeHasPriority(node);
  var container=document.createElement('div');
  var nodeEl=document.createElement('div');
  nodeEl.className='tree-node'+(isStructural?' tree-structural':'')+(hasDiff?' tree-has-diff':'');
  nodeEl.dataset.hpid=hpid;
  nodeEl.setAttribute('tabindex','0');
  var indentEl=document.createElement('div'); indentEl.className='tree-indent'; indentEl.style.width=(depth*18)+'px';
  for(var d=0;d<depth;d++){ var seg=document.createElement('div'); seg.className='tree-indent-segment'; indentEl.appendChild(seg); }
  nodeEl.appendChild(indentEl);
  var chevWrap=document.createElement('div'); chevWrap.className='tree-chevron-wrap';
  if(hasChildren){ var chev=document.createElement('div'); chev.className='tree-chevron'+(shouldAutoExpand?' open':''); chev.setAttribute('role','button'); chev.setAttribute('tabindex','0'); chev.textContent='\u25B6'; chevWrap.appendChild(chev); }
  else { var sp=document.createElement('div'); sp.className='tree-chevron-spacer'; chevWrap.appendChild(sp); }
  nodeEl.appendChild(chevWrap);
  var labelSpan=document.createElement('span'); labelSpan.className='tree-label'; labelSpan.title=label+(isStructural?' (structural \u2014 no direct diffs)':''); labelSpan.textContent=label; nodeEl.appendChild(labelSpan);
  if(isPseudo){ var pb=document.createElement('span'); pb.className='tree-badge nb-pseudo'; pb.textContent='PSEUDO'; nodeEl.appendChild(pb); }
  else if(hasDiff&&item&&sev){ var nb=narrativeBadge(item,sev); var badgeEl=document.createElement('span'); badgeEl.className='tree-badge '+nb.cls; badgeEl.textContent=nb.label; nodeEl.appendChild(badgeEl); }
  if(item&&item.isApex){ var apx=document.createElement('span'); apx.className='tree-apex-badge'; apx.title=item.suppressionSummary||'Apex node'; apx.textContent='APEX'; nodeEl.appendChild(apx); }
  if(item&&item.totalDiffs){ var cnt=document.createElement('span'); cnt.className='tree-diff-count'; cnt.title=item.totalDiffs+' diffs'; cnt.textContent=item.totalDiffs+'d'; nodeEl.appendChild(cnt); }
  if(item&&item.recurrenceCount>1){ var inst=document.createElement('span'); inst.className='tree-instances'; inst.textContent=(item.instanceIndex||1)+' of '+item.recurrenceCount; nodeEl.appendChild(inst); }
  if(VISUAL_MANIFEST[hpid]){ var dot=document.createElement('span'); dot.className='tree-visual-dot'; dot.title='Visual diff available'; nodeEl.appendChild(dot); }
  container.appendChild(nodeEl);
  if(hasChildren){
    var childContainer=document.createElement('div'); childContainer.className='tree-children';
    if(!shouldAutoExpand) childContainer.classList.add('collapsed');
    var childrenBuilt=shouldAutoExpand;
    var chevEl=chevWrap.firstChild;
    if(shouldAutoExpand){ children.forEach(function(child){ childContainer.appendChild(renderTreeNode(child,depth+1)); }); }
    function toggleChildren(e){ if(e) e.stopPropagation();
      var isOpen=chevEl.classList.contains('open');
      if(isOpen){ chevEl.classList.remove('open'); childContainer.classList.add('collapsed'); }
      else { if(!childrenBuilt){ childrenBuilt=true; children.forEach(function(child){ childContainer.appendChild(renderTreeNode(child,depth+1)); }); } chevEl.classList.add('open'); childContainer.classList.remove('collapsed'); }
    }
    chevEl.addEventListener('click',toggleChildren);
    chevEl.addEventListener('keydown',function(e){ if(e.key===' '||e.key==='Enter'){ e.preventDefault(); toggleChildren(e); } });
    container.appendChild(childContainer);
  }
  return container;
}

function buildTreeView(){
  var loading=document.getElementById('list-loading');
  var td=buildTreeData(), roots=td.roots;
  if(!roots.length){ if(loading) loading.remove(); treeEl.innerHTML='<div class="tree-empty">No diff elements found</div>'; return; }
  var frag=document.createDocumentFragment();
  var wrap=document.createElement('div'); wrap.className='tree-root';
  roots.forEach(function(r){ wrap.appendChild(renderTreeNode(r,0)); });
  frag.appendChild(wrap);
  if(loading) loading.remove();
  treeEl.appendChild(frag);
  var diffCount=0; treeEl.querySelectorAll('.tree-node.tree-has-diff').forEach(function(){ diffCount++; });
  var countEl=document.getElementById('tree-count'); if(countEl) countEl.textContent=diffCount+' diff element'+(diffCount!==1?'s':'');
  treeEl.addEventListener('click',function(e){
    if(e.target.closest('.tree-chevron')) return;
    var node=e.target.closest('.tree-node'); if(!node) return;
    handleNodeSelection(node.dataset.hpid,node);
  });
  treeEl.addEventListener('keydown',function(e){
    if(e.key!=='Enter'&&e.key!==' ') return;
    var node=e.target.closest('.tree-node'); if(!node) return;
    e.preventDefault(); handleNodeSelection(node.dataset.hpid,node);
  });
}

document.getElementById('expand-all-btn')?.addEventListener('click',function(){
  treeEl.querySelectorAll('.tree-chevron:not(.open)').forEach(function(ch){
    ch.classList.add('open');
    var cc=ch.closest('.tree-node')?.parentElement?.querySelector(':scope>.tree-children');
    if(cc) cc.classList.remove('collapsed');
  });
});
document.getElementById('collapse-all-btn')?.addEventListener('click',function(){
  treeEl.querySelectorAll('.tree-chevron.open').forEach(function(ch){
    ch.classList.remove('open');
    var cc=ch.closest('.tree-node')?.parentElement?.querySelector(':scope>.tree-children');
    if(cc) cc.classList.add('collapsed');
  });
});

function applyFilters(){
  var q=searchEl.value.toLowerCase().trim();
  treeEl.querySelectorAll('.tree-node').forEach(function(node){
    var hpid=node.dataset.hpid;
    var entry=HPID_ITEM_MAP.get(hpid);
    var sev=entry?.sev;
    var label=(node.querySelector('.tree-label')?.textContent||'').toLowerCase();
    var sevMatch=activeSev==='all'||sev===activeSev;
    var catMatch=activeCat==='all'||!!(entry&&Object.keys(entry.item?.diffsByCategory||{}).some(function(c){ return c===activeCat; }));
    var txtMatch=!q||label.includes(q);
    node.style.display=(sevMatch&&catMatch&&txtMatch)?'':'none';
  });
}
document.querySelectorAll('[data-sev].filter-btn').forEach(function(btn){
  btn.addEventListener('click',function(){
    document.querySelectorAll('[data-sev].filter-btn').forEach(function(b){ b.classList.remove('active'); });
    btn.classList.add('active'); activeSev=btn.dataset.sev; applyFilters();
  });
});
document.querySelectorAll('[data-cat].filter-btn').forEach(function(btn){
  btn.addEventListener('click',function(){
    document.querySelectorAll('[data-cat].filter-btn').forEach(function(b){ b.classList.remove('active'); });
    btn.classList.add('active'); activeCat=btn.dataset.cat; applyFilters();
  });
});
var _sd; searchEl.addEventListener('input',function(){ clearTimeout(_sd); _sd=setTimeout(applyFilters,200); });

document.addEventListener('keydown',function(e){
  if(e.key==='f'&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){ searchEl.focus(); e.preventDefault(); }
  if(e.key==='Escape'){
    var m=document.getElementById('vdiff-modal'); if(m&&!m.hasAttribute('hidden')){ closeModal(); return; }
    var ov=document.querySelector('.sidebar-wrapper.summary-active'); if(ov){ ov.classList.remove('summary-active'); document.getElementById('panel-summary-btn')?.classList.remove('active'); return; }
    if(searchEl.value){ searchEl.value=''; applyFilters(); }
  }
});

document.addEventListener('click',function(e){
  var btn=e.target.closest('[data-action]');
  if(btn){
    var a=btn.dataset.action;
    if(a==='close'){ closeModal(); return; }
    if(a==='ghost'){
      var modal=document.getElementById('vdiff-modal');
      var ghost=modal.querySelector('.vdiff-ghost');
      var active=modal.classList.toggle('ghost-mode');
      btn.classList.toggle('active',active);
      btn.textContent=active?'Ghost: ON':'Ghost';
      if(active){ var ci=modal.querySelector('.vdiff-screenshot[data-role="compare"]'); if(ci.src&&!ghost.querySelector('img')){ var gi=document.createElement('img'); gi.className='vdiff-ghost-img'; gi.src=ci.src; gi.setAttribute('decoding','async'); ghost.appendChild(gi); ghost.hidden=false; } }
      else { ghost.hidden=true; ghost.innerHTML=''; }
      return;
    }
    if(a==='sync'){ if(_syncCtrl){ var en=_syncCtrl.toggle(); btn.classList.toggle('active',en); btn.querySelector('.sync-icon-on').style.display=en?'':'none'; btn.querySelector('.sync-icon-off').style.display=en?'none':''; } return; }
    if(a==='zoom-in') { _zoom=Math.min(4,_zoom+0.25); applyZoom(_zoom); requestAnimationFrame(redrawAll); return; }
    if(a==='zoom-out'){ _zoom=Math.max(0.25,_zoom-0.25); applyZoom(_zoom); requestAnimationFrame(redrawAll); return; }
  }
  var ob=e.target.closest('.vdiff-open-btn'); if(ob){ openDiffModal(ob.dataset.hpid); return; }
  var expandBtn=e.target.closest('.pane-expand');
  if(expandBtn){
    var pane=expandBtn.closest('.vdiff-pane');
    var expanded=pane.classList.toggle('pane-fullwidth');
    document.querySelectorAll('.vdiff-pane').forEach(function(p){ if(p!==pane) p.classList.toggle('pane-hidden',expanded); });
    expandBtn.querySelector('.icon-expand').style.display=expanded?'none':'';
    expandBtn.querySelector('.icon-collapse').style.display=expanded?'':'none';
    expandBtn.title=expanded?'Exit focus mode':'Focus this pane';
    requestAnimationFrame(redrawAll);
    return;
  }
  if(e.target.id==='vdiff-modal') closeModal();
});

var tooltipEl=document.getElementById('vdiff-tooltip');
document.addEventListener('mousemove',function(e){
  var hl=e.target.closest('.hl-rect');
  if(!hl){ tooltipEl.hidden=true; return; }
  var diffs=JSON.parse(hl.dataset.diffs||'[]');
  if(!diffs.length){ tooltipEl.hidden=true; return; }
  var rows=diffs.map(function(d){ return '<div class="tt-row"><span class="tt-prop">'+esc(d.property)+'</span><span class="tt-base">'+esc(d.baseValue||'\u2014')+'</span><span class="tt-arr">\u2192</span><span class="tt-cmp">'+esc(d.compareValue||'\u2014')+'</span></div>'; }).join('');
  tooltipEl.innerHTML=rows;
  var vw=window.innerWidth, left=e.clientX+14;
  tooltipEl.style.left=(left+200>vw?e.clientX-214:left)+'px';
  tooltipEl.style.top=(e.clientY+14)+'px';
  tooltipEl.hidden=false;
});
document.addEventListener('mouseleave',function(){ tooltipEl.hidden=true; },true);

initSummaryOverlay();
buildTreeView();

})();`;
}

export { exportToHTML };