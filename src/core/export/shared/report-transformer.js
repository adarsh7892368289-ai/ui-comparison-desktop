/**
 * Transforms a raw comparison result into a grouped, scored, and suppression-processed
 * report ready for rendering in the popup and for export.
 * Runs in the popup context (called after IDB load, not in the SW).
 * Invariant: never mutates the original comparison result — only annotates matched elements in place.
 * Called by: popup.js and all export workflows via transformToGroupedReport().
 */

const SEVERITY_ORDER = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });

/** CSS properties whose values cascade down the DOM tree via inheritance. */
const INHERITABLE_PROPS = new Set([
  'color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'line-height', 'letter-spacing', 'text-align', 'word-spacing',
  'visibility', 'text-transform', 'white-space'
]);

/** Layout properties whose pixel deltas propagate to children via document flow. */
const LAYOUT_PROPAGATION_PROPS = new Set([
  'width', 'height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left'
]);

const LAYOUT_TOLERANCE_PX   = 2;
const W_CRIT                 = 10.0;
const W_HIGH                 =  4.0;
const W_MED                  =  1.5;
const W_LOW                  =  0.3;
const MAX_PENALTY            = 100.0;
const TEXT_RATIO_CAP         =  4.0;
const LEVENSHTEIN_MAX_LEN    =  500;

/** Parses a CSS value string to a float pixel number, returning null if unparseable. */
function parsePx(val) {
  const n = parseFloat(val);
  return Number.isFinite(n) ? n : null;
}

/**
 * Computes Levenshtein edit distance in O(n) space using the Wagner-Fischer algorithm.
 * Capped at LEVENSHTEIN_MAX_LEN characters per side to bound worst-case runtime.
 */
function wagnerFischer(a, b) {
  if (a.length === 0) { return b.length; }
  if (b.length === 0) { return a.length; }
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  const curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr.slice();
  }
  return prev[n];
}

/**
 * Returns a 0–1 text divergence score between two strings.
 * Numeric-looking strings are capped at 0.20 so price/count changes don't
 * inflate the content-divergence signal and demote real layout regressions.
 * Short strings (<8 chars) are down-weighted to 0.30× to avoid false positives on labels.
 */
function textDivergenceScore(baseText, compareText) {
  const a = String(baseText  ?? '').trim().slice(0, LEVENSHTEIN_MAX_LEN);
  const b = String(compareText ?? '').trim().slice(0, LEVENSHTEIN_MAX_LEN);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) { return 0.0; }

  let ratio = wagnerFischer(a, b) / maxLen;

  const numericPattern = /^[\d,.$%\s()\-+]+$/;
  if (numericPattern.test(a) && numericPattern.test(b)) {
    ratio = Math.min(ratio, 0.20);
  }

  if (maxLen < 8) {
    ratio *= 0.30;
  }

  return Math.min(ratio, 1.0);
}

/**
 * Computes how proportional a dimension change is relative to text-content growth.
 * Returns a signal enum: PROPORTIONAL, DISPROPORTIONAL, DIRECTION_MISMATCH, or AMBIGUOUS.
 * Returns a 0.5 neutral error on unparseable values or zero-length baseline text —
 * the caller treats these as AMBIGUOUS rather than either content or layout.
 */
function geometricProportionalityError(item, diff) {
  const basePx    = parsePx(diff.baseValue);
  const comparePx = parsePx(diff.compareValue);

  if (basePx === null || comparePx === null) {
    return { error: 0.5, contentPropScore: 0.5, layoutPropScore: 0.5, signal: 'UNPARSEABLE' };
  }
  if (basePx === 0) {
    return { error: 0.5, contentPropScore: 0.5, layoutPropScore: 0.5, signal: 'ZERO_BASELINE' };
  }

  const dimensionRatio = comparePx / basePx;

  const baseLen    = (item.baseTextContent    ?? '').trim().length;
  const compareLen = (item.compareTextContent ?? '').trim().length;

  if (baseLen === 0) {
    return { error: 0.5, contentPropScore: 0.5, layoutPropScore: 0.5, signal: 'NO_BASELINE_TEXT' };
  }

  const rawTextRatio   = compareLen / baseLen;
  const textLengthRatio = Math.min(rawTextRatio, TEXT_RATIO_CAP);

  const textGrew      = compareLen >= baseLen;
  const dimensionGrew = comparePx  >= basePx;
  const dirMismatch   = textGrew !== dimensionGrew;

  const normalizer = Math.max(textLengthRatio, Math.abs(dimensionRatio), 1.0);
  let normError    = Math.min(Math.abs(textLengthRatio - dimensionRatio) / normalizer, 1.0);

  if (dirMismatch) {
    normError = Math.min(normError+0.35, 1.0);
  }

  const signal = dirMismatch ? 'DIRECTION_MISMATCH'
    : normError < 0.20 ? 'PROPORTIONAL'
      : normError > 0.65 ? 'DISPROPORTIONAL'
        : 'AMBIGUOUS';

  return {
    error:            normError,
    contentPropScore: 1.0 - normError,
    layoutPropScore:  normError,
    signal
  };
}

/**
 * Returns S3 corroboration scores based on how many times this element pattern recurs.
 * Isolated elements (rc=1) get a content bonus; widely-recurring elements (rc≥4) get
 * a layout penalty — recurring structural changes are more likely to be layout regressions.
 */
function corroborationScores(recurrenceCount) {
  const rc = recurrenceCount ?? 1;
  if (rc === 1)              { return { S3_content: 0.20, S3_layout: 0.00 }; }
  if (rc === 2 || rc === 3)  { return { S3_content: 0.05, S3_layout: 0.05 }; }
  return                            { S3_content: 0.00, S3_layout: 0.20 };
}

/**
 * Classifies a single width/height diff as content-driven or layout-driven using
 * three signals: text divergence (S1), geometric proportionality (S2), recurrence (S3).
 * Mutates `diff` in place, adding severity, narrativeLabel, and confidence fields.
 * Invariant: severity can only be demoted (lowered), never promoted — content intelligence
 * cannot increase severity above what the static analyzer assigned.
 */
function classifyDimensionalChange(item, diff) {
  const S1 = textDivergenceScore(item.baseTextContent, item.compareTextContent);
  const geo = geometricProportionalityError(item, diff);
  const { S3_content, S3_layout } = corroborationScores(item.recurrenceCount);

  const contentScore = (S1              * 0.50)
                     + (geo.contentPropScore * 0.30)
                     + S3_content;

  const layoutScore  = ((1.0 - S1)      * 0.40)
                     + (geo.layoutPropScore  * 0.35)
                     + S3_layout;

  let action, narrativeLabel, newSeverity;

  if (contentScore >= 0.65) {
    action         = 'DEMOTE';
    narrativeLabel = 'CONTENT DIVERGENCE';
    newSeverity    = 'low';
  } else if (contentScore >= 0.45 && contentScore > layoutScore) {
    action         = 'SOFT_DEMOTE';
    narrativeLabel = 'CONTENT DIVERGENCE';
    newSeverity    = 'medium';
  } else if (layoutScore >= 0.65) {
    action         = 'RETAIN';
    narrativeLabel = null;
    newSeverity    = diff.severity;
  } else {
    action         = 'SOFT_DEMOTE';
    narrativeLabel = 'CONTENT DIVERGENCE';
    newSeverity    = 'medium';
  }

  const oldOrder = SEVERITY_ORDER[diff.severity] ?? 3;
  const newOrder = SEVERITY_ORDER[newSeverity]   ?? 3;
  if (newOrder < oldOrder) {
    newSeverity = diff.severity;
    action      = 'RETAIN';
  }

  diff.originalSeverity        = diff.severity;
  diff.severity                = newSeverity;
  diff.narrativeLabel          = narrativeLabel;
  diff.classificationCf        = Math.max(contentScore, layoutScore);
  diff.classificationAmbiguous = (contentScore < 0.65 && layoutScore < 0.65);

  return { action, narrativeLabel, newSeverity, confidence: diff.classificationCf };
}

/**
 * Runs the content intelligence classifier on all width/height diffs across every
 * severity group. Mutates group items in place and re-buckets items whose overall
 * severity changed after classification.
 */
function runContentIntelligenceOnGroups(groups) {
  for (const sev of ['critical', 'high', 'medium', 'low']) {
    for (const item of (groups[sev] ?? [])) {
      const baseText = (item.baseTextContent    ?? '').trim();
      const cmpText  = (item.compareTextContent ?? '').trim();
      if (!baseText || !cmpText || baseText === cmpText) { continue; }

      let anyChanged = false;

      for (const diffs of Object.values(item.diffsByCategory ?? {})) {
        for (const diff of diffs) {
          if (diff.property !== 'width' && diff.property !== 'height') { continue; }
          const result = classifyDimensionalChange(item, diff);
          if (result.action !== 'RETAIN') { anyChanged = true; }
        }
      }

      if (!anyChanged) { continue; }

      const allDiffs = Object.values(item.diffsByCategory).flat();
      const newSev   = getTopSeverity(allDiffs);

      if ((SEVERITY_ORDER[newSev] ?? 3) > (SEVERITY_ORDER[item.severity] ?? 3)) {
        item.severity         = newSev;
        item.diffsByCategory  = buildDiffsByCategory(allDiffs);

        const allWidthHeightAreDemoted = allDiffs
          .filter(d => d.property === 'width' || d.property === 'height')
          .every(d => d.narrativeLabel === 'CONTENT DIVERGENCE');

        if (allWidthHeightAreDemoted) {
          item.narrativeLabel = 'CONTENT DIVERGENCE';
        }
      }
    }
  }
}

/** Moves items to their correct severity bucket after content-intelligence reclassification. */
function rebucketAfterIntelligence(groups) {
  const allSeverities = ['critical', 'high', 'medium', 'low'];
  const displaced     = [];

  for (const sev of allSeverities) {
    const staying = [];
    for (const item of (groups[sev] ?? [])) {
      if (item.severity !== sev) { displaced.push(item); }
      else { staying.push(item); }
    }
    groups[sev] = staying;
  }

  for (const item of displaced) {
    const target = item.severity;
    if (groups[target]) { groups[target].push(item); }
  }

  for (const sev of allSeverities) {
    groups[sev].sort((a, b) => b.totalDiffs - a.totalDiffs);
  }
}

/** Returns a coarse badge category string ('content'|'layout'|'style') for an element item. */
function classifyItemBadge(item) {
  if (item.narrativeLabel === 'CONTENT DIVERGENCE') { return 'content'; }
  const allProps = Object.values(item.diffsByCategory || {}).flat().map(d => d.property);
  const hasLayout = allProps.some(p => /position|display|flex|grid|float|overflow|visibility|z-index/.test(p));
  const hasSize   = allProps.some(p => /^width$|^height$|max-width|min-width|^margin|^padding/.test(p));
  if (hasLayout || hasSize) { return 'layout'; }
  return 'style';
}

/** Returns the narrative badge label and CSS class for an element item used in the HTML report. */
function getNarrativeBadgeForItem(item) {
  if (item.narrativeLabel === 'CONTENT DIVERGENCE') {
    return { label: 'CONTENT DIVERGENCE', cls: 'nb-content' };
  }
  const allProps = Object.values(item.diffsByCategory || {}).flat().map(d => d.property);
  const hasLayout = allProps.some(p => /position|display|flex|grid|float|overflow|visibility|z-index/.test(p));
  const hasSize   = allProps.some(p => /^width$|^height$|max-width|min-width|^margin|^padding/.test(p));
  const hasPos    = allProps.some(p => /^top$|^left$|^right$|^bottom$|transform/.test(p));
  if (hasLayout || hasSize) { return { label: 'LAYOUT SHIFT',    cls: 'nb-layout'   }; }
  if (hasPos)               { return { label: 'POSITION DRIFT',  cls: 'nb-position' }; }
  return                           { label: 'STYLE REGRESSION', cls: 'nb-style'    };
}

/**
 * Computes a 0–100 impact score for the whole comparison and writes distribution,
 * topApexNodes, and rootCauseCount onto the summary object in place.
 * Score decreases from 100 as weighted severity counts accumulate; floor is 0.
 */
function computeImpactScore(groups, summary, rawDiffCount) {
  const allRootCauses = [
    ...(groups.critical ?? []),
    ...(groups.high     ?? []),
    ...(groups.medium   ?? []),
    ...(groups.low      ?? [])
  ];

  const R_crit  = allRootCauses.filter(i => i.severity === 'critical').length;
  const R_high  = allRootCauses.filter(i => i.severity === 'high').length;
  const R_med   = allRootCauses.filter(i => i.severity === 'medium').length;
  const R_low   = allRootCauses.filter(i => i.severity === 'low').length;
  const R_total = R_crit + R_high + R_med + R_low;

  const rawPenalty = (R_crit * W_CRIT) + (R_high * W_HIGH) + (R_med * W_MED) + (R_low * W_LOW);
  const impactScore = Math.max(0, Math.round((1 - rawPenalty / MAX_PENALTY) * 100));

  const contentDemoted = allRootCauses.filter(i => i.narrativeLabel === 'CONTENT DIVERGENCE').length;

  const apexNodes = allRootCauses
    .filter(i => i.isApex)
    .sort((a, b) => (b.suppressedDiffsCount ?? 0) - (a.suppressedDiffsCount ?? 0));

  const topItems = apexNodes.length > 0
    ? apexNodes
    : [...allRootCauses].sort((a, b) => b.totalDiffs - a.totalDiffs);

  let layoutCount = 0, styleCount = 0, contentCount = 0;
  for (const item of allRootCauses) {
    const cat = classifyItemBadge(item);
    if      (cat === 'content') {contentCount++;}
    else if (cat === 'layout')  {layoutCount++;}
    else                        {styleCount++;}
  }
  const domCount = (groups.added?.length ?? 0) + (groups.removed?.length ?? 0);

  summary.impactScore        = impactScore;
  summary.rawPenalty         = rawPenalty;
  summary.rootCauseCount     = R_total;
  summary.rawDiffCount       = rawDiffCount;
  summary.contentDemoted     = contentDemoted;
  summary.severityBreakdown  = { critical: R_crit, high: R_high, medium: R_med, low: R_low };
  summary.distribution       = { layout: layoutCount, style: styleCount, content: contentCount, dom: domCount };
  summary.topApexNodes       = topItems.slice(0, 3).map(i => {
    const badge = getNarrativeBadgeForItem(i);
    return {
      hpid:                 i.hpid,
      elementKey:           i.elementKey,
      suppressedDiffsCount: i.suppressedDiffsCount ?? 0,
      totalDiffs:           i.totalDiffs,
      severity:             i.severity,
      narrativeBadgeClass:  badge.cls,
      narrativeBadgeLabel:  badge.label
    };
  });
}

/** Returns the numeric pixel delta between two CSS values, or null if either is unparseable. */
function extractPxDelta(baseValue, compareValue) {
  const base = parseFloat(baseValue);
  const cmp  = parseFloat(compareValue);
  if (isNaN(base) || isNaN(cmp)) { return null; }
  return cmp - base;
}

/**
 * Walks up the HPID path looking for the nearest ancestor that has a diff entry.
 * Returns the ancestor's absHpid, or null if none is found before reaching the root.
 * Used by BFS suppression to identify which apex node owns a child's inherited diffs.
 */
function walkUpToNearestDiffAncestor(absHpid, diffIndex) {
  let cursor = absHpid;
  for (;;) {
    const lastDot = cursor.lastIndexOf('.');
    if (lastDot === -1) { return null; }
    cursor = cursor.slice(0, lastDot);
    if (diffIndex.has(cursor)) { return cursor; }
  }
}

/** Classifies a suppressed property set as CSS_INHERIT, LAYOUT_FLOW, or MIXED. */
function classifySuppressionType(propNames) {
  const hasInheritable = propNames.some(p => INHERITABLE_PROPS.has(p));
  const hasLayout      = propNames.some(p => LAYOUT_PROPAGATION_PROPS.has(p));
  if (hasInheritable && hasLayout) { return 'MIXED'; }
  if (hasInheritable)               { return 'CSS_INHERIT'; }
  return 'LAYOUT_FLOW';
}

/** Builds a human-readable summary string for an apex node's suppressed children. */
function buildSuppressionSummary(apexMatch) {
  const diffs       = apexMatch.suppressedDiffs ?? [];
  const cssCount    = diffs.filter(d => INHERITABLE_PROPS.has(d.property)).length;
  const layoutCount = diffs.filter(d => LAYOUT_PROPAGATION_PROPS.has(d.property)).length;
  const childCount  = (apexMatch.suppressedChildren ?? []).length;
  return `${childCount} child element${childCount !== 1 ? 's' : ''} suppressed `
       + `(${cssCount} CSS inherited · ${layoutCount} layout reflow)`;
}

/** Extracts the absolute HPID from either the nested baselineElement or the flat match fields. */
function matchAbsoluteHpid(match) {
  return match.baselineElement?.absoluteHpid ?? match.absoluteHpid ?? null;
}

/** Extracts the relative HPID from either the nested baselineElement or the flat match fields. */
function matchRelativeHpid(match) {
  return match.baselineElement?.hpid ?? match.hpid ?? null;
}

/**
 * BFS apex-suppression pass: walks the diff tree from shallowest to deepest and marks
 * child elements whose diffs are fully explained by an ancestor's diff as isInherited.
 * Partially-inherited children have their redundant diffs removed from annotatedDifferences.
 * Returns the filtered results array with isInherited elements removed.
 * Invariant: only properties in INHERITABLE_PROPS or LAYOUT_PROPAGATION_PROPS are suppressed.
 */
function runBFSSuppression(results) {
  const diffIndex             = new Map();
  const absoluteToRelativeMap = new Map();

  for (const match of results) {
    const absHpid = matchAbsoluteHpid(match);
    const relHpid = matchRelativeHpid(match);
    if (absHpid && (match.annotatedDifferences?.length ?? 0) > 0) {
      diffIndex.set(absHpid, match);
      if (relHpid) { absoluteToRelativeMap.set(absHpid, relHpid); }
    }
  }

  const propMap = new Map();
  for (const [absHpid, match] of diffIndex) {
    const inner = new Map();
    for (const diff of match.annotatedDifferences) {
      inner.set(diff.property, {
        base:    diff.baseValue,
        compare: diff.compareValue,
        delta:   extractPxDelta(diff.baseValue, diff.compareValue)
      });
    }
    propMap.set(absHpid, inner);
  }

  // Process shallowest nodes first so each child walks up to a fully-resolved apex.
  const queue = Array.from(diffIndex.keys())
    .sort((a, b) => a.split('.').length - b.split('.').length);

  for (const childAbsHpid of queue) {
    const childMatch = diffIndex.get(childAbsHpid);
    if (childMatch.isInherited) { continue; }

    const parentAbsHpid = walkUpToNearestDiffAncestor(childAbsHpid, diffIndex);
    if (!parentAbsHpid) { continue; }

    let apexAbsHpid = parentAbsHpid;
    let apexMatch   = diffIndex.get(apexAbsHpid);
    if (apexMatch.isInherited && apexMatch.apexAbsHpid) {
      apexAbsHpid = apexMatch.apexAbsHpid;
      apexMatch   = diffIndex.get(apexAbsHpid);
    }

    const childProps = propMap.get(childAbsHpid);
    const apexProps  = propMap.get(apexAbsHpid);
    if (!childProps || !apexProps) { continue; }

    const inheritedPropNames = [];

    for (const [prop, childDiff] of childProps) {
      if (!apexProps.has(prop)) { continue; }
      const apexDiff = apexProps.get(prop);

      if (INHERITABLE_PROPS.has(prop)) {
        if (childDiff.base === apexDiff.base && childDiff.compare === apexDiff.compare) {
          inheritedPropNames.push(prop);
        }
      } else if (LAYOUT_PROPAGATION_PROPS.has(prop)) {
        if (childDiff.delta !== null && apexDiff.delta !== null
            && Math.abs(childDiff.delta - apexDiff.delta) <= LAYOUT_TOLERANCE_PX) {
          inheritedPropNames.push(prop);
        }
      }
    }

    if (inheritedPropNames.length === 0) { continue; }

    const suppressedSet  = new Set(inheritedPropNames);
    const residualDiffs  = childMatch.annotatedDifferences.filter(d => !suppressedSet.has(d.property));
    const suppressedDiffs = childMatch.annotatedDifferences.filter(d =>  suppressedSet.has(d.property));

    if (residualDiffs.length === 0) {
      childMatch.isInherited        = true;
      childMatch.apexAbsHpid        = apexAbsHpid;
      childMatch.suppressionType    = classifySuppressionType(inheritedPropNames);
      childMatch.inheritedPropNames = inheritedPropNames;
    } else {
      childMatch.isPartiallyInherited  = true;
      childMatch.inheritedPropNames    = inheritedPropNames;
      childMatch.suppressedDiffsCount  = suppressedDiffs.length;
      childMatch.annotatedDifferences  = residualDiffs;
      childMatch.totalDifferences      = residualDiffs.length;
    }

    apexMatch.suppressedChildren ??= [];
    apexMatch.suppressedDiffs    ??= [];
    apexMatch.suppressedChildren.push(childAbsHpid);
    apexMatch.suppressedDiffs.push(...suppressedDiffs);
    apexMatch.suppressedDiffsCount = apexMatch.suppressedDiffs.length;
    apexMatch.isApex               = true;

    const childRelHpid = absoluteToRelativeMap.get(childAbsHpid) ?? childAbsHpid;
    const childEl      = resolveElement(childMatch);
    apexMatch.suppressedChildSummaries ??= [];
    apexMatch.suppressedChildSummaries.push({
      hpid:            childRelHpid,
      elementKey:      elementLabel(childEl),
      suppressionType: classifySuppressionType(inheritedPropNames),
      propNames:       inheritedPropNames
    });
  }

  for (const match of diffIndex.values()) {
    if (match.isApex) { match.suppressionSummary = buildSuppressionSummary(match); }
  }

  return results.filter(m => !matchAbsoluteHpid(m) || !m.isInherited);
}

/** Returns a short human-readable label for an element: tag + first id/class fragments. */
function elementLabel(el) {
  const tag     = (el.tagName  || 'unknown').toLowerCase();
  const idPart  = el.elementId ? `#${el.elementId}` : '';
  const clsPart = el.className?.trim()
    ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
    : '';
  return `${tag}${idPart}${clsPart}`;
}

/** Returns the best available selector string for an element, falling back to elementLabel. */
function elementBreadcrumb(el) {
  return el.cssSelector || el.xpath || elementLabel(el);
}

/** Returns the worst severity level present in an annotated diff array, defaulting to 'low'. */
function getTopSeverity(annotatedDifferences) {
  for (const level of ['critical', 'high', 'medium', 'low']) {
    if (annotatedDifferences.some(d => d.severity === level)) { return level; }
  }
  return 'low';
}

/**
 * Groups an annotated diff array by property category and sorts each group
 * worst-severity-first so renderers can display the most important diffs at the top.
 */
function buildDiffsByCategory(annotatedDifferences) {
  const map = {};
  for (const diff of annotatedDifferences) {
    const cat = diff.category || 'other';
    if (!map[cat]) { map[cat] = []; }
    map[cat].push(diff);
  }
  for (const cat of Object.keys(map)) {
    map[cat].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3));
  }
  return map;
}

/**
 * Returns a stable string fingerprint of a diffsByCategory object.
 * Used by deduplicateGroup to detect visually identical elements with the same diff set.
 */
function diffSignature(diffsByCategory) {
  const parts = [];
  for (const diffs of Object.values(diffsByCategory || {})) {
    for (const d of diffs) {
      parts.push(`${d.property}\x02${d.baseValue}\x02${d.compareValue}`);
    }
  }
  return parts.sort().join('\x00');
}

/**
 * Removes duplicate items from a severity group where both the elementKey and full diff set
 * are identical. Keeps the first occurrence and increments its recurrenceCount.
 * Used to collapse repeated card/grid elements with identical diffs into one representative entry.
 */
function deduplicateGroup(items) {
  const seen   = new Map();
  const result = [];
  for (const item of items) {
    const sig = `${item.elementKey}\x01${diffSignature(item.diffsByCategory)}`;
    if (seen.has(sig)) {
      const rep = result[seen.get(sig)];
      rep.recurrenceCount = (rep.recurrenceCount ?? 1) + 1;
      if (!rep.recurrenceHpids) { rep.recurrenceHpids = [rep.hpid]; }
      if (item.hpid) { rep.recurrenceHpids.push(item.hpid); }
    } else {
      seen.set(sig, result.length);
      result.push({ ...item, recurrenceCount: 1, recurrenceHpids: item.hpid ? [item.hpid] : [] });
    }
  }
  return result;
}

/**
 * Returns the baselineElement object from a match, or reconstructs a minimal element object
 * from the match's flat fields when baselineElement is absent (slimmed IDB records).
 */
function resolveElement(match) {
  if (match.baselineElement) { return match.baselineElement; }
  return {
    tagName:      match.tagName,
    elementId:    match.elementId,
    className:    match.className,
    cssSelector:  match.cssSelector  ?? null,
    xpath:        match.xpath        ?? null,
    hpid:         match.hpid         ?? null,
    absoluteHpid: match.absoluteHpid ?? null,
    textContent:  match.textContent  ?? null,
    depth:        match.depth        ?? null,
    tier:         match.tier         ?? null
  };
}

/**
 * Partitions the suppression-filtered results into {critical, high, medium, low, unchanged}
 * buckets, deduplicates each bucket, and sorts by totalDiffs descending.
 */
function buildMatchedGroups(results) {
  const groups = { critical: [], high: [], medium: [], low: [], unchanged: [] };

  for (const match of results) {
    const el    = resolveElement(match);
    const diffs = match.annotatedDifferences ?? [];

    const baseText = el.textContent
                  ?? match.baselineElement?.textContent
                  ?? match.baseTextContent
                  ?? null;
    const cmpText  = match.compareElement?.textContent
                  ?? match.compareTextContent
                  ?? null;

    if ((match.totalDifferences ?? diffs.length) === 0) {
      groups.unchanged.push({
        elementKey: elementLabel(el),
        tagName:    el.tagName,
        hpid:       el.hpid ?? null
      });
      continue;
    }

    const topSeverity     = getTopSeverity(diffs);
    const diffsByCategory = buildDiffsByCategory(diffs);

    groups[topSeverity].push({
      elementKey:               elementLabel(el),
      breadcrumb:               elementBreadcrumb(el),
      elementId:                el.elementId              ?? null,
      tagName:                  el.tagName,
      hpid:                     el.hpid                   ?? null,
      absoluteHpid:             el.absoluteHpid           ?? null,
      textContent:              el.textContent            ?? null,
      baseTextContent:          baseText,
      compareTextContent:       cmpText,
      depth:                    el.depth                  ?? null,
      tier:                     el.tier                   ?? null,
      totalDiffs:               match.totalDifferences    ?? diffs.length,
      suppressedDiffsCount:     match.suppressedDiffsCount ?? 0,
      suppressionSummary:       match.suppressionSummary   ?? null,
      suppressedChildSummaries: match.suppressedChildSummaries ?? [],
      isApex:                   match.isApex              ?? false,
      isPartiallyInherited:     match.isPartiallyInherited ?? false,
      inheritedPropNames:       match.inheritedPropNames   ?? [],
      narrativeLabel:           null,
      severity:                 topSeverity,
      diffsByCategory,
      cssSelector:              el.cssSelector            ?? null,
      xpath:                    el.xpath                  ?? null,
      compareCssSelector:       match.compareCssSelector  ?? null,
      compareXpath:             match.compareXpath         ?? null,
      matchConfidence:          match.confidence,
      matchStrategy:            match.strategy
    });
  }

  for (const severity of ['critical', 'high', 'medium', 'low']) {
    groups[severity] = deduplicateGroup(groups[severity]);
    groups[severity].sort((a, b) => b.totalDiffs - a.totalDiffs);
  }

  return groups;
}

/** Builds the ambiguous group array for elements the matcher could not definitively pair. */
function buildAmbiguousGroup(ambiguousList) {
  return ambiguousList.map(entry => {
    const el = entry.baselineElement ?? {
      tagName:     entry.tagName,
      elementId:   entry.elementId,
      className:   entry.className,
      cssSelector: entry.cssSelector,
      xpath:       entry.xpath
    };
    return {
      elementKey:      elementLabel(el),
      breadcrumb:      elementBreadcrumb(el),
      elementId:       el.elementId   ?? null,
      tagName:         el.tagName,
      cssSelector:     el.cssSelector ?? null,
      xpath:           el.xpath       ?? null,
      isAmbiguous:     true,
      candidateCount:  entry.candidateCount ?? entry.ambiguousCandidates?.length ?? 0,
      candidates:      (entry.ambiguousCandidates ?? []).map(c => ({
        compareIndex:  c.compareIndex  ?? null,
        confidence:    c.confidence    ?? 0,
        strategy:      c.strategy      ?? null,
        deltaFromBest: c.deltaFromBest ?? null
      })),
      matchConfidence: entry.confidence,
      matchStrategy:   entry.strategy
    };
  });
}

/**
 * Main entry point: runs BFS suppression, content intelligence, groups matched elements
 * by severity, appends added/removed/ambiguous groups, computes the impact score,
 * and returns {summary, groups} ready for the popup renderer and all export formats.
 * @param {object} comparisonResult - Full comparison result loaded from IDB.
 * @returns {{ summary: object, groups: object }}
 */
function transformToGroupedReport(comparisonResult) {
  const { comparison, unmatchedElements, matching } = comparisonResult;
  const results         = comparison?.results   ?? [];
  const ambiguousList   = comparison?.ambiguous ?? [];
  const rawDiffCount    = results.length;

  const resultsClean    = runBFSSuppression(results);
  const matchedGroups   = buildMatchedGroups(resultsClean);

  runContentIntelligenceOnGroups(matchedGroups);
  rebucketAfterIntelligence(matchedGroups);

  const unmatchedCompare  = unmatchedElements?.compare  ?? [];
  const unmatchedBaseline = unmatchedElements?.baseline ?? [];

  const groups = {
    ...matchedGroups,
    added: unmatchedCompare.map(el => ({
      elementKey:   elementLabel(el),
      tagName:      el.tagName,
      elementId:    el.elementId    ?? null,
      className:    el.className    ?? null,
      hpid:         el.hpid         ?? null,
      absoluteHpid: el.absoluteHpid ?? null,
      cssSelector:  el.cssSelector  ?? null,
      xpath:        el.xpath        ?? null,
      textContent:  el.textContent  ?? null,
      depth:        el.depth        ?? null,
      tier:         el.tier         ?? null,
      status:       'added'
    })),
    removed: unmatchedBaseline.map(el => ({
      elementKey:   elementLabel(el),
      tagName:      el.tagName,
      elementId:    el.elementId    ?? null,
      className:    el.className    ?? null,
      hpid:         el.hpid         ?? null,
      absoluteHpid: el.absoluteHpid ?? null,
      cssSelector:  el.cssSelector  ?? null,
      xpath:        el.xpath        ?? null,
      textContent:  el.textContent  ?? null,
      depth:        el.depth        ?? null,
      tier:         el.tier         ?? null,
      status:       'removed'
    })),
    ambiguous: buildAmbiguousGroup(ambiguousList)
  };

  const summary = {
    matchRate:        matching?.matchRate        ?? 0,
    totalMatched:     matching?.totalMatched     ?? 0,
    ambiguousCount:   matching?.ambiguousCount   ?? 0,
    modified:         comparison?.summary?.modifiedElements  ?? 0,
    unchanged:        comparison?.summary?.unchangedElements ?? 0,
    added:            unmatchedCompare.length,
    removed:          unmatchedBaseline.length,
    ambiguous:        ambiguousList.length,
    severityCounts:   comparison?.summary?.severityCounts   ?? { critical: 0, high: 0, medium: 0, low: 0 },
    totalDifferences: comparison?.summary?.totalDifferences ?? 0
  };

  computeImpactScore(groups, summary, rawDiffCount);

  // summary.modified arrives as the pre-suppression count (all matched elements with any diff).
  // After BFS, rootCauseCount holds only apex nodes; the gap is suppressed children.
  // All downstream consumers (sidebar, popup, CSV, Excel) must read the post-suppression fields.
  summary.modifiedPreSuppression = summary.modified;
  summary.suppressedChildCount   = summary.modified - summary.rootCauseCount;
  summary.modified               = summary.rootCauseCount;

  // rawDiffCount === totalMatched by construction — it counts matched pairs, not diffs.
  // Kept for backward compatibility; consumers must not use it as a diff metric.
  summary.matchedPairCount = rawDiffCount;

  // propertyDiffCount: post-suppression CSS property changes across visible apex groups.
  // Distinct from totalDifferences (pre-suppression) and rawDiffCount (matched pair count).
  let propertyDiffCount = 0;
  for (const sev of ['critical', 'high', 'medium', 'low']) {
    for (const item of (groups[sev] ?? [])) {
      for (const diffs of Object.values(item.diffsByCategory ?? {})) {
        propertyDiffCount += diffs.length;
      }
    }
  }
  summary.propertyDiffCount = propertyDiffCount;

  // Accounting invariants: any failure signals a pipeline data integrity regression.
  if (globalThis.process?.env?.NODE_ENV !== 'production') {
    const sevBreakdownSum = Object.values(summary.severityBreakdown ?? {}).reduce((a, b) => a + b, 0);
    const checks = [
      [sevBreakdownSum === summary.modified,
        `sum(severityBreakdown)=${sevBreakdownSum} !== modified=${summary.modified}`],
      [summary.modified + summary.suppressedChildCount + summary.unchanged === summary.totalMatched,
        `modified(${summary.modified})+suppressed(${summary.suppressedChildCount})+unchanged(${summary.unchanged}) !== totalMatched(${summary.totalMatched})`],
    ];
    for (const [ok, msg] of checks) {
      if (!ok) {throw new Error(`[report-transformer] Invariant violated: ${msg}`);}
    }
  }

  return { summary, groups };
}

export { elementBreadcrumb, elementLabel, getTopSeverity, transformToGroupedReport };