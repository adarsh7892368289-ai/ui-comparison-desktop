# UI Comparison Desktop

## What This System Does

UI Comparison Desktop is an Electron application that captures the complete DOM structure and computed CSS of any web page using Playwright, then pairs elements across two captures and diffs every tracked CSS property to produce a severity-ranked comparison report. It exists because screenshot-based visual regression tools cannot tell you *which element changed* or *which CSS property caused the change* — this tool operates at the semantic DOM level, producing per-element, per-property diffs with configurable tolerances, confidence-scored matching, and automatic cascade suppression to eliminate false positives caused by CSS inheritance.

A comparison begins when the user enters a URL and triggers extraction. Playwright launches a headless browser (default **Chromium**; **Firefox** and **WebKit** are also supported when `extractElements` is called with `options.browserType`), navigates to the page, waits for DOM stability (skeleton screens gone, images loaded, MutationObserver quiet), then injects a webpack-bundled extraction script (`extractor-bundle.js`) into the page context. That script walks the DOM via TreeWalker, computes a Hierarchical Position Identifier (HPID) for every element, reads `getComputedStyle` for 70+ CSS properties, collects bounding rects, generates both CSS and XPath selectors, classifies each element into tiers, detects page sections, and returns the full element inventory to the main process. The user repeats this for a second page (or environment). When they click Compare, the renderer process loads both element arrays from IndexedDB, sends them to the main process over IPC, where the Comparator runs a four-phase matching pipeline (test-attribute anchoring → sequence alignment → HPID suffix realignment → legacy strategy pool), then the PropertyDiffer normalizes and diffs every CSS property with tolerance-aware comparisons. A SeverityAnalyzer classifies each diff as critical/high/medium/low, and a cascade suppression pass removes inherited property echoes. If screenshots are requested, Playwright opens both pages, groups changed elements into keyframes by scroll position, freezes animations, captures WebP screenshots via CDP, and maps element bounding rects onto the screenshots. The final result flows back to the renderer where it is persisted in IndexedDB (with WAL crash recovery) and rendered in the result panel.

## Architecture Overview

### Layered architecture

Rough dependency direction (keep **core** free of Electron/renderer imports so the same modules work in the main process, in-page extractor bundle, and webpack bundles):

```
presentation (components, HTML, CSS)
       ↓
application (workflows, state, app entry)
       ↓
core (extraction, comparison, normalization, export)     infrastructure (IDB, logging, perf, errors)
```

**Rules that hold in practice:**

- **`src/core/`** must not import Electron, preload APIs, or renderer-only code. It is shared by the main process, the in-page extractor (`window.__uiCompare`), and the renderer bundle (via `@core/...` aliases where workflows need a small surface, e.g. `url-compatibility.js`).
- **`src/infrastructure/`** must not import from `application` or UI components. It is imported by the renderer bundle (IndexedDB, logger, error tracker) and must stay usable in that context.
- **`src/renderer/components/`** should stay thin: DOM, styles, and `window.electronAPI` only where needed (e.g. context menu). Avoid pulling in the full comparator or extractor.
- **`src/renderer/application/`** orchestrates workflows: it calls `window.electronAPI`, uses `src/infrastructure/idb-repository.js`, and may import specific modules under `@core/` (see `compare-workflow.js` → `url-compatibility.js`). Heavy comparison still runs in the **main** process inside `playwright-manager.js` (Node `require` of `Comparator`), not in the renderer.

### Webpack entry points and aliases

| Bundle | Config | Output | Notes |
|--------|--------|--------|--------|
| Main + preload | `webpack.main.config.js` | `dist/index.js`, `dist/preload.js` | `target: electron-main`, Playwright externalized |
| Renderer app | `webpack.renderer.config.js` | `dist/renderer/app.js` | `target: web`, copies `index.html` + `styles/` |
| Extractor (in-page) | `webpack.extractor.config.js` | `dist/extractor-bundle.js` | UMD → `window.__uiCompare` |

**Renderer resolve aliases** (`webpack.renderer.config.js`): `@core` → `src/core`, `@config` → `src/config`, `@infra` → `src/infrastructure`, `electron` → renderer stub, `electron-log` → `electron-log/renderer`.

**Main resolve aliases:** `@core`, `@config`, `@infra` (same folders).

The renderer entry `src/renderer/app.js` is written as **ES modules**; it imports `logger` and `errorTracker` from infrastructure on startup, then wires components and workflows on `DOMContentLoaded`.

### Dual-Process Electron Split

```
┌─────────────────────────────────────────────────┐
│  MAIN PROCESS  (Node.js)                        │
│                                                 │
│  src/main/index.js         App lifecycle        │
│  src/main/ipc-handlers.js  IPC request routing  │
│  src/main/playwright-manager.js  Browser ctrl   │
│  src/main/protocol-handler.js    app:// scheme  │
│  src/main/preload.js       Context bridge       │
│                                                 │
│  Owns: Playwright, file system, native dialogs, │
│        process lifecycle, CDP sessions          │
│  Cannot: Access DOM, read IndexedDB, render UI  │
├─────────────────────IPC─────────────────────────┤
│  RENDERER PROCESS  (Chromium)                   │
│                                                 │
│  src/renderer/app.js       Entry + wiring       │
│  src/renderer/state.js     State machine        │
│  src/renderer/application/ Workflow orchestr.   │
│  src/renderer/components/  UI components        │
│  src/infrastructure/*      IDB, logger, errors  │
│    (bundled into renderer via webpack)          │
│                                                 │
│  Owns: IndexedDB, DOM rendering, CSS,           │
│        state management, export formatting      │
│  Cannot: Launch browsers, access file system,   │
│          run Node.js APIs                       │
└─────────────────────────────────────────────────┘
```

**Why this split matters:** IndexedDB is a Chromium/Blink API — it does not exist in Node.js. All persistence goes through the renderer’s `idb-repository` (bundled by webpack). The main process does not open IndexedDB. For a comparison, the renderer loads both element arrays from IndexedDB, sends them to main over IPC; main runs the `Comparator` pipeline in Node and optionally uses Playwright for screenshots; results return to the renderer for saving (including visual blob side stores when enabled).

### IPC Contract

All IPC communication uses named channels defined in `src/main/ipc-channels.js`. The preload script (`src/main/preload.js`) exposes them via `contextBridge.exposeInMainWorld('electronAPI', {...})`.

```
┌─────────────┐                         ┌──────────────┐
│  Renderer    │  invoke(channel, data)  │  Main        │
│  Process     │ ──────────────────────> │  Process     │
│              │ <────────────────────── │              │
│              │  return { success, ... }│              │
│              │                         │              │
│              │  send(channel, payload) │              │
│              │ <────────────────────── │              │
│              │  (push: progress)       │              │
└─────────────┘                         └──────────────┘
```

## Repository Map

```
src/
├── config/
│   ├── defaults.js              # All configuration: extraction, comparison, matching,
│   │                            # normalization, selectors, storage, logging, export.
│   │                            # Deep-frozen at startup. Overridable via init().
│   └── validator.js             # Validates config at boot — required paths, types, ranges.
│
├── core/
│   ├── comparison/
│   │   ├── async-utils.js       # MessageChannel-based yield, progress/result frame builders.
│   │   ├── color-utils.js       # parseRgba, parsePx, relativeLuminance.
│   │   ├── comparator.js        # Orchestrator: pipes matcher → differ → severity → result.
│   │   ├── comparison-modes.js  # StaticComparisonMode, DynamicComparisonMode, cascade suppression.
│   │   ├── differ.js            # PropertyDiffer: normalizes then tolerance-compares properties.
│   │   ├── keyframe-grouper.js  # Groups elements by scroll position into screenshot keyframes.
│   │   ├── matcher.js           # ElementMatcher: 4-phase pipeline (anchor→sequence→suffix→legacy).
│   │   ├── severity-analyzer.js # SeverityAnalyzer: critical/high/medium/low classification.
│   │   └── url-compatibility.js # Pre-flight URL path/query/hash comparison.
│   │
│   ├── extraction/
│   │   ├── _page_stubs_/        # No-op stubs for electron/electron-log when bundled for in-page.
│   │   ├── attribute-collector.js # Collects element attributes, filtering framework-generated ones.
│   │   ├── dom-enrichment.js    # Neighbour context and class hierarchy collection.
│   │   ├── dom-traversal.js     # TreeWalker-based DOM walk, HPID generation, shadow DOM support.
│   │   ├── element-classifier.js # Tier classification (T0 irrelevant → T3 interactive).
│   │   ├── extraction-filter.js # Parses class/id/tag filters into CSS selectors.
│   │   ├── extractor.js         # Main extraction coordinator: readiness → traverse → pass1 → build.
│   │   ├── readiness-gate.js    # MutationObserver-based page stability detector.
│   │   ├── section-detector.js  # Classifies elements as header/main/footer by semantics or position.
│   │   └── style-collector.js   # Reads getComputedStyle for configured CSS properties.
│   │
│   ├── export/
│   │   ├── comparison-exporters/
│   │   │   ├── csv-exporter.js  # Builds multi-section CSV: summary, diffs, matched, unmatched.
│   │   │   ├── excel-exporter.js # Multi-sheet XLSX via SheetJS: summary, diffs, severity.
│   │   │   ├── html-exporter.js # Self-contained HTML report with embedded screenshots and CSS.
│   │   │   └── json-exporter.js # Machine-readable JSON export.
│   │   ├── export-utils/
│   │   │   ├── csv-utils.js     # CSV escaping and row serialization.
│   │   │   ├── download-trigger.js # Blob → object URL → programmatic click download.
│   │   │   └── report-transformer.js # BFS cascade suppression, content intelligence,
│   │   │                              # impact scoring, deduplication, grouped report building.
│   │   └── extraction-exporters/
│   │       └── report-exporter.js # Export extraction reports as CSV/JSON/Excel.
│   │
│   ├── normalization/
│   │   ├── cache.js             # Dual LRU cache: absolute (context-free) + relative (context-dependent).
│   │   ├── color-normalizer.js  # Normalizes hex/named/hsl/rgb → rgba(r, g, b, a).
│   │   ├── font-normalizer.js   # Normalizes font-family: strips quotes, standardizes casing.
│   │   ├── normalizer-engine.js # Routes properties to color/size/font normalizers with caching.
│   │   ├── shorthand-expander.js # Expands CSS shorthands (margin → margin-top/right/bottom/left).
│   │   └── unit-normalizer.js   # Converts em/rem/%/vw/vh/pt/cm → px with context snapshot.
│   │
│   └── selectors/
│       ├── css/
│       │   ├── generator.js     # Tiered CSS selector generation with timeout per strategy.
│       │   ├── strategies.js    # CSS selector strategies ordered by robustness tier.
│       │   └── validator.js     # CSS selector uniqueness validation.
│       ├── xpath/
│       │   ├── generator.js     # Tiered XPath generation with timeout per strategy.
│       │   ├── strategies.js    # XPath strategies ordered by robustness tier.
│       │   └── validator.js     # XPath uniqueness validation.
│       ├── selector-engine.js   # Coordinates CSS + XPath generation with bounded concurrency queue.
│       └── selector-utils.js    # Stable ID/class/value detection, ancestor chain walking.
│
├── infrastructure/
│   ├── error-tracker.js         # Deduplicating error tracker with count, firstSeen, lastSeen.
│   ├── idb-repository.js        # IndexedDB CRUD with WAL, circuit breaker, eviction, visual blob storage.
│   ├── logger.js                # Structured logger with console transport and level filtering.
│   └── performance-monitor.js   # Operation timing with p50/p95/p99 percentile tracking.
│
├── main/
│   ├── index.js                 # Electron app entry: config init, validation, window creation.
│   ├── ipc-channels.js          # Channel name constants (frozen object).
│   ├── ipc-handlers.js          # All ipcMain.handle registrations.
│   ├── playwright-manager.js    # Browser lifecycle, extraction, comparison, visual diff capture.
│   ├── preload.js               # contextBridge.exposeInMainWorld('electronAPI', {...}).
│   └── protocol-handler.js      # Custom app:// protocol, blob cache with 512MB LRU eviction.
│
├── renderer/
│   ├── app.js                   # DOMContentLoaded entry: wires components, commands, keyboard shortcuts.
│   ├── state.js                 # Reducer-based state machine (dispatch/subscribe/getState).
│   ├── ui.js                    # Re-exports Toast, Modal, progress helpers.
│   ├── application/
│   │   ├── compare-workflow.js  # Loads elements from IDB, invokes IPC, persists results.
│   │   ├── export-workflow.js   # Format-specific export handlers (HTML/CSV/JSON/Excel).
│   │   ├── import-workflow.js   # Per-slot file import (JSON/CSV/Excel) → parse → save to IDB.
│   │   └── report-manager.js    # Init, WAL replay, report list, extraction, context-menu actions, filters.
│   ├── components/
│   │   ├── app-shell.js         # Accordion navigation, breadcrumb, panel toggle.
│   │   ├── command-palette.js   # Ctrl+K command palette with fuzzy search.
│   │   ├── modal.js             # Promise-based confirm dialog.
│   │   ├── progress-bar.js      # Progress bar show/update/hide.
│   │   ├── report-list.js       # Virtual-scroll report list with grouping, sorting, density.
│   │   ├── result-panel.js      # Comparison result rendering: severity bars, coverage, actions.
│   │   ├── status-bar.js        # Bottom status bar: report count, phase indicator, shortcuts.
│   │   ├── system-banner.js     # Persistent warning/error banner for storage degradation.
│   │   └── toast.js             # Notification toasts (success/error/warning/info).
│   ├── stubs/
│   │   └── electron.js          # No-op Electron API stubs for webpack renderer bundle.
│   ├── styles/
│   │   ├── tokens.css           # Design tokens: colors, spacing, typography, shadows.
│   │   ├── base.css             # Reset, body, typography, form elements.
│   │   ├── shell.css            # App shell layout: toolbar, left panel, main content, status bar.
│   │   ├── components.css       # Buttons, cards, badges, modals, toasts, toggles.
│   │   ├── navigation.css       # Accordion nav sections, breadcrumb, command palette.
│   │   ├── report-list.css      # Virtual scroll viewport, report cards, export dropdowns.
│   │   └── result-panel.css     # Result panel: severity bars, coverage meters, element rows.
│   ├── utils/
│   │   ├── icons.js             # Inline SVG icon helpers for toolbar, lists, and commands.
│   │   ├── sanitize.js          # XSS-safe HTML escaping via textContent → innerHTML.
│   │   └── time.js              # Relative time formatting (just now, 5m ago, 2h ago, 3d ago).
│   └── index.html               # Main HTML template with all section markup.
│
├── scripts/
│   └── check-env.js             # Pre-build check: PLAYWRIGHT_BROWSERS_PATH exists with chromium.
│
├── webpack.main.config.js       # Main process bundle: target electron-main, externals playwright.
├── webpack.renderer.config.js   # Renderer bundle: target web, stubs electron, copies static assets.
├── webpack.extractor.config.js  # Extractor bundle: UMD library __uiCompare for in-page injection.
├── electron-builder.config.js   # Packaging: NSIS/DMG, asar, playwright browser bundling.
└── package.json                 # Scripts, dependencies, project metadata.
```

## Data Flow: End to End

This traces a single comparison operation from user action to rendered result.

### Phase 1: Extraction (URL → Element Inventory)

1. User types a URL into `#url-input` and clicks `#extract-btn`.
2. `report-manager.js` → `handleExtraction()` reads the URL and optional filter inputs (`filter-class`, `filter-id`, `filter-tag`).
3. `dispatch('EXTRACTION_PROGRESS', ...)` updates state; `showProgress('extract', ...)` shows the progress bar.
4. `window.electronAPI.extractElements({ url, options })` invokes IPC. The live UI passes `options.filters` when class/id/tag filters are set; `options.browserType` (`chromium` \| `firefox` \| `webkit`) is optional and defaults to `chromium` in `playwright-manager.js`.
5. **Main process** `ipc-handlers.js` → `_registerExtractionHandlers()` → `ipcMain.handle(CH.EXTRACT_ELEMENTS, ...)` calls `playwrightManager.runExtraction()`.
6. `playwright-manager.js` → `getBrowser(browserType)` launches or reuses a headless Playwright browser of that type.
7. A new browser context and page are created. `page.goto(url, { waitUntil: 'load' })`.
8. If filters are provided, `buildSelectorFromFilters(filters)` constructs a compound CSS selector. The manager waits for the selector to become visible and for descendant count to stabilize.
9. `page.addScriptTag({ content: getExtractorBundleSource() })` injects the extractor bundle (built by `webpack.extractor.config.js` from `src/core/extraction/extractor.js`).
10. `page.evaluate(({ filters, cfg }) => window.__uiCompare.extractWithConfig(filters, cfg))` runs the extraction in-page.

**Inside the page context (extractor.js):**

11. `waitForReadiness(filters)` — a MutationObserver watches for DOM stability. Noise mutations (analytics, tracking) are classified and ignored. The gate clears when no visual mutations occur for `stabilityWindowMs` (500ms) and no skeleton elements or unloaded images remain. Returns quality: `OPTIMAL`, `STABLE`, or `DEGRADED`.
12. `traverseDocument(filters)` — uses TreeWalker with a NodeFilter that rejects T0 tags (script, style, meta, etc.). For each element, computes both a relative HPID (rooted at extraction scope) and an absolute HPID (rooted at document.body). Shadow DOM boundaries inject a sentinel value (`0`) into the HPID path.
13. `executePass1(visits)` — single synchronous pass reads `getBoundingClientRect()` and `getComputedStyle()` for every element.
14. `applyVisibilityFilter()` — removes elements where `display:none`, `visibility:hidden`, `opacity:0`, or zero-dimension rect.
15. `executeUnifiedPass()` — processes elements in adaptive batches (40 for ≤200 elements, down to 10 for >3000). For each element, builds an element record with HPID, tag, id, class, text, styles, attributes, rect, tier, page section. Then generates CSS and XPath selectors via `generateSelectorsForElements()` using a bounded concurrency queue.
16. Returns a report object:

```javascript
{
  id: "uuid",
  url: "https://...",
  title: "Page Title",
  timestamp: "2024-...",
  totalElements: 342,
  elements: [
    {
      hpid: "1.3.2.1",
      absoluteHpid: "1.3.2.1",
      tagName: "div",
      elementId: "main-header",
      className: "header-container",
      textContent: "Welcome",
      cssSelector: "#main-header",
      xpath: "//*[@id='main-header']",
      depth: 4,
      tier: "T1",
      pageSection: "header",
      styles: { "color": "rgb(0, 0, 0)", "font-size": "16px", ... },
      attributes: { "role": "banner", ... },
      rect: { x: 0, y: 0, width: 1280, height: 64, top: 0, left: 0 }
    },
    // ...
  ],
  duration: 5200,
  captureQuality: "OPTIMAL"
}
```

17. **Back in main process:** `crypto.randomUUID()` assigns the report ID. Result returns to renderer via IPC.
18. **Renderer:** `storage.saveReport(report)` writes to IndexedDB with WAL protection (write PENDING entry to `operation_log`, write to `reports` and `elements` stores, delete WAL entry). Report count eviction fires if > 50 reports.

### Phase 2: Comparison (Two Reports → Diff Report)

19. User selects baseline and compare reports from `#baseline-report` / `#compare-report`, chooses **dynamic** or **static** mode (`[name="compare-mode"]`), and optionally turns **Visual Diff** off via `#visual-diff-toggle` (maps to `includeScreenshots`). They can **Import file** per slot (`#baseline-upload`, `#compare-upload`) through `import-workflow.js` instead of using a saved extraction.
20. When selections or mode change, `tryLoadCachedComparison()` in `compare-workflow.js` looks up an existing comparison by `(baselineId, compareId, mode)` in IndexedDB and, if found, dispatches `COMPARISON_COMPLETE` with `cachedAt` so the result panel shows stored diffs without re-running main-process work.
21. User clicks `#compare-btn`. `compare-workflow.js` → `handleComparison()` runs `assessUrlCompatibility()` (from `@core/comparison/url-compatibility.js` in the renderer) — if paths differ, comparison is blocked (`INCOMPATIBLE`). If query/hash differs, a warning toast fires (`CAUTION`).
22. `storage.loadReportElements(baselineId)` and `storage.loadReportElements(compareId)` load both element arrays from IndexedDB.
23. `window.electronAPI.startComparison({ baselineId, compareId, mode, baselineUrl, compareUrl, baselineElements, compareElements, includeScreenshots })` sends elements to main process.
24. **Main process:** `playwrightManager.runComparison()` builds synthetic report objects, instantiates `Comparator` from `src/core/comparison/comparator.js`, and runs `comparator.compare(...)`. Matching and diffing are pure Node logic; Playwright is used again for optional screenshot capture and visual pipeline steps.

**Matching pipeline (matcher.js):**

25. **Phase 0 — Test attribute anchoring:** Builds a multimap of compare elements keyed by `data-testid`/`data-qa`/etc. values. Matches baseline elements with identical attribute values. Confidence: 1.00.
26. **Phase 1 — Sequence alignment:** Walks baseline and compare arrays in parallel. At each position, first checks if HPIDs match but tagNames differ (`isReplacement`) — marks both as removed/added. Then checks if `tagName` and HPID segments match (`passesIdentityTriad`) — pairs them (confidence: 0.99). If neither, looks ahead up to 5 positions for a match. Unmatched elements in the gap are classified as added/removed.
27. **Phase 2 — HPID suffix realignment:** For orphaned elements from Phase 1, builds a suffix index (last 5 HPID segments + tagName). Elements with a unique suffix match are paired (confidence: 0.85). This handles cases where wrapper elements were inserted/removed, shifting HPIDs.
28. **Phase 3 — Legacy strategies:** Runs remaining orphans through classifiers in descending confidence order: `absolute-hpid` (0.95) → `id` (0.90) → `css-selector` (0.80) → `xpath` (0.78) → `position` (0.30, using a spatial grid with 50px cells).

**Diffing pipeline (comparison-modes.js + differ.js):**

29. For each matched pair, `PropertyDiffer.compareElements()` normalizes both elements' styles through `normalizerEngine.normalize()` (shorthand expansion → color/unit/font normalization with LRU cache), then compares every property. Tolerance strategies apply: color ±5 (static) or ±8 (dynamic) channel delta, size ±3px or ±5px, opacity ±0.01 or ±0.05.
30. Text content and attributes are compared (static mode includes text; dynamic mode excludes text, compares only structural attributes like `role`, `aria-label`).
31. `SeverityAnalyzer.analyzeDifferences()` classifies each diff. Layout-breaking changes (display none toggle, 50%+ size delta) → critical. High visual impact (opacity >0.3 delta, font-size >25% delta, luminance contrast >0.4) → high. Spacing properties → medium. Everything else → low.
32. `BaseComparisonMode.#suppressInheritedCascades()` walks the HPID tree. If a parent changed `color: red → blue` and a child has the identical change on an inheritable property, the child's diff is suppressed.

**Visual capture (playwright-manager.js):**

33. If `includeScreenshots` is true, Playwright opens both URLs in new pages.
34. `captureVisualDiffs()` extracts modified elements, builds selector pairs, and for each page: locks scrollbar, freezes animations via CSS injection and `requestAnimationFrame` patching, suppresses fixed/sticky elements that aren't diff targets.
35. `groupIntoKeyframes()` clusters elements by vertical position and groups them into scroll-position keyframes that fit within the viewport.
36. For each keyframe: scroll to position, verify scroll via `window.scrollY`, remeasure element rects, freeze JS execution (CDP `Emulation.setScriptExecutionDisabled` on Chromium, shim on Firefox/WebKit), capture full-viewport screenshot (WebP via CDP, PNG via Playwright API), unfreeze.
37. Screenshots are stored in the main process blob cache (`protocol-handler.js`, 512MB LRU eviction by comparison group).

**Result assembly:**

38. `runComparison()` assembles the final result:

```javascript
{
  comparisonId: "uuid",
  baselineId: "...",
  compareId: "...",
  mode: "dynamic",
  urlCompatibility: { classification: "COMPATIBLE", ... },
  matching: { totalMatched: 285, matchRate: 92, ... },
  comparison: {
    mode: "dynamic",
    results: [ /* per-element diff results */ ],
    summary: { severityCounts: { critical: 2, high: 5, medium: 12, low: 8 }, ... }
  },
  unmatchedElements: { baseline: [...], compare: [...] },
  visualDiffs: { /* hpid → { baseline: rectData, compare: rectData } */ },
  visualBlobs: { /* keyframeId → { buffer: Uint8Array, mimeType: "image/webp" } */ },
  visualKeyframes: [ /* keyframe metadata */ ],
  visualRectRecords: [ /* element rect records */ ],
  duration: 12400,
  completedAt: "2024-..."
}
```

39. **Renderer receives result:** Saves comparison metadata and diffs to IndexedDB (`saveComparison(meta, slimResults)`). Saves visual blobs, keyframes, and rect records separately. Dispatches `COMPARISON_COMPLETE` to state.
40. `ResultPanel.render()` builds the result panel: match rate circle, element coverage bar (unchanged/modified/added/removed segments), severity breakdown bars, unmatched element sections, export/report action buttons.

## Core Subsystems — Deep Dives

### DOM Snapshot Capture Pipeline

The extraction pipeline runs entirely inside the target page's JavaScript context. The extractor bundle (`webpack.extractor.config.js`) compiles `src/core/extraction/extractor.js` and its dependencies into a UMD module exposed as `window.__uiCompare`. This bundle uses stub modules for `electron` and `electron-log` (`src/core/extraction/_page_stubs_/`) so that shared core code that imports these modules doesn't crash in a browser context.

**HPID Identity Strings:** Every element receives two identifiers. The relative HPID is computed during traversal as dot-separated sibling ordinals relative to the extraction root (e.g., `1.3.2.1` means "first child of root → third child → second child → first child"). The absolute HPID is computed by walking `parentElement` up to `document.body`, using `previousElementSibling` counting. When crossing a Shadow DOM boundary (`parentNode instanceof ShadowRoot`), a sentinel value (default `0`) is injected into the path, making HPIDs globally unique across shadow boundaries.

**Bounding Geometry:** `getBoundingClientRect()` is read in a single synchronous pass (`executePass1`) to avoid layout thrashing. The values are converted from viewport-relative to document-relative by adding `scrollX`/`scrollY` at read time. All coordinates are `Math.round()`ed to integers.

**Computed CSS:** `getComputedStyle(element)` is called once per element during Pass 1. The collector reads every property listed in `config.extraction.cssProperties` (70+ properties). These are the post-cascade, post-animation resolved values.

**Readiness Gate:** Before traversal, `waitForReadiness()` uses a MutationObserver on `document.documentElement` watching `childList`, `subtree`, and `attributes`. Mutations are classified as "noise" (analytics tags, tracking attributes, offscreen elements) or "visual". The gate clears when: (a) no visual mutations occur for `stabilityWindowMs` (500ms), (b) no skeleton/shimmer elements exist, and (c) all viewport-visible images are loaded. A hard timeout (`hardTimeoutMs`) ensures extraction proceeds even if the page never fully settles, returning quality `DEGRADED`. The default config sets this to 1,000ms, but `playwright-manager.js` overrides it to 20,000ms when running extractions, giving real-world pages adequate time to settle.

### Multi-Phase Element Matching Pipeline

The matcher (`src/core/comparison/matcher.js`) uses an async generator pattern, yielding progress frames between phases so the UI can update the progress bar.

**Phase 0 (Test Attributes):** Builds a multimap of compare elements keyed by test attribute values (`data-testid`, `data-qa`, `data-cy`, etc. — 9 attributes configured in `config.comparison.matching.anchorAttributes`). For each baseline element with a matching key, resolves from the multimap. If exactly one available compare element matches, it's a definitive match (confidence 1.00). If multiple match, it's marked ambiguous.

**Phase 1 (Sequence Alignment):** Walks both arrays with two pointers. At each position, first checks if HPIDs match but tagNames differ (`isReplacement`) — if so, the element was replaced (old is removed, new is added). Then checks if both tagName and HPID segments match (`passesIdentityTriad`) — if yes, pair them (confidence 0.99). If no match at current position, look ahead up to `lookAheadWindow` (5) positions in both directions. Elements skipped by look-ahead are classified as added (compare) or removed (baseline).

**Phase 2 (HPID Suffix Realignment):** Takes orphans from Phase 1 and builds a suffix index: for each compare orphan, takes the last `suffixDepth` (5) segments of the HPID plus tagName as a key. Baseline orphans are matched against this index. Only 1:1 unique matches are accepted (confidence 0.85). This recovers matches when a wrapper div was inserted/removed, shifting all descendant HPIDs by one segment.

**Phase 3 (Legacy Strategies):** Runs remaining orphans through six strategy classifiers in descending confidence order: absolute-hpid (0.95), element-id (0.90), css-selector (0.80), xpath (0.78), position (0.30). Each classifier builds its own index (multimap or spatial grid) and processes all remaining baseline orphans. The position classifier uses a 2D grid with configurable cell size (`positionTolerance`, 50px), searching adjacent cells for the nearest same-tag element.

### CSS Diff Engine and Severity Ranking

**Normalization (before diffing):** Every style object passes through `normalizerEngine.normalize()`:
1. `expandShorthands()` — Expands `margin` → `margin-top/right/bottom/left` (CSS box model 1/2/3/4-value syntax), `border` → width/style/color per side, `background` → color/image, `font` → style/weight/size/line-height/family.
2. Color properties → `normalizeColor()` — converts named colors (150 entries), hex (3/4/6/8 digit), HSL, RGB all to `rgba(r, g, b, a)` canonical form.
3. Size properties → `normalizeUnit()` — converts `em`/`rem`/`%`/`vw`/`vh`/`pt`/`cm` to `px` using context snapshot (parent font size, viewport dimensions). Values are rounded to `config.normalization.rounding.decimals` (2) decimal places.
4. `font-family` → `normalizeFont()` — strips quotes, lowercases, applies canonical casing via alias map (e.g., `arial` → `Arial`), preserves generic families.
5. Results are cached in a dual LRU cache: absolute cache (1000 entries) for context-independent values, relative cache (500 entries) for context-dependent values.

**Tolerance comparison:** After normalization, each property is compared. If values differ, tolerance strategies are checked: color properties use per-channel delta (`|r1-r2| ≤ tolerance.color`), size properties use pixel delta, opacity uses float delta. Only differences exceeding tolerance are reported.

**Severity classification:**
- **Critical:** Property is in `config.comparison.severity.critical` list (`display`, `visibility`, `position`, `z-index`), OR passes layout-breaking heuristic (display none toggle, position change to/from absolute/fixed, width/height >50% delta).
- **High:** Property is in `config.comparison.severity.high` list, OR high visual impact (opacity delta >0.3, luminance contrast delta >0.4 for color properties, font-size >25% delta).
- **Medium:** Property is in `config.comparison.severity.medium` list, OR any layout category property.
- **Low:** Everything else.

**Cascade suppression:** After all elements are diffed, `#suppressInheritedCascades()` in `comparison-modes.js` builds a map of changed-element **relative** HPIDs (via `baselineElement.hpid`). For each element, checks if any ancestor's relative HPID is a prefix of its relative HPID and has the same base→compare change on an inheritable CSS property (`color`, `font-size`, `font-weight`, `visibility`, `text-decoration`, etc. — 28 properties in the `CSS_INHERITABLE` set). If so, the child's diff is removed from the result (but preserved in `suppressedDiffs` for debugging). `currentColor`-derived properties (border colors) are also suppressed if the ancestor's `color` change matches. This prevents the common false-positive pattern where changing a parent's `color` creates diff entries on every descendant.

### IndexedDB Persistence Layer

**Database:** `ui_comparison_db`, version 7.

**Object Stores:**

| Store | Key | Indexes | Content |
|---|---|---|---|
| `reports` | `id` | `by_timestamp`, `by_url`, `by_url_ts` | Report metadata (no elements) |
| `elements` | `reportId` | — | `{ reportId, data: Element[] }` |
| `comparisons` | `id` | `by_pair` (unique), `by_timestamp`, `by_baseline`, `by_compare`, `by_triple` | Comparison metadata |
| `comparison_diffs` | `comparisonId` | — | `{ comparisonId, results: DiffResult[] }` |
| `comparison_summary` | `comparisonId` | `by_timestamp` | Lightweight summary for cache hits |
| `visual_blobs` | `key` | `by_comparisonId`, `by_timestamp` | Screenshot blob data |
| `visual_keyframes` | `id` | `by_session` | Keyframe metadata |
| `visual_element_rects` | `id` | `by_session`, `by_session_element` | Element rect records |
| `operation_log` | `id` | `by_status`, `by_timestamp` | WAL entries |

**Write-Ahead Log (WAL):** Every write operation follows this sequence:
1. Write a `PENDING` entry to `operation_log` with the operation type and full payload.
2. Execute the actual write (report save, comparison save).
3. Delete the WAL entry (marking it complete).

On renderer startup, `initializeApp()` in `report-manager.js` calls `storage.applyPendingOperations()`, which scans `PENDING` WAL entries. **`SAVE_REPORT`** and **`SAVE_COMPARISON`** are replayed (each entry tracks `replayCount`; attempts stop after **3** failures, the entry is marked `FAILED`, and a `storage-degraded` event with reason **`WAL_REPLAY_EXHAUSTED`** is dispatched — `app.js` shows `SystemBanner.warning` for that case). **`SAVE_VISUAL_BLOB`** entries are never replayed (immediately marked `FAILED`) because binary payload may be missing after a crash. Other unknown operation types are failed the same way.

**Why WAL, not just write-and-hope:** IndexedDB transactions can fail or be torn if the app crashes mid-flight, quota is exceeded, or the DB is blocked. Without WAL, a crash between writing report metadata and element blobs could leave inconsistent rows. WAL records intent first; successful completion removes the entry. Replay on next launch recovers **report** and **comparison** writes when possible; when replay is unsafe or exhausted, the UI is notified instead of silently dropping data.

**Circuit Breaker:** The `IDBRepository` tracks consecutive write failures. After `CIRCUIT_BREAKER_LIMIT` (3) consecutive failures, the circuit opens: all subsequent writes are rejected immediately with an error. This prevents a cascade where repeated write failures (e.g., quota exceeded) cause the write queue to back up indefinitely, consuming memory. The circuit breaker dispatches a `storage-degraded` event (without `WAL_REPLAY_EXHAUSTED` in the detail), which `app.js` maps to `SystemBanner.error` (“Storage failure — too many consecutive write errors…”).

**Eviction:** Reports are capped at `config.storage.maxReports` (50). When saving a new report would exceed the cap, the oldest reports (by timestamp index) are deleted in the same transaction. Comparisons are capped at `MAX_COMPARISONS` (20). Duplicate pair-key comparisons (same baseline+compare+mode) replace the existing one.

### Electron IPC Contract Layer

Every IPC handler is registered in `src/main/ipc-handlers.js`. Every handler exposed to the renderer is defined in `src/main/preload.js` via `contextBridge.exposeInMainWorld`.

| Channel Name | Direction | Handler (Main) | Renderer API | Input Shape | Output Shape |
|---|---|---|---|---|---|
| `START_COMPARISON` | invoke | `_registerComparisonHandlers` | `electronAPI.startComparison(params)` | `{ baselineId, compareId, mode, baselineUrl, compareUrl, baselineElements[], compareElements[], includeScreenshots }` | `{ success, result \| error }` |
| `EXTRACT_ELEMENTS` | invoke | `_registerExtractionHandlers` | `electronAPI.extractElements(params)` | `{ url, options: { filters?, browserType? } }` | `{ success, report \| error }` |
| `EXPORT_HTML` | invoke | `_registerFileHandlers` | `electronAPI.exportHTML(params)` | `{ htmlContent, filename }` | `{ success, filePath \| reason \| error }` |
| `EXPORT_FILE` | invoke | `_registerFileHandlers` | `electronAPI.exportFile(params)` | `{ data, filename, format }` | `{ success, filePath \| reason \| error }` |
| `IMPORT_FILE` | invoke | `_registerFileHandlers` | `electronAPI.importFile()` | (none — opens native dialog) | `{ success, content, ext, filename \| reason \| error }` |
| `OPEN_REPORT` | invoke | `_registerFileHandlers` | `electronAPI.openReport(params)` | `{ htmlContent }` | `{ success \| error }` |
| `REGISTER_BLOB` | invoke | `_registerBlobHandlers` | `electronAPI.registerBlob(params)` | `{ blobId, base64, mimeType }` | `{ success \| error }` |
| `UNREGISTER_BLOBS_BY_COMPARISON` | invoke | `_registerBlobHandlers` | `electronAPI.unregisterBlobsByComparison(id)` | `comparisonId` (string) | `{ success, removed }` |
| `GET_VERSION` | invoke | `_registerMetaHandlers` | `electronAPI.getVersion()` | (none) | version string |
| `GET_PERF_METRICS` | invoke | `_registerMetaHandlers` | `electronAPI.getPerfMetrics()` | (none) | `{ success, metrics, timestamp }` |
| `COMPARISON_PROGRESS` | push (main→renderer) | `_pushToWindow` | `electronAPI.onComparisonProgress(cb)` | — | `{ label, pct }` |
| `EXTRACTION_PROGRESS` | push (main→renderer) | `_pushToWindow` | `electronAPI.onExtractionProgress(cb)` | — | `{ label, pct }` |
| `SET_WINDOW_TITLE` | send (renderer→main) | `ipcMain.on` in `index.js` | `electronAPI.setWindowTitle(title)` | `title` (string) | — |
| `SHOW_CONTEXT_MENU` | send (renderer→main) | `ipcMain.on` in `index.js` | `electronAPI.showContextMenu(payload)` | `{ reportId }` | — |
| `CONTEXT_ACTION` | push (main→renderer) | `webContents.send` from context menu | `electronAPI.onContextAction(cb)` | — | `{ action, reportId, format? }` |

Channel string values are defined in `src/main/ipc-channels.js` and must stay aligned across `ipc-handlers.js`, `preload.js`, and any `ipcMain.on` / `send` usage in `index.js`. Note: `SHOW_CONTEXT_MENU` and `CONTEXT_ACTION` use lowercase hyphenated runtime strings (`show-context-menu`, `context-action`) while other channels use `SCREAMING_SNAKE` names matching their constant values.

Renderer subscriptions: `report-manager.js` registers `onContextAction` during `initializeApp()` to connect menu actions to baseline/compare selection, export, and delete.

### Renderer UI and client state

**Bridge hard fail:** If `window.electronAPI` is missing (misconfigured preload), `app.js` replaces the body with a fatal message and throws — the app does not run half-connected.

**State (`src/renderer/state.js`):** Single store with `dispatch` / `subscribe` / `getState`. Notable actions include `REPORTS_LOADED`, `REPORT_DELETED`, `EXTRACTION_PROGRESS`, `COMPARISON_STARTED` / `COMPARISON_PROGRESS` / `COMPARISON_COMPLETE` / `COMPARISON_ERROR`, `BASELINE_SELECTED`, `COMPARE_SELECTED`, `MODE_CHANGED`, `RESET_COMPARISON`, `DISMISS_ERROR` (resets phase while preserving reports and selections), `FILTERS_UPDATED`, and export lifecycle actions. `phase` drives window title updates via `electronAPI.setWindowTitle` in the `subscribe` callback in `app.js`.

**Toolbar and shell:** `app-shell.js` drives the Extract / Compare accordion, breadcrumb (including “Results” when `phase === 'done'`), and left panel collapse (`#panel-toggle-btn`). `status-bar.js` shows phase and report count.

**Sidebar list:** `report-list.js` virtual-scrolls saved reports with **group by** (none / host / date / environment), **sort by** (date / elements / name), **density** toggle (compact 44px, default 64px, comfortable 80px), and **search** (`#search-reports`, debounced). Right-click (when available) calls `electronAPI.showContextMenu({ reportId })`; the native menu sends actions back through `electronAPI.onContextAction`, handled in `initializeApp()` to set baseline/compare, export JSON/HTML, or delete.

**Bulk actions:** Export all reports (`#export-all-btn` + `#export-all-format`) and delete all (`#delete-all-btn` in overflow menu) live in the sidebar card.

**Compare UX:** Segmented **dynamic** vs **static** mode, **Visual Diff** checkbox (`#visual-diff-toggle` → `includeScreenshots`), per-slot **Import file** inputs.

**Command palette and shortcuts (`app.js`):** **Ctrl+K** / **⌘K** toggles the palette. With focus outside inputs: **E** / **C** switch sections, **/** focuses search, **Escape** clears search text and re-renders the list. **Ctrl+Shift+D** (Cmd not used for diagnostics) opens a performance overlay fed by `getPerfMetrics()`. **Enter** dismisses error phase when not in an input.

**Token System:** `src/renderer/styles/tokens.css` defines CSS custom properties for colors (primary, neutral, semantic), spacing (4px base scale), typography (Inter + JetBrains Mono), border-radius, shadows, and z-index layers. Component styles are expected to use these tokens.

**CSS Grid Shell:** `src/renderer/styles/shell.css` defines the app layout as a CSS Grid (toolbar, system banner slot, main content, status bar; sidebar + main column).

**Result Panel:** `src/renderer/components/result-panel.js` renders comparison results (match rate, coverage, severity, unmatched sections, exports / full report).

## Getting Started

### Prerequisites

- **Node.js** 18+ (LTS recommended)
- **Windows 10+**, **macOS 12+**, or **Linux** (Ubuntu 20.04+)
- **PLAYWRIGHT_BROWSERS_PATH** environment variable set to a directory where Playwright browser binaries will be stored

### Install

```bash
git clone <repo-url> ui-comparison-desktop
cd ui-comparison-desktop
npm install
```

### Install Playwright Browsers

```bash
# Set the browser path (persist this in your shell profile)
# Windows (PowerShell):
$env:PLAYWRIGHT_BROWSERS_PATH = "C:\playwright-browsers"
# macOS/Linux:
export PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers

# Install browser engines
npm run install:browsers
```

### Run in Development

```bash
npm start
```

This runs three processes concurrently:
1. `webpack --watch` for the main process bundle
2. `webpack --watch` for the renderer bundle (copies HTML + CSS on emit)
3. `electron .` launches the app

`npm start` does **not** build the extractor bundle. You must build it separately before extraction will work (see next section). Alternatively, run `npm run build` once before your first `npm start` — it builds all three bundles.

DevTools: Press `Ctrl+Shift+I` (Windows/Linux) or `Cmd+Option+I` (macOS).

### Build the Extractor Bundle

The extractor bundle must be built at least once before extraction will work:

```bash
npm run build:extractor
```

This compiles `src/core/extraction/extractor.js` into `dist/extractor-bundle.js` as a UMD module exposed as `window.__uiCompare`.

### Build for Production

```bash
npm run build
```

The `prebuild` script runs `scripts/check-env.js`: `PLAYWRIGHT_BROWSERS_PATH` must be set and must contain a Playwright `chromium` directory (run `npx playwright install chromium` or `npm run install:browsers` if needed).

### Package for Distribution

```bash
# Requires PLAYWRIGHT_BROWSERS_PATH to be set (browsers are bundled into the installer)
npm run dist       # electron-builder for the current host OS
npm run dist:win   # Windows NSIS installer
npm run dist:mac   # macOS DMG
```

Installers and artifacts are written under `dist-installer/` (see `electron-builder.config.js`).

### Smoke Test

```bash
npm run smoke-test
```

Verifies the extractor bundle exists and `app.getVersion()` returns a valid string.

## Development Workflows

### Adding a New IPC Handler

**Constraint:** The handler must be registered in main, exposed in preload, and consumed in renderer. All three files must use the same channel name constant.

1. **`src/main/ipc-channels.js`** — Add the channel name constant:
   ```javascript
   MY_NEW_CHANNEL: 'MY_NEW_CHANNEL',
   ```

2. **`src/main/ipc-handlers.js`** — Add the handler inside a registration function (or create a new one), then call it from `registerIpcHandlers`:
   ```javascript
   ipcMain.handle(CH.MY_NEW_CHANNEL, async (event, params) => {
     // handler logic — this runs in main process (Node.js)
     return { success: true, data: ... };
   });
   ```

3. **`src/main/preload.js`** — Expose in the context bridge:
   ```javascript
   myNewMethod: (params) => ipcRenderer.invoke(CH.MY_NEW_CHANNEL, params),
   ```

4. **Renderer code** — Call via `window.electronAPI.myNewMethod(params)`.

**Constraint:** The handler in main must never import from `src/renderer/` or call IndexedDB. The renderer must never import from `src/main/`.

### Adding a New CSS Property to the Diff Engine

1. **`src/config/defaults.js`** — Add the property to `extraction.cssProperties`:
   ```javascript
   cssProperties: [
     // existing...
     'my-new-property',
   ],
   ```

2. **`src/config/defaults.js`** — Assign it to a severity tier in `comparison.severity`:
   ```javascript
   severity: {
     critical: [...],
     high: [..., 'my-new-property'],  // or medium/critical
   }
   ```

3. **`src/config/defaults.js`** — Assign it to a property category in `comparison.propertyCategories`:
   ```javascript
   propertyCategories: {
     visual: [..., 'my-new-property'],
   }
   ```

4. If the property is a color, add it to `COLOR_PROPERTIES` in `src/core/normalization/normalizer-engine.js`. If it's a size, add to `SIZE_PROPERTIES`.

5. If the property should be included in dynamic mode, add it to `comparison.modes.dynamic.compareProperties`.

**Constraint:** Do not add shorthand properties (e.g., `border`) to `cssProperties` — add their longhands instead. The shorthand expander in `normalizer-engine.js` handles expansion during comparison, but extraction reads `getComputedStyle` which already returns resolved longhands.

### Adding a New UI Component

1. Create `src/renderer/components/my-component.js`.
2. Use the token system — reference `var(--color-*)`, `var(--space-*)`, etc. from `tokens.css`.
3. Add CSS to the appropriate stylesheet in `src/renderer/styles/` (or create a new one and link it in `index.html`).
4. Export a factory function: `export function createMyComponent(containerEl) { ... }`.
5. Import and instantiate in `src/renderer/app.js` inside the `DOMContentLoaded` handler.

**Constraint:** Components must not import from `src/main/`. They must not call `ipcRenderer` directly — use `window.electronAPI` methods only. Avoid importing heavy `src/core/comparison/` or `src/core/extraction/` modules into presentational components; keep those in `application/` or main process. (Application workflows may import narrow `@core` helpers such as `url-compatibility.js`.)

### Extending the Matching Pipeline with a New Phase

1. **`src/config/defaults.js`** — Add a strategy entry:
   ```javascript
   strategies: [
     // existing...
     { id: 'my-strategy', confidence: 0.88, enabled: true, label: 'My strategy…' },
   ]
   ```

2. **`src/core/comparison/matcher.js`** — Add a classifier builder:
   ```javascript
   function buildMyStrategyClassifier(cmpIdxs, usedCompare, baseline, compareElements, matchConfig, strategy) {
     const map = buildMultiMap(compareElements, cmpIdxs, el => /* your key function */);
     return (bi) => {
       const key = /* extract key from baseline[bi] */;
       const res = resolveFromMultiMap(map.get(key), strategy.confidence, usedCompare, matchConfig.minMatchThreshold);
       // return { kind: 'match', match: ... } or { kind: 'orphan' }
     };
   }
   ```

3. Register in `LEGACY_CLASSIFIER_BUILDERS`:
   ```javascript
   'my-strategy': (cmpIdxs, usedCompare, baseline, cmpEls, matchConfig, strategy) =>
     buildMyStrategyClassifier(cmpIdxs, usedCompare, baseline, cmpEls, matchConfig, strategy),
   ```

**Constraint:** Strategies are run in descending confidence order during Phase 3. A strategy must never modify the `usedBaseline` set — only `usedCompare` — because baseline iteration order is controlled by the caller. The classifier function receives a single baseline index and must return `{ kind: 'match' | 'ambiguous' | 'orphan' }`.

## Debugging Guide

### IPC Message Not Received

**What to check first:** Open DevTools in the Electron window. Check the console for `window.electronAPI` — if it's `undefined`, the preload script path is wrong in `BrowserWindow.webPreferences.preload`. In `createMainWindow()` (`src/main/index.js`), confirm `preload: path.join(__dirname, 'preload.js')` — after webpack, `__dirname` for the main bundle is `dist/`, so this must resolve to `dist/preload.js`.

**Common root cause:** The preload entry in `webpack.main.config.js` compiles to `dist/preload.js`, but the `BrowserWindow` must load that same file. If you rename or move outputs, this path breaks silently — the window opens but `electronAPI` is `undefined`.

**Verification:** In the terminal where `npm start` runs, look for `registerIpcHandlers` log. In renderer DevTools, run `Object.keys(window.electronAPI)` — you should see the invoke/send APIs and progress/context subscription helpers (e.g. `startComparison`, `extractElements`, `onComparisonProgress`, `setWindowTitle`, `showContextMenu`, `onContextAction`).

### IndexedDB: circuit breaker or WAL replay

**Circuit breaker (`reason: 'CIRCUIT_OPEN'`):** Symptom is the red banner: “Storage failure — too many consecutive write errors.” After 3 consecutive write failures, new writes are rejected until restart.

**WAL replay exhausted (`reason: 'WAL_REPLAY_EXHAUSTED'`):** Symptom is the yellow/warning banner from `SystemBanner.warning` about queued writes that could not be replayed.

**What to check first:** DevTools → Application → IndexedDB → `ui_comparison_db`. Run `navigator.storage.estimate()` for quota. Inspect `operation_log` for `PENDING` / `FAILED` rows.

**Recovery:** Restart the app (resets the circuit counter on a fresh repository instance). If quota is the issue, delete reports in-app or clear the database from DevTools.

### Playwright Capture Failing

**Symptom:** Extraction returns `{ success: false, error: "Extractor bundle not found" }`.

**What to check first:** Run `npm run build:extractor`. Verify `dist/extractor-bundle.js` exists. The playwright-manager searches three candidate paths: `process.resourcesPath`, `__dirname`, and `process.cwd()/dist/`.

**Symptom:** Extraction succeeds but returns 0 elements.

**What to check:** The page may require authentication (Playwright runs in a fresh context with no cookies). The page may use heavy client-side rendering that hasn't completed within the readiness gate timeout. Check the main process logs for `[WAIT-DIAG]` — this logs `readyState`, `totalElements`, `containerCount`, and `descendantCount`. If `totalElements` is small, the page hasn't rendered.

### Element Pairing Producing Wrong Matches

**Symptom:** Match rate is low (<70%) or elements are paired with incorrect counterparts.

**What to check:** Look at the match strategies used. In the comparison result, each matched element has `strategy` and `confidence` fields. If most matches come from `position` (confidence ~0.30), the pages likely have very different DOM structures. Add `data-testid` attributes to key elements — Phase 0 uses these with confidence 1.00.

**Root cause usually:** Pages extracted from different page paths (URL compatibility check should have caught this), or one page has a modal/overlay that shifts all elements. Check `urlCompatibility.classification` in the result.

### Visual Scroll Rendering Artifacts

**Symptom:** Report list shows blank gaps or duplicate cards.

**What to check:** The virtual scroll implementation in `report-list.js` calculates row offsets based on density height. If the density was changed but `_buildLayout()` wasn't called, offsets are stale. Trigger a re-render by typing in the search box (even a space then backspace).

**Root cause usually:** The `ResizeObserver` was disconnected or the component was destroyed without cleanup (call `destroy()` on the old list before creating a new one). Another cause: if the viewport element's `clientHeight` returns 0 (e.g., because a parent has `display: none` during a section switch), the render pass calculates an empty visible range and skips all rows.

## Key Engineering Decisions

### Why Electron Over a Web App

The system requires Playwright to automate browser navigation, page freezing, and CDP screenshot capture. Playwright needs Node.js and launches browser processes — capabilities that are impossible in a web app sandbox. Electron provides both the Node.js main process (for Playwright) and a Chromium renderer (for the UI and IndexedDB), with a controlled IPC bridge between them. [Inferred from implementation]

### Why IndexedDB Over SQLite

Although `better-sqlite3` is listed as a dependency, the actual storage layer uses IndexedDB exclusively. IndexedDB runs natively in the Chromium renderer process with no native module compilation, no file path management, and no cross-process serialization for reads. Since the renderer already needs to display data, keeping storage in-process eliminates an IPC round-trip for every report load. `better-sqlite3` may be reserved for future use or metadata caching in the main process. [Inferred from implementation — better-sqlite3 is in dependencies but no SQLite usage was found in any source file]

### Why Write-Ahead Log

IndexedDB provides transactional writes, but a crash between two related transactions (e.g., writing report metadata and element data) can leave the database in an inconsistent state. The WAL pattern records intent before action and cleans up after success, providing crash-recovery semantics that IndexedDB's single-store transactions don't inherently guarantee for multi-store operations. The WAL explicitly does not auto-replay on recovery — it marks and reports — because between crash and recovery, the eviction policy may have changed the cap, a duplicate report may have been saved, or the storage quota may have shrunk. Auto-replaying in such conditions could cause data loss. [Inferred from implementation]

### Why HPID Strings for Identity

CSS selectors and XPaths are fragile — a class name change or an inserted wrapper div invalidates them. HPIDs encode structural position (path from root as sibling ordinals), which is stable across CSS-only changes and can be suffix-matched to recover from wrapper insertion. The dual HPID scheme (relative + absolute) allows filtered extractions to have compact local identifiers while maintaining a global anchor for cross-extraction matching. The shadow DOM sentinel ensures that elements inside shadow trees get globally unique HPIDs without needing to enumerate all shadow roots. [Inferred from implementation]

### Why Multi-Phase Matching Instead of Single-Pass Diff

A single-pass diff (like Unix `diff`) only works on sequences of identical types. DOM elements have multiple identity axes (position, attributes, selectors, visual location) with different reliability levels. The multi-phase approach allows high-confidence strategies (test attributes, sequence alignment) to claim matches first, removing them from the candidate pool before lower-confidence strategies run. This prevents a situation where a low-confidence positional match "steals" an element that would have been definitively matched by its `data-testid` in a later pass. The confidence values are attached to each match for audit trails. [Inferred from implementation]

### Why Virtual Scroll

The report list can contain up to 50 reports, each with a card containing action buttons, export dropdowns, and metadata. Rendering all cards into the DOM causes layout thrashing when the list is re-rendered (after extraction, deletion, or search). Virtual scroll renders only the ~10 visible cards plus 3 overscan, keeping DOM node count constant regardless of report count. This is especially important because report list re-renders happen during comparison (state changes trigger subscriber notifications). [Inferred from implementation]

### Why Cascade Suppression

Without cascade suppression, changing a parent's `color` property creates diff entries on every descendant that inherits `color`, and every element whose `border-color` defaults to `currentColor`. For a page with 300 elements, a single intentional color change could generate 100+ false-positive diff entries, making the report unusable. The BFS suppression walk in `report-transformer.js` and the inline suppression in `comparison-modes.js` handle this at two levels: the comparison mode removes diffs from the result array (preserving them in `suppressedDiffs`), and the report transformer performs a deeper ancestor-walk with proportionality error analysis for dimensional changes. [Inferred from implementation]

---

## Critical Risk Assessment

**The subsystem with the highest gap between implementation complexity and documentation coverage is `src/core/export/export-utils/report-transformer.js`.** This 729-line file contains the BFS cascade suppression algorithm, content intelligence (Levenshtein-based text divergence scoring, geometric proportionality error analysis for width/height changes), impact score computation, severity rebucketing, and deduplication logic. It transforms raw comparison results into the grouped report structure consumed by the HTML exporter. None of these algorithms were documented in the existing README — no mention of the Levenshtein distance, the proportionality error formula, the corroboration scores, or the narrative badge classification.

**The single most dangerous thing a new engineer could do:** Modify the `runBFSSuppression()` function's ancestor-walk logic (specifically the `walkUpToNearestDiffAncestor` function or the `INHERITABLE_PROPS` / `LAYOUT_PROPAGATION_PROPS` sets) without understanding that it uses *absolute* HPIDs for ancestry detection but the rest of the system uses *relative* HPIDs for display. If someone swapped to relative HPIDs in the suppression walk (because they "look simpler" or because they're used everywhere else), suppression would silently break for filtered extractions — where relative HPIDs start at `1` for every filter root, making unrelated elements appear to be ancestors of each other. The result: legitimate diffs would be suppressed, the impact score would improve, and the HTML report would show fewer issues than actually exist. This corruption would not produce any error, warning, or test failure — it would simply make reports look "clean" when they're not.
