import { get }             from '../../../config/defaults.js';
import logger               from '../../../infrastructure/logger.js';
import { safeTimestamp }    from '../shared/csv-utils.js';
import { triggerDownload }  from '../shared/download-trigger.js';

const ID_PREVIEW_LENGTH = 8;

function buildComparisonJsonPayload(result) {
  return {
    exportVersion: '1.0',
    exportedAt:    new Date().toISOString(),
    baseline: {
      id:              result.baseline?.id,
      url:             result.baseline?.url,
      title:           result.baseline?.title,
      timestamp:       result.baseline?.timestamp,
      totalElements:   result.baseline?.totalElements,
      styleCategories: result.baseline?.styleCategories,
      extractOptions:  result.baseline?.extractOptions
    },
    compare: {
      id:              result.compare?.id,
      url:             result.compare?.url,
      title:           result.compare?.title,
      timestamp:       result.compare?.timestamp,
      totalElements:   result.compare?.totalElements,
      styleCategories: result.compare?.styleCategories,
      extractOptions:  result.compare?.extractOptions
    },
    mode:              result.mode,
    duration:          result.duration,
    matching:          result.matching,
    comparison: {
      summary: result.comparison?.summary,
      results: result.comparison?.results ?? []
    },
    unmatchedElements: result.unmatchedElements
  };
}

function exportComparisonToJson(result) {
  try {
    const payload  = buildComparisonJsonPayload(result);
    const json     = JSON.stringify(payload, null, 2);
    const base     = get('export.defaultFilename', 'comparison-report');
    const bId      = result.baseline?.id?.slice(0, ID_PREVIEW_LENGTH) ?? 'unknown';
    const cId      = result.compare?.id?.slice(0,  ID_PREVIEW_LENGTH) ?? 'unknown';
    const filename = `${base}-${bId}-vs-${cId}-${safeTimestamp()}.json`;

    triggerDownload(json, 'application/json', filename);
    logger.info('Comparison JSON export complete', { filename });
    return { success: true, filename };
  } catch (err) {
    logger.error('Comparison JSON export failed', { error: err.message });
    return { success: false, error: err.message };
  }
}

export { buildComparisonJsonPayload, exportComparisonToJson };