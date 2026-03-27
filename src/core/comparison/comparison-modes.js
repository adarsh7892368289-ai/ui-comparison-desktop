import { get } from '../../config/defaults.js';
import logger from '../../infrastructure/logger.js';
import { PropertyDiffer } from './differ.js';
import { SeverityAnalyzer } from './severity-analyzer.js';
import { yieldToEventLoop, YIELD_CHUNK_SIZE, progressFrame, resultFrame } from './async-utils.js';

const CSS_INHERITABLE = new Set([
  'color', 'visibility',
  'font-size', 'font-weight', 'font-style', 'font-family',
  'font-variant', 'font-stretch', 'line-height', 'letter-spacing', 'word-spacing',
  'text-align', 'text-indent', 'text-transform', 'text-decoration',
  'white-space', 'word-break', 'overflow-wrap', 'direction',
  'list-style-type', 'list-style-position',
  'border-collapse', 'border-spacing', 'caption-side',
  'quotes', 'tab-size', 'orphans', 'widows'
]);

const CURRENT_COLOR_DERIVED = new Set([
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'
]);

const STATIC_FILTER = {
  compareProperties:        null,
  compareTextContent:       get('comparison.modes.static.compareTextContent'),
  structuralAttributesOnly: false,
  tolerances:               get('comparison.modes.static.tolerances')
};

const DYNAMIC_FILTER = {
  compareProperties:        new Set(get('comparison.modes.dynamic.compareProperties', [])),
  compareTextContent:       get('comparison.modes.dynamic.compareTextContent'),
  structuralAttributesOnly: true,
  structuralAttributes:     new Set(get('comparison.modes.dynamic.structuralOnlyAttributes', [
    'role', 'aria-label', 'type', 'name', 'data-testid'
  ])),
  tolerances:               get('comparison.modes.dynamic.tolerances')
};

class BaseComparisonMode {
  #differ;
  #severityAnalyzer;

  constructor({ differ, severityAnalyzer } = {}) {
    this.#differ           = differ           ?? new PropertyDiffer();
    this.#severityAnalyzer = severityAnalyzer ?? new SeverityAnalyzer();
  }

  compareMatch(match, filter) {
    const { baselineElement, compareElement } = match;

    const styleResult = this.#differ.compareElements(baselineElement, compareElement, {
      compareProperties: filter.compareProperties,
      tolerances:        filter.tolerances
    });

    const textDiffs = filter.compareTextContent
      ? this.compareTextContent(baselineElement, compareElement)
      : [];

    const attrDiffs = this.compareAttributes(
      baselineElement,
      compareElement,
      filter.structuralAttributesOnly ? filter.structuralAttributes : null
    );

    const allDiffs = [...styleResult.differences, ...textDiffs, ...attrDiffs];
    const severity = this.#severityAnalyzer.analyzeDifferences(allDiffs);

    return {
      ...match,
      elementId:            styleResult.elementId,
      tagName:              styleResult.tagName,
      differences:          allDiffs,
      totalDifferences:     allDiffs.length,
      overallSeverity:      severity.overallSeverity,
        severityCounts:       severity.severityCounts,
      annotatedDifferences: severity.annotatedDifferences
    };
  }

  compareTextContent(baselineElement, compareElement) {
    const baseText    = (baselineElement.textContent ?? '').trim();
    const compareText = (compareElement.textContent  ?? '').trim();
    if (baseText === compareText) {return [];}
    return [{
      property:     'textContent',
      baseValue:    baseText,
      compareValue: compareText,
      category:     'content',
      type:         'modified'
    }];
  }

  compareAttributes(baselineElement, compareElement, allowList = null) {
    const baseAttrs    = baselineElement.attributes ?? {};
    const compareAttrs = compareElement.attributes  ?? {};
    const allKeys      = new Set([...Object.keys(baseAttrs), ...Object.keys(compareAttrs)]);
    const diffs        = [];

    for (const key of allKeys) {
      if (allowList && !allowList.has(key)) {continue;}
      if (baseAttrs[key] === compareAttrs[key]) {continue;}
      diffs.push({
        property:     `attr:${key}`,
        baseValue:    baseAttrs[key]    ?? null,
        compareValue: compareAttrs[key] ?? null,
        category:     'attribute',
        type:         this.attrDiffType(baseAttrs[key], compareAttrs[key])
      });
    }
    return diffs;
  }

  attrDiffType(baseVal, compareVal) {
    if (baseVal === null && compareVal !== null) {return 'added';}
    if (baseVal !== null && compareVal === null) {return 'removed';}
    return 'modified';
  }

  generateSummary(diffResults, ambiguous, modeName) {
    const totalElements     = diffResults.length;
    const unchangedElements = diffResults.filter(r => r.totalDifferences === 0).length;
    const modifiedElements  = diffResults.filter(r => r.totalDifferences > 0).length;
    const totalDifferences  = diffResults.reduce((sum, r) => sum + r.totalDifferences, 0);
    const ambiguousCount    = ambiguous.length;

    const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const resultItem of diffResults) {
      const sev = resultItem.overallSeverity;
      if (sev && sev in severityCounts) {severityCounts[sev]++;}
    }

    logger.info(`${modeName} comparison summary`, {
      totalElements, unchangedElements, modifiedElements,
      totalDifferences, ambiguousCount, severityCounts
    });

    return {
      totalElements,
      unchangedElements,
      modifiedElements,
      totalDifferences,
      ambiguousCount,
      severityCounts
    };
  }

  #suppressInheritedCascades(diffResults) {
    const changedByHpid = new Map();
    for (const r of diffResults) {
      if (!r.differences?.length) {continue;}
      const hpid = r.baselineElement?.hpid ?? r.hpid ?? null;
      if (hpid) {changedByHpid.set(hpid, r.differences);}
    }

    if (!changedByHpid.size) {return diffResults;}

    return diffResults.map(r => {
      if (!r.differences?.length) {return r;}
      const hpid = r.baselineElement?.hpid ?? r.hpid ?? null;
      if (!hpid) {return r;}

      const ancestorDiffMap   = new Map();
      let   ancestorColorDiff = null;

      for (const [ancHpid, ancDiffs] of changedByHpid) {
        if (ancHpid === hpid) {continue;}
        if (!hpid.startsWith(`${ancHpid}.`)) {continue;}
        for (const d of ancDiffs) {
          if (!ancestorDiffMap.has(d.property)) {
            ancestorDiffMap.set(d.property, d);
          }
          if (d.property === 'color' && !ancestorColorDiff) {
            ancestorColorDiff = d;
          }
        }
      }

      if (!ancestorDiffMap.size) {return r;}

      const suppressed = [];
      const ownDiffs   = r.differences.filter(d => {
        if (CSS_INHERITABLE.has(d.property)) {
          const anc = ancestorDiffMap.get(d.property);
          if (anc && anc.baseValue === d.baseValue && anc.compareValue === d.compareValue) {
            suppressed.push({ ...d, inherited: true });
            return false;
          }
        }
        if (CURRENT_COLOR_DERIVED.has(d.property) && ancestorColorDiff) {
          if (
            ancestorColorDiff.baseValue    === d.baseValue &&
            ancestorColorDiff.compareValue === d.compareValue
          ) {
            suppressed.push({ ...d, inherited: true, derivedFrom: 'color' });
            return false;
          }
        }
        return true;
      });

      if (!suppressed.length) {return r;}

      const severity = this.#severityAnalyzer.analyzeDifferences(ownDiffs);
      return {
        ...r,
        differences:          ownDiffs,
        suppressedDiffs:      suppressed,
        totalDifferences:     ownDiffs.length,
        overallSeverity:      severity.overallSeverity,
        severityCounts:       severity.severityCounts,
        annotatedDifferences: severity.annotatedDifferences
      };
    });
  }

  /** @protected — call compare(), not this method directly; subclasses supply filter and modeName. */
  async* compareChunked(matches, ambiguous, filter, modeName) {
    const total       = matches.length;
    const diffResults = [];

    for (let start = 0; start < total; start += YIELD_CHUNK_SIZE) {
      const end = Math.min(start + YIELD_CHUNK_SIZE, total);
      for (let i = start; i < end; i++) {
        diffResults.push(this.compareMatch(matches[i], filter));
      }
      await yieldToEventLoop();
      yield progressFrame('Comparing properties…', end);
    }

    const cleaned = this.#suppressInheritedCascades(diffResults);

    yield resultFrame({
      modeName,
      results:  cleaned,
      ambiguous,
      summary:  this.generateSummary(cleaned, ambiguous, modeName)
    });
  }
}

class StaticComparisonMode extends BaseComparisonMode {
  constructor(deps = {}) { super(deps); }
  async* compare(matches, ambiguous = []) {
    yield* this.compareChunked(matches, ambiguous, STATIC_FILTER, 'static');
  }
}

class DynamicComparisonMode extends BaseComparisonMode {
  constructor(deps = {}) { super(deps); }
  async* compare(matches, ambiguous = []) {
    yield* this.compareChunked(matches, ambiguous, DYNAMIC_FILTER, 'dynamic');
  }
}

export { StaticComparisonMode, DynamicComparisonMode, STATIC_FILTER, DYNAMIC_FILTER };

function computeSeverityBreakdown(diffResults) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const r of diffResults) {
    if (!r.differences?.length) {continue;}
    const hpid = r.baselineElement?.hpid ?? r.hpid ?? null;
    if (!hpid) {continue;}
    const parentHpid = hpid.split('.').slice(0, -1).join('.');
    const isChild = diffResults.some(p => {
      const pH = p.baselineElement?.hpid ?? p.hpid ?? null;
      return pH === parentHpid && p.differences?.length;
    });
    if (isChild) {continue;}
    const sev = r.overallSeverity;
    if (sev && sev in counts) {counts[sev]++;}
  }
  return counts;
}