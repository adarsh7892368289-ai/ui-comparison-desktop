# UI Comparison Desktop

> Onboarding guide for engineers joining this project. For exhaustive subsystem
> reference (IPC registry, IDB schema, matching pipeline internals, bulk runner
> internals, failure modes, etc.) see
> [`SYSTEM_REFERENCE.md`](./SYSTEM_REFERENCE.md).

## What this application does

UI Comparison Desktop is an Electron application that uses Playwright to load two
URLs, inject a webpack-bundled in-page extractor that walks the live DOM and reads
`getComputedStyle` for ~70 CSS properties on every visible element, then runs a
four-phase element-matching pipeline (test-attribute anchoring → sequence alignment
→ HPID-suffix realignment → legacy strategy pool) and a tolerance-aware
PropertyDiffer over normalized styles to produce a per-element, per-property
severity-ranked diff report. Results (including optional CDP-driven keyframe
screenshots — with a JS-shim fallback path for non-Chromium engines) are persisted
in IndexedDB inside the renderer process behind a Write-Ahead Log and a 3-strike
circuit breaker, and rendered through a token-based, virtual-scrolled UI.

The app supports three workflows:

- **Extract** — capture a single URL into a saved report.
- **Compare** — diff two saved reports (baseline vs. compare) in `dynamic` or
  `static` mode, optionally with side-by-side keyframe screenshots.
- **Bulk** — upload an Excel plan (`baseline_url`, `compare_url`, plus optional
  `mode`, `screenshots`, `label`, `browser`, `filter_class/id/tag` columns; up
  to 500 rows) and run an entire spreadsheet of comparisons in parallel with a
  bounded concurrency, per-host cooldown, automatic deduplication of recent
  same-day extractions, an interrupted-job resume banner, and an exportable
  per-row Excel summary.

The app supports **multiple browser engines** (Playwright-managed Chromium /
Firefox / WebKit, plus system-installed Chrome, Edge, Brave, Firefox, Chromium and
Safari where available). At boot the main process detects all installable engines
on the host, surfaces them in a renderer-side dropdown, and routes every
extraction/comparison through the engine the user picked. WebKit screenshot
captures automatically fall back to Chromium if `Page.snapshotRect` fails.

## Prerequisites

| Requirement | Exact version |
|---|---|
| Node.js | 18 LTS or newer (the repo uses native ES modules; ESLint targets `ecmaVersion: latest`) |
| npm | Whatever ships with the Node version above |
| Electron | `^41.1.1` (pinned in `package.json` — do not upgrade casually; preload + sandbox model is tied to this major) |
| Playwright | `^1.48.0` |
| `p-limit` | `^4.0.0` (concurrency gate inside the main-process bulk runner; loaded via dynamic `import()` because it is ESM-only) |
| `xlsx` | `^0.18.5` (bulk plan parser + summary/template workbook builder) |
| electron-builder | `^26.8.1` |
| webpack | `^5.96.0` |
| Babel | `^7.24.0` |
| OS | Windows 10+, macOS 12+, or Linux (Ubuntu 20.04+) |
| `PLAYWRIGHT_BROWSERS_PATH` | **Required** environment variable. Must point to a directory that contains a Playwright `chromium` install. Validated by `scripts/check-env.js` on every `prebuild`. |

Native dependencies (`better-sqlite3`) are rebuilt against Electron via
`electron-builder install-app-deps` in the `postinstall` hook. `better-sqlite3`
itself is currently **declared but unused** by `src/`; all persistence is
IndexedDB.

## Installation and first run

```bash
git clone <repo-url> ui-comparison-desktop
cd ui-comparison-desktop
npm install                           # runs postinstall → electron-builder install-app-deps

# Persist this in your shell profile.
# PowerShell:
$env:PLAYWRIGHT_BROWSERS_PATH = "C:\playwright-browsers"
# bash/zsh:
export PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers

npm run install:browsers              # playwright install chromium firefox webkit

npm run build                         # builds extractor + main + renderer once
npm start                             # watch:main + watch:renderer + electron .
```

> **First-run gotcha:** `npm start` does **not** build the extractor bundle. If you
> skip `npm run build` (or at least `npm run build:extractor`) the very first
> extraction will fail with `Extractor bundle not found`. After the bundle exists,
> watch mode keeps the main and renderer bundles fresh; the extractor bundle is
> rebuilt only when you run `npm run build:extractor` or `npm run build` again.

## Running in development

```bash
npm start
```

Internally `concurrently` runs three jobs:

1. `webpack --watch` against `webpack.main.config.js` → `dist/index.js`,
   `dist/preload.js` (Electron main process and the preload context bridge).
2. `webpack --watch` against `webpack.renderer.config.js` → `dist/renderer/app.js`
   plus a copy of `src/renderer/index.html` and the entire `src/renderer/styles/`
   tree to `dist/renderer/` (now including `bulk.css`).
3. `electron .` — boots the app against the package `main` field
   (`dist/index.js`).

**Sequencing constraint:** Both webpack configs use `bail: true` while running
under `--watch`. If either watch process hits a compile error it exits with
code 1. `concurrently` will keep Electron running, but the bundle will be stale
or missing. Fix the error and rerun `npm start` (or run `electron .` after a
clean `npm run build`).

DevTools shortcut: `Ctrl+Shift+I` (Windows/Linux), `Cmd+Option+I` (macOS).
Diagnostics overlay: `Ctrl+Shift+D` / `Cmd+Shift+D` (renders `getPerfMetrics()`
in a modal).

## Build pipeline (correct order)

```bash
npm run build:extractor    # 1. dist/extractor-bundle.js  (UMD → window.__uiCompare)
npm run build:main         # 2. dist/index.js + dist/preload.js
npm run build:renderer     # 3. dist/renderer/app.js + index.html + styles/
```

`npm run build` runs the three above in that order. The composite script first
fires the `prebuild` hook (`node scripts/check-env.js`), which validates that
`PLAYWRIGHT_BROWSERS_PATH` is set, readable, and contains a directory whose name
starts with `chromium`. If any of those preconditions fails the build aborts
before webpack runs.

Packaging (after `npm run build`):

```bash
npm run dist          # current host OS (electron-builder)
npm run dist:win      # Windows NSIS  (forces CSC_IDENTITY_AUTO_DISCOVERY=false)
npm run dist:mac      # macOS DMG (must run on macOS)
npm run dist:linux    # Linux AppImage + .deb
```

`npm run dist:all` exists but **do not use it for release builds** — cross-OS
output from a single host produces broken artifacts for the foreign targets.
Run each target on its native CI runner.

## Tests

There is no Jest/Mocha test runner wired into `package.json`. The available
automated checks are:

```bash
npm run smoke-test     # electron . --smoke-test
                       # exits early after asserting the extractor bundle is on
                       # disk and app.getVersion() is non-empty
npm run lint           # eslint .
npm run format         # prettier --write .
```

`fake-indexeddb` is a devDependency reserved for future unit tests; no
application source currently imports it.

## Directory structure

| Path | Purpose |
|---|---|
| `src/config/` | Deep-frozen runtime configuration (`defaults.js`, including the new `bulk` block — `defaultConcurrency`, `maxConcurrency`, `maxRows`, `maxRetainedJobs`, `hostCooldownMs`) and its boot-time validator. Also hosts `browser-capability-profile.js` (per-engine CDP availability, screenshot method, freeze strategy, scrollbar gutter, normalization quirks). |
| `src/core/bulk/` | Pure-Node bulk-plan support: `plan-parser.js` (xlsx → row records, validates headers and row cap), `plan-validator.js` (row-by-row validation against URL compatibility + browser catalogue), `extraction-key.js` (SHA-256 deduplication key over `url|browserType|channel-or-path|YYYY-MM-DD`). |
| `src/core/comparison/` | Pure-Node matching, diffing, severity, cascade suppression, keyframe grouping. |
| `src/core/extraction/` | The in-page extraction pipeline (bundled into `extractor-bundle.js`). |
| `src/core/normalization/` | CSS color/unit/font normalizers and a dual LRU cache, used before diffing. |
| `src/core/selectors/` | CSS + XPath selector generators with timeouts and a bounded concurrency queue. |
| `src/core/export/` | HTML / CSV / JSON / Excel exporters for both comparisons and saved extractions, plus `bulk-summary-exporter.js` (xlsx workbook with `Bulk Summary` sheet + downloadable `Plan` template) and `bulk-pair-state-labels.js` (state→label map and friendly error hints). |
| `src/infrastructure/` | Renderer-side cross-cutting services: IndexedDB repository (with WAL + circuit breaker, now versioned at `9` with `bulk_jobs` / `bulk_pairs` stores and `by_bulkJobId` / `by_extractionKey` indexes on reports), structured logger, error tracker, performance monitor. |
| `src/main/` | Electron main process: app lifecycle, IPC handlers, preload, Playwright manager, custom protocol, resource path resolution, `browser-detector.js` (per-OS system-browser discovery + Playwright-managed binary probing), and `bulk-runner.js` (per-job concurrency gate via `p-limit`, per-host cooldown, dedup-aware extraction, screenshot fallback, cancellation propagation). |
| `src/renderer/` | Renderer entry, state machine (now including the `bulkJob` / `bulkParsedRows` slices), application workflows, presentational components, design tokens, stylesheets. |
| `src/renderer/application/` | Workflow orchestration (extract / compare / bulk / import / export / report management / notification queue). `bulk-workflow.js` is the renderer-side coordinator: dedup planning, host-memory–aware concurrency clamp, IPC bridging, persist-after-completion, resume detection. |
| `src/renderer/components/` | UI: app shell, browser selector, modal, progress bar, report list (virtual scroll), report combobox, result panel, status bar, system banner, toast, tooltip, plus the new `bulk-panel.js` (drop-zone / parse-summary / pair list with virtual scroll, action toolbar, resume banner). |
| `src/renderer/styles/` | `tokens.css` design tokens, plus `base`, `shell`, `components`, `navigation`, `report-list`, `result-panel`, and the new `bulk` stylesheet. |
| `src/renderer/utils/` | Renderer helpers: icons, panel-rail breakpoints, report metadata, `sanitize.js` (`sanitize`, `sanitizeErrorMessage` — strips Playwright "Browser logs:" / "Call log:" tails, `sanitizeFilename`), time. |
| `scripts/` | Build-time guards. `check-env.js` enforces `PLAYWRIGHT_BROWSERS_PATH`; `strip-comments.js` is a developer utility. |
| `docs/` | Optional design notes and migration specs. Not loaded at runtime. Contains `ui-redesign/` with depth audit, token-redesign spec, and implementation plan (each in v1 and v2). |
| `dist/` | Webpack output. Not committed. |
| `release/` | electron-builder output. Not committed. |
| `.playwright-browsers/` | Project-local Playwright browser tree consumed by `electron-builder` `extraResources`. |
| `.github/workflows/` | CI release pipeline definitions. |

Top-level files of note: `webpack.main.config.js`, `webpack.renderer.config.js`,
`webpack.extractor.config.js`, `electron-builder.yml`, `.eslintrc.json`,
`.prettierrc`, `package.json`, `SYSTEM_REFERENCE.md`.

## Architectural overview

Four layers, with a strict one-way dependency rule:

```
presentation  (src/renderer/components/, src/renderer/styles/, index.html)
        ↓
application   (src/renderer/application/, src/renderer/state.js, src/renderer/app.js)
        ↓
core          (src/core/**)            infrastructure  (src/infrastructure/**)
```

**The rule, stated precisely:** A module in layer L may import only from layers
strictly below L, plus other modules in L. `core/` and `infrastructure/` are
peers — neither imports the other except through narrow, intentional surfaces
(currently: `core/*` imports `infrastructure/logger.js`). Nothing in `core/` may
import Electron, the renderer DOM, or anything under `src/renderer/` or
`src/main/`. Nothing in `infrastructure/` may import from `application/`,
`presentation/`, or `src/main/`. Components must not import from `src/main/` or
call `ipcRenderer` directly — they use `window.electronAPI`.

`src/main/` is its own runtime context (Node + Electron-main); it freely
imports from `src/core/**` (e.g. `bulk-runner.js` requires `playwright-manager`
and the comparator) but never from `src/renderer/` or `src/infrastructure/`.

Enforcement is currently editorial (not runtime-checked), backed by ESLint and
the webpack alias map (`@core`, `@config`, `@infra`). `madge` is installed as a
devDependency for ad-hoc cycle detection.

See `SYSTEM_REFERENCE.md` → *Architecture* for the diagram with concrete file
paths and what breaks if the rule is violated.

## Electron context map

### Main (Node.js)

- `src/main/index.js` — lifecycle, application menu, frozen-session recovery
- `src/main/ipc-handlers.js` — `ipcMain.handle` registry (now also the bulk channels and `GET_HOST_MEMORY`)
- `src/main/playwright-manager.js` — browser launch, extraction, comparison orchestration, CDP screenshots
- `src/main/bulk-runner.js` — per-job orchestrator: `p-limit` concurrency gate, per-host cooldown, dedup-aware extraction, parallel baseline/compare, error-classification, progress events
- `src/main/protocol-handler.js` — `app://` scheme + 512 MB blob LRU
- `src/main/resource-paths.js` — locates extractor bundle / browsers across dev vs packaged
- `src/core/**` — loaded via Node `require` for the comparator, the bulk plan validator, and the extraction-key hasher

### Preload (isolated Node bridge)

- `src/main/preload.js` — `contextBridge.exposeInMainWorld('electronAPI', …)` (now exposes `startBulkJob`, `cancelBulkJob`, `bulkProvideElements`, `getHostMemory`, `onBulkProgress`, `onBulkPairCompleted`, `onBulkJobComplete`, `pickDirectory`, `exportFileToDirectory` in addition to the original surface)
- `src/main/ipc-channels.js`

### Renderer (Chromium, sandboxed)

- `src/renderer/**`
- `src/infrastructure/**` — IndexedDB lives here
- `src/renderer/stubs/electron.js` — renderer-bundle electron stub

### In-page (target site context)

- `src/core/extraction/**` compiled to `dist/extractor-bundle.js` (UMD → `window.__uiCompare`)
- Uses no-op stubs from `src/core/extraction/_page_stubs_/` for `electron` / `electron-log`

What crosses via IPC: extraction requests, comparison requests, file
import/export, blob registration for the `app://` protocol, version + perf
metrics, **available-browsers detection (`GET_AVAILABLE_BROWSERS`)**, **host
memory probe (`GET_HOST_MEMORY`)**, **bulk job start/cancel/element-provide
(`BULK_START_JOB`, `CANCEL_BULK_JOB`, `BULK_PROVIDE_ELEMENTS`)**, **directory-
scoped export (`PICK_DIRECTORY`, `EXPORT_FILE_TO_DIRECTORY`)**, cancellation,
progress and notification pushes (single-op and bulk), native context-menu
(report-id and bulk-job-id variants) and application-menu actions,
window-title updates. See `SYSTEM_REFERENCE.md` → *IPC Registry* for every
channel name, direction, payload type, and handler.

## Bulk pipeline (high-level)

1. **Plan upload.** The user drops an `.xlsx` into the Bulk panel. `xlsx` parses
   it; `src/core/bulk/plan-parser.js` reads the first sheet, validates headers,
   enforces `bulk.maxRows` (default `500`), and returns row records. Required
   columns: `baseline_url`, `compare_url`. Optional: `mode` (`dynamic`/`static`,
   default `dynamic`), `screenshots` (truthy/falsy tokens), `label`, `browser`
   (canonical `chromium`/`firefox`/`webkit` or any selector `displayName`),
   `filter_class`, `filter_id`, `filter_tag`.
2. **Validation.** `plan-validator.js` walks each row against the live browser
   catalogue and `assessUrlCompatibility` from the comparison core. Each row
   ends up `valid` / `warning` (URL CAUTION) / `invalid`. Invalid rows still
   appear in the downloaded summary with `status: invalid`.
3. **Dedup planning.** Renderer-side `computeDeduplicationPlan` (in
   `bulk-workflow.js`) hashes `url|browserType|channel-or-path|YYYY-MM-DD`
   (`buildExtractionKey` in `core/bulk/extraction-key.js`) and looks each side
   up via `storage.loadReportByExtractionKey`. Hits become
   `dedupedSides.{baseline|compare}` and the row will reuse those elements
   instead of re-extracting. The "Force refresh" toggle skips this.
4. **Concurrency clamp.** `_clampConcurrency` reads
   `electronAPI.getHostMemory()` once; if total RAM `< 12 GiB`, max concurrency
   is capped at `min(2, bulk.maxConcurrency=4)`. If the plan is heterogeneous
   (mixed `browserType` across rows) and the host is RAM-constrained,
   concurrency drops to **1**.
5. **Persist + dispatch.** The renderer writes a `bulk_jobs` row (status
   `running`) and one `bulk_pairs` row per pair, then invokes
   `BULK_START_JOB`. The main-process `bulk-runner.js` accepts the spec, sets
   up a `p-limit(safeConcurrency)` instance, and processes pairs via
   `Promise.allSettled([baseline, compare])` per row, with an optional
   per-host cooldown gate (`bulk.hostCooldownMs`, default `500`).
6. **Reused-side bridge.** When dedup finds an existing report, the renderer
   pushes its elements over `BULK_PROVIDE_ELEMENTS`; the main side resolves a
   pending `awaitProvidedElements(pairIndex, side)` promise and the runner
   skips the corresponding extraction. A 10-second timeout marks the pair as
   `STORAGE_DEGRADED` if the renderer never delivers.
7. **Per-pair lifecycle.** Each pair emits `BULK_PROGRESS` events
   (`extracting-baseline`, `extracting-compare`, `matching`, `screenshots`,
   `persisting`) and finally a `BULK_PAIR_COMPLETED` push with status `done` /
   `failed` / `cancelled`. The renderer animates the `persisting` phase, then
   persists results (report, comparison, blobs, keyframes, rects) tagged with
   `bulkJobId`.
8. **Eviction policy.** Bulk-tagged reports / comparisons are **excluded from
   `MAX_COMPARISONS=20` and `storage.maxReports=50` eviction**: the relevant
   counters subtract `by_bulkJobId.count()` so a 500-row bulk job does not
   evict the user's hand-curated single reports. `bulk_jobs` is itself capped
   at `BULK_MAX_RETAINED_JOBS=10` — older jobs get a cascade-delete.
9. **Resume detection.** On boot, `detectAndOfferResume` finds any
   `bulk_jobs` row still flagged `running` (i.e. the app was killed mid-run),
   marks any in-flight pair `failed` with `errorCode: 'INTERRUPTED'`, and
   shows a banner with **Resume from pair N**, **View partial results**, or
   **Discard** (cascade-deletes the job and all its derived rows).
10. **Export.** `routeBulkExportClick` pulls every persisted comparison for the
    job (in batches of 5 to stay friendly with IDB), feeds them through
    `buildBulkSummaryWorkbook` (24-column sheet with severity counts, dedup
    flag, status, failure reason, etc.), and saves via `EXPORT_FILE`. A
    matching `buildBulkTemplateWorkbook` exposes the empty plan template +
    instructions sheet under "Download template".

## Cross-browser support

The main process exposes `GET_AVAILABLE_BROWSERS` (`src/main/browser-detector.js`)
which returns a list of descriptors:

```
{ id, displayName, browserType, source, channel, executablePath,
  version, isAvailable, isLaunchable, isDefault, unavailableReason }
```

- **`source`** is `'playwright-managed'` (binaries from `PLAYWRIGHT_BROWSERS_PATH`)
  or `'system'` (Chrome/Edge/Brave/Firefox/Chromium/Safari discovered on disk).
- **System Firefox / Safari (WebKit)** are listed as read-only — Playwright
  requires its own patched build. Their `isLaunchable` is `false` with
  `unavailableReason: 'playwright-requires-patched-build'`.
- **System Chrome on Windows** is additionally probed against
  `HKLM/HKCU\SOFTWARE\Policies\Google\Chrome\RemoteDebuggingAllowed`. If the
  policy is `0`, the descriptor is marked `unavailableReason:
  'devtools-blocked-by-policy'` and the launch is pre-emptively blocked. If
  Playwright still raises a "DevTools remote debugging is disallowed" error at
  launch time, `getBrowser` rethrows with `code: 'BROWSER_POLICY_BLOCKED'`.
- **Per-OS strategies:** macOS reads `Info.plist` via `/usr/libexec/PlistBuddy`
  (falls back to `mdls`); Windows queries `reg.exe` against `App Paths`
  registry keys, then falls back to canonical `Program Files` /
  `LOCALAPPDATA\Programs` paths, and reads `wmic`/`powershell` for file
  versions; Linux probes canonical absolute paths first, then walks `$PATH`,
  and reads `--version`.

The renderer subscribes via `state.js` (`availableBrowsers`,
`selectedBrowser`, `browserDetectionState ∈ {idle,loading,ready,error}`,
`browserDetectionError`). The `BrowserSelector` component
(`src/renderer/components/browser-selector.js`) mounts into
`#browser-selector-slot` (in the Extract panel) and dispatches
`BROWSER_SELECTED`. Both the extract and compare workflows pre-flight this
state and refuse to launch if `browserDetectionState !== 'ready'` or the
selected browser is not launchable. The bulk workflow uses the same selection
as the **job-level** descriptor; per-row `browser` cells override it after
resolving against the catalogue.

Per-engine quirks live in `src/config/browser-capability-profile.js`:

| Engine | CDP available | Screenshot | Freeze method | Viewport override | Scrollbar gutter | Layout warmup |
|---|---|---|---|---|---|---|
| chromium | yes | `cdp-webp` (image/webp) | `cdp-script-disable` | `cdp-emulation` (DPR override on) | 15 px | no |
| firefox  | no  | `playwright-png`        | `js-shim`            | `playwright-set-viewport` (no DPR override) | 17 px | no |
| webkit   | no  | `playwright-png`        | `js-shim`            | `playwright-set-viewport` (no DPR override) | 0 px  | yes (`requiresLayoutWarmup`) |

On the shim path, `freezePage` patches `requestAnimationFrame`,
`setInterval` and `setTimeout` (only `0`/null delays survive) and injects a
`vdiff-freeze-styles` `<style>` block that sets
`animation-play-state: paused`, `transition-duration: 0s`,
`scroll-behavior: auto`. WebKit screenshot failures matching
`/Page\.snapshotRect|snapshot/i` automatically fall back to Chromium for the
visual phase; the renderer is informed via the
`visualData.devToolsWarnings` array (kind `'screenshot-engine-fallback'`).

Reasons surfaced to the renderer (`UNAVAILABLE_REASON_LABELS` in
`browser-selector.js`): `binary-not-found`, `version-mismatch`,
`playwright-requires-patched-build`, `unsupported-os`,
`devtools-blocked-by-policy`.

## How to add a new IPC channel

The contract that must hold:

1. **Add the constant** in `src/main/ipc-channels.js`. By convention invoke
   channels use `UPPER_SNAKE_CASE` for both key and string value. The three
   native-menu channels (`SHOW_CONTEXT_MENU`, `CONTEXT_ACTION`, `MENU_ACTION`)
   are the only ones using lowercase hyphenated runtime values; do not add new
   ones unless they are also native-menu integrations.
2. **Register the handler** inside one of the `_register*Handlers(...)`
   functions in `src/main/ipc-handlers.js` (or create a new one and call it
   from `registerIpcHandlers`). The handler must `return { success, … }` for
   invoke channels; never throw across the IPC boundary uncaught.
3. **Expose it in preload** (`src/main/preload.js`) with
   `ipcRenderer.invoke(CH.X, payload)` for request/response, or the
   `makePushBridge(CH.X)` helper for main→renderer push channels (the bridge
   returns an unsubscribe function). Push channels are powered by
   `_mainWindow.webContents.send(CH.X, payload)` from main —
   `_pushToWindow` in `src/main/ipc-handlers.js` is the canonical helper.
4. **Consume from the renderer** via `window.electronAPI.<method>` — never
   import `electron` directly from a renderer module.
5. **Sandbox safety:** the handler runs in main and has full Node access. It
   must never call IndexedDB (Chromium-only) and must not import from
   `src/renderer/`.

## Known gotchas

- **Extractor bundle must be built before first extraction.** `npm start` only
  watches main + renderer. Run `npm run build:extractor` (or `npm run build`)
  at least once. The Playwright manager probes three candidate paths (same
  order as `getExtractorBundleSource` in `src/main/playwright-manager.js`):
  `mainDistributionDir()/extractor-bundle.js` (dev: repo `dist/`; packaged:
  `app.asar.unpacked/dist/` because of `asarUnpack` in `electron-builder.yml`),
  `__dirname/extractor-bundle.js`, and `process.cwd()/dist/extractor-bundle.js`.
  It surfaces `Extractor bundle not found` if all miss.
- **`PLAYWRIGHT_BROWSERS_PATH` must exist and contain `chromium`** before any
  `npm run build` (`prebuild` hard-fails) and before any `npm run dist`
  (`prepackage` hard-fails). For packaged builds, the project-root
  `.playwright-browsers/` tree is what `electron-builder.yml` ships into
  `extraResources`.
- **`electronAPI` undefined → fatal.** If `window.electronAPI` is missing
  (typically caused by a moved `dist/preload.js`), `src/renderer/app.js`
  replaces the body with a fatal banner and throws. Confirm
  `BrowserWindow.webPreferences.preload` resolves to `dist/preload.js`.
- **IndexedDB lives only in the renderer.** The main process does not open
  the database. Comparisons run in main but persistence happens after the
  result returns to the renderer via IPC. The renderer is the source of
  truth for bulk-job persistence too — `bulk-runner.js` only emits events.
- **Renderer is sandboxed.** `app.enableSandbox()` is called in
  `src/main/index.js`. All Node capabilities the renderer needs must come
  through the preload bridge.
- **IDB version is `9`.** A fresh install creates every store at v9
  atomically; an upgrade from v8 adds `bulk_jobs`, `bulk_pairs`, plus
  `by_bulkJobId` / `by_extractionKey` indexes on `reports` and `by_bulkJobId`
  on `comparisons`. Earlier upgrades (v5 in particular) still run their
  data-clearing path; see `SYSTEM_REFERENCE.md` → *IndexedDB Schema*.
- **Storage degradation events are dispatched on `window`.** Listen for
  `storage-degraded` with `detail.reason` `CIRCUIT_OPEN` (red banner) or
  `WAL_REPLAY_EXHAUSTED` (warning banner). Three consecutive write failures open
  the circuit until the renderer is reloaded. **A storage-degraded event also
  cancels any running bulk job** (renderer-side handler in `app.js`).
- **WAL replay attempts are bounded.** Each pending entry tracks `replayCount`;
  after three failed attempts it is marked `FAILED` and the user is banner-warned.
  `SAVE_VISUAL_BLOB` WAL entries are *never* replayed (binary payload may be lost
  in flight) — they are immediately failed on startup. `SAVE_BULK_JOB` /
  `SAVE_BULK_PAIR` WAL entries are not in the known-replayable set and will
  also be force-failed at boot if they are ever pending.
- **Bulk eviction skips bulk-tagged rows.** `_evictAndWrite` and
  `_writeReportWithEviction` count `by_bulkJobId` separately and refuse to
  delete bulk rows when computing the "non-bulk" excess against
  `MAX_COMPARISONS=20` / `storage.maxReports=50`. Bulk-job retention is
  bounded separately by `BULK_MAX_RETAINED_JOBS=10`; `saveBulkJob` cascade-
  deletes the oldest jobs when the count would exceed the cap.
- **Bulk concurrency is clamped by host RAM.** Renderer-side
  `_clampConcurrency(requested, totalMemMB, heterogeneous)` halves the cap
  on machines with `< 12 GiB` total RAM, and forces a heterogeneous plan
  (mixed `browserType`s) down to **1** on those machines. Main-process
  `_registerBulkHandlers` independently clamps to `bulk.maxConcurrency` (4).
- **HPID dual scheme.** Every element carries a relative HPID (rooted at the
  extraction scope) and an `absoluteHpid` (rooted at `document.body`). The
  matcher's sequence alignment uses the relative HPID; the cascade suppression
  walk in the export report transformer uses the absolute HPID. Mixing them up
  silently corrupts suppression for filtered extractions — see
  *Critical risk* in `SYSTEM_REFERENCE.md`.
- **`bail: true` under watch.** A compile error kills the watch process while
  Electron keeps running on a stale bundle. Watch the `concurrently` output.
- **`dist:all` produces broken non-host artifacts.** Use per-OS CI runners.
- **`better-sqlite3` is declared but unused** in current sources (no
  `require('better-sqlite3')` anywhere under `src/`). It is rebuilt against
  Electron via the `postinstall` hook but never loaded. All persistence is
  IndexedDB.
- **`electron-updater` is declared but not wired.** Listed as an external in
  `webpack.main.config.js` and as a dependency, but no `src/` file imports it
  and `electron-builder.yml` has no `publish` configuration.
- **`OPERATION_CANCELLED` and `APP_NOTIFICATION` IPC channels are dead code.**
  Both constants exist in `src/main/ipc-channels.js`, both are bridged in
  `src/main/preload.js` (`onOperationCancelled`, `onAppNotification`), and the
  renderer subscribes to `APP_NOTIFICATION` in `src/renderer/app.js`. No code
  path in `src/main/` calls `webContents.send` on either channel. Cancellation
  is signaled via the invoke return `{ cancelled: true }`, not the push.
- **`recoverFrozenSessions()` runs at boot but is a no-op.** It iterates the
  in-process `_browsers` Map (`src/main/playwright-manager.js`), which is
  empty at boot before any extraction has launched a browser. The function is
  defensive but currently never finds anything to recover. Bulk-job recovery
  is a *separate* mechanism (`detectAndOfferResume`) that walks the
  `bulk_jobs` IDB store at renderer startup.
- **Notification queue caps are in `notification-queue.js`, not
  `notification-timing.js`.** `MAX_VISIBLE = 3` and the spam threshold
  (`≥ 3` enqueues within `NOTIFICATION_SPAM_WINDOW_MS = 800`) live in
  `src/renderer/application/notification-queue.js`. The timing-constants
  module only exports five duration values.
- **macOS traffic-light padding.** `html.platform-darwin #app-root` adds a
  left inset based on `electronAPI.platform`. Removing the platform class
  causes window-control overlap.
- **The application menu Help links** point to placeholder
  `your-org/ui-comparison` GitHub URLs — replace before shipping a fork.
- **Browser detection result is module-cached.** `src/main/browser-detector.js`
  memoises the first successful detection in a module-level `_cache`. The
  renderer's "Retry" button on the browser selector calls
  `getAvailableBrowsers({ refresh: true })` which forces re-detection. The
  cache is also reachable from tests via the (intentionally underscored)
  `_resetCache` export.
- **System Firefox / Safari are visible but not launchable.** Even when the
  browser-detector finds them, Playwright cannot drive a stock-OS install of
  these engines — only the Playwright-shipped patched builds. The selector
  greys them out with a tooltip explaining why.
- **WebKit visual capture fails over to Chromium silently.** If the WebKit
  screenshot path raises a `Page.snapshotRect`-shaped error, the comparison
  is retried against Chromium for the screenshot phase only. The matching
  pipeline result is unchanged; a `screenshot-engine-fallback` entry is
  appended to `result.visualDiffs.devToolsWarnings`.
- **`PLAYWRIGHT_BROWSERS_PATH` only covers the *bundled* engines.** System
  browsers are detected and launched independently via `channel:` (for
  canonical install paths) or `executablePath:`. Removing the env var breaks
  Playwright-managed launches but does *not* affect system Chrome/Edge/Brave.
- **Bulk context-menu is a separate code path.** The native context menu in
  `src/main/index.js` branches on `payload.bulkJobId` (a single "Delete this
  bulk run" item, action `'deleteBulkJob'`) vs. `payload.reportId` (the
  full report menu). Adding new bulk actions means extending that branch
  *and* the renderer-side `onContextAction` consumer.
- **`PICK_DIRECTORY` / `EXPORT_FILE_TO_DIRECTORY` defense-in-depth.** The
  `EXPORT_FILE_TO_DIRECTORY` handler only writes into directories the user
  has explicitly chosen *this session* via `PICK_DIRECTORY`. Paths outside
  that set are rejected with `{ success:false, error:'Directory not
  approved …' }`. This prevents rogue renderer-side code from writing to
  arbitrary filesystem locations.

## CI / Release pipeline

`.github/workflows/release-build.yml` — triggered on `workflow_dispatch`.

| Job | Runner | What it does |
|---|---|---|
| `build-win` | `windows-latest` | Checkout → Node 22 → set `PLAYWRIGHT_BROWSERS_PATH` → `npm ci` → `playwright install chromium` → `npm run dist:win` (with `CSC_IDENTITY_AUTO_DISCOVERY=false`) → upload `release/*.exe`, `*.blockmap`, `latest.yml` |
| `build-mac` | `macos-latest` | Same flow, except `npm run dist:mac` → upload `release/*.dmg` |

Both jobs pin `actions/checkout@v5`, `actions/setup-node@v5`, and
`actions/upload-artifact@v4`. No Linux job is defined yet — add one following
the same pattern if AppImage / .deb artifacts are needed.

## Webpack configurations

| Config | Entry | Target | Output | Notable |
|---|---|---|---|---|
| `webpack.main.config.js` | `src/main/index.js`, `src/main/preload.js` | `electron-main`, Electron 33 | `dist/index.js`, `dist/preload.js` | Externals: `playwright`, `electron-log`, `electron-updater`. Uses `@core`/`@config`/`@infra` aliases. `bail:true`. |
| `webpack.renderer.config.js` | `src/renderer/app.js` | `web`, Chrome 120 | `dist/renderer/app.js` | `CopyStaticAssetsPlugin` copies `index.html` + `styles/` to `dist/renderer/`. Aliases `electron` → stub, `electron-log` → `electron-log/renderer`. |
| `webpack.extractor.config.js` | `src/core/extraction/extractor.js` | `web`, Chrome 108 | `dist/extractor-bundle.js` (UMD `__uiCompare`) | Aliases `electron`/`electron-log` → `_page_stubs_/`. No code splitting. |

## Design tokens

`src/renderer/styles/tokens.css` provides all design constants used by the UI.
Token prefixes: `--color-*` (brand, surface, text, border, severity, match,
success, warning, destructive, scrim), `--font-*`, `--space-*`, `--radius-*`,
`--shadow-*`, `--z-*`, `--motion-*`. Every other stylesheet imports these
tokens — never raw values. The dark theme is the only mode (no light variant
at present). Typography: Inter (weights 400/500/600) for UI, JetBrains Mono
(weight 400) for monospace code / selector displays.

## Preload API surface

The full `window.electronAPI` surface exposed by `src/main/preload.js`:

| Method | Channel | Pattern |
|---|---|---|
| `startComparison(params)` | `START_COMPARISON` | invoke |
| `extractElements(params)` | `EXTRACT_ELEMENTS` | invoke |
| `cancelOperation(payload)` | `CANCEL_OPERATION` | invoke |
| `exportHTML(params)` | `EXPORT_HTML` | invoke |
| `exportFile(params)` | `EXPORT_FILE` | invoke |
| `pickDirectory(params?)` | `PICK_DIRECTORY` | invoke |
| `exportFileToDirectory(params)` | `EXPORT_FILE_TO_DIRECTORY` | invoke |
| `importFile()` | `IMPORT_FILE` | invoke |
| `registerBlob(params)` | `REGISTER_BLOB` | invoke |
| `unregisterBlobsByComparison(id)` | `UNREGISTER_BLOBS_BY_COMPARISON` | invoke |
| `openReport(params)` | `OPEN_REPORT` | invoke |
| `getVersion()` | `GET_VERSION` | invoke |
| `getPerfMetrics()` | `GET_PERF_METRICS` | invoke |
| `getAvailableBrowsers(opts?)` | `GET_AVAILABLE_BROWSERS` | invoke |
| `getHostMemory()` | `GET_HOST_MEMORY` | invoke |
| `startBulkJob(spec)` | `BULK_START_JOB` | invoke |
| `cancelBulkJob(jobId)` | `CANCEL_BULK_JOB` | invoke |
| `bulkProvideElements(payload)` | `BULK_PROVIDE_ELEMENTS` | invoke |
| `setWindowTitle(title)` | `SET_WINDOW_TITLE` | send (one-way) |
| `showContextMenu(payload)` | `SHOW_CONTEXT_MENU` | send (one-way) |
| `onComparisonProgress(cb)` | `COMPARISON_PROGRESS` | push (unsubscribe fn) |
| `onExtractionProgress(cb)` | `EXTRACTION_PROGRESS` | push (unsubscribe fn) |
| `onOperationCancelled(cb)` | `OPERATION_CANCELLED` | push (dead) |
| `onContextAction(cb)` | `CONTEXT_ACTION` | push (unsubscribe fn) |
| `onMenuAction(cb)` | `MENU_ACTION` | push (unsubscribe fn) |
| `onAppNotification(cb)` | `APP_NOTIFICATION` | push (dead) |
| `onBulkProgress(cb)` | `BULK_PROGRESS` | push (unsubscribe fn) |
| `onBulkPairCompleted(cb)` | `BULK_PAIR_COMPLETED` | push (unsubscribe fn) |
| `onBulkJobComplete(cb)` | `BULK_JOB_COMPLETE` | push (unsubscribe fn) |
| `platform` | — | property (`process.platform`) |

## Renderer state actions (complete list)

Single-extract/compare lifecycle:
- `REPORTS_LOADED` — hydrate reports array
- `REPORT_DELETED` — remove one report by id
- `EXTRACTION_STARTED` — phase → `extracting`
- `EXTRACTION_PROGRESS` — update label + pct (ignored during `cancelling`)
- `EXTRACT_UI_END` — transition extracting/cancelling → idle/done
- `COMPARISON_STARTED` — phase → `comparing`, clear prior result
- `COMPARISON_PROGRESS` — update label + pct (ignored during `cancelling`)
- `COMPARISON_COMPLETE` — phase → `done`, store result + cache metadata
- `COMPARISON_ERROR` — phase → `error`
- `COMPARE_UI_END` — transition comparing/cancelling → idle
- `OPERATION_CANCELLING` — phase → `cancelling`
- `RESET_COMPARISON` — clear comparison + viewer state
- `DISMISS_ERROR` — reset to initial (preserves reports, browser, bulk, filters)
- `BASELINE_SELECTED` — set selected baseline report id
- `COMPARE_SELECTED` — set selected compare report id
- `MODE_CHANGED` — set compare mode (`dynamic`/`static`)
- `FILTERS_UPDATED` — merge partial filter update
- `EXPORT_STARTED` — exportState → `pending`
- `EXPORT_COMPLETE` — exportState → `done`/`error`
- `EXPORT_ERROR` — exportState → `error` + store message

Browser detection:
- `BROWSER_DETECTION_STARTED` — browserDetectionState → `loading`
- `BROWSERS_DETECTED` — store list, auto-select default, state → `ready`
- `BROWSER_DETECTION_FAILED` — state → `error` + store message
- `BROWSER_SELECTED` — store user-chosen browser descriptor

Bulk:
- `BULK_PARSED_ROWS_SET` — store validated rows + detection state
- `BULK_DETECTION_STATE` — update detection phase
- `BULK_JOB_STARTED` — build running job from spec, first pair optimistically `extracting-baseline`
- `BULK_PROGRESS` — update one pair's status/pct/operationId
- `BULK_PAIR_COMPLETED` — finalize one pair (done/failed/cancelled + report/comparison ids)
- `BULK_JOB_COMPLETE` — derive terminal status from summary + cancelling flag
- `BULK_JOB_CANCELLING` — flip `cancelling` flag (button renders "Cancelling…")
- `BULK_JOB_CANCELLED` — flip queued pairs → cancelled, status → `cancelled`
- `BULK_JOB_STORAGE_DEGRADED` — mark storageDegraded + cancelling
- `BULK_JOB_LOADED` — hydrate a job from IDB (e.g. resume detection)
- `BULK_JOB_RESET` — null out job + parsed rows
- `BULK_JOB_RESUMED` / `BULK_JOB_RESUME_ACCEPTED` — re-queue incomplete pairs, status → `running`
- `BULK_JOB_RESUME_OFFERED` — show resume banner with offer metadata
- `BULK_JOB_RESUME_DECLINED` — cascade delete or mark partial
- `BULK_PAIR_OPEN` — set activePairIndex for viewer
- `BULK_PAIR_VIEWER_READY` — store viewer result + cache metadata
- `BULK_ACTIVE_PAIR_CLEAR` — close pair viewer

## Infrastructure services

### Performance monitor (`src/infrastructure/performance-monitor.js`)

Tracks per-operation timing with `start(op)` / `end(handle)` / `wrap(op, fn)`.
Retains the last 100 samples per operation in a circular buffer. Exposes
`getStats(op)` → `{ count, total, average, min, max, stdDev, p50, p95, p99 }`
and `getAllStats()`. Togglable via `enabled` flag without losing accumulated
data. `reset(op?)` clears one or all operations.

### Error tracker (`src/infrastructure/error-tracker.js`)

Deduplicates errors by `${code}:${message}` key. Tracks `count`, `firstSeen`,
`lastSeen` per unique error. Bounded at 100 entries (FIFO eviction of oldest).
Exports `ERROR_CODES` with 18 named codes covering extraction, selector
generation, comparison, and storage failures.

### IDB repository public API (`src/infrastructure/idb-repository.js`)

The singleton `storage` exports 25+ public methods:

| Category | Methods |
|---|---|
| Reports | `saveReport`, `loadReports`, `loadReportElements`, `loadReportByExtractionKey`, `deleteReport`, `deleteAllReports` |
| Comparisons | `saveComparison`, `loadComparisonByPair`, `loadComparisonDiffs` |
| Visual blobs | `saveVisualBlob`, `loadVisualBlob`, `deleteVisualBlobsByComparisonId` |
| Keyframes | `saveVisualKeyframe`, `loadKeyframesBySession` |
| Element rects | `saveVisualElementRect`, `saveVisualElementRects`, `loadElementRectsBySession`, `deleteVisualDataBySession` |
| Bulk | `saveBulkJob`, `updateBulkJob`, `loadBulkJob`, `loadAllBulkJobs`, `saveBulkPair`, `updateBulkPair`, `loadBulkPairsByJob`, `loadBulkPairsByStatus`, `deleteBulkJobCascade` |
| Recovery | `applyPendingOperations`, `consumeV5UpgradeDataClearedNotice` |
| Quota | `checkQuota` |

Helper: `buildPairKey(baselineId, compareId, mode)` → `${baselineId}_${compareId}_${mode}`.

## Normalization engine (`src/core/normalization/`)

`normalizer-engine.js` normalizes captured CSS values before diffing:

1. **Shorthand expansion** — `expandShorthands(styles)` splits shorthand
   properties (border, margin, padding, etc.) into longhands.
2. **Color normalization** — 11 color properties normalized to canonical RGB
   (handles named colors, hex, hsl, rgb with alpha).
3. **Size normalization** — 25 size properties have units standardized and
   values rounded to `normalization.rounding.decimals = 2`.
4. **Font family** — dequoted on Firefox/WebKit (per engine quirks profile).
5. **Font weight** — keywords → numeric (`normal`→`400`, `bold`→`700`).
6. **Box shadow** — reordered on WebKit (per engine quirks profile).

Engine-specific behavior is driven by `BROWSER_NORMALIZATION_PROFILES` from
`src/config/browser-capability-profile.js`. LRU cache (`normalization.cache`
config: `maxEntries=1000`, policy `LRU`) avoids re-normalizing repeated
values. Errors during normalization silently return the original value.

## Selector engine (`src/core/selectors/selector-engine.js`)

Generates CSS and XPath selectors for each extracted element. Key behaviors:

- **Bounded concurrency** — `BoundedQueue(selectors.concurrency = 4)` gates
  parallel selector generation across many elements.
- **Total timeout** — `selectors.totalTimeout = 600` ms hard limit per element
  (returns `NULL_SELECTORS` on timeout).
- **Parallel execution** — CSS and XPath generators run in parallel via
  `Promise.allSettled` (configurable per-type via
  `selectors.xpath.parallelExecution` / `selectors.css.parallelExecution`).
- **Shadow DOM** — `buildShadowPath` walks `getRootNode({ composed: false })`
  to detect shadow boundaries and returns host selector chain.
- **NULL_SELECTORS** — `{ xpath:null, css:null, shadowPath:null, xpathConfidence:0, cssConfidence:0, xpathStrategy:null, cssStrategy:null }` returned on any failure.

## Report manager / sidebar (`src/renderer/application/report-manager.js`)

`initializeApp(statusBar)` is the renderer entry point (called from `app.js`):

1. Awaits `storage.applyPendingOperations()` (WAL replay).
2. Creates the virtual-scrolled report list component.
3. Loads view config from `localStorage` key `'sidebar-view-config'`.
4. Wires sidebar controls (search with **250 ms debounce**, sort, group, density).
5. Subscribes to state for selection sync.

**View config**: `{ sortField, sortDirection, density, groupBy }`.
- Sort fields: `date`, `name` (host), `elements`.
- Density cycle: `compact` → `default` → `comfortable`.
- Group by: `null`, `host`, `date`, `environment`, `job`.

## Comparator (`src/core/comparison/comparator.js`)

`Comparator.compare()` is an async generator yielding `{ type:'progress' }` and
finally `{ type:'result' }` frames. Progress weight: matching = 50%, diffing =
49%, final 1% for assembly. Match rate formula:
`(matched / (matched + unmatchedBaseline + unmatchedCompare)) * 100`.

## Protocol handler (`src/main/protocol-handler.js`)

Registers the `app://` custom scheme. Routes:
- `app://./blob/<blobId>` — serves from in-memory LRU blob cache (default MIME
  `image/webp`, header `Cache-Control: no-store`).
- `app://./<path>` — serves static files from `dist/renderer/` with path
  traversal protection (403 on escape).

Blob cache: `MAX_BLOB_CACHE_BYTES = 512 MiB`. Eviction is **per-comparison-
group** (all blobs for the oldest `comparisonId` evicted together). Single
blobs exceeding the cap are silently rejected. The active comparison is never
self-evicted.

## Resource paths (`src/main/resource-paths.js`)

Exports `mainDistributionDir()` — resolves to the app's distribution root:
- **Dev:** `__dirname` (inside `dist/`).
- **Packaged:** replaces `/app.asar/` with `/app.asar.unpacked/` so
  `fs.readFileSync` can reach unpacked resources (extractor bundle, playwright).
