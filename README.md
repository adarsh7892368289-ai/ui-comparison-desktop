# UI Comparison Desktop

**A production-grade Electron desktop application for  DOM-level visual regression testing and cross-environment UI comparison.**
---

## What This System Does

**UI Comparison Desktop** is an Electron + Playwright application that performs **semantic DOM-level comparison** of web pages. It captures complete structural and visual snapshots of web page DOM (computed CSS, bounding geometry, element attributes, and positional identity), pairs corresponding elements across two captures, diffs every tracked CSS property with configurable tolerances, and produces severity-ranked comparison reports with visual side-by-side screenshots and multiple export formats.

Unlike screenshot diffing tools, UI Comparison Desktop operates at the **semantic DOM level**, producing per-element, per-property diffs with configurable tolerances, confidence-based matching strategies, and intelligent cascade suppression to eliminate false positives caused by CSS inheritance.

### Who Is This For?

- **QA Engineers**: Fast regression testing between production and staging environments
- **Design System Maintainers**: Verify design system updates don't break existing components
- **A/B Test Reviewers**: Compare live variant against control at the DOM level
- **Frontend Developers**: Validate CSS refactoring doesn't introduce unintended visual changes

### Key Capabilities

✅ **Multi-page DOM Extraction** — Capture complete element inventory with computed styles, selectors, and attributes  
✅ **Intelligent Element Matching** — Four-phase pipeline using positional, attribute, and selector-based strategies (>85% success rate)  
✅ **Severity-Ranked Diffs** — Classify changes as critical, high, medium, or low with built-in cascade suppression  
✅ **Visual Diff Verification** — CDP-captured screenshots with element highlighting for side-by-side validation  
✅ **Multiple Export Formats** — HTML (self-contained), CSV (data analysis), JSON (API integration), Excel (reporting)  
✅ **Cross-Platform** — Windows, macOS, and Linux support with native Playwright browser engines  
✅ **Offline Operations** — All comparison analysis runs locally; IndexedDB storage for historical report management  
✅ **URL Compatibility Pre-flight** — Detect incompatible URLs and tracking param variations before comparison  

---

## Features

### Extraction & Reporting
- **Full-page DOM extraction** with configurable scope (full page, visible viewport, custom selector trees)
- **80+ CSS properties** tracked including shorthand expansion (margin, padding, border, etc.)
- **Semantic attributes** captured: test IDs, ARIA labels, data attributes
- **Computed styles** from final browser rendering state (post-cascade, post-animation)
- **Bounding geometry** with high-precision float coordinates for layout analysis
- **Hierarchical Position Identifiers (HPID)** for stable element tracking across captures
- **Multiple selector strategies** for element re-identification (CSS, XPath, positional, test attributes)

### Comparison Engine
- **Two comparison modes**:
  - **Static Mode** — Full CSS suite, text content matching, tight tolerances (regression testing)
  - **Dynamic Mode** — Curated 40-property subset, text excluded, loose tolerances (A/B testing)
- **Four-phase element matching**:
  - Phase 0: Test-attribute anchoring (confidence 1.00)
  - Phase 1: Sequence alignment on positional identity (confidence 0.99)
  - Phase 2: HPID suffix realignment (confidence 0.85)
  - Phase 3: Legacy strategy pool (0.30–0.95 depending on strategy)
- **Automatic cascade suppression** — Removes inherited property changes to show only intentional modifications
- **Configurable tolerances** — Fine-grained control over sensitivity (color ±5-8, size ±3-5px, opacity ±0.01-0.05)
- **Match confidence scoring** — Every match includes confidence level for audit trails

### Results & Visualization
- **Severity-ranked diff table** with critical-to-low prioritization
- **Element classification** — Modified, unchanged, matched, unmatched, replaced
- **Visual side-by-side screenshots** — CDP-captured at matching scroll positions with element highlighting
- **Text preview** for changed elements with original/new values side-by-side
- **Match quality metrics** — Overall match rate, ambiguous match counts, element coverage
- **URL compatibility warnings** — Pre-flight detection of path variations and tracking parameters

### Data Management
- **Report import/export** — JSON format with full extraction + comparison metadata
- **IndexedDB storage** — Local database with write-ahead logging (WAL) for crash recovery
- **Multi-format export**:
  - **HTML** — Self-contained report with embedded screenshots, no external dependencies
  - **CSV** — Structured data for spreadsheet analysis and reporting
  - **JSON** — Machine-readable format for API integration and automation
  - **Excel** — Multi-sheet workbook with comparison summary, diffs, and element inventory
- **Bulk operations** — Export or import multiple reports at once
- **Search & filter** — Find reports by URL, timestamp, environment tag

### Production Considerations
- **Error recovery** — WAL pattern ensures crash-safe storage with automatic orphan detection
- **Circuit breaker** — Automatic database protection against cascading write failures
- **Performance monitoring** — Instrumentation for bottleneck identification
- **Detailed logging** — Structured logs for debugging and audit trails
- **DevTools detection** — Warnings when Chrome DevTools may interfere with measurements

---

## Quick Start

### Extraction Workflow

1. **Open a web page** in your browser (the page you want to capture)
2. **Launch UI Comparison Desktop**
3. **Click "Extract Elements"** in the sidebar
4. **Enter a report name** and select environment (Prod/Stage or custom tag)
5. **Wait for extraction** (typically 5-30 seconds depending on page size)
6. **Verify extraction count** — Summary shows element count, CSS properties, selectors captured

### Comparison Workflow

1. **Select extraction mode**:
   - Static: For regression testing (full CSS, tight tolerances)
   - Dynamic: For A/B testing (curated properties, loose tolerances)
2. **Choose baseline report** from the left panel
3. **Choose compare report** from the right panel
4. **Toggle "Include Visual Diffs"** if you need screenshots
5. **Click "Compare"** and monitor progress bar
6. **Review results**:
   - Summary panel shows severity counts
   - Diff table displays all property changes
   - Full Report button opens detailed view with screenshots

### Export Workflow

From the results panel or report list:
- **Export as HTML** — Self-contained report, email-friendly, shareable
- **Export as CSV** — Import to Excel for custom analysis
- **Export as JSON** — Integrate with CI/CD pipelines
- **Export as Excel** — Multi-sheet workbook for stakeholder reviews

---

## Architecture Overview

### Process Model

```
┌─────────────────────────────────┐
│ Main Process (Node.js)          │
├─────────────────────────────────┤
│ • Playwright browser control    │
│ • IPC message handling          │
│ • File system access            │
│ • Report data persistence       │
└──────────────┬──────────────────┘
               │
          IPC Bridge
               │
┌──────────────▼──────────────────┐
│ Renderer Process (Chromium)     │
├─────────────────────────────────┤
│ • UI rendering (HTML/CSS/JS)    │
│ • IndexedDB storage (reader)    │
│ • User interactions             │
│ • Report visualization          │
│ • Export trigger events         │
└─────────────────────────────────┘
```

### Architectural Layers (One-Way Dependency)

```
presentation (UI)
       ↓
application (workflows)
       ↓
core (business logic)
       ↓
infrastructure (utilities)
```

**Layer Responsibilities:**

| Layer | Purpose | Examples |
|-------|---------|----------|
| **presentation** | User interface, Electron windows, CSS/HTML rendering | `src/renderer/app.js`, `index.html` |
| **application** | Workflows, orchestration, user intent translation | Extract workflow, comparison workflow, exports |
| **core** | Business logic, algorithms, data transformation | Extraction engine, matcher, comparator, exporters |
| **infrastructure** | Low-level utilities, logging, storage, browser control | Logger, IDB repository, playwright manager, error tracking |

### Storage Architecture

**Design Decision: IndexedDB in Renderer Process**

- IndexedDB is a Chromium/Blink API; it does not exist in Node.js
- All storage operations are owned and executed in the **renderer process** only
- IPC handlers **never call storage**; they receive pre-loaded data via IPC payload
- Comparison workflow: renderer loads both reports → sends element arrays to main → main runs comparison → renderer saves result

**Crash Recovery (Write-Ahead Log):**
```
1. Record PENDING operation in operation_log
2. Write comparison data
3. Mark operation as COMPLETE
4. On next startup: scan for orphaned PENDING entries
5. Report issues but do not auto-replay (eviction state may have changed)
```

### IPC Contract

**Exposed API** via `window.electronAPI`:

```javascript
extractElements(params: { url, depth, useIFrame })
  → { report: { id, elements[], styles{}, ... } }

onExtractionProgress(callback)
  → { phase, progress, message, elementCount }

startComparison(params: { baselineElements[], compareElements[], mode, includeVisualDiffs })
  → Returns IPC port for streaming responses

onComparisonProgress(callback)
  → { phase, progress, elementsProcessed, totalElements }

exportHTML(params: { htmlContent, filename })
exportFile(params: { format, data, filename })

registerBlob(params: { comparisonId, keyframeId, blob })
unregisterBlobsByComparison(comparisonId)

getVersion() → version string
openReport(comparisonId) → Opens report in new window
```

**No IPC Handlers For:**
- Report loading (renderer calls IDB directly)
- Report deletion (renderer calls IDB directly)
- Cached comparison retrieval (renderer calls IDB directly)

---

## Configuration

### Environment Variables

```bash
# Development
NODE_ENV=development npm start    # Webpack watch + Electron dev tools

# Production
NODE_ENV=production npm run build  # Minified, optimized build
```

### Application Defaults

See [src/config/defaults.js](src/config/defaults.js) for all configurable values:

```javascript
{
  extraction: {
    timeout: 20000,
    cssProperties: [/* 80+ properties */],
    shadowSentinel: 0,
  },
  comparison: {
    modes: {
      static: { /* 80+ properties, tight tolerances */ },
      dynamic: { /* 40 properties, loose tolerances */ }
    },
    severity: {
      critical: ['display', 'position', ...],
      high: ['opacity', 'font-size', ...],
      medium: ['margin', 'padding', ...],
    }
  },
  logger: {
    level: 'info',
    prettyPrint: true,
  },
  errorTracking: {
    enabled: true,
    maxRecent: 100,
  },
}
```

### Customization

**To change comparison tolerances:**
Edit `src/config/defaults.js` → `comparison.modes.static/dynamic.tolerances`

**To add new CSS properties:**
Edit `src/config/defaults.js` → `extraction.cssProperties`

**To adjust extraction timeout:**
Edit `src/config/defaults.js` → `extraction.timeout`

**To customize severity levels:**
Edit `src/config/defaults.js` → `comparison.severity.{critical,high,medium}`

---

## Development Guide

### Project Structure

```
src/
├── config/                   # Configuration management
│   ├── defaults.js          # All configurable defaults
│   └── validator.js         # Config validation at startup
├── core/                     # Business logic (no UI, no storage)
│   ├── comparison/          # Matching and diffing
│   │   ├── async-utils.js   # Async utilities for comparison
│   │   ├── color-utils.js   # Color manipulation utilities
│   │   ├── comparator.js    # Main comparison engine
│   │   ├── comparison-modes.js # Static/dynamic mode definitions
│   │   ├── differ.js        # Property diffing logic
│   │   ├── keyframe-grouper.js # Visual diff grouping
│   │   ├── matcher.js       # Element matching algorithms
│   │   ├── severity-analyzer.js # Severity classification
│   │   └── url-compatibility.js # URL compatibility assessment
│   ├── extraction/          # DOM traversal and style collection
│   │   ├── attribute-collector.js # Element attribute collection
│   │   ├── dom-enrichment.js # DOM enhancement utilities
│   │   ├── dom-traversal.js # DOM tree traversal
│   │   ├── element-classifier.js # Element type classification
│   │   ├── extraction-filter.js # Filtering logic for extraction
│   │   ├── extractor.js     # Main extraction engine
│   │   ├── readiness-gate.js # Page readiness detection
│   │   ├── section-detector.js # Page section detection
│   │   ├── style-collector.js # CSS style collection
│   │   └── _page_stubs_/    # Stubs for page context
│   │       ├── electron-log.js
│   │       └── electron.js
│   ├── export/              # Report generation
│   │   ├── comparison-exporters/  # Comparison report exports
│   │   │   ├── csv-exporter.js
│   │   │   ├── excel-exporter.js
│   │   │   ├── html-exporter.js
│   │   │   └── json-exporter.js
│   │   ├── extraction-exporters/  # Extraction report exports
│   │   │   └── report-exporter.js
│   │   └── export-utils/          # Shared export utilities
│   │       ├── csv-utils.js
│   │       ├── download-trigger.js
│   │       └── report-transformer.js
│   ├── normalization/       # CSS normalization
│   │   ├── cache.js         # Normalization caching
│   │   ├── color-normalizer.js # Color value normalization
│   │   ├── font-normalizer.js # Font property normalization
│   │   ├── normalizer-engine.js # Main normalization engine
│   │   ├── shorthand-expander.js # CSS shorthand expansion
│   │   └── unit-normalizer.js # Unit conversion and normalization
│   └── selectors/           # Selector generation and validation
│       ├── selector-engine.js # Main selector engine
│       ├── selector-utils.js # Selector utilities
│       ├── css/             # CSS selector handling
│       │   ├── generator.js
│       │   ├── strategies.js
│       │   └── validator.js
│       └── xpath/           # XPath selector handling
│           ├── generator.js
│           ├── strategies.js
│           └── validator.js
├── infrastructure/          # Utilities and low-level services
│   ├── error-tracker.js     # Error collection and reporting
│   ├── idb-repository.js    # IndexedDB CRUD (renderer only)
│   ├── logger.js            # Structured logging
│   └── performance-monitor.js # Instrumentation
├── main/                    # Electron main process
│   ├── index.js            # App initialization
│   ├── ipc-channels.js     # IPC channel constants
│   ├── ipc-handlers.js     # IPC message handlers
│   ├── playwright-manager.js # Orchestrates Playwright
│   ├── preload.js          # Context bridge setup
│   └── protocol-handler.js # Custom protocol handling
└── renderer/               # Electron renderer process
    ├── app.js             # Main UI logic and state management
    ├── application/       # In-renderer workflows and report management
    │   ├── compare-workflow.js   # Comparison orchestration
    │   ├── export-workflow.js    # Export handling
    │   ├── import-workflow.js    # Import handling
    │   ├── report-manager.js     # Report management
    │   └── url-compatibility.js  # Pre-flight URL compatibility checks
    ├── index.html         # UI template
    ├── state.js           # Application state machine
    ├── stubs/             # Electron stubs for renderer
    │   └── electron.js
    └── ui.js              # Renderer UI helpers and DOM bindings
```



### Running Tests

```bash
# Lint code for style violations
npm run lint

# Auto-fix linting issues
npm run format

# (Unit tests to be added in future phases)
```

### Code Style Guidelines

- **ESLint enforced** (see `.eslintrc.js`)
- **Prettier formatting** (2-space indents, single quotes preferred where appropriate)
- **Async/await over Promises** for readability
- **Comments at module level** explaining purpose, not inline comments for obvious code
- **Meaningful variable names** — avoid `x`, `y`, `temp`
- **Error handling**: Always use try/catch or `.catch()` for Promises
- **No circular imports** — enforce one-way layer dependencies

### Common Development Tasks

#### Debugging in Chrome DevTools

```bash
# Open DevTools in the Electron window
npm start
# Press Ctrl+Shift+I (Windows/Linux) or Cmd+Option+I (macOS)
```

#### Inspecting IDB Storage

In DevTools Console (when Electron window is open):
```javascript
const db = await new Promise((resolve, reject) => {
  const req = indexedDB.open('ui-comparison');
  req.onsuccess = () => resolve(req.result);
  req.onerror = reject;
});

const tx = db.transaction(['reports'], 'readonly');
const store = tx.objectStore('reports');
store.getAll((result) => console.log(result));
```

#### Monitoring Performance

Performance events are logged to the main console. Search logs for:
- `extraction_complete` — Total extraction time
- `comparison_complete` — Total comparison time
- `match_phase_complete` — Time per matching phase
- `visual_capture_complete` — Screenshot capture metrics

#### Adding a New Comparison Mode

1. Add config to `src/config/defaults.js`:
   ```javascript
   comparison.modes.myMode = {
     name: 'My Mode',
     compareProperties: new Set(['color', 'opacity', ...]),
     tolerances: { /* ... */ },
     compareTextContent: false,
   }
   ```

2. Create mode class in `src/core/comparison/comparison-modes.js`:
   ```javascript
   class MyMode extends BaseComparisonMode {
   }
   ```

3. Register in comparator:
   ```javascript
   const modes = {
     myMode: new MyMode(...),
   };
   ```

4. Expose in UI for selection

---

## Core Concepts

### HPID (Hierarchical Position Identifier)

HPIDs trace the path from document root to any element as dot-separated sibling ordinals:
- `1.3.2.1` = "1st child → 3rd child → 2nd child → 1st child"
- **Relative HPID** = rooted at extraction scope (subtree scope for filtered extractions)
- **Absolute HPID** = always rooted at `document.body` (stable across scopes)

**Shadow DOM:** Sentinel values (default `0`) are injected when crossing shadow boundaries to keep HPIDs globally unique.

### Element Matching Pipeline

| Phase | Strategy | Confidence | Use Case |
|-------|----------|------------|----------|
| **0** | Test-attribute anchoring | 1.00 | Elements with `data-testid`, `data-qa`, etc. |
| **1** | Sequence alignment | 0.99 | Elements in same structural position |
| **2** | HPID suffix realignment | 0.85 | Elements shifted by wrapper insertion/removal |
| **3** | Legacy strategies (HPID/ID/selector/xpath/position) | 0.30–0.95 | Fallback matching on remaining orphans |

### Comparison Modes

| Mode | Properties | Text Matching | Tolerances | Use Case |
|------|-----------|:-----------|:----------:|----------|
| **Static** | 80+ (full set) | ✓ Yes | Tight | Regression testing, prod vs staging |
| **Dynamic** | 40 (curated) | ✗ No | Loose | A/B testing, live variant analysis |

### Severity Ranking

| Level | Criteria | Color | Action |
|-------|----------|-------|--------|
| **Critical** | Layout breaking (display:none toggle, flow changes, 50%+ size delta) | Red | Block deployment |
| **High** | High visual impact (opacity >0.3 delta, font-size >25% delta, contrast >0.4) | Orange | Review carefully |
| **Medium** | Layout properties (margin, padding) with minor delta | Yellow | Document change |
| **Low** | Everything else | Gray | No action |

### Cascade Suppression

Inherited CSS changes are automatically suppressed to show only intentional modifications:
- If parent has `color: red → blue` and child has `border-color: red → blue`, child diff is suppressed
- Parent's change is enough; don't report inherited consequence
- Suppressed diffs are preserved in logs for debugging, excluded from severity counts

---

## Performance & Optimization

### Extraction Performance

**Typical Times (informatica.com Coveo page):**
- Small site (50–100 elements): 2–5 seconds
- Medium site (200–500 elements): 5–10 seconds
- Large site (1000+ elements): 15–30 seconds

**Optimization Strategies:**
- Increase `extraction.timeout` in config for very slow sites
- Use `scope` parameter to extract only relevant subtree (e.g., `.main-content` vs full page)
- Disable unnecessary properties in `cssProperties` config

### Comparison Performance

**Typical Times:**
- 300 elements (85% match rate): 2–5 seconds
- 1000 elements (>90% match rate): 10–30 seconds

**Bottleneck Phases:**
1. Phase 1 (sequence alignment): O(n + deletions × lookAhead)
2. Phase 3 (legacy strategies): O(n × strategies) worst case
3. CSS normalization: O(n × properties)
4. Visual capture (if enabled): 5–10 seconds per keyframe

**Scaling Recommendations:**
- For >10k elements, disable visual diff capture
- Process large comparisons in off-peak hours
- Consider splitting extraction by page section

### Memory Management

- Keep report count <1000 in IndexedDB (use bulk delete for housekeeping)
- Visual blobs are largest consumers; consider disabling for very large pages
- Renderer process typically uses 200–500MB; monit or with external tools if exceeding 1GB

---

## Troubleshooting

### Common Issues

#### "Extraction timeout — page took too long to settle"
**Cause:** Page has heavy JavaScript that's still executing or network is very slow.
**Solutions:**
- Increase `extraction.timeout` in config (default 20s)
- Wait for page to fully load before clicking Extract
- Check for infinite scrollers or periodic animations

#### "Match rate only 30% — elements not pairing"
**Causes:**
1. Pages are structurally very different (deleted/added sections)
2. Elements use dynamic IDs or generated selectors
3. Shadow DOM boundaries crossing
**Solutions:**
- Verify both pages are the correct versions
- Check for test IDs (`data-testid`) on elements — Phase 0 matching (100% confidence)
- Review match quality report to identify patterns

#### "Comparison crashes — Critical error in IndexedDB"
**Cause:** Database corruption or storage quota exceeded.
**Solutions:**
- Clear local storage: Settings → Clear Cache → Confirm
- Quit and restart application (WAL recovery on startup)
- If persists, uninstall and reinstall application (deletes all reports)

#### "Visual diffs not appearing in HTML export"
**Cause:** Screenshot capture failed due to DevTools or page interference.
**Solutions:**
- Ensure DevTools is closed during comparison (height >200px delta triggers warning)
- Check warning icons in results panel for capture failures
- Try dynamic mode (which doesn't require visual diff)

#### "Export file is truncated or corrupted"
**Cause:** Browser crashed during large file generation.
**Solutions:**
- Try exporting smaller report (split comparison if needed)
- Use CSV format (more stable for large datasets)
- Update to latest Electron version

### Debug Logging

Enable detailed logging for troubleshooting:

```javascript
window.electronAPI.setLogLevel('debug');
window.electronAPI.exportLogs('./debug-logs.json');
```

Check application logs:
- **Windows**: `%APPDATA%/UI Comparison/logs/`
- **macOS**: `~/Library/Logs/UI Comparison/`
- **Linux**: `~/.config/UI Comparison/logs/`

---

## API Integration

### Programmatic Usage (Main Process)

```javascript
const { Comparator } = require('./src/core/comparison/comparator');
const { Extractor } = require('./src/core/extraction/extractor');

const extractor = new Extractor(page, config);
const report = await extractor.extract();

const comparator = new Comparator(config);
const result = comparator.compare(baselineElements, compareElements, 'static');

const { exportToHTML } = require('./src/core/export/comparison/html-exporter');
const html = await exportToHTML(result, { includeScreenshots: true });
```

### Building Custom Exporters

All exporters follow the same interface:

```javascript
class CustomExporter {
  async export(comparisonResult, options = {}) {
    return {
      success: true,
      data: 'formatted output',
      mimeType: 'application/json',
    };
  }
}
```

---

## Building for Distribution

### Creating Release Builds

```bash
# Build and create all platform installers
npm run build
npm run dist

# Or create platform-specific installer
npm run dist:win   # Windows .exe
npm run dist:mac   # macOS .dmg
npm run dist:linux # Linux AppImage
```

### Code Signing (macOS)

For production macOS releases, acquire a Developer ID certificate and set:
```bash
export CSC_LINK="path/to/certificate.p12"
export CSC_KEY_PASSWORD="passphrase"
npm run dist:mac
```

### Auto-Updates

Auto-updates are configured in `electron-builder.config.js`. To enable:
1. Set `publish` metadata with your release server URL
2. Sign releases with code signing certificates
3. Verify updates are working in Settings → Check for Updates

---

## Detailed Architecture

### Main Process (Node.js Runtime)

The main process handles Electron lifecycle, IPC communication, and orchestrates Playwright browser operations.

**Key Components:**

- **`src/main/index.js`** — Application entry point, window creation, config validation
- **`src/main/ipc-handlers.js`** — IPC message routing and handler registration
- **`src/main/playwright-manager.js`** — Browser control, screenshot capture, comparison execution
- **`src/main/preload.js`** — Context bridge exposing secure APIs to renderer
- **`src/main/protocol-handler.js`** — Custom `app://` protocol for loading UI assets

**IPC Contract Details:**

```javascript
window.electronAPI = {
  startComparison(params): Promise<ComparisonResult>
  onComparisonProgress(callback): UnsubscribeFunction
  
  extractElements(params): Promise<ExtractionResult>
  onExtractionProgress(callback): UnsubscribeFunction
  
  exportHTML(params): Promise<void>
  exportFile(params): Promise<{success: boolean, filePath?: string}>
  
  registerBlob(params): Promise<void>
  unregisterBlobsByComparison(id): Promise<void>
  
  getVersion(): Promise<string>
  openReport(id): Promise<void>
}
```

### Renderer Process (Chromium Runtime)

The renderer process manages the UI, state, and IndexedDB storage operations.

**Key Components:**

- **`src/renderer/app.js`** — Main UI logic, event handlers, toast notifications
- **`src/renderer/state.js`** — Application state management with reducer pattern
- **`src/renderer/index.html`** — UI template with embedded CSS variables
- **`src/renderer/application/`** — Workflow orchestrators:
  - `compare-workflow.js` — Comparison execution and result display
  - `export-workflow.js` — Multi-format export handling
  - `import-workflow.js` — Report import functionality
  - `report-manager.js` — Report CRUD operations and UI updates

### Core Business Logic

**Comparison Engine (`src/core/comparison/`):**

- **`comparator.js`** — Main comparison orchestrator, coordinates matching and diffing
- **`matcher.js`** — Four-phase element matching pipeline with confidence scoring
- **`differ.js`** — Property-level diffing with tolerance-based comparisons
- **`severity-analyzer.js`** — Severity classification (critical/high/medium/low)
- **`comparison-modes.js`** — Static vs dynamic comparison mode implementations
- **`keyframe-grouper.js`** — Visual diff screenshot grouping logic
- **`async-utils.js`** — Async utilities for non-blocking operations
- **`color-utils.js`** — Color parsing and manipulation utilities

**Extraction Engine (`src/core/extraction/`):**

- **`extractor.js`** — Main extraction coordinator
- **`dom-traversal.js`** — DOM tree traversal with HPID generation
- **`style-collector.js`** — CSS computed style collection
- **`element-classifier.js`** — Element tier classification (content/layout/etc.)
- **`attribute-collector.js`** — HTML attribute collection
- **`readiness-gate.js`** — Page load state detection
- **`section-detector.js`** — Page section identification
- **`dom-enrichment.js`** — Additional DOM metadata collection

**Export System (`src/core/export/`):**

- **`comparison/html-exporter.js`** — Self-contained HTML report generation
- **`comparison/csv-exporter.js`** — CSV format for data analysis
- **`comparison/json-exporter.js`** — JSON format for API integration
- **`comparison/excel-exporter.js`** — Excel workbook generation
- **`extraction/report-exporter.js`** — Extraction report exports
- **`shared/report-transformer.js`** — Common report transformation utilities
- **`shared/csv-utils.js`** — CSV generation utilities
- **`shared/download-trigger.js`** — File download handling

**Normalization Engine (`src/core/normalization/`):**

- **`normalizer-engine.js`** — Main normalization coordinator
- **`color-normalizer.js`** — Color value standardization
- **`font-normalizer.js`** — Font property normalization
- **`unit-normalizer.js`** — CSS unit conversion (px, em, rem, etc.)
- **`shorthand-expander.js`** — CSS shorthand property expansion
- **`cache.js`** — Normalization result caching

**Selector Engine (`src/core/selectors/`):**

- **`selector-engine.js`** — Main selector generation coordinator
- **`css/generator.js`** — CSS selector generation strategies
- **`css/strategies.js`** — CSS selector matching algorithms
- **`css/validator.js`** — CSS selector validation
- **`xpath/generator.js`** — XPath selector generation
- **`xpath/strategies.js`** — XPath selector matching
- **`xpath/validator.js`** — XPath selector validation
- **`selector-utils.js`** — Common selector utilities

### Infrastructure Layer

**Storage & Persistence (`src/infrastructure/`):**

- **`idb-repository.js`** — IndexedDB CRUD operations with WAL for crash recovery
- **`logger.js`** — Structured logging with configurable transports
- **`error-tracker.js`** — Error collection and reporting system
- **`performance-monitor.js`** — Operation timing and bottleneck detection

### Configuration System

**Configuration Management (`src/config/`):**

- **`defaults.js`** — All default configuration values and validation
- **`validator.js`** — Configuration validation at startup

**Key Configuration Areas:**

```javascript
{
  // Extraction settings
  extraction: {
    timeout: 20000,           // Page load timeout
    cssProperties: [...],     // 80+ CSS properties to track
    skipInvisible: true,      // Skip invisible elements
    batchSize: 20            // Processing batch size
  },
  
  // Comparison settings  
  comparison: {
    modes: {
      static: { /* Full CSS suite, tight tolerances */ },
      dynamic: { /* Curated 40 properties, loose tolerances */ }
    },
    severity: {
      critical: ['display', 'position', ...],
      high: ['opacity', 'font-size', ...],
      medium: ['margin', 'padding', ...]
    }
  },
  
  // Matching settings
  hpid: {
    coordinateMode: 'dual',   // HPID generation strategy
    maxDepth: 5000           // Maximum DOM depth
  },
  
  // Selector generation
  selectors: {
    generateCSS: true,
    generateXPath: true,
    concurrency: 4
  }
}
```

---

## Security Considerations

- **No external network calls** — All processing is local; no data sent to servers
- **Local storage only** — Reports stored in IndexedDB; no cloud sync
- **Browser isolation** — Playwright runs in isolated browser contexts
- **No credential handling** — Does not store or transmit authentication data
- **Content Security Policy** — Electron CSP headers prevent XSS in renderer
- **Input validation** — All IPC messages validated before processing
- **Error sanitization** — Sensitive information stripped from error logs

---

## Dependencies

### Runtime Dependencies

- **Electron 33.0.0** — Cross-platform desktop app framework
- **Playwright 1.48.0** — Browser automation for extraction
- **better-sqlite3 12.8.0** — SQLite database for metadata (if used)
- **electron-log 5.1.2** — Structured logging
- **electron-updater 6.3.0** — Auto-update functionality
- **xlsx 0.18.5** — Excel file generation

### Development Dependencies

- **Webpack 5.96.0** — Module bundling
- **Babel 7.24.0** — JavaScript transpilation
- **ESLint 8.57.0** — Code linting
- **Prettier 3.2.5** — Code formatting
- **electron-builder 24.13.3** — Application packaging
- **fake-indexeddb 6.2.5** — IndexedDB mocking for tests

### Browser Dependencies

Playwright bundles:
- **Chromium** — Primary browser engine
- **Firefox** — Alternative browser for compatibility testing
- **WebKit** — Safari engine for cross-browser validation

