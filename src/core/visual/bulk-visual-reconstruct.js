'use strict';

// Reconstructs persisted visual records (keyframes + element rects + a blob
// persistence plan) from per-report, extraction-time manifests after a bulk
// comparison has run. Mirrors the SauceLabs host-side reconstruction
// (src/renderer/application/saucelabs-workflow.js + saucelabs-bridge/visual-records.js)
// but additionally covers added/removed elements with both-pane "context"
// regions, matching the post-comparison capture path.
//
// elementKey convention (matches the HTML viewer's VISUAL_MANIFEST[hpid] lookup):
//   - matched/modified -> baseline hpid (compare rect remapped onto it)
//   - removed (baseline-only) -> baseline hpid (compare side = context region)
//   - added   (compare-only)  -> compare  hpid (baseline side = context region)

function hpidAncestors(hpid) {
  const parts = String(hpid).split('.');
  const out = [];
  for (let i = parts.length - 1; i >= 1; i--) {
    out.push(parts.slice(0, i).join('.'));
  }
  return out;
}

function nearestMappedAncestor(hpid, map) {
  for (const ancestor of hpidAncestors(hpid)) {
    if (map.has(ancestor)) { return ancestor; }
  }
  return null;
}

function buildMatchMaps(comparisonResults) {
  const baseToCompare = new Map();
  const compareToBase = new Map();
  for (const row of comparisonResults ?? []) {
    const b = row?.baselineElement?.hpid ?? null;
    const c = row?.compareElement?.hpid ?? null;
    if (!b || !c) { continue; }
    if (!baseToCompare.has(b)) { baseToCompare.set(b, c); }
    if (!compareToBase.has(c)) { compareToBase.set(c, b); }
  }
  return { baseToCompare, compareToBase };
}

function manifestIndex(manifest) {
  // A null manifest yields an empty index: lookups miss, so a side with no
  // captured screenshots simply contributes no records (real or context).
  const elementKeyframeMap = manifest?.elementKeyframeMap ?? {};
  const documentYById = manifest?.documentYById ?? {};
  const measurementsByKf = new Map(
    (manifest?.keyframeMeasurements ?? []).map((m) => [m.keyframeId, m])
  );
  return {
    elementKeyframeMap,
    documentYById,
    measurementsByKf,
    documentHeight: manifest?.documentHeight ?? null,
    viewportHeight: manifest?.viewportHeight ?? Infinity,
    actualDPR: manifest?.actualDPR ?? 1
  };
}

// Builds a single rect record for `elementKey` on `role`, reading the geometry
// of `sourceHpid` from `idx` (the source side's manifest index). Returns null
// when the source element was never captured. `prefixById` records every raw
// keyframe id that is actually referenced so the caller can persist exactly
// those keyframes/blobs.
//
// NOTE: the clip/misalign/pseudo geometry below is intentionally identical to
// buildSauceRectRecords() in ../saucelabs-bridge/visual-records.js — they must
// stay in lockstep so SauceLabs and bulk reports draw highlights the same way.
// They are kept separate because the iteration models differ (Sauce walks
// elementKeyframeMap with an optional remap; this drives per-(elementKey,
// sourceHpid) to support added/removed context regions). If you change the rect
// record shape or clipping math, update BOTH.
function buildRectRecord(idx, sessionId, role, elementKey, sourceHpid, prefixById) {
  const rawKfId = idx.elementKeyframeMap[sourceHpid];
  if (!rawKfId) { return null; }

  const prefixedId = `${sessionId}_${role}_${rawKfId}`;
  prefixById.set(rawKfId, prefixedId);

  const kfMeas = idx.measurementsByKf.get(rawKfId) ?? null;
  const measuredById = kfMeas ? new Map(kfMeas.rects.map((r) => [r.id, r])) : new Map();
  const pseudoById = kfMeas ? new Map((kfMeas.pseudoStyles ?? []).map((p) => [p.id, p])) : new Map();
  const m = measuredById.get(sourceHpid) ?? null;
  const pseudo = pseudoById.get(sourceHpid) ?? null;
  const docY = idx.documentYById[sourceHpid] ?? null;

  const base = {
    id: `${sessionId}_${role}_rect_${elementKey}`,
    sessionId,
    elementKey,
    tabRole: role,
    keyframeId: prefixedId,
    actualDPR: idx.actualDPR,
    documentY: docY,
    totalDocumentHeight: idx.documentHeight,
    pseudoBefore: pseudo?.before ? { ...pseudo.before, parentHpid: elementKey, pseudoType: 'before' } : null,
    pseudoAfter: pseudo?.after ? { ...pseudo.after, parentHpid: elementKey, pseudoType: 'after' } : null
  };

  if (!m || !m.found) {
    return {
      ...base, rect: null, rawRect: null, misaligned: true,
      misalignReason: m?.misalignReason ?? 'element-not-found',
      selectorAmbiguous: false, selectorMatchCount: null, rectClipped: false
    };
  }

  const rawY = m.viewportY;
  const rawH = m.height;
  const clippedY = Math.max(0, rawY);
  const clippedBottom = Math.min(rawY + rawH, idx.viewportHeight);
  const clippedH = Math.max(1, clippedBottom - clippedY);

  if (clippedBottom <= 0) {
    return {
      ...base, rect: null, rawRect: null, misaligned: true,
      misalignReason: 'clipped-below-fold',
      selectorAmbiguous: m.selectorAmbiguous ?? false,
      selectorMatchCount: m.selectorMatchCount ?? null, rectClipped: true
    };
  }

  return {
    ...base,
    rect: { x: m.viewportX, y: clippedY, width: m.width, height: clippedH },
    rawRect: { x: m.viewportX, y: rawY, width: m.width, height: rawH },
    misaligned: !m.inViewport,
    misalignReason: m.inViewport ? null : (m.misalignReason ?? null),
    selectorAmbiguous: m.selectorAmbiguous ?? false,
    selectorMatchCount: m.selectorMatchCount ?? null,
    rectClipped: clippedH < rawH
  };
}

function buildKeyframeRecords(manifest, sessionId, role, prefixById) {
  const records = [];
  for (const kf of manifest?.keyframes ?? []) {
    const prefixedId = prefixById.get(kf.id);
    if (!prefixedId) { continue; }
    records.push({
      id: prefixedId,
      sessionId,
      keyframeId: prefixedId,
      scrollY: kf.scrollY ?? 0,
      viewportWidth: kf.viewportWidth ?? 0,
      viewportHeight: kf.viewportHeight ?? 0,
      tabRole: role,
      elementIds: kf.elementIds ?? []
    });
  }
  return records;
}

/**
 * @param {object} params
 * @param {string} params.sessionId        visual session id (== comparisonId)
 * @param {Array}  params.comparisonResults matched rows (baselineElement/compareElement/totalDifferences)
 * @param {object} params.unmatchedElements { baseline:[{hpid}], compare:[{hpid}] }
 * @param {object} params.baselineManifest  sauce-shaped extraction manifest
 * @param {object} params.compareManifest   sauce-shaped extraction manifest
 * @returns {{ keyframeRecords, rectRecords, blobPlan }}
 *   blobPlan: [{ side:'baseline'|'compare', rawKfId, prefixedId }]
 */
function reconstructBulkVisualRecords({
  sessionId,
  comparisonResults,
  unmatchedElements,
  baselineManifest,
  compareManifest
}) {
  const empty = { keyframeRecords: [], rectRecords: [], blobPlan: [] };
  // At least one side must have a manifest; the other may be absent (e.g. the
  // opposite side reused a screenshot-less report), in which case only the
  // present side's real rects are produced and context regions are skipped.
  if (!sessionId || (!baselineManifest && !compareManifest)) { return empty; }

  const baseIdx = manifestIndex(baselineManifest);
  const cmpIdx = manifestIndex(compareManifest);
  const { baseToCompare, compareToBase } = buildMatchMaps(comparisonResults);

  const basePrefixById = new Map();
  const cmpPrefixById = new Map();
  const rectRecords = [];

  const pushBase = (elementKey, sourceHpid) => {
    const rec = buildRectRecord(baseIdx, sessionId, 'baseline', elementKey, sourceHpid, basePrefixById);
    if (rec) { rectRecords.push(rec); }
    return rec;
  };
  const pushCmp = (elementKey, sourceHpid) => {
    const rec = buildRectRecord(cmpIdx, sessionId, 'compare', elementKey, sourceHpid, cmpPrefixById);
    if (rec) { rectRecords.push(rec); }
    return rec;
  };

  // Modified matched pairs: both real rects, keyed under baseline hpid.
  for (const row of comparisonResults ?? []) {
    if ((row?.totalDifferences ?? 0) <= 0) { continue; }
    const baseHpid = row?.baselineElement?.hpid ?? null;
    const cmpHpid = row?.compareElement?.hpid ?? null;
    if (!baseHpid) { continue; }
    pushBase(baseHpid, baseHpid);
    if (cmpHpid) { pushCmp(baseHpid, cmpHpid); }
  }

  // Removed (baseline-only): real baseline rect + compare context region.
  for (const el of unmatchedElements?.baseline ?? []) {
    const baseHpid = el?.hpid ?? null;
    if (!baseHpid) { continue; }
    pushBase(baseHpid, baseHpid);
    const ancestor = nearestMappedAncestor(baseHpid, baseToCompare);
    if (ancestor) { pushCmp(baseHpid, baseToCompare.get(ancestor)); }
  }

  // Added (compare-only): real compare rect + baseline context region.
  for (const el of unmatchedElements?.compare ?? []) {
    const cmpHpid = el?.hpid ?? null;
    if (!cmpHpid) { continue; }
    pushCmp(cmpHpid, cmpHpid);
    const ancestor = nearestMappedAncestor(cmpHpid, compareToBase);
    if (ancestor) { pushBase(cmpHpid, compareToBase.get(ancestor)); }
  }

  const keyframeRecords = [
    ...buildKeyframeRecords(baselineManifest, sessionId, 'baseline', basePrefixById),
    ...buildKeyframeRecords(compareManifest, sessionId, 'compare', cmpPrefixById)
  ];

  const blobPlan = [];
  for (const [rawKfId, prefixedId] of basePrefixById) {
    blobPlan.push({ side: 'baseline', rawKfId, prefixedId });
  }
  for (const [rawKfId, prefixedId] of cmpPrefixById) {
    blobPlan.push({ side: 'compare', rawKfId, prefixedId });
  }

  return { keyframeRecords, rectRecords, blobPlan };
}

export { reconstructBulkVisualRecords, hpidAncestors, nearestMappedAncestor };
