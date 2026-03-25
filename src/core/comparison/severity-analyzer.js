import { get } from '../../config/defaults.js';
import { PROPERTY_CATEGORIES } from './differ.js';
import { parseRgba, parsePx, relativeLuminance } from './color-utils.js';

const SEVERITY_LEVELS = {
  CRITICAL: 'critical',
  HIGH:     'high',
  MEDIUM:   'medium',
  LOW:      'low'
};

class SeverityAnalyzer {
  constructor() {
    this._critical = get('comparison.severity.critical');
    this._high     = get('comparison.severity.high');
    this._medium   = get('comparison.severity.medium');
  }

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

  _calculateSeverity({ property, baseValue, compareValue, category }) {
    if (this._critical.includes(property))             { return SEVERITY_LEVELS.CRITICAL; }
    if (this._isLayoutBreaking(property, baseValue, compareValue)) { return SEVERITY_LEVELS.CRITICAL; }
    if (this._high.includes(property))                 { return SEVERITY_LEVELS.HIGH; }
    if (this._hasHighVisualImpact(property, baseValue, compareValue)) { return SEVERITY_LEVELS.HIGH; }
    if (this._medium.includes(property))               { return SEVERITY_LEVELS.MEDIUM; }
    if (category === PROPERTY_CATEGORIES.LAYOUT)       { return SEVERITY_LEVELS.MEDIUM; }
    return SEVERITY_LEVELS.LOW;
  }

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

  _countBySeverity(annotated) {
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const d of annotated) { counts[d.severity]++; }
    return counts;
  }

  _determineOverallSeverity({ critical, high, medium, low }) {
    if (critical > 0) { return SEVERITY_LEVELS.CRITICAL; }
    if (high > 0)     { return SEVERITY_LEVELS.HIGH; }
    if (medium > 0)   { return SEVERITY_LEVELS.MEDIUM; }
    if (low > 0)      { return SEVERITY_LEVELS.LOW; }
    return null;
  }
}

export { SeverityAnalyzer, SEVERITY_LEVELS };

