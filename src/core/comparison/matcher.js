import logger                                from '../../infrastructure/logger.js';
import { get }                               from '../../config/defaults.js';
import { yieldToEventLoop, YIELD_CHUNK_SIZE, progressFrame, resultFrame } from './async-utils.js';

const MatchType = Object.freeze({
  DEFINITIVE:         'definitive',
  POSITIONAL:         'positional',
  AMBIGUOUS:          'ambiguous',
  ADDED:              'added',
  REMOVED:            'removed',
  UNMATCHED_BASELINE: 'unmatched-baseline',
  UNMATCHED_COMPARE:  'unmatched-compare'
});

function getTestAttrKey(el, anchorAttributes) {
  for (const attr of anchorAttributes) {
    const val = el.attributes?.[attr];
    if (val) { return `${attr}::${val}`; }
  }
  return null;
}

function hpidSuffixKey(hpid, depth) {
  if (!hpid) { return null; }
  const parts = hpid.split('.');
  return parts.length <= depth ? hpid : parts.slice(-depth).join('.');
}

function parseHpidSegments(hpid) {
  if (!hpid) { return []; }
  return hpid.split('.').map(Number);
}

function segmentsEqual(a, b) {
  if (a.length !== b.length) { return false; }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) { return false; }
  }
  return true;
}

function buildMultiMap(items, availableIdxs, keyFn) {
  const map = new Map();
  for (const i of availableIdxs) {
    const key = keyFn(items[i]);
    if (key === null) { continue; }
    if (!map.has(key)) { map.set(key, []); }
    map.get(key).push(i);
  }
  return map;
}

function resolveFromMultiMap(indices, confidence, usedCompare, minMatchThreshold) {
  if (!indices) { return { verdict: 'no_match' }; }
  const available = indices.filter(i => !usedCompare.has(i));
  if (available.length === 0) { return { verdict: 'no_match' }; }
  if (available.length === 1) {
    return confidence >= minMatchThreshold
      ? { verdict: 'definitive', index: available[0], confidence }
      : { verdict: 'below_threshold', index: available[0], confidence };
  }
  if (confidence >= minMatchThreshold) {
    return {
      verdict:    'ambiguous',
      confidence,
      candidates: available.map(compareIndex => ({ compareIndex, confidence, deltaFromBest: 0 }))
    };
  }
  return { verdict: 'no_match' };
}

function makeDefinitiveMatch({ bi, ci, conf, strat, matchType, baseline, compareElements }) {
  return {
    baselineIndex:       bi,
    compareIndex:        ci,
    confidence:          conf,
    strategy:            strat,
    matchType,
    isAmbiguous:         false,
    ambiguousCandidates: null,
    baselineElement:     baseline[bi],
    compareElement:      compareElements[ci],
    mutations:           []
  };
}

function makeAmbiguousMatch(bi, conf, strat, candidates, baseline) {
  return {
    baselineIndex:       bi,
    compareIndex:        null,
    confidence:          conf,
    strategy:            strat,
    matchType:           MatchType.AMBIGUOUS,
    isAmbiguous:         true,
    ambiguousCandidates: candidates.map(c => ({ ...c, strategy: strat })),
    baselineElement:     baseline[bi],
    compareElement:      null,
    mutations:           []
  };
}

function passesIdentityTriad(bEl, cEl) {
  if (bEl.tagName !== cEl.tagName) { return false; }
  const bSegs = parseHpidSegments(bEl.hpid);
  const cSegs = parseHpidSegments(cEl.hpid);
  return segmentsEqual(bSegs, cSegs);
}

function isReplacement(bEl, cEl) {
  const bSegs = parseHpidSegments(bEl.hpid);
  const cSegs = parseHpidSegments(cEl.hpid);
  return segmentsEqual(bSegs, cSegs) && bEl.tagName !== cEl.tagName;
}

function sequenceAlign(baseline, compare, usedBaseline, usedCompare, config) {
  const { lookAheadWindow, inSequenceConf } = config;

  const pairs          = [];
  const added          = [];
  const removed        = [];
  const orphanBaseline = [];
  const orphanCompare  = [];

  let bi = 0;
  let ci = 0;

  while (bi < baseline.length && ci < compare.length) {
    if (usedBaseline.has(bi)) { bi++; continue; }
    if (usedCompare.has(ci))  { ci++; continue; }

    const bEl = baseline[bi];
    const cEl = compare[ci];

    if (isReplacement(bEl, cEl)) {
      removed.push(bi);
      added.push(ci);
      bi++;
      ci++;
      continue;
    }

    if (passesIdentityTriad(bEl, cEl)) {
      pairs.push({ bi, ci, confidence: inSequenceConf, strategy: 'sequence-hpid' });
      usedBaseline.add(bi);
      usedCompare.add(ci);
      bi++;
      ci++;
      continue;
    }

    let foundInCompare = -1;
    for (let k = 1; k <= lookAheadWindow; k++) {
      const cLook = ci + k;
      if (cLook >= compare.length) { break; }
      if (usedCompare.has(cLook)) { continue; }
      if (passesIdentityTriad(bEl, compare[cLook])) { foundInCompare = cLook; break; }
    }

    if (foundInCompare !== -1) {
      for (let k = ci; k < foundInCompare; k++) {
        if (!usedCompare.has(k)) { added.push(k); }
      }
      pairs.push({ bi, ci: foundInCompare, confidence: inSequenceConf - 0.05, strategy: 'sequence-resync-add' });
      usedBaseline.add(bi);
      usedCompare.add(foundInCompare);
      ci = foundInCompare + 1;
      bi++;
      continue;
    }

    let foundInBaseline = -1;
    for (let k = 1; k <= lookAheadWindow; k++) {
      const bLook = bi + k;
      if (bLook >= baseline.length) { break; }
      if (usedBaseline.has(bLook)) { continue; }
      if (passesIdentityTriad(baseline[bLook], cEl)) { foundInBaseline = bLook; break; }
    }

    if (foundInBaseline !== -1) {
      for (let k = bi; k < foundInBaseline; k++) {
        if (!usedBaseline.has(k)) { removed.push(k); }
      }
      pairs.push({ bi: foundInBaseline, ci, confidence: inSequenceConf - 0.05, strategy: 'sequence-resync-remove' });
      usedBaseline.add(foundInBaseline);
      usedCompare.add(ci);
      bi = foundInBaseline + 1;
      ci++;
      continue;
    }

    orphanBaseline.push(bi);
    orphanCompare.push(ci);
    usedBaseline.add(bi);
    usedCompare.add(ci);
    bi++;
    ci++;
  }

  while (bi < baseline.length) {
    if (!usedBaseline.has(bi)) { removed.push(bi); }
    bi++;
  }
  while (ci < compare.length) {
    if (!usedCompare.has(ci)) { added.push(ci); }
    ci++;
  }

  return { pairs, added, removed, orphanBaseline, orphanCompare };
}

function buildSuffixIndex(compareElements, availableIdxs, suffixDepth) {
  const index    = new Map();
  const minDepth = Math.max(2, Math.floor(suffixDepth / 2));

  for (const ci of availableIdxs) {
    const el   = compareElements[ci];
    const hpid = el.hpid;
    if (!hpid || hpid.split('.').length < minDepth) { continue; }
    const key = `${hpidSuffixKey(hpid, suffixDepth)}::${el.tagName ?? ''}`;
    if (!index.has(key)) { index.set(key, []); }
    index.get(key).push(ci);
  }
  return index;
}

function suffixRealignPass(
  baseline,
  compareElements,
  orphanBaselineIdxs,
  orphanCompareIdxs,
  usedCompare,
  suffixDepth,
  suffixConf
) {
  const index             = buildSuffixIndex(compareElements, orphanCompareIdxs, suffixDepth);
  const pairs             = [];
  const stillOrphanBaseline = [];

  for (const bi of orphanBaselineIdxs) {
    const bEl  = baseline[bi];
    const hpid = bEl.hpid;
    if (!hpid || hpid.split('.').length < Math.max(2, Math.floor(suffixDepth / 2))) {
      stillOrphanBaseline.push(bi);
      continue;
    }
    const key       = `${hpidSuffixKey(hpid, suffixDepth)}::${bEl.tagName ?? ''}`;
    const hits      = index.get(key);
    const available = hits ? hits.filter(i => !usedCompare.has(i)) : [];

    if (available.length === 1) {
      const ci = available[0];
      usedCompare.add(ci);
      pairs.push({ bi, ci, confidence: suffixConf, strategy: 'suffix-realign' });
    } else {
      stillOrphanBaseline.push(bi);
    }
  }

  return { pairs, stillOrphanBaseline };
}

function buildTestAttributeClassifier(cmpIdxs, usedCompare, baseline, compareElements, matchConfig, strategy) {
  const { anchorAttributes, minMatchThreshold } = matchConfig;
  const map = buildMultiMap(compareElements, cmpIdxs, el => getTestAttrKey(el, anchorAttributes));
  return (bi) => {
    const key = getTestAttrKey(baseline[bi], anchorAttributes);
    if (!key) { return { kind: 'orphan' }; }
    const res = resolveFromMultiMap(map.get(key), strategy.confidence, usedCompare, minMatchThreshold);
    if (res.verdict === 'definitive') {
      usedCompare.add(res.index);
      return { kind: 'match', match: makeDefinitiveMatch({ bi, ci: res.index, conf: res.confidence, strat: strategy.id, matchType: MatchType.DEFINITIVE, baseline, compareElements }) };
    }
    if (res.verdict === 'ambiguous') {
      return { kind: 'ambiguous', entry: makeAmbiguousMatch(bi, res.confidence, strategy.id, res.candidates, baseline) };
    }
    return { kind: 'orphan' };
  };
}

function buildAbsoluteHpidClassifier(cmpIdxs, usedCompare, baseline, compareElements, matchConfig, strategy) {
  const { minMatchThreshold } = matchConfig;
  const map = buildMultiMap(compareElements, cmpIdxs, el => el.absoluteHpid ?? null);
  return (bi) => {
    const hpid = baseline[bi].absoluteHpid;
    if (!hpid) { return { kind: 'orphan' }; }
    const res = resolveFromMultiMap(map.get(hpid), strategy.confidence, usedCompare, minMatchThreshold);
    if (res.verdict === 'definitive') {
      usedCompare.add(res.index);
      return { kind: 'match', match: makeDefinitiveMatch({ bi, ci: res.index, conf: res.confidence, strat: strategy.id, matchType: MatchType.DEFINITIVE, baseline, compareElements }) };
    }
    if (res.verdict === 'ambiguous') {
      return { kind: 'ambiguous', entry: makeAmbiguousMatch(bi, res.confidence, strategy.id, res.candidates, baseline) };
    }
    return { kind: 'orphan' };
  };
}

function buildIdClassifier(cmpIdxs, usedCompare, baseline, compareElements, matchConfig, strategy) {
  const { minMatchThreshold } = matchConfig;
  const map = buildMultiMap(compareElements, cmpIdxs, el => el.elementId || null);
  return (bi) => {
    const elId = baseline[bi].elementId;
    if (!elId) { return { kind: 'orphan' }; }
    const res = resolveFromMultiMap(map.get(elId), strategy.confidence, usedCompare, minMatchThreshold);
    if (res.verdict === 'definitive') {
      usedCompare.add(res.index);
      return { kind: 'match', match: makeDefinitiveMatch({ bi, ci: res.index, conf: res.confidence, strat: strategy.id, matchType: MatchType.DEFINITIVE, baseline, compareElements }) };
    }
    if (res.verdict === 'ambiguous') {
      return { kind: 'ambiguous', entry: makeAmbiguousMatch(bi, res.confidence, strategy.id, res.candidates, baseline) };
    }
    return { kind: 'orphan' };
  };
}

function buildCssSelectorClassifier(cmpIdxs, usedCompare, baseline, compareElements, matchConfig, strategy) {
  const { minMatchThreshold } = matchConfig;
  const map = buildMultiMap(compareElements, cmpIdxs, el => el.cssSelector ?? null);
  return (bi) => {
    const sel = baseline[bi].cssSelector;
    if (!sel) { return { kind: 'orphan' }; }
    const res = resolveFromMultiMap(map.get(sel), strategy.confidence, usedCompare, minMatchThreshold);
    if (res.verdict === 'definitive') {
      usedCompare.add(res.index);
      return { kind: 'match', match: makeDefinitiveMatch({ bi, ci: res.index, conf: res.confidence, strat: strategy.id, matchType: MatchType.DEFINITIVE, baseline, compareElements }) };
    }
    if (res.verdict === 'ambiguous') {
      return { kind: 'ambiguous', entry: makeAmbiguousMatch(bi, res.confidence, strategy.id, res.candidates, baseline) };
    }
    return { kind: 'orphan' };
  };
}

function buildXpathClassifier(cmpIdxs, usedCompare, baseline, compareElements, matchConfig, strategy) {
  const { minMatchThreshold } = matchConfig;
  const map = buildMultiMap(compareElements, cmpIdxs, el => el.xpath ?? null);
  return (bi) => {
    const xp = baseline[bi].xpath;
    if (!xp) { return { kind: 'orphan' }; }
    const res = resolveFromMultiMap(map.get(xp), strategy.confidence, usedCompare, minMatchThreshold);
    if (res.verdict === 'definitive') {
      usedCompare.add(res.index);
      return { kind: 'match', match: makeDefinitiveMatch({ bi, ci: res.index, conf: res.confidence, strat: strategy.id, matchType: MatchType.DEFINITIVE, baseline, compareElements }) };
    }
    if (res.verdict === 'ambiguous') {
      return { kind: 'ambiguous', entry: makeAmbiguousMatch(bi, res.confidence, strategy.id, res.candidates, baseline) };
    }
    return { kind: 'orphan' };
  };
}

function buildPositionGrid(compareElements, availableIdxs, cellSize) {
  const grid = new Map();
  for (const i of availableIdxs) {
    const { rect, tagName } = compareElements[i];
    if (!rect || rect.x === null || rect.y === null) { continue; }
    const cx  = Math.floor(rect.x / cellSize);
    const cy  = Math.floor(rect.y / cellSize);
    const key = `${cx}:${cy}:${tagName}`;
    if (!grid.has(key)) { grid.set(key, []); }
    grid.get(key).push({ index: i, x: rect.x, y: rect.y });
  }
  return grid;
}

function pickFromGrid(bx, by, tag, grid, cellSize, usedCompare) {
  const cx     = Math.floor(bx / cellSize);
  const cy     = Math.floor(by / cellSize);
  let bestIdx  = null;
  let bestDist = Infinity;

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = grid.get(`${cx + dx}:${cy + dy}:${tag}`);
      if (!bucket) { continue; }
      for (const { index, x, y } of bucket) {
        if (usedCompare.has(index)) { continue; }
        const dist = Math.hypot(bx - x, by - y);
        if (dist < cellSize && dist < bestDist) { bestDist = dist; bestIdx = index; }
      }
    }
  }

  if (bestIdx === null) { return null; }
  return { index: bestIdx, confidence: Math.max(0.1, 1 - bestDist / cellSize) * 0.30 };
}

function buildPositionClassifier(cmpIdxs, usedCompare, baseline, compareElements, cellSize, minConf, strategy) {
  const grid      = buildPositionGrid(compareElements, cmpIdxs, cellSize);
  const usedLocal = new Set();
  return (bi) => {
    const rect = baseline[bi].rect;
    if (rect?.x === null || rect?.y === null) { return { kind: 'orphan' }; }
    const hit = pickFromGrid(rect.x, rect.y, baseline[bi].tagName, grid, cellSize, usedCompare);
    if (hit && hit.confidence >= minConf && !usedLocal.has(hit.index)) {
      usedLocal.add(hit.index);
      usedCompare.add(hit.index);
      return { kind: 'match', match: makeDefinitiveMatch({ bi, ci: hit.index, conf: hit.confidence, strat: strategy.id, matchType: MatchType.POSITIONAL, baseline, compareElements }) };
    }
    return { kind: 'orphan' };
  };
}

const LEGACY_CLASSIFIER_BUILDERS = Object.freeze({
  'test-attribute': (cmpIdxs, usedCompare, baseline, cmpEls, matchConfig, strategy) =>
    buildTestAttributeClassifier(cmpIdxs, usedCompare, baseline, cmpEls, matchConfig, strategy),
  'absolute-hpid': (cmpIdxs, usedCompare, baseline, cmpEls, matchConfig, strategy) =>
    buildAbsoluteHpidClassifier(cmpIdxs, usedCompare, baseline, cmpEls, matchConfig, strategy),
  'id': (cmpIdxs, usedCompare, baseline, cmpEls, matchConfig, strategy) =>
    buildIdClassifier(cmpIdxs, usedCompare, baseline, cmpEls, matchConfig, strategy),
  'css-selector': (cmpIdxs, usedCompare, baseline, cmpEls, matchConfig, strategy) =>
    buildCssSelectorClassifier(cmpIdxs, usedCompare, baseline, cmpEls, matchConfig, strategy),
  'xpath': (cmpIdxs, usedCompare, baseline, cmpEls, matchConfig, strategy) =>
    buildXpathClassifier(cmpIdxs, usedCompare, baseline, cmpEls, matchConfig, strategy),
  'position': (cmpIdxs, usedCompare, baseline, cmpEls, matchConfig, strategy, cellSize, minConf) =>
    buildPositionClassifier(cmpIdxs, usedCompare, baseline, cmpEls, cellSize, minConf, strategy)
});

async function* runChunkedPass(indices, classifyFn, progressCtx) {
  const { label, startPct, endPct } = progressCtx;
  const total     = indices.length;
  const matches   = [];
  const ambiguous = [];
  const orphans   = [];

  for (let start = 0; start < total; start += YIELD_CHUNK_SIZE) {
    const end = Math.min(start + YIELD_CHUNK_SIZE, total);
    for (let i = start; i < end; i++) {
      const hit = classifyFn(indices[i]);
      if (hit.kind === 'match')          { matches.push(hit.match); }
      else if (hit.kind === 'ambiguous') { ambiguous.push(hit.entry); }
      else                               { orphans.push(indices[i]); }
    }
    await yieldToEventLoop();
    yield progressFrame(label, Math.round(startPct + (end / total) * (endPct - startPct)));
  }

  if (total === 0) { yield progressFrame(label, endPct); }
  yield resultFrame({ matches, ambiguous, orphans });
}

class ElementMatcher {
  #minConf;
  #minMatchThreshold;
  #ambiguityWindow;
  #cellSize;
  #anchorAttributes;
  #lookAheadWindow;
  #suffixDepth;
  #inSequenceConf;
  #suffixConf;
  #sequenceAlignEnabled;

  constructor() {
    this.#minConf              = get('comparison.matching.confidenceThreshold', 0.5);
    this.#minMatchThreshold    = get('comparison.matching.minMatchThreshold', 0.70);
    this.#ambiguityWindow      = get('comparison.matching.ambiguityWindow', 0.12);
    this.#cellSize             = get('comparison.matching.positionTolerance', 50);
    this.#anchorAttributes     = get('comparison.matching.anchorAttributes');
    this.#lookAheadWindow      = get('comparison.matching.sequenceAlignment.lookAheadWindow', 5);
    this.#suffixDepth          = get('comparison.matching.sequenceAlignment.suffixDepth', 5);
    this.#inSequenceConf       = get('comparison.matching.sequenceAlignment.inSequenceConf', 0.99);
    this.#suffixConf           = get('comparison.matching.sequenceAlignment.suffixConf', 0.85);
    this.#sequenceAlignEnabled = get('comparison.matching.sequenceAlignment.enabled', true);
  }

  async* matchElements(baseline, compareElements) {
    logger.info('Sequence-aware matching start', {
      baseline: baseline.length,
      compare:  compareElements.length
    });

    const usedBaseline = new Set();
    const usedCompare  = new Set();
    const allMatches   = [];
    const allAmbiguous = [];

    yield progressFrame('Anchoring by test attributes…', 5);

    const testAttrStrategy = get('comparison.matching.strategies')
      .find(s => s.id === 'test-attribute' && s.enabled);

    if (testAttrStrategy) {
      const allBaseIdxs = Array.from({ length: baseline.length },        (_, i) => i);
      const allCmpIdxs  = Array.from({ length: compareElements.length }, (_, i) => i);
      const matchConfig = {
        anchorAttributes:  this.#anchorAttributes,
        minMatchThreshold: this.#minMatchThreshold,
        ambiguityWindow:   this.#ambiguityWindow
      };

      const phase0Classify = buildTestAttributeClassifier(
        allCmpIdxs, usedCompare, baseline, compareElements, matchConfig, testAttrStrategy
      );

      let phase0Result = null;
      for await (const frame of runChunkedPass(
        allBaseIdxs, phase0Classify,
        { label: testAttrStrategy.label, startPct: 5, endPct: 20 }
      )) {
        if (frame.type === 'result') { phase0Result = frame.payload; }
        else { yield frame; }
      }

      for (const match of phase0Result.matches) {
        usedBaseline.add(match.baselineIndex);
        usedCompare.add(match.compareIndex);
        allMatches.push(match);
      }
      allAmbiguous.push(...phase0Result.ambiguous);
    }

    yield progressFrame('Running sequence alignment…', 20);

    if (this.#sequenceAlignEnabled) {
      await yieldToEventLoop();

      const alignResult = sequenceAlign(baseline, compareElements, usedBaseline, usedCompare, {
        anchorAttributes: this.#anchorAttributes,
        lookAheadWindow:  this.#lookAheadWindow,
        inSequenceConf:   this.#inSequenceConf
      });

      for (const { bi, ci, confidence, strategy } of alignResult.pairs) {
        allMatches.push(makeDefinitiveMatch({
          bi, ci, conf: confidence, strat: strategy,
          matchType: MatchType.DEFINITIVE, baseline, compareElements
        }));
      }

      for (const ci of alignResult.added)  { usedCompare.add(ci); }
      for (const bi of alignResult.removed) { usedBaseline.add(bi); }

      yield progressFrame('Sequence alignment complete…', 45);
      await yieldToEventLoop();

      const orphanCompareIdxs = alignResult.orphanCompare.filter(i => !usedCompare.has(i));

      const { pairs: suffixPairs, stillOrphanBaseline } = suffixRealignPass(
        baseline, compareElements,
        alignResult.orphanBaseline, orphanCompareIdxs,
        usedCompare, this.#suffixDepth, this.#suffixConf
      );

      for (const { bi, ci, confidence, strategy } of suffixPairs) {
        allMatches.push(makeDefinitiveMatch({
          bi, ci, conf: confidence, strat: strategy,
          matchType: MatchType.DEFINITIVE, baseline, compareElements
        }));
        usedBaseline.add(bi);
      }

      yield progressFrame('Re-alignment complete…', 55);

      const legacyStrategies = get('comparison.matching.strategies')
        .filter(s => s.enabled && s.id !== 'test-attribute')
        .sort((a, b) => b.confidence - a.confidence);

      const legacyBaseOrphans = stillOrphanBaseline.filter(i => !usedBaseline.has(i));
      const legacyCmpOrphans  = Array.from({ length: compareElements.length }, (_, i) => i)
        .filter(i => !usedCompare.has(i));

      const matchConfig = {
        anchorAttributes:  this.#anchorAttributes,
        minMatchThreshold: this.#minMatchThreshold,
        ambiguityWindow:   this.#ambiguityWindow
      };

      let mutableBaseOrphans = legacyBaseOrphans.slice();
      let mutableCmpOrphans  = legacyCmpOrphans.slice();

      const totalLegacy = legacyStrategies.length;
      for (let si = 0; si < totalLegacy; si++) {
        const strategy = legacyStrategies[si];
        const startPct = 55 + Math.round((si       / totalLegacy) * 35);
        const endPct   = 55 + Math.round(((si + 1) / totalLegacy) * 35);
        const builder  = LEGACY_CLASSIFIER_BUILDERS[strategy.id];
        if (!builder) { continue; }

        const classify = builder(
          mutableCmpOrphans, usedCompare, baseline, compareElements,
          matchConfig, strategy, this.#cellSize, this.#minConf
        );

        let passResult = null;
        for await (const frame of runChunkedPass(
          mutableBaseOrphans, classify, { label: strategy.label, startPct, endPct }
        )) {
          if (frame.type === 'result') { passResult = frame.payload; }
          else { yield frame; }
        }

        allMatches.push(...passResult.matches);
        allAmbiguous.push(...passResult.ambiguous);
        mutableBaseOrphans = passResult.orphans;
        mutableCmpOrphans  = mutableCmpOrphans.filter(i => !usedCompare.has(i));
      }

      const reservedByAmbiguous = new Set(
        allAmbiguous.flatMap(e => (e.ambiguousCandidates ?? []).map(c => c.compareIndex))
      );

      const finalUnmatchedBaselineIdxs = new Set([...alignResult.removed, ...mutableBaseOrphans]);
      const finalUnmatchedCompareIdxs  = new Set([
        ...alignResult.added,
        ...mutableCmpOrphans.filter(i => !reservedByAmbiguous.has(i))
      ]);

      const unmatchedBaseline = [...finalUnmatchedBaselineIdxs].map(i => baseline[i]);
      const unmatchedCompare  = [...finalUnmatchedCompareIdxs].map(i => compareElements[i]);

      logger.info('Sequence-aware matching complete', {
        phase0:            allMatches.filter(m => m.strategy === 'test-attribute').length,
        phase1Pairs:       alignResult.pairs.length,
        phase1Added:       alignResult.added.length,
        phase1Removed:     alignResult.removed.length,
        phase2Realigned:   suffixPairs.length,
        phase3:            allMatches.length - alignResult.pairs.length - suffixPairs.length -
                           allMatches.filter(m => m.strategy === 'test-attribute').length,
        totalMatched:      allMatches.length,
        ambiguous:         allAmbiguous.length,
        unmatchedBaseline: unmatchedBaseline.length,
        unmatchedCompare:  unmatchedCompare.length
      });

      yield progressFrame('Finalising match results…', 99);
      yield resultFrame({ matches: allMatches, ambiguous: allAmbiguous, unmatchedBaseline, unmatchedCompare });

    } else {
      const allBaseIdxs = Array.from({ length: baseline.length },        (_, i) => i).filter(i => !usedBaseline.has(i));
      const allCmpIdxs  = Array.from({ length: compareElements.length }, (_, i) => i).filter(i => !usedCompare.has(i));
      const legacyStrategies = get('comparison.matching.strategies')
        .filter(s => s.enabled && s.id !== 'test-attribute')
        .sort((a, b) => b.confidence - a.confidence);
      const matchConfig = {
        anchorAttributes:  this.#anchorAttributes,
        minMatchThreshold: this.#minMatchThreshold,
        ambiguityWindow:   this.#ambiguityWindow
      };

      let baseOrphans = allBaseIdxs;
      let cmpOrphans  = allCmpIdxs;
      const total     = legacyStrategies.length;

      for (let si = 0; si < total; si++) {
        const strategy = legacyStrategies[si];
        const startPct = Math.round((si       / total) * 79) + 20;
        const endPct   = Math.round(((si + 1) / total) * 79) + 20;
        const builder  = LEGACY_CLASSIFIER_BUILDERS[strategy.id];
        if (!builder) { continue; }

        const classify = builder(
          cmpOrphans, usedCompare, baseline, compareElements,
          matchConfig, strategy, this.#cellSize, this.#minConf
        );

        let passResult = null;
        for await (const frame of runChunkedPass(baseOrphans, classify, { label: strategy.label, startPct, endPct })) {
          if (frame.type === 'result') { passResult = frame.payload; }
          else { yield frame; }
        }

        allMatches.push(...passResult.matches);
        allAmbiguous.push(...passResult.ambiguous);
        baseOrphans = passResult.orphans;
        cmpOrphans  = cmpOrphans.filter(i => !usedCompare.has(i));
      }

      const reservedByAmbiguous = new Set(
        allAmbiguous.flatMap(e => (e.ambiguousCandidates ?? []).map(c => c.compareIndex))
      );
      const unmatchedBaseline = baseOrphans.map(i => baseline[i]);
      const unmatchedCompare  = cmpOrphans.filter(i => !reservedByAmbiguous.has(i)).map(i => compareElements[i]);

      yield progressFrame('Finalising match results…', 99);
      yield resultFrame({ matches: allMatches, ambiguous: allAmbiguous, unmatchedBaseline, unmatchedCompare });
    }
  }
}

export { ElementMatcher, MatchType };
