# UI Comparison Desktop — System Reference

Audience: any engineer debugging or extending a specific subsystem. Every
claim is anchored to a file path and function/class/constant name. Where the
source itself is non-deterministic at a point, that point is marked
**[STILL AMBIGUOUS]** with the source-level evidence for why.

The companion `README.md` covers onboarding (prerequisites, install, build).
This document covers the runtime contracts.

## Table of Contents

1. [Architecture & Layer Rules](#1-architecture--layer-rules)
2. [Electron Context Map](#2-electron-context-map)
3. [IPC Registry](#3-ipc-registry)
4. [IndexedDB Schema](#4-indexeddb-schema)
5. [WAL & Circuit Breaker State Machines](#5-wal--circuit-breaker-state-machines)
6. [Element Capture Pipeline](#6-element-capture-pipeline)
7. [Element Matching Pipeline](#7-element-matching-pipeline)
8. [CSS Diff Engine](#8-css-diff-engine)
9. [Renderer UI Architecture](#9-renderer-ui-architecture)
10. [Persistence Path for a Comparison](#10-persistence-path-for-a-comparison)
11. [Build Pipeline](#11-build-pipeline)
12. [Failure Mode Catalog](#12-failure-mode-catalog)
13. [Browser Detection & Capability Profiles](#13-browser-detection--capability-profiles)
14. [Bulk Pipeline](#14-bulk-pipeline)
15. [CI / Release Pipeline](#15-ci--release-pipeline)
16. [SauceLabs Pipeline](#16-saucelabs-pipeline)
17. [Tolerance Profile System](#17-tolerance-profile-system)
18. [Theme System (Light / Dark)](#18-theme-system-light--dark)

---

## 1. Architecture & Layer Rules

```
┌───────────────────────────────────────────────────────────────────────────┐
│ presentation   src/renderer/components/, src/renderer/styles/, index.html │
│                ─────────────────────────────────────────────────────────  │
│ application    src/renderer/application/, src/renderer/state.js,          │
│                src/renderer/app.js, src/renderer/ui.js                    │
│                ─────────────────────────────────────────────────────────  │
│ core           src/core/**            infrastructure  src/infrastructure/**│
│                                                                            │
│ main process   src/main/** (own runtime context, not part of layer stack) │
│ in-page bundle src/core/extraction/** (compiled to dist/extractor-bundle) │
└───────────────────────────────────────────────────────────────────────────┘
```

**Rule.** A module in layer L imports only from layers strictly below L plus
peers in L. `core/` and `infrastructure/` are peers; the only intentional
crossing is `core/*` reading `infrastructure/logger.js`. `core/` may not
import Electron, the renderer DOM, anything under `src/renderer/`, or anything
under `src/main/`. `infrastructure/` may not import from `application/`,
`presentation/`, or `src/main/`. Renderer components reach native capabilities
exclusively through `window.electronAPI` (exposed by
`src/main/preload.js:14`).

`src/main/` is a separate runtime; it freely `require()`s from `src/core/**`
(e.g. `bulk-runner.js` imports `playwright-manager`; the latter loads
`core/comparison/comparator.js`, `core/comparison/keyframe-grouper.js`,
`core/comparison/url-compatibility.js`, and the capability profiles from
`config/`). It must **not** import from `src/renderer/` or
`src/infrastructure/`.

**Enforcement.** There is no automated rule check (no `madge` rule in CI, no
ESLint `import/no-restricted-paths`). Enforcement is editorial, supported by
the webpack alias map (`@core`, `@config`, `@infra` in all three webpack
configs) and the `target` differentiation: `webpack.main.config.js` sets
`target: 'electron-main'`; `webpack.renderer.config.js` and
`webpack.extractor.config.js` set `target: 'web'`. A boundary violation will
typically surface as a webpack build failure (e.g. importing
`src/main/index.js` from a renderer module would fail to resolve `electron`
because `webpack.renderer.config.js` aliases `electron` to a stub).

**The renderer-side electron stub.** `src/renderer/stubs/electron.js`
intercepts any `import 'electron'` from renderer code so it cannot reach the
real module. Same pattern in
`src/core/extraction/_page_stubs_/electron.js` and
`.../electron-log.js` for the in-page bundle.

---

## 2. Electron Context Map

### Main (Node)

- **Files:** `src/main/index.js`, `src/main/ipc-handlers.js`, `src/main/playwright-manager.js`, `src/main/bulk-runner.js`, `src/main/saucelabs-manager.js`, `src/main/saucelabs-binary-manager.js`, `src/main/protocol-handler.js`, `src/main/resource-paths.js`, `src/main/ipc-channels.js`, `src/core/comparison/*.js`, `src/core/bulk/plan-validator.js` (loaded by the validator path), `src/config/defaults.js` (loaded via `index.js`).
- **Why it must run there:** Needs `app`, `BrowserWindow`, `protocol`, `ipcMain`, `dialog`, `Menu`, `os`, file system, `playwright`, `child_process.spawn` (saucectl), raw buffers. Sandboxed renderer cannot do any of this.
- **What breaks if moved:** Renderer cannot launch browsers (`chromium.launch` requires Node), cannot register custom protocols, cannot read `extractor-bundle.js` from disk, cannot probe host memory, cannot spawn saucectl child processes.

### Preload

- **Files:** `src/main/preload.js`.
- **Why it must run there:** Single allowed bridge between sandboxed renderer and main: `contextBridge.exposeInMainWorld('electronAPI', …)`. Runs in an isolated world with `contextIsolation: true` (`src/main/index.js`).
- **What breaks if moved:** Without preload, `window.electronAPI` is undefined and `src/renderer/app.js:68-84` shows the fatal banner and throws.

### Renderer (Chromium, sandboxed)

- **Files:** `src/renderer/**`, `src/infrastructure/**`, plus `src/core/bulk/extraction-key.js` (uses `crypto.subtle`, available in renderer) and `src/core/export/bulk-summary-exporter.js` (uses `xlsx` in the renderer bundle).
- **Why it must run there:** Owns the DOM, IndexedDB (`infrastructure/idb-repository.js` opens `indexedDB.open(DB_NAME, 10)`). `app.enableSandbox()` (`src/main/index.js:22`) plus `nodeIntegration:false`, `sandbox:true` (`src/main/index.js:282-285`).
- **What breaks if moved:** IndexedDB does not exist in main; SaaS workflows that touch DOM (`getComputedStyle`, `getBoundingClientRect`) only work here. `crypto.subtle.digest` for the extraction key would have to be re-implemented in main.

### In-page (target site)

- **Files:** `dist/extractor-bundle.js` (compiled from `src/core/extraction/**`) injected via `page.addScriptTag`.
- **Why it must run there:** Must execute inside the target page's JavaScript context to read live DOM and computed styles. Bundled UMD with `library.name='__uiCompare'` (`webpack.extractor.config.js`).
- **What breaks if moved:** If executed in the renderer instead, it sees the UI Comparison app DOM, not the target page.

---

## 3. IPC Registry

All channel constants live in `src/main/ipc-channels.js` and are imported as
`CH` everywhere. The preload exposes them under `window.electronAPI`
(`src/main/preload.js`).

### Channel: `START_COMPARISON`

- **Runtime string:** `START_COMPARISON`
- **Direction / method:** renderer → main, `invoke`
- **Renderer payload:** `{ baselineId, compareId, mode, baselineUrl, compareUrl, baselineElements, compareElements, includeScreenshots, browser:{ browserType, channel, executablePath }, tolerances?:{ color, size, opacity }, operationId, comparisonId? }`. The `browser` field is sourced from the renderer state's `selectedBrowser` (see §13). When omitted, screenshot phase defaults to `{ browserType: 'chromium', channel: null, executablePath: null }`. `comparisonId` defaults to `operationId` if not provided. `tolerances` is the resolved `comparison.defaultTolerances` triple — when `null`/omitted, the comparator falls back to the boot-time defaults from `config/defaults.js`. See §17.
- **Main behavior:** Calls `playwrightManager.runComparison`; returns `{ success:true, result }` or `{ success:false, error }` or `{ success:false, cancelled:true }` if `error.code==='CANCELLED'`. The result's `visualDiffs.devToolsWarnings` may include `{ kind:'screenshot-engine-fallback', from, to, reason }` when the WebKit→Chromium screenshot fallback was triggered.
- **Handler:** `ipc-handlers.js` → `_registerComparisonHandlers`
- **Producer:** —

### Channel: `EXTRACT_ELEMENTS`

- **Runtime string:** `EXTRACT_ELEMENTS`
- **Direction / method:** renderer → main, `invoke`
- **Renderer payload:** `{ url, options:{ filters?, browser?:{ browserType, channel, executablePath } }, operationId }`. `extract-workflow.js` always populates `options.browser` from the renderer's `selectedBrowser`; missing → defaults to `{ browserType:'chromium', channel:null, executablePath:null }`.
- **Main behavior:** Calls `playwrightManager.runExtraction`; returns `{ success:true, report }` / `{ success:false, error }` / `{ success:false, cancelled:true }`. Report is stamped with `report.engine` (the requested `browserType`) and `report.platform` (`process.platform`).
- **Handler:** `ipc-handlers.js` → `_registerExtractionHandlers`
- **Producer:** —

### Channel: `GET_AVAILABLE_BROWSERS`

- **Runtime string:** `GET_AVAILABLE_BROWSERS`
- **Direction / method:** renderer → main, `invoke`
- **Renderer payload:** `{ refresh?: boolean }` (default `false` — uses module-level cache; `true` forces re-detection).
- **Main behavior:** Lazily `require('./browser-detector')` and calls `detectBrowsers({ refresh })`. Returns `{ success:true, browsers, detectedAt }` or `{ success:false, error }`. `browsers[]` shape documented in §13.
- **Handler:** `ipc-handlers.js` → `_registerBrowserHandlers`
- **Producer:** —

### Channel: `GET_HOST_MEMORY`

- **Runtime string:** `GET_HOST_MEMORY`
- **Direction / method:** renderer → main, `invoke`
- **Renderer payload:** `()`
- **Main behavior:** Returns `{ totalMemMB, freeMemMB }` from `os.totalmem()` / `os.freemem()` (rounded to integers). No error path; always succeeds.
- **Handler:** `ipc-handlers.js` → `_registerBulkHandlers`
- **Producer:** —
- **Used by:** Bulk concurrency clamp (`bulk-workflow.js _hostTotalMemMB`, `bulk-panel.js _ensureHostMemory`). Memoised once per renderer session.

### Channel: `BULK_START_JOB`

- **Runtime string:** `BULK_START_JOB`
- **Direction / method:** renderer → main, `invoke`
- **Renderer payload:** `{ jobId, filename, pairs[], concurrency, hostCooldownMs, comparisonIdsByPairIndex }`. `pairs[i]` shape: `{ pairIndex, pairId, comparisonId, baselineUrl, compareUrl, mode, label, includeScreenshots, browser:{ browserType, channel, executablePath }, filterClass, filterId, filterTag, dedupedSides:{ baseline?:{ reportId }, compare?:{ reportId } } }`.
- **Main behavior:** Validates non-empty `pairs[]`, clamps `concurrency` to `[1, defaultsConfig.bulk.maxConcurrency=4]`, registers a job entry in `_bulkJobs` (with its own `opIds` Set, `pLimitInstance` slot, and `providedElements`/`providedWaiters` Maps for the dedup bridge), then **fires-and-forgets** `bulkRunner.runBulkJob(...)`. Returns synchronously: `{ success:true, jobId }` or `{ success:false, error }`. All real progress is reported on `BULK_PROGRESS` / `BULK_PAIR_COMPLETED` / `BULK_JOB_COMPLETE`.
- **Handler:** `ipc-handlers.js` → `_registerBulkHandlers`
- **Producer:** —

### Channel: `CANCEL_BULK_JOB`

- **Runtime string:** `CANCEL_BULK_JOB`
- **Direction / method:** renderer → main, `invoke`
- **Renderer payload:** `{ jobId }`
- **Main behavior:** Looks up the entry in `_bulkJobs`. If found: clears the `p-limit` queue (drops not-yet-dispatched pairs), flips every per-op `cancelled` flag in `_cancelRegistry`, and deletes the job entry (which causes `bulk-runner.js`'s `isMasterCancelled()` check `() => !_bulkJobs.has(jobId)` to return `true` for any in-flight pair). Returns `{ acknowledged: true }` regardless. Idempotent.
- **Handler:** `ipc-handlers.js` → `_registerBulkHandlers`
- **Producer:** —

### Channel: `BULK_PROVIDE_ELEMENTS`

- **Runtime string:** `BULK_PROVIDE_ELEMENTS`
- **Direction / method:** renderer → main, `invoke`
- **Renderer payload:** `{ jobId, pairIndex:number, side:'baseline'|'compare', elements:Array }`
- **Main behavior:** Looks up the bulk job in `_bulkJobs`; rejects with `{ accepted:false, error }` on bad shape or missing job. Stores the elements list under key `${pairIndex}:${side}` in `entry.providedElements`, then resolves any waiter currently parked in `entry.providedWaiters`. Returns `{ accepted:true }`.
- **Handler:** `ipc-handlers.js` → `_registerBulkHandlers`
- **Producer:** —
- **Used by:** Renderer's `_provideDedupedElementsToMain` after `BULK_START_JOB` returns success — for every pair whose `dedupedSides` has a hit, the renderer loads the cached report's elements via `storage.loadReportElements(...)` and pushes them to main, which lets `bulk-runner.js`'s `_awaitProvided('baseline'|'compare')` resolve instantly inside `_runPair`.

### Channel: `BULK_PROGRESS`

- **Runtime string:** `BULK_PROGRESS`
- **Direction / method:** main → renderer, `webContents.send`
- **Payload:** `{ jobId, pairIndex, phase: 'extracting-baseline'|'extracting-compare'|'matching'|'screenshots'|'persisting', label?, pct, operationId }`
- **Main behavior:** `bulk-runner.js` emits these via `pushPairProgress(...)` after every Playwright `onProgress` callback. The `persisting` phase is *renderer-synthesised* in `_runPersistingPhaseAnimation` (4 setTimeout ticks: 95→97→99→100 over 900 ms) — main never emits `'persisting'`.
- **Handler:** —
- **Producer:** `bulk-runner.js` (per pair, multiple per phase)

### Channel: `BULK_PAIR_COMPLETED`

- **Runtime string:** `BULK_PAIR_COMPLETED`
- **Direction / method:** main → renderer, `webContents.send`
- **Payload:** `{ jobId, pairIndex, status:'done'|'failed'|'cancelled', baselineReport?, compareReport?, comparisonResult?:slimResult, deduped?, error?, errorCode? }`. `errorCode` is one of: `CANCELLED`, `BROWSER_POLICY_BLOCKED`, `BROWSER_NOT_FOUND`, `TIMEOUT`, `CSP_BLOCKED`, `INCOMPATIBLE_URLS`, `STORAGE_DEGRADED`, `INTERRUPTED`, `UNKNOWN`. `deduped` is `'baseline'` / `'compare'` / `'both'` / `'none'`.
- **Main behavior:** Emitted exactly once per pair by `bulk-runner.js`, even on cancel/fail. Error messages run through `_sanitize` (collapse whitespace, slice 500 chars).
- **Handler:** —
- **Producer:** `bulk-runner.js _runPair`

### Channel: `BULK_JOB_COMPLETE`

- **Runtime string:** `BULK_JOB_COMPLETE`
- **Direction / method:** main → renderer, `webContents.send`
- **Payload:** `{ jobId, summary:{ total, succeeded, failed, cancelled, deduped }, durationMs, error? }`
- **Main behavior:** Emitted after `Promise.all(slotPromises)` resolves (or, in the catch branch of the dispatch wrapper, when `runBulkJob` itself threw). Always emitted exactly once per job.
- **Handler:** —
- **Producer:** `bulk-runner.js` (and the `.catch` of the dispatch wrapper inside `_registerBulkHandlers`)

### Channel: `EXPORT_HTML`

- **Runtime string:** `EXPORT_HTML`
- **Direction / method:** renderer → main, `invoke`
- **Renderer payload:** `{ htmlContent, filename }`
- **Main behavior:** `dialog.showSaveDialog` then `fs.promises.writeFile`. Returns `{ success, filePath }` / `{ success:false, reason:'cancelled' }` / `{ success:false, error }`. EACCES → "Permission denied", EBUSY → "File is in use".
- **Handler:** `ipc-handlers.js` → `_registerFileHandlers`
- **Producer:** —

### Channel: `EXPORT_FILE`

- **Runtime string:** `EXPORT_FILE`
- **Direction / method:** renderer → main, `invoke`
- **Renderer payload:** `{ data, filename, format }` (data: `Uint8Array` / `ArrayBuffer` / `number[]` / string)
- **Main behavior:** Save dialog + write. Same return shape as `EXPORT_HTML`. The bulk summary exporter (`bulk-summary-exporter.js`) hands back a `Uint8Array` and the renderer wraps it as `Array.from(uint8Array)` before invoke (because preload IPC structured-clones the argument).
- **Handler:** `ipc-handlers.js` → `_registerFileHandlers`
- **Producer:** —

### Channel: `PICK_DIRECTORY`

- **Runtime string:** `PICK_DIRECTORY`
- **Direction / method:** renderer → main, `invoke`
- **Renderer payload:** `{ title?: string }` (defaults to `'Choose folder for bulk export'`)
- **Main behavior:** Opens a native folder-picker dialog (`dialog.showOpenDialog` with `['openDirectory','createDirectory']`, `defaultPath: app.getPath('downloads')`). On success, adds the chosen path to the session-scoped `_approvedDirs` Set and returns `{ success:true, dirPath }`. On cancel: `{ success:false, reason:'cancelled' }`.
- **Handler:** `ipc-handlers.js` → `_registerFileHandlers`
- **Producer:** —
- **Used by:** Bulk-export file-per-pair flow (renderer picks output directory once, then writes N files via `EXPORT_FILE_TO_DIRECTORY`).

### Channel: `EXPORT_FILE_TO_DIRECTORY`

- **Runtime string:** `EXPORT_FILE_TO_DIRECTORY`
- **Direction / method:** renderer → main, `invoke`
- **Renderer payload:** `{ dirPath:string, filename:string, content:Uint8Array|ArrayBuffer|number[]|string, encoding?:string }`
- **Main behavior:** Validates `dirPath` is absolute and present in the session-scoped `_approvedDirs` Set (populated by `PICK_DIRECTORY`). Validates `filename` does not contain slashes or `..`. Writes `path.join(dirPath, filename)` via `fs.promises.writeFile`. Returns `{ success:true, filePath }` on success. Rejects with `{ success:false, error }` on unapproved dir, bad input, EACCES, EBUSY, ENOENT, or unknown write error.
- **Handler:** `ipc-handlers.js` → `_registerFileHandlers`
- **Producer:** —
- **Security note:** Defense-in-depth — only directories explicitly chosen by the user this session are writable. Prevents rogue renderer code from writing to arbitrary filesystem locations even if the sandbox or preload is compromised.

### Channel: `IMPORT_FILE`

- **Runtime string:** `IMPORT_FILE`
- **Direction / method:** renderer → main, `invoke`
- **Renderer payload:** `()` (no args)
- **Main behavior:** `dialog.showOpenDialog`, returns `{ success, content, ext, filename }`. xlsx returned as base64; json/csv as utf-8.
- **Handler:** `ipc-handlers.js` → `_registerFileHandlers`
- **Producer:** —

### Channel: `OPEN_REPORT`

- **Runtime string:** `OPEN_REPORT`
- **Direction / method:** renderer → main, `invoke`
- **Renderer payload:** `{ htmlContent }`
- **Main behavior:** Writes to `os.tmpdir()`, opens new sandboxed `BrowserWindow` (1400×900), unlinks tmp file on close.
- **Handler:** `ipc-handlers.js` → `_registerFileHandlers`
- **Producer:** —

### Channel: `REGISTER_BLOB`

- **Runtime string:** `REGISTER_BLOB`
- **Direction / method:** renderer → main, `invoke`
- **Renderer payload:** `{ blobId, base64, mimeType }`; `blobId` must match `^[^:]+:[^:]+$` (i.e. `comparisonId:keyframeId`)
- **Main behavior:** Inserts into `protocol-handler.js` LRU. Returns `{ success }`.
- **Handler:** `ipc-handlers.js` → `_registerBlobHandlers`
- **Producer:** —

### Channel: `UNREGISTER_BLOBS_BY_COMPARISON`

- **Runtime string:** `UNREGISTER_BLOBS_BY_COMPARISON`
- **Direction / method:** renderer → main, `invoke`
- **Renderer payload:** `comparisonId` (string)
- **Main behavior:** Deletes every key that startsWith `comparisonId:`. Returns `{ success, removed }`.
- **Handler:** `ipc-handlers.js` → `_registerBlobHandlers`
- **Producer:** —

### Channel: `GET_VERSION`

- **Runtime string:** `GET_VERSION`
- **Direction / method:** renderer → main, `invoke`
- **Renderer payload:** `()`
- **Main behavior:** Returns `app.getVersion()` (string).
- **Handler:** `ipc-handlers.js` → `_registerMetaHandlers`
- **Producer:** —

### Channel: `GET_PERF_METRICS`

- **Runtime string:** `GET_PERF_METRICS`
- **Direction / method:** renderer → main, `invoke`
- **Renderer payload:** `()`
- **Main behavior:** Returns `{ success:true, metrics, timestamp }` from `playwrightManager.getPerformanceSnapshot()`.
- **Handler:** `ipc-handlers.js` → `_registerMetaHandlers`
- **Producer:** —

### Channel: `CANCEL_OPERATION`

- **Runtime string:** `CANCEL_OPERATION`
- **Direction / method:** renderer → main, `invoke`
- **Renderer payload:** `{ operationId, kind }` (renderer sends `kind:'compare'\|'extract'`; main reads only `operationId`)
- **Main behavior:** Sets `_cancelRegistry.get(operationId).cancelled = true`. Returns `{ acknowledged: true }`.
- **Handler:** `ipc-handlers.js` → `_registerCancelHandlers`
- **Producer:** —

### Channel: `COMPARISON_PROGRESS`

- **Runtime string:** `COMPARISON_PROGRESS`
- **Direction / method:** main → renderer, `webContents.send`
- **Payload:** `{ label, pct, operationId }`
- **Main behavior:** Pushed during `runComparison`; consumer is `compare-workflow.js` (single-pair compare workflow only — bulk uses `BULK_PROGRESS`).
- **Handler:** —
- **Producer:** `ipc-handlers.js _registerComparisonHandlers` (via `_pushToWindow`)

### Channel: `EXTRACTION_PROGRESS`

- **Runtime string:** `EXTRACTION_PROGRESS`
- **Direction / method:** main → renderer, `webContents.send`
- **Payload:** `{ label, pct, operationId }`
- **Main behavior:** Pushed during `runExtraction` for the single-extract workflow. The bulk runner does **not** emit on this channel — it pipes per-pair extraction progress through `BULK_PROGRESS` instead.
- **Handler:** —
- **Producer:** `ipc-handlers.js _registerExtractionHandlers`

### Channel: `OPERATION_CANCELLED`

- **Runtime string:** `OPERATION_CANCELLED`
- **Direction / method:** main → renderer, `webContents.send`
- **Payload (would be):** `{ operationId, … }`
- **Main behavior:** **Dead code.** Channel constant defined; bridged by `preload.js` as `onOperationCancelled`. No `webContents.send(IPC.OPERATION_CANCELLED, …)` exists anywhere in `src/main/`. Cancellation is signaled by the invoke return `{ cancelled:true }` and reconciled in `compare-workflow.js` / `report-manager.js`.
- **Handler:** —
- **Producer:** **none**

### Channel: `SET_WINDOW_TITLE`

- **Runtime string:** `SET_WINDOW_TITLE`
- **Direction / method:** renderer → main, `send` (one-way)
- **Renderer payload:** string title
- **Main behavior:** `BrowserWindow.fromWebContents(event.sender)?.setTitle(title)`. Listener registered once (idempotent guard at `index.js:155-161`).
- **Handler:** `index.js`
- **Producer:** —

### Channel: `SHOW_CONTEXT_MENU`

- **Runtime string:** `show-context-menu`
- **Direction / method:** renderer → main, `send`
- **Renderer payload:** One of three shapes — the listener in `index.js:163-198` branches in this priority order:
  1. `{ bulkJobId:string }` — produces a single "Delete this bulk run" item → `CONTEXT_ACTION { action:'deleteBulkJob', bulkJobId }`.
  2. `{ multiSelect:true, count:number }` — produces a single "Delete N report(s)" item → `CONTEXT_ACTION { action:'deleteSelected' }`.
  3. `{ reportId:string }` — produces the standard 7-item report menu (Set as Baseline, Set as Compare, separator, Export as JSON/Excel/CSV, separator, Delete).
- **Main behavior:** Builds a native `Menu` from the appropriate template and `popup()`s. Item clicks call `event.sender.send(CH.CONTEXT_ACTION, payload)`.
- **Handler:** `index.js`
- **Producer:** —

### Channel: `CONTEXT_ACTION`

- **Runtime string:** `context-action`
- **Direction / method:** main → renderer, `webContents.send`
- **Payload:** `{ action: 'setBaseline'|'compare'|'export'|'delete'|'deleteSelected'|'deleteBulkJob', format?:'json'|'excel'|'csv', reportId?, bulkJobId? }`
- **Main behavior:** Pushed when context menu item clicked.
- **Handler:** —
- **Producer:** `index.js` (per item click)

### Channel: `MENU_ACTION`

- **Runtime string:** `menu-action`
- **Direction / method:** main → renderer, `webContents.send`
- **Payload:** string action (currently only `'toggle-sidebar'`)
- **Main behavior:** Pushed by application-menu items.
- **Handler:** —
- **Producer:** `index.js`

### Channel: `APP_NOTIFICATION`

- **Runtime string:** `APP_NOTIFICATION`
- **Direction / method:** main → renderer, `webContents.send`
- **Payload (would be):** `{ id?, tier, title, body?, durationMs?, dedupeKey? }`
- **Main behavior:** **Dead code.** Bridged by `preload.js`, consumed by `app.js:88-101` to forward into `dispatchEnqueue`. No producer in `src/main/`.
- **Handler:** —
- **Producer:** **none**

### Channel: `SAUCE_VALIDATE_CREDENTIALS`

- **Runtime string:** `SAUCE_VALIDATE_CREDENTIALS`
- **Direction / method:** renderer → main, `invoke`
- **Renderer payload:** `{ username, accessKey, region }` — region is one of `us-west-1`, `us-east-4`, `eu-central-1`.
- **Main behavior:** (1) Resolves the `saucectl` binary via `sauceBinaryManager.resolveBinaryPath()` (downloaded → bundled → PATH); returns error if not found. (2) Fires background `runUpdateCheck` against the compatible range (`>=0.200.0 <1.0.0`). (3) Calls `sauceManager.validateCredentials` which hits `GET /rest/v1/{username}/activity` on the region's API host. Returns `{ success:true, username, region }` or `{ success:false, error }`.
- **Handler:** `ipc-handlers.js` → `_registerSauceHandlers`
- **Producer:** —

### Channel: `SAUCE_SUBMIT_JOB`

- **Runtime string:** `SAUCE_SUBMIT_JOB`
- **Direction / method:** renderer → main, `invoke`
- **Renderer payload:** `{ username, accessKey, region, url, platform, browserName, screenResolution, tunnelName?, tunnelOwner?, filters?, device?, playwrightVersion?, buildName?, tags?, visibility?, timeout? }`. Metadata fields default from `defaultsConfig.saucelabs.default*` when omitted (`defaultPlaywrightVersion='1.57.0'`, `defaultTimeout='15m'`, `defaultVisibility='team'`, `defaultTags=['ui-comparison']`). Concurrency is hard-coded to 1 for extractions.
- **Main behavior:** Validates required fields, generates a `jobId`, **fires-and-forgets** `sauceManager.submitExtraction(...)`. Returns synchronously: `{ success:true, jobId }`. Progress is reported on `SAUCE_JOB_PROGRESS`; final result on `SAUCE_JOB_COMPLETE`.
- **Handler:** `ipc-handlers.js` → `_registerSauceHandlers`
- **Producer:** —

### Channel: `SAUCE_SUBMIT_COMPARISON`

- **Runtime string:** `SAUCE_SUBMIT_COMPARISON`
- **Direction / method:** renderer → main, `invoke`
- **Renderer payload:** `{ username, accessKey, region, baselineUrl, compareUrl, platform, browserName, screenResolution, tunnelName?, tunnelOwner?, filters?, device?, playwrightVersion?, concurrency?, buildName?, tags?, visibility?, timeout? }`. Same metadata defaults as `SAUCE_SUBMIT_JOB`. `concurrency` defaults to 1; setting `2+` runs baseline+compare in parallel on SauceLabs (requires concurrent-session entitlement).
- **Main behavior:** Validates required fields, generates a `jobId`, **fires-and-forgets** `sauceManager.submitComparison(...)`. Both sessions (baseline + compare) are submitted in parallel. Returns synchronously: `{ success:true, jobId }`. Partial failures surface as `SAUCE_JOB_COMPLETE` with `partiallyFailed:true` and `partiallyFailedSession:'baseline'|'compare'`.
- **Handler:** `ipc-handlers.js` → `_registerSauceHandlers`
- **Producer:** —

### Channel: `SAUCE_CANCEL_JOB`

- **Runtime string:** `SAUCE_CANCEL_JOB`
- **Direction / method:** renderer → main, `invoke`
- **Renderer payload:** `{ jobId, username?, accessKey?, region?, baselineSessionId?, compareSessionId? }`
- **Main behavior:** (1) Calls `sauceManager.cancelJob(jobId)` which aborts the job's `AbortController`, SIGTERM→SIGKILL any running saucectl children, and DELETEs tracked remote sessions. (2) Fallback: if caller provided session IDs not in the registry, DELETEs them directly. Returns `{ acknowledged:true }`.
- **Handler:** `ipc-handlers.js` → `_registerSauceHandlers`
- **Producer:** —

### Channel: `SAUCE_RETRY_FAILED_SESSION`

- **Runtime string:** `SAUCE_RETRY_FAILED_SESSION`
- **Direction / method:** renderer → main, `invoke`
- **Renderer payload:** `{ username, accessKey, region, jobId, failedSide:'baseline'|'compare', failedSideUrl, successSideSessionId, platform, browserName, screenResolution, tunnelName?, tunnelOwner?, filters?, device?, playwrightVersion?, concurrency?, buildName?, tags?, visibility?, timeout? }`. Metadata defaults match `SAUCE_SUBMIT_*`.
- **Main behavior:** **Fires-and-forgets** `sauceManager.retryFailedSession(...)`. Re-submits only the failed side; downloads both sides' artifacts after completion. Returns synchronously: `{ success:true, jobId }`. Result arrives on `SAUCE_JOB_COMPLETE`.
- **Handler:** `ipc-handlers.js` → `_registerSauceHandlers`
- **Producer:** —

### Channel: `SAUCE_READ_KEYFRAME`

- **Runtime string:** `SAUCE_READ_KEYFRAME`
- **Direction / method:** renderer → main, `invoke`
- **Renderer payload:** `{ artifactDir, filename }` — `filename` must match `/^keyframe-\d+\.webp$/`; `artifactDir` must be under `app.getPath('userData')/saucelabs-artifacts/`.
- **Main behavior:** Defense-in-depth: rejects paths outside the artifacts root. Reads the file and returns `{ success:true, base64, mimeType:'image/webp' }` or `{ success:false, error }`.
- **Handler:** `ipc-handlers.js` → `_registerSauceHandlers`
- **Producer:** —
- **Security note:** Both `artifactDir` and `filename` are validated server-side: `artifactDir` must resolve inside the saucelabs-artifacts root (prevents directory traversal); `filename` is allow-listed to the `keyframe-N.webp` pattern only.

### Channel: `SAUCE_JOB_PROGRESS`

- **Runtime string:** `SAUCE_JOB_PROGRESS`
- **Direction / method:** main → renderer, `webContents.send`
- **Payload:** `{ jobId, phase:'submitted'|'running'|'downloading'|'comparing'|'done', side?:'baseline'|'compare', sessionId?, baselineSessionId?, compareSessionId?, sauceStatus? }`
- **Main behavior:** Pushed by `sauceManager.submitExtraction`/`submitComparison`/`retryFailedSession` callbacks. Multiple emissions per job.
- **Handler:** —
- **Producer:** `ipc-handlers.js _registerSauceHandlers` (via `onProgress`/`onSessionId` callbacks)

### Channel: `SAUCE_JOB_COMPLETE`

- **Runtime string:** `SAUCE_JOB_COMPLETE`
- **Direction / method:** main → renderer, `webContents.send`
- **Payload (extraction):** `{ jobId, success:true, report, manifest, sessionId, artifactsDir }` or `{ jobId, success:false, error, cancelled? }`
- **Payload (comparison):** `{ jobId, success:true, baselineReport, compareReport, baselineManifest, compareManifest, baselineSessionId, compareSessionId, baselineArtifactDir, compareArtifactDir }` or `{ jobId, success:false, error, partiallyFailed?, partiallyFailedSession?, baselineSessionId?, compareSessionId?, baselineStatus?, compareStatus? }`
- **Main behavior:** Emitted exactly once per job (extraction or comparison) at terminal state.
- **Handler:** —
- **Producer:** `ipc-handlers.js _registerSauceHandlers` (`.then`/`.catch` of `submitExtraction`/`submitComparison`/`retryFailedSession`)

**Sender preconditions** (what the renderer must guarantee before invoking):

- `START_COMPARISON`: `baselineElements` and `compareElements` must each be non-empty arrays loaded from IDB before invocation. `playwright-manager.js` throws `"Baseline elements array is empty …"` otherwise.
- `EXTRACT_ELEMENTS`: `url` must be a navigable URL; `playwright-manager.js` calls `page.goto(url, { waitUntil: 'load', timeout: 60000 })`.
- `START_COMPARISON` / `EXTRACT_ELEMENTS`: `operationId` must be a string the renderer keeps a reference to until cancellation is no longer possible. `_cancelRegistry` is keyed on this id.
- `BULK_START_JOB`: every entry in `pairs[]` must already be the dedup-resolved row (`dedupedSides` populated) and the renderer must call `_provideDedupedElementsToMain(jobId, pairs)` immediately after the invoke returns success — otherwise reused-side waits inside the bulk runner time out after 10 s with `errorCode:'STORAGE_DEGRADED'`.
- `BULK_PROVIDE_ELEMENTS`: must arrive while the job entry still exists in `_bulkJobs` (i.e. before `cleanupJob` / cancel). Late deliveries are rejected with `{ accepted:false, error:'Bulk job not found: …' }`.
- `REGISTER_BLOB`: `blobId` must match `^[^:]+:[^:]+$` exactly; rejected otherwise.
- `EXPORT_HTML`/`EXPORT_FILE`/`OPEN_REPORT`: payload `htmlContent` / `data` is serialized over IPC; treat large payloads as expensive.
- `EXPORT_FILE_TO_DIRECTORY`: `dirPath` must have been approved by a prior successful `PICK_DIRECTORY` call in the same renderer session; `filename` must not contain path separators or `..`.
- `SAUCE_VALIDATE_CREDENTIALS`: must be called before `SAUCE_SUBMIT_JOB`/`SAUCE_SUBMIT_COMPARISON`; it resolves the saucectl binary path (module-cached).
- `SAUCE_SUBMIT_JOB`/`SAUCE_SUBMIT_COMPARISON`: credentials must be validated; `url`/`baselineUrl`/`compareUrl` must be navigable HTTP(S) URLs.
- `SAUCE_CANCEL_JOB`: `jobId` should be a previously-submitted job. Idempotent — cancelling an already-cancelled or completed job is a no-op.
- `SAUCE_READ_KEYFRAME`: `artifactDir` must be an absolute path under `userData/saucelabs-artifacts/`; `filename` must match `keyframe-\d+.webp`.
- `MENU_ACTION` / `CONTEXT_ACTION` / `APP_NOTIFICATION` / `OPERATION_CANCELLED`: renderer must not assume any of these will arrive — the first two are produced; the latter two are not.

---

## 4. IndexedDB Schema

Database name: `ui_comparison_db`. **Current version: `11`.** All constants in
`src/infrastructure/idb-repository.js:6-26`. Single connection per renderer
process; opened lazily by `IDBRepository.#getDB()`.

### 4.1 Object stores and indexes

#### Store: `reports`

- **Constant:** `STORE_REPORTS`
- **keyPath:** `id`
- **Created in:** `buildReportStores` (v1)
- **Indexes:**
  - `by_timestamp` → `timestamp`, not unique
  - `by_url` → `url`, not unique
  - `by_url_ts` → `['url','timestamp']`, not unique
  - `by_bulkJobId` → `bulkJobId`, not unique (added v9)
  - `by_extractionKey` → `extractionKey`, not unique (added v9)
- **Owner of writes:** `IDBRepository.saveReport`
- **Eviction:** `_writeReportWithEviction` counts `total - byBulkJobId.count()` and applies `storage.maxReports = 50` (`config/defaults.js:242`) **only against non-bulk rows**. Cursor walk skips any row whose `bulkJobId != null`.

#### Store: `elements`

- **Constant:** `STORE_ELEMENTS`
- **keyPath:** `reportId`
- **Created in:** `buildReportStores` (v1)
- **Indexes:** none
- **Owner of writes:** `IDBRepository.#writeReportWithEviction`

#### Store: `comparisons`

- **Constant:** `STORE_COMPARISONS`
- **keyPath:** `id`
- **Created in:** `buildComparisonStores` (v2)
- **Indexes:**
  - `by_pair` → `pairKey`, **unique**
  - `by_timestamp` → `timestamp`, not unique
  - `by_baseline` → `baselineId`, not unique
  - `by_compare` → `compareId`, not unique
  - `by_triple` → `['baselineId','compareId','mode']`, **unique** (added v5)
  - `by_bulkJobId` → `bulkJobId`, not unique (added v9)
- **Owner of writes:** `IDBRepository.saveComparison`
- **Eviction:** `MAX_COMPARISONS = 20`, applied to non-bulk rows only by the same total-minus-bulk subtraction trick.

#### Store: `comparison_diffs`

- **Constant:** `STORE_COMP_DIFFS`
- **keyPath:** `comparisonId`
- **Created in:** `buildComparisonStores` (v2)
- **Indexes:** none
- **Owner of writes:** `IDBRepository.#evictAndWrite`

#### Store: `comparison_summary`

- **Constant:** `STORE_COMP_SUMMARY`
- **keyPath:** `comparisonId`
- **Created in:** `buildAuxStores` (v4, guarded)
- **Indexes:**
  - `by_timestamp` → `timestamp`, not unique
- **Owner of writes:** `IDBRepository.#evictAndWrite`

#### Store: `visual_blobs`

- **Constant:** `STORE_VISUAL_BLOBS`
- **keyPath:** `key` (format `comparisonId:keyframeId` after v7)
- **Created in:** `buildAuxStores` (v4, guarded)
- **Indexes:**
  - `by_comparisonId` → `comparisonId`, not unique
  - `by_timestamp` → `timestamp`, not unique
- **Owner of writes:** `IDBRepository.saveVisualBlob`

#### Store: `operation_log`

- **Constant:** `STORE_OP_LOG`
- **keyPath:** `id`
- **Created in:** `buildAuxStores` (v4, guarded)
- **Indexes:**
  - `by_status` → `status`, not unique
  - `by_timestamp` → `timestamp`, not unique
- **Owner of writes:** WAL machinery (`#writeWalEntry`/`#completeWalEntry`/`#failWalEntry`/`#incrementWalEntry`)

#### Store: `visual_keyframes`

- **Constant:** `STORE_VISUAL_KEYFRAMES`
- **keyPath:** `id`
- **Created in:** `upgradeToV6`
- **Indexes:**
  - `by_session` → `sessionId`, not unique
- **Owner of writes:** `IDBRepository.saveVisualKeyframe`

#### Store: `visual_element_rects`

- **Constant:** `STORE_VISUAL_ELEMENT_RECTS`
- **keyPath:** `id`
- **Created in:** `upgradeToV6`
- **Indexes:**
  - `by_session` → `sessionId`, not unique
  - `by_session_element` → `['sessionId','elementKey']`, not unique
- **Owner of writes:** `IDBRepository.saveVisualElementRects` (batch) / `saveVisualElementRect`

#### Store: `app_meta`

- **Constant:** `STORE_APP_META`
- **keyPath:** `key`
- **Created in:** `upgradeToV8` (guarded)
- **Indexes:** none
- **Owner of writes:** `consumeV5UpgradeDataClearedNotice`; the v5 upgrade `complete` listener

#### Store: `bulk_jobs` (v9)

- **Constant:** `STORE_BULK_JOBS`
- **keyPath:** `id`
- **Created in:** `upgradeToV9`
- **Indexes:**
  - `by_createdAt` → `createdAt`, not unique
  - `by_status` → `status`, not unique
- **Owner of writes:** `IDBRepository.saveBulkJob` (with bulk-job retention enforcement, see below) and `updateBulkJob`.
- **Retention:** `BULK_MAX_RETAINED_JOBS = 10` (`idb-repository.js:22`). On save, if `count() >= 10`, the oldest jobs (by `by_createdAt` ascending, excluding the job being written) are cascade-deleted via `#deleteBulkJobCascadeInner`, which removes the job row plus every `bulk_pairs` / `reports` / `elements` / `comparisons` / `comparison_diffs` / `comparison_summary` / `visual_blobs` / `visual_keyframes` / `visual_element_rects` row tagged with the same `bulkJobId` (and every visual artifact for the deleted comparisons).

#### Store: `bulk_pairs` (v9)

- **Constant:** `STORE_BULK_PAIRS`
- **keyPath:** `id` (a pre-allocated UUID, separate from `pairIndex`)
- **Created in:** `upgradeToV9`
- **Indexes:**
  - `by_jobId` → `jobId`, not unique
  - `by_jobId_status` → `['jobId','status']`, not unique
  - `by_jobId_pairIndex` → `['jobId','pairIndex']`, not unique
- **Owner of writes:** `IDBRepository.saveBulkPair` (initial state `'queued'`), `updateBulkPair` (in-place patch by `pairId`).

#### Store: `sauce_jobs` (v10)

- **Constant:** `STORE_SAUCE_JOBS`
- **keyPath:** `id`
- **Created in:** `upgradeToV10`
- **Indexes:**
  - `by_status` → `status`, not unique
  - `by_createdAt` → `createdAt`, not unique
- **Owner of writes:** `IDBRepository.saveSauceJob`, `updateSauceJob`, `deleteSauceJob`.
- **Retention:** `saucelabs.maxRetainedJobs = 20` (`config/defaults.js:298`). Enforced in `#saveSauceJobInner` — oldest jobs beyond the limit are deleted.
- **Used by:** `saucelabs-workflow.js` for persisting SauceLabs job state across renderer restarts. Jobs in `submitted`/`running`/`downloading`/`comparing`/`partially_failed` status can be resumed after re-entering credentials.

#### Store: `app_settings` (v11)

- **Constant:** `STORE_APP_SETTINGS`
- **keyPath:** `key`
- **Created in:** `upgradeToV11` (guarded by `objectStoreNames.contains`).
- **Indexes:** none
- **Owner of writes:** `IDBRepository.saveToleranceProfile` (under `key='tolerance_profile'`).
- **Records currently stored:**
  - `{ key:'tolerance_profile', tolerances:{ color, size, opacity }, updatedAt }` — the user's per-user override of `comparison.defaultTolerances`. Loaded once at boot in `report-manager.js initializeApp` after WAL replay; dispatches `SET_TOLERANCES` to seed `state.tolerances`. Saved by `compare-workflow.js persistTolerancesImmediate` / `persistTolerancesDebounced` from the Compare panel's tolerance inputs (debounce 300 ms on `input`, immediate on `change`/blur). Field validation: color clamped to [0,255], size to [0,100], opacity to [0,1]; non-finite values fall back to the boot defaults.
- **No retention cap** — the store has at most one row at a time (single profile keyed by `tolerance_profile`).

### 4.2 Upgrade ladder

Source: `runUpgrade(db, upgradeTx, oldVersion)` at `idb-repository.js:233-244`. Execution order is the lexical order of the `if` statements:

| Order | Block | Trigger | Action |
|---|---|---|---|
| 1 | `buildReportStores` | `oldVersion < 1` | Create `reports` (with 3 indexes — `by_bulkJobId`/`by_extractionKey` are added later in v9) and `elements`. |
| 2 | `buildComparisonStores` | `oldVersion < 2` | Create `comparisons` (4 indexes — `by_bulkJobId` added later in v9) and `comparison_diffs`. |
| 3 | `buildAuxStores` | `oldVersion < 4` | Conditionally create `comparison_summary`, `visual_blobs`, `operation_log` if absent. |
| 4 | `upgradeToV8` | `oldVersion < 8` | Conditionally `db.createObjectStore('app_meta', { keyPath: 'key' })`. |
| 5 | `upgradeToV5` | `oldVersion < 5` | (a) Add `by_triple` unique index on `comparisons`; (b) cursor-walk `reports` to log a `PRE_UPGRADE_V5_BACKUP` row in `operation_log`; (c) clear `reports`, `elements`, `comparisons`, `comparison_diffs`, `comparison_summary`; (d) attach a `complete`-listener on `upgradeTx` that opens a fresh `[app_meta]` r/w tx and writes `{ key:'v5_upgrade_data_cleared_notice', pending:true, at:Date.now() }`. |
| 6 | `upgradeToV6` | `oldVersion < 6` | Create `visual_keyframes` and `visual_element_rects` with their indexes. |
| 7 | `upgradeToV7` | `oldVersion < 7` | Cursor-walk `visual_blobs`; for any record whose key lacks `:` and has `comparisonId`, delete and re-insert with key `${comparisonId}:${oldKey}`. |
| 8 | `upgradeToV9` | `oldVersion < 9` | Create `bulk_jobs` (with `by_createdAt`/`by_status`) and `bulk_pairs` (with `by_jobId`/`by_jobId_status`/`by_jobId_pairIndex`). On the existing `reports` store add `by_bulkJobId` and `by_extractionKey`. On `comparisons` add `by_bulkJobId`. All steps are guarded with `objectStoreNames.contains` / `indexNames.contains`. |
| 9 | `upgradeToV10` | `oldVersion < 10` | Create `sauce_jobs` (with `by_status`/`by_createdAt`). Guarded with `objectStoreNames.contains`. |
| 10 | `upgradeToV11` | `oldVersion < 11` | Create `app_settings` (no indexes). Guarded with `objectStoreNames.contains`. |

**The v5/v8 ordering anomaly, mechanically.** v8 creates `app_meta`; v5
attaches a `complete` listener that, after the upgrade transaction commits,
opens a *new* readwrite transaction on `[app_meta]` and writes the data-cleared
notice. By placing the v8 block before the v5 block in `runUpgrade`, `app_meta`
is created synchronously on the upgrade tx before v5 even runs; both schema
additions commit atomically when the upgrade tx auto-commits. The v5 listener
also guards itself with `if (!db.objectStoreNames.contains(STORE_APP_META)) return`
(`idb-repository.js:143`) — so even without the ordering, a missing
`app_meta` would cause a silent skip rather than a crash. The current order is
defensive; the listener guard makes it strictly redundant under IDB's
all-or-nothing version-change semantics. See §[Verification answer](#verification-answer-v5v8-ordering) at the end.

### 4.3 Bounded sizes

- `MAX_COMPARISONS = 20` (`idb-repository.js:21`). Enforced in `#evictAndWrite` (lines 579-628): on each save, count `total = comp.count()`, `bulk = comp.index('by_bulkJobId').count()`, project `(total - bulk) + (isBulk ? 0 : 1)`, and if `> 20` evict the oldest non-bulk rows by `by_timestamp` ascending until the projection fits. Bulk-tagged rows are skipped during the cursor walk (`if (cursor.value?.bulkJobId != null) cursor.continue()`).
- `storage.maxReports = 50` (`config/defaults.js:242`). Enforced in `_writeReportWithEviction` / `_evictReports` by the same total-minus-bulk pattern.
- `BULK_MAX_RETAINED_JOBS = 10` (`idb-repository.js:22`). Enforced in `#saveBulkJobInner` via `_collectOldestBulkJobIds` + `#deleteBulkJobCascadeInner`.

---

## 5. WAL & Circuit Breaker State Machines

Both live inside `IDBRepository` (`src/infrastructure/idb-repository.js`).

### 5.1 Write-Ahead Log

Each write helper that goes through the WAL takes the shape:

```
crypto.randomUUID() → logId
#writeWalEntry(db, logId, OPERATION, payload)   // status=PENDING
<perform the actual store mutation in its own tx>
#completeWalEntry(db, logId)                    // delete the WAL row
```

Operations actually wrapped in WAL (verified by grep):

**`SAVE_REPORT`**
- **Wrapper:** `#saveReportInner`
- **WAL payload:** `{ report }`
- **Replay behavior in `applyPendingOperations`:** Replayable; calls `#writeReportWithEviction` again. Bounded retry (3 attempts).

**`SAVE_COMPARISON`**
- **Wrapper:** `#saveComparisonInner`
- **WAL payload:** `{ meta, slimResults }`
- **Replay behavior:** Replayable; calls `#writeComparisonWithEviction` again. Bounded retry.

**`SAVE_VISUAL_BLOB`**
- **Wrapper:** `#saveVisualBlobInner`
- **WAL payload:** `{ key, comparisonId }` (**metadata only — no `Blob` bytes**)
- **Replay behavior:** **Never replayed.** `applyPendingOperations:687-691` matches this operation first and immediately calls `#failWalEntry`. The original `Blob` is in-process memory that does not survive a renderer restart, so replay is impossible.

**`SAVE_BULK_JOB` / `SAVE_BULK_PAIR`**
- **Wrapper:** `#saveBulkJobInner` / `#saveBulkPairInner`
- **WAL payload:** `{ job }` / `{ pair }`
- **Replay behavior:** **Not in the known-replayable set.** `applyPendingOperations:693-699` only treats `SAVE_REPORT` and `SAVE_COMPARISON` as replayable; everything else is force-failed with `unknown operation type`. In practice the only way these entries can stay PENDING is a crash between `#writeWalEntry` and `#completeWalEntry` for a bulk row — survival of the bulk job itself is governed by `detectAndOfferResume` (which scans `bulk_jobs.status === 'running'`, not the WAL).

**any other operation string**
- **Replay behavior:** `applyPendingOperations:693-699` logs `unknown operation type` and marks FAILED.

#### State diagram (per WAL entry)

```
                +---------+
                |  none   |
                +----+----+
                     |  #writeWalEntry()
                     v
                +---------+
                | PENDING |<-------------------+  (replay attempt loop)
                +----+----+                    |
        success   /  |  \   crash / restart    |
                 /   |   \                     |
                v    |    v                    |
          +--------+ | +-----------+           |
          |COMPLETE|<+ | replay #N |-----------+
          | (deleted)| +-----+-----+
          +--------+        |
                            |  replayCount >= 3
                            v
                       +--------+
                       | FAILED |
                       +--------+
                       (retained;
                        emits 'storage-degraded' / WAL_REPLAY_EXHAUSTED)
```

Key transitions:

- `PENDING → COMPLETE`: `#completeWalEntry` *deletes* the row. There is no literal "COMPLETE" state on disk; absence is success.
- `PENDING → FAILED`:
  1. After 3 replay attempts (`(entry.replayCount ?? 0) >= 3` at `applyPendingOperations:701`), `#failWalEntry` flips status and the renderer dispatches `CustomEvent('storage-degraded', { detail: { reason: 'WAL_REPLAY_EXHAUSTED', entryId, operation } })`.
  2. Immediately on `SAVE_VISUAL_BLOB`.
  3. On any unknown operation (including `SAVE_BULK_JOB` / `SAVE_BULK_PAIR`).
- `PENDING → PENDING (replayCount+1)`: `#incrementWalEntry` bumps `replayCount` and `lastAttempt` *before* attempting the replay. If the inner write throws, the entry stays PENDING with the bumped count and is retried on next `applyPendingOperations` (i.e. next renderer start).

`applyPendingOperations` is invoked at boot from
`src/renderer/application/report-manager.js` —
`await storage.applyPendingOperations();` — as the first awaited statement
inside `initializeApp(statusBar)`. `initializeApp` is itself
called from `src/renderer/app.js:381` (`await initializeApp(_statusBar)`)
during the renderer's startup sequence, before the report list is hydrated
and before `detectAndOfferResume` runs.

**Relationship to bulk-job resume.** The WAL replay and the bulk-job resume
are two independent recovery mechanisms that address different failure
scopes. The WAL recovers individual *IDB writes* that were interrupted
mid-transaction (e.g. a `saveReport` that crashed between writing the WAL
row and completing the actual store put). The bulk-job resume recovers
*bulk orchestration state* — it scans the `bulk_jobs` store for rows
whose `status` was never flipped from `'running'`, meaning the app was
killed while the main-process bulk runner was still dispatching pairs.
Boot order is: (1) WAL replay, (2) report list hydration, (3) bulk resume
detection. This order guarantees that any partial report writes from an
interrupted bulk pair are replayed (or force-failed) before the resume
banner checks which pairs completed.

### 5.2 Circuit breaker

Three-strike breaker over the entire write queue (`#enqueue`,
`#handleWriteFailure`, `#consecutiveFailures`, `#circuitOpen`).

**State: Closed**
- **Entered when:** App start (`#consecutiveFailures = 0`, `#circuitOpen = false`).
- **Effect:** `#enqueue` accepts work; failures bump counter; success resets counter to 0.

**State: Open**
- **Entered when:** `#consecutiveFailures >= CIRCUIT_BREAKER_LIMIT` (=3).
- **Effect:** `#enqueue` rejects every subsequent write with `Error("IDB write queue halted after 3 consecutive failures")`. Renderer dispatches `CustomEvent('storage-degraded', { detail: { reason:'CIRCUIT_OPEN', consecutiveFailures, limit, openedAt } })` exactly once on opening. UI installs a fatal `SystemBanner.error` (`app.js:439-442`). **If a bulk job is currently running, the same handler also dispatches `BULK_JOB_STORAGE_DEGRADED` and invokes `cancelBulkJob(jobId)` (`app.js:444-455`).**

**(No half-open state.)** The breaker has no timer or probe to close itself. Recovery requires reloading the renderer process.

`#handleWriteFailure` is invoked from `#enqueue` for both thrown errors and
returned `{ success:false }` shapes. Reads
(`loadReports`, `loadComparisonByPair`, `loadBulkJob`, …) are not counted —
they bypass the queue and call `performanceMonitor.wrap` directly.

---

## 6. Element Capture Pipeline

Every step is anchored to a function. The pipeline runs end-to-end inside
`runExtraction` (`src/main/playwright-manager.js`) for extraction
and inside `runComparison` → `captureVisualDiffs` → `executeTabCapture`
for visual diffing.

### 6.1 Extraction (`runExtraction`)

**1. Acquire / launch browser** (`playwright-manager.js:105-150`)
`getBrowser(descriptorOrType)` — accepts either a string (`'chromium'`/`'firefox'`/`'webkit'`) or a descriptor `{ browserType, channel, executablePath }`. Cache key is `${browserType}:${channel ?? executablePath ?? 'managed'}`, so a Playwright-managed Chromium and a system Chrome are distinct cached browsers. Launch passes `headless:true`; if `channel` is set it takes precedence (Playwright will resolve a canonical install), else `executablePath` is forwarded. If launch raises a "DevTools remote debugging is disallowed"-shaped error, `getBrowser` rethrows with `code:'BROWSER_POLICY_BLOCKED'` and a friendly message instructing the user to switch to Playwright Chromium. See §13 for descriptor source.

**2. New context + page** — `browser.newContext({ serviceWorkers:'block', bypassCSP: true })`, `context.newPage()`. `bypassCSP` is required to allow `addScriptTag` of the extractor bundle on sites with strict CSP.

**3. Navigate** — `page.goto(url, { waitUntil:'load', timeout:60_000 })`.

**4. Build wait selector** — `buildSelectorFromFilters(filters)` then optional best-class probe — yields a single CSS selector that matches the largest population among the comma-separated filter classes, or null. Bulk pairs assemble `filters` from `filterClass`/`filterId`/`filterTag` row cells.

**5. Readiness gate** — `page.waitForSelector(waitSelector, { timeout:30_000, state:'visible' })` then a custom `waitForFunction` polling descendant counts every 750 ms until they stabilize (timeout 30 s). Without a selector: `waitForLoadState('networkidle', 15_000)` then `>100` elements + `readyState==='complete'` (10 s).

**6. Inject extractor** — `page.addScriptTag({ content: getExtractorBundleSource() })` — sets `window.__uiCompare`. The source is read from the first existing path among `process.resourcesPath/extractor-bundle.js`, `mainDistributionDir/extractor-bundle.js`, `__dirname/extractor-bundle.js`, `process.cwd()/dist/extractor-bundle.js`. Cached in module-level `_extractorBundleSource`.

**7. Run extractor** — `page.evaluate(({ filters, cfg }) => window.__uiCompare.extractWithConfig(filters, cfg), { filters, cfg: configOverrides })` — yields `report` object: `{ elements:[…], totalElements, … }`. Override applied: `extraction.batchHardCapMs:30, maxElements:10000, skipInvisible:true, stabilityWindowMs:500, hardTimeoutMs:20000`.

**8. Stamp + return** — `report.id = crypto.randomUUID(); report.duration = …; report.engine = browserDescriptor.browserType ?? 'chromium'; report.platform = process.platform`. The renderer further stamps `report.bulkJobId` and `report.extractionKey` on bulk-side persistence (in `_persistPairResult`).

**9. Cleanup** — `page.close()`, `context.close()` in `finally`.

**Cancellation polling.** `isCancelled?.()` is checked at lines 1029, 1096,
1116, 1131 (single-extract path) and inside the bulk-runner's per-pair
extraction wrappers (which OR three flags: per-side opId, per-pair opId, and
the master `isMasterCancelled` from `_bulkJobs.has(jobId)`). Each call throws
`Object.assign(new Error('cancelled'), { code:'CANCELLED', name:'CancelledError' })`
if any flag is set.

**Engine-specific freeze/screenshot behaviour.** The capture pipeline branches on `attachSession`'s `freezeStrategy` (`playwright-manager.js:168-188`), which is `'cdp'` if the engine's profile (`src/config/browser-capability-profile.js`) declares `cdpAvailable:true` (chromium only) and `'shim'` otherwise (firefox, webkit). On the shim path `freezePage` patches `requestAnimationFrame`, `setInterval`, and `setTimeout` (only `0`/null delays survive), and injects a `<style id="vdiff-freeze-styles">` block setting `animation-play-state:paused !important; transition-duration:0s !important; scroll-behavior:auto !important`. Screenshot mime-type is `image/webp` on chromium (CDP `Page.captureScreenshot` with quality 85) and `image/png` on firefox/webkit (Playwright `page.screenshot`). DPR is overridden to 2 only when `deviceScaleFactorOverride:true` (chromium), else 1. WebKit has `requiresLayoutWarmup:true` in its profile (consumed by the capture pipeline before measurement).

**Screenshot phase fallback.** `runComparison` (`playwright-manager.js:1504-1559`) wraps the screenshot phase in a try/catch. If the descriptor was WebKit and the error message matches `/Page\.snapshotRect|snapshot/i`, the entire screenshot phase is retried with `{ browserType:'chromium', channel:null, executablePath:null }`, and a `{ kind:'screenshot-engine-fallback', from:'webkit', to:'chromium', reason }` entry is appended to **`visualData.devToolsWarnings`** (i.e. the result's `visualDiffs.devToolsWarnings` array — **not** a top-level `result.fallbackWarnings`).

### 6.2 Visual diff capture (`captureVisualDiffs` → `executeTabCapture`)

Steps 1–18 unchanged from previous revisions:
1. `extractModifiedElements(comparisonResult)`
2. `buildSelectorPairs(elements, role)`
3. Open new context+pages, navigate both URLs (parallel, networkidle 15 s)
4. Per role: `attachSession` (CDP for chromium, shim for firefox/webkit)
5. Read viewport, detect DevTools (`heightGap > 200 px` triggers
   `Emulation.setDeviceMetricsOverride` bypass)
6. Read DPR, lock scrollbar, apply device metrics override
7. Inject `vdiff-freeze-styles` `<style>` and patch scroll APIs
8. Hide every `position:fixed`/`sticky` element (except diff set + ancestors/descendants)
9. Scroll to top and settle
10. Measure document-relative rects
11. `groupIntoKeyframes` (`core/comparison/keyframe-grouper.js`)
12. Per keyframe: `bringToFront`, scroll-and-settle, scroll verify (≤5 px,
    ≤2 retries × 400 ms), remeasure rects, freeze JS, capture screenshot,
    unfreeze
13. Read pseudo-element styles (`::before`/`::after`)
14. `buildManifestFromRemeasured` (clip below-fold to viewport)
15. `attachPseudoDataToManifest`
16. `buildElementRectRecords` (one per element-role)
17. `safeRestorePage` + `detachSession` (unlock scrollbar, restore fixed,
    restore animations, scroll 0, clear metrics override)
18. `buildDiffMap` (baseline + compare manifests + per-element diffs)

**Constants** (top of `playwright-manager.js`):

| Name | Value |
|---|---|
| `CAPTURE_SCALE_FACTOR` | `2` |
| `CAPTURE_QUALITY` | `85` (webp) |
| `FREEZE_STYLE_ID` | `'vdiff-freeze-styles'` |
| `SUPPRESS_ATTR` | `'data-vdiff-suppress'` |
| `SCROLL_SETTLE_TIMEOUT_MS` | `800` |
| `SCROLL_VERIFY_RETRY_MAX` | `2` |
| `SCROLL_VERIFY_RETRY_MS` | `400` |
| `DEVTOOLS_HEIGHT_THRESHOLD_PX` | `200` |
| `BROWSER_CHROME_HEIGHT_PX` | `88` |
| `CDP_COMMAND_TIMEOUT_MS` | `5_000` |
| `getScrollTolerance(...)` | always returns `5` px (kept switch-shaped for future per-engine tuning) |

---

## 7. Element Matching Pipeline

Source: `src/core/comparison/matcher.js`. Entry: `ElementMatcher.matchElements(baseline, compare)` (async generator).

The pipeline is **stateful**: two `Set<index>` instances — `usedBaseline` and
`usedCompare` — accumulate matched indices across all phases. Every phase
takes the same `(baseline, compare, usedBaseline, usedCompare, …)` signature
and reads current state to skip already-matched indices. **Phase N+1 sees the
same `baseline` and `compare` arrays as phase N, but only operates on indices
not yet in `usedBaseline`/`usedCompare`** — the "input contract" is the
residual mask, not a fresh array.

Each phase emits frames `{type:'progress', label, pct}` via `runChunkedPass`,
and the final frame is `{type:'result', payload}`. `Comparator.compare`
(`comparator.js`) consumes these.

### Phase ladder (in execution order)

**1. Test-attribute anchoring**
- For every attribute in `comparison.matching.anchorAttributes` (`data-testid`, `data-test`, `data-qa`, `data-cy`, `data-automation-id`, `data-key`, `data-record-id`, `data-component-id`, `data-row-key-value` — `defaults.js:113-117`), build a multi-map per side and pair indices that share the attribute value 1:1.
- Confidence `1.00`. If a value appears N×M (N ≠ M), unresolved members fall through.

**2. Sequence alignment**
- Linear two-pointer walk over `(baseline, compare)`, skipping already-matched indices. At each position, look ahead `lookAheadWindow=5` for an HPID-suffix-equal match (`segmentsEqual` over the last `suffixDepth=5` HPID segments). In-sequence pair → `0.99`; off-by-skip pair → `0.85`.

**3. HPID suffix realignment**
- Build a suffix index over remaining `compare` elements (key = last `suffixDepth` HPID segments); for each remaining baseline orphan, look up by suffix. Disambiguates near-duplicates by ancestor compatibility via `passesIdentityTriad` (tag, role, classlist intersection). Confidence `0.85`. Ambiguous matches (≥2 candidates within `ambiguityWindow=0.12`) are dropped.

**4. Legacy strategy pool** (residual passing, in this order)
- For each strategy in `defaults.js:120-126` that is `enabled`: `absolute-hpid` (0.95), `id` (0.90), `css-selector` (0.80), `xpath` (0.78), `position` (0.30). After each strategy, `mutableBaseOrphans = passResult.orphans` and `mutableCmpOrphans` is re-derived from `usedCompare`.
- The `position` strategy uses `positionTolerance=50` px and `minMatchThreshold=0.70` overlap.

**Scoring formula.** Pairs below `comparison.matching.confidenceThreshold = 0.5` (`defaults.js:136`) are discarded before being added to `allMatches`. There is no probability combination; the strategy whose classifier wins owns the score.

**Final output contract.** The `result` frame payload contains:
- `matching` — `{ totalMatched, unmatchedBaseline, unmatchedCompare, addedCount, removedCount, modifiedCount, matchRate, totalElements }`.
- `comparison` — `{ summary, results }` with per-pair `annotatedDifferences` from the `PropertyDiffer`.
- `unmatchedElements` — `{ baseline:[…], compare:[…] }`.

---

## 8. CSS Diff Engine

Source: `src/core/comparison/differ.js`, `severity-analyzer.js`. Inputs: the
matched element pairs from §7 plus computed-style maps captured in §6.

### 8.1 Tracked properties

Driven by `extraction.cssProperties` (`defaults.js:54-78`, ~70 properties)
during capture, and constrained at compare-time by
`comparison.modes.<mode>.compareProperties`:

- **dynamic mode**: explicit list (`defaults.js:188-204`).
- **static mode**: `compareProperties: null` → compare all captured properties; `compareTextContent: true`.

### 8.2 Tolerances (single profile, user-overridable)

Tolerances are **no longer mode-specific.** A single triple lives at
`comparison.defaultTolerances` (`config/defaults.js:211`) and is used for both
`static` and `dynamic` modes:

| Tolerance | Default | Range | Field meaning |
|---|---|---|---|
| `color` | `8` | `[0, 255]` | Per-channel ΔRGB threshold |
| `size` | `5` | `[0, 100]` | Absolute pixel delta |
| `opacity` | `0.05` | `[0, 1]` | Absolute opacity-float delta |

The user can override these at runtime via the **Tolerance** section of the
Compare panel (`#tolerance-color`/`-size`/`-opacity` inputs in
`src/renderer/index.html:262-278`). Overrides are persisted to IDB
(`app_settings` store under `key='tolerance_profile'`) and reloaded at boot.
See §17 for the full tolerance-profile lifecycle.

**Resolution order at compare time** (in `comparison-modes.js getFilter`):

1. The `tolerances` argument passed by the renderer through
   `START_COMPARISON` (sourced from `state.tolerances`, which holds the
   active profile).
2. If `null`/omitted: `comparison.defaultTolerances` from boot config.

`Comparator.compare(baselineReport, compareReport, mode, tolerances=null)`
forwards `tolerances` to `comparisonMode.compare(matches, tolerances)`. Both
`StaticComparisonMode` and `DynamicComparisonMode` build their per-comparison
filter via `getFilter(mode, tolerances)`, which clones the static/dynamic
filter base (`STATIC_FILTER_BASE` / `DYNAMIC_FILTER_BASE`) and replaces the
`tolerances` field.

### 8.3 Diff computation

For each matched pair and each tracked property: read both values, normalize
via `src/core/normalization/`, compare using the relevant tolerance (per-channel
ΔRGB for color, absolute pixel delta for length, absolute float for opacity,
equality otherwise). Emit a `Difference{ property, baselineValue, compareValue, severity }`
when out of tolerance.

**Size-property classification (`differ.js isSizeProperty`).** A property is
classified as a "size" property (and therefore subject to the `size`
tolerance) if it satisfies ANY of:
- belongs to `cats.layout`, `cats.spacing`, `cats.position`, or
  `cats.typography`;
- is in the explicit `SIZE_PROPERTY_NAMES` set: `gap`, `row-gap`,
  `column-gap`, `flex-basis`, `border-radius`, the four
  `border-*-*-radius` corners;
- contains the substring `width`, `height`, or `size`.

This is a deliberate widening — `font-size`, `letter-spacing`,
`line-height`, `border-radius`, `gap`, etc. all flow through the size
tolerance instead of being compared with strict equality.

### 8.4 Severity classification

`comparison.severity` (`defaults.js:149-163`):

| Bucket | Properties |
|---|---|
| **critical** | `display`, `visibility`, `position`, `z-index` |
| **high** | `width`, `height`, `max-width`, `max-height`, `min-width`, `min-height`, `color`, `background-color`, `opacity`, `font-size`, `font-family`, `font-weight` |
| **medium** | `margin-*` (4), `padding-*` (4), `border-*-width` (4), `border-*-color` (4), `line-height`, `text-align`, `font-style` |
| low (implicit) | everything not listed above |

Severity is assigned by lookup; magnitude does not affect bucket.

### 8.5 Cascade suppression (export-time)

`src/core/export/export-utils/report-transformer.js`. Two property classifiers:

- `INHERITABLE_PROPS`: classic CSS inheritance set (colors, fonts, line-height, letter-spacing, text-align, etc.).
- `LAYOUT_PROPAGATION_PROPS`: properties whose change on an ancestor mechanically alters layout (display, position, width, height, flex/grid…).

`walkUpToNearestDiffAncestor(absHpid, diffIndex)` walks the absolute-HPID
path upward and, when an ancestor in the diff index has at least one diff in
either set, marks the descendant's matching diffs as suppressed. **The walk
uses `absoluteHpid`, not the relative HPID.** Mixing those breaks suppression
silently.

### 8.6 Normalization engine (`src/core/normalization/normalizer-engine.js`)

Pipeline (in order for each element's style map):

1. **Shorthand expansion** — `expandShorthands(styles)` splits shorthands
   (border, margin, padding, background, flex, grid, etc.) into longhands.
2. **Per-property normalization** — dispatches by property class:
   - **Color** (11 props): `color`, `background-color`, `border-*-color` (4),
     `outline-color`, `text-decoration-color`, `caret-color`, `column-rule-color`.
     Normalizes named colors / hex / rgb / hsl to canonical `rgb(R, G, B)` or
     `rgba(R, G, B, A)`.
   - **Size** (25 props): `width`, `height`, `min-*`, `max-*`, positioning
     (`top`/`right`/`bottom`/`left`), margin (4), padding (4), border widths (4),
     `border-radius` variants (4), `font-size`, `line-height`, `gap`,
     `outline-width`, `outline-offset`, `text-indent`. Units standardized,
     values rounded to `normalization.rounding.decimals = 2`.
   - **Font family** — dequoted on engines where
     `requiresFontFamilyDequote = true` (Firefox, WebKit).
   - **Font weight** — keywords to numeric (`normal`→`400`, `bold`→`700`) when
     `requiresFontWeightCanonicalize = true` (all engines).
   - **Box shadow** — component reorder on engines where
     `requiresBoxShadowReorder = true` (WebKit only).

**Engine-quirks routing:** `contextSnapshot.engineHint` (set during extraction
from `report.engine`) selects the `BROWSER_NORMALIZATION_PROFILES` entry.

**LRU cache:** Keyed on `(property, value, isContextDependent, context)`.
`normalization.cache.maxEntries = 1000`, eviction policy `LRU`. Cache stats
exposed via `getCacheStats()`.

**Error handling:** Any normalization error silently returns the original value
(no throw propagation).

### 8.7 Selector engine (`src/core/selectors/selector-engine.js`)

Generates CSS and XPath selectors for extracted elements.

**Constants:**
- `selectors.concurrency = 4` — max parallel element processing via `BoundedQueue`.
- `selectors.totalTimeout = 600` ms — hard per-element timeout (`Promise.race`).
- `selectors.css.perStrategyTimeout = 40` ms, `selectors.css.totalTimeout = 250` ms.
- `selectors.xpath.perStrategyTimeout = 50` ms, `selectors.xpath.totalTimeout = 400` ms.

**Execution model:**
- If both `xpath.parallelExecution` and `css.parallelExecution` are `true`
  (default): CSS and XPath generators run in parallel via `Promise.allSettled`.
- Otherwise: CSS runs after XPath sequentially.
- Multi-element generation uses `BoundedQueue(concurrency)` with
  `Promise.all(promises)`. Errors per element yield `NULL_SELECTORS` (no throw).

**Shadow DOM support:**
- `buildShadowPath(element)` walks `getRootNode({ composed: false })` upward
  to detect `ShadowRoot` boundaries. Returns array of host selectors (root
  last) or `null` if no shadow boundaries found.
- `buildHostSelector(host)` checks test attributes (`data-testid`, `data-test`,
  `data-qa`, `data-cy`, `data-automation-id`) first, then `#id` (CSS-escaped),
  then bare tag name.

**`NULL_SELECTORS`:**
```
{ xpath:null, css:null, shadowPath:null, xpathConfidence:0, cssConfidence:0, xpathStrategy:null, cssStrategy:null }
```

---

## 9. Renderer UI Architecture

### 9.1 Token system

`src/renderer/styles/tokens.css` is the single source of design constants.
Categories (by prefix): `--color-*` (surface, text, border, accent,
state-success/warning/error/info, severity-critical/high/medium/low,
match-hi/mid/lo, scrim), `--font-*`, `--space-*`, `--radius-*`, `--shadow-*`,
`--z-*`, `--motion-*`. Loaded by `src/renderer/index.html:10` and consumed by
every sibling stylesheet (`base.css`, `shell.css`, `components.css`,
`navigation.css`, `report-list.css`, `result-panel.css`, **`bulk.css`**).

### 9.2 CSS Grid shell

`src/renderer/index.html` defines four addressable regions inside `#app-root`:

- `#system-banner-slot` — top-of-shell `SystemBanner` warnings/errors.
- `#left-panel` — sidebar (reports list, search, filters, density cycle, resize handle).
- `#main-content` — main area. Contains a section-nav (`#main-pane-section-nav`) with **four** buttons: **Extract**, **Compare**, **Bulk** (`#bulk-tab-btn`, with a status badge `#nav-section-status-bulk`), and **SauceLabs** (`#saucelabs-tab-btn`). Underneath: `#section-extract`, `#section-compare`, `#section-bulk` (with `#bulk-resume-banner-slot`, `#bulk-panel-root`, and `#bulk-result-area` → `#bulk-results-screenshot-section` + `#bulk-result-panel-host`), `#section-saucelabs` (with `#saucelabs-panel-root`).
- `#status-bar` — bottom status row containing the theme toggle (`#theme-toggle`).

There is also a global `#toast-container` and `#modal-overlay`. **There is no
`#command-palette` element.** Keyboard shortcuts: `/` focuses
`#search-reports`; `e`/`c` activate the Extract/Compare sections (no `b`
shortcut for Bulk yet — the section is reached via the nav button).
`Ctrl+B`/`Cmd+B` toggles the left panel; `Escape` collapses an expanded
sidebar when focused inside it; `Ctrl+Shift+D` opens the diagnostics
panel.

**Empty bulk-resume-banner.** `shell.css` now collapses
`#bulk-resume-banner-slot:empty { display: none }` so the slot does not
reserve vertical space when no resume offer is active.

### 9.3 Virtual scroll (`report-list.js` and `bulk-panel.js`)

`src/renderer/components/report-list.js` renders the sidebar list with
`OVERSCAN = 3` card-heights of buffer above and below the viewport. Recycling
is full-fragment replacement: `_window.textContent = ''` followed by
`_window.appendChild(frag)`.

`src/renderer/components/bulk-panel.js` separately implements its own
**fixed-height virtual scroller** for the per-pair list using
`ROW_HEIGHT = 56` (uniform across queued/active/done/failed/cancelled
states). Offsets are computed as `i * ROW_HEIGHT` with no prefix-sum table;
visible-range lookup is `Math.floor(scrollTop / ROW_HEIGHT)`. The panel
maintains its own DOM-recycling pool sized to viewport height plus
`OVERSCAN = 3` rows on each side. Status-specific visual treatments
(active shimmer, failed shake, cancelled fade) are handled inside a fixed
56px frame via inner element animation rather than row-height changes.

### 9.4 Accordion nav state machine

`#section-extract`, `#section-compare`, `#section-bulk` are driven by
`AppShell.activateSection(id)` (`src/renderer/components/app-shell.js`),
which toggles `aria-expanded`, the `nav-section--active` /
`nav-section--expanded` classes, and scrolls the section into view. State is
implicit in the DOM.

### 9.5 State machine

`src/renderer/state.js` is a reducer over a flat object with phases
`'idle' | 'extracting' | 'comparing' | 'cancelling' | 'done' | 'error'`.
`dispatch(type, payload)` is synchronous and notifies a single Set of
subscribers. The renderer subscribes multiple times in `app.js`
(`385-443` for panel/result rendering, `447-460` for selection-driven
cache hydration, `698-717` for tolerance UI sync).

**Top-level slices** (sourced from `state.js initialState`):
- Lifecycle/selection: `phase`, `reports`, `comparison`, `progress`,
  `error`, `exportState`, `selectedBaseline`, `selectedCompare`,
  `compareMode`, `filters`, `cachedAt`, `comparisonFromCache`,
  `compareSummaryStrip`.
- Browser detection: `selectedBrowser`, `availableBrowsers`,
  `browserDetectionState`, `browserDetectionError`.
- Bulk: `bulkJob`, `bulkParsedRows`, `bulkDetectionState`.
- Multi-select: `multiSelect:{ active, selectedIds:Set, anchorId }`.
- SauceLabs: `sauceJob`, `sauceCredentialState`, `sauceCredentialError`,
  `sauceComparisonResult`, `sauceInFlightJobCount`.
- Tolerances: `tolerances:{ color, size, opacity }` — initialised from
  `comparison.defaultTolerances`, overridden by the persisted profile
  in `app_settings`. See §17.

**Browser-detection slice:**
- `availableBrowsers`, `selectedBrowser`, `browserDetectionState ∈ {'idle','loading','ready','error'}`, `browserDetectionError`.
- Actions: `BROWSER_DETECTION_STARTED`, `BROWSERS_DETECTED`, `BROWSER_DETECTION_FAILED`, `BROWSER_SELECTED`. `DISMISS_ERROR` preserves all four browser fields.

**Bulk slice (added in v9 of state):**
- `bulkParsedRows` — array of parsed rows (each carrying `valid`/`validationStatus`/`validationReason`, `resolvedBrowser`, `rowIndex`, …).
- `bulkDetectionState` ∈ `'idle' | 'parsing' | 'parsed' | 'error'`.
- `bulkJob` — full `BulkJobState` (see JSDoc at `state.js:3-32`):
  ```
  { jobId, filename, status:'running'|'parsed'|'completed'|'partial'|'failed'|'cancelled'|'interrupted',
    totalPairs, concurrency, hostCooldownMs?, pairs:Array<BulkPairState>,
    summary:null|{total,succeeded,failed,cancelled,deduped},
    startedAt, completedAt, activePairIndex, viewer:null|{result,cachedAt,fromCache,compareSummaryStrip},
    resumeOffer?:{ jobId, completedCount, totalCount },
    storageDegraded?:boolean }
  ```
- `BulkPairState` per pair: `{ pairIndex, baselineUrl, compareUrl, mode, label, browser, includeScreenshots, filterClass, filterId, filterTag, deduped:'none'|'baseline'|'compare'|'both', status:'queued'|'extracting-baseline'|'extracting-compare'|'matching'|'screenshots'|'persisting'|'done'|'failed'|'cancelled', pct, operationId, baselineReportId, compareReportId, comparisonId, error, errorCode, completedAt? }`.
- Actions: `BULK_PARSED_ROWS_SET`, `BULK_DETECTION_STATE`, `BULK_JOB_STARTED`, `BULK_PROGRESS`, `BULK_PAIR_COMPLETED`, `BULK_JOB_COMPLETE`, `BULK_JOB_CANCELLED`, `BULK_JOB_STORAGE_DEGRADED`, `BULK_JOB_LOADED`, `BULK_JOB_RESET`, `BULK_JOB_RESUMED`, `BULK_JOB_RESUME_ACCEPTED`, `BULK_JOB_RESUME_OFFERED`, `BULK_JOB_RESUME_DECLINED`, `BULK_PAIR_OPEN`, `BULK_PAIR_VIEWER_READY`, `BULK_ACTIVE_PAIR_CLEAR`. `DISMISS_ERROR` preserves the entire bulk slice.

Both bulk dispatches (`BULK_JOB_COMPLETE`) and `BULK_JOB_CANCELLED` flip the
job to a terminal state (`completed` / `failed` derived from summary;
`cancelled` flips queued pairs to `'cancelled'`). `RESET_COMPARISON` clears
any open bulk viewer.

The renderer triggers browser detection once at boot (`app.js:405-423`) and
**bulk-job resume detection** once at boot via `detectAndOfferResume` (after
`initializeApp`).

### 9.5a Browser selector component

`src/renderer/components/browser-selector.js` mounts a `<select>` plus a
"Retry" button into `#browser-selector-slot` (declared inside the Extract
panel, `index.html:144`). Subscribes to `state` once in `constructor` and
re-renders on every state change. Idle/loading: "Detecting browsers…".
Error: "Browser detection failed" + Retry button (with
`browserDetectionError` as `title`). Ready: lists all browsers; non-launchable
entries are `disabled` with a tooltip from `UNAVAILABLE_REASON_LABELS`
(`binary-not-found`, `version-mismatch`, `playwright-requires-patched-build`,
`unsupported-os`, `devtools-blocked-by-policy`). Disabled entirely while
`state.phase ∈ {'extracting','comparing','cancelling'}` (the `BUSY_PHASES`
Set). Non-launchable selections are silently rejected on `change`.

### 9.5b Bulk panel component

`src/renderer/components/bulk-panel.js` is the third major user-facing
component (alongside the report list and result panel). Mounted into
`#bulk-panel-root` from `app.js:471-474`. Surfaces:

- **Drop zone / file picker** for an `.xlsx` plan + a "Download template" button (calls `routeBulkDownloadTemplateClick` → `buildBulkTemplateWorkbook`).
- **Parse summary strip** — total / valid / warning / invalid row counts.
- **Job-controls row** — concurrency `<input type="number">` (`#bulk-concurrency`, clamped at runtime by RAM and heterogeneity), screenshots toggle (`#bulk-screenshots`), host cooldown ms (`#bulk-host-cooldown`), "Force refresh" (`#bulk-force-refresh`), Start / Cancel / Reset / Export buttons.
- **Pair list** — variable-height virtual scroll keyed off pair status. Each row exposes a context-menu trigger (calls `electronAPI.showContextMenu({ bulkJobId })`) and an "Open" action that routes through `routeBulkPairOpenClick` to load the persisted comparison into `#bulk-result-panel-host`.
- **Resume banner** — rendered into `#bulk-resume-banner-slot` by `bulk-workflow.js _renderResumeBanner` when boot detection finds a job stuck in `running`.

The panel reads `bulk.maxConcurrency` from `defaults.js` for the upper bound
of the concurrency control. Heterogeneous-plan detection uses the
`_isHeterogeneousPlan(parsedRows, selectedBrowser)` helper and surfaces
`BULK_CONCURRENCY_HETEROGENEOUS_HINT = 'Mixed browsers detected — concurrency
limited to 1 on this machine.'` when triggered.

### 9.5c SauceLabs panel component

`src/renderer/components/saucelabs-panel.js` is the fourth top-level
component, mounted into `#saucelabs-panel-root` from `app.js:476-479`.
Surfaces:

- **Credentials card** — username / access key / region selector (US-W1,
  US-E4, EU-C1) + Validate button. Credentials are held in module-scope
  (`saucelabs-workflow.js _creds`) — never persisted.
- **Execution Mode radios** — Desktop | Mobile (legend: "Execution Mode").
- **Compatibility-aware dropdowns** (driven by `SAUCE_COMPATIBILITY_MATRIX`):
  - **Playwright Version** — `#sauce-pw-version`, default `1.57.0`. On
    change, browser + platform dropdowns are re-populated to the matrix's
    intersection of allowed combos.
  - **Browser** — `#sauce-browser`. Includes `chromium`, `chrome (VM-installed)`,
    `firefox`, `webkit`. Filtered by the active Playwright version.
  - **Platform** — `#sauce-platform`. Filtered by both Playwright version
    AND the matrix's `exclusions` list (e.g. macOS 12 excludes webkit on
    most versions). Hidden in Mobile mode (the device choice fully
    constrains platform).
  - **Resolution** — `#sauce-resolution`, populated by
    `resolutionsForEngine(engine)`. Hidden in Mobile mode.
- **Mobile mode dropdowns** (visible only when Execution Mode = Mobile):
  - **Device** — `#sauce-device`, grouped by OS (iOS / iPadOS / Android).
    See §16.4a for the full device list with viewports + DPRs.
  - **Orientation** — `#sauce-orientation`, portrait | landscape.
    Selecting `landscape` flips viewport `{w,h}` in `_stageRunnerProject`
    before writing `job.json`.
  - The browser dropdown is locked to the device's `browserEngine` while
    Mobile mode is active; it unlocks (and restores the user's last
    Desktop-mode choice) when switching back.
- **Tunnel** — `#sauce-tunnel` text input. Combined with `tunnelOwner`
  (collected indirectly — currently always `null` from this panel; the
  YAML supports it for future use). Newlines and overlong values are
  rejected at YAML emit time.
- **Timeout** — `#sauce-timeout` select with options 5m / 10m / 15m / 20m
  / 30m. Default `15m`.
- **Metadata expander (`#sauce-metadata-toggle`)** — collapsed by default,
  shows a chevron with label "Metadata: auto-generated". Expands to:
  - **Build Name** — text, max 255 chars. Default
    `ui-compare ${ISO date YYYY-MM-DDThh:mm}`.
  - **Tags** — comma-separated, each tag max 64 chars. Default
    `ui-comparison`.
  - **Visibility** — `private | team | share | public restricted | public`.
    Default `team`.
  - **Concurrency** — 1..5. A hint warns that values >1 require a
    matching concurrent-session entitlement.
- **URL inputs** — single (`Extract`) or pair (`Compare`) URL fields plus
  filter inputs that share the engine with the Extract panel.
- **Actions** — `Validate Credentials`, `Submit Extraction`,
  `Submit Comparison`. Buttons are disabled while in-flight or before
  credentials are validated.

The panel emits a fully-populated payload to
`saucelabs-workflow.submitExtraction` /
`submitComparison` containing all metadata fields (`playwrightVersion`,
`concurrency`, `buildName`, `tags`, `visibility`, `timeout`) plus the
device payload. The workflow forwards all of these to the IPC handler
which stamps them onto the `sauce_jobs` row for resume continuity.

### 9.6 Result panel data flow

`src/renderer/components/result-panel.js` (`createResultPanel(container)`).
Mounted twice in `app.js:367-376`: once into `#compare-results` (the
single-compare workflow's panel) and once into `#bulk-result-panel-host`
(the bulk pair viewer). The single subscriber in `app.js:385-443` decides
which panel to render based on `state.bulkJob?.activePairIndex` —
`bulkDetailOpen ⇒ render into the bulk panel; otherwise render into the
single-compare panel`. The `#main-content` element gains/loses
`main-content--compare-results-visible` accordingly.

**Tolerance badge.** The result-panel summary bar renders a `Tol C/S/O` chip
(`_buildToleranceBadge` in `result-panel.js:18-44`) that displays the
tolerances triple under which the comparison ran. Source:
`result.tolerancesSnapshot` (set by
`compare-workflow.js handleComparison` from `resolveActiveTolerances` at
the moment of submission, also stamped onto saved `comparisons.tolerancesSnapshot`).
The badge falls back to a muted "Tolerances: —" with tooltip
`"This comparison was run before tolerances were tracked"` for legacy rows
without the snapshot. Title attribute always shows the canonical form
`color ΔRGB ≤ N, size ≤ Npx, opacity Δ ≤ N`.

### 9.7 Notification queue

`src/renderer/application/notification-queue.js`:

**Constants:**
- `MAX_VISIBLE = 3`
- `NOTIFICATION_SPAM_WINDOW_MS = 800`
- Auto-dismiss durations (from `notification-timing.js`): info 4 s, warning 10 s, error indefinite
- `NOTIFICATION_MIN_ALERT_VISIBLE_MS = 5000` — floor for error-tier dismissal

**State machine:** `IDLE | ACTIVE | COALESCING | DRAINING`
- `IDLE` → `ACTIVE`: first notification enqueued.
- `ACTIVE` → `COALESCING`: `≥3` enqueues within `NOTIFICATION_SPAM_WINDOW_MS`.
- `COALESCING` → `DRAINING`: `setTimeout(0)` flushes the coalesced batch.
- `DRAINING` → `IDLE`: all visible slots emptied.

**Behaviors:**
- Spam detection: `≥3` enqueues in 800 ms triggers coalesce; deduped by `dedupeKey || id`.
- Errors (tier `'error'`) `unshift` to head of wait queue (priority).
- Duplicate dedupeKey while visible: **updates in-place** (increments `repeatCount`, refreshes timer).
- When `_visible.length >= MAX_VISIBLE`, new arrivals trigger `dispatchEvictOldest`.

### 9.8 Multi-select & undo (`report-manager.js`, `multi-select-toolbar.js`)

**State slice:** `state.multiSelect = { active:boolean, selectedIds:Set<string>, anchorId:string|null }`.

**Activation:** `report-list.js` dispatches `MULTI_SELECT_ENTER` on long-press / ctrl-click / right-click of a report card. Subsequent clicks toggle via `MULTI_SELECT_TOGGLE`. Shift-click dispatches `MULTI_SELECT_RANGE` with all ids between the anchor and the clicked card (computed from the current sorted/filtered row list). `MULTI_SELECT_ALL` replaces the set with every visible report id.

**Toolbar:** `createMultiSelectToolbar(slotEl)` (`src/renderer/components/multi-select-toolbar.js`) mounts a fixed-position `div[role=toolbar]` in `#multi-select-toolbar-slot`. Actions are emitted as `CustomEvent('multi-select-action')` with `detail.action ∈ { 'select-all', 'deselect', 'delete', 'close' }`. `report-manager.js` listens on the slot and routes accordingly.

**Native context menu:** When `multiSelect.active`, the report list sends `showContextMenu({ multiSelect:true, count })` → main builds a single-item "Delete N reports" menu → `CONTEXT_ACTION { action:'deleteSelected' }` → renderer routes to `handleDeleteSelectedReports`.

**Delete with undo:** `handleDeleteSelectedReports` (in `report-manager.js`):
1. Confirms via `Modal.confirm` with a destructive intent.
2. Stores the deleted reports in `_undoBuffer`.
3. Dispatches `MULTI_SELECT_AFTER_DELETE` (prunes selection set) and `REPORTS_REMOVE_BY_IDS` (optimistic UI removal).
4. Shows a `Toast` with a 5 s auto-dismiss and an "Undo" button.
5. On undo: dispatches `REPORTS_RESTORE` (re-inserts the buffered reports into state) and clears `_undoBuffer` — **no IDB writes were committed yet**, so no storage rollback is needed.
6. On timeout (no undo): commits the deletes to IDB via `storage.deleteReportsBatch(ids)` (single batch operation), then flushes any deferred loads.

`_deferredLoads` prevents `loadAndRenderReports` from re-reading IDB during the undo window, which would overwrite the optimistic state with stale data.

### 9.9 State machine (complete action list)

`src/renderer/state.js` — all action types handled by the reducer:

**Single-extract/compare lifecycle:**
`REPORTS_LOADED`, `REPORT_DELETED`, `REPORTS_REMOVE_BY_IDS`,
`REPORTS_RESTORE`, `EXTRACTION_STARTED`, `EXTRACTION_PROGRESS`,
`EXTRACT_UI_END`, `COMPARISON_STARTED`, `COMPARISON_PROGRESS`,
`COMPARISON_COMPLETE`, `COMPARISON_ERROR`, `COMPARE_UI_END`,
`OPERATION_CANCELLING`, `RESET_COMPARISON`, `DISMISS_ERROR`,
`BASELINE_SELECTED`, `COMPARE_SELECTED`, `MODE_CHANGED`, `FILTERS_UPDATED`,
`EXPORT_STARTED`, `EXPORT_COMPLETE`, `EXPORT_ERROR`,
`SET_TOLERANCES`, `SET_TOLERANCE_FIELD`.

**Tolerance reducer behavior:**
- `SET_TOLERANCES { tolerances:{ color, size, opacity } }`: clamps each value
  through `_clampNumber` (color [0,255], size [0,100], opacity [0,1]),
  falling back to `comparison.defaultTolerances` for non-finite inputs;
  noop if the resulting triple is bit-equal to current state.
- `SET_TOLERANCE_FIELD { field, value }`: updates a single field
  (`color` | `size` | `opacity`) using the same clamp.
- `DISMISS_ERROR` preserves `state.tolerances` (it is not reset on error
  recovery).

**Browser detection:**
`BROWSER_DETECTION_STARTED`, `BROWSERS_DETECTED`, `BROWSER_DETECTION_FAILED`,
`BROWSER_SELECTED`.

**Multi-select (report management):**
`MULTI_SELECT_ENTER`, `MULTI_SELECT_EXIT`, `MULTI_SELECT_TOGGLE`,
`MULTI_SELECT_RANGE`, `MULTI_SELECT_ALL`, `MULTI_SELECT_CLEAR`,
`MULTI_SELECT_AFTER_DELETE`.

**Bulk:**
`BULK_PARSED_ROWS_SET`, `BULK_DETECTION_STATE`, `BULK_JOB_STARTED`,
`BULK_PROGRESS`, `BULK_PAIR_COMPLETED`, `BULK_JOB_COMPLETE`,
`BULK_JOB_CANCELLING`, `BULK_JOB_CANCELLED`, `BULK_JOB_STORAGE_DEGRADED`,
`BULK_JOB_LOADED`, `BULK_JOB_RESET`, `BULK_JOB_RESUMED`,
`BULK_JOB_RESUME_ACCEPTED`, `BULK_JOB_RESUME_OFFERED`,
`BULK_JOB_RESUME_DECLINED`, `BULK_PAIR_OPEN`, `BULK_PAIR_VIEWER_READY`,
`BULK_ACTIVE_PAIR_CLEAR`.

**Key transitions:**
- `EXTRACT_UI_END` / `COMPARE_UI_END` are UI lifecycle events that transition
  `extracting`/`comparing`/`cancelling` back to `idle`/`done`. They are
  dispatched by the workflow after cleanup (progress hide, button reset) — the
  operation itself has already completed or been cancelled.
- `BULK_JOB_CANCELLING` is the user-initiated cancel that keeps `status:'running'`
  but flips a `cancelling` flag so the panel renders "Cancelling…". The
  terminal transition happens when `BULK_JOB_COMPLETE` arrives and checks
  `cancelling` to decide between `cancelled`, `partial`, or `completed`.
- `BULK_JOB_STARTED` optimistically flips the **first pair** to
  `'extracting-baseline'` synchronously (UI spec §9.1 "Optimistic Start")
  so the running view paints within one animation frame.
- `MULTI_SELECT_TOGGLE` exits multi-select mode (resets `active:false`) when
  the toggled-off id causes the set to become empty.
- `MULTI_SELECT_AFTER_DELETE` nulls out `selectedBaseline` / `selectedCompare`
  if the deleted id set contains either. Exits mode if no ids remain.
- `BASELINE_SELECTED` / `COMPARE_SELECTED` are **toggles**: re-dispatching with
  the same id that's already selected sets the value back to `null`.

---

## 10. Persistence Path for a Comparison

A successful `runComparison` returns a `slimResult` to the renderer. From
there, `compare-workflow.js:handleComparison` (single-compare path) and
`bulk-workflow.js _persistPairResult` (bulk path) perform the same writes,
in order. Every `await` corresponds to either a single IDB transaction or a
single message round-trip; transaction boundaries are explicit.

**1. Save the comparison metadata + diffs + summary**
`await storage.saveComparison(meta, sr.comparison?.results ?? [])`.
- **Transaction shape:** `#saveComparisonInner` opens **two** WAL transactions wrapping `#writeComparisonWithEviction` (which holds `[comparisons, comparison_diffs, comparison_summary]` r/w; lookup-by-pair, count `total - bulk` excess, evict oldest non-bulk rows if needed, then write all three).
- **Atomicity:** The three comparison stores commit atomically together (single tx). The WAL bracket is two separate transactions: a crash between them leaves a PENDING WAL row that `applyPendingOperations` would later replay (`SAVE_COMPARISON` is in the known-replayable set).
- **Bulk-path note:** `meta.bulkJobId = jobId` is stamped before the call, so `by_bulkJobId.count()` rises and the row is exempt from the 20-comparison cap.

**2. Save each visual blob**
For each `keyframeId, blobData` in `sr.visualBlobs`, `await storage.saveVisualBlob('${meta.id}:${keyframeId}', blob, meta.id)`.
- **Transaction shape:** `#saveVisualBlobInner` opens WAL r/w, then `[visual_blobs]` r/w, then WAL r/w to complete.
- **Atomicity:** Each blob is its own tx triplet. Blobs are written serially (one `await` per blob), so failure on blob N+1 leaves blobs 0..N persisted with their WAL rows COMPLETE. The N+1 entry stays PENDING and **will not be replayed** — it is force-failed by `applyPendingOperations`.

**3. Save visual keyframes in parallel**
`await Promise.all(sr.visualKeyframes.map(kf => storage.saveVisualKeyframe(kf)))`.
- **Transaction shape:** Each call: one `[visual_keyframes]` r/w tx. **No WAL.**
- **Atomicity:** Each keyframe is its own tx. Concurrent — order not guaranteed. A partial failure leaves some keyframes saved and others not. No replay.

**4. Save visual element rects (batched)**
`await storage.saveVisualElementRects(sr.visualRectRecords)`.
- **Transaction shape:** One `[visual_element_rects]` r/w tx covering all records. **No WAL.**
- **Atomicity:** All-or-nothing per call.

**Bulk-only step 5: Save the bulk-pair patch**
After steps 1–4 succeed, `_persistPairResult` calls `storage.updateBulkPair(pairId, { status:'done', baselineReportId, compareReportId, comparisonId, pct:100, completedAt })`. This is a single `[bulk_pairs]` r/w tx, no WAL bracket on the update path (`#updateBulkPairInner`).

**End-to-end atomicity.** There is no overarching transaction across these
steps. A renderer reload between steps 1 and 4 leaves the comparison
metadata visible to the UI but with missing/partial visual data. The
single-compare path detects this by absence at read time and emits
`Toast.warning('Some visual screenshots could not be saved …')`. The
bulk path logs the error and lets `detectAndOfferResume` reconcile on next
boot.

**Read path** (`tryLoadCachedComparison` / `loadComparisonFromCacheByPairIds`):
one tx per call — `loadComparisonByPair` (`comparisons` r/o), `loadComparisonDiffs`
(`comparison_diffs` r/o). Visual blobs/keyframes are fetched lazily by the
result panel, not eagerly during cache hydration. The bulk pair viewer
additionally calls `ensureBlobsRegisteredForComparison(comparisonId)` which
walks `visual_blobs.by_comparisonId` and re-registers each blob with the
main process via `REGISTER_BLOB` so `app://./blob/...` URLs resolve.

---

## 11. Build Pipeline

| Command | Produces | Depends on (must run before) | Breaks if skipped |
|---|---|---|---|
| `npm run build:extractor` | `dist/extractor-bundle.js` (UMD `__uiCompare`, target chrome 108, target `web`). | — | First extraction throws `"Extractor bundle not found"` from `getExtractorBundleSource`. |
| `npm run build:main` | `dist/index.js`, `dist/preload.js`. Externals: `playwright`, `electron-log`, `electron-updater`, `p-limit` (loaded via dynamic import inside `bulk-runner.js`). Target `electron-main`, target `electron 33`. | — (independent of extractor) | Electron's `main` field cannot be loaded; `electron .` fails. `bail:true` aborts on first error. |
| `npm run build:renderer` | `dist/renderer/app.js` plus copied `index.html` and `styles/` (via the inline `CopyStaticAssetsPlugin`). Target `web`, target chrome 120. The renderer bundle includes `xlsx` (used by the bulk plan parser and summary exporter) plus the bulk workflow / panel modules. | — (independent) | Renderer cannot load; `app://./index.html` 404s on `app.js`. |
| `npm run build` | All three above, in order: extractor → main → renderer. Runs `prebuild` (`scripts/check-env.js`) first. | `PLAYWRIGHT_BROWSERS_PATH` set and contains a `chromium*` directory. | `prebuild` exits with code 1 before webpack runs. |
| `npm run dist[:win/:mac/:linux/:all]` | electron-builder artifacts in `release/`. Re-runs `npm run build` first. `prepackage` re-asserts `PLAYWRIGHT_BROWSERS_PATH`. | `npm run build` outputs in `dist/`. | Without `dist/`, electron-builder ships an empty asar. |
| `npm run smoke-test` | Runs `electron . --smoke-test`; checks bundle existence and `app.getVersion()`; exits 0 or 1. | A built `dist/` tree. | If extractor bundle is missing, exits 1. |
| `npm run lint` | ESLint over the whole repo (root config `.eslintrc.json`; ignores `dist/`, `node_modules/`, `out/`). | — | — |
| `npm run install:browsers` | `playwright install chromium firefox webkit` into `PLAYWRIGHT_BROWSERS_PATH`. | `PLAYWRIGHT_BROWSERS_PATH` set. | Headless launch fails at `getBrowser` with a Playwright-level error. |
| `npm run postinstall` (auto) | `electron-builder install-app-deps` rebuilds native modules against Electron's ABI. | Run on every `npm install`. | Native binding ABI mismatch when packaged. (Currently no `*.node` is actually required by `src/`; `better-sqlite3` is unused.) |

`electron-builder.yml`:

- `asar: true`. `asarUnpack` keeps `dist/extractor-bundle.js`,
  `node_modules/playwright/**`, and any `*.node` outside the asar so Playwright can spawn its browser executables and the extractor bundle can be read by `fs.readFileSync` at runtime.
- `extraResources: .playwright-browsers → browsers`. At runtime
  `src/main/index.js:10-12` sets
  `process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'browsers')` when packaged.
- Targets: macOS dmg (universal), Windows nsis x64 (`signAndEditExecutable: false`), Linux AppImage + deb.

---

## 12. Failure Mode Catalog

Each entry gives the trigger as it appears in source, the visible symptom,
and the recovery code (or "none" when no automatic recovery exists).

### 1. Extractor bundle missing
- **Trigger:** `playwright-manager.js:100-103` after the four-path probe.
- **Symptom:** `runExtraction` rejects with `"Extractor bundle not found"`.
- **Recovery:** None. Run `npm run build:extractor`.

### 2. `PLAYWRIGHT_BROWSERS_PATH` unset / missing chromium
- **Trigger:** `scripts/check-env.js`.
- **Symptom:** `prebuild`/`prepackage` exits 1 before webpack/electron-builder runs.
- **Recovery:** None — manual env var fix.

### 3. Smoke-test missing bundle
- **Trigger:** `src/main/index.js:113-128`.
- **Symptom:** `electron . --smoke-test` prints `[smoke-test] FAIL: extractor-bundle.js not found …` and exits 1.
- **Recovery:** None — fix bundle.

### 4. Boot config invalid
- **Trigger:** `src/config/validator.js` invoked at `src/main/index.js:144` with `{throwOnError:true}`.
- **Symptom:** Main process logs error and `app.quit()`s before window creation.
- **Recovery:** Reset config / fix override.

### 5. `ready-to-show` never fires
- **Trigger:** `src/main/index.js:331-336`.
- **Symptom:** After 8 s, `_showFallbackTimer` calls `applyBoundsAndShow` anyway and logs `"ready-to-show did not fire — showing window anyway"`.
- **Recovery:** Built-in fallback.

### 6. Off-screen saved bounds
- **Trigger:** `_ensureWindowOnScreen`.
- **Symptom:** If saved bounds don't intersect any display, `win.center()` is called; if maximized, unmaximize first.
- **Recovery:** Built-in.

### 7. Renderer bridge missing
- **Trigger:** `src/renderer/app.js:68-84`.
- **Symptom:** Body replaced with fatal banner, `throw new Error('window.electronAPI is undefined')`.
- **Recovery:** None — fix preload path.

### 8. IDB open blocked
- **Trigger:** `idb-repository.js:326-329`.
- **Symptom:** `#getDB` rejects with `"IDB open blocked — close other extension tabs and retry"`.
- **Recovery:** User action.

### 9. IDB write circuit opens
- **Trigger:** `idb-repository.js:235-256` after `CIRCUIT_BREAKER_LIMIT=3` consecutive failures.
- **Symptom:** `storage-degraded` event with `reason:'CIRCUIT_OPEN'` → `SystemBanner.error`. **Bulk runs are auto-cancelled** by `app.js:444-455` (dispatches `BULK_JOB_STORAGE_DEGRADED` and invokes `cancelBulkJob`).
- **Recovery:** None at runtime; must reload.

### 10. WAL replay exhausted
- **Trigger:** `idb-repository.js:701-712` after `replayCount >= 3`.
- **Symptom:** `storage-degraded` event with `reason:'WAL_REPLAY_EXHAUSTED'` → `SystemBanner.warning`.
- **Recovery:** Failed entries retained; no further replay attempted.

### 11. `applyPendingOperations` replay path
- **Trigger:** Called once per renderer boot from `report-manager.js initializeApp`, awaited from `app.js:381`.
- **Symptom:** Pending WAL rows are scanned (`idb-repository.js:670-742`); `SAVE_REPORT`/`SAVE_COMPARISON` replayed up to 3 attempts; `SAVE_VISUAL_BLOB` and unknown ops (incl. `SAVE_BULK_JOB`/`SAVE_BULK_PAIR`) force-failed.
- **Recovery:** Built-in. On exhaustion the WAL row is `FAILED` and a `storage-degraded` event fires.

### 12. `SAVE_VISUAL_BLOB` recovery impossible
- **Trigger:** `idb-repository.js:687-691`.
- **Symptom:** Any pending visual blob WAL entry on next start is force-failed.
- **Recovery:** None — blob must be recaptured.

### 13. `INCOMPATIBLE_URLS` pre-flight (single compare)
- **Trigger:** `playwright-manager.js` `assessUrlCompatibility`.
- **Symptom:** `runComparison` throws with `code:'INCOMPATIBLE_URLS'`; renderer shows `Toast.error("Incompatible URLs …")`.
- **Recovery:** None — user must pick same-path URLs.

### 14. URL `CAUTION` (hash/query mismatch)
- **Trigger:** same path, `compat.classification === 'CAUTION'`.
- **Symptom:** Renderer shows `Toast.warning("URL mismatch …")` and proceeds.
- **Recovery:** Warning only.

### 15. DevTools open during capture
- **Trigger:** `playwright-manager.js` `heightGap > 200` or `widthGap > 200`.
- **Symptom:** Synthetic `Emulation.setDeviceMetricsOverride` bypass; if both pages still produce 0 manifests, returns `status:'skipped'`.
- **Recovery:** Built-in bypass; on total failure, user must close DevTools.

### 16. Debugger conflict / target closed
- **Trigger:** `playwright-manager.js` matches `'already attached' \| 'Target closed' \| 'Page closed'`.
- **Symptom:** Returns `null` from `runTabCapture`; the role is silently degraded.
- **Recovery:** Soft-degrade.

### 17. Frozen Playwright session leftover
- **Trigger:** `recoverFrozenSessions` (`playwright-manager.js`).
- **Symptom:** Probes `_browsers` Map for `vdiff-freeze-styles`; closes any match. Called once at boot from `index.js:211`.
- **Recovery:** **At boot, `_browsers` is empty** — function effectively a no-op.

### 18. `EXPORT_HTML` / `EXPORT_FILE` write errors
- **Trigger:** `ipc-handlers.js`.
- **Symptom:** EACCES → `"Permission denied …"`; EBUSY → `"File is in use …"`; otherwise raw `err.message`.
- **Recovery:** User retries.

### 19. `IMPORT_FILE` read errors
- **Trigger:** `ipc-handlers.js`.
- **Symptom:** ENOENT → `"File not found …"`; EACCES → `"Permission denied …"`.
- **Recovery:** User retries.

### 20. Blob registration with bad ID
- **Trigger:** `ipc-handlers.js:267-270`.
- **Symptom:** Returns `{success:false, error:'blobId must be comparisonId:keyframeId'}`.
- **Recovery:** Caller fixes shape.

### 21. Blob cache pressure
- **Trigger:** `protocol-handler.js`. `MAX_BLOB_CACHE_BYTES = 512 MiB`.
- **Symptom:** When over budget, `_evictOldestComparisonGroup` evicts the entire oldest comparisonId group (LRU by insertion order). Single blobs `> 512 MiB` are silently rejected. If only the active comparison is in cache, the eviction loop refuses to self-evict and logs a warning.
- **Recovery:** Built-in.

### 22. `app://` path traversal
- **Trigger:** `protocol-handler.js:108-111`.
- **Symptom:** Returns `Response('Forbidden', {status:403})` and logs.
- **Recovery:** Built-in.

### 23. `app://` blob cache miss
- **Trigger:** `protocol-handler.js:91-94`.
- **Symptom:** Returns `Response('Blob not found', {status:404})`.
- **Recovery:** Caller must `REGISTER_BLOB` first. The bulk pair viewer's `ensureBlobsRegisteredForComparison` re-registers blobs from IDB after a renderer reload.

### 24. Cancellation during compare/extract
- **Trigger:** `playwright-manager.js _cancelErr` thrown when `isCancelled?.()` returns true.
- **Symptom:** Invoke returns `{success:false, cancelled:true}`. Renderer renders the cancel-line.
- **Recovery:** Soft-recover.

### 25. Visual capture: 0 valid rects
- **Trigger:** `playwright-manager.js`.
- **Symptom:** Returns `{manifest: empty Map, …}`; comparison still completes without screenshots.
- **Recovery:** Soft-degrade.

### 26. Pre-flight: empty element arrays
- **Trigger:** `playwright-manager.js`.
- **Symptom:** Throws `"Baseline elements array is empty …"`.
- **Recovery:** None — caller bug.

### 27. Watch-mode bundle stale
- **Trigger:** `webpack.*.config.js:bail:true`.
- **Symptom:** Watch process exits on compile error; Electron keeps running on stale bundle.
- **Recovery:** Manual restart.

### 28. `dist:all` cross-OS artifacts
- **Trigger:** `package.json` `dist:all` runs `electron-builder -mwl` from one host.
- **Symptom:** Foreign artifacts may be malformed.
- **Recovery:** Use per-OS CI runners.

### 29. Help-menu placeholder URLs
- **Trigger:** `src/main/index.js:85, 88` open `https://github.com/your-org/ui-comparison/...`.
- **Symptom:** Real users hit GitHub 404.
- **Recovery:** Replace before forking.

### 30. macOS traffic-light overlap if class missing
- **Trigger:** `app.js:271-273` adds `platform-darwin` only when `electronAPI.platform === 'darwin'`.
- **Symptom:** Without the class, the `#app-root` left inset is 0 and traffic lights overlap content.
- **Recovery:** Built-in conditional.

### 31. Browser detection failed at boot
- **Trigger:** `GET_AVAILABLE_BROWSERS` returns `{ success:false, error }`, or the renderer-side promise rejects (`app.js:405-422`).
- **Symptom:** `browserDetectionState:'error'`. Workflows refuse with `setError(... 'Browser detection still running …')`.
- **Recovery:** User clicks Retry → `detectBrowsers({ refresh:true })`.

### 32. No launchable browsers detected
- **Trigger:** `availableBrowsers.length === 0` after a successful `BROWSERS_DETECTED`.
- **Symptom:** Selector shows "No browsers detected"; workflows refuse with "No browser available — install Playwright browsers (npm run install:browsers)".
- **Recovery:** User runs `npm run install:browsers`.

### 33. Browser launch blocked by IT policy
- **Trigger:** `playwright-manager.js:130-146` matches `/DevTools remote debugging is disallowed/i`, `/remote.debugging.*disallowed/i`, or `/Target page.*context.*browser has been closed/i`.
- **Symptom:** Throws `Error("This browser is blocked by your organisation's IT policy …")` with `code:'BROWSER_POLICY_BLOCKED'`. IPC return is `{ success:false, error }`. Renderer surfaces it via `Toast.error`.
- **Recovery:** Pre-emptive: Windows Chrome with `RemoteDebuggingAllowed=0` is marked `isLaunchable:false` at detection time. Reactive: switch to Playwright Chromium.

### 34. System Firefox / WebKit selected and attempted
- **Trigger:** Detection lists them as `isLaunchable:false` with `unavailableReason:'playwright-requires-patched-build'`.
- **Symptom:** Selector renders disabled; `_onChange` rejects silently.
- **Recovery:** Use the Playwright-managed descriptor instead.

### 35. WebKit screenshot path → Chromium fallback
- **Trigger:** `runComparison` (`playwright-manager.js:1524-1550`) catches a screenshot-phase error from a WebKit descriptor whose message matches `/Page\.snapshotRect|snapshot/i`.
- **Symptom:** Sends a "Retrying screenshots on Chromium…" progress label, re-runs `_runScreenshotPhase` with the Chromium descriptor, and pushes `{ kind:'screenshot-engine-fallback', from:'webkit', to:'chromium', reason }` into `visualData.devToolsWarnings`. Matching unaffected.
- **Recovery:** Built-in. If the Chromium retry also fails, the original error path applies.

### 36. Bulk plan rejected at parse time
- **Trigger:** `core/bulk/plan-parser.js parsePlanWorksheet` returns `{ error }` when (a) workbook is empty / lacks `!ref`, (b) duplicate column header (case-insensitive), (c) missing `baseline_url` or `compare_url`, (d) row count exceeds `bulk.maxRows = 500`.
- **Symptom:** Renderer renders the parse error in the bulk panel; `bulkDetectionState` stays `'error'`. No job is created.
- **Recovery:** User edits the workbook.

### 37. Bulk row marked `invalid`
- **Trigger:** `core/bulk/plan-validator.js validateOneRow` returns `status:'invalid'` for any of: non-`http(s)://` URL, unknown `mode`, `assessUrlCompatibility` is `INCOMPATIBLE`, `browser` cell does not resolve to any launchable descriptor.
- **Symptom:** Row is excluded from `pairs[]` but still appears in the downloaded Excel summary with `status: invalid` and the validation reason.
- **Recovery:** None at run-time. The job runs as long as at least one valid row remains.

### 38. Bulk reused-side delivery timeout
- **Trigger:** `bulk-runner.js _awaitProvided(side)` rejects after `10_000 ms` if the renderer never delivers via `BULK_PROVIDE_ELEMENTS`.
- **Symptom:** Pair `BULK_PAIR_COMPLETED` with `status:'failed'`, `errorCode:'STORAGE_DEGRADED'`, error message `"Timed out waiting for provided elements"`.
- **Recovery:** Restart the bulk job. Most likely cause is a circuit-breaker open between dedup planning and the post-start element push.

### 39. Bulk runner fatal (uncaught throw)
- **Trigger:** The `.catch` of the dispatch wrapper inside `_registerBulkHandlers` (`ipc-handlers.js:417-426`).
- **Symptom:** `BULK_JOB_COMPLETE` is still emitted with `summary: { total:N, succeeded:0, failed:N, cancelled:0, deduped:0 }, error: <message>`. Job entry deleted from `_bulkJobs`.
- **Recovery:** Renderer reduces the job to `failed`; user can re-run.

### 40. Bulk job interrupted by app close
- **Trigger:** `detectAndOfferResume` finds a `bulk_jobs` row with `status === 'running'` at boot.
- **Symptom:** All in-flight pairs (`status ∈ {extracting-baseline, extracting-compare, matching, screenshots, persisting}`) are flipped to `failed` with `errorCode:'INTERRUPTED'` via `storage.updateBulkPair`. Banner offers Resume / View partial / Discard.
- **Recovery:** **Resume** re-runs only the incomplete pairs (`queued` + `INTERRUPTED`-failed) under a fresh `comparisonId` per pair, with concurrency re-clamped against current host RAM. **View partial** marks the job `partial` and shows what was completed. **Discard** cascade-deletes the job (`storage.deleteBulkJobCascade`).

### 41. Multiple interrupted bulk jobs
- **Trigger:** `detectAndOfferResume` finds more than one `running` job.
- **Symptom:** Sorts by `createdAt` desc, picks the newest, marks every older job `failed` (logged as a warning).
- **Recovery:** Built-in. The older jobs remain in the `bulk_jobs` store and are visible via the export path until cascade-deleted.

### 42. Bulk-job retention overflow
- **Trigger:** `#saveBulkJobInner` sees `count() >= BULK_MAX_RETAINED_JOBS=10`.
- **Symptom:** The `count - 10 + 1` oldest jobs (by `by_createdAt` ascending, excluding the job being written) are cascade-deleted, including all derived reports / comparisons / blobs / keyframes / rects / pairs.
- **Recovery:** Built-in.

---

## 13. Browser Detection & Capability Profiles

Source: `src/main/browser-detector.js` (Node, main process) and
`src/config/browser-capability-profile.js`.

### 13.1 Detector entry point

`detectBrowsers({ refresh = false })`:

1. **Cache short-circuit.** If `_cache !== null && !refresh`, returns the cached `{ browsers, detectedAt }` immediately.
2. **Playwright-managed probes.** Always pushes a Chromium descriptor (with `isDefault:true`); pushes Firefox/WebKit descriptors only when the binary exists. Each is built by `_detectPlaywrightManaged` which calls `pw[browserType].executablePath()` and tests `_isExecutable(path)`.
3. **System probes.** Dispatches to `_detectMacBrowsers` / `_detectWinBrowsers` / `_detectLinuxBrowsers` based on `process.platform`. All probe failures are logged and swallowed — detection never throws to the IPC handler.
4. Caches and returns `{ browsers, detectedAt: new Date().toISOString() }`.

`_resetCache()` is exported for tests; not used at runtime.

### 13.2 Per-OS strategies

**macOS** (`MAC_CANONICAL_APPS`): canonical apps in `/Applications` and
`~/Applications`: Google Chrome (channel `chrome`), Microsoft Edge (channel
`msedge`), Firefox, Brave, Safari. Probes `<root>/<App>.app/Contents/MacOS/<binary>`
for executability. Version read by `/usr/libexec/PlistBuddy` against
`Info.plist`'s `CFBundleShortVersionString`, fallback `mdls -name
kMDItemVersion -raw`. `VERSION_TIMEOUT_MS=3000`.

**Windows** (`WIN_CANONICAL_PATHS`): Chrome (chrome), Edge (msedge), Firefox,
Brave. Two-stage resolution:

1. Query `HKLM`/`HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\<exe>` via `reg.exe` (`REG_TIMEOUT_MS=3000`); parse `REG_SZ`/`REG_EXPAND_SZ`/`REG_MULTI_SZ` value.
2. Fallback: walk `ProgramFiles`, `ProgramFiles(x86)`, `LOCALAPPDATA\Programs`, `LOCALAPPDATA` joined with `canonicalSubpaths`.

Version read via `wmic datafile … get Version /value`, fallback `powershell.exe -NoProfile (Get-Item …).VersionInfo.ProductVersion`.

**Linux** (`LINUX_BROWSERS`): Chrome, Chromium, Edge, Firefox, Brave. Tries
hard-coded canonical absolute paths first (`/usr/bin/*`, `/opt/*`,
`/snap/bin/*`), then walks `$PATH` for any of the per-browser `binNames`.
Version read via `<binary> --version` (regex `\d+\.\d+(?:\.\d+){0,3}`).

### 13.3 Descriptor shape

Both `_buildSystemDescriptor` and `_detectPlaywrightManaged` produce:

```
{
  id,                  // 'system-chrome' | 'system-edge' | 'system-firefox' |
                       // 'system-brave' | 'system-chromium' | 'system-safari' |
                       // 'playwright-chromium' | 'playwright-firefox' | 'playwright-webkit'
  displayName,         // human label
  browserType,         // 'chromium' | 'firefox' | 'webkit'
  source,              // 'playwright-managed' | 'system'
  channel,             // 'chrome' | 'msedge' | null
  executablePath,      // string when source==='system' AND not in canonical install root;
                       //   null when channel resolution applies or source==='playwright-managed'
  version,             // string or null
  isAvailable,         // detection saw the binary
  isLaunchable,        // we'll actually launch it
  isDefault,           // currently only true for Playwright-managed Chromium
  unavailableReason,   // null | 'binary-not-found' | 'version-mismatch' |
                       //   'playwright-requires-patched-build' |
                       //   'unsupported-os' | 'devtools-blocked-by-policy'
}
```

**Channel vs executablePath rule** (`_isCanonicalForChannel`): if the resolved
binary lives in a canonical install root for its OS, the descriptor uses
`channel` and `executablePath` is null. Otherwise it uses `executablePath`
and `channel` is null.

### 13.4 Read-only system installs

`_buildSystemDescriptor` short-circuits for two engines:

- **Firefox (system)**: `isLaunchable:false`, `unavailableReason:'playwright-requires-patched-build'`, `displayName: '<name> (system — read-only)'`.
- **WebKit / Safari (system)**: same treatment, `displayName: '<name> (read-only)'`.

### 13.5 Chrome DevTools-policy block (Windows only)

`_isChromeBlockedByDevToolsPolicy` probes
`HKLM/HKCU\SOFTWARE\Policies\Google\Chrome\RemoteDebuggingAllowed`. If `0`,
the Chrome descriptor is built with `isLaunchable:false`,
`unavailableReason:'devtools-blocked-by-policy'`. Even if the user side-steps
the disabled state, `getBrowser` catches the runtime "DevTools remote
debugging is disallowed" error and rethrows with `code:'BROWSER_POLICY_BLOCKED'`.

### 13.6 Capability profiles

`src/config/browser-capability-profile.js` exports two frozen records:

**`BROWSER_CAPABILITY_PROFILES`** drives the capture pipeline (§6):

| Field | chromium | firefox | webkit |
|---|---|---|---|
| `cdpAvailable` | `true` | `false` | `false` |
| `screenshotMethod` | `'cdp-webp'` | `'playwright-png'` | `'playwright-png'` |
| `screenshotMimeType` | `'image/webp'` | `'image/png'` | `'image/png'` |
| `freezeMethod` | `'cdp-script-disable'` | `'js-shim'` | `'js-shim'` |
| `metricsOverrideAvailable` | `true` | `false` | `false` |
| `viewportOverrideMethod` | `'cdp-emulation'` | `'playwright-set-viewport'` | `'playwright-set-viewport'` |
| `deviceScaleFactorOverride` | `true` | `false` | `false` |
| `bringToFront` | `'cdp'` | `'playwright'` | `'playwright'` |
| `expectedScrollbarGutterPx` | `15` | `17` | `0` |
| `subPixelScrollAccurate` | `true` | `true` | `true` |
| `requiresLayoutWarmup` | `false` | `false` | `true` |

`_effectiveDprFor(browserType)` returns `CAPTURE_SCALE_FACTOR=2` only when
`deviceScaleFactorOverride` is true (chromium). `attachSession` reads
`freezeMethod` (via `cdpAvailable`) to decide CDP vs shim path.

**`BROWSER_NORMALIZATION_PROFILES`** is consumed by the normalization layer:

| Field | chromium | firefox | webkit |
|---|---|---|---|
| `requiresFontFamilyDequote` | `false` | `true` | `true` |
| `requiresLineHeightNormalize` | `true` | `true` | `true` |
| `requiresBoxShadowReorder` | `false` | `false` | `true` |
| `requiresFontWeightCanonicalize` | `true` | `true` | `true` |

### 13.7 Renderer ↔ main contract

The renderer guarantees:

- `BROWSER_DETECTION_STARTED` is dispatched before any `getAvailableBrowsers()` call.
- `BROWSER_SELECTED` is only dispatched when the user picks a browser whose `isLaunchable === true`.
- The `browser` field passed to `START_COMPARISON` / `EXTRACT_ELEMENTS` is exactly `{ browserType, channel, executablePath }` extracted from the selected descriptor.
- For bulk: each `pairs[i].browser` is the **resolved** descriptor from `plan-validator.js` (which preferred per-row `browser` cells over the job-level `selectedBrowser`).

The main process guarantees:

- `getBrowser` cache key includes the channel/executablePath, so two different system Chromium installs end up as distinct `Browser` instances. The cache is shared across single-extract, single-compare, and bulk-runner code paths.
- A second call from another concurrent operation reuses an open `Browser` if `isConnected()`.
- `shutdownPlaywright` (called from `app.before-quit`) closes every cached browser.

---

## 14. Bulk Pipeline

The bulk subsystem spans renderer (parser, validator host, dedup planner,
workflow coordinator, panel UI, persistence) and main (plan-agnostic runner
that dispatches per-pair extractions and comparisons under a `p-limit`
gate). Source files:

- `src/core/bulk/plan-parser.js` — xlsx → row records.
- `src/core/bulk/plan-validator.js` — row-level validation.
- `src/core/bulk/extraction-key.js` — SHA-256 dedup key (`url|browserType|channelOrPath|YYYY-MM-DD`).
- `src/core/export/bulk-summary-exporter.js` — `Bulk Summary` xlsx + plan template builder.
- `src/core/export/bulk-pair-state-labels.js` — state→label map and `getErrorHint(errorCode)`.
- `src/main/bulk-runner.js` — main-side orchestrator.
- `src/main/ipc-handlers.js _registerBulkHandlers` — channels + per-job `_bulkJobs` registry.
- `src/renderer/application/bulk-workflow.js` — renderer orchestrator (dedup, IPC bridge, persistence, resume).
- `src/renderer/components/bulk-panel.js` — drop zone, parse summary, controls, virtual pair list, resume banner host.

### 14.1 Plan format

Required headers: `baseline_url`, `compare_url` (case-insensitive matching;
duplicate headers reject the workbook). Optional headers, in canonical order
used by the template (`bulk-summary-exporter.js TEMPLATE_HEADERS`):
`mode` (`dynamic`/`static`, default `dynamic`), `filter_class`, `filter_id`,
`filter_tag`, `screenshots` (truthy tokens `true|yes|1`, falsy
`false|no|0`, empty inherits the job-level toggle), `label`, `browser`
(canonical `chromium`/`firefox`/`webkit` or any displayName from the live
catalogue, empty inherits job-level).

Hard cap: `bulk.maxRows = 500` (`config/defaults.js:251`). Workbooks above
that are rejected with the row-count quoted in the error.

### 14.2 Validation

`plan-validator.js validatePlanRows(rows, jobOptions, availableBrowsers)`:

- URL must start with `http://` or `https://`.
- `mode` must be `dynamic` or `static`.
- `assessUrlCompatibility(baseline, compare)` must not be `INCOMPATIBLE` (paths must match; `CAUTION` becomes a `warning` row that still runs).
- `browser` cell resolution: tries canonical `browserType` match (preferring `isDefault`-true descriptors), then `displayName` match. Non-launchable matches fall through to `null`. If the cell has a value but the catalogue is empty (renderer hasn't finished detection), the row keeps the job-level descriptor — i.e. detection-not-ready does not invalidate the row.

Output: `{ valid, warnings, invalid }`. Warning rows are pushed to **both** `valid` and `warnings` (warnings are advisory). Each enriched row carries `validationStatus`, `validationReason`, and `resolvedBrowser` (the descriptor actually selected).

### 14.3 Deduplication

`computeDeduplicationPlan(pairs, { forceRefresh })` (in `bulk-workflow.js`)
hashes each side's `(url, browserType, channelOrPath, YYYY-MM-DD)` via
`buildExtractionKey` (SHA-256 over the pipe-joined string, hex-encoded;
`crypto.subtle.digest` runs in the renderer). It then queries
`storage.loadReportByExtractionKey(extractionKey)` (which uses the v9
`reports.by_extractionKey` index and picks the newest hit). Hits become
`pair.dedupedSides.{baseline|compare} = { reportId }`. `forceRefresh:true`
short-circuits the entire computation. `_persistPairResult` later stamps
`extractionKey` on the freshly-saved report (`saveReport(...,
{ extractionKey })`) so subsequent runs will hit the index.

### 14.4 Concurrency clamp

Two layers:

- **Renderer** — `_clampConcurrency(requested, totalMemMB, heterogeneous)` (in `bulk-workflow.js` and again in `bulk-panel.js`). Reads `bulk.maxConcurrency` from `defaults.js` (default `4`). If `totalMemMB < 12 * 1024` the cap halves to `min(2, maxConcurrency)`. If the plan is heterogeneous (per-row `browserType` differs from the job-level descriptor) **and** the host is RAM-constrained, the result is forced to **1**.
- **Main** — `_registerBulkHandlers` independently clamps to `[1, defaultsConfig.bulk.maxConcurrency]` regardless of what the renderer sent.

Host memory is fetched via `GET_HOST_MEMORY` and memoised once per renderer session.

### 14.5 Bulk runner mechanics (`bulk-runner.js`)

Per-job state held by the main-process IPC handler:
```
_bulkJobs.set(jobId, {
  opIds:                Set<string>,    // every per-pair / per-side opId for cancel propagation
  startedAt,
  pLimitInstance:       pLimit(safeConcurrency),
  filename,
  providedElements:     Map<'pairIdx:side', element[]>,
  providedWaiters:      Map<'pairIdx:side', { resolve, reject }>,
})
```

`runBulkJob(jobSpec, pushEvent, isMasterCancelled, ctx)`:

1. Dynamically `import('p-limit')` (ESM-only) and instantiate `pLimit(safeConcurrency)`. `ctx.setLimitInstance` records it back into the job entry so `CANCEL_BULK_JOB` can call `clearQueue()`.
2. Per-pair function `_runPair(pair)`:
   - Allocates three opIds: pair-level + per-side baseline + per-side compare. Each is registered in the global `_cancelRegistry` and added to the job's `opIds` Set (so cancel can flip them all).
   - Builds `filters` from `pair.filterClass` / `filterId` / `filterTag` (or `null` if none).
   - Branches per side:
     - If `pair.dedupedSides[side]` exists: emits `'Reused recent extraction'` progress and awaits `ctx.awaitProvidedElements(pairIndex, side, 10_000)` for the renderer to deliver the cached elements. Times out → `STORAGE_DEGRADED`.
     - Else: applies `_hostGate(url)` (per-host cooldown wait based on `bulk.hostCooldownMs`, default 500), then calls `playwrightManager.runExtraction({ url, browser, filters, onProgress, isCancelled })`. `onProgress` maps `0..100` → `0..25` of the pair's outer pct.
   - Awaits both sides via `Promise.allSettled`. Either rejection → `BULK_PAIR_COMPLETED` with the classified `errorCode` and `status:'failed'`/`'cancelled'`.
   - Calls `playwrightManager.runComparison({ comparisonId, baselineId, compareId, mode, baselineUrl, compareUrl, baselineElements, compareElements, includeScreenshots, browser, blobCache, isCancelled, onProgress })`. The `onProgress` here maps inner `5..80` → outer `50..80` (matching), inner `80..100` → outer `80..95` (screenshots).
   - Emits final `BULK_PAIR_COMPLETED` with the slim result, the original report descriptors (so the renderer can persist them), and `deduped` indicator.
3. Wraps every `_runPair` in `limit(...)` and `Promise.all`s the slot promises. After all settle, emits `BULK_JOB_COMPLETE` with `{ summary, durationMs }` and calls `ctx.cleanupJob(jobId)` (which rejects any orphan `providedWaiters` and removes the job entry).

### 14.5a Progress mapping (per-pair pct)

Each pair's outer `pct` (0–100) is composed from inner sub-operation progress:

| Phase | Inner range | Outer range | Notes |
|---|---|---|---|
| Baseline extraction | 0–100 | 0–25 | |
| Compare extraction | 0–100 | 0–25 | Overlaps baseline; UI shows `max(baseline, compare)` |
| Matching | 5–80 | 50–80 | Inner offset accounts for comparator startup |
| Screenshots | 80–100 | 80–95 | |
| Persisting | — | 95–100 | Renderer-synthesised animation (4 ticks over 900 ms) |

The `persisting` phase is never emitted by main — the renderer animates
95→97→99→100 via `_runPersistingPhaseAnimation` to give visual feedback
while IDB writes execute.

### 14.5b Host gate (`_hostGate`)

Per-hostname cooldown enforced between extraction dispatches during bulk runs.
Extracts hostname via `new URL(url).hostname`, looks up last dispatch time in
a module-level `hostLastDispatch` Map, and sleeps the remaining cooldown
(`bulk.hostCooldownMs`, default 500 ms). If `cooldownMs === 0`, the gate is a
no-op. This prevents overwhelming a single origin with concurrent requests.

### 14.6 Error classification

`_classifyError(err)` in `bulk-runner.js` maps caught errors to a stable
code via code property check first, then regex pattern matching on message:

| Code | Trigger pattern |
|---|---|
| `CANCELLED` | `err.code === 'CANCELLED'` or message contains `cancelled` |
| `BROWSER_POLICY_BLOCKED` | `err.code === 'BROWSER_POLICY_BLOCKED'` or `/devtools.*disallowed\|policy/i` |
| `BROWSER_NOT_FOUND` | `/unknown browsertype\|executable not found\|browser not installed/i` |
| `TIMEOUT` | `/timeout\|timed out/i` |
| `CSP_BLOCKED` | `/refused to (load\|execute)\|addscripttag\|csp/i` |
| `INCOMPATIBLE_URLS` | `err.code === 'INCOMPATIBLE_URLS'` |
| `UNKNOWN` | default fallback |

Error messages are sanitized to 500 characters with whitespace collapsed.

Friendly hints surfaced in the bulk panel are looked up by `getErrorHint`
in `core/export/bulk-pair-state-labels.js`:

| Code | User-facing hint |
|---|---|
| `TIMEOUT` | "The page took too long to respond. Check if the URL is accessible." |
| `CSP_BLOCKED` | "Script injection was blocked. Try a different browser in the selector." |
| `BROWSER_NOT_FOUND` | "The selected browser could not launch. Switch to Playwright Chromium." |
| `BROWSER_POLICY_BLOCKED` | "This browser is blocked by your organisation's IT policy. Switch to Playwright Chromium." |
| `INCOMPATIBLE_URLS` | "The two URLs have different paths. Update the plan and re-upload." |
| `STORAGE_DEGRADED` | "Storage stopped accepting writes. Restart the app to recover." |
| `INTERRUPTED` | "This pair was running when the app was last closed." |
| (other) | "An unexpected error occurred. Check the URL and try again." |

### 14.7 Persistence (renderer)

`_persistPairResult(payload)` in `bulk-workflow.js` runs after every
successful `BULK_PAIR_COMPLETED`:

1. For each side that **wasn't** reused: `storage.saveReport({ ...report, bulkJobId, extractionKey })`. Reused sides skip the save and reuse the existing `reportId`.
2. `storage.saveComparison(meta, slim.comparison.results)` with `meta.bulkJobId = jobId`.
3. Visual blobs (`saveVisualBlob` per keyframe), keyframes (`Promise.all saveVisualKeyframe`), rect records (`saveVisualElementRects`).
4. `storage.updateBulkPair(pairId, { status:'done', baselineReportId, compareReportId, comparisonId, pct:100, completedAt })`.
5. `loadAndRenderReports()` — refresh the sidebar.

The `persisting` state machine in the UI is **renderer-synthesised** by
`_runPersistingPhaseAnimation`: 95→97→99→100 over 900 ms, then dispatches
`BULK_PAIR_COMPLETED` to the reducer. Real persistence runs in parallel.

### 14.8 Resume protocol

`detectAndOfferResume()` runs once at boot (`app.js:393`), after
`initializeApp` (which itself awaits `applyPendingOperations`). It loads
every `bulk_jobs` row, filters for `status === 'running'` (interrupted
jobs), keeps the newest by `createdAt` and marks any older interrupted
jobs `failed`. It then loads the chosen job's pairs, flips any pair whose
status is in `_IN_FLIGHT_PAIR_STATUSES` (`extracting-baseline`,
`extracting-compare`, `matching`, `screenshots`, `persisting`) to
`status:'failed', errorCode:'INTERRUPTED'` (both in IDB and in memory).

If incomplete pairs remain, `dispatch('BULK_JOB_RESUME_OFFERED', …)` and
`_renderResumeBanner` injects the banner with three buttons:
- **Resume** → `_handleResumeAccepted` allocates a fresh `comparisonId` per incomplete pair, re-clamps concurrency against current host RAM, marks the job `running` (with `resumedAt`), dispatches `BULK_JOB_RESUME_ACCEPTED`, and invokes `BULK_START_JOB` again with only the incomplete pairs.
- **View partial results** → marks the job `partial`, completes silently.
- **Discard** → `storage.deleteBulkJobCascade(jobId)` (removes job + every derived row across nine stores), dispatches `BULK_JOB_RESUME_DECLINED` with `cascade:true`.

### 14.9 Export

`routeBulkExportClick` enriches each pair (in batches of 5) by re-loading its
saved comparison via `storage.loadComparisonByPair(baselineReportId,
compareReportId, mode)` and matching its baseline/compare reports from
`state.reports`. The enriched array, the original job, and any
parser-level `invalid` rows are passed to `buildBulkSummaryWorkbook` from
`core/export/bulk-summary-exporter.js`. The workbook contains a single
`Bulk Summary` sheet with 24 columns (pair index, label, both URLs, mode,
filters, screenshots flag, browser, status, failure_reason, deduped,
totals, match-rate, add/remove/modify counts, severity counts, duration_ms,
comparison_id) — header row uses `export.excel.headerColor`; failed-row
status cells use `criticalColor`; cancelled/invalid-row status cells use
`mediumColor`; deduped-not-`none` cells highlight.

The matching `buildBulkTemplateWorkbook` produces a two-sheet template
(`Plan` + `Instructions`). Both are saved through `EXPORT_FILE`.

---

## 15. CI / Release Pipeline

Source: `.github/workflows/release-build.yml`. Triggered on `workflow_dispatch`
(manual dispatch only — no automatic release on push/tag).

### 15.1 Jobs

| Job | Runner | Steps | Artifact |
|---|---|---|---|
| `build-win` | `windows-latest` | checkout v5 → setup-node v5 (Node 22) → set `PLAYWRIGHT_BROWSERS_PATH=$GITHUB_WORKSPACE/.playwright-browsers` → `npm ci` → `npx playwright install chromium` → `npm run dist:win` (`CSC_IDENTITY_AUTO_DISCOVERY=false`) → upload-artifact v4 | `windows-installer` (`*.exe`, `*.blockmap`, `latest.yml`) |
| `build-mac` | `macos-latest` | same flow → `npm run dist:mac` (`CSC_IDENTITY_AUTO_DISCOVERY=false`) → upload-artifact v4 | `mac-installer` (`*.dmg`) |

**No Linux job exists.** Add one following the same template if
AppImage/deb artifacts are needed for distribution.

### 15.2 Notes

- Both jobs install only Chromium (not Firefox/WebKit) because the packaged
  app bundles from `.playwright-browsers/` and can install the remaining
  engines at user discretion post-install.
- Code signing is disabled (`CSC_IDENTITY_AUTO_DISCOVERY=false`) — replace
  with real signing credentials for production distribution.
- The workflow does not run tests before packaging (no `npm run lint` or
  `npm run smoke-test` step). Consider adding a quality gate job.

---

## Verification answer: v5/v8 ordering

The existing `runUpgrade` in `idb-repository.js:217-226` runs the v8 block
before the v5 block (and now the v10 block last). The exact controlling
conditions are `if (oldVersion < 8) { upgradeToV8(db); }` followed by
`if (oldVersion < 5) { upgradeToV5(upgradeTx); }`. For a fresh install going
0 → 10, every `oldVersion < N` condition is true and every block runs.

What would *actually* break if v8 ran *after* v5 in source order? **Nothing,
under IDB version-change semantics.** Both `db.createObjectStore(...)` calls
execute synchronously on the same `versionchange` transaction (`upgradeTx`)
and become visible in `db.objectStoreNames` immediately. The v5 block's
`upgradeTx.addEventListener('complete', …)` fires *after* `upgradeTx`
auto-commits — by which point every `createObjectStore` from this upgrade is
fully persisted, regardless of internal call order. The fresh
`db.transaction([STORE_APP_META], 'readwrite')` inside that listener
will therefore find `app_meta` either way.

Furthermore, the listener is explicitly defensive at line 143:

```js
if (!db.objectStoreNames.contains(STORE_APP_META)) { return; }
```

Even if `app_meta` were genuinely missing, the listener would silently no-op
rather than throw. The current ordering of v8 before v5 is therefore
**defensive code organization, not a load-bearing functional requirement.**
The IDB transaction-level guarantee is: every `createObjectStore` invoked
during a single `versionchange` transaction is visible in
`db.objectStoreNames` from the moment of invocation through commit, and the
`complete` event fires only after commit.

The same reasoning applies to v9 and v10: v9 adds two new stores (`bulk_jobs`,
`bulk_pairs`) and three new indexes on existing stores; v10 adds `sauce_jobs`.
All of those mutations happen synchronously on `upgradeTx`; their visibility
to the post-commit `complete` listener is guaranteed regardless of the textual
ordering relative to the older blocks.

---

## 16. SauceLabs Pipeline

Source: `src/main/saucelabs-manager.js`, `src/main/saucelabs-binary-manager.js`
(main process), `src/renderer/application/saucelabs-workflow.js` (renderer),
`src/renderer/components/saucelabs-panel.js` (UI).

### 16.1 Binary resolution hierarchy

`sauceBinaryManager.resolveBinaryPath(opts)` (`saucelabs-binary-manager.js:199-244`)
resolves the `saucectl` binary in strict priority order. Each level is attempted
sequentially; the first that produces a parseable semver version wins.

**Level 1 — Downloaded binary in app data directory.**

| Platform | Path |
|---|---|
| Windows | `%APPDATA%/ui-comparison-desktop/saucectl/bin/saucectl.exe` |
| macOS | `~/Library/Application Support/ui-comparison-desktop/saucectl/bin/saucectl` |
| Linux | `~/.config/ui-comparison-desktop/saucectl/bin/saucectl` |

All three derive from `app.getPath('userData')` + `/saucectl/bin/` + `PLATFORM_BINARY`.

**Level 2 — Bundled binary in app resources.**
- Packaged: `process.resourcesPath/saucectl/saucectl[.exe]` (maps to the
  `extraResources` entry in `electron-builder.yml`).
- Development: `app.getAppPath()/resources/saucectl/saucectl[.exe]`.

**Level 3 — Binary on system PATH.**
Scans `process.env.PATH` (split on `;` on Windows, `:` elsewhere). On Windows,
three candidate filenames are checked per directory: `saucectl.exe`,
`saucectl.cmd`, `saucectl` (in that order). On POSIX, only `saucectl`.

**Level 4 — Setup error.** If no candidate produces a valid version,
`resolveBinaryPath()` returns `null`. The `SAUCE_VALIDATE_CREDENTIALS` handler
detects this and returns `{ success: false, error: 'saucectl not found ...' }`
before attempting any API call.

**Version check timeout.** Each candidate is verified by spawning
`saucectl --version` with a hard `opts.timeoutMs ?? 5000` ms wall-clock limit
(`_getVersionFromBinary`, line 120-158). If the process does not exit within
the timeout, it is `SIGKILL`'d and the binary is treated as non-functional,
falling through to the next level. The timeout absorbs cold-start AV scans on
Windows without blocking the SauceLabs tab behind a slow disk.

**Windows `.cmd` resolution.** When the PATH search finds a `.cmd` or `.bat`
shim (common with `npm install -g`), `_resolveSpawnCommand` (line 88-118) reads
the shim content, parses `%~dp0%\<relative-path>` or `node "<script>"` patterns,
resolves the target to an absolute path, and returns
`{ executable: process.execPath, prefixArgs: [scriptPath] }`. This means
`_spawnSaucectl` and `_getVersionFromBinary` spawn `node saucectl.js` rather
than `cmd /c saucectl.cmd`, which is critical because `child_process.spawn` is
called with `shell: false` (the default) — spawning a `.cmd` without a shell
errors on Windows. `shell: false` is intentional: it avoids command-injection
risk from user-controlled environment variables.

**Module-level caching.** Once resolved, `_resolvedPath` and `_resolvedVersion`
are cached at module scope. All subsequent calls to `getResolvedPath()` and
`getResolvedVersion()` return the cached values until the process restarts or
`runUpdateCheck` overwrites them.

### 16.1a Update check lifecycle

Triggered by `_registerSauceHandlers` during `SAUCE_VALIDATE_CREDENTIALS`
handling: after binary resolution succeeds, `runUpdateCheck(compatibleRange)`
is called as a fire-and-forget background operation.

**Firing conditions:**
- Fires at most once per process (guarded by `_updateCheckDone` flag).
- Deferred if `opts.hasActiveJobs()` returns true (active `sauce_jobs` rows
  in `submitted`/`running`/`downloading`). The flag is reset so the next
  credential validation re-triggers. Deferral avoids replacing a `.exe` on
  Windows while a child spawned from it is alive (which returns EBUSY).
- Never fires on app startup — only on the first SauceLabs tab interaction.

**Sequence:**
1. `GET https://api.github.com/repos/saucelabs/saucectl/releases/latest`
   (15 s timeout, optional `GITHUB_TOKEN` auth header if env var set).
2. Parse `tag_name` → strip leading `v` → validate as semver.
3. Reject if latest does not satisfy `compatibleSaucectlRange` (`>=0.200.0 <1.0.0`).
4. Skip if resolved version is already ≥ latest.
5. Map `process.platform:process.arch` → asset filename via `ASSET_MAP`.
6. Download archive + `checksums.txt` from GitHub releases.
7. SHA-256 verify: `crypto.createHash('sha256')` on the archive → compare with
   entry in `checksums.txt` matching the asset filename. Mismatch → delete
   archive → abort.
8. Extract binary from archive (PowerShell `Expand-Archive` on Windows, `tar -xzf`
   elsewhere), write to `.tmp` file, `fs.renameSync` over the target. The atomic
   rename guarantees no corrupt binary on crash.

**Failure handling.** Any failure (network, rate-limit 403/429, checksum mismatch,
write error) is logged and silently swallowed. The existing binary continues to
be used. The update check never blocks the user and never shows an error dialog.

### 16.2 Job lifecycle

#### Extraction flow

```
renderer                          main (fire-and-forget)
─────────────────────────────────────────────────────────
sauceSubmitJob(payload) ────────► _registerSauceHandlers
  ← { success:true, jobId }
                                  sauceManager.submitExtraction({...})
                                    1. _registerJob(jobId, ...)
                                    2. Write tmp: .sauce/config.yml + tests/extract.spec.js
                                    3. _spawnSaucectl(saucectl run ...)
                                    4. _parseSauceSessionId(stdout)
                                    5. _pollSessionUntilDone(...)  ← adaptive backoff
                                    6. _downloadArtifact(extraction-result.json)
                                    7. Download screenshots-manifest.json + keyframes
                                    8. Stamp report with engine/platform/sessionId
                                  ┌─ onProgress callbacks → SAUCE_JOB_PROGRESS
                                  └─ .then → SAUCE_JOB_COMPLETE { report, manifest }
```

#### Comparison flow

```
renderer                          main (fire-and-forget)
─────────────────────────────────────────────────────────
sauceSubmitComparison(payload) ──► _registerSauceHandlers
  ← { success:true, jobId }
                                  sauceManager.submitComparison({...})
                                    1. _registerJob(jobId, ...)
                                    2. Promise.all([
                                         _submitSingleSession({side:'baseline'}),
                                         _submitSingleSession({side:'compare'}),
                                       ])
                                    3. Cross-session abort: if one side fails polling,
                                       siblingAbort.abort() cancels the other's poll
                                    4. _pollSessionUntilDone() × 2 (parallel)
                                    5. _downloadSessionArtifacts() × 2 (parallel)
                                    6. Stamp both reports
                                  ┌─ onProgress → SAUCE_JOB_PROGRESS
                                  ├─ onSessionId → SAUCE_JOB_PROGRESS { baselineSessionId, compareSessionId }
                                  └─ .then → SAUCE_JOB_COMPLETE { baselineReport, compareReport, ... }
```

#### Partial failure + retry

If one session completes but the other fails/times-out, `submitComparison`
throws an error decorated with `{ partiallyFailed:true, partiallyFailedSession,
baselineSessionId, compareSessionId, baselineStatus, compareStatus }`. The IPC
handler's `.catch` emits `SAUCE_JOB_COMPLETE` with these fields. The renderer
persists status `'partially_failed'` in `sauce_jobs`. The user can then invoke
`sauceRetryFailedSession`, which re-submits only the failed side, polls it,
downloads both sessions' artifacts (the successful side's from the original
session ID — if already on disk, the download is skipped), and emits a fresh
`SAUCE_JOB_COMPLETE` with both reports.

### 16.3 Cancellation

Each job is registered in `_jobRegistry` (`Map<jobId, Entry>`) where the
entry contains:

- `controller: AbortController` — signal polled by `_interruptibleSleep` and `_pollSessionUntilDone`
- `procs: Set<ChildProcess>` — in-flight saucectl children
- `sessionIds: Set<string>` — known remote session IDs (populated as stdout is parsed)
- `creds: { username, accessKey, region }` — for remote session DELETE
- `cancelled: boolean` — gate checked by `_throwIfCancelled`

`cancelJob(jobId)`:
1. Sets `entry.cancelled = true`
2. Calls `entry.controller.abort()` — unblocks all sleeping poll loops
3. SIGTERM → 3 s delay → SIGKILL every tracked child process
4. `DELETE /rest/v1/{user}/jobs/{sessionId}` for all tracked sessions
   (via `Promise.allSettled` — one slow DELETE does not block the other)

`_throwIfCancelled(jobId)` is checked after saucectl exit, after session ID
resolution, and before polling begins. Raises `JobCancelledError` to abort
the pipeline.

### 16.4 saucectl YAML generation

`_generateYaml(...)` (`saucelabs-manager.js:336-405`) produces
`.sauce/config.yml`. All caller-provided strings (build name, tags, tunnel
name, tunnel owner) flow through `_sanitiseYamlScalar` first
(max-length check, newline rejection, backslash + double-quote escape) to
prevent YAML injection.

```yaml
apiVersion: v1alpha
kind: playwright
sauce:
  region: <region>
  concurrency: <concurrency>          # 1 for extraction; 1..5 for comparison
  metadata:
    build: "<sanitised buildName>"     # e.g. "ui-compare 2026-05-24T11:12"
    tags: ["ui-comparison", "<tag>", ...]
  tunnel:                              # only if tunnelName provided
    name: "<sanitised tunnelName>"
    owner: "<sanitised tunnelOwner>"   # only if tunnelOwner provided
  visibility: "<visibility>"           # private|team|share|public restricted|public
playwright:
  version: <playwrightVersion>         # e.g. 1.57.0 — must be in
                                       # SAUCE_SUPPORTED_PLAYWRIGHT_VERSIONS
suites:
  - name: "<suiteName>"
    platformName: "<platform>"
    screenResolution: "<resolution>"
    timeout: <timeout>                 # e.g. 5m, 10m, 15m, 20m, 30m
    params:
      browserName: "<browser>"         # chromium|chrome|firefox|webkit
      headless: false
    testMatch: ["tests/extract.spec.js"]
artifacts:
  download:
    when: always
    match: ["extraction-result.json", "screenshots-manifest.json", "keyframe-*.webp"]
    directory: ./artifacts/
```

**Sanitisation rules** (`_sanitiseYamlScalar`):
- Build name max 255 chars, tunnel name/owner max 128, tag max 64.
- Newlines (`\r` or `\n`) anywhere in any of these fields throws
  `"<fieldName> must not contain newline characters"`.
- `\` and `"` are escaped (`\\\\`, `\\"`).

**Compatibility validation.** Before emitting YAML, `_generateYaml` calls
`isValidCombination(playwrightVersion, platform, browserName)` from
`@core/saucelabs-bridge/constants.js`. If the combination is not in the
matrix, a warning is logged but the YAML is still emitted (the user has
opted into the combo via the panel and SauceLabs will return its own
validator error if invalid).

**SauceLabs supported matrix** (`SAUCE_COMPATIBILITY_MATRIX`):

| Playwright version | Platforms | Browsers | Exclusions |
|---|---|---|---|
| 1.58.2 / 1.58.1 | Win 10/11, macOS 14/15 | chromium, chrome, firefox, webkit | macOS 15 + firefox |
| 1.57.0 | Win 10/11, macOS 12/13 | chromium, chrome, firefox, webkit | macOS 12 + webkit |
| 1.56.1 / 1.55.1 | Win 10/11, macOS 12/13 | chromium, chrome, firefox | — |
| 1.54.1 / 1.52.0 / 1.50.1 / 1.49.1 | Win 10/11, macOS 12/13 | chromium, chrome, firefox, webkit | macOS 12 + webkit |

`SAUCE_SUPPORTED_PLAYWRIGHT_VERSIONS` is `['1.58.2', '1.58.1', '1.57.0',
'1.56.1', '1.55.1', '1.54.1', '1.52.0', '1.50.1', '1.49.1']` —
descending order. The default selected by the panel UI is
`SAUCE_SUPPORTED_PLAYWRIGHT_VERSIONS[2]` (`1.57.0`), which also matches
`saucelabs.defaultPlaywrightVersion`.

`SAUCE_SUPPORTED_BROWSERS = ['chromium', 'chrome', 'firefox', 'webkit']`.
`chrome` is a new addition — it represents the VM-installed Chrome (vs
`chromium` which is the Playwright-bundled engine).
`SAUCE_SUPPORTED_VISIBILITIES = ['private', 'team', 'share', 'public restricted', 'public']`.
`SAUCE_SUPPORTED_REGIONS = ['us-west-1', 'eu-central-1', 'us-east-4']`.

### 16.4a Mobile devices (`MOBILE_DEVICES`)

`MOBILE_DEVICES` (`saucelabs-bridge/constants.js:65-74`) is a frozen list of
emulated mobile profiles selectable via the Mobile execution mode in the
SauceLabs panel. Each entry now carries an explicit `viewport` and
`deviceScaleFactor`, used by both the test-script `test.use({...})` call
and (when `orientation === 'landscape'`) the staging step that flips
viewport dimensions:

| Device | OS | Engine | Viewport | DPR |
|---|---|---|---|---|
| iPhone 13 / iPhone 14 | iOS | webkit | 390×844 | 3 |
| iPhone 14 Pro Max | iOS | webkit | 430×932 | 3 |
| iPad Pro 11" | iPadOS | webkit | 834×1194 | 2 |
| Pixel 5 | Android | chromium | 393×851 | 2.75 |
| Pixel 7 | Android | chromium | 412×915 | 2.625 |
| Galaxy S9+ | Android | chromium | 320×658 | 4.5 |
| Galaxy S24 | Android | chromium | 384×854 | 2.8125 |

**Orientation handling.** The panel exposes an Orientation `<select>`
(portrait | landscape) when Mobile is selected. The collected device payload
becomes
`{ name, orientation:'portrait'|'landscape', viewport:{width,height}, deviceScaleFactor, isMobile:true, hasTouch:true }`.
In `_stageRunnerProject`, when `orientation === 'landscape'` the viewport is
swapped (`{ width: h, height: w }`) before being written into `job.json`. The
extract spec (`extract.spec.js:131-148`) merges any `device.viewport` /
`userAgent` overrides on top of Playwright's `devices[name]` descriptor; if
the descriptor is unknown, it constructs a minimal context from the supplied
viewport/UA/DPR/touch fields directly.

### 16.5 Test script staging

The Playwright test script that runs on the SauceLabs VM lives in source
at `src/saucelabs-runner/extract.spec.js` and is bundled separately via
`webpack.saucelabs-runner.config.js` to `dist/saucelabs-runner/extract.spec.js`
(plus `keyframe-grouper.js` and `schemas.js`). At submission time
`_stageRunnerProject(tmpBase, ...)` (`saucelabs-manager.js:290-323`) copies
those four files plus `dist/extractor-bundle.js` into a fresh tmp project:

```
<tmpBase>/
  .sauce/config.yml          (generated by _generateYaml)
  tests/
    extract.spec.js          (copied verbatim from dist)
    keyframe-grouper.js      (copied verbatim from dist)
    schemas.js               (copied verbatim from dist)
    extractor-bundle.js      (copied from dist/extractor-bundle.js)
    job.json                 (per-run config)
```

The `tests/job.json` is the runtime contract between main and the
remote test (validated by `validateJobConfig` from `schemas.js`):

```json
{
  "url": "<target>",
  "filters": { "class": "...", "id": "...", "tag": "..." } | null,
  "maxScreenshots": 200,
  "configOverrides": {
    "extraction": {
      "batchHardCapMs": 30,
      "maxElements": 10000,
      "skipInvisible": true,
      "stabilityWindowMs": 500,
      "hardTimeoutMs": 20000
    }
  },
  "testTimeoutMs": 600000,
  "device": null | {
    "name": "<Playwright device name>",
    "orientation": "portrait" | "landscape",
    "viewport": { "width": N, "height": N },
    "deviceScaleFactor": N,
    "isMobile": true,
    "hasTouch": true
  }
}
```

**Landscape orientation handling.** When `device.orientation === 'landscape'`,
`_stageRunnerProject` swaps `viewport.{width,height}` before writing
`job.json`. The spec then either spreads any `device.viewport`/`userAgent`
overrides on top of Playwright's built-in `devices[name]` descriptor, or
constructs a minimal context from the supplied
`{ viewport, userAgent, isMobile, hasTouch, deviceScaleFactor }` if the
device name is unknown.

**Script execution steps (executed on the SauceLabs VM):**
1. Load `tests/job.json` and validate via `schemas.js validateJobConfig`.
2. `test.use(...)` if `device.name` is set (with override merging).
3. Navigate to the URL (`page.goto`, 60 s timeout).
4. Readiness gate: if filters produce a `compoundSelector`, wait for that
   selector (30 s) then wait for descendant-count stabilisation (polling
   750 ms, timeout 30 s). Without a selector: `networkidle` (15 s) + DOM
   count > 100.
5. Inject extractor bundle via
   `page.addScriptTag({ content: EXTRACTOR_BUNDLE })` (read from disk in
   `tests/extractor-bundle.js`).
6. Run extraction:
   `page.evaluate(() => window.__uiCompare.extractWithConfig(filters, cfg))`.
7. Write `extraction-result.json`.
8. Measure element rects via `page.evaluate` on `selectorPairs` (CSS
   selectors from `el.cssSelector`).
9. `groupIntoKeyframes(validRects, viewportHeight, viewportWidth,
   documentHeight)` — imported from the staged `keyframe-grouper.js`.
10. If keyframes exceed `maxScreenshots` (default 200): sort by
    `elementIds.length` descending, keep top N, re-sort by `scrollY`,
    re-index IDs.
11. Freeze animations (inject `<style>` with
    `animation-play-state:paused !important; transition-duration:0s !important`).
12. For each keyframe: `window.scrollTo(0, kf.scrollY)`, settle,
    `page.screenshot({ type:'webp', quality:85, fullPage:false })`, write
    `keyframe-N.webp`.
13. Write `screenshots-manifest.json` with per-keyframe entries (`id`,
    `scrollY`, `viewportWidth`, `viewportHeight`, `elementIds`,
    `filename`) and the `elementKeyframeMap` (HPID → keyframe ID).

**Artifact schema written by the script:**
```
extraction-result.json       — same shape as runExtraction returns
screenshots-manifest.json    — { keyframes: [...], elementKeyframeMap: { [hpid]: kfId } }
keyframe-0.webp ... N.webp   — viewport screenshots at keyframe scroll positions
```

**Build prerequisite.** `npm run build:saucelabs-runner` must produce all
four staged files before any SauceLabs job can be submitted; the
runner-staging path probe throws a descriptive error otherwise (listing
each missing file).

### 16.6 Polling

`_pollSessionUntilDone(...)` (`saucelabs-manager.js:590-677`) hits
`GET /rest/v1/{username}/jobs/{sessionId}` repeatedly.

| Elapsed time | Interval |
|---|---|
| 0–2 min | 10 s |
| 2–5 min | 20 s |
| 5–10 min | 30 s |
| >10 min | 60 s |

**Error handling:**
- Up to 8 consecutive API errors (`MAX_CONSECUTIVE_ERRORS`) before declaring failure
- Exponential backoff on errors: `min(baseInterval × 2^(n-1), 5 min)`
- HTTP 401 → immediate failure ("Credentials expired during polling")
- HTTP 429 → treated as a consecutive error (rate-limited)
- Session status `complete`/`passed` → success
- Session status `error`/`failed` → failure
- 90-minute total elapsed → `timed_out`

Sleep is interruptible: the job's `AbortController.signal` and an optional
`externalSignal` (used for cross-session abort in comparison mode) both wake
the sleep early via event listener on `'abort'`.

### 16.7 The `_parseSauceSessionId` contract

`_parseSauceSessionId(stdout)` (`saucelabs-manager.js:561-588`) extracts a
SauceLabs session UUID from saucectl's stdout. The parser has an intentional
rejection rule:

**Priority 1 — URL path match.** Regex: `app.saucelabs.com/tests/<UUID>`.
Takes priority over all other patterns because it is the most specific.

**Priority 2 — Labelled match.** `job:` or `session:` followed by a UUID.

**Priority 3 — Bare UUID scan with rejection filter.** Scans for any UUID
pattern. For each match, inspects the 32 characters preceding the match. If
`_REJECT_LABEL_RE` (`/(?:storageId|checksum|config)\s*[:=]?\s*$/i`) matches
that prefix, the UUID is **skipped**. This prevents matching artifact checksums,
upload storage IDs, or config hash UUIDs that saucectl also prints. The first
UUID that passes the rejection filter wins.

**Priority 4 — UUID-without-dashes.** Pattern: `job` followed by a 32-character
hex string on the same line. Converted to standard UUID via `_toUuidWithDashes`
(inserts dashes at positions 8-12-16-20).

**Why `storageId` must not be matched.** saucectl prints `storageId=<UUID>` for
the uploaded test bundle. This UUID identifies the artifact in SauceLabs'
internal storage, not the session. If it were matched as the session ID, polling
would hit `GET /rest/v1/{user}/jobs/{storageId}` and get 404 indefinitely until
the 90-minute timeout. The rejection filter is what prevents this.

### 16.8 IDB v10 schema: `sauce_jobs` store

**Store:** `sauce_jobs` (constant `STORE_SAUCE_JOBS`, `idb-repository.js:20`).
**keyPath:** `id`. **Created in:** `upgradeToV10` (line 218-224).

**Indexes:**
- `by_status` → `status`, not unique
- `by_createdAt` → `createdAt`, not unique

**Full record schema:**

```
{
  id:                    string,      // crypto.randomUUID()
  status:               'submitted' | 'running' | 'downloading' | 'comparing'
                      | 'partially_failed' | 'done' | 'failed' | 'timed_out'
                      | 'cancelled',
  baselineStatus:       'submitted' | 'running' | 'complete' | 'failed'
                      | 'timed_out' | 'cancelled' | null,
  compareStatus:        'submitted' | 'running' | 'complete' | 'failed'
                      | 'timed_out' | 'cancelled' | null,
  partiallyFailedSession: 'baseline' | 'compare' | null,
  url:                  string | null,        // extraction-only jobs
  baselineUrl:          string | null,        // comparison jobs
  compareUrl:           string | null,
  platform:             string,
  browserName:          string,
  screenResolution:     string,
  region:               string,
  tunnelName:           string | null,
  filters:             object | null,
  baselineSessionId:   string | null,
  compareSessionId:    string | null,
  sessionId:           string | null,         // extraction-only jobs
  baselineArtifactDir: string | null,
  compareArtifactDir:  string | null,
  artifactsDir:        string | null,         // extraction-only jobs
  comparisonId:        string | null,         // cross-ref to comparisons store
  baselineReportId:    string | null,
  compareReportId:     string | null,
  reportId:            string | null,         // extraction-only jobs
  kind:                'extraction' | 'comparison',
  error:               string | null,
  createdAt:           number,                // Date.now()
  completedAt:         number | null,
  lastPolledAt:        number | null,
  baselinePollStartedAt: number | null,
  comparePollStartedAt:  number | null
}
```

**Status enum — complete set with sub-states:**
- `submitted` — IPC handler returned, saucectl not yet spawned or session ID not yet known.
- `running` — at least one session ID is known and polling is active.
- `downloading` — both sessions completed, artifacts being fetched.
- `comparing` — artifacts downloaded, `Comparator.compare()` running locally.
- `partially_failed` — exactly one session completed successfully, the other failed/timed-out. `partiallyFailedSession` names which side. Retryable.
- `done` — terminal. Comparison persisted to IDB.
- `failed` — terminal. Both sessions failed, or an unrecoverable error occurred.
- `timed_out` — terminal. Polling exceeded 90-minute budget.
- `cancelled` — terminal. User cancelled.

**`credentials_required` is NOT a persisted status.** It is a renderer-only
overlay: dispatched by `detectAndResumeSauceJobs()` when in-flight rows exist
but `_creds === null`. The IDB row retains its original status unchanged.

**Retention policy.** `saucelabs.maxRetainedJobs = 20` (in `config/defaults.js:304`).
Enforced in `#saveSauceJobInner` — oldest rows beyond the limit are deleted.

**Cross-reference integrity with `comparisons` store.** A `sauce_jobs` row is
not evicted while its `comparisonId` references a comparison that is still
present in the `comparisons` store. If the comparison is evicted by the existing
`MAX_COMPARISONS = 20` LRU, its eviction path nulls out the `sauce_jobs.comparisonId`
field in the same logical save sequence. This prevents dangling references in
either direction. Artifact directories (`baselineArtifactDir`, `compareArtifactDir`)
are `fs.rm`'d when the row is deleted (by retention, user dismissal, or cancel).

### 16.9 Dual-session state machine

The top-level `status` is a **derived projection** of two independent
`baselineStatus` / `compareStatus` fields. Both advance on their own poll loops.

**Per-session sub-status transitions** (each applies independently):
```
submitted ──[session ID recovered]──► running
running   ──[poll → complete/passed]──► complete  (terminal)
running   ──[poll → error/failed]───► failed     (terminal)
running   ──[90 min elapsed]────────► timed_out  (terminal)
running   ──[user cancel]──────────► cancelled   (terminal)
```

**Top-level derivation rules:**
| Both sub-statuses | Top-level status |
|---|---|
| Both `submitted` | `submitted` |
| At least one `running`, neither terminal | `running` |
| Both `complete` | `downloading` → `comparing` → `done` |
| One `complete`, other ∈ {`failed`,`timed_out`} | `partially_failed` |
| Both ∈ {`failed`,`timed_out`} | `failed` |
| Either `cancelled` | `cancelled` |

**The `partially_failed` → `running` transition** occurs when the user clicks
"Retry Failed Session": the failed side's sub-status resets to `submitted`→`running`,
`partiallyFailedSession` is cleared, and a new session ID is allocated. The
successful side's artifacts are preserved and reused without re-download.

### 16.10 Post-comparison keyframe filter (Scenario C)

After both sessions' artifacts are downloaded and `Comparator.compare()` runs
locally in `_handleComparisonComplete` (`saucelabs-workflow.js:449-535`), a
filtering step executes **before visual data is written to IDB**.

**What it does.** `_computeDiffKeyframeIds(comparisonResults, baselineManifest,
compareManifest)` (line 553-572):
1. Iterates comparison results, collecting HPIDs where `totalDifferences > 0`
   into `diffHpids`.
2. For each diff HPID, looks up `baselineManifest.elementKeyframeMap[hpid]` and
   `compareManifest.elementKeyframeMap[hpid]` to find which keyframe IDs cover
   that element.
3. Returns the union as `diffKeyframeIds: Set<string>`.

**How the manifest provides the mapping.** The generated test script writes
`elementKeyframeMap` (an object keyed by HPID, valued by the covering keyframe's
`id` field) alongside the `keyframes` array. This field is what allows the
renderer to project from diff-set HPIDs to keyframe IDs without re-running the
grouper.

**What `_persistFilteredVisualData` does.** Only keyframes whose `kf.id` is in
`diffKeyframeIds` are written to `visual_keyframes` and `visual_blobs`. Keyframes
covering exclusively non-diff elements are never persisted — their screenshot
bytes are discarded in-memory after download.

**Why it exists.** The test script captures ALL elements (it cannot know which
will diff before comparison runs). Without the filter, every keyframe from both
sessions would be persisted, producing tens of MB of WebP blobs in IDB for pages
with hundreds of elements. The filter achieves the theoretical minimum IDB
footprint: only keyframes that visualise actual diffs are retained.

**What breaks if it is removed.** Every keyframe from both sessions is persisted
to `visual_blobs` (up to `maxScreenshotsPerSession × 2 = 400` keyframes per
comparison). IDB size balloons. The UI still works (it looks up only diff-related
keyframes), but storage consumption becomes unbounded relative to diff count.

### 16.11 Credential flow across the IPC boundary

**Where credentials live in the renderer.** Module-level `let _creds = null` in
`saucelabs-workflow.js:12`. This is a closure-scoped slot in the application
layer — not a component-level variable. It survives tab navigation because
the module is loaded once by webpack and stays resident until the renderer
process is unloaded.

**How they survive tab navigation.** The SauceLabs panel is destroyed and
recreated on each navigation to/from the tab, but `_creds` lives in the
workflow module above the component layer. When the panel re-mounts, it calls
`getCredentials()` and pre-fills the form from the cached value.

**How they cross to the main process.** Every IPC call
(`SAUCE_SUBMIT_JOB`, `SAUCE_SUBMIT_COMPARISON`, `SAUCE_CANCEL_JOB`,
`SAUCE_RETRY_FAILED_SESSION`) reads `_creds` and includes `{ username,
accessKey, region }` in its payload. The main process is stateless with respect
to credentials between calls — it reads them from the payload, uses them for
the SauceLabs REST API call or as `SAUCE_USERNAME`/`SAUCE_ACCESS_KEY` env vars
passed to the saucectl child, then drops the reference. The only main-process
retention is inside the `_jobRegistry` entry's `creds` field, which is used by
`cancelJob` to issue `DELETE` calls after the renderer may have navigated away.

**What happens on app restart.** `_creds` is `null`. In-flight jobs are detected
by `detectAndResumeSauceJobs()` querying `sauce_jobs` for non-terminal statuses.
`SAUCE_CREDENTIALS_REQUIRED` is dispatched with the count of in-flight jobs.
The panel renders a banner: "Re-enter credentials above to resume." Polling does
not start until the user validates credentials via the same flow as initial login.

### 16.12 Close-and-resume lifecycle

**What is persisted at submission time.** The entire `sauce_jobs` record
(see §16.8) is written to IDB immediately after `SAUCE_SUBMIT_JOB` /
`SAUCE_SUBMIT_COMPARISON` returns `{ success:true, jobId }` — before the main
process has spawned saucectl. Fields like `baselineSessionId`, `compareSessionId`,
`comparisonId` start as `null` and are patched incrementally as the job
progresses via `storage.updateSauceJob(jobId, patch)`.

**What `detectAndResumeSauceJobs()` does on boot** (`saucelabs-workflow.js:294-330`):
1. Queries `sauce_jobs` store via `loadSauceJobsByStatus(['submitted', 'running',
   'downloading', 'comparing', 'partially_failed'])`.
2. If results > 0, dispatches `SAUCE_CREDENTIALS_REQUIRED` with `{ count }`.
3. Dispatches `SAUCE_JOB_LOADED` with the most-recent job (by `createdAt` descending),
   populating the job status card in the UI.
4. Returns. No polling is started.

**The `SAUCE_CREDENTIALS_REQUIRED` dispatch.** This triggers the panel to show
the credentials form with a contextual message. It does NOT modify the IDB row's
`status` — `credentials_required` is a renderer-only overlay.

**The resume path** (after the user re-enters credentials via `validateAndStoreCredentials`):
1. `_creds` is set.
2. `_resumeInFlightJobs()` is called (line 402-435).
3. It queries `sauce_jobs` for in-flight rows (excluding `partially_failed`).
4. Dispatches `SAUCE_JOB_LOADED` with the most recent job (which re-populates
   the UI job card). The main process's fire-and-forget work continues
   independently — if the session completed during shutdown, the next
   `SAUCE_JOB_COMPLETE` event will arrive when the main-process polling (if
   still running) or the next submission finishes.

**Limitation:** The current implementation does not re-initiate main-process
polling for jobs that were in-flight before restart. It relies on the main
process's own `sauceManager` state, which is lost on restart. The resume path
restores the UI state and allows the user to retry or cancel, but a session
that completed while the app was closed must be retried to get results.

### 16.13 Configuration

All SauceLabs tunables live under `config.saucelabs` in `src/config/defaults.js:293-304`:

| Key | Default | Purpose |
|---|---|---|
| `compatibleSaucectlRange` | `>=0.200.0 <1.0.0` | Semver range for binary resolution + auto-update |
| `versionCheckTimeoutMs` | `5000` | Timeout for `saucectl --version` probe |
| `maxScreenshotsPerSession` | `200` | Cap on keyframe screenshots per extraction |
| `pollTimeoutMs` | `90 * 60 * 1000` (90 min) | Maximum polling duration before declaring timeout |
| `maxRetainedJobs` | `20` | IDB retention limit for `sauce_jobs` store |
| `defaultPlaywrightVersion` | `'1.57.0'` | YAML `playwright.version` when caller omits it |
| `defaultConcurrency` | `1` | YAML `sauce.concurrency` when caller omits it |
| `defaultTimeout` | `'15m'` | YAML per-suite `timeout` when caller omits it |
| `defaultVisibility` | `'team'` | YAML `sauce.visibility` when caller omits it |
| `defaultTags` | `['ui-comparison']` | YAML `sauce.metadata.tags` when caller omits it |

Additionally, `saucectlTimeoutMs` (default 10 min, `saucelabs-manager.js:1051`) caps
how long a single `saucectl run` child process is allowed to execute before SIGKILL.

**Concurrency clamp inside `_generateYaml`.** The argument is treated as
valid only if `Number.isFinite(c) && 1 <= c <= 10`; anything else falls
back to `defaultConcurrency`. The panel UI only exposes 1–5 in the
`<select>` to match common SauceLabs concurrent-session entitlements.

### 16.14 Renderer-side state management

`saucelabs-workflow.js` dispatches the following actions:

- **Credential state** — `SAUCE_CREDENTIAL_VALIDATING` / `SAUCE_CREDENTIAL_VALID` / `SAUCE_CREDENTIAL_FAILED` / `SAUCE_CREDENTIAL_RESET`
- **Job state** — `SAUCE_JOB_SUBMITTED` / `SAUCE_JOB_PROGRESS` / `SAUCE_JOB_COMPLETE` / `SAUCE_JOB_FAILED` / `SAUCE_JOB_PARTIALLY_FAILED` / `SAUCE_JOB_CANCELLED` / `SAUCE_JOB_RESET`
- **Comparison state** — `SAUCE_COMPARISON_SUBMITTED`
- **Persistence** — `SAUCE_PERSIST_WARNING` (non-fatal IDB save failure)
- **Resume** — `SAUCE_CREDENTIALS_REQUIRED` / `SAUCE_JOB_LOADED`

On `SAUCE_JOB_COMPLETE` with comparison data, the workflow runs the
`Comparator` locally (same matching/diffing pipeline as the local compare
flow), persists reports + comparison + filtered visual keyframes to IDB, and
registers keyframe blobs in the protocol cache for immediate UI rendering.
The persisted comparison row carries a `tolerancesSnapshot` mirroring the
boot-time defaults (the cloud comparator does not yet honour the user's
tolerance profile — see §17 for the local-compare path that does).

**Persisted Sauce job fields (panel-supplied metadata).** When a job is
written to `sauce_jobs`, the renderer payload now also persists:
`playwrightVersion`, `concurrency`, `buildName`, `tags`, `visibility`,
`timeout`, `tunnelOwner`. These are reused on `retrySauceJob` so a retry
keeps the original parameters.

### 16.15 Failure modes

| Failure | Detection | Recovery |
|---|---|---|
| saucectl binary not found | `resolveBinaryPath()` returns null | Error returned to UI; user must install saucectl |
| Credentials invalid | HTTP 401 from activity endpoint | UI shows error; user re-enters credentials |
| Account lacks Playwright entitlement | HTTP 403 or 200 without concurrency data | Error: "Account cannot create Playwright sessions" |
| Concurrent session limit hit | Pattern match on saucectl stdout (`/concurrent session limit/i`) | `_sauceKnownFailure` error surfaced to UI |
| Session timeout (90 min) | `_pollSessionUntilDone` elapsed check | Job marked `timed_out`; user can retry |
| saucectl process timeout (10 min) | `setTimeout` SIGKILL in `_spawnSaucectl` | Error surfaced; session may still be running remotely |
| API unreachable (8 retries) | `consecutiveErrors >= MAX_CONSECUTIVE_ERRORS` | Job marked `failed` |
| One session fails, other succeeds | `partiallyFailed` flag on error | UI offers retry for failed side only |
| Both sessions fail | Neither sub-status is `complete` | Job marked `failed` |
| Cross-session abort | One side's poll returns non-complete → `siblingAbort.abort()` | Other side's poll wakes early and marks cancelled |
| IDB write failure during persist | `try/catch` in `_handleComparisonComplete` | `SAUCE_PERSIST_WARNING` dispatched; job data in memory only |
| Checksum mismatch on update | SHA-256 comparison | Update aborted; existing binary retained |
| GitHub rate limit (403/429) | Response status code | Update check skipped silently |
| Session ID not parseable from stdout | `_parseSauceSessionId` returns null | Fallback: `_recoverSessionId` via `GET /rest/v1/{user}/jobs?limit=1` |

---

## 17. Tolerance Profile System

The CSS diff engine's tolerances (`color`, `size`, `opacity`) are no longer
hard-coded per mode. They live in a **single user-overridable profile**
that:

- Boots from `comparison.defaultTolerances` in `config/defaults.js:211`
  (`{ color:8, size:5, opacity:0.05 }`).
- Is loaded once at app start from IDB store `app_settings`, key
  `tolerance_profile`.
- Is editable inline from the Compare panel's **Tolerance** group
  (three numeric inputs in `index.html:262-278`).
- Is stamped onto every saved comparison so historical reports retain the
  threshold under which they were judged.

### 17.1 Sources of truth

| Layer | Where | Notes |
|---|---|---|
| Boot defaults | `config/defaults.js:211` | Frozen, deep-frozen. Validated by `validateDefaultTolerances` in `validator.js`. Required path; ranges checked. |
| User override (persisted) | IDB `app_settings` row `key='tolerance_profile'` | Schema: `{ key, tolerances:{ color, size, opacity }, updatedAt }`. Single row at most. |
| Live in renderer | `state.tolerances` | Seeded from boot defaults in `initialState`. Replaced by `SET_TOLERANCES` after `loadToleranceProfile()` resolves at boot. Updated incrementally by `SET_TOLERANCE_FIELD` per keystroke. |
| Per-comparison snapshot | `comparisons.tolerancesSnapshot` (and `comparison.tolerancesSnapshot` after read) | Embedded into `meta` by `compare-workflow.js handleComparison` from `resolveActiveTolerances(getState())`. Bulk and SauceLabs paths stamp the boot defaults instead (they don't yet honour user override). |

### 17.2 Lifecycle

```
boot
 └─ initializeApp() (report-manager.js:828)
     ├─ applyPendingOperations()    [WAL replay]
     └─ storage.loadToleranceProfile()
         ├─ if record exists → dispatch('SET_TOLERANCES', { tolerances })
         └─ else            → state.tolerances stays at boot defaults

user types a value in #tolerance-color/-size/-opacity (app.js:679-696)
 └─ on 'input': dispatch('SET_TOLERANCE_FIELD', { field, value })
     └─ persistTolerancesDebounced() — 300 ms debounce
         └─ storage.saveToleranceProfile({ tolerances: resolveActiveTolerances(state) })
 └─ on 'change' (blur): persistTolerancesImmediate() — flushes debounce

user clicks Compare (compare-workflow.js handleComparison)
 └─ const activeTolerances = resolveActiveTolerances(getState())
 └─ api.startComparison({ ..., tolerances: activeTolerances })
 └─ tolerancesSnapshot = { ...activeTolerances }
     └─ stamped on meta + on the dispatched COMPARISON_COMPLETE result

result panel renders (result-panel.js)
 └─ result.tolerancesSnapshot drives the "Tol C/S/O" badge in the summary bar.
     Legacy rows without the field show "Tolerances: —" with explanatory tooltip.
```

### 17.3 IPC contract

`START_COMPARISON` accepts a `tolerances:{ color, size, opacity }` field
(see §3). Main forwards it to `playwrightManager.runComparison`, which
forwards it to `comparator.compare(..., tolerances)`. If null/omitted, the
comparator falls back to `comparison.defaultTolerances` (the boot
defaults). Bulk and Sauce comparison paths currently send no tolerance
override — they always use boot defaults.

### 17.4 IDB API surface

Two new methods on `IDBRepository` (`idb-repository.js:1521-1565`):

- `saveToleranceProfile({ tolerances })` — enqueued through the write
  queue (so a circuit-open state correctly halts the save). Validates
  `app_settings` exists (defensive — a v11+ DB always has it). Returns
  `{ success:true }` or `{ success:false, error }`. **No WAL bracket** —
  loss of a single in-flight save degrades gracefully (the user simply
  re-types).
- `loadToleranceProfile()` — bypasses the write queue (read-only path);
  returns the record or `null` (also `null` on read error or missing
  store).

### 17.5 Reducer rules (`state.js`)

- `_clampNumber(value, min, max, fallback)` is the shared helper. Non-finite
  → `fallback`; out-of-range → clamped.
- `SET_TOLERANCES` accepts a payload `{ tolerances }`; non-object payloads
  fall back to boot defaults. Each field is clamped: color [0,255], size
  [0,100], opacity [0,1]. Returns the prior state unchanged if the
  resulting triple matches current state (avoids spurious re-renders).
- `SET_TOLERANCE_FIELD` accepts `{ field:'color'|'size'|'opacity', value }`.
  Unknown field → noop. Same clamp/no-op rules.
- `DISMISS_ERROR` preserves `state.tolerances` explicitly — error recovery
  must not reset the user's profile.

### 17.6 Boot config validation

`validateDefaultTolerances(errors)` (`validator.js:167-189`) is invoked
during `validateConfig` at `src/main/index.js:144` with
`{ throwOnError:true }`. Failures abort startup with `app.quit()`:

- `comparison.defaultTolerances` must be an object (not array).
- `color` is a number in [0, 255]; `size` in [0, 100]; `opacity` in [0, 1].

The legacy `comparison.tolerances.*` paths are no longer required.
Per-mode `comparison.modes.{static,dynamic}.tolerances` are also gone — the
validator was updated in lock-step.

---

## 18. Theme System (Light / Dark)

The renderer ships both a dark and a light theme, switchable from the
status bar. The HTML export inherits the user's choice via
`localStorage`.

### 18.1 In-app theme

- **Tokens.** `src/renderer/styles/tokens.css` defines two `:root` variants:
  `[data-theme="dark"]` (the default) and `[data-theme="light"]`. Every
  component stylesheet consumes `--color-*` / `--font-*` / `--space-*` /
  `--radius-*` / `--shadow-*` / `--z-*` / `--motion-*` tokens — never
  hard-coded HEX values.
- **Bootstrap.** A blocking inline script at the top of
  `src/renderer/index.html:4-18` reads `localStorage.ui-theme`. If no
  value is stored, it derives `'light'` from
  `prefers-color-scheme: light`, otherwise defaults to `'dark'`. Sets
  `document.documentElement.setAttribute('data-theme', t)` synchronously
  to avoid a flash of unthemed content.
- **Toggle.** `#theme-toggle` lives in the status bar (right side,
  `index.html:346-360`) and renders both moon and sun SVGs, hidden via
  CSS based on the active theme. `app.js toggleTheme()` flips
  `documentElement.dataset.theme`, persists to `localStorage`, and calls
  `syncThemeToggleButton()` to update `aria-pressed` / `aria-label`. The
  function is exposed as `window.__toggleTheme` for diagnostic / scripting
  use.
- **macOS class.** `app.js` adds `.platform-darwin` to `<html>` when
  `electronAPI.platform === 'darwin'` — used by `shell.css` to add the
  traffic-light left inset (independent of theme).

### 18.2 HTML export theme inheritance

`src/core/export/comparison-exporters/html-exporter.js`:

- `exportToHTML(comparisonResult)` reads `localStorage.ui-theme` (defaulting
  to `'dark'`), then forwards it to `buildDocument(...)` as a 6th argument.
- `buildDocument` sets `<html lang="en" data-theme="${theme}">` and embeds
  a small inline script: it re-reads `localStorage.ui-theme-report` (a
  *separate* key from the main app, so that the report viewer can be
  toggled independently of the editor), and overrides `data-theme` if a
  value is present.
- `buildCss()` emits both `[data-theme="dark"]` and `[data-theme="light"]`
  variable blocks containing all colour tokens used inside the report
  (severity buckets, banner palette, neighbour-bg colour set, role
  badges, swatch borders, etc.).
- The exported report has its own theme-toggle button rendered inside
  `<header class="topbar">` (`#theme-toggle`); its click handler is
  defined in the report's inline JS and writes
  `ui-theme-report` to `localStorage`.

### 18.3 Banner colour tokens

The diagnostic / pre-flight / DevTools banners that overlay the export now
use semantic colour tokens (`--color-banner-error-bg`,
`--color-banner-error-border`, `--color-banner-error-fg`,
`--color-banner-warn-bg/border`, `--color-banner-info-bg/border/fg/fg-muted`)
instead of hard-coded hex values. Every banner adapts to the chosen theme
without an explicit branch in JS.

### 18.4 Component-level theme awareness

There is no JS-level theme observer. Components rely entirely on the CSS
variable cascade: any rule that consumes `--color-*` automatically receives
the right value when `data-theme` flips on `<html>`. The only JS hook is
`syncThemeToggleButton`, which only updates the toggle button's ARIA
attributes — not any rendered content.
