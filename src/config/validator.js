import { get } from './defaults.js';
import logger from '../infrastructure/logger.js';

const REQUIRED_PATHS = [
  'schema.includeStyles',
  'schema.includeAttributes',
  'schema.includeRect',
  'schema.includeNeighbours',
  'schema.includeClassHierarchy',
  'schema.includeTier',
  'schema.includeClassMeta',
  'schema.includePageSection',
  'schema.record.textContent.maxLength',
  'schema.enrichment.neighbours.maxParentClasses',
  'schema.enrichment.neighbours.maxChildrenTypes',
  'schema.enrichment.classHierarchy.maxParentDepth',
  'schema.enrichment.classHierarchy.maxChildCount',
  'schema.enrichment.classHierarchy.maxClassSlice',

  'extraction.batchSize',
  'extraction.batchHardCapMs',
  'extraction.perElementTimeout',
  'extraction.maxElements',
  'extraction.skipInvisible',
  'extraction.stabilityWindowMs',
  'extraction.hardTimeoutMs',
  'extraction.irrelevantTags',
  'extraction.cssProperties',

  'selectors.generateCSS',
  'selectors.generateXPath',
  'selectors.concurrency',
  'selectors.totalTimeout',
  'selectors.xpath.perStrategyTimeout',
  'selectors.xpath.totalTimeout',
  'selectors.xpath.enableFallback',
  'selectors.xpath.parallelExecution',
  'selectors.css.perStrategyTimeout',
  'selectors.css.totalTimeout',
  'selectors.css.enableFallback',
  'selectors.css.parallelExecution',
  'selectors.minRobustnessScore',

  'comparison.matching.anchorAttributes',
  'comparison.matching.strategies',
  'comparison.tolerances.color',
  'comparison.tolerances.size',
  'comparison.tolerances.opacity',
  'comparison.matching.positionTolerance',

  'comparison.severity.critical',
  'comparison.severity.high',
  'comparison.severity.medium',

  'comparison.propertyCategories.layout',
  'comparison.propertyCategories.visual',
  'comparison.propertyCategories.typography',
  'comparison.propertyCategories.spacing',
  'comparison.propertyCategories.position',

  'comparison.modes.dynamic.compareProperties',
  'comparison.modes.dynamic.compareTextContent',
  'comparison.modes.dynamic.tolerances',
  'comparison.modes.static.compareTextContent',
  'comparison.modes.static.tolerances',

  'normalization.cache.enabled',
  'normalization.cache.maxEntries',
  'normalization.rounding.decimals',

  'infrastructure.timeout.default',
  'infrastructure.timeout.extraction',
  'infrastructure.timeout.tabLoad',
  'infrastructure.timeout.contentScript',

  'storage.maxReports',
  'storage.reportKey',
  'storage.logsKey',
  'storage.stateKey',

  'logging.level',
  'logging.persistLogs',
  'logging.maxEntries',
  'logging.slowOperationThreshold',

  'attributes.priority',
  'attributes.supplementary',
  'attributes.frameworkPatterns',
  'attributes.dynamicIdPatterns',
  'attributes.dynamicClassPatterns',

  'export.excel.headerColor',
  'export.excel.criticalColor',
  'export.excel.highColor',
  'export.excel.mediumColor',
  'export.excel.lowColor',
  'export.csv.delimiter',
  'export.csv.encoding'
];

const TYPE_EXPECTATIONS = [
  { path: 'schema.includeStyles',          type: 'boolean' },
  { path: 'schema.includeAttributes',      type: 'boolean' },
  { path: 'schema.includeRect',            type: 'boolean' },
  { path: 'schema.includeNeighbours',      type: 'boolean' },
  { path: 'schema.includeClassHierarchy',  type: 'boolean' },
  { path: 'schema.includeTier',            type: 'boolean' },
  { path: 'schema.includeClassMeta',       type: 'boolean' },
  { path: 'schema.includePageSection',     type: 'boolean' },
  { path: 'schema.record.textContent.maxLength',               type: 'number' },
  { path: 'schema.enrichment.neighbours.maxParentClasses',     type: 'number' },
  { path: 'schema.enrichment.neighbours.maxChildrenTypes',     type: 'number' },
  { path: 'schema.enrichment.classHierarchy.maxParentDepth',   type: 'number' },
  { path: 'schema.enrichment.classHierarchy.maxChildCount',    type: 'number' },
  { path: 'schema.enrichment.classHierarchy.maxClassSlice',    type: 'number' },
  { path: 'extraction.batchSize',           type: 'number' },
  { path: 'extraction.batchHardCapMs',      type: 'number' },
  { path: 'extraction.perElementTimeout',   type: 'number' },
  { path: 'extraction.maxElements',         type: 'number' },
  { path: 'extraction.skipInvisible',       type: 'boolean' },
  { path: 'extraction.stabilityWindowMs',   type: 'number' },
  { path: 'extraction.hardTimeoutMs',       type: 'number' },
  { path: 'extraction.irrelevantTags',      type: 'array' },
  { path: 'extraction.cssProperties',       type: 'array' },
  { path: 'selectors.generateCSS',          type: 'boolean' },
  { path: 'selectors.generateXPath',        type: 'boolean' },
  { path: 'selectors.concurrency',          type: 'number' },
  { path: 'selectors.totalTimeout',         type: 'number' },
  { path: 'selectors.xpath.perStrategyTimeout', type: 'number' },
  { path: 'selectors.css.perStrategyTimeout',   type: 'number' },
  { path: 'comparison.matching.anchorAttributes', type: 'array' },
  { path: 'comparison.matching.strategies',       type: 'array' },
  { path: 'comparison.tolerances.color',    type: 'number' },
  { path: 'comparison.tolerances.size',     type: 'number' },
  { path: 'comparison.severity.critical',   type: 'array' },
  { path: 'comparison.severity.high',       type: 'array' },
  { path: 'comparison.severity.medium',     type: 'array' },
  { path: 'comparison.modes.dynamic.compareProperties', type: 'array' },
  { path: 'infrastructure.timeout.default', type: 'number' },
  { path: 'logging.slowOperationThreshold', type: 'number' },
  { path: 'attributes.priority',            type: 'array' },
  { path: 'attributes.frameworkPatterns',   type: 'array' }
];

const SANITY_CHECKS = [
  { path: 'schema.record.textContent.maxLength',               min: 50,  max: 10_000 },
  { path: 'schema.enrichment.neighbours.maxParentClasses',     min: 1,   max: 20     },
  { path: 'schema.enrichment.neighbours.maxChildrenTypes',     min: 1,   max: 50     },
  { path: 'schema.enrichment.classHierarchy.maxParentDepth',   min: 1,   max: 20     },
  { path: 'schema.enrichment.classHierarchy.maxChildCount',    min: 1,   max: 100    },
  { path: 'schema.enrichment.classHierarchy.maxClassSlice',    min: 1,   max: 10     },
  { path: 'extraction.batchSize',               min: 1,    max: 100    },
  { path: 'extraction.batchHardCapMs',          min: 10,   max: 200    },
  { path: 'extraction.perElementTimeout',       min: 10,   max: 5000   },
  { path: 'extraction.maxElements',             min: 100,  max: 100000 },
  { path: 'extraction.stabilityWindowMs',       min: 100,  max: 10000  },
  { path: 'extraction.hardTimeoutMs',           min: 1000, max: 30000  },
  { path: 'selectors.concurrency',              min: 1,    max: 32     },
  { path: 'selectors.totalTimeout',             min: 100,  max: 10000  },
  { path: 'selectors.xpath.perStrategyTimeout', min: 10,   max: 2000   },
  { path: 'selectors.css.perStrategyTimeout',   min: 5,    max: 1000   },
  { path: 'comparison.tolerances.color',        min: 0,    max: 255    },
  { path: 'comparison.tolerances.size',         min: 0,    max: 100    },
  { path: 'infrastructure.timeout.default',     min: 100,  max: 300000 },
  { path: 'logging.slowOperationThreshold',     min: 50,   max: 30000  }
];

function validateStrategies(errors) {
  try {
    const strategies = get('comparison.matching.strategies');
    if (!Array.isArray(strategies) || strategies.length === 0) {
      errors.push('[Config] "comparison.matching.strategies" must be a non-empty array');
      return;
    }
    for (const s of strategies) {
      if (typeof s.id !== 'string') {
        errors.push(`[Config] Strategy entry missing "id": ${JSON.stringify(s)}`);
      }
      if (typeof s.confidence !== 'number' || s.confidence < 0 || s.confidence > 1) {
        errors.push(`[Config] Strategy "${s.id}" has invalid confidence: ${s.confidence}`);
      }
      if (typeof s.enabled !== 'boolean') {
        errors.push(`[Config] Strategy "${s.id}" missing "enabled" boolean`);
      }
    }
  } catch {
    errors.push('[Config] "comparison.matching.strategies" could not be validated');
  }
}

function checkRequiredPaths(errors) {
  for (const path of REQUIRED_PATHS) {
    try {
      const value = get(path);
      if (value === null || value === undefined) {
        errors.push(`[Config] "${path}" is null/undefined`);
      }
    } catch (err) {
      errors.push(`[Config] "${path}" does not exist — ${err.message}`);
    }
  }
}

function checkTypeExpectations(errors) {
  for (const { path, type } of TYPE_EXPECTATIONS) {
    try {
      const value  = get(path);
      const actual = Array.isArray(value) ? 'array' : typeof value;
      if (actual !== type) {
        errors.push(`[Config] "${path}" expected ${type}, got ${actual}`);
      }
    } catch {
      // Ignore paths that do not exist or cannot be resolved
    }
  }
}

function checkSanityRanges(errors) {
  for (const { path, min, max } of SANITY_CHECKS) {
    try {
      const value = get(path);
      if (typeof value === 'number' && (value < min || value > max)) {
        errors.push(`[Config] "${path}" value ${value} is outside expected range [${min}, ${max}]`);
      }
    } catch {
      // Ignore paths that do not exist or cannot be resolved
    }
  }
}

function validateConfig({ throwOnError = true } = {}) {
  const errors = [];

  checkRequiredPaths(errors);
  checkTypeExpectations(errors);
  checkSanityRanges(errors);
  validateStrategies(errors);

  const valid = errors.length === 0;

  if (!valid) {
    const summary = `Config validation failed with ${errors.length} error(s):\n${ 
      errors.map(e => `  • ${e}`).join('\n')}`;

    if (throwOnError) {
      throw new Error(summary);
    } else {
      logger.error('Config validation failed', { errors, summary });
    }
  }

  return { valid, errors };
}

export { validateConfig };