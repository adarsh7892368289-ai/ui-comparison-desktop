import { ElementMatcher } from './matcher.js';
import { StaticComparisonMode, DynamicComparisonMode } from './comparison-modes.js';
import { progressFrame, resultFrame } from './async-utils.js';

const MATCHING_PCT_WEIGHT    = 0.5;
const MATCHING_PHASE_CEILING = 50;

function calculateMatchRate(matched, unmatchedBaseline, unmatchedCompare) {
  const denominator = matched + unmatchedBaseline + unmatchedCompare;
  if (denominator === 0) {
    return 0;
  }
  return Math.round((matched / denominator) * 100);
}

function buildReportMeta(report) {
  return {
    id:            report.id,
    url:           report.url,
    title:         report.title,
    timestamp:     report.timestamp,
    totalElements: report.elements.length
  };
}

function buildUnmatchedSummary(elements) {
  return elements.map(el => ({
    id:          el.id,
    hpid:        el.hpid        ?? null,
    absoluteHpid:el.absoluteHpid ?? null,
    tagName:     el.tagName,
    elementId:   el.elementId,
    className:   el.className,
    cssSelector: el.cssSelector ?? null,
    xpath:       el.xpath        ?? null,
    textContent: el.textContent  ?? null,
    depth:       el.depth        ?? null,
    tier:        el.tier         ?? null
  }));
}

function buildMatchingMetadata(matchingResult) {
  const totalMatched       = matchingResult.matches.length;
  const ambiguousCount     = (matchingResult.ambiguous ?? []).length;
  const unmatchedBaseCount = matchingResult.unmatchedBaseline.length;
  const unmatchedCmpCount  = matchingResult.unmatchedCompare.length;
  return {
    totalMatched,
    ambiguousCount,
    unmatchedBaseline: unmatchedBaseCount,
    unmatchedCompare:  unmatchedCmpCount,
    matchRate:         calculateMatchRate(totalMatched, unmatchedBaseCount, unmatchedCmpCount)
  };
}

class Comparator {
  #matcher;
  #modes;

  constructor({ matcher, modes } = {}) {
    this.#matcher = matcher ?? new ElementMatcher();
    this.#modes   = modes ?? {
      static:  new StaticComparisonMode(),
      dynamic: new DynamicComparisonMode()
    };
  }

  async* compare(baselineReport, compareReport, mode = 'static') {
    const startTime    = performance.now();
    let matchingResult = null;

    const matchingGen = this.#matcher.matchElements(
      baselineReport.elements,
      compareReport.elements
    );

    for await (const frame of matchingGen) {
      if (frame.type === 'result') {
        matchingResult = frame.payload;
      } else {
        yield progressFrame(frame.label, Math.round(frame.pct * MATCHING_PCT_WEIGHT));
      }
    }

    yield progressFrame('Comparing properties…', MATCHING_PHASE_CEILING);

    const comparisonMode  = this.#modes[mode] ?? this.#modes.static;
    const diffTotal       = matchingResult.matches.length;
    let   comparisonResult = null;

    const diffingGen = comparisonMode.compare(
      matchingResult.matches,
      matchingResult.ambiguous ?? []
    );

    for await (const frame of diffingGen) {
      if (frame.type === 'result') {
        comparisonResult = frame.payload;
      } else {
        const diffFraction = diffTotal > 0 ? frame.pct / diffTotal : 1;
        yield progressFrame(frame.label, MATCHING_PHASE_CEILING + Math.min(Math.round(diffFraction * 49), 49));
      }
    }

    const duration = Math.round(performance.now() - startTime);

    yield progressFrame('Finalising results…', 99);

    yield resultFrame({
      baseline: buildReportMeta(baselineReport),
      compare:  buildReportMeta(compareReport),
      mode,
      matching: buildMatchingMetadata(matchingResult),
      comparison: {
        mode:      comparisonResult.modeName,
        results:   comparisonResult.results,
        ambiguous: comparisonResult.ambiguous,
        summary:   comparisonResult.summary
      },
      unmatchedElements: {
        baseline: buildUnmatchedSummary(matchingResult.unmatchedBaseline),
        compare:  buildUnmatchedSummary(matchingResult.unmatchedCompare)
      },
      duration,
      timestamp: new Date().toISOString()
    });
  }
}

export { Comparator };