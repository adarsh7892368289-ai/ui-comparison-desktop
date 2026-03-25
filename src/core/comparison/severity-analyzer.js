/**
 * Assigns a severity level (critical/high/medium/low) to each property diff and
 * computes the overall worst-case severity for an element.
 * Runs in the MV3 service worker context.
 * Invariant: severity is always the *worst* of all diff-level severities — never averaged.
 * Called by: comparison-modes.js → BaseComparisonMode.compareChunked().
 */
import { get } from '../../config/defaults.js';
import { PROPERTY_CATEGORIES } from './differ.js';
import { parseRgba, parsePx, relativeLuminance } from './color-utils.js';

const SEVERITY_LEVELS = {
  CRITICAL: 'critical',
  HIGH:     'high',
  MEDIUM:   'medium',
  LOW:      'low'
};

/**
 * Scores the severity of each diff in a diff result and returns annotated copies.
 * Does not own property diffing or element matching — receives pre-computed diffs only.
 */
class SeverityAnalyzer {
  /** Reads property bucket lists from config once at construction time. */
  constructor() {
    this._critical = get('comparison.severity.critical');
    this._high     = get('comparison.severity.high');
    this._medium   = get('comparison.severity.medium');
  }

  /**
   * Annotates each diff with a severity field and returns the overall severity plus counts.
   * Returns nulled-out counts with an empty array when there are no differences.
   * @param {object[]} differences - Raw diff objects from PropertyDiffer.compareElements().
   * @returns {{ overallSeverity: string|null, severityCounts: object, annotatedDifferences: object[] }}
   */
  analyzeDifferences(differences) {
    if (!differences || differences.length === 0) {
      return {
        overallSeverity:    null,
        severityCounts:     { critical: 0, high: 0, medium: 0, low: 0 },
        annotatedDifferences: []
      };
    }

    const annotated = differences.map(diff => ({
      ...diff,
      severity: this._calculateSeverity(diff)
    }));

    const severityCounts  = this._countBySeverity(annotated);
    const overallSeverity = this._determineOverallSeverity(severityCounts);

    return { overallSeverity, severityCounts, annotatedDifferences: annotated };
  }

  /**
   * Returns the severity level for a single property diff.
   * Checked in priority order: config-listed critical → layout-breaking → config-listed high
   * → high visual impact → config-listed medium → layout category → low (default).
   */
  _calculateSeverity({ property, baseValue, compareValue, category }) {
    if (this._critical.includes(property))             { return SEVERITY_LEVELS.CRITICAL; }
    if (this._isLayoutBreaking(property, baseValue, compareValue)) { return SEVERITY_LEVELS.CRITICAL; }
    if (this._high.includes(property))                 { return SEVERITY_LEVELS.HIGH; }
    if (this._hasHighVisualImpact(property, baseValue, compareValue)) { return SEVERITY_LEVELS.HIGH; }
    if (this._medium.includes(property))               { return SEVERITY_LEVELS.MEDIUM; }
    if (category === PROPERTY_CATEGORIES.LAYOUT)       { return SEVERITY_LEVELS.MEDIUM; }
    return SEVERITY_LEVELS.LOW;
  }

  /**
   * Returns true when the diff represents a structural layout disruption severe enough
   * to warrant critical severity even if the property is not in the config critical list.
   * Covers: display:none appearing/disappearing, flow↔positioned switches,
   * and dimension changes larger than 50% of the baseline value.
   */
  _isLayoutBreaking(property, baseValue, compareValue) {
    if (property === 'display') {
      if (baseValue === 'none' || compareValue === 'none') { return true; }
      const block = ['block', 'flex', 'grid', 'inline-block'];
      return block.includes(baseValue) !== block.includes(compareValue);
    }
    if (property === 'position') {
      if (baseValue !== compareValue) {
        return ['absolute', 'fixed'].includes(baseValue) ||
               ['absolute', 'fixed'].includes(compareValue);
      }
    }
    if (property === 'width' || property === 'height') {
      const basePx    = parsePx(baseValue);
      const comparePx = parsePx(compareValue);
      if (basePx && comparePx) {
        return Math.abs((comparePx - basePx) / basePx) * 100 > 50;
      }
    }
    return false;
  }

  /**
   * Returns true when the diff has a high perceptual impact that the config property
   * lists do not capture — large opacity jumps, high luminance-contrast color changes,
   * and font-size changes larger than 25% of the baseline.
   */
  _hasHighVisualImpact(property, baseValue, compareValue) {
    if (property === 'opacity') {
      const b = parseFloat(baseValue);
      const c = parseFloat(compareValue);
      if (!isNaN(b) && !isNaN(c)) { return Math.abs(b - c) > 0.3; }
    }
    if (property.includes('color')) {
      const baseRgba    = parseRgba(baseValue);
      const compareRgba = parseRgba(compareValue);
      if (baseRgba && compareRgba) {
        return Math.abs(relativeLuminance(baseRgba) - relativeLuminance(compareRgba)) > 0.4;
      }
    }
    if (property === 'font-size') {
      const basePx    = parsePx(baseValue);
      const comparePx = parsePx(compareValue);
      if (basePx && comparePx) {
        return Math.abs((comparePx - basePx) / basePx) * 100 > 25;
      }
    }
    return false;
  }

  /** Tallies annotated diffs into a {critical, high, medium, low} count object. */
  _countBySeverity(annotated) {
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const d of annotated) { counts[d.severity]++; }
    return counts;
  }

  /**
   * Returns the single worst severity present in the counts object.
   * Returns null only when all counts are zero (no differences at all).
   */
  _determineOverallSeverity({ critical, high, medium, low }) {
    if (critical > 0) { return SEVERITY_LEVELS.CRITICAL; }
    if (high > 0)     { return SEVERITY_LEVELS.HIGH; }
    if (medium > 0)   { return SEVERITY_LEVELS.MEDIUM; }
    if (low > 0)      { return SEVERITY_LEVELS.LOW; }
    return null;
  }
}

export { SeverityAnalyzer, SEVERITY_LEVELS };