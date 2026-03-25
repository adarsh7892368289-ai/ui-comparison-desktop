/**
 * Builds and triggers a CSV download of a full comparison result.
 * Runs in the popup context (uses triggerDownload which touches the DOM).
 * Invariant: never throws — failures are caught and returned as {success:false}.
 * Called by: export-workflow.js → exportComparisonToCsv().
 */
import logger              from '../../../infrastructure/logger.js';
import { rowsToCsv }       from '../shared/csv-utils.js';
import { triggerDownload } from '../shared/download-trigger.js';

// Prepended to output so Excel auto-detects UTF-8 encoding on open.
const UTF8_BOM = '\uFEFF';

/**
 * Converts a full comparison result into a BOM-prefixed CSV string with five
 * sections: summary, severity breakdown, differences, matched elements, and
 * unmatched elements.
 * @param {object} result - Fully-resolved comparison result from compare-workflow.
 * @returns {string} BOM-prefixed CSV text ready for download.
 */
function buildComparisonCsv(result) {
  const s    = result.comparison.summary;
  const rows = [];

  rows.push(['COMPARISON SUMMARY']);
  rows.push(['Baseline ID',        result.baseline.id]);
  rows.push(['Baseline URL',       result.baseline.url]);
  rows.push(['Baseline Title',     result.baseline.title]);
  rows.push(['Baseline Timestamp', result.baseline.timestamp]);
  rows.push(['Baseline Elements',  result.baseline.totalElements]);
  rows.push(['Compare ID',         result.compare.id]);
  rows.push(['Compare URL',        result.compare.url]);
  rows.push(['Compare Title',      result.compare.title]);
  rows.push(['Compare Timestamp',  result.compare.timestamp]);
  rows.push(['Compare Elements',   result.compare.totalElements]);
  rows.push(['Mode',               result.mode]);
  rows.push(['Duration (ms)',      result.duration]);
  rows.push(['Match Rate',         `${result.matching.matchRate}%`]);
  rows.push(['Total Matched',      result.matching.totalMatched]);
  rows.push(['Unmatched Baseline', result.matching.unmatchedBaseline]);
  rows.push(['Unmatched Compare',  result.matching.unmatchedCompare]);
  rows.push([]);

  rows.push(['SEVERITY BREAKDOWN — counts elements by worst severity (1 element = 1 count)']);
  rows.push(['Critical',                                    s.severityCounts.critical]);
  rows.push(['High',                                        s.severityCounts.high]);
  rows.push(['Medium',                                      s.severityCounts.medium]);
  rows.push(['Low',                                         s.severityCounts.low]);
  rows.push(['CSS Property Changes (propertyDiffCount)',    s.propertyDiffCount ?? s.totalDifferences]);
  rows.push(['Modified Elements (apex only)',               s.rootCauseCount ?? s.modifiedElements]);
  rows.push(['Modified Elements (pre-filter)',              s.modifiedElements]);
  rows.push(['Unchanged Elements',                          s.unchangedElements]);
  rows.push(['Total Elements',                              s.totalElements]);
  rows.push([]);

  rows.push(['DIFFERENCES']);
  rows.push([
    'HPID', 'Absolute HPID', 'Tag Name', 'Element ID', 'Class Name',
    'Text Content', 'Tier', 'Depth', 'CSS Selector', 'XPath',
    'Property', 'Category', 'Baseline Value', 'Compare Value', 'Severity', 'Diff Type'
  ]);

  for (const match of result.comparison.results) {
    const el = match.baselineElement ?? {};
    for (const diff of (match.annotatedDifferences || [])) {
      rows.push([
        el.hpid         ?? match.hpid         ?? '',
        el.absoluteHpid ?? match.absoluteHpid ?? '',
        el.tagName      ?? match.tagName       ?? '',
        el.elementId    ?? match.elementId     ?? '',
        el.className    ?? match.className     ?? '',
        el.textContent  ?? match.textContent   ?? '',
        el.tier         ?? match.tier          ?? '',
        el.depth        ?? match.depth         ?? '',
        el.cssSelector  ?? match.cssSelector   ?? '',
        el.xpath        ?? match.xpath         ?? '',
        diff.property,
        diff.category,
        diff.baseValue    ?? '',
        diff.compareValue ?? '',
        diff.severity,
        diff.type
      ]);
    }
  }

  rows.push([]);

  rows.push(['MATCHED ELEMENTS']);
  rows.push([
    'HPID', 'Tag Name', 'Element ID Attr', 'Class Name',
    'Match Strategy', 'Match Confidence', 'CSS Property Changes', 'Overall Severity'
  ]);

  for (const r of result.comparison.results) {
    rows.push([
      r.elementId,
      r.tagName,
      (r.baselineElement?.elementId || r.baselineElementId) || '',
      (r.baselineElement?.className || r.className) || '',
      r.strategy,
      typeof r.confidence === 'number' ? r.confidence.toFixed(2) : '',
      r.totalDifferences,
      r.overallSeverity || 'none'
    ]);
  }

  rows.push([]);

  rows.push(['UNMATCHED ELEMENTS']);
  rows.push([
    'Status', 'HPID', 'Absolute HPID', 'Tag Name', 'Element ID',
    'Class Name', 'Text Content', 'Tier', 'Depth', 'CSS Selector', 'XPath'
  ]);

  for (const el of result.unmatchedElements.baseline) {
    rows.push([
      'Only in Baseline (removed)',
      el.hpid ?? '', el.absoluteHpid ?? '', el.tagName ?? '',
      el.elementId ?? '', el.className ?? '', el.textContent ?? '',
      el.tier ?? '', el.depth ?? '', el.cssSelector ?? '', el.xpath ?? ''
    ]);
  }

  for (const el of result.unmatchedElements.compare) {
    rows.push([
      'Only in Compare (added)',
      el.hpid ?? '', el.absoluteHpid ?? '', el.tagName ?? '',
      el.elementId ?? '', el.className ?? '', el.textContent ?? '',
      el.tier ?? '', el.depth ?? '', el.cssSelector ?? '', el.xpath ?? ''
    ]);
  }

  rows.push([]);

  rows.push(['BY SEVERITY']);

  const groups = { critical: [], high: [], medium: [], low: [] };
  for (const match of result.comparison.results) {
    for (const diff of (match.annotatedDifferences || [])) {
      if (groups[diff.severity]) {
        groups[diff.severity].push({
          elementId:    match.elementId,
          tagName:      match.tagName,
          property:     diff.property,
          baseValue:    diff.baseValue    ?? '',
          compareValue: diff.compareValue ?? ''
        });
      }
    }
  }

  for (const severity of ['critical', 'high', 'medium', 'low']) {
    const items = groups[severity];
    rows.push([`${severity.toUpperCase()} — ${items.length} property change${items.length !== 1 ? 's' : ''}`]);
    if (items.length > 0) {
      rows.push(['Element ID', 'Tag', 'Property', 'Baseline Value', 'Compare Value']);
      for (const item of items) {
        rows.push([item.elementId, item.tagName, item.property, item.baseValue, item.compareValue]);
      }
    }
    rows.push([]);
  }

  return UTF8_BOM + rowsToCsv(rows);
}

/**
 * Builds the CSV for the given result and triggers a browser download. Never throws.
 * @param {object} result - Fully-resolved comparison result from compare-workflow.
 * @returns {{ success: true, filename: string } | { success: false, error: string }}
 */
function exportComparisonToCsv(result) {
  try {
    const csv      = buildComparisonCsv(result);
    const filename = `comparison-${result.baseline.id}-vs-${result.compare.id}.csv`;
    triggerDownload(csv, 'text/csv;charset=utf-8;', filename);
    logger.info('Comparison CSV export complete', { filename });
    return { success: true, filename };
  } catch (err) {
    logger.error('Comparison CSV export failed', { error: err.message });
    return { success: false, error: err.message };
  }
}

export { buildComparisonCsv, exportComparisonToCsv };