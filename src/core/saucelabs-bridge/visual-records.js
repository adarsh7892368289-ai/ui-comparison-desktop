'use strict';

// Pure data transforms that bridge SauceLabs runner output to the IDB record
// shape the local Compare flow consumes. Kept dependency-free so they can be
// unit-tested in isolation and called from either main or renderer contexts.
//
// All inputs/outputs are plain JS objects:
//   - manifest: shape emitted by src/saucelabs-runner/extract.spec.js as
//     screenshots-manifest.json (keyframes, elementKeyframeMap, documentYById,
//     keyframeMeasurements, etc.).
//   - rect record: shape consumed by playwright-manager.buildElementRectRecords
//     and src/renderer/application/compare-workflow._rebuildVisualDiffsFromSession.

// Builds the compareHpid → baselineHpid translation map from comparator output.
// Used to re-key compare-side rect records under the baseline hpid so the
// rebuild path pairs both sides for the same logical element.
//
// Comparator results are an array of rows; each matched row has both
// baselineElement.hpid and compareElement.hpid. Unmatched rows (added/removed
// elements) have only one side and don't appear in the remap.
function buildCompareHpidRemap(comparisonResults) {
  const remap = new Map();
  for (const row of comparisonResults ?? []) {
    const baselineHpid = row?.baselineElement?.hpid ?? null;
    const compareHpid = row?.compareElement?.hpid ?? null;
    if (!baselineHpid || !compareHpid) continue;
    remap.set(compareHpid, baselineHpid);
  }
  return remap;
}

// Returns the set of keyframe ids (rawKfId, e.g. "kf_0") that contain at
// least one element with a non-zero comparison diff. Used to limit visual
// persistence to "interesting" keyframes (per Scenario C filter). Considers
// both manifests since a diff'd element may live on either side.
function computeDiffKeyframeIds(comparisonResults, baselineManifest, compareManifest) {
  const diffHpids = new Set();
  for (const row of comparisonResults ?? []) {
    if ((row?.totalDifferences ?? 0) > 0) {
      const hpid = row?.baselineElement?.hpid ?? null;
      if (hpid) diffHpids.add(hpid);
    }
  }

  const diffKeyframeIds = new Set();
  const baseMap = baselineManifest?.elementKeyframeMap ?? {};
  const compMap = compareManifest?.elementKeyframeMap ?? {};

  for (const hpid of diffHpids) {
    if (baseMap[hpid]) diffKeyframeIds.add(baseMap[hpid]);
    if (compMap[hpid]) diffKeyframeIds.add(compMap[hpid]);
  }

  return diffKeyframeIds;
}

// Builds element-level rect records from saucectl's enriched manifest.
// Mirrors playwright-manager.buildManifestFromRemeasured + buildElementRectRecords
// so the HTML exporter and visual-diff overlays receive the same record shape
// the local Compare flow produces.
//
// Parameters:
//   manifest:    screenshots-manifest.json contents (per side)
//   sessionId:   comparisonId — used as visualSessionId for IDB indexing
//   role:        'baseline' | 'compare'
//   prefixById:  Map<rawKfId, prefixedKfId> ; prefixed = `${sessionId}_${role}_${rawKfId}`
//   hpidRemap:   optional Map<sourceHpid, unifiedKey>. For compare side, this
//                translates each compare-page hpid to the matched baseline hpid;
//                pass null on baseline side.
function buildSauceRectRecords(manifest, sessionId, role, prefixById, hpidRemap = null) {
  const records = [];
  const elementKeyframeMap = manifest?.elementKeyframeMap ?? {};
  const documentYById = manifest?.documentYById ?? {};
  const documentHeight = manifest?.documentHeight ?? null;
  const viewportH = manifest?.viewportHeight ?? Infinity;
  const actualDPR = manifest?.actualDPR ?? 1;
  const measurementsByKf = new Map(
    (manifest?.keyframeMeasurements ?? []).map((m) => [m.keyframeId, m])
  );

  for (const [sourceHpid, rawKfId] of Object.entries(elementKeyframeMap)) {
    const prefixedId = prefixById.get(rawKfId);
    if (!prefixedId) continue;

    const elementKey = hpidRemap ? hpidRemap.get(sourceHpid) : sourceHpid;
    if (!elementKey) continue;

    const kfMeas = measurementsByKf.get(rawKfId) ?? null;
    const measuredById = kfMeas ? new Map(kfMeas.rects.map((r) => [r.id, r])) : new Map();
    const pseudoById = kfMeas ? new Map((kfMeas.pseudoStyles ?? []).map((p) => [p.id, p])) : new Map();
    const m = measuredById.get(sourceHpid) ?? null;
    const pseudo = pseudoById.get(sourceHpid) ?? null;
    const docY = documentYById[sourceHpid] ?? null;

    const baseRecord = {
      id: `${sessionId}_${role}_rect_${elementKey}`,
      sessionId,
      elementKey,
      tabRole: role,
      keyframeId: prefixedId,
      actualDPR,
      documentY: docY,
      totalDocumentHeight: documentHeight,
      pseudoBefore: pseudo?.before ? { ...pseudo.before, parentHpid: elementKey, pseudoType: 'before' } : null,
      pseudoAfter: pseudo?.after ? { ...pseudo.after, parentHpid: elementKey, pseudoType: 'after' } : null
    };

    if (!m || !m.found) {
      records.push({
        ...baseRecord,
        rect: null,
        rawRect: null,
        misaligned: true,
        misalignReason: m?.misalignReason ?? 'element-not-found',
        selectorAmbiguous: false,
        selectorMatchCount: null,
        rectClipped: false
      });
      continue;
    }

    const rawY = m.viewportY;
    const rawH = m.height;
    const clippedY = Math.max(0, rawY);
    const clippedBottom = Math.min(rawY + rawH, viewportH);
    const clippedH = Math.max(1, clippedBottom - clippedY);
    const rectClipped = clippedH < rawH;

    if (clippedBottom <= 0) {
      records.push({
        ...baseRecord,
        rect: null,
        rawRect: null,
        misaligned: true,
        misalignReason: 'clipped-below-fold',
        selectorAmbiguous: m.selectorAmbiguous ?? false,
        selectorMatchCount: m.selectorMatchCount ?? null,
        rectClipped: true
      });
      continue;
    }

    records.push({
      ...baseRecord,
      rect: { x: m.viewportX, y: clippedY, width: m.width, height: clippedH },
      rawRect: { x: m.viewportX, y: rawY, width: m.width, height: rawH },
      misaligned: !m.inViewport,
      misalignReason: m.inViewport ? null : (m.misalignReason ?? null),
      selectorAmbiguous: m.selectorAmbiguous ?? false,
      selectorMatchCount: m.selectorMatchCount ?? null,
      rectClipped
    });
  }

  return records;
}

export { buildCompareHpidRemap, computeDiffKeyframeIds, buildSauceRectRecords };
