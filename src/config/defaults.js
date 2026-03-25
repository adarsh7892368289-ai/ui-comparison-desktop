/**
 * Single source of truth for all runtime configuration. Runs in all three contexts.
 * Failure mode contained here: get() throws when a path is missing and no fallback
 * is provided — callers that supply a fallback never throw.
 * Callers: every module that reads config via get(). background.js and tests call init().
 */

/**
 * Master config object. Two non-obvious conventions used throughout:
 * - comparison.modes.static.compareProperties: null is a sentinel meaning
 *   "compare all tracked CSS properties" in the comparator.
 * - Arrays are leaf values in mergeDeep — overriding cssProperties replaces
 *   the whole array, not appends to it.
 */
const rawConfig = {

  schema: {
    includeStyles:         true,
    includeAttributes:     true,
    includeRect:           true,
    includeNeighbours:     false,
    includeClassHierarchy: false,
    includeTier:           true,
    includeClassMeta:      true,
    includePageSection:    true,

    record: {
      textContent: {
        maxLength: 500
      }
    },

    enrichment: {
      neighbours: {
        maxParentClasses: 3,
        maxChildrenTypes: 10
      },
      classHierarchy: {
        maxParentDepth: 3,
        maxChildCount:  10,
        maxClassSlice:  2
      }
    }
  },

  extraction: {
    batchSize:         20,
    batchHardCapMs:    30,
    perElementTimeout: 200,
    maxElements:       10_000,
    skipInvisible:     true,
    stabilityWindowMs: 500,
    hardTimeoutMs:     1000,

    section: {
      headerPositionRatio:  0.20,
      footerPositionRatio:  0.15,
      headerViewportFactor: 1.5,
      footerViewportFactor: 1.0
    },

    irrelevantTags: [
      'SCRIPT', 'STYLE', 'META', 'LINK', 'NOSCRIPT', 'BR', 'HR',
      'HEAD', 'TITLE', 'BASE', 'TEMPLATE', 'SLOT', 'WBR', 'PARAM',
      'TRACK', 'SOURCE', 'AREA', 'COL', 'COLGROUP'
    ],

    cssProperties: [
      'font-family', 'font-size', 'font-weight', 'font-style',
      'line-height', 'letter-spacing', 'word-spacing', 'text-align',
      'text-decoration', 'text-transform',
      'color', 'background-color', 'opacity', 'visibility',
      'padding',
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'margin',
      'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
      'gap',
      'display', 'position', 'float', 'clear', 'overflow', 'overflow-x', 'overflow-y',
      'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height',
      'top', 'right', 'bottom', 'left', 'z-index',
      'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
      'justify-content', 'align-items', 'align-content', 'align-self',
      'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
      'border', 'border-width', 'border-style', 'border-color',
      'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
      'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
      'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
      'border-radius',
      'border-top-left-radius', 'border-top-right-radius',
      'border-bottom-right-radius', 'border-bottom-left-radius',
      'box-shadow', 'text-shadow'
    ],

    styleCategories: ['typography', 'colors', 'spacing', 'layout', 'borders']
  },

  hpid: {
    coordinateMode: 'dual',
    maxDepth:       5_000,
    shadowSentinel: 0
  },

  selectors: {
    generateCSS:   true,
    generateXPath: true,
    concurrency:   4,
    totalTimeout:  600,

    xpath: {
      perStrategyTimeout: 50,
      totalTimeout:       400,
      enableFallback:     true,
      parallelExecution:  true,
      enableNearbyText:   false
    },
    css: {
      perStrategyTimeout: 40,
      totalTimeout:       250,
      enableFallback:     true,
      parallelExecution:  true
    },
    minRobustnessScore: 50
  },

  comparison: {
    matching: {
      anchorAttributes: [
        'data-testid', 'data-test', 'data-qa', 'data-cy',
        'data-automation-id', 'data-key', 'data-record-id',
        'data-component-id', 'data-row-key-value'
      ],

      strategies: [
        { id: 'test-attribute', confidence: 1.00, enabled: true, label: 'Anchoring by test attributes\u2026' },
        { id: 'absolute-hpid', confidence: 0.95, enabled: true, label: 'Anchoring by absolute position\u2026' },
        { id: 'id',            confidence: 0.90, enabled: true, label: 'Anchoring by element ID\u2026' },
        { id: 'css-selector',  confidence: 0.80, enabled: true, label: 'Structural match by CSS\u2026' },
        { id: 'xpath',         confidence: 0.78, enabled: true, label: 'Structural match by XPath\u2026' },
        { id: 'position',      confidence: 0.30, enabled: true, label: 'Positional matching\u2026' }
      ],

      sequenceAlignment: {
        enabled:         true,
        lookAheadWindow: 5,
        suffixDepth:     5,
        inSequenceConf:  0.99,
        suffixConf:      0.85
      },

      confidenceThreshold: 0.5,
      positionTolerance:   50,
      minMatchThreshold:   0.70,
      ambiguityWindow:     0.12,
      yieldChunkSize:      64
    },

    tolerances: {
      color:   5,
      size:    3,
      opacity: 0.01
    },

    severity: {
      critical: ['display', 'visibility', 'position', 'z-index'],
      high: [
        'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height',
        'color', 'background-color', 'opacity',
        'font-size', 'font-family', 'font-weight'
      ],
      medium: [
        'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
        'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
        'border-top-width', 'border-bottom-width', 'border-left-width', 'border-right-width',
        'border-top-color', 'border-bottom-color', 'border-left-color', 'border-right-color',
        'line-height', 'text-align', 'font-style'
      ]
    },

    propertyCategories: {
      layout: [
        'display', 'position', 'float', 'clear',
        'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height'
      ],
      visual: [
        'color', 'background-color', 'border-top-color', 'border-right-color',
        'border-bottom-color', 'border-left-color', 'opacity', 'visibility',
        'box-shadow', 'text-shadow'
      ],
      typography: [
        'font-family', 'font-size', 'font-weight', 'font-style',
        'line-height', 'text-align', 'text-decoration', 'letter-spacing', 'word-spacing'
      ],
      spacing: [
        'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
        'padding-top', 'padding-right', 'padding-bottom', 'padding-left'
      ],
      position: ['top', 'right', 'bottom', 'left', 'z-index']
    },

    modes: {
      dynamic: {
        compareProperties: [
          'font-family', 'font-size', 'font-weight', 'font-style',
          'line-height', 'letter-spacing', 'text-align', 'text-decoration',
          'text-transform',
          'color', 'background-color', 'opacity', 'visibility',
          'display', 'position', 'float',
          'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height',
          'top', 'right', 'bottom', 'left', 'z-index',
          'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
          'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
          'gap',
          'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
          'justify-content', 'align-items', 'align-self',
          'grid-template-columns', 'grid-template-rows',
          'border-width', 'border-style', 'border-color', 'border-radius',
          'box-shadow'
        ],
        compareTextContent:       false,
        structuralOnlyAttributes: [
          'role', 'aria-label', 'aria-labelledby', 'aria-describedby',
          'type', 'name', 'data-testid', 'data-test', 'data-qa', 'data-cy'
        ],
        tolerances: { color: 8, size: 5, opacity: 0.05 }
      },
      static: {
        compareProperties:  null,
        compareTextContent: true,
        tolerances:         { color: 5, size: 3, opacity: 0.01 }
      }
    },

  },

  normalization: {
    cache: {
      enabled:        true,
      maxEntries:     1_000,
      evictionPolicy: 'LRU'
    },
    rounding: {
      decimals: 2
    }
  },

  infrastructure: {
    timeout: {
      default:       5_000,
      extraction:    200,
      tabLoad:       30_000,
      contentScript: 300_000
    }
  },

  storage: {
    maxReports: 50,
    reportKey:  'page_comparator_reports',
    logsKey:    'page_comparator_logs',
    stateKey:   'page_comparator_state'
  },

  logging: {
    level:                  'debug',
    persistLogs:            true,
    maxEntries:             1_000,
    slowOperationThreshold: 500
  },

  attributes: {
    priority: [
      'data-testid', 'data-test', 'data-qa', 'data-cy',
      'data-automation-id', 'data-key', 'data-record-id',
      'data-component-id', 'data-row-key-value'
    ],
    supplementary: [
      'role', 'type', 'href', 'for', 'value',
      'placeholder', 'name', 'aria-label'
    ],
    frameworkPatterns: [
      '^ng-', '^_ngcontent', '^_nghost',
      '^v-', '^data-v-[a-f0-9]+$',
      '^jsx-', '^data-reactid', '^data-react-'
    ],
    dynamicIdPatterns: [
      '^\\d+$',
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
      '^\\d{13,}$',
      '^[a-f0-9]{32,}$',
      '^(ember|react|vue|angular)\\d+$',
      '^uid-\\d+$',
      '^temp[-_]?\\d+$',
      '-\\d{2,}$'
    ],
    dynamicClassPatterns: [
      '^Mui[A-Z]\\w+-\\w+-\\d+$',
      '^makeStyles-',
      '^css-[a-z0-9]+$',
      '^jss\\d+$',
      '^sc-[a-z]+-[a-z]+$',
      '^emotion-\\d+$',
      '^lwc-[a-z0-9]+'
    ]
  },

  export: {
    defaultFilename: 'comparison-report',
    excel: {
      headerColor:   '4472C4',
      criticalColor: 'FF4444',
      highColor:     'FF9800',
      mediumColor:   'FFD700',
      lowColor:      'FFFFFF',
      maxCellLength: 32_767
    },
    csv: {
      delimiter: ',',
      encoding:  'utf-8-bom'
    }
  }
};

/** Recursively freezes an object and all its nested object values. */
function deepFreeze(obj) {
  Object.freeze(obj);
  for (const prop of Object.getOwnPropertyNames(obj)) {
    const val = obj[prop];
    if (val && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

// Cloned from rawConfig before freezing so init() can re-derive from the unfrozen source.
let config = deepFreeze(JSON.parse(JSON.stringify(rawConfig)));

/**
 * Deep-merges source into target. Arrays are treated as leaf values and replaced
 * wholesale — there is no element-level array merge. This is intentional: callers
 * override an entire array (e.g. cssProperties) rather than patching individual items.
 */
function mergeDeep(target, source) {
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key])
    ) {
      target[key] = target[key] || {};
      mergeDeep(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}

/**
 * Re-initialises the active config from rawConfig with the given overrides merged in.
 * Must be called before the first get() in any test context that needs non-default values.
 * Re-clones from rawConfig on every call so previous init() calls do not accumulate.
 *
 * @param {Object} [overrides={}]
 * @returns {Readonly<Object>} The new frozen config object.
 */
function init(overrides = {}) {
  const merged = JSON.parse(JSON.stringify(rawConfig));
  mergeDeep(merged, overrides);
  config = deepFreeze(merged);
  return config;
}

/**
 * Reads a value from the active config by dot-separated path.
 * Returns fallback when the path resolves to undefined (if fallback is provided).
 * Throws when the path is missing or an intermediate segment is null/undefined and
 * no fallback is provided — use a fallback for any optional config path.
 *
 * @param {string} path - Dot-separated key path, e.g. 'extraction.batchSize'.
 * @param {*} [fallback] - Returned instead of throwing when the path is not found.
 * @returns {*}
 */
function get(path, fallback) {
  const segments = path.split('.');
  let current    = config;

  for (const seg of segments) {
    if (current === undefined || current === null) {
      if (fallback !== undefined) { return fallback; }
      throw new Error(`[Config] Path not found: "${path}" (failed at "${seg}")`);
    }
    current = current[seg];
  }

  if (current === undefined) {
    if (fallback !== undefined) { return fallback; }
    throw new Error(`[Config] Path not found: "${path}"`);
  }

  return current;
}

export { config, get, init };

